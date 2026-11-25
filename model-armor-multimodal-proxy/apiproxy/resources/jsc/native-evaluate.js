/**
 * JS-Native-Evaluate (includes armor-lib.js): results of Apigee's built-in Model Armor policies, in the same shape as
 * the callout path, so the UI can show both modes side by side.
 *
 * The native SanitizeUserPrompt / SanitizeModelResponse policies screen TEXT ONLY. In native mode:
 *   prompt   : the text part is screened by SUP-MM-Native-Prompt; every attachment is "unsupported".
 *              Attachments, or an image answer that could not be screened, mean the request is rejected
 *              before Gemini (fail closed): mm.verdict = "unsupported".
 *   response : the answer text is screened by SMR-MM-Native-Response.
 * Runs in the normal flow (no match) and in the FaultRule for FilterMatched (match), for either stage.
 */
var required = armorRequired(properties.requiredFilters);
var stage = String(context.getVariable('mm.stage') || 'prompt');
var filterMatched = String(context.getVariable('fault.name') || '') === 'FilterMatched';
var t0 = Number(context.getVariable(stage === 'response' ? 'mm.rt0' : 'mm.t0'));
var ms = isFinite(t0) && t0 > 0 ? Math.max(0, Date.now() - t0) : null;

function nativeSummary(raw) {
  var s = armorSummary(raw, required);
  if (filterMatched && s.verdict !== 'blocked') { s.verdict = 'blocked'; }   // matched, details not readable
  return s;
}

if (stage === 'response') {
  var hasText = String(context.getVariable('mm.resp_has_text')) === 'true';
  var r = hasText ? nativeSummary(context.getVariable('SanitizeModelResponse.SMR-MM-Native-Response.responseFromModelArmor')) : null;
  var verdict = r ? r.verdict : 'allowed';
  context.setVariable('mm.resp_verdict', verdict);
  context.setVariable('mm.resp_matched', r && r.filters.length ? r.filters.map(function (f) { return 'text:' + f; }).join(',') : 'none');
  context.setVariable('mm.resp_latency_ms', String(ms || 0));
  context.setVariable('mm.resp_json', JSON.stringify({ verdict: verdict, text: r ? { verdict: r.verdict, filters: r.filters } : null, image: null }));
} else {
  var s = nativeSummary(context.getVariable('SanitizeUserPrompt.SUP-MM-Native-Prompt.responseFromModelArmor'));
  var meta = [];
  try { meta = JSON.parse(String(context.getVariable('mm.parts_meta') || '[]')); } catch (e) { meta = []; }
  var parts = [{ n: 1, kind: 'text', verdict: s.verdict, filters: s.filters, ms: ms, bytes: (meta[0] || {}).bytes || 0, forwarded: true }];
  for (var i = 1; i < meta.length; i++) {
    parts.push({ n: i + 1, kind: meta[i].kind, verdict: 'unsupported', filters: [], ms: null, bytes: meta[i].bytes || 0, forwarded: false });
  }
  var files = parts.length - 1;
  var isImage = String(context.getVariable('mm.flow')) === 'image';
  var v = s.verdict;
  var reason = '';
  if (v === 'allowed' && files > 0) {
    v = 'unsupported';
    reason = 'Apigee\'s native SanitizeUserPrompt policy screens text only: ' + files + ' attachment' + (files > 1 ? 's' : '') +
      ' could not be screened, so the request was rejected before Gemini (fail closed).';
  } else if (v === 'allowed' && isImage) {
    v = 'unsupported';
    reason = 'Apigee\'s native SanitizeModelResponse policy cannot screen a generated image, so the request was not sent to the image model (fail closed).';
  }
  context.setVariable('mm.verdict', v);
  context.setVariable('mm.unsupported_reason', reason);
  context.setVariable('mm.matched', s.filters.length ? s.filters.map(function (f) { return 'p1:' + f; }).join(',') : 'none');
  context.setVariable('mm.parts_json', JSON.stringify(parts));
  context.setVariable('mm.latency_ms', String(ms || 0));
}
