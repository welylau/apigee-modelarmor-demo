/**
 * JS-Split-Parts: validate the multimodal prompt and build one Model Armor request per part.
 *
 * Accepts exactly ONE user content with at most 1 text part and at most `maxFiles` inlineData parts.
 * Model Armor screens one item per call (one text, OR one image, OR one document), so each part becomes
 * its own sanitizeUserPrompt body:
 *   text                     -> {"userPromptData":{"text":...}}
 *   image / document / text  -> {"userPromptData":{"byteItem":{"byteDataType":<TYPE>,"byteData":<base64>}}}
 *
 * Sets
 *   mm.flow            chat | image                 (POST /generate | POST /generate-image)
 *   mm.input_ok        "true" | "false";  mm.reject_reason (fixed text, never echoes input)
 *   mm.part_count      1..4;  mm.partN.kind = text | IMAGE | PDF | WORD_DOCUMENT | ... (telemetry only)
 *   private.mm.partN.body   Model Armor request body for part N (private.* is masked in Debug)
 *   mm.parts_meta      JSON [{n, kind, mime, bytes, forwarded}]  (no content)
 *   mm.model           Gemini model for this flow (property model / image_model)
 *   mm.image_action    block | redact   (header x-armor-image-action, else property responseImageAction)
 *   mm.resp_image_template   Model Armor template used for response images (redact or inspect)
 * Rewrites request.content to the body Gemini receives: the text part, every part Gemini can read
 * (images, PDF, text), and a short note for parts it can't (Office files, BMP) that passed screening.
 */
var flow = String(context.getVariable('proxy.pathsuffix') || '') === '/generate-image' ? 'image' : 'chat';
context.setVariable('mm.flow', flow);
// native  = Apigee's built-in SanitizeUserPrompt / SanitizeModelResponse policies (text only)
// callout = ServiceCallouts to the Model Armor REST API (text, images, documents)   [default]
// Default is callout here (101 proxy defaults to native): only the REST API can screen images and documents.
var mode = String(context.getVariable('request.header.x-armor-mode') || 'callout').toLowerCase().trim();
if (mode !== 'native') { mode = 'callout'; }
context.setVariable('mm.mode', mode);

var maxFiles = parseInt(String(properties.maxFiles || '3'), 10);
var maxText = parseInt(String(properties.maxTextChars || '8000'), 10);
var maxPart = parseInt(String(properties.maxPartBase64Chars || '5592408'), 10);    // 4 MB file
var maxTotal = parseInt(String(properties.maxTotalBase64Chars || '7000000'), 10);  // ~5 MB of files
var defAction = String(properties.responseImageAction || 'redact').toLowerCase();

