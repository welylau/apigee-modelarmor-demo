/**
 * Guided Tour - mission definitions for Model Armor and Apigee Demo.
 *
 * Purely declarative: tour-engine.js renders and sequences these. A mission is complete when its
 * last step completes; then the "What just happened?" explainer is shown.
 *
 * Step fields (full schema: references/tour.md in the apigee-demo-ui skill)
 *   kind        'action' | 'scenario'
 *   title/body  coachmark copy (string or fn(engine)); body is trusted, authored HTML
 *   target      CSS selector to spotlight ('scenario' steps default to [data-scenario="<id>"])
 *   targetAll   spotlight the union of every match of `target` (local engine change)
 *   scenario    id for demoApp.loadScenario: text ids from /api/config, 'doc-clean' | 'doc-injection', 'mm-*'
 *   runTarget / resultTarget   run button + result card for this step (default #runBtn / #resultCard; local engine change)
 *   shade       false = highlight without dimming
 *   action      { label, run(engine) } primary button (kind 'action')
 *   before(engine)  setup when the step is shown
 *   expect      short "Expected:" line
 *   done        { click: selector } | { verdict: [...] } | { run: fn(detail, engine) -> bool }
 *               detail.verdict: text/doc = 'allowed'|'blocked'|'error'|'mixed' (both modes combined);
 *               mm = 'allowed'|'blocked'|'incomplete'|'redacted'|'error'. detail.view = 'text'|'doc'|'mm', detail.raw = body.
 *   onMiss      fn(detail, engine) -> hint HTML when a run does not satisfy `done`
 * Mission fields: id (used by ?tour=<id>), title, badge, bonus?, steps[], explainer {title, flow[{text,state,tag}], note, handoff?} | fn(engine)
 */

const click = (sel) => document.querySelector(sel)?.click();
/** before(): close any layer the user left open, then open one left section (the chip must be visible). */
const openView = (key) => (e) => {
  e.closeOverlays();
  window.demoMM?.closeExplain?.();
  e.app.setSectionOpen?.(key, true);
};
const DOC = { runTarget: '#uploadBtn', resultTarget: '#uploadResultCard' };
const MM = { runTarget: '#mmRunBtn', resultTarget: '#mmResultCard' };
const PART = { text: 'Text', IMAGE: 'Image', PDF: 'PDF', WORD_DOCUMENT: 'Word', EXCEL_DOCUMENT: 'Excel', POWERPOINT_DOCUMENT: 'PowerPoint', TXT: 'TXT', CSV: 'CSV' };
const VERDICT = { allowed: 'clean', blocked: 'blocked', incomplete: 'not fully screened', redacted: 'redacted' };
const ms = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? `${Math.round(Number(v)).toLocaleString()} ms` : '—');
const missText = (d) => (d.verdict === 'mixed' ? 'The two modes disagreed. Check the summary line above the columns.'
  : d.verdict === 'error' ? 'Both modes returned an error. Check the server <code>.env</code> and the proxy deployment.' : '');
/** Filters a mode matched (text / doc run), as a short list. */
const matched = (r, mode, fallback) => {
  const f = r?.[mode]?.armor?.filters;
  return Array.isArray(f) && f.length ? f.join(', ') : fallback;
};
/** One flow row per multimodal prompt part, from the real run (falls back to `fallback` rows). */
const partRows = (e, fallback) => {
  const parts = (e.lastRun?.view === 'mm' && Array.isArray(e.lastRun.parts) ? e.lastRun.parts : []).filter((p) => p && typeof p === 'object');
  if (!parts.length) return fallback;
  return parts.map((p) => ({
    text: `${p.name || `Part ${p.n}`}: ${VERDICT[p.verdict] || p.verdict || '—'}${Array.isArray(p.filters) && p.filters.length ? ` (${p.filters.join(', ')})` : ''}`,
    state: p.verdict === 'allowed' ? 'ok' : 'fail', tag: PART[p.kind] || 'Part',
  }));
};

export const WELCOME = {
  icon: '🛡️',
  title: 'Welcome to Model Armor & Apigee Demo: Text, Documents, and Multi-modalities',
  subtitle: 'Apigee X screens prompts, documents, pictures and answers with Model Armor before Gemini sees them.',
  minutes: 7,
  bullets: [
    'Screen a prompt with the native policy and the REST callout',
    'Screen a CV and see how each mode reads it',
    'Catch an injection hidden in a picture inside a PDF',
    'Run a 3-file happy flow (photo + PDF + CSV), Office files, and image redaction',
  ],
};

export const FINISH = {
  lead: "You've seen Apigee and Model Armor:",
  bullets: [
    'Screen prompts with the native policy or a REST callout, same verdict',
    'Screen documents as extracted text or as the raw file',
    'Pass a clean 3-modality pack (photo + PDF + CSV) to Gemini after screening every part',
    'Block sensitive Office files and redact PII in a generated image',
    'Log every decision for audit',
  ],
};

