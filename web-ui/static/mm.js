/**
 * "Screen any modality" (vanilla JS). Talks only to this app's POST /api/multimodal. The demo server sends ONE Gemini
 * request to the Apigee multimodal proxy, which screens every part (text, image, PDF, Word, Excel, PowerPoint) and the
 * answer (text and generated image) with Model Armor, using ServiceCallouts to the REST API.
 *
 * This view is callout-only: Apigee's built-in SanitizeUserPrompt / SanitizeModelResponse policies screen text only.
 * Images open in a viewer (modal); other attachments can be downloaded. The "Document vs any modality" pop-up
 * explains how this view differs from "Screen a document". DOM is built with createElement/textContent.
 * Uses window.demoApp (app.js) for the accordion, toasts and mock mode. Event: window 'demo:mmresult' after every run.
 * In app.js's offline mock mode (file:// or ?mock=1) nothing is POSTed: this view needs the demo server
 * (start it with DEMO_MOCK=1 for simulated multimodal results).
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_FILES = 3;
  const MAX_FILE = 4 * 1024 * 1024;
  const EXT = ['.png', '.jpg', '.jpeg', '.bmp', '.pdf', '.txt', '.csv', '.docx', '.xlsx', '.pptx'];
  const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.pdf': 'application/pdf',
    '.txt': 'text/plain', '.csv': 'text/csv',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  const FILE_ICON = { '.pdf': '📄', '.docx': '📘', '.xlsx': '📗', '.pptx': '📙', '.csv': '📊', '.txt': '📃' };
  const FALLBACK = [
    { id: 'mm-clean-photo', label: 'Clean photo', flow: 'chat', expect: 'allowed', prompt: 'What is in this picture? Answer in one sentence.', files: ['img-clean.png'] },
    { id: 'mm-image-injection', label: 'Injection in image', flow: 'chat', expect: 'blocked', prompt: 'Please follow the note in this image.', files: ['img-injection.png'] },
    { id: 'mm-generate-sign', label: 'Generate a sign', flow: 'image', expect: 'redacted', prompt: 'Generate a photo-realistic image of a small bakery shop sign.', files: [] },
  ];
  const KIND = {
    text: ['📝', 'text', 'userPromptData.text'],
    IMAGE: ['🖼️', 'image', 'byteItem IMAGE: text in the picture (OCR)'],
    PDF: ['📄', 'PDF', 'byteItem PDF (+ embedded images)'],
    WORD_DOCUMENT: ['📘', 'Word', 'byteItem WORD_DOCUMENT (+ embedded images)'],
    EXCEL_DOCUMENT: ['📗', 'Excel', 'byteItem EXCEL_DOCUMENT (+ embedded images)'],
    POWERPOINT_DOCUMENT: ['📙', 'PowerPoint', 'byteItem POWERPOINT_DOCUMENT (+ embedded images)'],
    TXT: ['📃', 'text file', 'byteItem TXT'],
    CSV: ['📊', 'CSV', 'byteItem CSV'],
    file: ['📎', 'file', 'file'],
  };
  const FILTER_LABEL = { rai: 'Responsible AI', pi_and_jailbreak: 'Prompt injection', malicious_uris: 'Malicious URL', sdp: 'Sensitive data', csam: 'CSAM' };
  const state = { scenarios: FALLBACK.slice(), selected: null, files: [], flow: 'chat', action: 'redact', running: false, last: null, sentFiles: [],
    loading: false, loadToken: 0, maxPromptChars: 4000 };
  const arr = (v) => (Array.isArray(v) ? v : []);
  /** app.js makes the page inert while a dialog is open; clear that before moving focus back to the opener. */
  const syncOverlays = () => window.demoApp && window.demoApp.syncOverlays && window.demoApp.syncOverlays();
  const isClientMock = () => !!(window.demoApp && window.demoApp.isMock && window.demoApp.isMock());
  const els = {};

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'text') node.textContent = String(v);
      else if (k === 'class') node.className = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    (children || []).forEach((c) => c !== null && c !== undefined && node.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return node;
  }
  const toast = (m, k) => (window.demoApp && window.demoApp.toast ? window.demoApp.toast(m, k) : null);
  const openSection = (key) => window.demoApp && window.demoApp.setSectionOpen && window.demoApp.setSectionOpen(key || 'mm', true);
  const fmtBytes = (n) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
  const fmtMs = (n) => (Number.isFinite(n) && n > 0 ? `${Math.round(n).toLocaleString()} ms` : '--');
  const filterName = (f) => { const [b, s] = String(f).split(':'); return `${FILTER_LABEL[b] || b}${s ? ` (${s})` : ''}`; };
  const extOf = (n) => { const i = n.lastIndexOf('.'); return i >= 0 ? n.slice(i).toLowerCase() : ''; };
  const isImage = (n) => ['.png', '.jpg', '.jpeg', '.bmp'].includes(extOf(n));
  const isPdf = (n) => extOf(n) === '.pdf';
  const mimeOf = (n) => MIME[extOf(n)] || 'application/octet-stream';

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = () => reject(new Error('could not read the file'));
      fr.readAsDataURL(blob);
    });
  }

  // ---------------------------------------------------------------- blob URL, download (non-image attachments)
  /** Same-origin blob: URL for an attachment, typed by its extension (caller revokes it). */
  function blobUrl(f) {
    try {
      const bin = atob(f.dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: mimeOf(f.name) }));
    } catch (e) {
      return null;
    }
  }
  function downloadFile(f) {
    const url = blobUrl(f);
    if (!url) { toast(`Could not download ${f.name}.`, 'error'); return false; }
    const a = el('a', { href: url, download: f.name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  }

  // ---------------------------------------------------------------- image viewer (modal)
  let viewerOpener = null;
  const isViewerOpen = () => !!(els.imgModal && els.imgModal.classList.contains('active'));
  function setZoom(on) {
    els.imgBody.classList.toggle('zoomed', on);
    els.imgZoom.setAttribute('aria-pressed', String(on));
    els.imgZoom.textContent = on ? '🔍 Fit' : '🔍 100%';
  }
  function openImage(src, title, badge, caption, opener) {
    if (!els.imgModal || !/^data:image\/(png|jpeg|bmp);base64,/.test(src)) return false;
    viewerOpener = opener || document.activeElement;
    els.imgImg.src = src;
    els.imgImg.alt = title;
    els.imgTitle.textContent = title;
    els.imgBadge.textContent = badge;
    els.imgCaption.textContent = caption || '';
    setZoom(false);
    els.imgModal.classList.add('active');
    els.imgClose.focus();
    return true;
  }
  function closeImage() {
    if (!isViewerOpen()) return;
    els.imgModal.classList.remove('active');
    els.imgImg.removeAttribute('src');
    syncOverlays();
    if (viewerOpener && viewerOpener.focus) viewerOpener.focus();
  }
  const OFFICE_PREVIEWS = {
    'doc-embedded-injection.docx': 'samples/multimodal/doc-embedded-injection.docx.preview.pdf',
    'deck-card.pptx': 'samples/multimodal/deck-card.pptx.preview.pdf',
    'sheet-pii.xlsx': 'samples/multimodal/sheet-pii.xlsx.preview.pdf',
    'inventory-q4.csv': 'samples/multimodal/inventory-q4.csv.preview.pdf',
  };

  /** Button that opens an attachment: image -> image viewer, PDF or Office preset -> PDF viewer, anything else -> download. */
  function fileAction(f, children, cls) {
    const img = isImage(f.name), pdf = isPdf(f.name), preview = !!f.previewUrl;
    const verb = img ? 'Enlarge' : (pdf || preview) ? 'View' : 'Download';
    const btn = el('button', { type: 'button', class: cls,
      title: img ? 'Click to enlarge' : pdf ? 'Click to view the PDF' : preview ? `Click to preview ${f.name}` : `Click to download ${f.name}`,
      'aria-label': `${verb} ${f.name}`, 'aria-haspopup': (img || pdf || preview) ? 'dialog' : null }, children);
    btn.addEventListener('click', (e) => {
      if (img) openImage(`data:${mimeOf(f.name)};base64,${f.dataBase64}`, f.name, 'Attachment', `${f.name} · ${fmtBytes(f.size)} · sent to Model Armor as byteItem IMAGE`, e.currentTarget);
      else if (pdf) openPdfAttachment(f, e.currentTarget);
      else if (preview) openOfficePreview(f, e.currentTarget);
      else downloadFile(f);
    });
    return btn;
  }

  /** Show a PDF attachment in app.js's PDF viewer (same modal as the sample CVs); fall back to a download. */
  function openPdfAttachment(f, opener) {
    const open = window.demoApp && window.demoApp.openPdfFile;
    const url = open ? blobUrl(f) : null;
    const ok = !!(url && open({ url, title: f.name, badge: 'Attachment',
      note: `${fmtBytes(f.size)} · sent to Model Armor as a byteItem PDF: its text and up to 5 embedded pictures are screened.`, opener }));
    if (!ok) { if (url) URL.revokeObjectURL(url); downloadFile(f); }
  }

  /** Show a pre-rendered PDF preview of a built-in Office/CSV sample, with a Download button for the real file. */
  function openOfficePreview(f, opener) {
    const open = window.demoApp && window.demoApp.openPdfFile;
    const ext = extOf(f.name);
    const kindLabel = { '.docx': 'WORD_DOCUMENT', '.pptx': 'POWERPOINT_DOCUMENT', '.xlsx': 'EXCEL_DOCUMENT', '.csv': 'CSV' }[ext] || 'document';
    const ok = !!(open && open({
      url: f.previewUrl, title: f.name, badge: `Preview · ${ext.slice(1).toUpperCase()}`,
      note: `PDF preview of ${f.name} (${fmtBytes(f.size)}). Apigee sends the raw ${ext} file to Model Armor as byteItem ${kindLabel}.`,
      downloadFn: () => downloadFile(f), downloadLabel: `⬇ Download ${ext}`, opener,
    }));
    if (!ok) downloadFile(f);
  }

  // ---------------------------------------------------------------- "Document vs any modality" explainer (modal)
  let explainOpener = null;
  const isExplainOpen = () => !!(els.exModal && els.exModal.classList.contains('active'));
  function openExplain(from, opener) {
    if (!els.exModal) return false;
    explainOpener = opener || document.activeElement;
    els.exModal.dataset.from = from === 'mm' ? 'mm' : 'doc';   // CSS marks that card "You are here"
    els.exModal.classList.add('active');
    els.exClose.focus();
    return true;
  }
  function closeExplain() {
    if (!isExplainOpen()) return;
    els.exModal.classList.remove('active');
    syncOverlays();
    if (explainOpener && explainOpener.focus) explainOpener.focus();
  }

  // ---------------------------------------------------------------- scenarios
  function renderScenarios() {
    els.list.replaceChildren(...state.scenarios.map((s) => {
      const sub = s.expect === 'allowed' ? 'expect → allowed' : s.expect === 'redacted' ? 'answer → redact / block'
        : s.expect === 'error' ? 'expect → 503 fail closed' : 'expect → blocked';
      const btn = el('button', { type: 'button', class: `preset-btn${s.expect === 'blocked' || s.expect === 'error' ? ' expect-blocked' : ''}${s.id === state.selected ? ' active' : ''}`,
        'data-mm-scenario': s.id, 'aria-pressed': String(s.id === state.selected), title: s.description || s.label },
      [el('span', { class: 'preset-title', text: s.label }), el('span', { class: 'preset-sub', text: sub })]);
      btn.addEventListener('click', () => loadScenario(s.id));
      return btn;
    }));
  }

  /** While sample files load, Run is disabled; a newer load (or a manual file add) makes older loads stale. */
  function setLoading(on) {
    state.loading = on;
    els.run.disabled = on || state.running;
    els.run.setAttribute('aria-busy', String(on));
    if (on) els.files.replaceChildren(el('div', { class: 'mm-files-empty', text: 'Loading the sample files…' }));
  }

  async function loadScenario(id) {
    const s = state.scenarios.find((x) => x.id === id);
    if (!s || state.running) return false;
    const token = ++state.loadToken;
    openSection();
    state.selected = s.id;
    els.prompt.value = s.prompt;
    updateCount();
    setFlow(s.flow || 'chat');
    renderScenarios();
    state.files = [];
    const names = s.files || [];
    if (!names.length) { setLoading(false); renderFiles(); return true; }
    setLoading(true);
    const files = [];
    try {
      for (const name of names) {
        const res = await fetch(`samples/multimodal/${encodeURIComponent(name)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
        const blob = await res.blob();
        const dataBase64 = await toBase64(blob);
        if (token !== state.loadToken) return false;   // another scenario was picked meanwhile
        files.push({ name, size: blob.size, dataBase64, previewUrl: OFFICE_PREVIEWS[name] || null });
      }
    } catch (e) {
      if (token !== state.loadToken) return false;
      toast(`Could not load the sample: ${String(e.message || e).slice(0, 120)}`, 'error');
    }
    state.files = files;
    setLoading(false);
    renderFiles();
    return true;
  }

  // ---------------------------------------------------------------- files
  function renderFiles() {
    if (!state.files.length) {
      els.files.replaceChildren(el('div', { class: 'mm-files-empty', text: 'No attachments. Add up to 3: image (PNG, JPEG, BMP), PDF, Word, Excel, PowerPoint, TXT or CSV, 4 MB each.' }));
      return;
    }
    els.files.replaceChildren(...state.files.map((f, i) => {
      const thumb = isImage(f.name)
        ? fileAction(f, [el('img', { class: 'mm-thumb', alt: '', src: `data:${mimeOf(f.name)};base64,${f.dataBase64}` })], 'mm-thumb-btn')
        : fileAction(f, [el('span', { class: 'mm-thumb mm-thumb-icon', 'aria-hidden': 'true', text: FILE_ICON[extOf(f.name)] || '📃' })], 'mm-thumb-btn mm-download');
      const name = fileAction(f, [el('span', { text: f.name })], `mm-file-name mm-file-link${isImage(f.name) ? '' : ' mm-download'}`);
      const rm = el('button', { type: 'button', class: 'mm-file-rm', 'aria-label': `Remove ${f.name}`, title: 'Remove', text: '×' });
      rm.addEventListener('click', () => { state.files.splice(i, 1); state.selected = null; renderScenarios(); renderFiles(); });
      return el('div', { class: 'mm-file' }, [thumb, name, el('span', { class: 'mm-file-size', text: fmtBytes(f.size) }),
        isImage(f.name) ? null : el('span', { class: 'mm-dl-hint', 'aria-hidden': 'true', text: (isPdf(f.name) || f.previewUrl) ? '👁' : '⬇' }), rm]);
    }));
  }

  async function addFiles(list) {
    if (state.loading) { state.loadToken++; state.files = []; setLoading(false); }   // cancel a sample still loading
    for (const file of Array.from(list || [])) {
      if (state.files.length >= MAX_FILES) { toast(`At most ${MAX_FILES} attachments.`, 'warn'); break; }
      if (!EXT.includes(extOf(file.name))) { toast(`Unsupported type: ${file.name}`, 'warn'); continue; }
      if (!file.size) { toast(`${file.name} is empty.`, 'warn'); continue; }
      if (file.size > MAX_FILE) { toast(`${file.name} is over 4 MB (Model Armor limit).`, 'warn'); continue; }
      state.files.push({ name: file.name, size: file.size, dataBase64: await toBase64(file) });
    }
    state.selected = null;
    renderScenarios();
    renderFiles();
  }

  // ---------------------------------------------------------------- toggles
  /** Radio group state + roving tabindex: only the checked button is in the Tab order. */
  function seg(group, attr, value) {
    group.querySelectorAll('.seg-btn').forEach((b) => {
      const on = b.dataset[attr] === value;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }
  /** Left/Right (and Up/Down) move the selection inside a radio group, as for native radio buttons. */
  function segKeys(group, onPick) {
    group.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step || group.getAttribute('aria-disabled') === 'true') return;
      const btns = Array.from(group.querySelectorAll('.seg-btn'));
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = btns[(i + step + btns.length) % btns.length];
      onPick(next);
      next.focus();
    });
  }
  function setFlow(f) {
    state.flow = f === 'image' ? 'image' : 'chat';
    seg(els.flow, 'flow', state.flow);
    // "Response images" only matters for image answers: dim it for text answers but keep the chosen value.
    const off = state.flow !== 'image';
    els.action.setAttribute('aria-disabled', String(off));
    els.action.classList.toggle('is-dim', off);
    if (els.actionHint) els.actionHint.hidden = !off;
  }
  function setAction(a) { state.action = a === 'block' ? 'block' : 'redact'; seg(els.action, 'action', state.action); }
  function updateCount() { els.count.textContent = `${els.prompt.value.length.toLocaleString()} / ${state.maxPromptChars.toLocaleString()} chars`; }
  /** Typing over a preset prompt makes it a custom run (audited as 'mm-custom'). */
  function onPromptInput() {
    updateCount();
    const s = state.selected && state.scenarios.find((x) => x.id === state.selected);
    if (s && els.prompt.value !== s.prompt) { state.selected = null; renderScenarios(); }
  }

  // ---------------------------------------------------------------- run
  async function run() {
    if (state.running || state.loading) return null;
    openSection();
    const prompt = els.prompt.value.trim();
    if (!prompt) { toast('Enter a prompt or pick a scenario first.', 'warn'); els.prompt.focus(); return null; }
    if (isClientMock()) {
      toast('Mock mode: "Screen any modality" needs the demo server. Start it with DEMO_MOCK=1 for simulated results.', 'warn');
      pill('idle', 'Mock');
      els.body.replaceChildren(banner('error', '🧪', 'Not sent: the page is in offline mock mode',
        'This view only works through the demo server. Run ./run-local.sh (add DEMO_MOCK=1 for simulated gateway results) and open the page from it, without ?mock=1.'));
      return null;
    }
    state.sentFiles = state.files.slice();
    setRunning(true);
    let body = null;
    try {
      const res = await fetch('/api/multimodal', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ flow: state.flow, prompt, imageAction: state.action, scenarioId: state.selected || 'mm-custom',
          files: state.files.map((f) => ({ name: f.name, dataBase64: f.dataBase64 })) }),
      });
      body = await res.json().catch(() => null);
      if (!res.ok || !body || body.httpStatus === undefined) throw new Error((body && body.error) || `HTTP ${res.status}`);
    } catch (e) {
      toast(`Request failed: ${String(e.message || e).slice(0, 160)}`, 'error');
      body = null;
    } finally {
      setRunning(false);
    }
    if (!body) { if (state.last) render(state.last); else renderEmpty(); return null; }
    if (!body.parts || !Array.isArray(body.parts)) body.parts = [];
    state.last = body;
    render(body);
    window.dispatchEvent(new CustomEvent('demo:mmresult', { detail: body }));
    return body;
  }

  function pill(kind, text) {
    els.pill.className = `status-pill status-${kind}`;
    els.pill.textContent = text;
  }

  function setRunning(on) {
    state.running = on;
    els.run.disabled = on || state.loading;
    els.spinner.hidden = !on;
    if (!on) return;
    pill('running', 'Running');
    els.latency.textContent = '…';
    els.rawDetails.hidden = true;
    const n = 1 + state.files.length;
    els.body.replaceChildren(
      banner('running', '⏳', `Screening ${n} part${n > 1 ? 's' : ''}…`,
        `Apigee calls Model Armor once per part${state.flow === 'image' ? ', then Gemini generates an image and Apigee screens it too' : ', then sends the clean request to Gemini'}.`),
      partsTable([{ n: 1, kind: 'text', name: 'Prompt text', verdict: 'running' }].concat(state.files.map((f, i) => ({ n: i + 2, kind: '…', name: f.name, verdict: 'running' })))),
    );
  }

  function banner(kind, icon, title, desc) {
    return el('div', { class: `verdict-banner v-${kind}` }, [el('span', { class: 'verdict-icon', 'aria-hidden': 'true', text: icon }),
      el('div', {}, [el('div', { class: 'verdict-title', text: title }), el('div', { class: 'verdict-desc', text: desc })])]);
  }

  const VPILL = { allowed: ['success', 'Allowed'], blocked: ['blocked', 'Blocked'], incomplete: ['blocked', 'Not screened'], running: ['running', 'Running'], redacted: ['success', 'Redacted'] };
  /** Part name: a link to the attachment (image -> viewer, other file -> download) when it is one of the sent files. */
  function partName(p) {
    const k = KIND[p.kind] || KIND.file;
    const f = typeof p.n === 'number' && p.n > 1 ? state.sentFiles[p.n - 2] : null;
    const label = [el('span', { class: 'mm-kind-icon', 'aria-hidden': 'true', text: k[0] }), el('span', { class: 'mm-part-name', text: p.name || k[1] })];
    return f && f.name === p.name ? fileAction(f, label, `mm-part-link${isImage(f.name) ? '' : ' mm-download'}`) : el('span', { class: 'mm-part-cell', title: p.name || '' }, label);
  }
  function partsTable(parts) {
    const head = el('tr', {}, ['#', 'Part', 'Model Armor saw', 'To Gemini', 'Filters', 'Verdict', 'Time'].map((h) => el('th', { text: h })));
    const rows = parts.map((p) => {
      const k = KIND[p.kind] || KIND.file;
      const filters = arr(p.filters).length
        ? el('div', { class: 'mm-chips' }, arr(p.filters).map((f) => el('span', { class: 'filter-chip hit', text: filterName(f) })))
        : el('span', { class: 'mm-muted', text: p.verdict === 'allowed' || p.verdict === 'redacted' ? 'none matched' : '—' });
      const [pk, pt] = VPILL[p.verdict] || ['idle', p.verdict || '—'];
      const toGemini = p.n === 'A' ? 'n/a (answer)' : p.verdict === 'running' ? '…' : p.forwarded === false ? 'note only (can\'t read this type)' : 'yes';
      return el('tr', { class: `mm-row v-${p.verdict}` }, [
        el('td', { class: 'mono', text: p.n }),
        el('td', {}, [partName(p)]),
        el('td', { class: 'mono mm-saw', text: p.saw || k[2] }),
        el('td', { class: 'mm-muted', text: toGemini }),
        el('td', {}, [filters]),
        el('td', {}, [el('span', { class: `status-pill status-${pk}`, text: pt })]),
        el('td', { class: 'mono', text: fmtMs(p.ms) }),
      ]);
    });
    return el('div', { class: 'table-responsive mm-table-wrap' }, [el('table', { class: 'data-table mm-table' }, [el('thead', {}, [head]), el('tbody', {}, rows)])]);
  }

  function summaryFor(r) {
    const parts = arr(r.parts).filter((p) => p && typeof p === 'object');
    const hit = parts.filter((p) => p.verdict === 'blocked');
    const inc = parts.filter((p) => p.verdict === 'incomplete');
    const img = (r.response && typeof r.response.image === 'object' && r.response.image) || null;
    const txt = (r.response && typeof r.response.text === 'object' && r.response.text) || null;
    const where = (p) => `part ${p.n} (${(KIND[p.kind] || KIND.file)[1]}${p.name && p.n > 1 ? `: ${p.name}` : ''})`;
    if (r.verdict === 'redacted') return ['allowed', '🩹', 'Answer image redacted by Model Armor',
      `Found ${(img && arr(img.findings).length ? arr(img.findings).join(', ') : 'sensitive data')}; Apigee swapped in Model Armor's redacted image. The original never left the gateway.`];
    if (r.verdict === 'allowed') return ['allowed', '✅', 'Every part is clean',
      `${parts.length} prompt part${parts.length > 1 ? 's' : ''} screened, Gemini answered, and the answer was screened too.`];
    if (r.verdict === 'blocked' && r.stage === 'response') {
      const fs = [].concat(arr(img && img.filters), arr(txt && txt.filters)).map(filterName);
      return ['blocked', '⛔', `Answer blocked by Model Armor${fs.length ? `: ${fs.join(', ')}` : ''}`,
        `Gemini answered, but Apigee held the ${img ? 'image' : 'answer'} back${img && arr(img.findings).length ? ` (found ${arr(img.findings).join(', ')})` : ''}. Switch "Response images" to Redact to return a cleaned image instead.`];
    }
    if (r.verdict === 'blocked') return ['blocked', '⛔', `Blocked at the prompt: ${hit.map((p) => `${where(p)} → ${arr(p.filters).map(filterName).join(', ')}`).join('; ') || 'policy match'}`,
      `HTTP ${r.httpStatus} • ${hit.some((p) => p.n > 1) && !hit.some((p) => p.n === 1) ? 'The text itself was clean; the problem was inside the attachment. ' : ''}Gemini was never called.`];
    if (r.verdict === 'incomplete') return ['error', '🚧', `Not fully screened: ${inc.map(where).join(', ') || 'Model Armor could not finish'}`,
      `HTTP ${r.httpStatus} • ${r.error || 'Model Armor skipped the input.'} Apigee fails closed: nothing was sent to Gemini.`];
    return ['error', '❌', 'Request failed', r.error || (r.httpStatus ? `HTTP ${r.httpStatus}` : 'No response from the demo server.')];
  }

  function answerBlock(r) {
    if (!(r.verdict === 'allowed' || r.verdict === 'redacted')) return null;
    const img = r.image && typeof r.image.dataBase64 === 'string' && r.image.dataBase64 && /^image\/(png|jpeg|bmp)$/.test(r.image.mimeType || '') ? r.image : null;
    const ri = (r.response && typeof r.response.image === 'object' && r.response.image) || null;
    const children = [el('div', { class: 'mm-answer-head', text: 'Gemini answer (after Model Armor)' })];
    if (r.text && typeof r.text === 'string') children.push(el('div', { class: 'compare-response', text: r.text }));
    if (img) {
      const src = `data:${img.mimeType};base64,${img.dataBase64}`;
      const redacted = ri && ri.state === 'redacted';
      const caption = redacted ? `Redacted by Model Armor: ${arr(ri.findings).join(', ') || 'sensitive data'}` : 'Screened by Model Armor: nothing found';
      const zoom = el('button', { type: 'button', class: 'mm-answer-zoom', 'aria-label': 'Enlarge the generated image' }, [
        el('img', { class: 'mm-answer-img', alt: redacted ? 'Generated image with sensitive data blacked out by Model Armor' : 'Generated image', src }),
      ]);
      zoom.addEventListener('click', (e) => openImage(src, redacted ? 'Generated image (redacted)' : 'Generated image', redacted ? 'Redacted' : 'Answer', caption, e.currentTarget));
      children.push(el('figure', { class: 'mm-answer-figure' }, [zoom, el('figcaption', { text: caption })]));
    }
    if (!r.text && !img) children.push(el('div', { class: 'mm-muted', text: '(empty answer)' }));
    return el('div', { class: 'mm-answer' }, children);
  }

  function render(r) {
    const [kind, icon, title, desc] = summaryFor(r);
    const PILL = { allowed: ['success', 'Allowed'], redacted: ['success', 'Redacted'], blocked: ['blocked', 'Blocked'], incomplete: ['blocked', '503 Held'], error: ['blocked', 'Error'] };
    pill(...(PILL[r.verdict] || PILL.error));
    els.latency.textContent = fmtMs(r.latencyMs);
    els.endpoint.textContent = `POST ${r.flow === 'image' ? '/model-armor-multimodal/generate-image' : '/model-armor-multimodal/generate'} · REST callout · x-armor-image-action: ${r.imageAction}`;
    const ra = r.response && typeof r.response === 'object' ? r.response : null;
    if (ra && ra.text && typeof ra.text !== 'object') ra.text = null;
    if (ra && ra.image && typeof ra.image !== 'object') ra.image = null;
    const respRows = [];
    if (ra && (ra.text || ra.image)) {
      if (ra.text) respRows.push({ n: 'A', kind: 'text', saw: 'modelResponseData.text', name: 'Answer text', verdict: ra.text.verdict, filters: ra.text.filters });
      if (ra.image) respRows.push({ n: 'A', kind: 'IMAGE', saw: `modelResponseData byteItem IMAGE (${ra.image.action === 'redact' ? 'redact template' : 'inspect template'})`, name: `Generated image (${ra.image.action})`, verdict: ra.image.state === 'redacted' ? 'redacted' : ra.image.verdict, filters: ra.image.filters });
    }
    els.body.replaceChildren(...[
      banner(kind, icon, title, desc),
      el('div', { class: 'mm-section-label', text: 'Prompt: one Model Armor call per part (sanitizeUserPrompt)' }),
      partsTable(arr(r.parts).filter((p) => p && typeof p === 'object')),
      respRows.length ? el('div', { class: 'mm-section-label', text: 'Answer: screened before it reaches the user (sanitizeModelResponse)' }) : null,
      respRows.length ? partsTable(respRows) : null,
      answerBlock(r),
      el('div', { class: 'compare-metrics' }, [
        el('span', {}, ['HTTP ', el('b', { text: r.httpStatus || '--' })]),
        el('span', {}, ['Prompt checks ', el('b', { text: fmtMs(r.armorLatencyMs) })]),
        r.armorResponseLatencyMs ? el('span', {}, ['Answer checks ', el('b', { text: fmtMs(r.armorResponseLatencyMs) })]) : null,
        el('span', {}, ['Total ', el('b', { text: fmtMs(r.latencyMs) })]),
      ]),
      el('p', { class: 'mm-note', text: 'This view uses ServiceCallouts to the Model Armor REST API, one item per call. Apigee\'s built-in SanitizeUserPrompt / SanitizeModelResponse policies screen text only, so they can\'t check images or documents.' }),
    ].filter(Boolean));
    const shortImg = r.image && typeof r.image.dataBase64 === 'string'
      ? Object.assign({}, r.image, { dataBase64: `<base64, ${r.image.dataBase64.length.toLocaleString()} chars>` }) : null;
    els.raw.textContent = JSON.stringify({ requestHeaders: r.requestHeaders, requestBody: r.requestBody, httpStatus: r.httpStatus,
      responseHeaders: r.responseHeaders, armor: { parts: r.parts, response: r.response }, answer: { text: r.text, image: shortImg }, error: r.error || undefined }, null, 2);
    els.rawDetails.hidden = false;
  }

  function renderEmpty() {
    pill('idle', 'Idle');
    els.latency.textContent = '0 ms';
    els.rawDetails.hidden = true;
    els.body.replaceChildren(el('div', { class: 'empty-state compare-empty' }, [
      el('div', { class: 'empty-icon', text: '🖼️' }),
      el('p', { text: 'Pick a scenario, or type a prompt and attach images or documents, then press "Screen every part".' }),
      el('p', { class: 'compare-empty-sub', text: 'Apigee sends each part (the text, every image, every PDF / Word / Excel / PowerPoint file) to Model Armor separately, including images embedded inside documents. With "Image answer", the generated image is screened too: redacted or blocked.' }),
    ]));
  }

  async function loadConfig() {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      const cfg = await res.json();
      const maxChars = Number(cfg && cfg.multimodal && cfg.multimodal.maxPromptChars);
      if (Number.isInteger(maxChars) && maxChars > 0 && maxChars <= 100000) {
        state.maxPromptChars = maxChars;
        els.prompt.maxLength = maxChars;
        updateCount();
      }
      const list = cfg && cfg.multimodal && Array.isArray(cfg.multimodal.scenarios) ? cfg.multimodal.scenarios : null;
      if (list && list.length) state.scenarios = list.map((s) => ({ id: String(s.id).slice(0, 64), label: String(s.label || s.id).slice(0, 60),
        flow: s.flow === 'image' ? 'image' : 'chat', expect: String(s.expect || ''), prompt: String(s.prompt || '').slice(0, state.maxPromptChars),
        files: Array.isArray(s.files) ? s.files.filter((f) => typeof f === 'string' && /^[A-Za-z0-9._-]+$/.test(f)).slice(0, MAX_FILES) : [],
        description: String(s.description || '').slice(0, 240) }));
    } catch { /* keep the fallback list */ }
    renderScenarios();
  }

  function init() {
    Object.assign(els, {
      list: $('mmScenarioList'), prompt: $('mmPrompt'), count: $('mmCharCount'), files: $('mmFiles'), input: $('mmFileInput'),
      add: $('mmAddFileBtn'), flow: $('mmFlowGroup'), action: $('mmActionGroup'), actionHint: $('mmActionHint'), run: $('mmRunBtn'), spinner: $('mmRunSpinner'),
      body: $('mmBody'), pill: $('mmStatusPill'), latency: $('mmLatency'), endpoint: $('mmEndpoint'), raw: $('mmRaw'), rawDetails: $('mmRawDetails'),
      imgModal: $('imgModal'), imgBody: $('imgModalBody'), imgImg: $('imgModalImg'), imgTitle: $('imgModalTitle'), imgBadge: $('imgModalBadge'),
      imgCaption: $('imgModalCaption'), imgZoom: $('imgZoomBtn'), imgClose: $('imgModalCloseBtn'),
      exModal: $('explainModal'), exClose: $('explainModalCloseBtn'),
    });
    if (!els.list || !els.body) return;
    if (els.imgModal) {
      els.imgClose.addEventListener('click', closeImage);
      els.imgModal.addEventListener('click', (e) => { if (e.target === els.imgModal) closeImage(); });
      els.imgZoom.addEventListener('click', () => setZoom(!els.imgBody.classList.contains('zoomed')));
      els.imgImg.addEventListener('click', () => setZoom(!els.imgBody.classList.contains('zoomed')));
    }
    if (els.exModal) {
      document.querySelectorAll('[data-explain]').forEach((b) => b.addEventListener('click', (e) => openExplain(b.dataset.explain, e.currentTarget)));
      els.exClose.addEventListener('click', closeExplain);
      els.exModal.addEventListener('click', (e) => { if (e.target === els.exModal) closeExplain(); });
      els.exModal.querySelectorAll('[data-explain-open]').forEach((b) => b.addEventListener('click', () => {
        explainOpener = null;                       // focus moves to the opened section instead
        closeExplain();
        openSection(b.dataset.explainOpen);
        const t = document.querySelector(`.section-toggle[data-collapse-key="${b.dataset.explainOpen}"]`);
        if (t) t.focus();
      }));
    }
    // Capture phase: Esc closes these modals before app.js handles Esc for its own panels.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (isViewerOpen()) { e.preventDefault(); e.stopImmediatePropagation(); closeImage(); }
      else if (isExplainOpen()) { e.preventDefault(); e.stopImmediatePropagation(); closeExplain(); }
    }, true);
    renderScenarios();
    renderFiles();
    renderEmpty();
    setFlow(state.flow);
    setAction(state.action);
    updateCount();
    els.prompt.addEventListener('input', onPromptInput);
    els.prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } });
    els.add.addEventListener('click', () => els.input.click());
    els.input.addEventListener('change', async () => { await addFiles(els.input.files); els.input.value = ''; });
    els.flow.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => setFlow(b.dataset.flow)));
    els.action.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
      if (els.action.getAttribute('aria-disabled') !== 'true') setAction(b.dataset.action);
    }));
    segKeys(els.flow, (b) => setFlow(b.dataset.flow));
    segKeys(els.action, (b) => setAction(b.dataset.action));
    els.run.addEventListener('click', run);
    loadConfig();
    window.demoMM = { loadScenario, run, setFlow, setAction, openImage, closeImage, openExplain, closeExplain, downloadFile,
      files: () => state.files.slice(), last: () => state.last, isRunning: () => state.running, isLoading: () => state.loading };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
