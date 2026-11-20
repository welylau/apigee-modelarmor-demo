// Offline tests for the proxy JavaScript (simulates Apigee's context/properties).
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const dir = process.argv[2] + '/apigee-model-armor-101-proxy/apiproxy/resources/jsc/';

function run(file, vars, props) {
  const store = Object.assign({}, vars);
  const context = { getVariable: (k) => (k in store ? store[k] : null), setVariable: (k, v) => { store[k] = v; } };
  vm.runInNewContext(fs.readFileSync(dir + file, 'utf8'), { context, properties: props || {}, JSON, Date, Math, Number, String, Object, isFinite, parseInt });
  return store;
}

const PROPS = { requiredFilters: 'rai,sdp,pi_and_jailbreak,malicious_uris', nativePolicy: 'SUP-Sanitize-Prompt', calloutResponse: 'armorResponse' };
const ok = (m = 'NO_MATCH_FOUND') => ({ executionState: 'EXECUTION_SUCCESS', matchState: m });
function maResp({ pi = 'NO_MATCH_FOUND', uri = 'NO_MATCH_FOUND', sdp = 'NO_MATCH_FOUND', harass = 'NO_MATCH_FOUND', skipSdp = false, inv = 'SUCCESS' } = {}) {
  const any = [pi, uri, sdp, harass].includes('MATCH_FOUND');
  return JSON.stringify({ sanitizationResult: {
    filterMatchState: any ? 'MATCH_FOUND' : 'NO_MATCH_FOUND', invocationResult: inv,
    filterResults: {
      csam: { csamFilterFilterResult: ok() },
      malicious_uris: { maliciousUriFilterResult: ok(uri) },
      rai: { raiFilterResult: Object.assign(ok(harass), { raiFilterTypeResults: {
        dangerous: { confidenceLevel: 'LOW', matchState: 'NO_MATCH_FOUND' }, harassment: { confidenceLevel: 'HIGH', matchState: harass } } }) },
      pi_and_jailbreak: { piAndJailbreakFilterResult: Object.assign(ok(pi), { confidenceLevel: 'HIGH' }) },
      sdp: { sdpFilterResult: { inspectResult: skipSdp ? { executionState: 'EXECUTION_SKIPPED', matchState: 'NO_MATCH_FOUND' } : ok(sdp) } },
    } } });
}
const start = String(Date.now() - 80);
const t = [];
function test(name, fn) { try { fn(); t.push(`PASS ${name}`); } catch (e) { t.push(`FAIL ${name}: ${e.message}`); process.exitCode = 1; } }

// ---------------- prepare-armor.js
const body = (o) => JSON.stringify(o);
test('prepare: valid single prompt, default native', () => {
  const s = run('prepare-armor.js', { 'request.content': body({ contents: [{ role: 'user', parts: [{ text: 'hi there' }] }] }) }, { maxPromptChars: '8000' });
  assert.equal(s['armor.mode'], 'native'); assert.equal(s['armor.input_ok'], 'true');
  assert.equal(s['private.armor.prompt'], 'hi there');
  assert.deepEqual(JSON.parse(s['private.armor.callout_body']), { userPromptData: { text: 'hi there' } });
});
test('prepare: callout header (case-insensitive)', () => {
  const s = run('prepare-armor.js', { 'request.header.x-armor-mode': ' CallOut ', 'request.content': body({ contents: [{ parts: [{ text: 'x' }] }] }) }, {});
  assert.equal(s['armor.mode'], 'callout');
});
test('prepare: unknown mode -> native', () => {
  const s = run('prepare-armor.js', { 'request.header.x-armor-mode': 'skip', 'request.content': body({ contents: [{ parts: [{ text: 'x' }] }] }) }, {});
  assert.equal(s['armor.mode'], 'native');
});
for (const [name, c] of [
  ['two contents (multi-turn)', body({ contents: [{ role: 'user', parts: [{ text: 'a' }] }, { role: 'user', parts: [{ text: 'b' }] }] })],
  ['two parts', body({ contents: [{ role: 'user', parts: [{ text: 'a' }, { text: 'b' }] }] })],
  ['model role', body({ contents: [{ role: 'model', parts: [{ text: 'a' }] }] })],
  ['empty text', body({ contents: [{ parts: [{ text: '   ' }] }] })],
  ['non-string text', body({ contents: [{ parts: [{ text: 42 }] }] })],
  ['not JSON', 'nope'],
  ['too long', body({ contents: [{ parts: [{ text: 'a'.repeat(8001) }] }] })],
]) test(`prepare: rejects ${name}`, () => assert.equal(run('prepare-armor.js', { 'request.content': c }, { maxPromptChars: '8000' })['armor.input_ok'], 'false'));

