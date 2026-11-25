"""Multimodal screening for the demo server (POST /api/multimodal).

The browser sends {flow, prompt, files:[{name, dataBase64}], imageAction, scenarioId}. This module builds ONE Gemini
request (text part + one inlineData part per file) and sends it to model-armor-multimodal-proxy. The proxy, not this
server, splits the prompt into parts and calls Model Armor once per part: the gateway does the work.

  flow "chat"  -> POST /model-armor-multimodal/generate        (text + files in, text out)
  flow "image" -> POST /model-armor-multimodal/generate-image  (image model; generated image is blocked or redacted)

Nothing is written to disk. The returned image (original or redacted) goes back to the browser only.
Python stdlib only.
"""
import base64
import binascii
import json
import os
import random
import re
import time
import urllib.error
import urllib.request

# Extension -> MIME type sent to the proxy (the proxy maps it to a Model Armor byteDataType).
TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".bmp": "image/bmp",
    ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
MAX_FILES = 3
MAX_FILE_BYTES = 4 * 1024 * 1024       # Model Armor limit per image / document
MAX_TOTAL_BYTES = 5 * 1024 * 1024      # proxy maxTotalBase64Chars (7,000,000) covers this
MAX_BODY_BYTES = 7_500_000             # JSON + base64 envelope
MAX_PROMPT_CHARS = 4000
TIMEOUT_S = 285                        # > proxy worst case 270 s (4x25 prompt callouts + 120 target + 20 + 30), < Cloud Run 300 s

# Sample scenarios shown as chips (files are under static/samples/multimodal/).
SCENARIOS = [
    {"id": "mm-clean-photo", "label": "Clean photo", "flow": "chat", "expect": "allowed",
     "prompt": "What is in this picture? Answer in one sentence.", "files": ["img-clean.png"],
     "description": "A harmless product photo: every part passes and Gemini describes it."},
    {"id": "mm-launch-pack", "label": "Product launch pack", "flow": "chat", "expect": "allowed",
     "prompt": "Verify that the product photo matches the PDF spec sheet, then report total Q4 stock across hubs and the wholesale price range from the CSV.",
     "files": ["img-clean.png", "spec-mug.pdf", "inventory-q4.csv"],
     "description": "Happy flow across 3 modalities (photo + PDF + CSV): all 4 prompt parts pass Model Armor and Gemini cross-checks them."},
    {"id": "mm-image-injection", "label": "Injection in image", "flow": "chat", "expect": "blocked",
     "prompt": "Please follow the note in this image.", "files": ["img-injection.png"],
     "description": "The text part is clean; the injection is typed inside the image (found by OCR)."},
    {"id": "mm-card-photo", "label": "Card photo", "flow": "chat", "expect": "blocked",
     "prompt": "Which bank issued this card?", "files": ["img-card.png"],
     "description": "A photo of a (test) payment card: Sensitive Data Protection reads the number."},
    {"id": "mm-word-embedded", "label": "Word: hidden in image", "flow": "chat", "expect": "blocked",
     "prompt": "Summarise this CV in three bullet points.", "files": ["doc-embedded-injection.docx"],
     "description": "The Word text is clean; the injection is only inside an embedded image."},
    {"id": "mm-pdf-embedded", "label": "PDF: hidden in image", "flow": "chat", "expect": "blocked",
     "prompt": "Summarise this CV in three bullet points.", "files": ["pdf-embedded-injection.pdf"],
     "description": "The PDF text is clean; the injection is only inside an embedded image. Try the same file in Screen a document."},
    {"id": "mm-office-pii", "label": "Deck + sheet", "flow": "chat", "expect": "blocked",
     "prompt": "Summarise these two files.", "files": ["deck-card.pptx", "sheet-pii.xlsx"],
     "description": "A card number inside a slide image, and customer PII in a spreadsheet."},
    {"id": "mm-generate-sign", "label": "Generate a sign", "flow": "image", "expect": "redacted",
     "prompt": "Generate a photo-realistic image of a small bakery shop sign on a wooden board. Under the shop name "
               "'Bayside Bakery', show an email address for orders in large, clear letters.",
     "files": [],
     "description": "The prompt is clean; the generated image contains an email address. Redact it or block the answer."},
]


class BadRequest(Exception):
    pass


def _safe_name(name):
    base = os.path.basename(str(name or "").replace("\\", "/"))
    return re.sub(r"[^A-Za-z0-9._ ()-]", "_", base)[:120] or "file"


