# model-armor-via-servicecallout-proxy

A minimal Apigee X proxy that screens prompts **and uploaded files** with Model Armor through a
`ServiceCallout` to the Model Armor REST API, then forwards clean requests to Gemini 2.5 Flash-Lite.
It is the callout-only part of `apigee-model-armor-101-proxy`, with no `SanitizeUserPrompt`, mode
switch or audit logging.

```
client ──x-api-key──▶ VA-Verify-API-Key
                      JS-Prepare-Request   one text part, or one PDF/TXT/CSV file (base64)
                      SC-Model-Armor       POST modelarmor.<loc>.rep.googleapis.com/.../templates/<id>:sanitizeUserPrompt
                      JS-Evaluate-Armor    allowed | blocked | incomplete
                        ├─ blocked     ▶ 400 BLOCKED_BY_MODEL_ARMOR (+ matchedFilters)
                        ├─ incomplete  ▶ 503 (fail closed)
                        └─ allowed     ▶ Gemini (Vertex AI) ▶ 200
```

| Policy | Purpose |
|---|---|
| `VA-Verify-API-Key` | `x-api-key` header |
| `JS-Prepare-Request` | Builds `userPromptData.text` or `userPromptData.byteItem` (`PDF`/`TXT`/`CSV`); rebuilds the Gemini body from exactly what Model Armor screens (files get the proxy-owned `fileInstruction`) |
| `SC-Model-Armor` | ServiceCallout with `GoogleAccessToken` (runtime SA needs `roles/modelarmor.user`), 20 s timeout |
| `JS-Evaluate-Armor` | Verdict; every filter in `requiredFilters` must report `EXECUTION_SUCCESS` |
| `RF-Armor-Blocked` / `RF-Armor-Incomplete` / `RF-Bad-Request` | 400 / 503 / 400 JSON errors |
| `AM-Prepare-Gemini-Request`, `AM-Set-Target-URL` | Strip client credentials, call Vertex AI with the runtime SA |

## Deploy and test

```bash
ARMOR_LOCATION=us-central1 ./model-armor-via-servicecallout-proxy/deploy.sh   # import, deploy, add to the demo API product
./model-armor-via-servicecallout-proxy/test.sh                                # 7 PASS/FAIL checks (text + PDF)
```

`deploy.sh` adds this proxy to `apigee-model-armor-101-product`, so the existing demo key in `web-ui/.env` works.

## Request examples

```bash
# text
curl -sk -X POST "https://YOUR_APIGEE_HOST/model-armor-via-servicecallout/generate" \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Explain what an API gateway does."}]}]}'

# file (PDF, text/plain or text/csv, max ~1 MB)
python3 -c 'import base64,json; print(json.dumps({"contents":[{"role":"user","parts":[{"inlineData":{"mimeType":"application/pdf","data":base64.b64encode(open("test-data/resume-clean-sample.pdf","rb").read()).decode()}}]}]}))' > /tmp/req.json
curl -sk -X POST "https://YOUR_APIGEE_HOST/model-armor-via-servicecallout/generate" \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" --data @/tmp/req.json
```
