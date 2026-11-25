/**
 * JS-Evaluate-Parts (includes armor-lib.js): one verdict per prompt part, then one overall verdict.
 *
 * Reads mmArmorResp<N>.content (ServiceCallout SC-MM-Part-<N>) and mm.t<N> (time after each callout).
 * Sets
 *   mm.verdict     allowed | blocked | incomplete   (blocked if ANY part matched; incomplete if any part
 *                  could not be fully screened; allowed only if EVERY part is clean)
 *   mm.matched     e.g. "p1:pi_and_jailbreak,p3:sdp" or "none"
 *   mm.parts_json  JSON [{n, kind, verdict, filters, ms, bytes, forwarded}]  (names only, no content)
 *   mm.latency_ms  total Model Armor time for the prompt
 */
var required = armorRequired(properties.requiredFilters);
var count = parseInt(String(context.getVariable('mm.part_count') || '0'), 10);
var meta = [];
try { meta = JSON.parse(String(context.getVariable('mm.parts_meta') || '[]')); } catch (e) { meta = []; }

var parts = [];
var matched = [];
var anyBlocked = false, anyIncomplete = count === 0;
var prev = Number(context.getVariable('mm.t0'));
for (var n = 1; n <= count; n++) {
  var s = armorSummary(context.getVariable('mmArmorResp' + n + '.content'), required);
  var t = Number(context.getVariable('mm.t' + n));
  var ms = (isFinite(t) && isFinite(prev) && t >= prev) ? t - prev : null;
  if (isFinite(t)) { prev = t; }
  var m = meta[n - 1] || {};
  parts.push({ n: n, kind: String(context.getVariable('mm.part' + n + '.kind') || m.kind || ''), verdict: s.verdict,
               filters: s.filters, ms: ms, bytes: m.bytes || 0, forwarded: m.forwarded !== false });
  if (s.verdict === 'blocked') { anyBlocked = true; s.filters.forEach(function (f) { matched.push('p' + n + ':' + f); }); }
  if (s.verdict === 'incomplete') { anyIncomplete = true; }
}

var start = Number(context.getVariable('mm.t0'));
context.setVariable('mm.verdict', anyBlocked ? 'blocked' : (anyIncomplete ? 'incomplete' : 'allowed'));
context.setVariable('mm.matched', matched.length ? matched.join(',') : 'none');
context.setVariable('mm.parts_json', JSON.stringify(parts));
context.setVariable('mm.latency_ms', String(isFinite(start) && start > 0 && isFinite(prev) ? Math.max(0, prev - start) : 0));
