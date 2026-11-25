/**
 * armor-lib.js (shared, loaded with <IncludeURL>): turn one Model Armor sanitize* response into a verdict.
 *
 * armorSummary(raw, required) -> {
 *   verdict:    'allowed' | 'blocked' | 'incomplete'
 *   filters:    matched filter names, e.g. ['pi_and_jailbreak', 'rai:dangerous', 'sdp']
 *   invocation: SUCCESS | PARTIAL | FAILURE | ''
 *   findings:   SDP infoTypes found (images: PHONE_NUMBER, ...), names only
 *   redactedImage: base64 of the redacted image, only when SDP matched (else null)
 *   complete:   true only if every filter in `required` reported EXECUTION_SUCCESS and invocationResult
 *               is SUCCESS (or not reported). Independent of verdict: a match is 'blocked' even when
 *               incomplete, but anything that would let content THROUGH (allow, redact) needs complete.
 * }
 *
 * Fail closed: 'allowed' needs filterMatchState NO_MATCH_FOUND and complete. A document over Model Armor's
 * limits (> 4 MB or > 5 embedded images) comes back as NO_MATCH_FOUND with every filter EXECUTION_SKIPPED
 * and invocationResult FAILURE: that is 'incomplete', never 'allowed'.
 * extractedImageText (OCR text) is never read or copied anywhere.
 */
function armorStr(v) { return (v === null || v === undefined) ? '' : String(v); }

function armorSummary(raw, required) {
  var out = { verdict: 'incomplete', filters: [], invocation: '', findings: [], redactedImage: null, complete: false };
  var sr = null;
  try {
    var parsed = JSON.parse(armorStr(raw));
    sr = (parsed && parsed.sanitizationResult) ? parsed.sanitizationResult : null;
  } catch (e) { sr = null; }
  if (!sr || typeof sr !== 'object') { return out; }

  var matchState = armorStr(sr.filterMatchState);
  out.invocation = armorStr(sr.invocationResult);
  var execOk = {};
  var sdpMatched = false;
  var sdpRedacted = null;
  var fr = sr.filterResults || {};
  Object.keys(fr).forEach(function (key) {
    var wrapper = fr[key];
    if (!wrapper || typeof wrapper !== 'object') { return; }
    var keys = Object.keys(wrapper);
    var inner = keys.length ? wrapper[keys[0]] : null;          // e.g. piAndJailbreakFilterResult
    if (!inner || typeof inner !== 'object') { return; }
    if (inner.inspectResult) { inner = inner.inspectResult; }    // SDP inspect
    else if (inner.redactResult) { inner = inner.redactResult; } // SDP de-identify (images)
    else if (inner.deidentifyResult) { inner = inner.deidentifyResult; }
    execOk[key] = armorStr(inner.executionState) === 'EXECUTION_SUCCESS';
    if (armorStr(inner.matchState) !== 'MATCH_FOUND') { return; }
    var subs = [];
    var types = inner.raiFilterTypeResults || {};
    Object.keys(types).forEach(function (t) {
      if (types[t] && armorStr(types[t].matchState) === 'MATCH_FOUND') { subs.push(key + ':' + t); }
    });
    out.filters = out.filters.concat(subs.length ? subs : [key]);
    if (key === 'sdp') {
      sdpMatched = true;
      (inner.findings || []).forEach(function (f) {
        var it = armorStr(f && (f.infoType && f.infoType.name ? f.infoType.name : f.infoType));
        if (it && out.findings.indexOf(it) < 0) { out.findings.push(it); }
      });
      if (typeof inner.redactedImage === 'string' && inner.redactedImage.length) { sdpRedacted = inner.redactedImage; }
    }
  });

  // complete: every required filter reported EXECUTION_SUCCESS and the invocation did not fail.
  // Computed independently of the verdict, so callers that would ACT on a match (redaction) can
  // check it; a match is still 'blocked' even when incomplete (blocking is always safe).
  var allRan = required.length > 0 && required.every(function (k) { return execOk[k] === true; });
  var invOk = out.invocation === '' || out.invocation === 'SUCCESS';
  out.complete = allRan && invOk;
  if (out.filters.length > 0 || matchState === 'MATCH_FOUND') {
    out.verdict = 'blocked';
  } else {
    out.verdict = (matchState === 'NO_MATCH_FOUND' && out.complete) ? 'allowed' : 'incomplete';
  }
  if (sdpMatched && sdpRedacted) { out.redactedImage = sdpRedacted; }
  return out;
}

function armorRequired(prop) {
  return armorStr(prop).split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
}
