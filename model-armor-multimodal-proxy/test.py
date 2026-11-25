#!/usr/bin/env python3
"""Live tests for model-armor-multimodal-proxy (PASS/FAIL). Assets: test-data/multimodal (synthetic).

Usage: python3 model-armor-multimodal-proxy/test.py         (key from web-ui/.env, host from APIGEE_HOST)
  M1  text + clean image                 -> 200, all parts allowed
  M2  text + image with typed injection  -> 400, part 2 pi_and_jailbreak (OCR)
  M3  text + payment card image          -> 400, part 2 sdp
  M4  text + Word CV, injection ONLY inside the embedded image -> 400, part 2 pi_and_jailbreak
  M5  text + PowerPoint (card in a slide image) + Excel (PII) -> 400, parts 2 and 3 sdp
  M6  text + Word with 6 embedded images (over Model Armor's limit) -> 503 fail closed
  M7  text + clean Word -> 200, Gemini told the Office file passed screening
  M8  generate-image, redact: sign with phone + email -> 200 redacted, findings listed  (may vary: LLM output)
  M9  generate-image, block: same prompt -> 400 stage=response
  M10 unsupported type (webp) -> 400 INVALID_ARGUMENT;  M11 bad key -> 401
  H1-H4 stage verdict headers on M1 (allowed), M2 (prompt blocked), M6 (prompt incomplete), M9 (response blocked):
      X-Armor-Verdict (response verdict, unchanged), X-Armor-Prompt-Verdict, X-Armor-Response-Verdict
"""
import base64, json, os, ssl, sys, time, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, "test-data", "multimodal")
env = {}
if os.path.exists(os.path.join(ROOT, "web-ui", ".env")):
    for line in open(os.path.join(ROOT, "web-ui", ".env")):
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.strip().split("=", 1); env[k] = v.strip().strip('"')
HOST = os.environ.get("APIGEE_HOST") or env.get("APIGEE_HOST") or "YOUR_APIGEE_HOST"
KEY = os.environ.get("API_KEY") or env.get("API_KEY")
if not KEY:
    sys.exit("❌ API_KEY not set (run ./scripts/setup-apigee.sh)")
CTX = ssl._create_unverified_context() if HOST.endswith(".nip.io") else ssl.create_default_context()
MIME = {".png": "image/png", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}


def part(name, mime=None):
    return {"inlineData": {"mimeType": mime or MIME[os.path.splitext(name)[1]],
                           "data": base64.b64encode(open(os.path.join(D, name), "rb").read()).decode()}}


def call(path, text, files=(), action=None, key=None):
    body = {"contents": [{"role": "user", "parts": [{"text": text}] + list(files)}]}
    h = {"Content-Type": "application/json", "x-api-key": key or KEY, "x-demo-scenario": "mm-test"}
    if action:
        h["x-armor-image-action"] = action
    req = urllib.request.Request(f"https://{HOST}/model-armor-multimodal/{path}", data=json.dumps(body).encode(), headers=h, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=180) as r:
            return r.status, dict(r.headers), json.loads(r.read()), time.time() - t0
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, dict(e.headers), json.loads(raw), time.time() - t0
        except ValueError:
            return e.code, dict(e.headers), {"raw": raw[:300].decode(errors="replace")}, time.time() - t0


def parts_of(code, headers, body):
    if code == 200:
        return json.loads(next((v for k, v in headers.items() if k.lower() == "x-armor-parts"), "[]"))
    return ((body.get("error") or {}).get("armor") or {}).get("parts") or []


PASS = FAIL = 0
def check(name, cond, detail):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"  ✅ {name}: {detail}")
    else:
        FAIL += 1; print(f"  ❌ {name}: {detail}")


hget = lambda h, k: next((v for kk, v in h.items() if kk.lower() == k.lower()), None)
def verdict_headers(name, h, verdict, prompt, response):
    got = (hget(h, "X-Armor-Verdict"), hget(h, "X-Armor-Prompt-Verdict"), hget(h, "X-Armor-Response-Verdict"))
    check(name, got == (verdict, prompt, response), f"verdict/prompt/response = {got}, want {(verdict, prompt, response)}")


print(f"🎯 https://{HOST}/model-armor-multimodal")
c, h, b, s = call("generate", "What is in this picture? One sentence.", [part("img-clean.png")])
p = parts_of(c, h, b)
check("M1 text + clean image", c == 200 and [x["verdict"] for x in p] == ["allowed", "allowed"],
      f"HTTP {c} parts={[(x['kind'], x['verdict'], x.get('ms')) for x in p]} {s:.1f}s")
