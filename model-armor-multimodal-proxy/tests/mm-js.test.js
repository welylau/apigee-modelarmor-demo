// Offline tests for the multimodal proxy JavaScript (simulates Apigee's context/properties).
// Usage: node model-armor-multimodal-proxy/tests/mm-js.test.js
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const dir = __dirname + '/../apiproxy/resources/jsc/';
const LIB = fs.readFileSync(dir + 'armor-lib.js', 'utf8');

function run(file, vars, props, withLib) {
  const store = Object.assign({}, vars);
  const context = { getVariable: (k) => (k in store ? store[k] : null), setVariable: (k, v) => { store[k] = v; } };
  const src = (withLib ? LIB + '\n' : '') + fs.readFileSync(dir + file, 'utf8');
  vm.runInNewContext(src, { context, properties: props || {}, JSON, Date, Math, Number, String, Object, isFinite, parseInt });
  return store;
}
const t = [];
function test(name, fn) { try { fn(); t.push(`PASS ${name}`); } catch (e) { t.push(`FAIL ${name}: ${e.message}`); process.exitCode = 1; } }

const PNG = Buffer.from('\x89PNG fake image bytes').toString('base64');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const body = (parts, extra) => JSON.stringify(Object.assign({ contents: [{ role: 'user', parts }] }, extra || {}));
const PS = { 'propertyset.demo.model': 'gemini-2.5-flash-lite', 'propertyset.demo.image_model': 'gemini-2.5-flash-image',
             'propertyset.demo.armor_template_inspect': 'apigee-mm-inspect', 'propertyset.demo.armor_template_redact': 'apigee-mm-redact' };
const split = (content, extra, props) => run('split-parts.js', Object.assign({ 'proxy.pathsuffix': '/generate', 'request.content': content }, PS, extra || {}), props || {});

// ---------------- split-parts.js
test('split: text only -> 1 part, chat model', () => {
  const s = split(body([{ text: 'hello' }]));
  assert.equal(s['mm.input_ok'], 'true'); assert.equal(s['mm.part_count'], 1); assert.equal(s['mm.part1.kind'], 'text');
  assert.deepEqual(JSON.parse(s['private.mm.part1.body']), { userPromptData: { text: 'hello' } });
  assert.equal(s['mm.model'], 'gemini-2.5-flash-lite'); assert.equal(s['mm.flow'], 'chat');
});
test('split: text + image + docx -> 3 parts, byteItem types, Office file replaced by a note for Gemini', () => {
  const s = split(body([{ inlineData: { mimeType: 'image/png', data: PNG } }, { text: 'describe' }, { inlineData: { mimeType: DOCX_MIME, data: PNG } }]));
  assert.equal(s['mm.part_count'], 3);
  assert.deepEqual([s['mm.part1.kind'], s['mm.part2.kind'], s['mm.part3.kind']], ['text', 'IMAGE', 'WORD_DOCUMENT']);
  assert.deepEqual(JSON.parse(s['private.mm.part2.body']), { userPromptData: { byteItem: { byteDataType: 'IMAGE', byteData: PNG } } });
  const g = JSON.parse(s['request.content']).contents[0].parts;
  assert.equal(g[0].text, 'describe'); assert.equal(g[1].inlineData.mimeType, 'image/png');
  assert.ok(/Word document passed Model Armor screening/.test(g[2].text));
  const meta = JSON.parse(s['mm.parts_meta']);
  assert.deepEqual(meta.map((m) => m.forwarded), [true, true, false]);
});
test('split: /generate-image -> image model + responseModalities', () => {
  const s = split(body([{ text: 'draw a sign' }]), { 'proxy.pathsuffix': '/generate-image' });
  assert.equal(s['mm.model'], 'gemini-2.5-flash-image');
  assert.deepEqual(JSON.parse(s['request.content']).generationConfig, { responseModalities: ['TEXT', 'IMAGE'] });
});
test('split: image action header block -> inspect template; default redact -> redact template', () => {
  assert.equal(split(body([{ text: 'x' }]), { 'request.header.x-armor-image-action': ' Block ' })['mm.resp_image_template'], 'apigee-mm-inspect');
  const d = split(body([{ text: 'x' }]), {}, { responseImageAction: 'redact' });
  assert.equal(d['mm.image_action'], 'redact'); assert.equal(d['mm.resp_image_template'], 'apigee-mm-redact');
  assert.equal(split(body([{ text: 'x' }]), { 'request.header.x-armor-image-action': 'skip' }, { responseImageAction: 'block' })['mm.image_action'], 'block');
});
const file = (mime, data) => ({ inlineData: { mimeType: mime, data: data || PNG } });
for (const [name, c, props] of [
  ['no text part', body([file('image/png')])],
  ['two text parts', body([{ text: 'a' }, { text: 'b' }])],
  ['four files', body([{ text: 'a' }, file('image/png'), file('image/png'), file('image/png'), file('image/png')])],
  ['unsupported type (webp)', body([{ text: 'a' }, file('image/webp')])],
  ['bad base64', body([{ text: 'a' }, file('image/png', 'abc')])],
  ['part over 4 MB', body([{ text: 'a' }, file('image/png', 'AAAA'.repeat(10))]), { maxPartBase64Chars: '20' }],
  ['two contents', JSON.stringify({ contents: [{ parts: [{ text: 'a' }] }, { parts: [{ text: 'b' }] }] })],
  ['model role', JSON.stringify({ contents: [{ role: 'model', parts: [{ text: 'a' }] }] })],
  ['not JSON', 'nope'],
]) test(`split: rejects ${name}`, () => {
  const s = split(c, {}, props);
  assert.equal(s['mm.input_ok'], 'false'); assert.equal(s['mm.part_count'], 0); assert.ok(s['mm.reject_reason']);
});

