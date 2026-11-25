#!/usr/bin/env python3
"""Generate the model-armor-multimodal-proxy bundle XML.

Usage (from anywhere):
    python3 scripts/gen-mm-proxy.py            # writes into <repo>/model-armor-multimodal-proxy/apiproxy
    python3 scripts/gen-mm-proxy.py <root>     # writes into <root>/model-armor-multimodal-proxy/apiproxy

The proxy has 4 identical part callouts, two flows with the same steps and long fault conditions,
so its XML (policies/, proxies/default.xml, targets/default.xml, resources/properties/demo.properties
and the bundle manifest) is generated here instead of edited by hand: change this script, re-run it,
and commit both. The JavaScript in apiproxy/resources/jsc/ is hand-written and NOT touched.

No secrets live here. The project id is the same literal default (YOUR_PROJECT_ID) the other bundles
use; model-armor-multimodal-proxy/deploy.sh rewrites vertex_project / armor_project / armor_location
in a staged copy at deploy time, and the publish sanitizer maps the literal like everywhere else.
"""
import os
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B = os.path.join(ROOT, "model-armor-multimodal-proxy", "apiproxy")
HDR = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
MAX_PARTS = 4
files = {}

def pol(name, body):
    files[f"policies/{name}.xml"] = HDR + body.strip() + "\n"

AUTH = """        <Authentication>
            <GoogleAccessToken>
                <Scopes>
                    <Scope>https://www.googleapis.com/auth/cloud-platform</Scope>
                </Scopes>
            </GoogleAccessToken>
        </Authentication>"""
MA_HOST = "https://modelarmor.{propertyset.demo.armor_location}.rep.googleapis.com/v1/projects/{propertyset.demo.armor_project}/locations/{propertyset.demo.armor_location}/templates/"

def sc(name, display, body_var, resp_var, template_expr, method, comment, timeout_ms=20000):
    pol(name, f"""
<ServiceCallout continueOnError="false" enabled="true" name="{name}">
    <DisplayName>{display}</DisplayName>
    <!-- {comment}
         Non-2xx or timeout -> FaultRule "mm-unavailable" (503, fail closed). -->
    <Request variable="{resp_var}Req" clearPayload="true">
        <Set>
            <Headers>
                <Header name="Content-Type">application/json</Header>
            </Headers>
            <Payload contentType="application/json">{{{body_var}}}</Payload>
            <Verb>POST</Verb>
        </Set>
        <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>
    </Request>
    <Response>{resp_var}</Response>
    <!-- Images and documents usually take 1.5-4 s each (Model Armor runs OCR / parses the file), with spikes
         past 20 s seen live. Worst case per request: 4 x 25 s (prompt parts) + 120 s (Gemini) + 20 s (answer text)
         + 30 s (answer image, redaction is slower) = 270 s, under the 300 s Cloud Run timeout. -->
    <Timeout>{timeout_ms}</Timeout>
    <HTTPTargetConnection>
        <!-- Token of the proxy's deployment service account (needs roles/modelarmor.user). -->
{AUTH}
        <!-- Multi-region endpoint: image screening needs us / eu / global (not us-central1). -->
        <URL>{MA_HOST}{template_expr}:{method}</URL>
    </HTTPTargetConnection>
</ServiceCallout>""")

# ---- request side ----
pol("VA-Verify-API-Key", """
<VerifyAPIKey continueOnError="false" enabled="true" name="VA-Verify-API-Key">
    <DisplayName>Verify API Key</DisplayName>
    <APIKey ref="request.header.x-api-key"/>
</VerifyAPIKey>""")

init_vars = [("mm.t0", None, "system.timestamp"), ("mm.stage", "prompt", None), ("mm.verdict", "pending", None),
             ("mm.matched", "none", None), ("mm.parts_json", "[]", None), ("mm.latency_ms", "0", None),
             ("mm.resp_verdict", "none", None), ("mm.resp_matched", "none", None), ("mm.resp_json", "null", None),
             ("mm.resp_latency_ms", "0", None), ("mm.image_action", "redact", None), ("mm.part_count", "0", None), ("mm.mode", "callout", None), ("mm.unsupported_reason", "", None)]
assigns = "\n".join(
    f"    <AssignVariable>\n        <Name>{n}</Name>\n" + (f"        <Ref>{r}</Ref>\n" if r else f"        <Value>{v}</Value>\n") + "    </AssignVariable>"
    for n, v, r in init_vars)
pol("AM-MM-Init", f"""
<AssignMessage continueOnError="false" enabled="true" name="AM-MM-Init">
    <DisplayName>Init Multimodal Armor Variables</DisplayName>
    <!-- Safe defaults so every error body is valid JSON, and the Armor timer starts here. -->
{assigns}
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</AssignMessage>""")

