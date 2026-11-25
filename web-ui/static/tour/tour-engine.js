/**
 * Guided Tour engine - welcome chooser, 4-rectangle spotlight + coachmark, mission stepper,
 * checklist, completion detection and "What just happened?" explainer.
 * Generalised from the Model Armor (SMR) demo engine, which adapted the Coffee Shop demo's tour.
 *
 * Integration contract (provided by app.js; the app never depends on this file):
 *   window.demoApp       { loadScenario(id), run(), isRunning(), isArchOpen(), isAdminOpen(), closeArch(), closeAdmin(), lastResult() }
 *   'demo:ready'         facade available
 *   'demo:runresult'     detail = { ok, httpStatus, latencyMs, tokens, verdict, response, ..., scenarioId }
 * Scenario buttons carry data-scenario="<id>". Run button = #runBtn, result card = #resultCard.
 *
 * Missions are declarative (tour-missions.js). Step schema: see references/tour.md in the skill.
 *
 * Local changes (apigee-model-armor-101: three views, each with its own run button and result card):
 *   1. Per-step `runTarget` / `resultTarget` (default #runBtn / #resultCard), used by the loaded / running phases,
 *      the Run ⚡ button and Run-click detection. The pick phase reacts to clicks on the step's `target`.
 *   2. Also listens to 'demo:uploadresult' and 'demo:mmresult'. Every result is normalised (normalizeRun) to
 *      { ...body, view: 'text'|'doc'|'mm', raw: body, verdict, scenarioId }. Text/doc compare bodies get an
 *      overall verdict: 'blocked' if both modes blocked, 'allowed' if both allowed, 'error' if both failed, else 'mixed'.
 *      mm keeps its own verdict (allowed|blocked|incomplete|redacted|error); its scenario id comes from the
 *      x-demo-scenario request header echoed by the server.
 *   3. demoApp.loadScenario(id) may return a Promise<boolean> (doc samples and mm files are fetched); awaited.
 *      Run ⚡ waits (up to 8 s) for a disabled run button to enable (sample files still loading).
 *   4. Step `targetAll: true` spotlights the union of every element matching `target` (both live diagrams).
 *   5. Esc defers to any open app overlay (demoApp.isOverlayOpen: arch, audit, PDF, image, explainer modals).
 *   6. Generic "loaded" hint copy (the app has three different run buttons, none called Send).
 */
import { MISSIONS, WELCOME, FINISH } from './tour-missions.js';

const SLUG = 'apigee-model-armor-101';
const STORE_KEY = `${SLUG}.tour.v1`;
const HIDE_WELCOME_KEY = `${SLUG}.tour.hideWelcome`;
const SEEN_KEY = `${SLUG}.tour.seenThisSession`;
const RUN_BTN = '#runBtn';
const RESULT_CARD = '#resultCard';
const VERDICT_LABEL = { allowed: 'Allowed', blocked: 'Blocked', error: 'Error', mixed: 'Different verdicts per mode', incomplete: 'Not fully screened (503)', redacted: 'Redacted' };
const LOADED_HINT = 'Loaded. Press <b>Run</b> here or the highlighted button.';