// ---------------- armor-lib + evaluate-parts.js (shapes taken from live Model Armor responses)
const REQ = { requiredFilters: 'rai,sdp,pi_and_jailbreak,malicious_uris' };
const ex = (m = 'NO_MATCH_FOUND', e = 'EXECUTION_SUCCESS') => ({ executionState: e, matchState: m });
function ma({ pi, sdp, rai, inv = 'SUCCESS', skipAll = false, redacted } = {}) {
  const st = (m) => (skipAll ? ex('NO_MATCH_FOUND', 'EXECUTION_SKIPPED') : ex(m || 'NO_MATCH_FOUND'));
  const sdpInner = redacted !== undefined
    ? { redactResult: Object.assign(st(sdp), { redactedImage: redacted, extractedImageText: 'SECRET OCR', findings: sdp === 'MATCH_FOUND' ? [{ infoType: 'PHONE_NUMBER' }, { infoType: 'EMAIL_ADDRESS' }] : [] }) }
    : { inspectResult: st(sdp) };
  const any = [pi, sdp, rai].includes('MATCH_FOUND');
  return JSON.stringify({ sanitizationResult: { filterMatchState: any ? 'MATCH_FOUND' : 'NO_MATCH_FOUND', invocationResult: inv, filterResults: {
    csam: { csamFilterFilterResult: st() }, malicious_uris: { maliciousUriFilterResult: st() },
    rai: { raiFilterResult: Object.assign(st(rai), { raiFilterTypeResults: { dangerous: { matchState: rai || 'NO_MATCH_FOUND' } } }) },
    pi_and_jailbreak: { piAndJailbreakFilterResult: st(pi) }, sdp: { sdpFilterResult: sdpInner } } } });
}
const evalParts = (resps) => {
  const vars = { 'mm.part_count': resps.length, 'mm.t0': '1000', 'mm.parts_meta': JSON.stringify(resps.map((_, i) => ({ n: i + 1, kind: i ? 'IMAGE' : 'text', bytes: 10, forwarded: true }))) };
  resps.forEach((r, i) => { vars[`mmArmorResp${i + 1}.content`] = r; vars[`mm.t${i + 1}`] = String(1000 + (i + 1) * 500); vars[`mm.part${i + 1}.kind`] = i ? 'IMAGE' : 'text'; });
  return run('evaluate-parts.js', vars, REQ, true);
};
test('evaluate: every part clean -> allowed, per-part ms', () => {
  const s = evalParts([ma(), ma()]);
  assert.equal(s['mm.verdict'], 'allowed'); assert.equal(s['mm.matched'], 'none');
  assert.deepEqual(JSON.parse(s['mm.parts_json']).map((p) => p.ms), [500, 500]); assert.equal(s['mm.latency_ms'], '1000');
});
test('evaluate: injection only in part 2 (image OCR) -> blocked p2', () => {
  const s = evalParts([ma(), ma({ pi: 'MATCH_FOUND' })]);
  assert.equal(s['mm.verdict'], 'blocked'); assert.equal(s['mm.matched'], 'p2:pi_and_jailbreak');
  assert.deepEqual(JSON.parse(s['mm.parts_json']).map((p) => p.verdict), ['allowed', 'blocked']);
});
test('evaluate: document over limits (FAILURE, all skipped, NO_MATCH) -> incomplete, never allowed', () => {
  const s = evalParts([ma(), ma({ inv: 'FAILURE', skipAll: true })]);
  assert.equal(s['mm.verdict'], 'incomplete');
});
test('evaluate: blocked beats incomplete', () => {
  assert.equal(evalParts([ma({ sdp: 'MATCH_FOUND' }), ma({ inv: 'FAILURE', skipAll: true })])['mm.verdict'], 'blocked');
});
test('evaluate: missing / unparseable response -> incomplete', () => {
  assert.equal(evalParts([ma(), 'not json'])['mm.verdict'], 'incomplete');
});
test('evaluate: rai sub-type reported', () => {
  assert.equal(evalParts([ma({ rai: 'MATCH_FOUND' })])['mm.matched'], 'p1:rai:dangerous');
});