pol("JS-Split-Parts", """
<Javascript continueOnError="false" enabled="true" timeLimit="5000" name="JS-Split-Parts">
    <DisplayName>Split Prompt into Parts (text, images, documents)</DisplayName>
    <Properties>
        <Property name="maxFiles">3</Property>
        <Property name="maxTextChars">8000</Property>
        <!-- Model Armor limit: 4 MB per image or document (base64 = 4/3 of the bytes). -->
        <Property name="maxPartBase64Chars">5592408</Property>
        <Property name="maxTotalBase64Chars">7000000</Property>
        <!-- Response images: block (any match blocks) or redact (SDP findings are blacked out).
             Per request: header x-armor-image-action: block | redact. -->
        <Property name="responseImageAction">redact</Property>
    </Properties>
    <ResourceURL>jsc://split-parts.js</ResourceURL>
</Javascript>""")

pol("RF-Bad-Request", """
<RaiseFault continueOnError="false" enabled="true" name="RF-Bad-Request">
    <DisplayName>Unsupported Request Shape</DisplayName>
    <FaultResponse>
        <Set>
            <Headers>
                <Header name="X-Request-Id">{messageid}</Header>
            </Headers>
            <Payload contentType="application/json" variablePrefix="@" variableSuffix="#">{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"@mm.reject_reason#","requestId":"@messageid#"}}</Payload>
            <StatusCode>400</StatusCode>
            <ReasonPhrase>Bad Request</ReasonPhrase>
        </Set>
    </FaultResponse>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>""")

for n in range(1, MAX_PARTS + 1):
    sc(f"SC-MM-Part-{n}", f"Model Armor: sanitizeUserPrompt, part {n}", f"private.mm.part{n}.body", f"mmArmorResp{n}",
       "{propertyset.demo.armor_template_inspect}", "sanitizeUserPrompt",
       f"Part {n} of the prompt (text, or one image / document as a byteItem). Model Armor screens one item per call.",
       timeout_ms=25000)
    pol(f"AM-MM-Mark-{n}", f"""
<AssignMessage continueOnError="false" enabled="true" name="AM-MM-Mark-{n}">
    <DisplayName>Time After Part {n}</DisplayName>
    <AssignVariable>
        <Name>mm.t{n}</Name>
        <Ref>system.timestamp</Ref>
    </AssignVariable>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</AssignMessage>""")

pol("JS-Evaluate-Parts", """
<Javascript continueOnError="false" enabled="true" timeLimit="1000" name="JS-Evaluate-Parts">
    <DisplayName>One Verdict for All Parts (fail closed)</DisplayName>
    <Properties>
        <!-- Each must report EXECUTION_SUCCESS for a part to count as clean. -->
        <Property name="requiredFilters">rai,sdp,pi_and_jailbreak,malicious_uris</Property>
    </Properties>
    <IncludeURL>jsc://armor-lib.js</IncludeURL>
    <ResourceURL>jsc://evaluate-parts.js</ResourceURL>
</Javascript>""")

for name, code, phrase, disp in [("RF-MM-Blocked", 400, "Bad Request", "Model Armor Match (prompt or response)"),
                                 ("RF-MM-Incomplete", 503, "Service Unavailable", "Model Armor Result Incomplete")]:
    pol(name, f"""
<RaiseFault continueOnError="false" enabled="true" name="{name}">
    <DisplayName>{disp}</DisplayName>
    <!-- Body is set by the matching FaultRule (AM-Error-MM-*). -->
    <FaultResponse>
        <Set>
            <StatusCode>{code}</StatusCode>
            <ReasonPhrase>{phrase}</ReasonPhrase>
        </Set>
    </FaultResponse>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>""")

pol("AM-Prepare-Gemini-Request", """
<AssignMessage continueOnError="false" enabled="true" name="AM-Prepare-Gemini-Request">
    <DisplayName>Prepare Gemini Request</DisplayName>
    <!-- Never forward client credentials or demo headers to Vertex AI. -->
    <Remove>
        <Headers>
            <Header name="x-api-key"/>
            <Header name="x-goog-api-key"/>
            <Header name="authorization"/>
            <Header name="x-demo-scenario"/>
            <Header name="x-armor-image-action"/>
            <Header name="x-armor-mode"/>
        </Headers>
        <QueryParams>
            <QueryParam name="key"/>
            <QueryParam name="apikey"/>
        </QueryParams>
    </Remove>
    <Set>
        <Headers>
            <Header name="Content-Type">application/json</Header>
        </Headers>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="request"/>
</AssignMessage>""")