// ---------------- prepare-armor.js: file uploads (callout only)
const PDF_B64 = Buffer.from('%PDF-1.4 test').toString('base64');
const fileBody = (mimeType, data) => body({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data } }] }] });
const FPROPS = { maxPromptChars: '8000', maxFileBase64Chars: '1400000', fileInstruction: 'Summarise.' };
test('prepare: callout PDF -> byteItem + rewritten Gemini body', () => {
  const s = run('prepare-armor.js', { 'request.header.x-armor-mode': 'callout', 'request.content': fileBody('application/pdf', PDF_B64) }, FPROPS);
  assert.equal(s['armor.input_ok'], 'true'); assert.equal(s['armor.input'], 'file:PDF');
  assert.deepEqual(JSON.parse(s['private.armor.callout_body']), { userPromptData: { byteItem: { byteDataType: 'PDF', byteData: PDF_B64 } } });
  assert.deepEqual(JSON.parse(s['request.content']), { contents: [{ role: 'user', parts: [{ text: 'Summarise.' }, { inlineData: { mimeType: 'application/pdf', data: PDF_B64 } }] }] });
  assert.equal(s['private.armor.prompt'], undefined);
});
test('prepare: callout CSV -> CSV for Armor, text/plain for Gemini', () => {
  const d = Buffer.from('a,b\n1,2').toString('base64');
  const s = run('prepare-armor.js', { 'request.header.x-armor-mode': 'callout', 'request.content': fileBody('text/csv', d) }, FPROPS);
  assert.equal(JSON.parse(s['private.armor.callout_body']).userPromptData.byteItem.byteDataType, 'CSV');
  assert.equal(JSON.parse(s['request.content']).contents[0].parts[1].inlineData.mimeType, 'text/plain');
});
test('prepare: native + file -> rejected with reason, body untouched', () => {
  const c = fileBody('application/pdf', PDF_B64);
  const s = run('prepare-armor.js', { 'request.content': c }, FPROPS);
  assert.equal(s['armor.input_ok'], 'false'); assert.match(s['armor.reject_reason'], /native SanitizeUserPrompt/);
  assert.equal(s['request.content'], c); assert.equal(s['private.armor.callout_body'], undefined);
});
for (const [name, c, props] of [
  ['unsupported mime', fileBody('image/png', PDF_B64)],
  ['bad base64', fileBody('application/pdf', 'not base64!')],
  ['empty data', fileBody('application/pdf', '')],
  ['too large', fileBody('application/pdf', PDF_B64), Object.assign({}, FPROPS, { maxFileBase64Chars: '8' })],
  ['text + file parts', body({ contents: [{ parts: [{ text: 'hi' }, { inlineData: { mimeType: 'application/pdf', data: PDF_B64 } }] }] })],
  ['text and inlineData in one part', body({ contents: [{ parts: [{ text: 'hi', inlineData: { mimeType: 'application/pdf', data: PDF_B64 } }] }] })],
]) test(`prepare: callout rejects ${name}`, () => {
  const s = run('prepare-armor.js', { 'request.header.x-armor-mode': 'callout', 'request.content': c }, props || FPROPS);
  assert.equal(s['armor.input_ok'], 'false'); assert.ok(s['armor.reject_reason']);
});