verdict_headers("H1 allowed headers", h, "allowed", "allowed", "allowed")

for name, fname, flt in [("M2 typed injection in image (OCR)", "img-injection.png", "pi_and_jailbreak"),
                         ("M3 payment card image", "img-card.png", "sdp"),
                         ("M4 injection only inside a Word file's embedded image", "doc-embedded-injection.docx", "pi_and_jailbreak")]:
    c, h, b, s = call("generate", "Please review the attachment.", [part(fname)])
    p = parts_of(c, h, b)
    check(name, c == 400 and len(p) == 2 and p[0]["verdict"] == "allowed" and flt in p[1]["filters"],
          f"HTTP {c} parts={[(x['kind'], x['verdict'], x['filters']) for x in p]} {s:.1f}s")
    if fname == "img-injection.png":
        verdict_headers("H2 prompt blocked headers", h, "blocked", "blocked", "none")

c, h, b, s = call("generate", "Summarise these files.", [part("deck-card.pptx"), part("sheet-pii.xlsx")])
p = parts_of(c, h, b)
check("M5 PowerPoint + Excel", c == 400 and len(p) == 3 and "sdp" in p[1]["filters"] and "sdp" in p[2]["filters"],
      f"HTTP {c} parts={[(x['kind'], x['verdict'], x['filters']) for x in p]} {s:.1f}s")

c, h, b, s = call("generate", "Summarise this catalogue.", [part("doc-six-images.docx")])
p = parts_of(c, h, b)
check("M6 Word with 6 images (over the 5-image limit)", c == 503 and len(p) == 2 and p[1]["verdict"] == "incomplete",
      f"HTTP {c} status={(b.get('error') or {}).get('status')} parts={[(x['kind'], x['verdict']) for x in p]} {s:.1f}s")
verdict_headers("H3 prompt incomplete headers", h, "incomplete", "incomplete", "none")

c, h, b, s = call("generate", "I attached my CV. Reply with one short sentence acknowledging it.", [part("doc-clean.docx")])
p = parts_of(c, h, b)
ans = "".join(x.get("text", "") for x in ((b.get("candidates") or [{}])[0].get("content") or {}).get("parts", []))
check("M7 clean Word file (screen-only, not sent to Gemini)", c == 200 and p and p[1]["forwarded"] is False,
      f"HTTP {c} parts={[(x['kind'], x['verdict'], x['forwarded']) for x in p]} answer={ans[:70]!r}")

# No PII in the prompt itself (SDP would block it at the prompt stage); the model invents the email address.
# (A made-up phone number is not reliable: image models draw fictional 555 numbers, which SDP doesn't flag.)
SIGN = ("Generate a photo-realistic image of a small bakery shop sign on a wooden board. Under the shop name "
        "'Bayside Bakery', show an email address for orders in large, clear letters.")
c, h, b, s = call("generate-image", SIGN, action="redact")
rj = json.loads(hget(h, "X-Armor-Response") or "null") if c == 200 else (b.get("error") or {}).get("armor", {}).get("response")
img = rj and rj.get("image") or {}
check("M8 generated image, redact", c == 200 and img.get("state") == "redacted",
      f"HTTP {c} verdict={hget(h, 'X-Armor-Verdict')} image={img} {s:.1f}s  (LLM output varies: re-run if the model drew no contact details)")
if c == 200:
    for x in b["candidates"][0]["content"]["parts"]:
        if "inlineData" in x:
            out = os.path.join(os.environ.get("MM_TEST_OUT", "/tmp"), "mm-redacted.png")
            open(out, "wb").write(base64.b64decode(x["inlineData"]["data"])); print(f"     redacted image saved: {out}")

c, h, b, s = call("generate-image", SIGN, action="block")
err = b.get("error") or {}
check("M9 generated image, block", c == 400 and err.get("stage") == "response",
      f"HTTP {c} stage={err.get('stage')} response={(err.get('armor') or {}).get('response')} {s:.1f}s")
verdict_headers("H4 response blocked headers", h, "blocked", "allowed", "blocked")

c, h, b, s = call("generate", "x", [{"inlineData": {"mimeType": "image/webp", "data": "AAAA"}}])
check("M10 unsupported type", c == 400 and (b.get("error") or {}).get("status") == "INVALID_ARGUMENT", f"HTTP {c} {(b.get('error') or {}).get('message')}")
c, h, b, s = call("generate", "hello", key="bad-key")
check("M11 bad key", c == 401, f"HTTP {c}")

print(f"Result: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