pol("AM-Set-Target-URL", """
<AssignMessage continueOnError="false" enabled="true" name="AM-Set-Target-URL">
    <DisplayName>Set Vertex AI Target URL (chat or image model)</DisplayName>
    <!-- mm.model is set by JS-Split-Parts: property model (POST /generate) or image_model (POST /generate-image). -->
    <AssignVariable>
        <Name>target.url</Name>
        <Template>https://{propertyset.demo.vertex_host}/v1/projects/{propertyset.demo.vertex_project}/locations/{propertyset.demo.vertex_location}/publishers/google/models/{mm.model}:generateContent</Template>
    </AssignVariable>
    <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>
</AssignMessage>""")

# ---- response side ----
pol("AM-MM-Stage-Response", """
<AssignMessage continueOnError="false" enabled="true" name="AM-MM-Stage-Response">
    <DisplayName>Mark Response Stage</DisplayName>
    <AssignVariable>
        <Name>mm.stage</Name>
        <Value>response</Value>
    </AssignVariable>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</AssignMessage>""")
pol("JS-Split-Response", """
<Javascript continueOnError="false" enabled="true" timeLimit="3000" name="JS-Split-Response">
    <DisplayName>Split Gemini Answer (text, image)</DisplayName>
    <ResourceURL>jsc://split-response.js</ResourceURL>
</Javascript>""")
sc("SC-MM-Resp-Text", "Model Armor: sanitizeModelResponse, text", "private.mm.resp_text_body", "mmArmorRespText",
   "{propertyset.demo.armor_template_inspect}", "sanitizeModelResponse", "Gemini's answer text.")
sc("SC-MM-Resp-Image", "Model Armor: sanitizeModelResponse, image", "private.mm.resp_image_body", "mmArmorRespImage",
   "{mm.resp_image_template}", "sanitizeModelResponse",
   "The generated image. mm.resp_image_template = the redact template (returns redactedImage) or the inspect template (block only).",
   timeout_ms=30000)
pol("JS-Apply-Response", """
<Javascript continueOnError="false" enabled="true" timeLimit="5000" name="JS-Apply-Response">
    <DisplayName>Block, Redact or Pass the Answer</DisplayName>
    <Properties>
        <Property name="requiredFilters">rai,sdp,pi_and_jailbreak,malicious_uris</Property>
    </Properties>
    <IncludeURL>jsc://armor-lib.js</IncludeURL>
    <ResourceURL>jsc://apply-response.js</ResourceURL>
</Javascript>""")
pol("AM-MM-Headers", """
<AssignMessage continueOnError="true" enabled="true" name="AM-MM-Headers">
    <DisplayName>Add Multimodal Armor Telemetry Headers</DisplayName>
    <!-- Names, verdicts and timings only: never prompt text, file bytes or OCR text.
         X-Armor-Verdict is the RESPONSE verdict (kept for the web UI BFF); X-Armor-Filters / X-Armor-Latency-Ms
         describe the PROMPT. X-Armor-Prompt-Verdict / X-Armor-Response-Verdict name each stage explicitly. -->
    <Set>
        <Headers>
            <Header name="X-Request-Id">{messageid}</Header>
            <Header name="X-Armor-Mode">{mm.mode}</Header>
            <Header name="X-Armor-Verdict">{mm.resp_verdict}</Header>
            <Header name="X-Armor-Prompt-Verdict">{mm.verdict}</Header>
            <Header name="X-Armor-Response-Verdict">{mm.resp_verdict}</Header>
            <Header name="X-Armor-Filters">{mm.matched}</Header>
            <Header name="X-Armor-Latency-Ms">{mm.latency_ms}</Header>
            <Header name="X-Armor-Response-Latency-Ms">{mm.resp_latency_ms}</Header>
            <Header name="X-Armor-Parts">{mm.parts_json}</Header>
            <Header name="X-Armor-Response">{mm.resp_json}</Header>
        </Headers>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>""")

# ---- errors ----
# Prompt verdict: blocked | incomplete | unsupported at the prompt stage, allowed once the answer is being screened.
# Response verdict: blocked | incomplete at the response stage, none if the request never reached Gemini.
ERR_HEADERS = """            <Header name="Content-Type">application/json</Header>
            <Header name="X-Request-Id">{messageid}</Header>
            <Header name="X-Armor-Mode">{mm.mode}</Header>
            <Header name="X-Armor-Stage">{mm.stage}</Header>
            <Header name="X-Armor-Prompt-Verdict">{mm.verdict}</Header>
            <Header name="X-Armor-Response-Verdict">{mm.resp_verdict}</Header>
            <Header name="X-Armor-Latency-Ms">{mm.latency_ms}</Header>"""
