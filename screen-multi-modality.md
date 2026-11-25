# Screen any modality: how the proxy handles text, pictures and documents, in both directions

This page explains, step by step, how **Screen any modality** works: what the demo server does, which Apigee
policies run in which order, how each part of a prompt (text, picture, PDF, Word, Excel, PowerPoint) reaches
**Model Armor** before **Gemini** sees it, and how Gemini's answer, including a generated image, is screened on the
way back. For the overall demo, see the main [README](README.md).

This view uses the **Model Armor REST API through Apigee `ServiceCallout` policies**. Apigee's built-in
`SanitizeUserPrompt` / `SanitizeModelResponse` policies screen text only, so the web UI does not use them here.
For the text-only document flow that compares both Apigee modes, see [screen-a-doc.md](screen-a-doc.md).

> [!IMPORTANT]
> **This is not an official Google product.** It is a demo / reference implementation provided as-is.

## Contents

1. [The idea in one picture](#1-the-idea-in-one-picture)
2. [Why a separate proxy, and why the REST callout](#2-why-a-separate-proxy-and-why-the-rest-callout)
3. [One-time setup](#3-one-time-setup)
4. [Step 0: the demo server (BFF)](#4-step-0-the-demo-server-bff)
5. [The proxy, step by step: the prompt](#5-the-proxy-step-by-step-the-prompt)
6. [The proxy, step by step: the answer](#6-the-proxy-step-by-step-the-answer)
7. [What comes back](#7-what-comes-back)
8. [Try it with curl](#8-try-it-with-curl)
9. [Sample files and what each one shows](#9-sample-files-and-what-each-one-shows)
10. [Limits and gotchas](#10-limits-and-gotchas)
11. [Where to change things](#11-where-to-change-things)
12. [Native mode in this proxy](#12-native-mode-in-this-proxy)
13. [How this differs from Screen a document](#13-how-this-differs-from-screen-a-document)

## 1. The idea in one picture

```
Browser ──prompt + up to 3 files──▶ demo server (BFF, POST /api/multimodal)
                                      │  one Gemini request: 1 text part + 1 inlineData part per file
                                      ▼
   Apigee proxy  POST /model-armor-multimodal/generate          (text answer,  chat model)
                 POST /model-armor-multimodal/generate-image    (image answer, image model)

   PROMPT (request flow)
     1  VA-Verify-API-Key          who is calling
     2  AM-MM-Init                 defaults + start the timer
     3  JS-Split-Parts             validate, split into parts, build one Model Armor body per part
        RF-Bad-Request             wrong shape or file type -> 400 INVALID_ARGUMENT
     4  SC-MM-Part-1 … 4           one Model Armor call per part (sanitizeUserPrompt)
                                     part 1 = the text         -> userPromptData.text
                                     part 2… = each file       -> userPromptData.byteItem {IMAGE | PDF | WORD_DOCUMENT | …}
        JS-Evaluate-Parts          one verdict per part, then one for the request (fail closed)
     5  RF-MM-Blocked / RF-MM-Incomplete      -> 400 / 503, Gemini is never called
     6  AM-Prepare-Gemini-Request  strip credentials
        Gemini generateContent     (only if every part is clean)

   ANSWER (response flow)
     7  JS-Split-Response          find the answer text and the generated image
        SC-MM-Resp-Text            sanitizeModelResponse, text
        SC-MM-Resp-Image           sanitizeModelResponse, byteItem IMAGE
     8  JS-Apply-Response          pass, block, or swap in Model Armor's redacted image
        RF-MM-Blocked / RF-MM-Incomplete      -> 400 / 503, the answer is held back
     9  AM-MM-Headers + ML-Log-Audit          telemetry, never content
```

The browser never talks to Apigee directly. The demo server adds the API key and sends **one** request. The
**proxy** does the splitting and calls Model Armor once per part, so the gateway does the work, not the app.

## 2. Why a separate proxy, and why the REST callout

Four facts about Model Armor shape this design. They come from the Model Armor documentation
([Screen images](https://docs.cloud.google.com/model-armor/screen-images),
[Feature availability by region](https://docs.cloud.google.com/model-armor/feature-availability-by-region),
[Integrations](https://docs.cloud.google.com/model-armor/integrations#modalities)), checked in November 2026.

| Fact | What it means here |
|---|---|
| **Apigee's built-in Model Armor policies screen text only.** Pictures and documents are supported by the REST API. | Every part is screened with a `ServiceCallout` to the REST API. |
| **Model Armor screens one item per call:** one text, or one picture, or one document. Text and a picture can't be combined in one call. | The proxy splits the prompt into parts and makes one call per part. |
| **Picture screening is only available in some locations:** `us`, `eu` and `global` support it; `us-central1` and `asia-southeast1` do not. | This proxy uses its own templates in the `us` multi-region. The original 101 proxy keeps its regional, text-only template. |
| **Redacting a picture needs a de-identify template, but a de-identify template makes Model Armor skip documents that contain pictures.** | Two templates: one to inspect prompts and documents, one to redact standalone answer images. |

Apigee has no loop construct for policies, so the proxy has **four fixed callouts** (`SC-MM-Part-1` to
`SC-MM-Part-4`), each with a condition such as `mm.part_count >= 3`. Four covers the limit of one text part plus
three files. The callouts run one after the other, so screening time adds up across parts.

## 3. One-time setup

Run these once per project. `setup-model-armor-multimodal.sh` is safe to re-run: it creates what is missing and never
edits what exists. `deploy.sh` can also be re-run; each run imports and deploys a new proxy revision.

```bash
# 1. Model Armor + Sensitive Data Protection templates and IAM (location "us" by default)
./scripts/setup-model-armor-multimodal.sh

# 2. Import and deploy the proxy, and add it to the demo's API product (the existing key then works)
./model-armor-multimodal-proxy/deploy.sh
```

[`setup-model-armor-multimodal.sh`](scripts/setup-model-armor-multimodal.sh) creates:

| Resource | Purpose |
|---|---|
| Sensitive Data Protection inspect template `apigee-mm-inspect` | What counts as sensitive: card numbers, email addresses, phone numbers, US social security numbers, IBANs, and licence plates in pictures |
| Sensitive Data Protection de-identify template `apigee-mm-redact` | How to redact a picture: a black box over each finding |
| Model Armor template `apigee-mm-inspect` | Text **and image** modalities; Responsible AI, prompt injection and jailbreak, malicious URL, and Sensitive Data Protection (inspect only). Used for every prompt part and for answer text |
| Model Armor template `apigee-mm-redact` | The same filters plus the de-identify template. Used only for a generated answer image when the action is `redact` |
| IAM | The Model Armor service agent gets `roles/dlp.user` and `roles/dlp.reader`; the Apigee runtime service account gets `roles/modelarmor.user` |

Both Sensitive Data Protection templates must be in the **same location** as the Model Armor templates.

To use another location, set `MM_LOCATION` for both scripts (for example `MM_LOCATION=eu`). It must be a location
with image support. `deploy.sh` also accepts `ARMOR_LOCATION` (an alias, used when `MM_LOCATION` is unset) and
`ARMOR_PROJECT` (the project that holds the Model Armor templates, default `PROJECT_ID`); its other overrides are
`PROJECT_ID`, `APIGEE_ORG`, `APIGEE_ENV` and `PRODUCT`. Like `setup-apigee.sh`, it refuses to deploy a sanitized
tree (`YOUR_…` placeholders from `./sanitize.sh`): run `./restore.sh` first.

## 4. Step 0: the demo server (BFF)

`POST /api/multimodal` in [`web-ui/multimodal.py`](web-ui/multimodal.py) receives this from the browser:

```json
{"flow": "chat", "prompt": "Summarise these two files.", "imageAction": "redact", "scenarioId": "mm-office-pii",
 "files": [{"name": "deck-card.pptx", "dataBase64": "<base64>"}, {"name": "sheet-pii.xlsx", "dataBase64": "<base64>"}]}
```

Files are kept in memory only, never written to disk.

1. **Check the input.** A prompt is required (max 4,000 characters). At most 3 files, 4 MB each, 5 MB together.
   The file extension decides the MIME type sent to the proxy:

   | Extension | MIME type sent to the proxy |
   |---|---|
   | `.png`, `.jpg` / `.jpeg`, `.bmp` | `image/png`, `image/jpeg`, `image/bmp` |
   | `.pdf` | `application/pdf` |
   | `.txt`, `.csv` | `text/plain`, `text/csv` |
   | `.docx`, `.xlsx`, `.pptx` | The standard Office Open XML types (`…wordprocessingml.document`, `…spreadsheetml.sheet`, `…presentationml.presentation`) |

2. **Build one Gemini request.** The prompt becomes the text part and each file becomes one `inlineData` part:

   ```json
   {"contents":[{"role":"user","parts":[
     {"text":"Summarise these two files."},
     {"inlineData":{"mimeType":"application/vnd.openxmlformats-officedocument.presentationml.presentation","data":"<base64>"}},
     {"inlineData":{"mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","data":"<base64>"}}
   ]}]}
   ```

3. **Call the proxy once.** `flow: "chat"` goes to `/generate`, `flow: "image"` goes to `/generate-image`. The
   server adds `x-api-key`, `x-armor-mode: callout` and `x-armor-image-action: redact | block`.

4. **Return one result to the browser:** the verdict, one row per part (from the `X-Armor-Parts` header or the
   error body), the answer's own checks, and the answer text and image. The image is passed to the browser as it
   came from the proxy: either the original (nothing found) or Model Armor's redacted version.

## 5. The proxy, step by step: the prompt

All steps live in the `generate` and `generate-image` flows of
[`proxies/default.xml`](model-armor-multimodal-proxy/apiproxy/proxies/default.xml). The two flows run the same
steps; only the Gemini model differs.

### Step 1: `VA-Verify-API-Key`: who is calling

Runs in the PreFlow. It checks the `x-api-key` header against the API product. A bad key gets `401` from the
`invalid-api-key` FaultRule, before anything is screened.

### Step 2: `AM-MM-Init`: safe defaults

Sets `mm.t0` (the start time, used for the time per part) and defaults such as `mm.stage=prompt`,
`mm.verdict=pending` and `mm.parts_json=[]`, so every error body is still valid JSON.

### Step 3: `JS-Split-Parts`: validate, split, and build the Model Armor requests

[`split-parts.js`](model-armor-multimodal-proxy/apiproxy/resources/jsc/split-parts.js) accepts **exactly one user
content** with **exactly one text part** and **up to three `inlineData` parts**. Anything else is rejected.

For each file it maps the MIME type to a Model Armor `byteDataType`, and notes whether Gemini can read that type:

```js
var TYPES = {
  'image/png':       { armor: 'IMAGE', gemini: 'image/png' },
  'image/jpeg':      { armor: 'IMAGE', gemini: 'image/jpeg' },
  'image/bmp':       { armor: 'IMAGE', gemini: null },
  'application/pdf': { armor: 'PDF',   gemini: 'application/pdf' },
  'text/plain':      { armor: 'TXT',   gemini: 'text/plain' },
  'text/csv':        { armor: 'CSV',   gemini: 'text/plain' },
  '…wordprocessingml.document':   { armor: 'WORD_DOCUMENT',       gemini: null },
  '…spreadsheetml.sheet':         { armor: 'EXCEL_DOCUMENT',      gemini: null },
  '…presentationml.presentation': { armor: 'POWERPOINT_DOCUMENT', gemini: null }
};
```

It then sets these variables. The text is always **part 1**; files follow in the order they were sent.

| Variable | Value |
|---|---|
| `mm.part_count` | Number of parts, 1 to 4 (a number, so conditions like `mm.part_count >= 3` work) |
| `mm.part<N>.kind` | `text`, `IMAGE`, `PDF`, `WORD_DOCUMENT`, `EXCEL_DOCUMENT`, `POWERPOINT_DOCUMENT`, `TXT` or `CSV` |
| `private.mm.part<N>.body` | The Model Armor request for part N (see below) |
| `mm.model` | `model` for `/generate`, `image_model` for `/generate-image` (both from the property set) |
| `mm.image_action` | `redact` or `block`: the `x-armor-image-action` header, else the `responseImageAction` property |
| `mm.resp_image_template` | The redact template (action `redact`) or the inspect template (action `block`) |
| `request.content` | **Rewritten** to what Gemini will receive |

The two shapes of `private.mm.part<N>.body`:

```json
{"userPromptData":{"text":"Summarise these two files."}}
{"userPromptData":{"byteItem":{"byteDataType":"POWERPOINT_DOCUMENT","byteData":"<base64>"}}}
```

Three details matter:

- **`private.` prefix.** Apigee masks `private.*` variables in Debug sessions, so prompt text and file bytes
  don't show up in a trace.
- **Gemini gets only what it can read.** Pictures (PNG, JPEG), PDF and text files are forwarded as they are. For a
  type Gemini can't read (Word, Excel, PowerPoint, BMP), the file is **screened but not forwarded**: Gemini gets a
  short note instead, such as "An attached Word document passed Model Armor screening…".
- **The proxy owns the request body.** It is rebuilt from the validated parts, so any other field the client sent
  (`systemInstruction`, tools, generation settings) is dropped. For `/generate-image` the proxy adds
  `generationConfig.responseModalities: ["TEXT","IMAGE"]`.

`RF-Bad-Request` runs when `mm.input_ok != "true"`. It returns `400 INVALID_ARGUMENT` with a fixed reason (the
input is never echoed back). Nothing has been sent to Model Armor or Gemini at this point.

### Step 4: `SC-MM-Part-1` to `SC-MM-Part-4`: one Model Armor call per part

Each callout runs only if its part exists (`mm.part_count >= N`).
[`SC-MM-Part-2.xml`](model-armor-multimodal-proxy/apiproxy/policies/SC-MM-Part-2.xml), shortened:

```xml
<ServiceCallout name="SC-MM-Part-2">
    <Request variable="mmArmorResp2Req" clearPayload="true">
        <Set>
            <Payload contentType="application/json">{private.mm.part2.body}</Payload>
            <Verb>POST</Verb>
        </Set>
        <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>
    </Request>
    <Response>mmArmorResp2</Response>
    <Timeout>25000</Timeout>
    <HTTPTargetConnection>
        <Authentication>
            <GoogleAccessToken>
                <Scopes><Scope>https://www.googleapis.com/auth/cloud-platform</Scope></Scopes>
            </GoogleAccessToken>
        </Authentication>
        <URL>https://modelarmor.{propertyset.demo.armor_location}.rep.googleapis.com/v1/projects/{propertyset.demo.armor_project}/locations/{propertyset.demo.armor_location}/templates/{propertyset.demo.armor_template_inspect}:sanitizeUserPrompt</URL>
    </HTTPTargetConnection>
</ServiceCallout>
```

- **Endpoint.** A template in `<location>` answers on `modelarmor.<location>.rep.googleapis.com`, here
  `modelarmor.us.rep.googleapis.com`.
- **Identity.** `GoogleAccessToken` uses the proxy's deployment service account, which needs `roles/modelarmor.user`.
- **Timeout 25 s** for each prompt part. In this demo text usually took about 0.4 to 0.8 s, a picture about 1.2 to
  1.4 s, and a document about 1.8 to 3.7 s, but document scans occasionally spiked past 20 s. The four part callouts,
  the Gemini target and the two answer callouts together stay under Cloud Run's 300 s (see
  [section 10](#10-limits-and-gotchas)).
- **What Model Armor does with each type.** For a picture it reads the words in the picture and screens them like
  text. For a document it screens the text and, because the template has the image modality, up to 5 pictures
  embedded in the document.
- After each callout, `AM-MM-Mark-<N>` records the time, which gives the time per part.
- A non-2xx answer or a timeout sets `servicecallout.SC-MM-Part-<N>.failed`, which leads to `503` (step 5).

### Step 4 (continued): `JS-Evaluate-Parts`: one verdict per part, then one for the request

[`evaluate-parts.js`](model-armor-multimodal-proxy/apiproxy/resources/jsc/evaluate-parts.js) reads each
`mmArmorResp<N>.content` through the shared [`armor-lib.js`](model-armor-multimodal-proxy/apiproxy/resources/jsc/armor-lib.js).

A part's verdict:

| Verdict | When |
|---|---|
| `blocked` | Any filter reports `MATCH_FOUND` |
| `allowed` | `filterMatchState = NO_MATCH_FOUND`, **and** `invocationResult` is `SUCCESS`, **and** every filter in `requiredFilters` (`rai,sdp,pi_and_jailbreak,malicious_uris`) reports `EXECUTION_SUCCESS` |
| `incomplete` | Anything else: a skipped filter, a partial or failed invocation, or an unreadable result |

The request's verdict: `blocked` if **any** part is blocked, else `incomplete` if any part is incomplete, else `allowed`.

| Variable | Meaning |
|---|---|
| `mm.verdict` | `allowed`, `blocked` or `incomplete` |
| `mm.matched` | Which part matched which filter, for example `p2:pi_and_jailbreak` or `p2:sdp,p3:sdp` |
| `mm.parts_json` | One entry per part: number, kind, verdict, filter names, time, size, forwarded to Gemini or not. No content |
| `mm.latency_ms` | Total Model Armor time for the prompt |

> [!IMPORTANT]
> **Why "no match" is not enough.** When a document is over Model Armor's limits (in this demo: more than 5
> embedded pictures; files over 4 MB are rejected with `400` by the demo server and the proxy before any call),
> Model Armor skips it and still answers `200` with `filterMatchState: NO_MATCH_FOUND`. Only
> `invocationResult: FAILURE` and `EXECUTION_SKIPPED` on every filter show that nothing was checked. The proxy
> treats that as `incomplete` and returns `503`. A proxy that only looked at the match state would let the file through.

### Step 5: block or hold back

| Policy | Condition | Result |
|---|---|---|
| `RF-MM-Blocked` | `mm.verdict = "blocked"` | FaultRule `mm-blocked` → `AM-Error-MM-Blocked`: `400 BLOCKED_BY_MODEL_ARMOR` with the per-part results |
| `RF-MM-Incomplete` | `mm.verdict != "allowed"` | FaultRule `mm-unavailable` → `AM-Error-MM-Unavailable`: `503 ARMOR_UNAVAILABLE` |

In both cases **Gemini is never called**.

### Step 6: `AM-Prepare-Gemini-Request`, then Gemini

Only a fully clean prompt gets here. The policy removes `x-api-key`, `authorization`, `x-armor-mode`,
`x-armor-image-action`, `x-demo-scenario` and key query parameters, so no client credential reaches Vertex AI.

The TargetEndpoint ([`targets/default.xml`](model-armor-multimodal-proxy/apiproxy/targets/default.xml)) sets
`target.url` from the property set and `mm.model` (`AM-Set-Target-URL`), and calls
`…/models/<model>:generateContent` with the proxy's Google identity. Its I/O timeout is 120 s, because image
generation is slower than text.

## 6. The proxy, step by step: the answer

### Step 7: `JS-Split-Response`, `SC-MM-Resp-Text`, `SC-MM-Resp-Image`

`AM-MM-Stage-Response` sets `mm.stage=response`, so errors say which direction they came from.

[`split-response.js`](model-armor-multimodal-proxy/apiproxy/resources/jsc/split-response.js) reads Gemini's answer
and builds one Model Armor body for the text and one for the image:

```json
{"modelResponseData":{"text":"Here's your bakery shop sign!"}}
{"modelResponseData":{"byteItem":{"byteDataType":"IMAGE","byteData":"<base64>"}}}
```

If the answer can't be screened as it is (it can't be parsed, it has more than one image, or the image is not PNG,
JPEG or BMP), the script sets `mm.resp_shape_ok=false` and the answer is held back in step 8.

Only text and image parts are screened, so only those are returned. Gemini "thought" parts (`"thought": true`) and
any other part type (`functionCall`, `fileData`, …) are removed from the answer before it leaves the gateway.

`SC-MM-Resp-Text` posts the text to `…/templates/<inspect template>:sanitizeModelResponse`.
`SC-MM-Resp-Image` posts the image to `…/templates/{mm.resp_image_template}:sanitizeModelResponse`:

| `x-armor-image-action` | Template used for the image | What Model Armor returns |
|---|---|---|
| `redact` (default) | `apigee-mm-redact` | The findings **and** `redactedImage`: the picture with a black box over each finding |
| `block` | `apigee-mm-inspect` | The findings only |

### Step 8: `JS-Apply-Response`: pass, block or redact

[`apply-response.js`](model-armor-multimodal-proxy/apiproxy/resources/jsc/apply-response.js) decides:

| Situation | Result |
|---|---|
| Nothing matched in the text or the image | `allowed`: the answer passes unchanged |
| The **text** matched any filter | `blocked` |
| The **image** matched, action `block` | `blocked` |
| The image matched **only** Sensitive Data Protection, action `redact`, every required filter ran (`EXECUTION_SUCCESS`), and Model Armor returned `redactedImage` | `redacted`: the proxy replaces the image bytes in Gemini's answer with the redacted image |
| The image matched anything else (prompt injection, Responsible AI, malicious URL), even with action `redact` | `blocked`: only sensitive data can be redacted |
| Anything could not be fully screened (including a redact result where a required filter did not run), or the image could not be swapped | `incomplete` (`503`) |

`RF-MM-Blocked` and `RF-MM-Incomplete` then run with the same FaultRules as step 5 (`400` / `503`), this time
with `"stage":"response"`. The original image never leaves the gateway in the `redacted`, `blocked` or
`incomplete` cases.

Model Armor's redact result also contains `extractedImageText`, the words it read in the picture. The proxy never
copies that field into a header, a body or a log.

### Step 9: telemetry, never content

- `AM-MM-Headers` adds these headers to a `200`: `X-Armor-Mode`, `X-Armor-Prompt-Verdict`,
  `X-Armor-Response-Verdict`, `X-Armor-Verdict`, `X-Armor-Filters`, `X-Armor-Latency-Ms`,
  `X-Armor-Response-Latency-Ms`, `X-Armor-Parts` (JSON, one entry per prompt part) and `X-Armor-Response` (JSON, the
  answer's text and image results). The `400` / `503` error responses carry `X-Armor-Mode`, `X-Armor-Stage`
  (`prompt` or `response`), the three verdict headers and `X-Armor-Latency-Ms`.

  | Header | Values | Meaning |
  |---|---|---|
  | `X-Armor-Prompt-Verdict` | `allowed`, `blocked`, `incomplete` | The prompt's verdict (all parts, step 4) |
  | `X-Armor-Response-Verdict` | `allowed`, `redacted`, `blocked`, `incomplete` (`none` if the answer was never reached) | The answer's verdict (step 8) |
  | `X-Armor-Verdict` | On a `200`, the same as `X-Armor-Response-Verdict`; on an error, the outcome (`blocked`, `incomplete`, `unsupported`) | Kept for compatibility. In the 101 proxy, `X-Armor-Verdict` is the **prompt** verdict |
- `ML-Log-Audit` (PostClientFlow) writes the stage, part count, verdicts, image action and filter names to Cloud
  Logging (log `apigee-model-armor-101-logs`, the same log as the 101 proxy). Prompt text, file bytes and image
  bytes are never logged.

## 7. What comes back

These are real responses from the deployed proxy, with request IDs and image data shortened. They were recorded
before `X-Armor-Prompt-Verdict` and `X-Armor-Response-Verdict` were added, so only `x-armor-verdict` is shown.

**Clean photo** (`/generate`, text + `img-clean.png`), `200`:

```
x-armor-mode: callout
x-armor-verdict: allowed
x-armor-latency-ms: 1691
x-armor-response-latency-ms: 428
x-armor-parts: [{"n":1,"kind":"text","verdict":"allowed","filters":[],"ms":408,"bytes":48,"forwarded":true},
                {"n":2,"kind":"IMAGE","verdict":"allowed","filters":[],"ms":1283,"bytes":155958,"forwarded":true}]
x-armor-response: {"verdict":"allowed","text":{"verdict":"allowed","filters":[]},"image":null}
{"candidates":[{"content":{"role":"model","parts":[{"text":"The picture shows a blue ceramic mug with a brown liquid in it, along with its description."}]}}]}
```

**PDF with an injection hidden in an embedded picture** (`pdf-embedded-injection.pdf`), `400`. The text part is
clean; part 2 is blocked:

```json
{"error":{"code":400,"status":"BLOCKED_BY_MODEL_ARMOR","stage":"prompt","message":"Blocked by Model Armor.",
  "armor":{"mode":"callout","verdict":"blocked","matched":"p2:pi_and_jailbreak",
    "parts":[{"n":1,"kind":"text","verdict":"allowed","filters":[],"ms":739,"bytes":41,"forwarded":true},
             {"n":2,"kind":"PDF","verdict":"blocked","filters":["pi_and_jailbreak"],"ms":2321,"bytes":46287,"forwarded":true}],
    "response":null,"latencyMs":3060},
  "requestId":"..."}}
```

**Word file with 6 embedded pictures** (`doc-six-images.docx`), `503`. Model Armor skipped the file, so the proxy
fails closed:

```json
{"error":{"code":503,"status":"ARMOR_UNAVAILABLE","stage":"prompt",
  "message":"Model Armor could not fully screen the input (for example a file over its size or embedded-image limits), so nothing was forwarded (fail closed).",
  "armor":{"mode":"callout","verdict":"incomplete",
    "parts":[{"n":1,"kind":"text","verdict":"allowed","filters":[],"ms":376,"bytes":25,"forwarded":true},
             {"n":2,"kind":"WORD_DOCUMENT","verdict":"incomplete","filters":[],"ms":3706,"bytes":926118,"forwarded":false}],
    "response":null},
  "requestId":"..."}}
```

**Generated image, action `redact`** (`/generate-image`), `200`. The image in the body is Model Armor's redacted version:

```
x-armor-verdict: redacted
x-armor-latency-ms: 700
x-armor-response-latency-ms: 4355
x-armor-response: {"verdict":"redacted","text":{"verdict":"allowed","filters":[]},
                   "image":{"verdict":"blocked","state":"redacted","action":"redact","filters":["sdp"],"findings":["EMAIL_ADDRESS"]}}
{"candidates":[{"content":{"role":"model","parts":[{"text":"Here's your bakery shop sign! \n"},
  {"inlineData":{"mimeType":"image/png","data":"<base64>"}}]}}]}
```

**Generated image, action `block`**, `400`. The prompt was clean (`"matched":"none"` covers the prompt parts); the
answer's result is under `armor.response`:

```json
{"error":{"code":400,"status":"BLOCKED_BY_MODEL_ARMOR","stage":"response","message":"Blocked by Model Armor.",
  "armor":{"mode":"callout","verdict":"blocked","matched":"none",
    "parts":[{"n":1,"kind":"text","verdict":"allowed","filters":[],"ms":381,"bytes":175,"forwarded":true}],
    "response":{"verdict":"blocked","text":{"verdict":"allowed","filters":[]},
                "image":{"verdict":"blocked","state":"blocked","action":"block","filters":["sdp"],"findings":["EMAIL_ADDRESS"]}},
    "latencyMs":381},
  "requestId":"..."}}
```

**Unsupported file type**, `400`:

```json
{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"Unsupported file type: image/webp.","requestId":"..."}}
```

## 8. Try it with curl

```bash
HOST=YOUR_APIGEE_HOST
KEY=YOUR_API_KEY

# 1. Text + a picture with a typed prompt injection: 400, blocked on part 2
printf '{"contents":[{"role":"user","parts":[{"text":"Please follow the note in this image."},{"inlineData":{"mimeType":"image/png","data":"%s"}}]}]}' \
  "$(base64 < test-data/multimodal/img-injection.png | tr -d '\n')" > /tmp/mm-request.json
curl -sk -X POST "https://$HOST/model-armor-multimodal/generate" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" -d @/tmp/mm-request.json

# 2. Generate an image and get it back redacted: 200, x-armor-verdict: redacted
curl -sk -X POST "https://$HOST/model-armor-multimodal/generate-image" \
  -H "x-api-key: $KEY" -H "x-armor-image-action: redact" -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Generate a photo-realistic image of a small bakery shop sign on a wooden board. Under the shop name \"Bayside Bakery\", show an email address for orders in large, clear letters."}]}]}' \
  -D /tmp/mm-headers.txt -o /tmp/mm-answer.json
grep -i "^x-armor-.*verdict\|^x-armor-response:" /tmp/mm-headers.txt
python3 -c 'import json,base64; p=json.load(open("/tmp/mm-answer.json"))["candidates"][0]["content"]["parts"]; open("/tmp/mm-image.png","wb").write(base64.b64decode(next(x["inlineData"]["data"] for x in p if "inlineData" in x)))'
# open /tmp/mm-image.png: the email address is covered by a black box
```

Use `-H "x-armor-image-action: block"` in the second call to get `400` with `"stage":"response"` instead.

The repo also has two test scripts:

```bash
node model-armor-multimodal-proxy/tests/mm-js.test.js    # offline tests of the proxy JavaScript
python3 model-armor-multimodal-proxy/test.py             # live tests M1 to M11 against the deployed proxy
```

`test.py` reads `API_KEY` and `APIGEE_HOST` from `web-ui/.env`.

## 9. Sample files and what each one shows

All files are synthetic (fictional names, public test card numbers). Regenerate them with
`python3 scripts/make-multimodal-assets.py` (needs Google Chrome for the pictures and the PDF).

| File in [`test-data/multimodal/`](test-data/multimodal/) | UI scenario | What it shows | Result |
|---|---|---|---|
| `img-clean.png` | Clean photo | A harmless picture passes and Gemini describes it | `200` |
| `img-clean.png` + `spec-mug.pdf` + `inventory-q4.csv` | Product launch pack | Happy flow across 3 modalities: photo, spec PDF, and Q4 stock CSV all pass; Gemini cross-checks them | `200` |
| `img-injection.png` | Injection in image | The prompt text is clean; the injection is typed inside the picture | `400`, picture: `pi_and_jailbreak` |
| `img-card.png` | Card photo | A photo of a payment card (test number) | `400`, picture: `sdp` |
| `doc-embedded-injection.docx` | Word: hidden in image | The Word text is clean; the injection is only inside an embedded picture | `400`, Word file: `pi_and_jailbreak` |
| `pdf-embedded-injection.pdf` | PDF: hidden in image | The same idea in a PDF. **Screen a document** allows this file; this view blocks it | `400`, PDF: `pi_and_jailbreak` |
| `deck-card.pptx` + `sheet-pii.xlsx` | Deck + sheet | A card number inside a slide picture, and customer data in a spreadsheet | `400`, both files: `sdp` |
| `doc-six-images.docx` | (test script only) | More than 5 embedded pictures: Model Armor skips the file | `503`, fail closed |
| (no file) | Generate a sign | The prompt is clean; the generated image contains an email address | `200` redacted, or `400` with action `block` |
| `doc-clean.docx` | (test script only) | A clean Word file passes; Gemini gets a note, not the file | `200` |
| `img-sign.png` | (not used by the UI) | A shop sign with a phone number and an email address, for trying redaction directly against Model Armor | |

## 10. Limits and gotchas

- **One text part plus up to 3 files.** More files need more `SC-MM-Part-<N>` callouts (see section 11).
- **4 MB per file** is Model Armor's limit for a picture or a document. The proxy also caps the files together
  at about 5 MB (`maxTotalBase64Chars`), and the demo server enforces the same limits first. A file over these
  limits gets `400` and is never sent to Model Armor.
- **At most 5 pictures inside one document.** Over that, Model Armor skips the whole document. The proxy returns
  `503`.
- **Location.** The templates must be in a location with image support. With a template that has no image
  support, a picture came back from Model Armor as `200` with `invocationResult: FAILURE`, which this proxy also
  treats as `incomplete`.
- **Time adds up.** Parts are screened one after the other. Three files can add 5 s or more before Gemini is called.
- **Image generation is slow and varies.** Most `/generate-image` runs took 9 to 12 s end to end, but two runs
  took 69 s and 102 s, with the time spent waiting for the image model. Keep client timeouts well above that. In this
  demo the demo server waits 285 s (`TIMEOUT_S` in `multimodal.py`), the Gemini target 120 s, each prompt-part
  callout 25 s, the answer-text callout 20 s, the answer-image callout 30 s, and Cloud Run allows 300 s per request.
  The proxy's worst case, 4 × 25 + 120 + 20 + 30 = 270 s, stays under the Cloud Run limit.
- **Generated images vary.** The sample prompt asks for an email address because that was detected reliably. In
  one run the model drew a made-up `555` phone number that was not flagged. If the model draws nothing sensitive,
  the image passes unchanged, and `test.py` check M8 fails for that run.
- **Redaction is coarse.** The black box can cover more than the sensitive text. How much is covered depends on
  the Sensitive Data Protection templates.
- **Only sensitive data can be redacted.** An injection or harmful content in a generated image always blocks.
- **Office files and BMP pictures are not sent to Gemini.** They are screened; Gemini gets a note. Gemini's answer
  is then based on the prompt and the other parts only.
- **Cost.** Model Armor bills pictures as tokens: 5,000 per picture plus 1,000 per MB, and a document as its text
  plus each embedded picture ([Screen images](https://docs.cloud.google.com/model-armor/screen-images)). Each
  `/generate-image` run also makes one image-model call.
- **Streaming is not supported.** Model Armor's streaming methods are text only.
- **What was tested.** PNG pictures, PDF, CSV, Word, Excel and PowerPoint files, and generated PNG images were tested
  through the deployed proxy. JPEG, BMP and TXT inputs are accepted by the proxy via the same `byteItem` path.
  Detection of objects in a picture (the licence plate setting in the inspect template) was not tested.

## 11. Where to change things

The proxy XML under `model-armor-multimodal-proxy/apiproxy/` (policies, flows, property values) is generated by
[`scripts/gen-mm-proxy.py`](scripts/gen-mm-proxy.py). To change an XML setting below, edit the generator and run
`python3 scripts/gen-mm-proxy.py`, rather than editing the XML by hand. The JavaScript under `resources/jsc/` is
hand-written; edit it directly.

| To change | Edit |
|---|---|
| Allowed MIME types, `byteDataType` mapping, what Gemini can read | `TYPES` in [`split-parts.js`](model-armor-multimodal-proxy/apiproxy/resources/jsc/split-parts.js), and `TYPES` in [`web-ui/multimodal.py`](web-ui/multimodal.py) |
| Max files, text length, file size | `maxFiles`, `maxTextChars`, `maxPartBase64Chars`, `maxTotalBase64Chars` in [`JS-Split-Parts.xml`](model-armor-multimodal-proxy/apiproxy/policies/JS-Split-Parts.xml) |
| More than 3 files | In the generator: add `SC-MM-Part-5` and `AM-MM-Mark-5` (like part 4), their steps in both flows, the callout in the `mm-unavailable` condition, and raise `maxFiles`; then regenerate |
| Default action for answer images | `responseImageAction` in `JS-Split-Parts.xml` (`redact` or `block`); per request, the `x-armor-image-action` header |
| Filters that must run before `allowed` | `requiredFilters` in [`JS-Evaluate-Parts.xml`](model-armor-multimodal-proxy/apiproxy/policies/JS-Evaluate-Parts.xml) and [`JS-Apply-Response.xml`](model-armor-multimodal-proxy/apiproxy/policies/JS-Apply-Response.xml) (keep in line with the templates) |
| Templates, location, models | `armor_location`, `armor_template_inspect`, `armor_template_redact`, `model`, `image_model` in [`demo.properties`](model-armor-multimodal-proxy/apiproxy/resources/properties/demo.properties) |
| What counts as sensitive, and how pictures are redacted | The Sensitive Data Protection templates in [`setup-model-armor-multimodal.sh`](scripts/setup-model-armor-multimodal.sh). The script never edits existing templates, so change them in the console or delete and re-create them |
| Callout timeout | `<Timeout>` in the `SC-MM-*.xml` policies |
| Demo server limits and sample scenarios | `MAX_FILES`, `MAX_FILE_BYTES`, `MAX_TOTAL_BYTES`, `SCENARIOS` in [`web-ui/multimodal.py`](web-ui/multimodal.py) |

## 12. Native mode in this proxy

The web UI always sends `x-armor-mode: callout`, which is also the default. The proxy still accepts
`x-armor-mode: native`, to show what the built-in policies can and can't do:

- `SUP-MM-Native-Prompt` (`SanitizeUserPrompt`) screens the **text part**, and `SMR-MM-Native-Response`
  (`SanitizeModelResponse`) screens the **answer text**. A text-only request works in native mode, in both directions.
- The built-in policies have no input for a picture or a file. A request with an attachment, and any
  `/generate-image` request, is **rejected before Gemini** (fail closed), so nothing unscreened is forwarded:

```json
{"error":{"code":400,"status":"NOT_SCREENABLE_BY_NATIVE_POLICY","stage":"prompt",
  "message":"Apigee's native SanitizeUserPrompt policy screens text only: 1 attachment could not be screened, so the request was rejected before Gemini (fail closed).",
  "armor":{"mode":"native","verdict":"unsupported","matched":"none",
    "parts":[{"n":1,"kind":"text","verdict":"allowed","filters":[],"ms":718,"bytes":24,"forwarded":true},
             {"n":2,"kind":"IMAGE","verdict":"unsupported","filters":[],"ms":null,"bytes":155958,"forwarded":false}],
    "response":null,"latencyMs":718},
  "requestId":"..."}}
```

That is why this view is callout-only: for every sample scenario, the native result would be this rejection.

## 13. How this differs from Screen a document

In the web UI, the **ⓘ** button next to either section title (or **ⓘ Document vs any modality** in the result
card) opens a pop-up with this comparison.

| | **Screen a document** ([guide](screen-a-doc.md)) | **Screen any modality** (this page) |
|---|---|---|
| Question it answers | Can Apigee screen a document's **text**, with either mode? | Can Apigee screen **everything else**: pictures, Office files, pictures inside documents, and the model's answer? |
| Apigee proxy | `apigee-model-armor-101-proxy` | `model-armor-multimodal-proxy` |
| Model Armor template | `apigee-model-armor-101`: text only, regional | `apigee-mm-inspect` and `apigee-mm-redact`: text and images, in `us`, `eu` or `global` |
| What you send | One file; the instruction is fixed | Your own prompt plus up to 3 files |
| File types | PDF, TXT, MD, CSV, JSON (max 1 MB) | PNG, JPEG, BMP, PDF, Word, Excel, PowerPoint, TXT, CSV (max 4 MB each, 5 MB together) |
| Native policy | **Used.** The demo server extracts the text first, then `SanitizeUserPrompt` screens it | **Not used in the UI.** The built-in policies screen text only |
| REST callout | One `ServiceCallout`: the file as a `byteItem` | One `ServiceCallout` **per part**: the text, then each file |
| Pictures inside a document | Not screened | Screened, up to 5 per document |
| Gemini's answer | Not screened | Screened; generated images are blocked or redacted |
| File over Model Armor's limits | Not applicable (1 MB cap) | Over 4 MB: `400` before screening. Over 5 embedded pictures: `503`, fail closed |

The same file can give a different result in the two views. `pdf-embedded-injection.pdf` has clean text and an
injection inside an embedded picture: **Screen a document** allows it in both modes, and **Screen any modality**
blocks it.
