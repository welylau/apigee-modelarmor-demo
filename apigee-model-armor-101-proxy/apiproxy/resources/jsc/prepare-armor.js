/**
 * JS-Prepare-Armor
 * - armor.mode       = "callout" if header x-armor-mode is "callout", otherwise "native"
 * - armor.input_ok   = "true" only for exactly ONE user content with ONE part, either
 *     text       : one non-empty text part (both modes), or
 *     inlineData : one uploaded file (callout mode only; the native SanitizeUserPrompt policy is
 *                  text-only, so a file sent in native mode is rejected with a clear reason)
 *   so what Model Armor inspects is exactly what Gemini receives.
 * - armor.input      = "text" | "file:PDF" | "file:TXT" | "file:CSV"   (telemetry, no content)
 * - armor.reject_reason  short, fixed message for RF-Bad-Request (never echoes input)
 * - private.armor.prompt        the text prompt (private.* is masked in Debug)
 * - private.armor.callout_body  JSON body for the REST sanitizeUserPrompt call
 *                               (userPromptData.text, or userPromptData.byteItem for files)
 * On success request.content is ALWAYS rewritten to a fresh Gemini body, so Gemini only receives
 * what Model Armor screened:
 *   text : {contents:[{role:'user',parts:[{text:<prompt>}]}]}
 *   file : the proxy-owned instruction (property fileInstruction) + the same inlineData bytes.
 * Nothing else from the client body (systemInstruction, tools, toolConfig, generationConfig,
 * safetySettings, cachedContent, ...) is forwarded in either mode.
 * On rejection the body is left untouched (RF-Bad-Request stops the flow anyway).
 */
// Default is native here (multimodal proxy defaults to callout): this proxy teaches the built-in text policies first.
var mode = String(context.getVariable('request.header.x-armor-mode') || 'native').toLowerCase().trim();
if (mode !== 'callout') { mode = 'native'; }
context.setVariable('armor.mode', mode);

var maxChars = parseInt(String(properties.maxPromptChars || '8000'), 10);
var maxFileB64 = parseInt(String(properties.maxFileBase64Chars || '1400000'), 10);
var instruction = String(properties.fileInstruction || 'Summarise this document in three short bullet points.');
// Upload MIME type -> Model Armor byteDataType and the MIME type sent to Gemini.
var FILE_TYPES = {
  'application/pdf': { armor: 'PDF', gemini: 'application/pdf' },
  'text/plain': { armor: 'TXT', gemini: 'text/plain' },
  'text/csv': { armor: 'CSV', gemini: 'text/plain' }
};
var B64 = /^[A-Za-z0-9+\/]+={0,2}$/;

var ok = false;
var reason = 'Send exactly one user content with one part: a non-empty text (max ' + maxChars + ' chars) or, in callout mode, one inlineData file.';
var prompt = '';
var file = null;
try {
  var body = JSON.parse(String(context.getVariable('request.content') || ''));
  var contents = body && body.contents;
  if (contents && contents.length === 1) {
    var c = contents[0];
    var role = c && c.role;
    var parts = c && c.parts;
    if ((role === undefined || role === 'user') && parts && parts.length === 1) {
      var p = parts[0] || {};
      if (typeof p.text === 'string' && p.text.trim().length > 0 && p.inlineData === undefined) {
        prompt = p.text;
        ok = prompt.length <= maxChars;
      } else if (p.text === undefined && p.inlineData && typeof p.inlineData === 'object') {
        var mime = String(p.inlineData.mimeType || '').toLowerCase();
        var data = p.inlineData.data;
        var type = FILE_TYPES.hasOwnProperty(mime) ? FILE_TYPES[mime] : null;
        if (mode !== 'callout') {
          reason = 'Files need x-armor-mode: callout. The native SanitizeUserPrompt policy only screens text, so extract the text and send it as a text part.';
        } else if (!type) {
          reason = 'Unsupported file type. Allowed: application/pdf, text/plain, text/csv.';
        } else if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !B64.test(data)) {
          reason = 'inlineData.data must be non-empty standard base64.';
        } else if (data.length > maxFileB64) {
          reason = 'File too large (max ' + maxFileB64 + ' base64 chars).';
        } else {
          file = { armor: type.armor, gemini: type.gemini, data: data };
          ok = true;
        }
      }
    }
  }
} catch (e) {
  ok = false;
}

context.setVariable('armor.input_ok', ok ? 'true' : 'false');
context.setVariable('armor.input', file ? 'file:' + file.armor : 'text');
if (!ok) {
  context.setVariable('armor.reject_reason', reason);
} else if (file) {
  context.setVariable('private.armor.callout_body',
    JSON.stringify({ userPromptData: { byteItem: { byteDataType: file.armor, byteData: file.data } } }));
  context.setVariable('request.content', JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: instruction }, { inlineData: { mimeType: file.gemini, data: file.data } }] }]
  }));
} else {
  context.setVariable('private.armor.prompt', prompt);
  context.setVariable('private.armor.callout_body', JSON.stringify({ userPromptData: { text: prompt } }));
  // Forward only the screened prompt: unscreened fields such as systemInstruction or tools
  // must never reach Gemini.
  context.setVariable('request.content', JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  }));
}