# A ServiceCallout / native policy that failed leaves its stage verdict at the AM-MM-Init default
# (pending / none). FaultRule "mm-unavailable" marks it incomplete before the error body is built.
for name, disp, var in [("AM-MM-Prompt-Incomplete", "Mark Prompt Verdict Incomplete", "mm.verdict"),
                        ("AM-MM-Response-Incomplete", "Mark Response Verdict Incomplete", "mm.resp_verdict")]:
    pol(name, f"""
<AssignMessage continueOnError="true" enabled="true" name="{name}">
    <DisplayName>{disp}</DisplayName>
    <AssignVariable>
        <Name>{var}</Name>
        <Value>incomplete</Value>
    </AssignVariable>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</AssignMessage>""")
pol("AM-Error-MM-Blocked", f"""
<AssignMessage continueOnError="true" enabled="true" name="AM-Error-MM-Blocked">
    <DisplayName>400 Blocked by Model Armor</DisplayName>
    <!-- Filter names per part only; never the prompt, file bytes, OCR text or the raw Model Armor result. -->
    <Set>
        <Headers>
{ERR_HEADERS}
            <Header name="X-Armor-Verdict">blocked</Header>
        </Headers>
        <Payload contentType="application/json" variablePrefix="@" variableSuffix="#">{{"error":{{"code":400,"status":"BLOCKED_BY_MODEL_ARMOR","stage":"@mm.stage#","message":"Blocked by Model Armor.","armor":{{"mode":"@mm.mode#","verdict":"blocked","matched":"@mm.matched#","parts":@mm.parts_json#,"response":@mm.resp_json#,"latencyMs":@mm.latency_ms#}},"requestId":"@messageid#"}}}}</Payload>
        <StatusCode>400</StatusCode>
        <ReasonPhrase>Bad Request</ReasonPhrase>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>""")
pol("AM-Error-MM-Unavailable", f"""
<AssignMessage continueOnError="true" enabled="true" name="AM-Error-MM-Unavailable">
    <DisplayName>503 Model Armor Could Not Finish (fail closed)</DisplayName>
    <Set>
        <Headers>
{ERR_HEADERS}
            <Header name="X-Armor-Verdict">incomplete</Header>
        </Headers>
        <Payload contentType="application/json" variablePrefix="@" variableSuffix="#">{{"error":{{"code":503,"status":"ARMOR_UNAVAILABLE","stage":"@mm.stage#","message":"Model Armor could not fully screen the input (for example a file over its size or embedded-image limits), so nothing was forwarded (fail closed).","armor":{{"mode":"@mm.mode#","verdict":"incomplete","parts":@mm.parts_json#,"response":@mm.resp_json#}},"requestId":"@messageid#"}}}}</Payload>
        <StatusCode>503</StatusCode>
        <ReasonPhrase>Service Unavailable</ReasonPhrase>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>""")
# ---- native mode (built-in policies, text only) ----
TEMPLATE = "projects/{propertyset.demo.armor_project}/locations/{propertyset.demo.armor_location}/templates/{propertyset.demo.armor_template_inspect}"
pol("SUP-MM-Native-Prompt", f"""
<SanitizeUserPrompt continueOnError="false" enabled="true" name="SUP-MM-Native-Prompt">
    <DisplayName>Model Armor: Sanitize User Prompt (native, text only)</DisplayName>
    <!-- Built-in policy: screens the text part. It has no input for images or documents. -->
    <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>
    <ModelArmor>
        <TemplateName>{TEMPLATE}</TemplateName>
    </ModelArmor>
    <UserPromptSource>{{private.mm.native_text}}</UserPromptSource>
</SanitizeUserPrompt>""")
pol("SMR-MM-Native-Response", f"""
<SanitizeModelResponse continueOnError="false" enabled="true" name="SMR-MM-Native-Response">
    <DisplayName>Model Armor: Sanitize Model Response (native, text only)</DisplayName>
    <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>
    <ModelArmor>
        <TemplateName>{TEMPLATE}</TemplateName>
    </ModelArmor>
    <UserPromptSource>{{private.mm.native_text}}</UserPromptSource>
    <LLMResponseSource>{{private.mm.resp_text}}</LLMResponseSource>
</SanitizeModelResponse>""")
pol("JS-Native-Evaluate", """
<Javascript continueOnError="false" enabled="true" timeLimit="1000" name="JS-Native-Evaluate">
    <DisplayName>Native Policy Results (same shape as the callout path)</DisplayName>
    <Properties>
        <Property name="requiredFilters">rai,sdp,pi_and_jailbreak,malicious_uris</Property>
    </Properties>
    <IncludeURL>jsc://armor-lib.js</IncludeURL>
    <ResourceURL>jsc://native-evaluate.js</ResourceURL>
</Javascript>""")
pol("RF-MM-Unsupported", """
<RaiseFault continueOnError="false" enabled="true" name="RF-MM-Unsupported">
    <DisplayName>Native Policy Cannot Screen This Input</DisplayName>
    <!-- Body is set by FaultRule "mm-native-unsupported" (AM-Error-MM-Unsupported). -->
    <FaultResponse>
        <Set>
            <StatusCode>400</StatusCode>
            <ReasonPhrase>Bad Request</ReasonPhrase>
        </Set>
    </FaultResponse>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>""")
