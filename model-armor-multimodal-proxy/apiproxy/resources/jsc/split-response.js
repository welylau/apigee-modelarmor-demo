/**
 * JS-Split-Response: read Gemini's answer and build the Model Armor sanitizeModelResponse bodies.
 *
 * Gemini can answer with text and (image model) an inline image. Model Armor screens one item per call:
 *   text  -> {"modelResponseData":{"text":...}}                                   (SC-MM-Resp-Text)
 *   image -> {"modelResponseData":{"byteItem":{"byteDataType":"IMAGE",...}}}      (SC-MM-Resp-Image)
 * Sets mm.resp_has_text / mm.resp_has_image ("true"/"false"), private.mm.resp_text_body,
 * private.mm.resp_image_body, mm.resp_image_index (part index in candidates[0].content.parts),
 * mm.resp_shape_ok ("false" when the answer can't be screened: unreadable, more than one image,
 * or an image type Model Armor doesn't accept) and mm.rt0 (start time for the response checks).
 * Parts that are not screened are REMOVED from response.content before screening/forwarding:
 * thought parts (thought:true) and anything that is neither text nor inlineData (functionCall,
 * fileData, executableCode, ...). So the client only ever receives what Model Armor screened.
 */
context.setVariable('mm.rt0', String(Date.now()));
var hasText = false, hasImage = false, shapeOk = true;
try {
  var r = JSON.parse(String(context.getVariable('response.content') || ''));
  var content = r && r.candidates && r.candidates[0] && r.candidates[0].content;
  var raw = (content && content.parts) || [];
  var parts = [];
  for (var k = 0; k < raw.length; k++) {
    var q = raw[k] || {};
    if (q.thought) { continue; }                                   // model reasoning: never screened
    if (typeof q.text === 'string' || q.inlineData) { parts.push(q); }
  }
  if (parts.length !== raw.length) {
    content.parts = parts;
    context.setVariable('response.content', JSON.stringify(r));
  }
  var texts = [];
  var images = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i] || {};
    if (typeof p.text === 'string' && p.text.trim().length) { texts.push(p.text); }
    if (p.inlineData && typeof p.inlineData.data === 'string') { images.push({ index: i, mime: String(p.inlineData.mimeType || '').toLowerCase(), data: p.inlineData.data }); }
    else if (p.inlineData) { shapeOk = false; }                     // inlineData without bytes: cannot screen
  }
  if (texts.length) {
    hasText = true;
    context.setVariable('private.mm.resp_text', texts.join('\n'));   // native SanitizeModelResponse
    context.setVariable('private.mm.resp_text_body', JSON.stringify({ modelResponseData: { text: texts.join('\n') } }));
  }
  if (images.length > 1) { shapeOk = false; }
  if (images.length === 1) {
    var img = images[0];
    if (['image/png', 'image/jpeg', 'image/bmp'].indexOf(img.mime) < 0) { shapeOk = false; }
    else {
      hasImage = true;
      context.setVariable('mm.resp_image_index', String(img.index));
      context.setVariable('private.mm.resp_image_body', JSON.stringify({ modelResponseData: { byteItem: { byteDataType: 'IMAGE', byteData: img.data } } }));
    }
  }
} catch (e) {
  shapeOk = false;
}
context.setVariable('mm.resp_has_text', hasText ? 'true' : 'false');
context.setVariable('mm.resp_has_image', hasImage ? 'true' : 'false');
context.setVariable('mm.resp_shape_ok', shapeOk ? 'true' : 'false');