/** Local change 2: one detail shape for text, document and multimodal results. */
function compareVerdict(results) {
  const v = ['native', 'callout'].map((m) => results?.[m]?.verdict);
  if (v.every((x) => x === 'blocked')) return 'blocked';
  if (v.every((x) => x === 'allowed')) return 'allowed';
  if (v.every((x) => !x || x === 'error')) return 'error';
  return 'mixed';
}
function normalizeRun(view, body) {
  if (view === 'mm') {
    const hdr = body.requestHeaders && typeof body.requestHeaders === 'object' ? body.requestHeaders['x-demo-scenario'] : null;
    return { ...body, view, raw: body, verdict: body.verdict || 'error', scenarioId: body.scenarioId || hdr || null };
  }
  return { ...body, view, raw: body, verdict: compareVerdict(body.results), scenarioId: body.scenarioId || null };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const resolve = (v, ...args) => (typeof v === 'function' ? v(...args) : v);
const CLOSE_BTN = '<button type="button" class="tour-close" data-act="dismiss" title="Close (Esc)" aria-label="Close tour">×</button>';
// Local change 7: the "What just happened?" panel is movable (drag the top bar or the ⠿ handle, or arrow keys
// on the handle) and can be minimised; the position is kept for later explainers in the same page view.
const expHead = (kicker, title) => `
  <div class="tour-exp-bar">
    <button type="button" class="tour-exp-grip" aria-label="Move this panel: drag, or use the arrow keys" title="Drag to move">⠿</button>
    <span class="tour-exp-kicker">${kicker}</span>
    <button type="button" class="tour-exp-min" data-act="min" aria-label="Minimise" aria-expanded="true" title="Minimise">–</button>
    <button type="button" class="tour-exp-x" data-act="dismiss" aria-label="Close tour" title="Close (Esc)">×</button>
  </div>
  <h3 class="tour-exp-title">${title}</h3>`;

/**
 * Render authored template HTML without innerHTML: parse with DOMParser, drop active content
 * (script/iframe/object/embed/style, on* handlers, javascript: URLs), then move nodes in.
 * TODO(security): mission copy is trusted, authored HTML. Never interpolate server/user data into
 * it without esc(); dynamic values in this file always go through esc().
 */
function renderHTML(el, html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.body.querySelectorAll('script,iframe,object,embed,style,link,meta').forEach((n) => n.remove());
  doc.body.querySelectorAll('*').forEach((n) => {
    [...n.attributes].forEach((a) => {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
    });
  });
  el.replaceChildren(...doc.body.childNodes);
}

export class GuidedTour {
  constructor(app) {
    this.app = app;
    this.state = this.load();
    this.hint = '';
    this.mode = 'idle'; // idle | step | explainer | finished
    this.phase = 'pick'; // scenario steps: pick -> loaded -> running
    this.lastRun = null;
    this.build();
    this.bind();

    const forced = new URLSearchParams(window.location.search).get('tour');
    let seen = false, hidden = false;
    try { hidden = !!localStorage.getItem(HIDE_WELCOME_KEY); seen = !!sessionStorage.getItem(SEEN_KEY); } catch { /* storage unavailable */ }
    if (forced && forced !== '0') {
      const idx = MISSIONS.findIndex((m) => m.id === forced);
      if (idx >= 0) this.start(idx, !this.state.completed.length); else this.showWelcome();
    } else if (this.state.active) {
      this.showStep(); // resume an in-progress tour after reload
    } else if (forced !== '0' && !hidden && !seen) {
      this.showWelcome();
    }
  }

  // ------------------------------------------------------------------ state
  load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return { active: !!s.active, mission: s.mission || 0, step: s.step || 0, completed: Array.isArray(s.completed) ? s.completed : [] };
    } catch { return { active: false, mission: 0, step: 0, completed: [] }; }
  }
  save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(this.state)); } catch { /* storage unavailable */ } }
  get mission() { return MISSIONS[this.state.mission]; }
  get step() { return this.mission?.steps[this.state.step]; }
  stepTarget(s) { return s?.target || (s?.scenario ? `[data-scenario="${s.scenario}"]` : null); }
  runSel(s) { return s?.runTarget || RUN_BTN; }       // local change 1
  resultSel(s) { return s?.resultTarget || RESULT_CARD; }

  // ------------------------------------------------------------------ DOM
  build() {
    const main = MISSIONS.filter((m) => !m.bonus).length;
    const W = WELCOME || {};
    const root = document.createElement('div');
    root.className = 'tour-root';
    renderHTML(root, `
      <div class="tour-welcome-backdrop" id="tourWelcome" hidden>
        <div class="tour-welcome" role="dialog" aria-modal="true" aria-labelledby="tourWelcomeTitle">
          <div class="tour-welcome-icon">${esc(W.icon || '🗺️')}</div>
          <h2 id="tourWelcomeTitle">${esc(W.title || 'Welcome')}</h2>
          <p class="tour-welcome-sub">${esc(W.subtitle || '')}</p>
          <div class="tour-choice-grid">
            <button type="button" class="tour-choice selected" data-choice="tour">
              <span class="tour-choice-badge">Recommended</span>
              <span class="tour-choice-icon">🗺️</span>
              <span class="tour-choice-title">Guided Tour</span>
              <span class="tour-choice-meta">${main} short missions${MISSIONS.length > main ? ' + bonus' : ''} · about ${esc(W.minutes || 5)} min</span>
              <ul class="tour-choice-list">${(W.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
            </button>
            <button type="button" class="tour-choice" data-choice="explore">
              <span class="tour-choice-icon">🧭</span>
              <span class="tour-choice-title">Explore on my own</span>
              <span class="tour-choice-meta">Go straight to the scenarios. You can start the tour later from the header.</span>
            </button>
          </div>
          <div class="tour-welcome-footer">
            <label class="tour-check"><input type="checkbox" id="tourHideWelcome"> Don't show this again</label>
            <div class="tour-welcome-actions">
              <button type="button" class="tour-btn tour-btn-text" id="tourResumeBtn" hidden></button>
              <button type="button" class="tour-btn tour-btn-text" id="tourSkipBtn">Skip</button>
              <button type="button" class="tour-btn tour-btn-primary" id="tourStartBtn">Start Guided Tour</button>
            </div>
          </div>
        </div>
      </div>
      <div class="tour-dim" id="tourDim" hidden><i></i><i></i><i></i><i></i></div>
      <div class="tour-spotlight" id="tourSpotlight" hidden></div>
      <div class="tour-stepper" id="tourStepper" hidden>
        <button type="button" class="tour-stepper-list" id="tourChecklistBtn" title="Show all missions">☰ Missions</button>
        <div class="tour-dots" id="tourDots"></div>
        <span class="tour-stepper-label" id="tourStepperLabel"></span>
        <button type="button" class="tour-btn tour-btn-text tour-exit" id="tourExitBtn">Exit tour</button>
      </div>
      <div class="tour-checklist" id="tourChecklist" hidden></div>
      <div class="tour-pop" id="tourPop" role="dialog" aria-live="polite" aria-label="Guided tour step" hidden></div>
      <aside class="tour-explainer" id="tourExplainer" aria-live="polite" aria-label="What just happened" hidden></aside>
      <div class="tour-toast" id="tourToast" role="status" hidden></div>
    `);
    document.body.appendChild(root);
    const $ = (id) => root.querySelector(`#${id}`);
    Object.assign(this, {
      root, welcome: $('tourWelcome'), spot: $('tourSpotlight'), dim: $('tourDim'), stepper: $('tourStepper'),
      dots: $('tourDots'), stepperLabel: $('tourStepperLabel'), checklist: $('tourChecklist'),
      pop: $('tourPop'), explainer: $('tourExplainer'), toast: $('tourToast'),
    });
    this.initExplainerDrag();

    let choice = 'tour';
    root.querySelectorAll('.tour-choice').forEach((btn) => btn.addEventListener('click', () => {
      choice = btn.dataset.choice;
      root.querySelectorAll('.tour-choice').forEach((b) => b.classList.toggle('selected', b === btn));
      $('tourStartBtn').textContent = choice === 'tour' ? 'Start Guided Tour' : 'Start exploring';
    }));
    this.closeWelcome = () => {
      try {
        if ($('tourHideWelcome').checked) localStorage.setItem(HIDE_WELCOME_KEY, '1');
        sessionStorage.setItem(SEEN_KEY, '1');
      } catch { /* storage unavailable */ }
      this.welcome.hidden = true;
    };
    $('tourStartBtn').addEventListener('click', () => {
      this.closeWelcome();
      if (choice === 'tour') this.start(0, true); else this.exit(false);
    });
    $('tourSkipBtn').addEventListener('click', () => { this.closeWelcome(); this.exit(false); });
    $('tourResumeBtn').addEventListener('click', () => { this.closeWelcome(); this.start(this.state.mission); });
    $('tourExitBtn').addEventListener('click', () => this.exit(true));
    $('tourChecklistBtn').addEventListener('click', () => this.toggleChecklist());
  }

  /** Local change 7: make the explainer movable (pointer drag on its top bar, arrow keys on ⠿) and minimisable. */
  initExplainerDrag() {
    const el = this.explainer;
    const place = (x, y) => {
      const r = el.getBoundingClientRect();
      const nx = Math.max(8, Math.min(window.innerWidth - r.width - 8, x));
      const ny = Math.max(8, Math.min(window.innerHeight - 56, y));
      Object.assign(el.style, { left: `${nx}px`, top: `${ny}px`, right: 'auto', bottom: 'auto' });
      this.expPos = { x: nx, y: ny };
    };
    this.placeExplainer = () => { if (this.expPos && !el.hidden) place(this.expPos.x, this.expPos.y); };
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !e.target.closest('.tour-exp-bar')) return;
      if (e.target.closest('button') && !e.target.closest('.tour-exp-grip')) return;   // min / close stay clickable
      const r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-dragging');
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => { if (drag && e.pointerId === drag.id) place(e.clientX - drag.dx, e.clientY - drag.dy); });
    const end = (e) => {
      if (!drag) return;
      drag = null;
      el.classList.remove('is-dragging');
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {
      if (!e.target.closest('.tour-exp-grip')) return;
      const n = e.shiftKey ? 40 : 12;
      const d = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] }[e.key];
      if (!d) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      place(r.left + d[0], r.top + d[1]);
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act="min"]');
      if (!b) return;
      const min = el.classList.toggle('is-min');
      b.textContent = min ? '+' : '–';
      b.setAttribute('aria-expanded', String(!min));
      b.setAttribute('aria-label', min ? 'Expand' : 'Minimise');
      b.title = min ? 'Expand' : 'Minimise';
      this.placeExplainer();
    });
    window.addEventListener('resize', () => this.placeExplainer());
  }

  bind() {
    window.addEventListener('demo:runresult', (e) => this.onRunResult(normalizeRun('text', e.detail || {})));
    window.addEventListener('demo:uploadresult', (e) => this.onRunResult(normalizeRun('doc', e.detail || {})));
    window.addEventListener('demo:mmresult', (e) => this.onRunResult(normalizeRun('mm', e.detail || {})));
    document.addEventListener('click', (e) => {
      if (this.mode !== 'step') return;
      const s = this.step;
      if (s?.done?.click && e.target.closest(s.done.click)) { setTimeout(() => this.completeStep(), 300); return; }
      // The user picked the scenario chip / sample themselves.
      if (s?.kind === 'scenario' && this.phase === 'pick' && e.target.closest(this.stepTarget(s))) {
        this.phase = 'loaded';
        this.hint = LOADED_HINT;
        setTimeout(() => { this.renderPop(); this.position(); }, 50);
        return;
      }
      // The user pressed the real Run button during a scenario / run step.
      const runBtn = e.target.closest(this.runSel(s));
      if (runBtn && !runBtn.disabled && (s?.kind === 'scenario' || s?.done?.run || s?.done?.verdict)) {
        this.phase = 'running';
        this.hint = 'Calling Apigee… watch the result panel.';
        this.renderPop();
        setTimeout(() => this.position(), 50);
      }
    }, true);
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!this.checklist.hidden) { this.toggleChecklist(false); e.stopImmediatePropagation(); return; }
      if (!this.welcome.hidden) { this.closeWelcome(); this.exit(false); e.stopImmediatePropagation(); return; }
      // Let the app close its own layer first (local change 5: any overlay, incl. PDF / image / explainer modals).
      if (this.app.isOverlayOpen?.() || this.app.isArchOpen?.() || this.app.isAdminOpen?.()) return;
      if (['step', 'explainer', 'finished'].includes(this.mode)) this.dismiss();
    }, true);

    let raf = 0;
    const reflow = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.position()); };
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);
    // Panels resize (splitter, response text); keep the spotlight glued on.
    setInterval(() => { if (this.mode === 'step') this.position(); }, 300);
  }

  // ------------------------------------------------------------------ helpers
  showToast(html) {
    renderHTML(this.toast, html);
    this.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toast.hidden = true; }, 5000);
  }
  closeOverlays() { this.app.closeArch?.(); this.app.closeAdmin?.(); }

  // ------------------------------------------------------------------ flow
  showWelcome() {
    const resume = this.root.querySelector('#tourResumeBtn');
    const canResume = this.state.completed.length > 0 && this.state.mission < MISSIONS.length;
    resume.hidden = !canResume;
    if (canResume) resume.textContent = `Resume (Mission ${this.state.mission + 1})`;
    this.mode = 'idle';
    this.hideOverlays();
    this.welcome.hidden = false;
    this.root.querySelector('#tourStartBtn').focus();
  }

  /** Public: (re)open the chooser, e.g. from the header button. */
  open() { this.showWelcome(); }

  start(missionIdx = 0, fresh = false) {
    if (fresh) this.state = { active: true, mission: 0, step: 0, completed: [] };
    this.state.active = true;
    this.state.mission = Math.max(0, Math.min(missionIdx, MISSIONS.length - 1));
    this.state.step = 0;
    this.save();
    this.showStep();
  }

  exit(confirmed) {
    this.state.active = false;
    this.save();
    this.mode = 'idle';
    this.hideOverlays();
    if (confirmed) this.showToast('🗺️ Guided Tour paused. Reopen it any time from <b>Guided Tour</b> in the header.');
  }

  hideOverlays() {
    [this.dim, this.spot, this.stepper, this.checklist, this.pop, this.explainer].forEach((el) => { el.hidden = true; });
  }

  showStep() {
    const s = this.step;
    if (!s) return this.finish();
    this.mode = 'step';
    this.hint = '';
    this.phase = 'pick';
    this.explainer.hidden = true;
    if (s.before) s.before(this);
    this.renderStepper();
    this.renderPop();
    const sel = this.stepTarget(s);
    const el = sel && document.querySelector(sel);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    setTimeout(() => this.position(), 350);
  }

  completeStep() {
    if (this.mode !== 'step') return;
    const m = this.mission;
    if (this.state.step < m.steps.length - 1) {
      // Local change 8: a step with its own explainer gets a "What just happened?" panel before the next step.
      if (this.step?.explainer) return this.showExplainer(this.step);
      return this.nextStep();
    }
    if (!this.state.completed.includes(m.id)) this.state.completed.push(m.id);
    this.save();
    this.showExplainer();
  }

  nextStep() {
    this.explainer.hidden = true;
    this.state.step += 1;
    this.save();
    this.showStep();
  }

  nextMission() {
    this.closeOverlays();
    if (this.state.mission >= MISSIONS.length - 1) return this.finish();
    this.state.mission += 1;
    this.state.step = 0;
    this.save();
    this.showStep();
  }

  back() {
    let mi = this.state.mission, si = this.state.step - 1;
    if (si < 0) {
      if (mi === 0) return;
      mi -= 1;
      si = MISSIONS[mi].steps.length - 1;
    }
    this.state.mission = mi;
    this.state.step = si;
    this.save();
    this.showStep();
  }

  finish() {
    this.state.active = false;
    this.state.mission = MISSIONS.length;
    this.save();
    this.hideOverlays();
    this.closeOverlays();
    const done = this.state.completed.length;
    const F = FINISH || {};
    renderHTML(this.explainer, `${expHead('Guided Tour', '🎉 Tour complete')}
      <div class="tour-exp-body">
      <p class="tour-exp-text">You finished <b>${done}</b> of ${MISSIONS.length} missions. ${esc(F.lead || "You've seen Apigee:")}</p>
      <ul class="tour-exp-summary">${(F.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
      </div>
      <div class="tour-exp-actions">
        <button type="button" class="tour-btn tour-btn-text" data-act="restart">Restart tour</button>
        <button type="button" class="tour-btn tour-btn-primary" data-act="close">Continue exploring</button>
      </div>`);
    this.mode = 'finished';
    this.explainer.classList.remove('tour-explainer-low', 'is-min');
    this.explainer.hidden = false;
    this.placeExplainer();
    this.explainer.querySelector('[data-act="restart"]').onclick = () => this.start(0, true);
    this.explainer.querySelectorAll('[data-act="close"], [data-act="dismiss"]').forEach((b) => {
      b.onclick = () => { this.explainer.hidden = true; this.mode = 'idle'; };
    });
  }

  // ------------------------------------------------------------------ events
  onRunResult(detail) {
    this.lastRun = detail;
    if (!this.state.active || this.mode !== 'step') return;
    const s = this.step;
    const wantsVerdict = Array.isArray(s?.done?.verdict);
    const wantsRun = typeof s?.done?.run === 'function';
    if (!wantsVerdict && !wantsRun) return;
    if (s.scenario && detail.scenarioId && detail.scenarioId !== s.scenario && !s.anyScenario) {
      this.phase = 'pick';
      this.hint = `That ran <code>${esc(detail.scenarioId)}</code>. Load the highlighted scenario for this step.`;
      this.renderPop(); this.position();
      return;
    }
    const ok = (wantsVerdict ? s.done.verdict.includes(detail.verdict) : true) && (wantsRun ? !!s.done.run(detail, this) : true);
    if (ok) { setTimeout(() => this.completeStep(), 900); return; }
    this.phase = s.kind === 'scenario' ? 'loaded' : 'pick';
    const got = `<b>${esc(VERDICT_LABEL[detail.verdict] || detail.verdict)}</b>${detail.httpStatus ? ` (HTTP ${esc(detail.httpStatus)})` : ''}`;
    this.hint = (s.onMiss && s.onMiss(detail, this)) || `Got ${got}. Expected something else. Check the server config, then run it again.`;
    this.renderPop();
    this.position();
  }

  // ------------------------------------------------------------------ render
  renderStepper() {
    const main = MISSIONS.filter((m) => !m.bonus);
    renderHTML(this.dots, MISSIONS.map((m, i) => {
      const cls = this.state.completed.includes(m.id) ? 'done' : (i === this.state.mission ? 'current' : '');
      const label = m.bonus ? '★' : i + 1;
      return `${i ? '<span class="tour-dot-line"></span>' : ''}<button type="button" class="tour-dot ${cls} ${m.bonus ? 'bonus' : ''}" data-idx="${i}" title="${esc(m.title)}" aria-label="Mission ${i + 1}: ${esc(m.title)}">${cls === 'done' ? '✓' : label}</button>`;
    }).join(''));
    this.dots.querySelectorAll('.tour-dot').forEach((d) => d.addEventListener('click', () => this.start(Number(d.dataset.idx))));
    const m = this.mission;
    this.stepperLabel.textContent = m?.bonus ? 'Guided Tour · Bonus mission' : `Guided Tour · Mission ${this.state.mission + 1}/${main.length}`;
    const header = document.querySelector('header');
    if (header) this.stepper.style.top = `${Math.round(header.getBoundingClientRect().bottom) + 6}px`;
    this.stepper.hidden = false;
  }

  toggleChecklist(force) {
    const show = force ?? this.checklist.hidden;
    if (!show) { this.checklist.hidden = true; return; }
    const doneCount = this.state.completed.length;
    const pct = Math.round((doneCount / MISSIONS.length) * 100);
    renderHTML(this.checklist, `
      <div class="tour-cl-head">
        <div class="tour-ring" style="--pct:${pct}"><span>${doneCount}/${MISSIONS.length}</span></div>
        <div><div class="tour-cl-title">Mission checklist</div><div class="tour-cl-sub">Click a mission to jump to it</div></div>
      </div>
      <ol class="tour-cl-list">
        ${MISSIONS.map((m, i) => {
          const st = this.state.completed.includes(m.id) ? 'done' : (i === this.state.mission ? 'current' : 'todo');
          return `<li class="${st}" data-idx="${i}" tabindex="0"><span class="tour-cl-mark">${st === 'done' ? '✓' : (m.bonus ? '★' : i + 1)}</span>
            <span class="tour-cl-name">${esc(m.title)}</span><span class="tour-cl-badge">${esc(m.badge || '')}</span></li>`;
        }).join('')}
      </ol>`);
    this.checklist.querySelectorAll('li').forEach((li) => {
      const go = () => { this.toggleChecklist(false); this.start(Number(li.dataset.idx)); };
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    this.checklist.hidden = false;
  }

  renderPop() {
    const s = this.step, m = this.mission;
    if (!s) return;
    const multi = m.steps.length > 1;
    const kicker = `${m.bonus ? 'BONUS MISSION' : `MISSION ${this.state.mission + 1} OF ${MISSIONS.filter((x) => !x.bonus).length}`}${multi ? ` · STEP ${this.state.step + 1}/${m.steps.length}` : ''}`;

    let primary = '';
    if (this.phase === 'running' && (s.kind === 'scenario' || s.done?.run || s.done?.verdict)) primary = '<button type="button" class="tour-btn tour-btn-primary" disabled>Running…</button>';
    else if (s.kind === 'scenario' && this.phase === 'loaded') primary = '<button type="button" class="tour-btn tour-btn-primary" data-act="run">Run ⚡</button>';
    else if (s.kind === 'scenario') primary = '<button type="button" class="tour-btn tour-btn-primary" data-act="load">Load this scenario</button>';
    else if (s.action) primary = `<button type="button" class="tour-btn tour-btn-primary" data-act="action">${esc(resolve(s.action.label, this))}</button>`;

    renderHTML(this.pop, `${CLOSE_BTN}
      <span class="tour-pop-arrow"></span>
      <div class="tour-pop-kicker">${kicker}</div>
      <h3 class="tour-pop-title">${esc(resolve(s.title, this))}</h3>
      <div class="tour-pop-body">${resolve(s.body, this) || ''}</div>
      ${s.expect ? `<div class="tour-expect">Expected: <b>${esc(resolve(s.expect, this))}</b></div>` : ''}
      ${this.hint ? `<div class="tour-hint">${this.hint}</div>` : ''}
      <div class="tour-pop-actions">
        <button type="button" class="tour-btn tour-btn-text" data-act="back" ${this.state.mission === 0 && this.state.step === 0 ? 'disabled' : ''}>Back</button>
        <button type="button" class="tour-btn tour-btn-text" data-act="skip">Skip</button>
        ${primary}
      </div>`);
    this.pop.hidden = false;

    const on = (act, fn) => { const b = this.pop.querySelector(`[data-act="${act}"]`); if (b) b.onclick = fn; };
    on('load', async () => {
      const step = s;
      this.hint = 'Loading…';
      this.renderPop();
      let ok = false;
      try { ok = await this.app.loadScenario(s.scenario); } catch { ok = false; } // local change 3
      if (this.step !== step || this.mode !== 'step') return;
      if (!ok) { this.hint = `Could not load <code>${esc(s.scenario)}</code>. Is a run still in progress?`; this.renderPop(); return; }
      this.phase = 'loaded';
      this.hint = LOADED_HINT;
      this.renderPop(); this.position();
    });
    on('run', async () => {
      const sel = this.runSel(s);
      for (let i = 0; i < 40 && document.querySelector(sel)?.disabled; i++) await new Promise((r) => setTimeout(r, 200));
      document.querySelector(sel)?.click();
    });
    on('action', () => s.action.run(this));
    on('skip', () => this.completeStep());
    on('back', () => this.back());
    on('dismiss', () => this.dismiss());
  }

  /** "What just happened?" after a mission, or (local change 8) after a step that defines its own explainer. */
  showExplainer(stepObj = null) {
    const m = this.mission, ex = resolve(stepObj ? stepObj.explainer : m.explainer, this) || {};
    this.mode = 'explainer';
    this.expForStep = !!stepObj;
    this.spot.hidden = true; this.dim.hidden = true;
    this.pop.hidden = true;
    this.renderStepper();
    const next = MISSIONS[this.state.mission + 1];
    const nextStep = stepObj ? m.steps[this.state.step + 1] : null;
    const icon = { ok: '✓', fail: '✕', skip: '–', miss: '!' };
    const ho = ex.handoff;
    const handoff = ho ? `
      <div class="tour-handoff">
        <div class="tour-handoff-row">
          <span class="tour-handoff-layer missed"><span class="tour-handoff-x">✕</span>${esc(ho.missed)}<small>missed it</small></span>
          <span class="tour-handoff-arrow" aria-hidden="true">→</span>
          <span class="tour-handoff-layer caught"><span class="tour-handoff-x">🛡</span>${esc(ho.caught)}<small>blocked it</small></span>
        </div>
        <p class="tour-handoff-text">${esc(ho.text)}</p>
      </div>` : '';
    const done = stepObj
      ? `<div class="tour-exp-done tour-exp-done-step">Step ${this.state.step + 1} of ${m.steps.length} done</div>`
      : '<div class="tour-exp-done">Mission complete!</div>';
    const actions = stepObj
      ? `<button type="button" class="tour-btn tour-btn-text" data-act="later">Pause</button>
         <button type="button" class="tour-btn tour-btn-primary" data-act="nextstep">Next step: ${esc(resolve(nextStep?.title, this) || 'continue')}</button>`
      : `${next?.bonus ? '<button type="button" class="tour-btn tour-btn-text" data-act="finish">Finish tour</button>' : '<button type="button" class="tour-btn tour-btn-text" data-act="later">Pause</button>'}
         <button type="button" class="tour-btn tour-btn-primary" data-act="next">${next ? `${next.bonus ? 'Bonus' : 'Next'}: ${esc(next.title.replace(/^Bonus:\s*/, ''))}` : 'Finish tour'}</button>`;
    renderHTML(this.explainer, `${expHead('What just happened?', esc(ex.title || m.title))}
      <div class="tour-exp-body">
      ${handoff}
      <ol class="tour-flow">
        ${(ex.flow || []).map((f, i) => `<li class="${esc(f.state || 'ok')}"><span class="tour-flow-n">${icon[f.state] || i + 1}</span><span class="tour-flow-text">${esc(f.text)}</span>${f.tag ? `<span class="tour-flow-tag">${esc(f.tag)}</span>` : ''}</li>`).join('')}
      </ol>
      ${ex.note ? `<p class="tour-exp-note">${ex.note}</p>` : ''}
      ${done}
      </div>
      <div class="tour-exp-actions">${actions}</div>`);
    this.explainer.classList.remove('is-min');
    this.explainer.hidden = false;
    this.explainer.classList.toggle('tour-explainer-low', !!this.app.isArchOpen?.());
    this.placeExplainer();
    const on = (act, fn) => { const b = this.explainer.querySelector(`[data-act="${act}"]`); if (b) b.onclick = fn; };
    on('next', () => { this.explainer.hidden = true; this.nextMission(); });
    on('nextstep', () => this.nextStep());
    on('finish', () => this.finish());
    on('later', () => this.dismiss());
    on('dismiss', () => this.dismiss());
    this.explainer.querySelector('[data-act="next"], [data-act="nextstep"]')?.focus();
  }

  /** Close the current tour pop-up (× or Esc). Progress is kept for Resume. */
  dismiss() {
    if (this.mode === 'step') return this.exit(true);
    if (this.mode === 'explainer') {
      if (this.expForStep) {
        this.state.step += 1;   // resume at the next step of this mission
      } else {
        this.state.mission = Math.min(this.state.mission + 1, MISSIONS.length - 1);
        this.state.step = 0;
      }
      return this.exit(true);
    }
    if (this.mode === 'finished') { this.explainer.hidden = true; this.mode = 'idle'; }
  }

  // ------------------------------------------------------------------ layout
  position() {
    if (this.mode !== 'step' || this.pop.hidden) return;
    const s = this.step;
    const isVisible = (rect) => rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0
      && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    // Scenario steps: chip -> Run button (loaded) -> result card (running). No dimming once the
    // user is expected to act or watch, so the UI stays fully usable.
    let sel = this.stepTarget(s);
    let shade = s?.shade !== false;
    let all = !!s?.targetAll;
    if (s?.kind === 'scenario' && this.phase === 'loaded') { sel = this.runSel(s); shade = false; all = false; }
    if (this.phase === 'running') { sel = this.resultSel(s); shade = false; all = false; }
    // Local change 4: union of every match when targetAll is set.
    const rects = !sel ? [] : (all ? [...document.querySelectorAll(sel)] : [document.querySelector(sel)])
      .filter(Boolean).map((n) => n.getBoundingClientRect()).filter(isVisible);
    const r = rects.length ? rects.reduce((u, x) => {
      const left = Math.min(u.left, x.left), top = Math.min(u.top, x.top), right = Math.max(u.right, x.right), bottom = Math.max(u.bottom, x.bottom);
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }) : null;
    const visible = isVisible(r);

    const pw = this.pop.offsetWidth, ph = this.pop.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 16, pad = 12;
    this.pop.classList.remove('place-right', 'place-left', 'place-bottom', 'place-top', 'place-center');

    if (!visible) {
      this.spot.hidden = true; this.dim.hidden = true;
      this.pop.classList.add('place-center');
      this.pop.style.left = `${(vw - pw) / 2}px`;
      this.pop.style.top = `${Math.max(80, (vh - ph) / 2)}px`;
      return;
    }

    const p = 6;
    // Clip the highlight to the viewport (the result card can be taller than the screen).
    const top0 = Math.max(4, r.top - p), bot0 = Math.min(vh - 4, r.bottom + p);
    Object.assign(this.spot.style, { left: `${r.left - p}px`, top: `${top0}px`, width: `${r.width + p * 2}px`, height: `${bot0 - top0}px` });
    this.spot.hidden = false;
    if (!shade) {
      this.dim.hidden = true;
    } else {
      // 4 rectangles around the hole (pointer-events:none) so the real UI stays clickable.
      const t = Math.max(0, r.top - p), b = Math.min(vh, r.bottom + p);
      const l = Math.max(0, r.left - p), rt = Math.min(vw, r.right + p);
      const [dTop, dBottom, dLeft, dRight] = this.dim.children;
      Object.assign(dTop.style, { left: '0px', top: '0px', width: `${vw}px`, height: `${t}px` });
      Object.assign(dBottom.style, { left: '0px', top: `${b}px`, width: `${vw}px`, height: `${Math.max(0, vh - b)}px` });
      Object.assign(dLeft.style, { left: '0px', top: `${t}px`, width: `${l}px`, height: `${Math.max(0, b - t)}px` });
      Object.assign(dRight.style, { left: `${rt}px`, top: `${t}px`, width: `${Math.max(0, vw - rt)}px`, height: `${Math.max(0, b - t)}px` });
      this.dim.hidden = false;
    }

    const a = { left: r.left, right: r.right, top: Math.max(r.top, 0), bottom: Math.min(r.bottom, vh) };
    a.height = a.bottom - a.top; a.width = r.width;
    let place, left, top;
    if (a.right + gap + pw < vw - pad) { place = 'right'; left = a.right + gap; top = a.top + a.height / 2 - ph / 2; }
    else if (a.left - gap - pw > pad) { place = 'left'; left = a.left - gap - pw; top = a.top + a.height / 2 - ph / 2; }
    else if (a.bottom + gap + ph < vh - pad) { place = 'bottom'; top = a.bottom + gap; left = a.left + a.width / 2 - pw / 2; }
    else { place = 'top'; top = a.top - gap - ph; left = a.left + a.width / 2 - pw / 2; }

    const minTop = this.stepper.hidden ? pad : Math.max(pad, this.stepper.getBoundingClientRect().bottom + 8);
    left = Math.max(pad, Math.min(left, vw - pw - pad));
    top = Math.max(minTop, Math.min(top, vh - ph - pad));
    this.pop.classList.add(`place-${place}`);
    this.pop.style.left = `${left}px`;
    this.pop.style.top = `${top}px`;
    const arrow = this.pop.querySelector('.tour-pop-arrow');
    if (arrow) {
      if (place === 'right' || place === 'left') {
        arrow.style.top = `${Math.max(16, Math.min(ph - 16, a.top + a.height / 2 - top))}px`; arrow.style.left = '';
      } else {
        arrow.style.left = `${Math.max(16, Math.min(pw - 16, a.left + a.width / 2 - left))}px`; arrow.style.top = '';
      }
    }
  }
}

// Bootstrap once app.js has exposed window.demoApp (module scripts run before DOMContentLoaded).
function boot() {
  if (window.demoTour || !window.demoApp || !MISSIONS.length) return;
  window.demoTour = new GuidedTour(window.demoApp);
  document.getElementById('headerTourBtn')?.addEventListener('click', () => window.demoTour.open());
}
if (window.demoApp) boot(); else window.addEventListener('demo:ready', boot, { once: true });