// ---------------- split-response.js
const gem = (parts) => JSON.stringify({ candidates: [{ content: { role: 'model', parts } }], usageMetadata: { totalTokenCount: 9 } });
test('split-response: text + png -> two bodies', () => {
  const s = run('split-response.js', { 'response.content': gem([{ text: 'Here you go' }, { inlineData: { mimeType: 'image/png', data: PNG } }]) });
  assert.equal(s['mm.resp_has_text'], 'true'); assert.equal(s['mm.resp_has_image'], 'true'); assert.equal(s['mm.resp_shape_ok'], 'true');
  assert.equal(s['mm.resp_image_index'], '1');
  assert.deepEqual(JSON.parse(s['private.mm.resp_image_body']), { modelResponseData: { byteItem: { byteDataType: 'IMAGE', byteData: PNG } } });
});
test('split-response: two images or webp -> shape not ok (fail closed)', () => {
  assert.equal(run('split-response.js', { 'response.content': gem([{ inlineData: { mimeType: 'image/png', data: PNG } }, { inlineData: { mimeType: 'image/png', data: PNG } }]) })['mm.resp_shape_ok'], 'false');
  assert.equal(run('split-response.js', { 'response.content': gem([{ inlineData: { mimeType: 'image/webp', data: PNG } }]) })['mm.resp_shape_ok'], 'false');
  assert.equal(run('split-response.js', { 'response.content': 'nope' })['mm.resp_shape_ok'], 'false');
});
test('split-response: thought parts stripped from response.content, never screened', () => {
  const s = run('split-response.js', { 'response.content': gem([{ text: 'secret reasoning 4111 1111', thought: true }, { text: 'Final answer' }, { inlineData: { mimeType: 'image/png', data: PNG } }]) });
  const parts = JSON.parse(s['response.content']).candidates[0].content.parts;
  assert.equal(parts.length, 2); assert.equal(parts[0].text, 'Final answer');
  assert.ok(!s['response.content'].includes('secret reasoning'));
  assert.deepEqual(JSON.parse(s['private.mm.resp_text_body']), { modelResponseData: { text: 'Final answer' } });
  assert.equal(s['mm.resp_image_index'], '1');   // index into the stripped parts
  assert.equal(JSON.parse(s['response.content']).usageMetadata.totalTokenCount, 9);
});
test('split-response: functionCall / fileData / executableCode stripped; clean answer content untouched', () => {
  const s = run('split-response.js', { 'response.content': gem([{ functionCall: { name: 'f', args: {} } }, { text: 'ok' }, { fileData: { fileUri: 'gs://x/y' } }, { executableCode: { code: 'print(1)' } }]) });
  assert.deepEqual(JSON.parse(s['response.content']).candidates[0].content.parts, [{ text: 'ok' }]);
  assert.equal(s['mm.resp_has_text'], 'true'); assert.equal(s['mm.resp_shape_ok'], 'true');
  const orig = gem([{ text: 'plain' }]);
  assert.equal(run('split-response.js', { 'response.content': orig })['response.content'], orig);   // not re-serialised
});
test('split-response: inlineData without bytes -> shape not ok', () => {
  assert.equal(run('split-response.js', { 'response.content': gem([{ text: 'x' }, { inlineData: { mimeType: 'image/png' } }]) })['mm.resp_shape_ok'], 'false');
});

