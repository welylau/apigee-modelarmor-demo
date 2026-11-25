# Screen a document: how the proxy handles PDF / TXT / CSV files

This page explains, step by step, how **Screen a document** works: what the demo server does, which Apigee
policies run in which order, and how the uploaded file reaches **Model Armor as a `byteItem`** before
**Gemini** ever sees it. For the overall demo, see the main [README](README.md).

This view screens a document's **text**. For pictures, Word / Excel / PowerPoint files, pictures inside documents
and answer screening, see **Screen any modality** ([screen-multi-modality.md](screen-multi-modality.md)).
[Section 9](#9-how-this-differs-from-screen-any-modality) compares the two.

> [!IMPORTANT]
> **This is not an official Google product.** It is a demo / reference implementation provided as-is.

## Contents

1. [The idea in one picture](#1-the-idea-in-one-picture)
2. [Why two paths for one file](#2-why-two-paths-for-one-file)
3. [Step 0: the demo server (BFF)](#3-step-0-the-demo-server-bff)
4. [The proxy, step by step](#4-the-proxy-step-by-step)
5. [What comes back](#5-what-comes-back)
6. [Try it with curl](#6-try-it-with-curl)
7. [Limits and gotchas](#7-limits-and-gotchas)
8. [Where to change things](#8-where-to-change-things)
9. [How this differs from Screen any modality](#9-how-this-differs-from-screen-any-modality)

## 1. The idea in one picture

```
Browser ──upload──▶ demo server (BFF, POST /api/upload)
                      │
                      ├─ native path ─▶ extract text (pdf_text.py) ─▶ text part ────────────┐
                      │                                                                     │
                      └─ callout path ─▶ raw file, base64 ─▶ one inlineData part ──────────┤
                                                                                            ▼
                         Apigee proxy  POST /apigee-model-armor-101/generate   (x-armor-mode: native | callout)
                           1  VA-Verify-API-Key       who is calling
                           2  AM-Armor-Init           defaults + start the Armor timer
                           3  JS-Prepare-Armor        validate the body, build the Model Armor request
                              RF-Bad-Request          wrong shape -> 400 INVALID_ARGUMENT
                           4a SUP-Sanitize-Prompt     native:  userPromptData.text   (text only)
                           4b SC-Model-Armor          callout: userPromptData.byteItem {PDF|TXT|CSV}
                           5  JS-Evaluate-Armor       one verdict for both modes (fail closed)
                              RF-Armor-Blocked / RF-Armor-Incomplete   -> 400 / 503
                           6  AM-Prepare-Gemini-Request   strip credentials
                              Gemini generateContent  (only if allowed)
                              AM-Armor-Headers + ML-Log-Audit          telemetry, no content
```

The browser never talks to Apigee directly. The demo server adds the API key, calls the proxy **twice in
parallel** (once per mode) and returns both results, which the UI shows side by side. The step numbers match the
comments in [`proxies/default.xml`](apigee-model-armor-101-proxy/apiproxy/proxies/default.xml).

## 2. Why two paths for one file

| | Native path | Callout path |
|---|---|---|
| Apigee policy | `SanitizeUserPrompt` (built in) | `ServiceCallout` to the Model Armor REST API |
| Model Armor field | `userPromptData.text` | `userPromptData.byteItem` (`byteDataType`, `byteData`) |
| Who reads the PDF | **Your app** — here, the demo server (`pdf_text.py`) — extracts the text first | **Model Armor** parses the raw PDF itself |
| What Gemini gets | The extracted text, with an instruction (the body is rebuilt from the screened text only) | The same PDF bytes Model Armor screened, with an instruction |
| Limit | 8,000 characters, including the fixed instruction and document header | ~1 MB file |

The native `SanitizeUserPrompt` policy only takes a text template (`<UserPromptSource>`), so it cannot screen a
binary file. To protect a document with the native policy, something must turn the file into text first. The
REST API also accepts a `byteItem`, so the callout path can send the file as-is and let Model Armor read it.

Comparing the two side by side shows the trade-off: the callout path screens exactly the bytes Gemini receives,
and the native path depends on how well the text was extracted.

### Why the native policy can screen a document here

The native policy never receives the file. The **demo server** opens the file, pulls out the text and sends that
text to Apigee as an ordinary prompt. To `SanitizeUserPrompt` it is just a long piece of text, so it works.
Three things follow from that:

- **The application does the work, not the gateway.** Any app that wants native screening of documents needs its
  own text-extraction step before it calls Apigee.
- **Only text gets through.** Pictures inside the document are dropped by the extraction and are never screened.
  (On this path Gemini doesn't get them either: it only receives the extracted text.)
- **Only formats the server can extract are supported:** PDF, TXT, MD, CSV and JSON.

### What this view does not screen

| Not screened | Why |
|---|---|
| **Pictures inside the document** | The native path only has the extracted text. The callout path sends the whole PDF, but this proxy's Model Armor template screens **text only**, so Model Armor reads the PDF's text and not its pictures. Gemini still receives the pictures, inside the PDF. |
| **Gemini's answer** | `SMR-Sanitize-Response` is attached but disabled in this proxy. |

You can see the first gap with [`test-data/multimodal/pdf-embedded-injection.pdf`](test-data/multimodal/pdf-embedded-injection.pdf).
Its text is a clean CV; the prompt injection is only inside an embedded picture.

| Where you send it | Result (tested) |
|---|---|
| **Screen a document**, native | `200` allowed (the extracted text is clean) |
| **Screen a document**, callout | `200` allowed (the text-only template doesn't look inside the picture) |
| **Screen any modality** | `400` blocked, `pi_and_jailbreak` on the PDF part |

Screening pictures needs a Model Armor template with the image modality, in a location that supports images, and
the REST callout. That is what **Screen any modality** does: see [section 9](#9-how-this-differs-from-screen-any-modality)
and [screen-multi-modality.md](screen-multi-modality.md).

## 3. Step 0: the demo server (BFF)

`POST /api/upload` in [`web-ui/server.py`](web-ui/server.py) receives `{filename, dataBase64}` from the browser.
The file is kept in memory only, never written to disk.

1. **Check the file.** Allowed extensions and how they are sent:

   | Extension | MIME sent to the proxy | Model Armor `byteDataType` |
   |---|---|---|
   | `.pdf` | `application/pdf` | `PDF` |
   | `.txt`, `.md`, `.json` | `text/plain` | `TXT` |
   | `.csv` | `text/csv` | `CSV` |

   Max 1 MB. A `.pdf` must contain `%PDF-` within its first 1 KB, and text files must be UTF-8.

2. **Extract text for the native path.** [`web-ui/pdf_text.py`](web-ui/pdf_text.py) (Python stdlib only) reads
   FlateDecode streams, object streams, `Tj` / `TJ` text operators and ToUnicode maps. It does **not** do OCR.
   **Invisible text (white, tiny, off-page) is extracted on purpose**, because an LLM would read it too.

3. **Build the two request bodies.**

   Native: the instruction plus the extracted text, as one text part:

   ```json
   {"contents":[{"role":"user","parts":[{"text":"You are reviewing an uploaded document. Summarise it in three short bullet points.\n\n--- Document: cv.pdf ---\n<extracted text>"}]}]}
   ```

   Callout: the raw file as one `inlineData` part:

   ```json
   {"contents":[{"role":"user","parts":[{"inlineData":{"mimeType":"application/pdf","data":"<base64>"}}]}]}
   ```

4. **Skip the native path when it would be unsafe.** If no text could be extracted, or the native prompt (fixed
   instruction + document header + extracted text) is longer than 8,000 characters, the native call is **not sent** (the UI shows "Not sent"). The text is never cut short,
   because the cut-off part would reach Gemini without being screened.

5. **Call the proxy twice in parallel** with `x-armor-mode: native` and `x-armor-mode: callout`, and return
   both results plus the extracted text (shown under the two columns in the UI).

## 4. The proxy, step by step

All steps live in the `generate` flow of [`proxies/default.xml`](apigee-model-armor-101-proxy/apiproxy/proxies/default.xml)
(`POST /apigee-model-armor-101/generate`).

### Step 1: `VA-Verify-API-Key`: who is calling

Runs in the PreFlow. It checks the `x-api-key` header against the API product. A bad key gets `401` from the
`invalid-api-key` FaultRule, before anything is screened.

### Step 2: `AM-Armor-Init`: safe defaults

[`AM-Armor-Init.xml`](apigee-model-armor-101-proxy/apiproxy/policies/AM-Armor-Init.xml) sets `armor.start_ms`
(used later for the "Armor check" time) and defaults (`armor.mode=native`, `armor.input=text`,
`armor.matched=none`), so every error body is still valid JSON.

### Step 3: `JS-Prepare-Armor`: validate the body and build the Model Armor request

[`prepare-armor.js`](apigee-model-armor-101-proxy/apiproxy/resources/jsc/prepare-armor.js) is where a file
becomes a `byteItem`. It accepts **exactly one user content with exactly one part**, so what Model Armor screens
is exactly what Gemini receives:

- **A text part** (both modes): up to `maxPromptChars` (8,000). The body sent to Gemini is rebuilt from that
  text only.
- **One `inlineData` part** (callout mode only):
  - Native mode with a file → rejected with a clear message (`Files need x-armor-mode: callout…`).
  - MIME type must be `application/pdf`, `text/plain` or `text/csv`.
  - `data` must be standard base64 (length a multiple of 4) and at most `maxFileBase64Chars` (1,400,000).

For a valid file it sets these variables:

| Variable | Value |
|---|---|
| `armor.input` | `file:PDF`, `file:TXT` or `file:CSV` (telemetry only) |
| `private.armor.callout_body` | `{"userPromptData":{"byteItem":{"byteDataType":"PDF","byteData":"<base64>"}}}` |
| `request.content` | **Rewritten** to `{"contents":[{"role":"user","parts":[{"text":"<fileInstruction>"},{"inlineData":{...same bytes...}}]}]}` |

Two details matter for security:

- **`private.` prefix**: Apigee masks `private.*` variables in Debug sessions, so the file and prompt don't show up in a trace.
- **The proxy owns the request body.** In text mode, the body sent to Gemini is rebuilt from the screened text; in
  file mode, from the `fileInstruction` property plus the screened bytes. Anything else the client sent
  (`systemInstruction`, tools, generation settings, extra parts) is dropped.

The mapping inside the script:

```js
var FILE_TYPES = {
  'application/pdf': { armor: 'PDF', gemini: 'application/pdf' },
  'text/plain':      { armor: 'TXT', gemini: 'text/plain' },
  'text/csv':        { armor: 'CSV', gemini: 'text/plain' }   // Gemini gets CSV as plain text
};
```

### Step 3 (continued): `RF-Bad-Request`: reject anything else

Runs when `armor.input_ok != "true"`. It returns `400 INVALID_ARGUMENT` with the fixed reason set by `JS-Prepare-Armor` (the
input is never echoed back). Nothing has been sent to Model Armor or Gemini at this point.

### Step 4a: `SUP-Sanitize-Prompt` (native mode): text only

Runs when `armor.mode = "native"`. [`SUP-Sanitize-Prompt.xml`](apigee-model-armor-101-proxy/apiproxy/policies/SUP-Sanitize-Prompt.xml):

```xml
<SanitizeUserPrompt name="SUP-Sanitize-Prompt">
    <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>   <!-- fail closed -->
    <ModelArmor>
        <TemplateName>projects/{propertyset.demo.armor_project}/locations/{propertyset.demo.armor_location}/templates/{propertyset.demo.armor_template}</TemplateName>
    </ModelArmor>
    <UserPromptSource>{private.armor.prompt}</UserPromptSource>
</SanitizeUserPrompt>
```

For documents, this screens the text the demo server extracted. A match raises the `FilterMatched` fault.

### Step 4b: `SC-Model-Armor` (callout mode): the file as a `byteItem`

Runs when `armor.mode = "callout"`. [`SC-Model-Armor.xml`](apigee-model-armor-101-proxy/apiproxy/policies/SC-Model-Armor.xml)
posts the body from step 3 to the Model Armor REST API (shortened; see the file for the full policy):

```xml
<ServiceCallout name="SC-Model-Armor">
    <Request variable="armorRequest" clearPayload="true">
        <Set>
            <Payload contentType="application/json">{private.armor.callout_body}</Payload>
            <Verb>POST</Verb>
        </Set>
        <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>
    </Request>
    <Response>armorResponse</Response>
    <Timeout>20000</Timeout>   <!-- PDF parsing is slower than plain text -->
    <HTTPTargetConnection>
        <Authentication>
            <GoogleAccessToken>
                <Scopes><Scope>https://www.googleapis.com/auth/cloud-platform</Scope></Scopes>
            </GoogleAccessToken>
        </Authentication>
        <URL>https://modelarmor.{propertyset.demo.armor_location}.rep.googleapis.com/v1/projects/{propertyset.demo.armor_project}/locations/{propertyset.demo.armor_location}/templates/{propertyset.demo.armor_template}:sanitizeUserPrompt</URL>
    </HTTPTargetConnection>
</ServiceCallout>
```

- **Same template, same filters** as the native path. Only the input type differs.
- **Regional endpoint**: a template in `<location>` only answers on `modelarmor.<location>.rep.googleapis.com`; the global host returns `403`.
- **Identity**: `GoogleAccessToken` uses the proxy's deployment service account, which needs `roles/modelarmor.user`.
- **Timeout 20 s**: Model Armor has to open and parse the PDF.
- A non-2xx answer or a timeout sets `servicecallout.SC-Model-Armor.failed`, which leads to `503` (step 5).

### Step 5: `JS-Evaluate-Armor`: one verdict, fail closed

[`evaluate-armor.js`](apigee-model-armor-101-proxy/apiproxy/resources/jsc/evaluate-armor.js) reads either the
native policy's `responseFromModelArmor` or the callout's `armorResponse.content`, then sets:

| Variable | Meaning |
|---|---|
| `armor.verdict` | `allowed`, `blocked` or `incomplete` |
| `armor.matched` / `armor.filters_json` | Matched filter names, e.g. `pi_and_jailbreak,rai:dangerous` |
| `armor.latency_ms` | Time since step 2: the "Armor check" in the UI |

`allowed` needs **all** of these: `filterMatchState = NO_MATCH_FOUND`, `invocationResult = SUCCESS` (when reported),
and `EXECUTION_SUCCESS` for every filter in the `requiredFilters` property (`rai,sdp,pi_and_jailbreak,malicious_uris`).
If a filter was skipped, for example because Model Armor could not parse the document, the verdict is `incomplete`, not `allowed`.

### Step 5 (continued): block or hold back

| Policy | Condition | Result |
|---|---|---|
| `RF-Armor-Blocked` | `armor.verdict = "blocked"` | FaultRule `armor-blocked` → `AM-Error-Armor-Blocked`: `400 BLOCKED_BY_MODEL_ARMOR` with the filter names |
| `RF-Armor-Incomplete` | `armor.verdict != "allowed"` | FaultRule `armor-unavailable` → `AM-Error-Armor-Unavailable`: `503 ARMOR_UNAVAILABLE` |

The native path reaches the same `armor-blocked` FaultRule through its own `FilterMatched` fault, so both modes
return the same error shape. In both cases **Gemini is never called**.

### Step 6: `AM-Prepare-Gemini-Request`: strip credentials

Only clean input gets here. It removes `x-api-key`, `authorization`, `x-armor-mode`, `x-demo-scenario` and key
query parameters, so no client credential reaches Vertex AI.

### Then: Gemini

The TargetEndpoint ([`targets/default.xml`](apigee-model-armor-101-proxy/apiproxy/targets/default.xml)) sets
`target.url` from the property set (`AM-Set-Target-URL`) and calls `…/models/<model>:generateContent` with the
proxy's Google identity (I/O timeout 60 s). In callout mode Gemini receives the `fileInstruction` text plus **the same PDF bytes
Model Armor screened**, and reads the PDF natively.

### Response: telemetry, never content

- `AM-Armor-Headers` adds `X-Armor-Mode`, `X-Armor-Input` (`file:PDF`), `X-Armor-Verdict`, `X-Armor-Filters` and `X-Armor-Latency-Ms` to the response. In this proxy `X-Armor-Verdict` is the **prompt** (input) verdict; the multimodal proxy uses it for the answer (see [screen-multi-modality.md](screen-multi-modality.md#step-9-telemetry-never-content)).
- If Gemini itself returns an error (Vertex AI `4xx` / `5xx`), the `DefaultFaultRule` still sets the `X-Armor-*` headers, so the UI keeps the file's verdict and Model Armor time next to the model error.
- `ML-Log-Audit` (PostClientFlow) writes mode, verdict and filter names to Cloud Logging (log `apigee-model-armor-101-logs`). File content and prompt text are never logged.

`SMR-Sanitize-Response` (screening Gemini's answer) is attached in the response flow but disabled in this demo. Its
step runs only for text input (`armor.input = text`), so even when enabled it is skipped for a file.

## 5. What comes back

Clean file (callout mode), `200`:

```
X-Armor-Mode: callout
X-Armor-Input: file:PDF
X-Armor-Verdict: allowed
X-Armor-Filters: none
X-Armor-Latency-Ms: 1633
{"candidates":[{"content":{"role":"model","parts":[{"text":"Here is a summary of the document in three bullet points:\n\n*   Sarah Lim is an FP&A Lead with 8 years of experience ..."}]}}], ...}
```

The injection sample CV ([`test-data/resume-injection-sample.pdf`](test-data/resume-injection-sample.pdf)), `400`:

```json
{"error":{"code":400,"status":"BLOCKED_BY_MODEL_ARMOR",
  "message":"Prompt blocked by Model Armor before it reached Gemini.",
  "armor":{"mode":"callout","verdict":"blocked",
           "matchedFilters":["rai:harassment","rai:dangerous","pi_and_jailbreak"],"latencyMs":1802},
  "requestId":"..."}}
```

A file sent with `x-armor-mode: native`, `400`:

```json
{"error":{"code":400,"status":"INVALID_ARGUMENT",
  "message":"Files need x-armor-mode: callout. The native SanitizeUserPrompt policy only screens text, so extract the text and send it as a text part.", ...}}
```

## 6. Try it with curl

```bash
B64=$(base64 < test-data/resume-injection-sample.pdf | tr -d '\n')
curl -sk -X POST "https://YOUR_APIGEE_HOST/apigee-model-armor-101/generate" \
  -H "x-api-key: YOUR_API_KEY" -H "x-armor-mode: callout" -H "Content-Type: application/json" \
  -d "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"inlineData\":{\"mimeType\":\"application/pdf\",\"data\":\"$B64\"}}]}]}" \
  -D - | grep -iE "^HTTP|^x-armor"
```

Expected: `HTTP/2 400`, `x-armor-input: file:PDF`, `x-armor-verdict: blocked`.
Swap in `test-data/resume-clean-sample.pdf` for a `200` with Gemini's three-bullet summary.
Regenerate both sample CVs with `python3 scripts/make-test-resume.py && python3 scripts/make-test-resume.py --clean`
(no flag writes the injection CV, `--clean` the clean one).

## 7. Limits and gotchas

- **Size**: the demo server accepts 1 MB; the proxy accepts up to 1,400,000 base64 characters (~1 MB of file).
- **Types**: this proxy accepts `PDF`, `TXT` and `CSV` only. Other text formats (`.md`, `.json`) are sent as `TXT`; Word and image files are rejected. Model Armor's `byteItem` also supports images and Word / Excel / PowerPoint files: use **Screen any modality** for those ([screen-multi-modality.md](screen-multi-modality.md)).
- **Pictures inside a PDF are not screened**: this proxy's template screens text only. On the callout path Gemini still receives them inside the PDF. See [section 2](#what-this-view-does-not-screen).
- **Native path = text only**: a file in native mode is always `400 INVALID_ARGUMENT`. Extract the text yourself, as the demo server does.
- **No truncation**: a native prompt over 8,000 characters (including the fixed instruction and document header)
  is not sent at all on the native path, so no unscreened text can reach Gemini.
- **Scanned PDFs**: `pdf_text.py` does no OCR, so a scanned PDF gives no text and the native path is skipped. The callout path still sends the file to Model Armor.
- **Fail closed**: an unparseable document, a skipped filter, a timeout or a Model Armor error all give `503`, never `200`.
- **Regional host**: use `modelarmor.<location>.rep.googleapis.com` for a regional template; the global host returns `403`.
- **Timeouts**: PDF screening plus Gemini can take several seconds. The demo server waits 60 s per call
  (`GATEWAY_TIMEOUT_S`), the Model Armor callout 20 s, the Gemini target 60 s, and Cloud Run allows 300 s per request.

## 8. Where to change things

| To change | Edit |
|---|---|
| Allowed MIME types / `byteDataType` mapping | `FILE_TYPES` in [`prepare-armor.js`](apigee-model-armor-101-proxy/apiproxy/resources/jsc/prepare-armor.js) |
| Max text length / max file size | `maxPromptChars` / `maxFileBase64Chars` in [`JS-Prepare-Armor.xml`](apigee-model-armor-101-proxy/apiproxy/policies/JS-Prepare-Armor.xml) |
| What Gemini is asked to do with a file | `fileInstruction` in `JS-Prepare-Armor.xml` (and `FILE_INSTRUCTION` in `server.py`, so both paths match) |
| Filters that must run before `allowed` | `requiredFilters` in [`JS-Evaluate-Armor.xml`](apigee-model-armor-101-proxy/apiproxy/policies/JS-Evaluate-Armor.xml) (keep in line with the template) |
| Template / region | `armor_project`, `armor_location`, `armor_template` in [`demo.properties`](apigee-model-armor-101-proxy/apiproxy/resources/properties/demo.properties) |
| Callout timeout | `<Timeout>` in [`SC-Model-Armor.xml`](apigee-model-armor-101-proxy/apiproxy/policies/SC-Model-Armor.xml) |
| Demo server upload types and limits | `UPLOAD_TYPES`, `MAX_UPLOAD_BYTES`, `NATIVE_MAX_CHARS` in [`web-ui/server.py`](web-ui/server.py) |

## 9. How this differs from Screen any modality

The demo has two views that send a file to Model Armor. In the web UI, the **ⓘ** button next to either section
title (or **ⓘ Document vs any modality** in the result card) opens a pop-up with this comparison.

| | **Screen a document** (this page) | **Screen any modality** ([guide](screen-multi-modality.md)) |
|---|---|---|
| Question it answers | Can Apigee screen a document's **text**, with either mode? | Can Apigee screen **everything else**: pictures, Office files, pictures inside documents, and the model's answer? |
| Apigee proxy | `apigee-model-armor-101-proxy` | `model-armor-multimodal-proxy` |
| Model Armor template | `apigee-model-armor-101`: text only, regional | `apigee-mm-inspect` and `apigee-mm-redact`: text and images, in `us`, `eu` or `global` |
| What you send | One file; the instruction is fixed | Your own prompt plus up to 3 files |
| File types | PDF, TXT, MD, CSV, JSON (max 1 MB) | PNG, JPEG, BMP, PDF, Word, Excel, PowerPoint, TXT, CSV (max 4 MB each, 5 MB together) |
| Native policy | **Used.** The demo server extracts the text first, then `SanitizeUserPrompt` screens it | **Not used in the UI.** The built-in policies screen text only, so they can't check a picture or a file |
| REST callout | One `ServiceCallout`: the file as a `byteItem` | One `ServiceCallout` **per part**: the text, then each file |
| Pictures inside a document | Not screened | Screened, up to 5 per document |
| Gemini's answer | Not screened | Screened; generated images are blocked or redacted |
| File over Model Armor's limits | Not applicable (1 MB cap) | Over 4 MB: `400` before screening. Over 5 embedded pictures: `503`, fail closed |

**Which one to use**

- Use **Screen a document** to show that a text document, including hidden text, can be protected with **either**
  Apigee mode, and what the native path needs from the application (text extraction).
- Use **Screen any modality** when the input or the answer is more than text. Only the REST callout can screen it.

The same PDF can give a different result in the two views, because the templates differ. The tested example is in
[section 2](#what-this-view-does-not-screen).