// ---------------- evaluate-armor.js
test('evaluate: callout clean -> allowed', () => {
  const s = run('evaluate-armor.js', { 'armor.mode': 'callout', 'armor.start_ms': start, 'armorResponse.content': maResp() }, PROPS);
  assert.equal(s['armor.verdict'], 'allowed'); assert.equal(s['armor.matched'], 'none'); assert.equal(s['armor.filters_json'], '[]');
  assert.ok(Number(s['armor.latency_ms']) >= 80);
});
test('evaluate: callout prompt injection -> blocked', () => {
  const s = run('evaluate-armor.js', { 'armor.mode': 'callout', 'armorResponse.content': maResp({ pi: 'MATCH_FOUND' }) }, PROPS);
  assert.equal(s['armor.verdict'], 'blocked'); assert.equal(s['armor.matched'], 'pi_and_jailbreak');
});
test('evaluate: rai subtype reported', () => {
  const s = run('evaluate-armor.js', { 'armor.mode': 'callout', 'armorResponse.content': maResp({ harass: 'MATCH_FOUND' }) }, PROPS);
  assert.deepEqual(JSON.parse(s['armor.filters_json']), ['rai:harassment']);
});
test('evaluate: sdp nested inspectResult', () => {
  const s = run('evaluate-armor.js', { 'armor.mode': 'callout', 'armorResponse.content': maResp({ sdp: 'MATCH_FOUND' }) }, PROPS);
  assert.equal(s['armor.matched'], 'sdp');
});
test('evaluate: skipped required filter -> incomplete (fail closed)', () => {
  const s = run('evaluate-armor.js', { 'armor.mode': 'callout', 'armorResponse.content': maResp({ skipSdp: true }) }, PROPS);
  assert.equal(s['armor.verdict'], 'incomplete');
});
test('evaluate: PARTIAL invocation -> incomplete', () => {
  const s = run('evaluate-armor.js', { 'armor.mode': 'callout', 'armorResponse.content': maResp({ inv: 'PARTIAL' }) }, PROPS);
  assert.equal(s['armor.verdict'], 'incomplete');
});
test('evaluate: missing/garbage response -> incomplete', () => {
  assert.equal(run('evaluate-armor.js', { 'armor.mode': 'callout', 'armorResponse.content': '<html>' }, PROPS)['armor.verdict'], 'incomplete');
  assert.equal(run('evaluate-armor.js', { 'armor.mode': 'native' }, PROPS)['armor.verdict'], 'incomplete');
});
test('evaluate: empty requiredFilters never allows', () => {
  assert.equal(run('evaluate-armor.js', { 'armor.mode': 'callout', 'armorResponse.content': maResp() }, Object.assign({}, PROPS, { requiredFilters: '' }))['armor.verdict'], 'incomplete');
});
test('evaluate: native responseFromModelArmor (wrapped) clean -> allowed', () => {
  const s = run('evaluate-armor.js', { 'armor.mode': 'native', 'SanitizeUserPrompt.SUP-Sanitize-Prompt.responseFromModelArmor': maResp() }, PROPS);
  assert.equal(s['armor.verdict'], 'allowed');
});
test('evaluate: native unwrapped sanitizationResult -> blocked malicious_uris', () => {
  const inner = JSON.stringify(JSON.parse(maResp({ uri: 'MATCH_FOUND' })).sanitizationResult);
  const s = run('evaluate-armor.js', { 'armor.mode': 'native', 'SanitizeUserPrompt.SUP-Sanitize-Prompt.responseFromModelArmor': inner }, PROPS);
  assert.equal(s['armor.verdict'], 'blocked'); assert.equal(s['armor.matched'], 'malicious_uris');
});
test('evaluate: native fault FilterMatched + flattened vars only', () => {
  const p = 'SanitizeUserPrompt.SUP-Sanitize-Prompt.';
  const s = run('evaluate-armor.js', { 'armor.mode': 'native', 'fault.name': 'FilterMatched',
    [p + 'filterMatchState']: 'MATCH_FOUND', [p + 'piAndJailbreakFilterResult.matchState']: 'MATCH_FOUND',
    [p + 'piAndJailbreakFilterResult.executionState']: 'EXECUTION_SUCCESS' }, PROPS);
  assert.equal(s['armor.verdict'], 'blocked'); assert.equal(s['armor.matched'], 'pi_and_jailbreak');
});
test('evaluate: native FilterMatched with no detail still blocked', () => {
  const s = run('evaluate-armor.js', { 'armor.mode': 'native', 'fault.name': 'FilterMatched' }, PROPS);
  assert.equal(s['armor.verdict'], 'blocked'); assert.equal(s['armor.filters_json'], '[]');
});

console.log(t.join('\n'));