// ---------------- apply-response.js
const REDACTED = 'iVBORredactedPNG';
const apply = (vars) => run('apply-response.js', Object.assign({ 'mm.resp_shape_ok': 'true', 'mm.rt0': String(Date.now() - 50) }, vars), REQ, true);
const withImage = (action, imgResp, extra) => Object.assign({ 'mm.image_action': action, 'mm.resp_has_image': 'true', 'mm.resp_has_text': 'false',
  'mm.resp_image_index': '1', 'mmArmorRespImage.content': imgResp,
  'response.content': gem([{ text: 'sign' }, { inlineData: { mimeType: 'image/png', data: PNG } }]) }, extra || {});
test('apply: redact + SDP only -> image swapped, findings listed, OCR text never copied', () => {
  const s = apply(withImage('redact', ma({ sdp: 'MATCH_FOUND', redacted: REDACTED })));
  assert.equal(s['mm.resp_verdict'], 'redacted');
  const part = JSON.parse(s['response.content']).candidates[0].content.parts[1];
  assert.equal(part.inlineData.data, REDACTED); assert.equal(part.inlineData.mimeType, 'image/png');
  const rj = JSON.parse(s['mm.resp_json']);
  assert.deepEqual(rj.image.findings, ['PHONE_NUMBER', 'EMAIL_ADDRESS']); assert.equal(rj.image.state, 'redacted');
  assert.ok(!(s['response.content'] + s['mm.resp_json'] + s['mm.resp_matched']).includes('SECRET OCR'));
});
test('apply: redact but injection in the image -> blocked (cannot redact non-SDP findings)', () => {
  assert.equal(apply(withImage('redact', ma({ pi: 'MATCH_FOUND', redacted: REDACTED })))['mm.resp_verdict'], 'blocked');
});
test('apply: block action + SDP -> blocked, content untouched', () => {
  const v = withImage('block', ma({ sdp: 'MATCH_FOUND' }));
  const s = apply(v);
  assert.equal(s['mm.resp_verdict'], 'blocked'); assert.equal(s['response.content'], v['response.content']);
});
test('apply: clean image with redact template -> allowed, original kept', () => {
  const v = withImage('redact', ma({ redacted: REDACTED }));
  const s = apply(v);
  assert.equal(s['mm.resp_verdict'], 'allowed'); assert.equal(s['response.content'], v['response.content']);
});
test('apply: text answer leaks a card -> blocked', () => {
  const s = apply({ 'mm.resp_has_text': 'true', 'mm.resp_has_image': 'false', 'mmArmorRespText.content': ma({ sdp: 'MATCH_FOUND' }) });
  assert.equal(s['mm.resp_verdict'], 'blocked'); assert.equal(s['mm.resp_matched'], 'text:sdp');
});
test('apply: image screening incomplete -> incomplete', () => {
  assert.equal(apply(withImage('redact', ma({ inv: 'FAILURE', skipAll: true, redacted: REDACTED })))['mm.resp_verdict'], 'incomplete');
});
test('apply: unscreenable answer shape -> incomplete', () => {
  assert.equal(apply({ 'mm.resp_shape_ok': 'false', 'mm.resp_has_text': 'false', 'mm.resp_has_image': 'false' })['mm.resp_verdict'], 'incomplete');
});
test('apply: no text, no image -> allowed, but functionCall / fileData / executableCode / thought removed', () => {
  const s = apply({ 'mm.resp_has_text': 'false', 'mm.resp_has_image': 'false',
    'response.content': gem([{ functionCall: { name: 'f', args: {} } }, { fileData: { fileUri: 'gs://x' } }, { executableCode: { code: 'x' } }, { text: 'hm', thought: true }]) });
  assert.equal(s['mm.resp_verdict'], 'allowed');
  assert.deepEqual(JSON.parse(s['response.content']).candidates[0].content.parts, []);
});
test('apply: redacted answer also drops an unscreened part, swap still lands on the image', () => {
  const v = withImage('redact', ma({ sdp: 'MATCH_FOUND', redacted: REDACTED }),
    { 'response.content': gem([{ text: 'sign' }, { inlineData: { mimeType: 'image/png', data: PNG } }, { functionCall: { name: 'f' } }]) });
  const s = apply(v);
  assert.equal(s['mm.resp_verdict'], 'redacted');
  const parts = JSON.parse(s['response.content']).candidates[0].content.parts;
  assert.equal(parts.length, 2); assert.equal(parts[1].inlineData.data, REDACTED);
});
test('apply: blocked answer content left for RF-MM-Blocked (not rewritten)', () => {
  const v = withImage('block', ma({ sdp: 'MATCH_FOUND' }), { 'response.content': gem([{ functionCall: { name: 'f' } }]) });
  assert.equal(apply(v)['response.content'], v['response.content']);
});
// Mark one filter EXECUTION_SKIPPED in a ma() response (e.g. rai did not run on the image).
const skipFilter = (resp, key) => {
  const o = JSON.parse(resp); const w = o.sanitizationResult.filterResults[key]; const inner = w[Object.keys(w)[0]];
  inner.executionState = 'EXECUTION_SKIPPED'; return JSON.stringify(o);
};
test('lib: complete flag (full success true; skipped rai or PARTIAL false)', () => {
  const lib = (r) => { const s = {}; vm.runInNewContext(LIB + '\nout = armorSummary(raw, req);', Object.assign(s, { raw: r, req: ['rai', 'sdp', 'pi_and_jailbreak', 'malicious_uris'], JSON, String, Object })); return s.out; };
  assert.equal(lib(ma({ sdp: 'MATCH_FOUND' })).complete, true);
  assert.equal(lib(skipFilter(ma({ sdp: 'MATCH_FOUND' }), 'rai')).complete, false);
  assert.equal(lib(ma({ inv: 'PARTIAL' })).complete, false);
  assert.equal(lib('garbage').complete, false);
});
test('apply: redact + SDP match + rai EXECUTION_SKIPPED -> incomplete, NOT redacted, original never returned modified', () => {
  const v = withImage('redact', skipFilter(ma({ sdp: 'MATCH_FOUND', redacted: REDACTED }), 'rai'));
  const s = apply(v);
  assert.equal(s['mm.resp_verdict'], 'incomplete');
  assert.equal(s['response.content'], v['response.content']);   // no swap; RF-MM-Incomplete replaces the body with a 503
  assert.equal(JSON.parse(s['mm.resp_json']).image.state, 'incomplete');
});
test('apply: redact + SDP match + invocation PARTIAL -> incomplete, not redacted', () => {
  assert.equal(apply(withImage('redact', ma({ sdp: 'MATCH_FOUND', redacted: REDACTED, inv: 'PARTIAL' })))['mm.resp_verdict'], 'incomplete');
});
test('apply: redact + full success + SDP only -> redacted', () => {
  const s = apply(withImage('redact', ma({ sdp: 'MATCH_FOUND', redacted: REDACTED })));
  assert.equal(s['mm.resp_verdict'], 'redacted');
  assert.equal(JSON.parse(s['response.content']).candidates[0].content.parts[1].inlineData.data, REDACTED);
});
test('apply: incomplete SDP-only image + text match -> blocked wins', () => {
  const s = apply(Object.assign(withImage('redact', skipFilter(ma({ sdp: 'MATCH_FOUND', redacted: REDACTED }), 'rai')),
    { 'mm.resp_has_text': 'true', 'mmArmorRespText.content': ma({ pi: 'MATCH_FOUND' }) }));
  assert.equal(s['mm.resp_verdict'], 'blocked');
});
test('evaluate: prompt part match with a skipped filter -> still blocked (blocking is safe)', () => {
  const s = evalParts([ma(), skipFilter(ma({ sdp: 'MATCH_FOUND' }), 'rai')]);
  assert.equal(s['mm.verdict'], 'blocked'); assert.equal(s['mm.matched'], 'p2:sdp');
});

