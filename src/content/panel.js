// The floating button + panel shown on H5P pages (Shadow DOM, so the page's CSS can't touch it).
// Content-script world: shares globals with collect.js and main.js; icons come from shared/icons.js.

let hostEl = null;
let ui = null;
let teardown = null; // removes the document/window listeners added while the button is mounted

// Where the floating button lives: which edge, and how far down (0 = top, 1 = bottom)
let fabPos = { side: 'right', y: 0.85 };

const FAB = 46;   // button size
const EDGE = 12;  // gap between the button and the screen edge

/* ---------------- small helpers ---------------- */

// Returns a clean { side, y } or null if the stored value is unusable
function normalizeFabPos(p) {
  if (p && (p.side === 'left' || p.side === 'right') && typeof p.y === 'number') {
    return { side: p.side, y: H5PUtils.clamp(p.y, 0, 1) };
  }
  return null;
}

// "Not extracted: Video ×2, Accordion" or '' when everything was understood
function unknownNote(data) {
  if (!data.unknown || !data.unknown.length) return '';
  return (
    'Not extracted: ' +
    data.unknown
      .map((u) => u.library.replace(/^H5P\./, '') + (u.count > 1 ? ' ×' + u.count : ''))
      .join(', ')
  );
}

function safeSend(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (e) {
    // extension was reloaded; this page needs a refresh
  }
}

function viewport() {
  const d = document.documentElement;
  return { w: d.clientWidth, h: d.clientHeight };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// @font-face has to live in the page's own document (not inside the shadow root)
function ensureFont() {
  if (document.getElementById('h5px-font')) return;
  try {
    const s = document.createElement('style');
    s.id = 'h5px-font';
    s.textContent =
      "@font-face{font-family:'H5PX Space Grotesk';src:url('" +
      chrome.runtime.getURL('assets/fonts/SpaceGrotesk.woff2') +
      "') format('woff2');font-weight:300 700;font-display:swap;}";
    document.head.appendChild(s);
  } catch (e) {}
}

const CARD_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }

/* ---- floating button ---- */
.fab {
  position: fixed; z-index: 2147483647; width: 46px; height: 46px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  color: #000000; background: #22C801; border: 0; border-radius: 50%;
  box-shadow: 0 6px 20px rgba(0,0,0,.45); cursor: grab; touch-action: none; user-select: none;
  transition: left .25s cubic-bezier(0.22, 1, 0.36, 1), top .25s cubic-bezier(0.22, 1, 0.36, 1), background .15s ease, transform .15s ease;
}
.fab:hover { background: #1CA601; transform: scale(1.06); }
.fab.dragging { cursor: grabbing; transition: none; transform: scale(1.1); }
.fab:focus-visible { outline: 2px solid #FFFFFF; outline-offset: 2px; }
.fab .badge {
  position: absolute; top: -3px; right: -3px; width: 18px; height: 18px;
  display: none; align-items: center; justify-content: center;
  color: #22C801; background: #1A1A1A; border: 1px solid #22C801; border-radius: 50%;
}
.fab .badge.on { display: flex; }

/* ---- panel ---- */
.panel {
  position: fixed; z-index: 2147483646; width: 330px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow-y: auto;
  background: #1A1A1A; color: #FFFFFF; border: 1px solid #2A2A2A; border-radius: 14px;
  padding: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.55);
  font-family: 'H5PX Space Grotesk', 'Space Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif;
  visibility: hidden; opacity: 0; transform: translateY(6px) scale(.98); pointer-events: none;
  transition: opacity .18s ease, transform .18s ease, visibility 0s linear .18s;
}
.panel.open { visibility: visible; opacity: 1; transform: none; pointer-events: auto; transition: opacity .18s ease, transform .18s ease; }
@media (prefers-reduced-motion: reduce) {
  .fab, .panel, .panel.open { transition: none; }
  .fab:hover, .fab.dragging { transform: none; }
}
.ico { display: inline-flex; flex-shrink: 0; }
.head { display: flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #22C801; flex-shrink: 0; }
.kicker { font-size: 12px; color: #8A8A8A; flex: 1; letter-spacing: .02em; }
.close { display: inline-flex; background: none; border: 0; color: #8A8A8A; cursor: pointer; padding: 3px; border-radius: 6px; }
.close:hover { color: #FFFFFF; background: #202020; }
.title { margin: 10px 0 2px; font-size: 15px; font-weight: 600; line-height: 1.3; }
.sub { margin: 0; font-size: 12px; color: #8A8A8A; }
.warn { margin: 8px 0 0; font-size: 12px; line-height: 1.35; color: #F0B429; }
.errbar { margin: 10px 0 0; padding: 8px 10px; font-size: 12px; line-height: 1.35; color: #EF4444; background: rgba(239,68,68,.08); border: 1px solid #EF4444; border-radius: 8px; }
.row { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 10px 12px; background: #121212; border: 1px solid #2A2A2A; border-radius: 10px; }
.row:hover { background: #202020; }
.ib { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex-shrink: 0; color: #22C801; background: #1A1A1A; border: 1px solid #2A2A2A; border-radius: 8px; }
.rtext { flex: 1; min-width: 0; }
.label { font-size: 13px; font-weight: 600; }
.meta { font-size: 12px; color: #8A8A8A; margin-top: 2px; }
.meta.err { color: #EF4444; }
.bar { height: 3px; margin-top: 6px; background: #2A2A2A; border-radius: 2px; overflow: hidden; }
.fill { height: 100%; width: 0; background: #22C801; transition: width .2s ease; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font: inherit; font-size: 13px; font-weight: 600; color: #FFFFFF; background: transparent; border: 1px solid #2A2A2A; border-radius: 8px; padding: 7px 10px; cursor: pointer; white-space: nowrap; }
.btn:hover { background: #202020; }
.btn:focus-visible, .close:focus-visible { outline: 2px solid #22C801; outline-offset: 2px; }
.btn:disabled { color: #4A4A4A; cursor: not-allowed; }
.btn.busy { color: #8A8A8A; }
.primary { width: 100%; margin-top: 12px; padding: 10px 12px; color: #000000; background: #22C801; border-color: #22C801; }
.primary:hover { background: #1CA601; border-color: #1CA601; }
.primary:disabled { background: #2A2A2A; border-color: #2A2A2A; color: #4A4A4A; }
.actions { display: flex; gap: 8px; margin-top: 8px; }
.actions .grow { flex: 1; }
.inlib { color: #22C801; border-color: #22C801; }
`;

/* ---------------- show / hide ---------------- */

function hideCard() {
  if (teardown) teardown();
  teardown = null;
  if (hostEl) hostEl.remove();
  hostEl = null;
  ui = null;
}

function showCard(data) {
  if (hostEl) return;

  const slideCount = H5PUtils.dedupeConsecutive(data.images || []).length;
  const hasText = data.notes.length + data.quiz.length > 0;
  const hasSlides = slideCount > 0;
  if (!hasText && !hasSlides) return;

  ensureFont();

  hostEl = document.createElement('div');
  hostEl.id = 'h5p-extractor-host';
  const root = hostEl.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CARD_CSS;
  root.appendChild(style);

  /* ----- the floating button ----- */
  const fab = el('button', 'fab');
  fab.setAttribute('aria-label', 'H5P Weekly Extractor');
  fab.setAttribute('aria-expanded', 'false');
  fab.title = 'H5P Weekly Extractor (drag to move)';
  fab.appendChild(icon('download', 20));
  const badge = el('span', 'badge');
  badge.appendChild(icon('check', 10));
  fab.appendChild(badge);

  /* ----- the panel ----- */
  const panel = el('div', 'panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'H5P Weekly Extractor');

  const head = el('div', 'head');
  const close = el('button', 'close');
  close.setAttribute('aria-label', 'Close');
  close.appendChild(icon('x', 16));
  head.append(el('span', 'dot'), el('span', 'kicker', 'H5P content detected'), close);
  panel.appendChild(head);

  const weekTitle = data.weekLabel ? data.weekLabel.replace(/:\s*/, ' – ') : data.title;
  const partText = data.partTotal > 1 ? ` · Part ${data.partIndex} of ${data.partTotal}` : '';
  panel.appendChild(el('p', 'title', weekTitle || 'H5P content'));
  panel.appendChild(el('p', 'sub', (data.subject || '') + partText));

  const warnText = unknownNote(data);
  if (warnText) {
    const warn = el('p', 'warn', warnText);
    warn.title = 'These H5P content types were found on this page but this extension does not read them yet.';
    panel.appendChild(warn);
  }

  // Red error banner (hidden until something fails)
  const errBar = el('div', 'errbar');
  errBar.setAttribute('role', 'alert');
  errBar.hidden = true;
  panel.appendChild(errBar);

  function showErr(text) {
    errBar.textContent = text;
    errBar.hidden = false;
    openPanel(); // make sure the person actually sees it
  }
  function clearErr() {
    errBar.hidden = true;
  }

  let txtBtn = null;
  let pdfBtn = null;
  let pdfMeta = null;
  let pdfFill = null;
  let pdfBar = null;

  if (hasText) {
    const row = el('div', 'row');
    const ib = el('span', 'ib');
    ib.appendChild(icon('file', 16));
    const text = el('div', 'rtext');
    text.append(
      el('div', 'label', 'Notes (.txt)'),
      el('div', 'meta', `${data.notes.length} notes · ${H5PUtils.questionTotal(data)} questions`)
    );
    txtBtn = el('button', 'btn');
    setBtn(txtBtn, 'download', 'Download');
    txtBtn.addEventListener('click', () => {
      clearErr();
      txtBtn.disabled = true;
      safeSend({ action: 'buildAndDownload', kind: 'txt', key: data.key, data });
    });
    row.append(ib, text, txtBtn);
    panel.appendChild(row);
  }

  if (hasSlides) {
    const row = el('div', 'row');
    const ib = el('span', 'ib');
    ib.appendChild(icon('slides', 16));
    const text = el('div', 'rtext');
    pdfMeta = el('div', 'meta', `${slideCount} slides`);
    pdfBar = el('div', 'bar');
    pdfFill = el('div', 'fill');
    pdfBar.appendChild(pdfFill);
    text.append(el('div', 'label', 'Slides (.pdf)'), pdfMeta, pdfBar);
    pdfBtn = el('button', 'btn busy');
    setBtn(pdfBtn, null, 'Preparing…');
    pdfBtn.addEventListener('click', () => {
      clearErr();
      pdfBtn.disabled = true;
      safeSend({ action: 'buildAndDownload', kind: 'pdf', key: data.key, data });
    });
    row.append(ib, text, pdfBtn);
    panel.appendChild(row);
  }

  const bothBtn = el('button', 'btn primary');
  setBtn(bothBtn, 'download', 'Download both');
  if (hasText && hasSlides) {
    bothBtn.addEventListener('click', () => {
      clearErr();
      bothBtn.disabled = true;
      if (txtBtn) txtBtn.disabled = true;
      if (pdfBtn) pdfBtn.disabled = true;
      safeSend({ action: 'buildAndDownload', kind: 'both', key: data.key, data });
    });
    panel.appendChild(bothBtn);
  }

  const actions = el('div', 'actions');
  const libBtn = el('button', 'btn grow');
  setBtn(libBtn, 'plus', 'Add to library');
  libBtn.addEventListener('click', () => {
    clearErr();
    libBtn.disabled = true;
    setBtn(libBtn, null, 'Saving…');
    safeSend({ action: 'library-add', key: data.key, data });
  });
  const openBtn = el('button', 'btn');
  openBtn.title = 'Open your library';
  setBtn(openBtn, 'library', '');
  openBtn.addEventListener('click', () => safeSend({ action: 'open-library' }));
  actions.append(libBtn, openBtn);
  panel.appendChild(actions);

  root.append(fab, panel);
  document.body.appendChild(hostEl);

  /* ----- open / close / position ----- */
  let open = false;
  let curLeft = 0;
  let curTop = 0;

  function placeFab() {
    const { w, h } = viewport();
    curLeft = fabPos.side === 'left' ? EDGE : w - FAB - EDGE;
    curTop = H5PUtils.clamp(fabPos.y * (h - FAB), EDGE, Math.max(EDGE, h - FAB - EDGE));
    fab.style.left = curLeft + 'px';
    fab.style.top = curTop + 'px';
  }

  function positionPanel() {
    const { w, h } = viewport();
    const f = fab.getBoundingClientRect();
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    let left = fabPos.side === 'right' ? f.right - pw : f.left;
    left = H5PUtils.clamp(left, 8, Math.max(8, w - pw - 8));
    let top = f.top - ph - 10; // above the button if it fits...
    if (top < 8) top = Math.min(f.bottom + 10, h - ph - 8); // ...otherwise below
    top = Math.max(8, top);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function openPanel() {
    if (open) return;
    open = true;
    panel.classList.add('open');
    fab.setAttribute('aria-expanded', 'true');
    positionPanel();
  }

  function closePanel() {
    if (!open) return;
    open = false;
    panel.classList.remove('open');
    fab.setAttribute('aria-expanded', 'false');
  }

  function togglePanel() {
    if (open) closePanel(); else openPanel();
  }

  close.addEventListener('click', () => { closePanel(); fab.focus(); });

  /* ----- dragging ----- */
  let drag = null;

  function saveFabPos() {
    try { chrome.storage.sync.set({ fabPos }); } catch (e) {}
  }

  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: curLeft, ot: curTop, moved: false };
    try { fab.setPointerCapture(e.pointerId); } catch (err) {}
  });

  fab.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 5) return; // still a click, not a drag
      drag.moved = true;
      closePanel();
      fab.classList.add('dragging');
    }
    const { w, h } = viewport();
    curLeft = H5PUtils.clamp(drag.ol + dx, 0, w - FAB);
    curTop = H5PUtils.clamp(drag.ot + dy, 0, h - FAB);
    fab.style.left = curLeft + 'px';
    fab.style.top = curTop + 'px';
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    try { fab.releasePointerCapture(e.pointerId); } catch (err) {}
    fab.classList.remove('dragging');
    if (d.moved) {
      // snap to the nearest side edge and remember it
      const { w, h } = viewport();
      fabPos = {
        side: curLeft + FAB / 2 < w / 2 ? 'left' : 'right',
        y: H5PUtils.clamp(curTop / (h - FAB), 0, 1),
      };
      placeFab();
      saveFabPos();
    } else if (e.type === 'pointerup') {
      togglePanel();
    }
  }
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);
  // keyboard activation (Enter / Space) arrives as a click with detail 0
  fab.addEventListener('click', (e) => { if (e.detail === 0) togglePanel(); });

  /* ----- page-level listeners (removed again in hideCard) ----- */
  const onDocDown = (e) => {
    if (open && !e.composedPath().includes(hostEl)) closePanel();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && open) { closePanel(); fab.focus(); }
  };
  const onBlur = () => closePanel(); // clicking into the H5P iframe blurs the page
  const onResize = () => { placeFab(); if (open) positionPanel(); };
  // Hide while a video / H5P is fullscreen so we never sit on top of it
  const onFullscreen = () => {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs) closePanel();
    hostEl.style.display = fs ? 'none' : '';
  };

  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('webkitfullscreenchange', onFullscreen);
  teardown = () => {
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('fullscreenchange', onFullscreen);
    document.removeEventListener('webkitfullscreenchange', onFullscreen);
  };

  placeFab();
  onFullscreen();

  /* ----- status updates ----- */
  function flashSaved(btn) {
    if (!btn) return;
    setBtn(btn, 'check', 'Saved');
    btn.disabled = false;
    setTimeout(() => setBtn(btn, 'download', 'Download'), 2500);
  }

  async function refreshLib() {
    try {
      const { library = {} } = await chrome.storage.local.get('library');
      const saved = !!library[data.id];
      const count = Object.keys(library).length;
      setBtn(libBtn, saved ? 'check' : 'plus', saved ? 'In library' : 'Add to library');
      libBtn.title = saved ? 'Click to update this week in your library' : '';
      libBtn.classList.toggle('inlib', saved);
      libBtn.disabled = false;
      setBtn(openBtn, 'library', count ? String(count) : '');
      badge.classList.toggle('on', saved);
    } catch (e) {}
  }

  ui = {
    refreshLib,
    placeFab() {
      placeFab();
      if (open) positionPanel();
    },
    update(msg) {
      if (msg.kind === 'pdf-progress' && pdfBtn) {
        if (msg.state === 'building') {
          const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
          pdfFill.style.width = pct + '%';
          setBtn(pdfBtn, null, `Preparing ${msg.done}/${msg.total}`);
          pdfBtn.classList.add('busy');
        } else if (msg.state === 'ready') {
          pdfBar.style.display = 'none';
          setBtn(pdfBtn, 'download', 'Download');
          pdfBtn.classList.remove('busy');
        } else if (msg.state === 'error') {
          pdfBar.style.display = 'none';
          pdfMeta.textContent = "Couldn't build the PDF";
          pdfMeta.classList.add('err');
          setBtn(pdfBtn, null, 'Retry');
          pdfBtn.classList.remove('busy');
          pdfBtn.disabled = false;
        }
      }
      if (msg.kind === 'saved') {
        if (msg.which === 'txt') flashSaved(txtBtn);
        if (msg.which === 'pdf') flashSaved(pdfBtn);
        if (msg.which === 'error') {
          [txtBtn, pdfBtn].forEach((b) => { if (b) b.disabled = false; });
          showErr(msg.error ? 'Download failed: ' + msg.error : 'Download failed. Please try again.');
        }
        bothBtn.disabled = false;
      }
      if (msg.kind === 'library') {
        if (msg.state === 'saving') setBtn(libBtn, null, 'Saving…');
        if (msg.state === 'saved') refreshLib();
        if (msg.state === 'error') {
          setBtn(libBtn, null, 'Retry');
          libBtn.disabled = false;
          showErr(msg.error ? "Couldn't save to library: " + msg.error : "Couldn't save to library. Please try again.");
        }
      }
    },
  };

  refreshLib();

  // Start building the files in the background so they're ready on click
  safeSend({ action: 'prebuild', key: data.key, data });
}