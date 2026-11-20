/**
 * JS-Prepare-Request
 * Accepts a Gemini generateContent body with exactly ONE user part:
 *   text : {"text": "..."}                                  (max maxPromptChars)
 *   file : {"inlineData": {"mimeType": "...", "data": "<base64>"}}
 *          mimeType application/pdf | text/plain | text/csv  (max maxFileBase64Chars)
 * Sets
 *   armor.input_ok               "true" | "false"
 *   armor.reject_reason          short fixed message for RF-Bad-Request (never echoes input)
 *   private.armor.callout_body   body for SC-Model-Armor (userPromptData.text or .byteItem)
 *   request.content              a fresh Gemini body with only what Model Armor screened
 *                                (+ the proxy-owned fileInstruction for files)
 */
var maxChars = parseInt(String(properties.maxPromptChars || '8000'), 10);
var maxB64 = parseInt(String(properties.maxFileBase64Chars || '1400000'), 10);
var instruction = String(properties.fileInstruction || 'Summarise this document in three short bullet points.');
var ARMOR_TYPE = { 'application/pdf': 'PDF', 'text/plain': 'TXT', 'text/csv': 'CSV' };
var GEMINI_MIME = { PDF: 'application/pdf', TXT: 'text/plain', CSV: 'text/plain' };

var ok = false;
var reason = 'Send one user part: a text, or one inlineData file (application/pdf, text/plain or text/csv) in standard base64.';
var armorBody = null;
var geminiParts = null;

try {
  var body = JSON.parse(String(context.getVariable('request.content') || ''));
  var c = body && body.contents && body.contents.length === 1 ? body.contents[0] : null;
  var p = c && (c.role === undefined || c.role === 'user') && c.parts && c.parts.length === 1 ? c.parts[0] : null;

  if (p && typeof p.text === 'string' && p.text.trim().length > 0 && p.inlineData === undefined) {
    if (p.text.length <= maxChars) {
      armorBody = { userPromptData: { text: p.text } };
      geminiParts = [{ text: p.text }];
      ok = true;
    } else {
      reason = 'Prompt too long (max ' + maxChars + ' chars).';
    }
  } else if (p && p.text === undefined && p.inlineData && typeof p.inlineData === 'object') {
    var mime = String(p.inlineData.mimeType || '').toLowerCase();
    var data = p.inlineData.data;
    var type = ARMOR_TYPE.hasOwnProperty(mime) ? ARMOR_TYPE[mime] : null;
    if (!type) {
      reason = 'Unsupported file type. Allowed: application/pdf, text/plain, text/csv.';
    } else if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+\/]+={0,2}$/.test(data)) {
      reason = 'inlineData.data must be non-empty standard base64.';
    } else if (data.length > maxB64) {
      reason = 'File too large (max ' + maxB64 + ' base64 chars).';
    } else {
      armorBody = { userPromptData: { byteItem: { byteDataType: type, byteData: data } } };
      geminiParts = [{ text: instruction }, { inlineData: { mimeType: GEMINI_MIME[type], data: data } }];
      ok = true;
    }
  }
} catch (e) {
  ok = false;
}

context.setVariable('armor.input_ok', ok ? 'true' : 'false');
if (ok) {
  context.setVariable('private.armor.callout_body', JSON.stringify(armorBody));
  context.setVariable('request.content', JSON.stringify({ contents: [{ role: 'user', parts: geminiParts }] }));
} else {
  context.setVariable('armor.reject_reason', reason);
}
