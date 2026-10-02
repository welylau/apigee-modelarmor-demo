/*
 * nemo-evaluate.js - interprets the NeMo Guardrails rails-only response.
 *
 * A check is "block" when any activated input rail stopped the flow
 * (rail.stop === true or "stop" in rail.decisions).
 * Failure policy: FAIL-OPEN. Timeouts / non-200 / unparsable responses give
 * verdict "error" and never block; Static + Model Armor layers still apply.
 */
function jsonSafe(s) {
    var j = JSON.stringify(String(s || ''));
    return j.substring(1, j.length - 1);
}
function headerSafe(s) {
    return String(s || '')
        .replace(/\s*\$model=\S+/g, '')
        .replace(/[^A-Za-z0-9 _,.:\-]/g, '')
        .substring(0, 200);
}

var mode = context.getVariable('nemo.mode');
var start = parseInt(context.getVariable('nemo.start_ms') || '0', 10);
context.setVariable('nemo.elapsed_ms', String(start ? (Date.now() - start) : 0));

var status = String(context.getVariable('nemoResponse.status.code') || '');
var verdict = 'error';
var rail = '';
var rails = [];
var message = '';

if (status === '200') {
    try {
        var r = JSON.parse(context.getVariable('nemoResponse.content') || '{}');
        var log = (r.guardrails && r.guardrails.log) || {};
        var activated = log.activated_rails || [];
        verdict = 'pass';
        for (var i = 0; i < activated.length; i++) {
            var a = activated[i] || {};
            if (a.name) { rails.push(String(a.name)); }
            var decisions = a.decisions || [];
            var stopped = a.stop === true || decisions.indexOf('stop') !== -1;
            if (stopped) {
                verdict = 'block';
                if (!rail) { rail = String(a.name || 'unknown rail'); }
            }
        }
        if (verdict === 'block') {
            var choice = (r.choices && r.choices[0]) || {};
            message = (choice.message && choice.message.content) || 'Blocked by NeMo Guardrails';
        }
    } catch (e) {
        verdict = 'error';
        message = 'Unparsable NeMo response';
    }
} else {
    message = status ? ('NeMo HTTP ' + status) : 'NeMo callout failed (timeout / network)';
}

context.setVariable('nemo.verdict', verdict);
context.setVariable('nemo.rail', headerSafe(rail));
context.setVariable('nemo.rails', headerSafe(rails.join(',')));
context.setVariable('nemo.message', jsonSafe(message));
context.setVariable('nemo.action', (verdict === 'block' && mode === 'enforce') ? 'block' : 'allow');