def _parse(data):
    flow = data.get("flow") if data.get("flow") in ("chat", "image") else "chat"
    action = data.get("imageAction") if data.get("imageAction") in ("block", "redact") else "redact"
    scenario_id = data.get("scenarioId") or "mm-custom"
    if not isinstance(scenario_id, str) or not re.fullmatch(r"[a-z0-9-]{1,64}", scenario_id):
        raise BadRequest("invalid scenarioId")
    prompt = data.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise BadRequest("A prompt is required (the question or instruction).")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise BadRequest(f"Prompt exceeds {MAX_PROMPT_CHARS} characters.")
    files = data.get("files") or []
    if not isinstance(files, list) or len(files) > MAX_FILES:
        raise BadRequest(f"At most {MAX_FILES} files.")
    parts, meta, total = [], [], 0
    for f in files:
        if not isinstance(f, dict):
            raise BadRequest("Invalid file entry.")
        name = _safe_name(f.get("name"))
        ext = os.path.splitext(name)[1].lower()
        if ext not in TYPES:
            raise BadRequest(f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(TYPES))}.")
        b64 = f.get("dataBase64")
        if not isinstance(b64, str):
            raise BadRequest(f"{name}: dataBase64 must be a base64 string.")
        try:
            raw = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            raise BadRequest(f"{name}: dataBase64 is not valid base64.")
        if not raw:
            raise BadRequest(f"{name} is empty.")
        if len(raw) > MAX_FILE_BYTES:
            raise BadRequest(f"{name} is over 4 MB (Model Armor limit per file).")
        total += len(raw)
        if total > MAX_TOTAL_BYTES:
            raise BadRequest("Files are over 5 MB together.")
        parts.append({"inlineData": {"mimeType": TYPES[ext], "data": base64.b64encode(raw).decode("ascii")}})
        meta.append({"name": name, "mime": TYPES[ext], "bytes": len(raw)})
    return flow, action, scenario_id, prompt, parts, meta


# Proxy response headers passed back to the browser (raw panel). Shared with server.py (text and document views).
RESPONSE_HEADERS_KEEP = ("x-armor-mode", "x-armor-verdict", "x-armor-filters", "x-armor-latency-ms",
                         "x-armor-response-latency-ms", "x-armor-stage", "x-armor-input", "x-request-id",
                         "content-type", "x-demo-mock")


def header(headers, name):
    return next((v for k, v in (headers or {}).items() if str(k).lower() == name.lower()), None)


def keep_headers(headers):
    return {k: v for k, v in (headers or {}).items() if str(k).lower() in RESPONSE_HEADERS_KEEP}


def _json_header(headers, name, default):
    try:
        v = header(headers, name)
        return json.loads(v) if v else default
    except ValueError:
        return default


def _int(v, default=0):
    """int() that never raises: proxy headers and bodies are untrusted input."""
    if isinstance(v, bool):
        return default
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _str_list(v):
    return [str(x)[:60] for x in v if isinstance(x, str)] if isinstance(v, list) else []


def _clean_parts(parts):
    """Per-part verdicts from the proxy: keep dicts with an int part number; filters always a list of strings."""
    out = []
    for p in parts if isinstance(parts, list) else []:
        if not isinstance(p, dict) or isinstance(p.get("n"), bool) or not isinstance(p.get("n"), int):
            continue
        q = dict(p)
        q["filters"] = _str_list(p.get("filters") or [])
        q["ms"] = _int(p.get("ms"), 0)
        q["kind"] = str(p.get("kind") or "file")[:40]
        q["verdict"] = str(p.get("verdict") or "")[:20]
        out.append(q)
    return out


def _clean_response(resp):
    """Answer screening summary {verdict, text:{verdict, filters}, image:{...}}; anything malformed -> None."""
    if not isinstance(resp, dict):
        return None
    out = dict(resp)
    for key in ("text", "image"):
        v = resp.get(key)
        if isinstance(v, dict):
            out[key] = dict(v, filters=_str_list(v.get("filters") or []), findings=_str_list(v.get("findings") or []))
        else:
            out[key] = None
    return out