pol("AM-Error-MM-Unsupported", f"""
<AssignMessage continueOnError="true" enabled="true" name="AM-Error-MM-Unsupported">
    <DisplayName>400 Not Screenable by the Native Policy (fail closed)</DisplayName>
    <Set>
        <Headers>
{ERR_HEADERS}
            <Header name="X-Armor-Verdict">unsupported</Header>
        </Headers>
        <Payload contentType="application/json" variablePrefix="@" variableSuffix="#">{{"error":{{"code":400,"status":"NOT_SCREENABLE_BY_NATIVE_POLICY","stage":"prompt","message":"@mm.unsupported_reason#","armor":{{"mode":"native","verdict":"unsupported","matched":"@mm.matched#","parts":@mm.parts_json#,"response":null,"latencyMs":@mm.latency_ms#}},"requestId":"@messageid#"}}}}</Payload>
        <StatusCode>400</StatusCode>
        <ReasonPhrase>Bad Request</ReasonPhrase>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>""")
pol("AM-Error-Unauthenticated", """
<AssignMessage continueOnError="true" enabled="true" name="AM-Error-Unauthenticated">
    <DisplayName>401 JSON Error</DisplayName>
    <Set>
        <Headers>
            <Header name="Content-Type">application/json</Header>
            <Header name="X-Request-Id">{messageid}</Header>
        </Headers>
        <Payload contentType="application/json" variablePrefix="@" variableSuffix="#">{"error":{"code":401,"status":"UNAUTHENTICATED","message":"A valid API key is required in the x-api-key header.","requestId":"@messageid#"}}</Payload>
        <StatusCode>401</StatusCode>
        <ReasonPhrase>Unauthorized</ReasonPhrase>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>""")
pol("AM-Error-Default", """
<AssignMessage continueOnError="true" enabled="true" name="AM-Error-Default">
    <DisplayName>Sanitized JSON Error</DisplayName>
    <!-- Keeps the fault's HTTP status; never echoes upstream bodies (may contain prompt text).
         "code" stays a quoted string on purpose: if error.status.code is unset, an unquoted
         value would render as "code":, (invalid JSON) because unresolved variables become empty. -->
    <Set>
        <Headers>
            <Header name="Content-Type">application/json</Header>
            <Header name="X-Request-Id">{messageid}</Header>
        </Headers>
        <Payload contentType="application/json" variablePrefix="@" variableSuffix="#">{"error":{"code":"@error.status.code#","status":"@fault.name#","message":"The gateway could not complete the request.","requestId":"@messageid#"}}</Payload>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>""")
pol("RF-Not-Found", """
<RaiseFault continueOnError="false" enabled="true" name="RF-Not-Found">
    <DisplayName>Unknown Resource</DisplayName>
    <FaultResponse>
        <Set>
            <Headers>
                <Header name="X-Request-Id">{messageid}</Header>
            </Headers>
            <Payload contentType="application/json" variablePrefix="@" variableSuffix="#">{"error":{"code":404,"status":"NOT_FOUND","message":"Use POST /model-armor-multimodal/generate or /generate-image.","requestId":"@messageid#"}}</Payload>
            <StatusCode>404</StatusCode>
            <ReasonPhrase>Not Found</ReasonPhrase>
        </Set>
    </FaultResponse>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>""")