export const MISSIONS = [
  // ---------------------------------------------------------------- 1
  {
    id: 'text', title: 'Screen a prompt', badge: 'Text',
    steps: [{
      kind: 'scenario', scenario: 'clean', title: 'Screen a clean prompt', before: openView('text'),
      body: 'Load <b>Clean prompt</b> and screen it. The server sends the same prompt through Apigee twice: once with the <b>native</b> Model Armor policy, once with a <b>REST callout</b>.',
      expect: 'Allowed in both modes',
      done: { verdict: ['allowed'] },
      onMiss: missText,
      explainer: (e) => {
        const r = e.lastRun?.raw?.results || {};
        const tok = Number(r.native?.tokens?.total) || Number(r.callout?.tokens?.total) || 0;
        return {
          title: 'Clean prompt: allowed by both modes',
          flow: [
            { text: 'Native policy (SanitizeUserPrompt): no filter matched', state: 'ok', tag: 'Native' },
            { text: 'REST callout (sanitizeUserPrompt): no filter matched', state: 'ok', tag: 'Callout' },
            { text: `Gemini answered${tok ? ` (${tok.toLocaleString()} tokens)` : ''}`, state: 'ok', tag: 'Gemini' },
            { text: `Model Armor check: native ${ms(r.native?.armor?.latencyMs)} · callout ${ms(r.callout?.armor?.latencyMs)}`, state: 'ok', tag: 'Latency' },
          ],
          note: 'A clean prompt costs one Model Armor check per mode before Gemini. Next, the same box with an injection.',
        };
      },
    }, {
      kind: 'scenario', scenario: 'prompt-injection', title: 'Try a prompt injection', before: openView('text'),
      body: "This prompt tries to override the model's instructions. Model Armor should stop it in both modes.",
      expect: 'Blocked in both modes · HTTP 400',
      done: { verdict: ['blocked'] },
      onMiss: missText,
    }],
    explainer: (e) => {
      const r = e.lastRun?.raw?.results || {};
      const filters = (r.native?.armor?.filters || []).join(', ') || 'pi_and_jailbreak';
      return {
        title: 'Same verdict, two ways to call Model Armor',
        flow: [
          { text: `Native policy (SanitizeUserPrompt) matched ${filters}`, state: 'fail', tag: 'Native' },
          { text: 'REST callout (sanitizeUserPrompt) matched it too', state: 'fail', tag: 'Callout' },
          { text: 'Gemini was never called, so no tokens were spent', state: 'skip', tag: 'Gemini' },
          { text: `Model Armor check: native ${ms(r.native?.armor?.latencyMs)} · callout ${ms(r.callout?.armor?.latencyMs)}`, state: 'ok', tag: 'Latency' },
        ],
        note: 'Both modes use the same template. The native policy is configuration only; the callout gives you the full REST response. The summary line above the columns compares check times.',
      };
    },
  },
  // ---------------------------------------------------------------- 2
  {
    id: 'doc', title: 'Screen a document', badge: 'Document',
    steps: [{
      kind: 'scenario', scenario: 'doc-injection', target: '[data-sample-use="injection"]', ...DOC,
      title: 'Screen a CV with hidden instructions', before: openView('doc'),
      body: "Daniel Koh's CV has a visible injection plus white 4 pt text you can't see. Press <b>Use</b> to load it, then screen it in both modes.",
      expect: 'Blocked in both modes',
      done: { verdict: ['blocked'] },
      onMiss: missText,
      explainer: (e) => {
        const r = e.lastRun?.raw?.results || {};
        const chars = Number(e.lastRun?.file?.extractedChars) || 0;
        return {
          title: 'The CV was blocked in both modes',
          flow: [
            { text: `Native: the demo server extracted ${chars ? `${chars.toLocaleString()} characters of` : 'the'} text; SanitizeUserPrompt matched ${matched(r, 'native', 'it')}`, state: 'fail', tag: 'Native' },
            { text: `Callout: Apigee sent the raw PDF as a byteItem; Model Armor matched ${matched(r, 'callout', 'it')}`, state: 'fail', tag: 'Callout' },
            { text: "The hidden white 4 pt text was caught too: it's still text", state: 'ok', tag: 'Hidden text' },
            { text: 'Gemini never saw the CV', state: 'skip', tag: 'Gemini' },
          ],
          note: 'Next: the two small diagrams show the path each mode took.',
        };
      },
    }, {
      kind: 'action', title: 'Two paths to Model Armor', target: '#compareGrid .flow-live', targetAll: true,
      body: '<b>Native</b>: your app extracts the text first (amber), and Apigee screens that text. <b>Callout</b>: your app sends the raw file (violet) and Model Armor reads it.',
      action: { label: 'Got it', run: (e) => e.completeStep() },
    }],
    explainer: {
      title: 'One document, two ways in',
      flow: [
        { text: 'Native: your app extracted the text, SanitizeUserPrompt screened it', state: 'fail', tag: 'Native' },
        { text: 'Callout: the raw PDF went to Model Armor, which read it itself', state: 'fail', tag: 'Callout' },
        { text: "Text you can't see (white, 4 pt) is still text: both paths screen it", state: 'ok', tag: 'Hidden text' },
        { text: 'Gemini never saw the CV', state: 'skip', tag: 'Gemini' },
      ],
      note: 'Open <b>Text the demo server extracted</b> under the columns to see exactly what the native policy screened.',
    },
  },
  // ---------------------------------------------------------------- 3
  {
    id: 'hidden', title: 'Hidden in a picture', badge: 'Image',
    steps: [{
      kind: 'scenario', scenario: 'mm-pdf-embedded', target: '[data-mm-scenario="mm-pdf-embedded"]', ...MM,
      title: 'A PDF with a picture inside', before: openView('mm'),
      body: "This CV's text is clean. The injection is typed inside a picture embedded in the PDF. <b>Screen any modality</b> sends every part to Model Armor, pictures inside documents included.",
      expect: 'Blocked: the PDF part',
      done: { verdict: ['blocked'] },
      onMiss: (d) => (d.verdict === 'allowed' ? 'It got through. Check that the multimodal template screens images.' : ''),
      explainer: (e) => ({
        title: 'The text was clean, the picture was not',
        flow: [
          ...partRows(e, [
            { text: 'Prompt text: clean', state: 'ok', tag: 'Text' },
            { text: 'pdf-embedded-injection.pdf: blocked (pi_and_jailbreak)', state: 'fail', tag: 'PDF' },
          ]),
          { text: 'Model Armor read the picture inside the PDF, not just its text', state: 'ok', tag: 'Embedded image' },
          { text: 'Apigee stopped the request: Gemini was never called', state: 'skip', tag: '400' },
        ],
        note: 'Next: why <b>Screen a document</b> would let the same file through.',
      }),
    }, {
      kind: 'action', title: 'Why the other view misses it', target: '.section-info[data-explain="mm"]', before: (e) => e.app.setSectionOpen?.('mm', true),
      body: '<b>Screen a document</b> screens text only, so the same file passes there. Open the comparison.',
      action: { label: 'Open comparison', run: () => click('.section-info[data-explain="mm"]') },
      done: { click: '[data-explain]' },
    }, {
      kind: 'action', title: 'Document vs any modality', target: '#explainModal .explain-try', shade: false,
      body: 'Pictures inside a document are screened only in <b>Screen any modality</b>. It also screens Gemini\'s answer.',
      action: { label: 'Close and continue', run: (e) => { window.demoMM?.closeExplain?.(); e.completeStep(); } },
    }],
    explainer: {
      title: 'Same file, two views, two results',
      flow: [
        { text: 'Screen a document: the text is extracted or read as a document; pictures inside are not screened', state: 'miss', tag: 'Allowed' },
        { text: 'Screen any modality: the text and up to 5 embedded pictures are screened', state: 'fail', tag: 'Blocked' },
        { text: 'Both go through Apigee to Model Armor before Gemini', state: 'ok', tag: 'Gateway' },
      ],
      note: 'Pick the view by what your users send: text documents, or pictures and Office files.',
    },
  },
  // ---------------------------------------------------------------- 4
  {
    id: 'office', title: 'Multi-file & Office', badge: 'Multi-file',
    steps: [{
      kind: 'scenario', scenario: 'mm-launch-pack', target: '[data-mm-scenario="mm-launch-pack"]', ...MM,
      title: 'Happy flow: photo + PDF + CSV', before: openView('mm'),
      body: 'Three clean attachments in one request: a product photo, a PDF spec sheet, and a Q4 stock CSV. Apigee screens all 4 prompt parts separately, forwards them to Gemini, and screens the answer.',
      expect: 'Allowed: all 4 parts + answer',
      done: { verdict: ['allowed'] },
      explainer: (e) => ({
        title: 'All 4 parts passed, and Gemini cross-checked them',
        flow: [
          ...partRows(e, [
            { text: 'Prompt text: clean', state: 'ok', tag: 'Text' },
            { text: 'img-clean.png: clean', state: 'ok', tag: 'Image' },
            { text: 'spec-mug.pdf: clean (text + embedded photo)', state: 'ok', tag: 'PDF' },
            { text: 'inventory-q4.csv: clean', state: 'ok', tag: 'CSV' },
          ]),
          { text: 'Gemini verified the photo against the PDF and totalled Q4 stock from the CSV', state: 'ok', tag: 'Gemini' },
          { text: 'Answer text screened by sanitizeModelResponse before return', state: 'ok', tag: 'Answer' },
        ],
        note: 'Next: try two Office files containing sensitive payment card and customer data.',
      }),
    }, {
      kind: 'scenario', scenario: 'mm-office-pii', target: '[data-mm-scenario="mm-office-pii"]', ...MM,
      title: 'Screen PowerPoint and Excel', before: openView('mm'),
      body: 'A slide with a card number in a picture, and a sheet of customer details. Model Armor reads Office files directly.',
      expect: 'Blocked: PowerPoint and Excel parts (Sensitive data)',
      done: { verdict: ['blocked'] },
    }],
    explainer: (e) => {
      const parts = (e.lastRun?.view === 'mm' && Array.isArray(e.lastRun.parts) ? e.lastRun.parts : []).filter((p) => p && typeof p === 'object');
      const flow = parts.length
        ? parts.map((p) => ({
          text: `${p.name || `Part ${p.n}`}: ${VERDICT[p.verdict] || p.verdict || '—'}${Array.isArray(p.filters) && p.filters.length ? ` (${p.filters.join(', ')})` : ''}`,
          state: p.verdict === 'allowed' ? 'ok' : 'fail', tag: PART[p.kind] || 'Part',
        }))
        : [
          { text: 'PowerPoint: card number found in a slide picture', state: 'fail', tag: 'PowerPoint' },
          { text: 'Excel: customer details found', state: 'fail', tag: 'Excel' },
        ];
      flow.push({ text: 'Gemini was never called', state: 'skip', tag: 'Gemini' });
      return {
        title: 'Every file screened, one call per part',
        flow,
        note: "Clean multi-file packs go straight through to Gemini; files with PII stop at the gateway.",
      };
    },
  },
  // ---------------------------------------------------------------- 5
  {
    id: 'redact', title: 'Screen the answer', badge: 'Redact',
    steps: [{
      kind: 'scenario', scenario: 'mm-generate-sign', target: '[data-mm-scenario="mm-generate-sign"]', ...MM,
      title: 'Screen the answer, not just the prompt',
      before: (e) => { openView('mm')(e); window.demoMM?.setAction?.('redact'); },
      body: 'The prompt is clean, but the image Gemini draws will show an email address. With <b>Redact</b>, Apigee returns the image Model Armor cleaned. Generating it takes 10 to 15 seconds.',
      expect: 'Redacted',
      done: { verdict: ['redacted'] },
      onMiss: (d) => (d.verdict === 'blocked' ? 'Blocked instead: <b>Response images</b> is set to Block. Switch it to Redact and run again.'
        : d.verdict === 'allowed' ? 'Model Armor found nothing in this image. Image models vary: run it again.' : ''),
    }],
    explainer: (e) => {
      const findings = (e.lastRun?.response?.image?.findings || []).join(', ') || 'an email address';
      return {
        title: 'The answer was screened too',
        flow: [
          { text: 'Prompt screened: clean', state: 'ok', tag: 'sanitizeUserPrompt' },
          { text: 'Gemini generated the image', state: 'ok', tag: 'Gemini' },
          { text: `Answer screened: found ${findings} in the image`, state: 'fail', tag: 'sanitizeModelResponse' },
          { text: 'Apigee returned the redacted image; the original never left the gateway', state: 'ok', tag: 'Redact' },
        ],
        note: 'Switch <b>Response images</b> to Block to hold the whole answer back instead.',
      };
    },
  },
  // ---------------------------------------------------------------- bonus
  {
    id: 'audit', title: 'Bonus: Open the audit log', badge: 'Audit', bonus: true,
    steps: [{
      kind: 'action', title: 'Every decision is logged', target: '#adminTab',
      before: (e) => { e.closeOverlays(); window.demoMM?.closeExplain?.(); },
      body: 'The tab on the right edge opens the audit log. It is a real <code>&lt;button&gt;</code>, so <kbd>Tab</kbd> + <kbd>Enter</kbd> works too.',
      action: { label: 'Open audit log', run: () => click('#adminTab') },
      done: { click: '#adminTab, #btnOpenAdmin' },
    }],
    explainer: {
      title: 'The audit trail',
      flow: [
        { text: 'One row per request and mode: scenario, mode, matched filters, HTTP status, verdict, latency', state: 'ok', tag: 'Ledger' },
        { text: 'No prompts, files, keys or PII in this view', state: 'ok', tag: 'Privacy' },
        { text: "Refresh pulls the proxies' Cloud Logging entries", state: 'ok', tag: 'Logging' },
      ],
    },
  },
];
