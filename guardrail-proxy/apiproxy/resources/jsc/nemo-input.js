/*
 * nemo-input.js - builds the NVIDIA NeMo Guardrails "rails-only" input check.
 *
 * Headers (from the client / demo UI):
 *   x-nemo-guardrails : enforce | monitor | disable   (default: disable = opt-in)
 *   x-nemo-profile    : jailbreak_self_check | content_safety | topic_control
 *
 * The prompt text is only placed in the ServiceCallout body; it is never written
 * to flow variables that are logged or echoed back.
 */
var ALLOWED_PROFILES = {
    jailbreak_self_check: true,
    content_safety: true,
    topic_control: true
};
var DEFAULT_PROFILE = 'jailbreak_self_check';
var MAX_PROMPT_CHARS = 8000;

var mode = String(context.getVariable('request.header.x-nemo-guardrails') || 'disable').toLowerCase();
if (mode !== 'enforce' && mode !== 'monitor') {
    mode = 'disable';
}

var profile = String(context.getVariable('request.header.x-nemo-profile') || DEFAULT_PROFILE).toLowerCase();
if (!ALLOWED_PROFILES.hasOwnProperty(profile)) {
    profile = DEFAULT_PROFILE;
}

var prompt = '';
if (mode !== 'disable') {
    try {
        var body = JSON.parse(context.getVariable('request.content') || '{}');
        var contents = body.contents || [];
        var last = contents.length ? contents[contents.length - 1] : {};
        var parts = (last && last.parts) || [];
        var part = parts.length ? parts[parts.length - 1] : {};
        prompt = String((part && part.text) || '');
    } catch (e) {
        prompt = '';
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
        prompt = prompt.substring(0, MAX_PROMPT_CHARS);
    }
}

context.setVariable('nemo.mode', mode);
context.setVariable('nemo.profile', profile);

if (mode === 'disable') {
    context.setVariable('nemo.enabled', 'false');
    context.setVariable('nemo.verdict', 'disabled');
} else if (!prompt) {
    // Nothing to check (e.g. malformed body) - let the target / Model Armor handle it.
    context.setVariable('nemo.enabled', 'true');
    context.setVariable('nemo.call', 'false');
    context.setVariable('nemo.verdict', 'skipped');
    context.setVariable('nemo.elapsed_ms', '0');
} else {
    context.setVariable('nemo.enabled', 'true');
    context.setVariable('nemo.call', 'true');
    context.setVariable('nemo.request.body', JSON.stringify({
        model: 'gemini-2.5-flash-lite',
        messages: [{ role: 'user', content: prompt }],
        guardrails: {
            config_id: profile,
            options: { rails: ['input'], log: { activated_rails: true } }
        }
    }));
    context.setVariable('nemo.start_ms', String(Date.now()));
}