pol("ML-Log-Audit", """
<MessageLogging continueOnError="true" enabled="true" name="ML-Log-Audit">
    <DisplayName>Log Audit Event to Cloud Logging</DisplayName>
    <!-- Same log as the 101 proxy, so the web UI audit drawer shows both. Names and verdicts only. -->
    <CloudLogging>
        <LogName>projects/{organization.name}/logs/apigee-model-armor-101-logs</LogName>
        <Message contentType="application/json">{"proxy":"{apiproxy.name}","app":"{escapeJSON(developer.app.name)}","scenarioId":"{escapeJSON(request.header.x-demo-scenario)}","httpStatus":"{response.status.code}","fault":"{escapeJSON(fault.name)}","armorMode":"mm-{mm.mode}","armorStage":"{mm.stage}","armorParts":"{mm.part_count}","armorVerdict":"{mm.verdict}","armorResponseVerdict":"{mm.resp_verdict}","armorImageAction":"{mm.image_action}","armorFilters":"{escapeJSON(mm.matched)}","armorResponseFilters":"{escapeJSON(mm.resp_matched)}","armorLatencyMs":"{mm.latency_ms}","requestId":"{messageid}"}</Message>
        <Labels>
            <Label>
                <Key>proxy</Key>
                <Value>{apiproxy.name}</Value>
            </Label>
            <Label>
                <Key>environment</Key>
                <Value>{environment.name}</Value>
            </Label>
        </Labels>
        <ResourceType>api</ResourceType>
    </CloudLogging>
</MessageLogging>""")

# ---- proxy endpoint ----
def step(name, cond=None, indent=16):
    pad = " " * indent
    c = f"\n{pad}    <Condition>{cond}</Condition>" if cond else ""
    return f"{pad}<Step>\n{pad}    <Name>{name}</Name>{c}\n{pad}</Step>"

CO = '(mm.mode = "callout")'
NA = '(mm.mode = "native")'
req_steps = [
    "<!-- 2. Defaults + start the Armor timer -->", step("AM-MM-Init"),
    "<!-- 3. Split the prompt: 1 text part + up to 3 files (image / PDF / Word / Excel / PowerPoint / TXT / CSV).\n"
    "                     Builds one Model Armor body per part; Gemini gets only what it can read.\n"
    "                     x-armor-mode: callout (default, REST API) | native (built-in policies, text only). -->",
    step("JS-Split-Parts"), step("RF-Bad-Request", 'mm.input_ok != "true"'),
    "<!-- 4a. MODE callout: one ServiceCallout per part (Model Armor screens one item per call; Apigee has no\n"
    "                     loops, so the callouts are fixed and conditioned). -->",
]
for n in range(1, MAX_PARTS + 1):
    req_steps += [step(f"SC-MM-Part-{n}", f"{CO} and (mm.part_count >= {n})"), step(f"AM-MM-Mark-{n}", f"{CO} and (mm.part_count >= {n})")]
req_steps += [
    step("JS-Evaluate-Parts", CO),
    "<!-- 4b. MODE native: Apigee's built-in SanitizeUserPrompt screens the TEXT part only. Attachments (or an image\n"
    "                     answer) cannot be screened natively, so the request is rejected before Gemini (fail closed).\n"
    "                     A match raises FilterMatched -> FaultRule \"mm-native-match\". -->",
    step("SUP-MM-Native-Prompt", NA), step("JS-Native-Evaluate", NA),
    step("RF-MM-Unsupported", f'{NA} and (mm.verdict = "unsupported")'),
    "<!-- 5. Blocked if ANY part matched; 503 if any part could not be fully screened -->",
    step("RF-MM-Blocked", 'mm.verdict = "blocked"'), step("RF-MM-Incomplete", 'mm.verdict != "allowed"'),
    "<!-- 6. Clean prompt: strip caller credentials, forward to Gemini -->", step("AM-Prepare-Gemini-Request"),
]
resp_steps = [
    "<!-- 7. Screen the answer: text and (image model) the generated image -->",
    step("AM-MM-Stage-Response"), step("JS-Split-Response"),
    step("SC-MM-Resp-Text", f'{CO} and (mm.resp_has_text = "true")'), step("SC-MM-Resp-Image", f'{CO} and (mm.resp_has_image = "true")'),
    "<!-- 8. Block, redact (swap in Model Armor's redactedImage) or pass; fail closed -->",
    step("JS-Apply-Response", CO),
    "<!-- 7-8 native: built-in SanitizeModelResponse on the answer text (image answers never reach this point) -->",
    step("SMR-MM-Native-Response", f'{NA} and (mm.resp_has_text = "true")'), step("JS-Native-Evaluate", NA),
    step("RF-MM-Blocked", 'mm.resp_verdict = "blocked"'),
    step("RF-MM-Incomplete", '(mm.resp_verdict != "allowed") and (mm.resp_verdict != "redacted")'),
    step("AM-MM-Headers"),
]
fix = lambda lst: "\n".join(x if x.startswith(" ") else " " * 16 + x for x in lst)
blocked_c = '((mm.stage = "prompt") and (mm.verdict = "blocked")) or ((mm.stage = "response") and (mm.resp_verdict = "blocked"))'
sc_fail = " or ".join([f"(servicecallout.SC-MM-Part-{n}.failed = true)" for n in range(1, MAX_PARTS + 1)] +
                      ["(servicecallout.SC-MM-Resp-Text.failed = true)", "(servicecallout.SC-MM-Resp-Image.failed = true)",
                       "(SanitizeUserPrompt.SUP-MM-Native-Prompt.failed = true)", "(SanitizeModelResponse.SMR-MM-Native-Response.failed = true)"])
