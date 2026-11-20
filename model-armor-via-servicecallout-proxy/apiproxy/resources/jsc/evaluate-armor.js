/**
 * JS-Evaluate-Armor: read the ServiceCallout response (armorResponse.content) and decide.
 *   armor.verdict      allowed | blocked | incomplete
 *   armor.filters_json JSON array of matched filters, e.g. ["pi_and_jailbreak","rai:harassment"]
 * Fail closed: "allowed" needs filterMatchState NO_MATCH_FOUND, invocationResult SUCCESS (when
 * reported) and EXECUTION_SUCCESS for every filter listed in the requiredFilters property.
 */
function str(v) { return (v === null || v === undefined) ? '' : String(v); }

var required = str(properties.requiredFilters).split(',')
  .map(function (s) { return s.trim(); })
  .filter(function (s) { return s.length > 0; });

var sr = null;
try {
  var parsed = JSON.parse(str(context.getVariable('armorResponse.content')));
  sr = parsed && parsed.sanitizationResult ? parsed.sanitizationResult : null;
} catch (e) {
  sr = null;
}

var matched = [];
var ran = {};
var matchState = sr ? str(sr.filterMatchState) : '';
var invocation = sr ? str(sr.invocationResult) : '';

// filterResults: { rai: { raiFilterResult: {...} }, sdp: { sdpFilterResult: { inspectResult: {...} } }, ... }
var results = (sr && sr.filterResults) || {};
Object.keys(results).forEach(function (name) {
  var wrapper = results[name] || {};
  var keys = Object.keys(wrapper);
  var r = keys.length ? wrapper[keys[0]] : null;
  if (r && r.inspectResult) { r = r.inspectResult; }
  if (!r) { return; }
  ran[name] = str(r.executionState) === 'EXECUTION_SUCCESS';
  if (str(r.matchState) === 'MATCH_FOUND') {
    var types = r.raiFilterTypeResults || {};
    var subs = Object.keys(types).filter(function (t) { return str(types[t] && types[t].matchState) === 'MATCH_FOUND'; });
    if (subs.length) { subs.forEach(function (t) { matched.push(name + ':' + t); }); } else { matched.push(name); }
  }
});

var verdict;
if (matched.length > 0 || matchState === 'MATCH_FOUND') {
  verdict = 'blocked';
} else {
  var allRan = required.length > 0 && required.every(function (k) { return ran[k] === true; });
  var invOk = invocation === '' || invocation === 'SUCCESS';
  verdict = (matchState === 'NO_MATCH_FOUND' && allRan && invOk) ? 'allowed' : 'incomplete';
}

context.setVariable('armor.verdict', verdict);
context.setVariable('armor.filters_json', JSON.stringify(matched));