// ---------------- native mode (built-in policies, text only)
test('split: x-armor-mode native -> mm.mode native, Gemini gets text only, native text set', () => {
  const s = split(body([{ text: 'describe' }, file('image/png')]), { 'request.header.x-armor-mode': ' Native ' });
  assert.equal(s['mm.mode'], 'native'); assert.equal(s['private.mm.native_text'], 'describe');
  assert.deepEqual(JSON.parse(s['request.content']).contents[0].parts, [{ text: 'describe' }]);
  assert.equal(split(body([{ text: 'x' }]))['mm.mode'], 'callout');
});
const nat = (vars) => run('native-evaluate.js', Object.assign({ 'mm.stage': 'prompt', 'mm.t0': String(Date.now() - 40), 'mm.flow': 'chat' }, vars), REQ, true);
const META3 = JSON.stringify([{ n: 1, kind: 'text', bytes: 5 }, { n: 2, kind: 'IMAGE', bytes: 9 }, { n: 3, kind: 'WORD_DOCUMENT', bytes: 9 }]);
test('native: clean text, no attachments -> allowed', () => {
  const s = nat({ 'mm.parts_meta': JSON.stringify([{ n: 1, kind: 'text', bytes: 5 }]), 'SanitizeUserPrompt.SUP-MM-Native-Prompt.responseFromModelArmor': ma() });
  assert.equal(s['mm.verdict'], 'allowed');
});
test('native: clean text + attachments -> unsupported (fail closed), attachments marked unsupported', () => {
  const s = nat({ 'mm.parts_meta': META3, 'SanitizeUserPrompt.SUP-MM-Native-Prompt.responseFromModelArmor': ma() });
  assert.equal(s['mm.verdict'], 'unsupported'); assert.ok(/2 attachments could not be screened/.test(s['mm.unsupported_reason']));
  assert.deepEqual(JSON.parse(s['mm.parts_json']).map((p) => p.verdict), ['allowed', 'unsupported', 'unsupported']);
});
test('native: image answer requested -> unsupported before Gemini', () => {
  const s = nat({ 'mm.flow': 'image', 'mm.parts_meta': JSON.stringify([{ n: 1, kind: 'text', bytes: 5 }]), 'SanitizeUserPrompt.SUP-MM-Native-Prompt.responseFromModelArmor': ma() });
  assert.equal(s['mm.verdict'], 'unsupported'); assert.ok(/generated image/.test(s['mm.unsupported_reason']));
});
test('native: FilterMatched on the text (FaultRule) -> blocked with filters', () => {
  const s = nat({ 'fault.name': 'FilterMatched', 'mm.parts_meta': META3, 'SanitizeUserPrompt.SUP-MM-Native-Prompt.responseFromModelArmor': ma({ pi: 'MATCH_FOUND' }) });
  assert.equal(s['mm.verdict'], 'blocked'); assert.equal(s['mm.matched'], 'p1:pi_and_jailbreak');
});
test('native: FilterMatched but result unreadable -> still blocked', () => {
  assert.equal(nat({ 'fault.name': 'FilterMatched', 'mm.parts_meta': META3 })['mm.verdict'], 'blocked');
});
test('native: response text match -> resp blocked; clean -> allowed', () => {
  const b = nat({ 'mm.stage': 'response', 'mm.rt0': String(Date.now() - 20), 'mm.resp_has_text': 'true', 'fault.name': 'FilterMatched',
    'SanitizeModelResponse.SMR-MM-Native-Response.responseFromModelArmor': ma({ sdp: 'MATCH_FOUND' }) });
  assert.equal(b['mm.resp_verdict'], 'blocked'); assert.equal(b['mm.resp_matched'], 'text:sdp');
  const a = nat({ 'mm.stage': 'response', 'mm.rt0': String(Date.now() - 20), 'mm.resp_has_text': 'true',
    'SanitizeModelResponse.SMR-MM-Native-Response.responseFromModelArmor': ma() });
  assert.equal(a['mm.resp_verdict'], 'allowed'); assert.equal(JSON.parse(a['mm.resp_json']).text.verdict, 'allowed');
});

console.log(t.join('\n'));
console.log(t.every((x) => x.startsWith('PASS')) ? `All ${t.length} tests passed` : 'SOME TESTS FAILED');