unavail_c = (f'(fault.name != "FilterMatched") and !({blocked_c}) and !((mm.stage = "prompt") and (mm.verdict = "unsupported")) and '
             f'((mm.verdict = "incomplete") or (mm.resp_verdict = "incomplete") or {sc_fail})')
flow_body = lambda: f"""            <Request>
{fix(req_steps)}
            </Request>
            <Response>
{fix(resp_steps)}
            </Response>"""
files["proxies/default.xml"] = HDR + f"""<!--
  POST /model-armor-multimodal/generate        text + images + documents in, text out   (chat model)
  POST /model-armor-multimodal/generate-image  text (+ images) in, text + image out       (image model)
  Every part of the prompt and every part of the answer is screened by Model Armor through the REST API
  (callout mode, the default).
  Apigee's built-in SanitizeUserPrompt / SanitizeModelResponse policies scan text only, so images and documents
  use ServiceCallouts (userPromptData / modelResponseData byteItem).
-->
<ProxyEndpoint name="default">
    <PreFlow name="PreFlow">
        <Request>
            <!-- 1. Consumer identity -->
            <Step>
                <Name>VA-Verify-API-Key</Name>
            </Step>
        </Request>
        <Response/>
    </PreFlow>
    <Flows>
        <Flow name="generate">
            <Description>POST /generate: multimodal prompt (text + up to 3 files), every part screened, then Gemini</Description>
            <Condition>(proxy.pathsuffix MatchesPath "/generate") and (request.verb = "POST")</Condition>
{flow_body()}
        </Flow>
        <Flow name="generate-image">
            <Description>POST /generate-image: same prompt screening, Gemini image model, generated image screened (block or redact)</Description>
            <Condition>(proxy.pathsuffix MatchesPath "/generate-image") and (request.verb = "POST")</Condition>
{flow_body()}
        </Flow>
        <Flow name="not-found">
            <Request>
                <Step>
                    <Name>RF-Not-Found</Name>
                </Step>
            </Request>
            <Response/>
        </Flow>
    </Flows>
    <PostClientFlow name="PostClientFlow">
        <Response>
            <Step>
                <Name>ML-Log-Audit</Name>
            </Step>
        </Response>
    </PostClientFlow>
    <HTTPProxyConnection>
        <BasePath>/model-armor-multimodal</BasePath>
    </HTTPProxyConnection>
    <RouteRule name="default">
        <TargetEndpoint>default</TargetEndpoint>
    </RouteRule>
    <!-- Conditions are mutually exclusive, so evaluation order does not matter. -->
    <FaultRules>
        <FaultRule name="invalid-api-key">
            <Step>
                <Name>AM-Error-Unauthenticated</Name>
            </Step>
            <Condition>(fault.name = "FailedToResolveAPIKey") or (fault.name = "InvalidApiKey") or (fault.name = "InvalidApiKeyForGivenResource") or (fault.name = "ApiKeyNotApproved") or (fault.name = "DeveloperStatusNotActive") or (fault.name = "consumer_key_expired")</Condition>
        </FaultRule>
        <!-- A part of the prompt, or of the answer, matched a filter. -->
        <FaultRule name="mm-blocked">
            <Step>
                <Name>AM-Error-MM-Blocked</Name>
            </Step>
            <Condition>(fault.name != "FilterMatched") and ({blocked_c})</Condition>
        </FaultRule>
        <!-- Native mode: the built-in SanitizeUserPrompt / SanitizeModelResponse policy raised FilterMatched. -->
        <FaultRule name="mm-native-match">
            <Step>
                <Name>JS-Native-Evaluate</Name>
            </Step>
            <Step>
                <Name>AM-Error-MM-Blocked</Name>
            </Step>
            <Condition>fault.name = "FilterMatched"</Condition>
        </FaultRule>
        <!-- Native mode: attachments or an image answer, which the built-in (text-only) policies cannot screen. -->
        <FaultRule name="mm-native-unsupported">
            <Step>
                <Name>AM-Error-MM-Unsupported</Name>
            </Step>
            <Condition>(fault.name != "FilterMatched") and (mm.stage = "prompt") and (mm.verdict = "unsupported")</Condition>
        </FaultRule>
        <!-- Something could not be fully screened (file over limits, skipped filter, Model Armor error): never forward it. -->
        <FaultRule name="mm-unavailable">
            <!-- A failed callout leaves the stage verdict at its default: name it for X-Armor-*-Verdict. -->
            <Step>
                <Name>AM-MM-Prompt-Incomplete</Name>
                <Condition>(mm.stage = "prompt") and (mm.verdict = "pending")</Condition>
            </Step>
            <Step>
                <Name>AM-MM-Response-Incomplete</Name>
                <Condition>(mm.stage = "response") and (mm.resp_verdict = "none")</Condition>
            </Step>
            <Step>
                <Name>AM-Error-MM-Unavailable</Name>
            </Step>
            <Condition>{unavail_c}</Condition>
        </FaultRule>
    </FaultRules>
    <DefaultFaultRule name="default-fault-handler">
        <Step>
            <Condition>fault.name != "RaiseFault"</Condition>
            <Name>AM-Error-Default</Name>
        </Step>
        <AlwaysEnforce>false</AlwaysEnforce>
    </DefaultFaultRule>
</ProxyEndpoint>
"""