def _answer(resp_json):
    """(text, image) from a Gemini response; image = {mimeType, dataBase64} or None."""
    try:
        parts = resp_json["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError, TypeError):
        return "", None
    if not isinstance(parts, list):
        return "", None
    text = "".join(p["text"] for p in parts if isinstance(p, dict) and isinstance(p.get("text"), str) and not p.get("thought"))
    img = next((p["inlineData"] for p in parts if isinstance(p, dict) and isinstance(p.get("inlineData"), dict)), None)
    ok = img and isinstance(img.get("data"), str) and img.get("data") and isinstance(img.get("mimeType"), str)
    image = {"mimeType": img["mimeType"][:40], "dataBase64": img["data"]} if ok else None
    return text, image


def _mock(flow, action, prompt, meta):
    """Offline stand-in for the proxy: guesses verdicts from the sample file names."""
    time.sleep(0.6 + 0.3 * len(meta))
    rules = {"injection": ["pi_and_jailbreak"], "card": ["sdp"], "pii": ["sdp"]}
    parts = [{"n": 1, "kind": "text", "verdict": "allowed", "filters": [], "ms": random.randint(250, 500),
              "bytes": len(prompt), "forwarded": True}]
    for i, m in enumerate(meta, 2):
        kind = {"image/png": "IMAGE", "image/jpeg": "IMAGE", "image/bmp": "IMAGE", "application/pdf": "PDF",
                "text/plain": "TXT", "text/csv": "CSV"}.get(m["mime"]) or (
            "WORD_DOCUMENT" if m["name"].endswith(".docx") else "EXCEL_DOCUMENT" if m["name"].endswith(".xlsx") else "POWERPOINT_DOCUMENT")
        filters = next((v for k, v in rules.items() if k in m["name"]), [])
        verdict = "incomplete" if "six-images" in m["name"] else ("blocked" if filters else "allowed")
        parts.append({"n": i, "kind": kind, "verdict": verdict, "filters": filters, "ms": random.randint(1200, 2600),
                      "bytes": m["bytes"], "forwarded": kind in ("IMAGE", "PDF", "TXT", "CSV") and not m["name"].endswith(".bmp")})
    if any(p["verdict"] == "blocked" for p in parts):
        return 400, {"verdict": "blocked", "stage": "prompt", "parts": parts, "response": None, "text": "", "image": None}
    if any(p["verdict"] == "incomplete" for p in parts):
        return 503, {"verdict": "incomplete", "stage": "prompt", "parts": parts, "response": None, "text": "", "image": None}
    if flow == "image":
        state = "redacted" if action == "redact" else "blocked"
        resp = {"verdict": "redacted" if state == "redacted" else "blocked", "text": None,
                "image": {"verdict": "blocked", "state": state, "action": action, "filters": ["sdp"], "findings": ["PHONE_NUMBER", "EMAIL_ADDRESS"]}}
        if state == "blocked":
            return 400, {"verdict": "blocked", "stage": "response", "parts": parts, "response": resp, "text": "", "image": None}
        return 200, {"verdict": "redacted", "stage": "response", "parts": parts, "response": resp,
                     "text": "(mock) Here is the sign. Connect the demo server to Apigee to see a real generated image.", "image": None}
    return 200, {"verdict": "allowed", "stage": "response", "parts": parts, "response": {"verdict": "allowed", "text": {"verdict": "allowed", "filters": []}, "image": None},
                 "text": "(mock) Every part passed Model Armor, so Apigee forwarded the request to Gemini.", "image": None}


def run(data, cfg):
    """Handle POST /api/multimodal: one request to the multimodal proxy, screened with ServiceCallouts (REST API).

    Apigee's built-in SanitizeUserPrompt / SanitizeModelResponse policies screen text only, so this view does not
    use them (the proxy still accepts x-armor-mode: native, which rejects attachments; see screen-multi-modality.md).
    cfg: api_key, apigee_host, ssl_ctx, mock, record(scenario, mode, filters, status, verdict, ms), mask_key.
    """
    flow, action, scenario_id, prompt, file_parts, meta = _parse(data)
    path = "generate-image" if flow == "image" else "generate"
    url = f"https://{cfg['apigee_host']}/model-armor-multimodal/{path}"
    req_headers = {"Content-Type": "application/json", "x-demo-scenario": scenario_id, "x-armor-mode": "callout", "x-armor-image-action": action}
    shown_headers = {**req_headers, "x-api-key": cfg["mask_key"](cfg["api_key"]) or "(not set)"}
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}] + file_parts}]}
    preview = {"contents": [{"role": "user", "parts": [{"text": f"<prompt, {len(prompt):,} chars>"}] +
                             [{"inlineData": {"mimeType": m["mime"], "data": f"<base64, {m['name']}, {m['bytes']:,} bytes>"}} for m in meta]}]}
    start = time.time()
    if cfg["mock"]:
        status, r = _mock(flow, action, prompt, meta)
        resp_headers, resp_json = {"X-Demo-Mock": "true"}, None
    else:
        req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST",
                                     headers={**req_headers, "x-api-key": cfg["api_key"]})
        try:
            with urllib.request.urlopen(req, context=cfg["ssl_ctx"], timeout=TIMEOUT_S) as resp:
                status, resp_headers, raw = resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            status, resp_headers, raw = e.code, dict(e.headers or {}), e.read()
        except Exception as e:
            ms = int((time.time() - start) * 1000)
            cfg["record"](scenario_id, "mm-callout", None, 502, "error", ms)
            return {"ok": False, "httpStatus": 502, "latencyMs": ms, "verdict": "error", "stage": "gateway", "flow": flow,
                    "imageAction": action, "parts": [], "files": meta, "response": None, "text": "", "image": None,
                    "error": f"Could not reach the Apigee gateway: {e.__class__.__name__}",
                    "requestHeaders": shown_headers, "requestBody": preview, "responseHeaders": {}}
        try:
            resp_json = json.loads(raw.decode("utf-8"))
        except Exception:
            resp_json = {"raw": raw[:500].decode("utf-8", errors="replace")}
        err = resp_json.get("error") if isinstance(resp_json, dict) else None
        err = err if isinstance(err, dict) else None
        armor = err.get("armor") if err else None
        armor = armor if isinstance(armor, dict) else {}
        if status == 200:
            text, image = _answer(resp_json)
            verdict = header(resp_headers, "X-Armor-Verdict")
            r = {"verdict": verdict if verdict in ("allowed", "redacted") else "allowed", "stage": "response",
                 "parts": _json_header(resp_headers, "X-Armor-Parts", []),
                 "response": _json_header(resp_headers, "X-Armor-Response", None), "text": text, "image": image}
        else:
            verdict = {400: "blocked", 503: "incomplete"}.get(status, "error")
            if err and err.get("status") == "INVALID_ARGUMENT":
                verdict = "error"
            message = err.get("message") if err else None
            r = {"verdict": verdict, "stage": str(err.get("stage") or "prompt")[:20] if err else "gateway",
                 "parts": armor.get("parts"), "response": armor.get("response"), "text": "", "image": None,
                 "error": str(message)[:500] if message else ("Gateway error" if not err else None)}
    r["parts"] = _clean_parts(r.get("parts"))
    r["response"] = _clean_response(r.get("response"))
    if not isinstance(r.get("text"), str):
        r["text"] = ""
    ms = int((time.time() - start) * 1000)
    # Attach file names to parts (part 1 = text, parts 2.. = files in order).
    for p in r["parts"]:
        n = p["n"]
        p["name"] = "Prompt text" if n == 1 else (meta[n - 2]["name"] if 0 <= n - 2 < len(meta) else f"part {n}")
    matched = [f"p{p['n']}:{f}" for p in r["parts"] for f in p["filters"]]
    resp_img = (r["response"] or {}).get("image") or {}
    matched += [f"response:{f}" for f in resp_img.get("filters") or []]
    audit_verdict = {"allowed": "allowed", "redacted": "allowed", "blocked": "blocked"}.get(r["verdict"], "error")
    cfg["record"](scenario_id, "mm-callout", ",".join(matched) or None, status, audit_verdict, ms,
                  request_id=header(resp_headers, "X-Request-Id"))
    return {
        "ok": r["verdict"] in ("allowed", "redacted"), "httpStatus": status, "latencyMs": ms, "flow": flow, "imageAction": action,
        "verdict": r["verdict"], "stage": r["stage"], "parts": r["parts"], "files": meta, "response": r.get("response"),
        "text": r.get("text", ""), "image": r.get("image"), "error": r.get("error"),
        "armorLatencyMs": _int(header(resp_headers, "X-Armor-Latency-Ms")) if not cfg["mock"] else sum(p["ms"] for p in r["parts"]),
        "armorResponseLatencyMs": _int(header(resp_headers, "X-Armor-Response-Latency-Ms")) if not cfg["mock"] else 0,
        "requestHeaders": shown_headers, "requestBody": preview,
        "responseHeaders": keep_headers(resp_headers),
    }
