/**
 * JS-Evaluate-Armor: one verdict for both inspection modes.
 *
 * Input
 *   native : SanitizeUserPrompt.<nativePolicy>.responseFromModelArmor (+ flattened per-filter vars)
 *   callout: <calloutResponse>.content (REST sanitizeUserPrompt response)
 * Output (filter names only, never prompt text)
 *   armor.verdict      allowed | blocked | incomplete
 *   armor.matched      comma list of matched filters, or "none"
 *   armor.filters_json JSON array of matched filters (e.g. ["pi_and_jailbreak","rai:dangerous"])
 *   armor.invocation   SUCCESS | PARTIAL | FAILURE | unknown
 *   armor.latency_ms   time since AM-Armor-Init
 *
 * Fail closed: "allowed" needs filterMatchState NO_MATCH_FOUND, invocation SUCCESS (when reported)
 * and EXECUTION_SUCCESS for every filter in requiredFilters.
 */
function str(v) { return (v === null || v === undefined) ? '' : String(v); }

var mode = str(context.getVariable('armor.mode')) || 'native';
var nativePolicy = str(properties.nativePolicy) || 'SUP-Sanitize-Prompt';
var nativePrefix = 'SanitizeUserPrompt.' + nativePolicy + '.';
var required = str(properties.requiredFilters).split(',')
  .map(function (s) { return s.trim(); })
  .filter(function (s) { return s.length > 0; });

var raw = mode === 'callout'
  ? context.getVariable(str(properties.calloutResponse || 'armorResponse') + '.content')
  : context.getVariable(nativePrefix + 'responseFromModelArmor');

var sr = null;
try {
  var parsed = JSON.parse(str(raw));
  sr = (parsed && parsed.sanitizationResult) ? parsed.sanitizationResult : parsed;
} catch (e) {
  sr = null;
}

var matched = [];
var execOk = {};
var matchState = '';
var invocation = '';

function firstChild(obj) {
  if (!obj || typeof obj !== 'object') { return null; }
  var keys = Object.keys(obj);
  return keys.length ? obj[keys[0]] : null;
}

if (sr && typeof sr === 'object') {
  matchState = str(sr.filterMatchState);
  invocation = str(sr.invocationResult);
  var fr = sr.filterResults || {};
  Object.keys(fr).forEach(function (key) {
    var inner = firstChild(fr[key]);                  // e.g. piAndJailbreakFilterResult
    if (inner && inner.inspectResult) { inner = inner.inspectResult; }   // basic / advanced SDP
    if (!inner) { return; }
    execOk[key] = str(inner.executionState) === 'EXECUTION_SUCCESS';
    if (str(inner.matchState) === 'MATCH_FOUND') {
      var subs = [];
      var types = inner.raiFilterTypeResults || {};
      Object.keys(types).forEach(function (t) {
        if (types[t] && str(types[t].matchState) === 'MATCH_FOUND') { subs.push(key + ':' + t); }
      });
      if (subs.length) { matched = matched.concat(subs); } else { matched.push(key); }
    }
  });
} else if (mode === 'native') {
  // Fallback: flattened variables documented for the native policy.
  matchState = str(context.getVariable(nativePrefix + 'filterMatchState'));
  invocation = str(context.getVariable(nativePrefix + 'invocationResult'));
  var flat = {
    rai: 'raiFilterResult',
    sdp: 'sdpFilterResult.inspectResult',
    pi_and_jailbreak: 'piAndJailbreakFilterResult',
    malicious_uris: 'maliciousUriFilterResult',
    csam: 'csamFilterFilterResult'
  };
  Object.keys(flat).forEach(function (key) {
    var exec = str(context.getVariable(nativePrefix + flat[key] + '.executionState'));
    if (exec) { execOk[key] = exec === 'EXECUTION_SUCCESS'; }
    if (str(context.getVariable(nativePrefix + flat[key] + '.matchState')) === 'MATCH_FOUND') { matched.push(key); }
  });
}

var nativeFilterMatched = mode === 'native' && str(context.getVariable('fault.name')) === 'FilterMatched';
var verdict;
if (matched.length > 0 || matchState === 'MATCH_FOUND' || nativeFilterMatched) {
  verdict = 'blocked';
} else {
  var allRan = required.every(function (k) { return execOk[k] === true; });
  var invOk = invocation === '' || invocation === 'SUCCESS';
  verdict = (matchState === 'NO_MATCH_FOUND' && invOk && allRan && required.length > 0) ? 'allowed' : 'incomplete';
}

var start = Number(context.getVariable('armor.start_ms'));
var latency = isFinite(start) && start > 0 ? Math.max(0, Date.now() - start) : 0;

context.setVariable('armor.verdict', verdict);
context.setVariable('armor.matched', matched.length ? matched.join(',') : 'none');
context.setVariable('armor.filters_json', JSON.stringify(matched));
context.setVariable('armor.invocation', invocation || 'unknown');
context.setVariable('armor.match_state', matchState || 'unknown');
context.setVariable('armor.latency_ms', String(latency));