// MIME type -> Model Armor byteDataType, and whether Gemini can read the bytes directly.
var TYPES = {
  'image/png': { armor: 'IMAGE', gemini: 'image/png' },
  'image/jpeg': { armor: 'IMAGE', gemini: 'image/jpeg' },
  'image/bmp': { armor: 'IMAGE', gemini: null },
  'application/pdf': { armor: 'PDF', gemini: 'application/pdf' },
  'text/plain': { armor: 'TXT', gemini: 'text/plain' },
  'text/csv': { armor: 'CSV', gemini: 'text/plain' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { armor: 'WORD_DOCUMENT', gemini: null },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { armor: 'EXCEL_DOCUMENT', gemini: null },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { armor: 'POWERPOINT_DOCUMENT', gemini: null }
};
var LABEL = { WORD_DOCUMENT: 'Word document', EXCEL_DOCUMENT: 'Excel workbook', POWERPOINT_DOCUMENT: 'PowerPoint deck', IMAGE: 'BMP image' };
var B64 = /^[A-Za-z0-9+\/]+={0,2}$/;

var ok = false;
var reason = 'Send one user content with at most 1 text part (max ' + maxText + ' chars) and at most ' + maxFiles +
  ' inlineData files (PNG, JPEG, BMP, PDF, TXT, CSV, DOCX, XLSX, PPTX; max 4 MB each).';
var screened = [];   // [{kind, body, meta}]
var gemini = [];     // parts forwarded to Gemini
var text = null;
try {
  var req = JSON.parse(String(context.getVariable('request.content') || ''));
  var contents = req && req.contents;
  if (contents && contents.length === 1) {
    var c = contents[0];
    var parts = c && c.parts;
    if ((c.role === undefined || c.role === 'user') && parts && parts.length >= 1 && parts.length <= 1 + maxFiles) {
      ok = true;
      var files = 0, total = 0;
      for (var i = 0; i < parts.length && ok; i++) {
        var p = parts[i] || {};
        if (typeof p.text === 'string' && p.inlineData === undefined) {
          if (text !== null || p.text.trim().length === 0 || p.text.length > maxText) { ok = false; break; }
          text = p.text;
        } else if (p.text === undefined && p.inlineData && typeof p.inlineData === 'object') {
          var mime = String(p.inlineData.mimeType || '').toLowerCase();
          var data = p.inlineData.data;
          var type = TYPES.hasOwnProperty(mime) ? TYPES[mime] : null;
          if (!type) { ok = false; reason = 'Unsupported file type: ' + mime.slice(0, 80) + '.'; break; }
          if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !B64.test(data)) {
            ok = false; reason = 'inlineData.data must be non-empty standard base64.'; break;
          }
          files++; total += data.length;
          if (files > maxFiles) { ok = false; break; }
          if (data.length > maxPart) { ok = false; reason = 'Each file must be 4 MB or smaller (Model Armor limit).'; break; }
          if (total > maxTotal) { ok = false; reason = 'Files are too large together (max ' + maxTotal + ' base64 chars).'; break; }
          screened.push({ kind: type.armor, body: { userPromptData: { byteItem: { byteDataType: type.armor, byteData: data } } },
            meta: { kind: type.armor, mime: mime, bytes: Math.floor(data.length * 3 / 4), forwarded: !!type.gemini } });
          if (type.gemini) {
            gemini.push({ inlineData: { mimeType: type.gemini, data: data } });
          } else {
            gemini.push({ text: '[An attached ' + (LABEL[type.armor] || type.armor) + ' passed Model Armor screening. ' +
              'This model cannot read that file type, so only this note is shared.]' });
          }
        } else {
          ok = false; break;
        }
      }
      if (ok && text === null) { ok = false; reason = 'A text part (the question or instruction) is required.'; }
    }
  }
} catch (e) {
  ok = false;
}

context.setVariable('mm.input_ok', ok ? 'true' : 'false');
if (!ok) {
  context.setVariable('mm.reject_reason', reason);
  context.setVariable('mm.part_count', 0);
} else {
  // Text first, then files in request order: part numbers match what the client sent (text = part 1).
  screened.unshift({ kind: 'text', body: { userPromptData: { text: text } },
    meta: { kind: 'text', mime: 'text/plain', bytes: text.length, forwarded: true } });
  var meta = [];
  for (var n = 1; n <= screened.length; n++) {
    context.setVariable('mm.part' + n + '.kind', screened[n - 1].kind);
    context.setVariable('private.mm.part' + n + '.body', JSON.stringify(screened[n - 1].body));
    var m = screened[n - 1].meta; m.n = n; meta.push(m);
  }
  context.setVariable('mm.part_count', screened.length);   // number: step conditions use mm.part_count >= N
  context.setVariable('mm.parts_meta', JSON.stringify(meta));
  context.setVariable('private.mm.native_text', text);      // SUP-MM-Native-Prompt (native mode)
  var geminiParts = mode === 'native' ? [{ text: text }] : [{ text: text }].concat(gemini);
  var geminiBody = { contents: [{ role: 'user', parts: geminiParts }] };
  if (flow === 'image') { geminiBody.generationConfig = { responseModalities: ['TEXT', 'IMAGE'] }; }
  context.setVariable('request.content', JSON.stringify(geminiBody));
}

var model = flow === 'image' ? context.getVariable('propertyset.demo.image_model') : context.getVariable('propertyset.demo.model');
context.setVariable('mm.model', String(model || ''));
var action = String(context.getVariable('request.header.x-armor-image-action') || defAction).toLowerCase().trim();
if (action !== 'block' && action !== 'redact') { action = defAction === 'block' ? 'block' : 'redact'; }
context.setVariable('mm.image_action', action);
context.setVariable('mm.resp_image_template', String(context.getVariable(
  action === 'redact' ? 'propertyset.demo.armor_template_redact' : 'propertyset.demo.armor_template_inspect') || ''));