files["targets/default.xml"] = HDR + f"""<TargetEndpoint name="default">
    <PreFlow name="PreFlow">
        <Request>
            <!-- Chat or image model from the property set (mm.model, set by JS-Split-Parts) -->
            <Step>
                <Name>AM-Set-Target-URL</Name>
            </Step>
        </Request>
        <Response/>
    </PreFlow>
    <PostFlow name="PostFlow">
        <Request/>
        <Response/>
    </PostFlow>
    <Flows/>
    <HTTPTargetConnection>
        <!-- Token of the deploy-time service account (needs roles/aiplatform.user). -->
{AUTH}
        <Properties>
            <Property name="target.copy.pathsuffix">false</Property>
            <Property name="connect.timeout.millis">30000</Property>
            <!-- Image generation takes ~5-15 s. -->
            <Property name="io.timeout.millis">120000</Property>
        </Properties>
        <!-- Default; overridden at runtime by AM-Set-Target-URL -->
        <URL>https://aiplatform.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/global/publishers/google/models/gemini-2.5-flash-lite:generateContent</URL>
    </HTTPTargetConnection>
</TargetEndpoint>
"""

files["resources/properties/demo.properties"] = """# Proxy-scoped property set "demo" (read as propertyset.demo.<key>).
# deploy.sh rewrites vertex_project, armor_project and armor_location in a staged copy at deploy time.
vertex_host=aiplatform.googleapis.com
vertex_project=YOUR_PROJECT_ID
vertex_location=global
# Chat model (POST /generate) and image model (POST /generate-image)
model=gemini-2.5-flash-lite
image_model=gemini-2.5-flash-image
# Model Armor templates (scripts/setup-model-armor-multimodal.sh). Location must support images: us, eu or global.
armor_project=YOUR_PROJECT_ID
armor_location=us
armor_template_inspect=apigee-mm-inspect
armor_template_redact=apigee-mm-redact
"""

policies = sorted(os.path.splitext(os.path.basename(k))[0] for k in files if k.startswith("policies/"))
files["model-armor-multimodal-proxy.xml"] = HDR + f"""<APIProxy revision="1" name="model-armor-multimodal-proxy">
    <Basepaths>/model-armor-multimodal</Basepaths>
    <ConfigurationVersion majorVersion="4" minorVersion="0"/>
    <DisplayName>model-armor-multimodal-proxy</DisplayName>
    <Description>Model Armor multimodal: every prompt part (text, image, PDF, Word, Excel, PowerPoint) and every answer part (text, generated image) screened through the Model Armor REST API (callout mode, the default); response images blocked or redacted</Description>
    <Policies>
{chr(10).join(f"        <Policy>{p}</Policy>" for p in policies)}
    </Policies>
    <ProxyEndpoints>
        <ProxyEndpoint>default</ProxyEndpoint>
    </ProxyEndpoints>
    <Resources>
        <Resource>properties://demo.properties</Resource>
        <Resource>jsc://armor-lib.js</Resource>
        <Resource>jsc://split-parts.js</Resource>
        <Resource>jsc://evaluate-parts.js</Resource>
        <Resource>jsc://split-response.js</Resource>
        <Resource>jsc://apply-response.js</Resource>
        <Resource>jsc://native-evaluate.js</Resource>
    </Resources>
    <TargetEndpoints>
        <TargetEndpoint>default</TargetEndpoint>
    </TargetEndpoints>
</APIProxy>
"""

for rel, content in files.items():
    path = os.path.join(B, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
print(f"wrote {len(files)} files ({len(policies)} policies)")
