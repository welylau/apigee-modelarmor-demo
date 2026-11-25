/**
 * JS-Apply-Response (includes armor-lib.js): decide what happens to Gemini's answer.
 *
 * Text  : any match -> blocked.
 * Image : mm.image_action = block  -> any match blocks the whole answer.
 *         mm.image_action = redact -> if ONLY Sensitive Data Protection matched, Model Armor returned
 *                                     redactedImage AND every required filter ran (img.complete), the image
 *                                     bytes are replaced (black boxes) and the answer goes through; any other
 *                                     match (injection, RAI, CSAM, URL) still blocks, and an SDP-only match
 *                                     with an incomplete result is 'incomplete' (503), never redacted.
 * Anything that could not be fully screened -> incomplete (503).
 *
 * Sets mm.resp_verdict (allowed | redacted | blocked | incomplete), mm.resp_json (names only),
 * mm.resp_matched, mm.resp_latency_ms, and rewrites response.content only when an image is redacted
 * or an unscreened part (thought, functionCall, fileData, ...) has to be removed.
 */
var required = armorRequired(properties.requiredFilters);
var action = String(context.getVariable('mm.image_action') || 'redact');
var shapeOk = String(context.getVariable('mm.resp_shape_ok')) === 'true';
var hasText = String(context.getVariable('mm.resp_has_text')) === 'true';
var hasImage = String(context.getVariable('mm.resp_has_image')) === 'true';

var txt = hasText ? armorSummary(context.getVariable('mmArmorRespText.content'), required) : null;
var img = hasImage ? armorSummary(context.getVariable('mmArmorRespImage.content'), required) : null;

var verdict = 'allowed';
var imageState = hasImage ? 'clean' : 'none';
if (!shapeOk) { verdict = 'incomplete'; }
if (txt && txt.verdict === 'incomplete') { verdict = 'incomplete'; }
if (img && img.verdict === 'incomplete') { verdict = 'incomplete'; }
if (txt && txt.verdict === 'blocked') { verdict = 'blocked'; }
if (img && img.verdict === 'blocked') {
  var onlySdp = img.filters.length > 0 && img.filters.every(function (f) { return f === 'sdp'; });
  if (action === 'redact' && onlySdp && img.redactedImage) {
    if (img.complete) {
      imageState = 'redacted';
    } else {
      // SDP matched but another required filter did not run (or the invocation was not SUCCESS):
      // redacting would let an unscreened image through, so fail closed (blocked still wins).
      imageState = 'incomplete';
      if (verdict !== 'blocked') { verdict = 'incomplete'; }
    }
  } else {
    imageState = 'blocked';
    verdict = 'blocked';
  }
}

if (verdict === 'allowed' && imageState === 'redacted') {
  try {
    var r = JSON.parse(String(context.getVariable('response.content')));
    var idx = parseInt(String(context.getVariable('mm.resp_image_index')), 10);
    var part = r.candidates[0].content.parts[idx];
    var b64 = img.redactedImage;
    part.inlineData.data = b64;
    part.inlineData.mimeType = b64.indexOf('/9j/') === 0 ? 'image/jpeg' : (b64.indexOf('iVBOR') === 0 ? 'image/png' : part.inlineData.mimeType);
    context.setVariable('response.content', JSON.stringify(r));
    verdict = 'redacted';
  } catch (e) {
    verdict = 'incomplete';   // could not swap the image: never return the original
  }
}

// Only screened parts may leave the proxy. JS-Split-Response already strips thought parts and
// anything that is neither text nor inlineData (functionCall, fileData, executableCode, ...);
// this repeats it so an answer with neither text nor image stays 'allowed' but carries nothing
// unscreened. Unreadable content while passing -> incomplete (fail closed).
if (verdict === 'allowed' || verdict === 'redacted') {
  try {
    var raw = context.getVariable('response.content');
    if (raw !== null && raw !== undefined && String(raw).length) {
      var rr = JSON.parse(String(raw));
      var cc = rr && rr.candidates && rr.candidates[0] && rr.candidates[0].content;
      if (cc && cc.parts) {
        var kept = cc.parts.filter(function (q) { return q && !q.thought && (typeof q.text === 'string' || q.inlineData); });
        if (kept.length !== cc.parts.length) {
          cc.parts = kept;
          context.setVariable('response.content', JSON.stringify(rr));
        }
      }
    }
  } catch (e2) {
    verdict = 'incomplete';
  }
}

var matched = [];
if (txt) { txt.filters.forEach(function (f) { matched.push('text:' + f); }); }
if (img) { img.filters.forEach(function (f) { matched.push('image:' + f); }); }
var rt0 = Number(context.getVariable('mm.rt0'));
context.setVariable('mm.resp_verdict', verdict);
context.setVariable('mm.resp_matched', matched.length ? matched.join(',') : 'none');
context.setVariable('mm.resp_latency_ms', String(isFinite(rt0) && rt0 > 0 ? Math.max(0, Date.now() - rt0) : 0));
context.setVariable('mm.resp_json', JSON.stringify({
  verdict: verdict,
  text: txt ? { verdict: txt.verdict, filters: txt.filters } : null,
  image: img ? { verdict: img.verdict, state: imageState, action: action, filters: img.filters, findings: img.findings } : null
}));
