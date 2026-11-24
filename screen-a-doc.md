# Screen a document: how the proxy handles PDF / TXT / CSV files

This page explains, step by step, how **Screen a document** works: what the demo server does, which Apigee
policies run in which order, and how the uploaded file reaches **Model Armor as a `byteItem`** before
**Gemini** ever sees it. For the overall demo, see the main [README](README.md).

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
                           4  RF-Bad-Request          wrong shape -> 400 INVALID_ARGUMENT
                           5a SUP-Sanitize-Prompt     native:  userPromptData.text   (text only)
                           5b SC-Model-Armor          callout: userPromptData.byteItem {PDF|TXT|CSV}
                           6  JS-Evaluate-Armor       one verdict for both modes (fail closed)
                           7  RF-Armor-Blocked / RF-Armor-Incomplete   -> 400 / 503
                           8  AM-Prepare-Gemini-Request   strip credentials
                           9  Gemini generateContent  (only if allowed)
                          10  AM-Armor-Headers + ML-Log-Audit          telemetry, no content
```

The browser never talks to Apigee directly. The demo server adds the API key, calls the proxy **twice in
parallel** (once per mode) and returns both results, which the UI shows side by side.

## 2. Why two paths for one file

| | Native path | Callout path |
|---|---|---|
| Apigee policy | `SanitizeUserPrompt` (built in) | `ServiceCallout` to the Model Armor REST API |
| Model Armor field | `userPromptData.text` | `userPromptData.byteItem` (`byteDataType`, `byteData`) |
| Who reads the PDF | **The demo server** (`pdf_text.py`) extracts the text first | **Model Armor** parses the raw PDF itself |
| What Gemini gets | The extracted text, with an instruction | The same PDF bytes Model Armor screened, with an instruction |
| Limit | 8,000 characters of text | ~1 MB file |

The native `SanitizeUserPrompt` policy only takes a text template (`<UserPromptSource>`), so it cannot screen a
binary file. To protect a document with the native policy, something must turn the file into text first. The
REST API also accepts a `byteItem`, so the callout path can send the file as-is and let Model Armor read it.

Comparing the two side by side shows the trade-off: the callout path screens exactly the bytes Gemini receives,
and the native path depends on how well the text was extracted.

## 3. Step 0: the demo server (BFF)

`POST /api/upload` in [`web-ui/server.py`](web-ui/server.py) receives `{filename, dataBase64}` from the browser.
The file is kept in memory only, never written to disk.

1. **Check the file.** Allowed extensions and how they are sent:

   | Extension | MIME sent to the proxy | Model Armor `byteDataType` |
   |---|---|---|
   | `.pdf` | `application/pdf` | `PDF` |
   | `.txt`, `.md`, `.json` | `text/plain` | `TXT` |
   | `.csv` | `text/csv` | `CSV` |

   Max 1 MB. A `.pdf` must start with `%PDF-`, and text files must be UTF-8.

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

4. **Skip the native path when it would be unsafe.** If no text could be extracted, or the text is longer than
   8,000 characters, the native call is **not sent** (the UI shows "Not sent"). The text is never cut short,
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

- **A text part** (both modes): up to `maxPromptChars` (8,000).
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
- **The proxy owns the instruction.** In file mode, the body sent to Gemini is rebuilt from the `fileInstruction`
  property plus the screened bytes. Anything else the client sent (`systemInstruction`, tools, extra parts) is dropped.

The mapping inside the script:

```js
var FILE_TYPES = {
  'application/pdf': { armor: 'PDF', gemini: 'application/pdf' },
  'text/plain':      { armor: 'TXT', gemini: 'text/plain' },
  'text/csv':        { armor: 'CSV', gemini: 'text/plain' }   // Gemini gets CSV as plain text
};
```

### Step 4: `RF-Bad-Request`: reject anything else

Runs when `armor.input_ok != "true"`. It returns `400 INVALID_ARGUMENT` with the fixed reason from step 3 (the
input is never echoed back). Nothing has been sent to Model Armor or Gemini at this point.

### Step 5a: `SUP-Sanitize-Prompt` (native mode): text only

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

### Step 5b: `SC-Model-Armor` (callout mode): the file as a `byteItem`

Runs when `armor.mode = "callout"`. [`SC-Model-Armor.xml`](apigee-model-armor-101-proxy/apiproxy/policies/SC-Model-Armor.xml)
posts the body from step 3 to the Model Armor REST API:

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
- A non-2xx answer or a timeout sets `servicecallout.SC-Model-Armor.failed`, which leads to `503` (step 7).

### Step 6: `JS-Evaluate-Armor`: one verdict, fail closed

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

### Step 7: block or hold back

| Policy | Condition | Result |
|---|---|---|
| `RF-Armor-Blocked` | `armor.verdict = "blocked"` | FaultRule `armor-blocked` → `AM-Error-Armor-Blocked`: `400 BLOCKED_BY_MODEL_ARMOR` with the filter names |
| `RF-Armor-Incomplete` | `armor.verdict != "allowed"` | FaultRule `armor-unavailable` → `AM-Error-Armor-Unavailable`: `503 ARMOR_UNAVAILABLE` |

The native path reaches the same `armor-blocked` FaultRule through its own `FilterMatched` fault, so both modes
return the same error shape. In both cases **Gemini is never called**.

### Step 8: `AM-Prepare-Gemini-Request`: strip credentials

Only clean input gets here. It removes `x-api-key`, `authorization`, `x-armor-mode`, `x-demo-scenario` and key
query parameters, so no client credential reaches Vertex AI.

### Step 9: Gemini

The TargetEndpoint ([`targets/default.xml`](apigee-model-armor-101-proxy/apiproxy/targets/default.xml)) sets
`target.url` from the property set (`AM-Set-Target-URL`) and calls `…/models/<model>:generateContent` with the
proxy's Google identity. In callout mode Gemini receives the `fileInstruction` text plus **the same PDF bytes
Model Armor screened**, and reads the PDF natively.

### Step 10: telemetry, never content

- `AM-Armor-Headers` adds `X-Armor-Mode`, `X-Armor-Input` (`file:PDF`), `X-Armor-Verdict`, `X-Armor-Filters` and `X-Armor-Latency-Ms` to the response.
- `ML-Log-Audit` (PostClientFlow) writes mode, verdict and filter names to Cloud Logging (log `apigee-model-armor-101-logs`). File content and prompt text are never logged.

`SMR-Sanitize-Response` (screening Gemini's answer) is attached in the response flow but disabled in this demo.

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
Regenerate both sample CVs with `python3 scripts/make-test-resume.py`.

## 7. Limits and gotchas

- **Size**: the demo server accepts 1 MB; the proxy accepts up to 1,400,000 base64 characters (~1 MB of file).
- **Types**: Model Armor's `byteItem` only knows `PDF`, `TXT` and `CSV`. Other text formats (`.md`, `.json`) are sent as `TXT`; Word and image files are rejected.
- **Native path = text only**: a file in native mode is always `400 INVALID_ARGUMENT`. Extract the text yourself, as the demo server does.
- **No truncation**: text over 8,000 characters is not sent at all on the native path, so no unscreened text can reach Gemini.
- **Scanned PDFs**: `pdf_text.py` does no OCR, so a scanned PDF gives no text and the native path is skipped. The callout path still sends the file to Model Armor.
- **Fail closed**: an unparseable document, a skipped filter, a timeout or a Model Armor error all give `503`, never `200`.
- **Regional host**: use `modelarmor.<location>.rep.googleapis.com` for a regional template; the global host returns `403`.
- **Ingress timeout**: PDF screening plus Gemini can take several seconds; keep the client timeout above that.

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
