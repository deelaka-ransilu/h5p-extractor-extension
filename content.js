// Runs in the isolated world (default), so chrome.runtime works here.
// inject.js (page world) hands us the raw H5PIntegration data via postMessage.

let cachedData = null;
let hostEl = null;
let ui = null;

/* ---------------- data collection ---------------- */

function requestRawData() {
  return new Promise((resolve) => {
    function handler(event) {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'H5P_EXTRACTOR_RESPONSE') return;
      window.removeEventListener('message', handler);
      resolve(event.data);
    }
    window.addEventListener('message', handler);
    window.postMessage({ type: 'H5P_EXTRACTOR_REQUEST' }, '*');

    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ error: 'Timed out waiting for page data. Try reloading the page.' });
    }, 3000);
  });
}

function getBreadcrumbInfo() {
  const items = Array.from(document.querySelectorAll('.breadcrumb-item')).map((el) =>
    el.textContent.trim().replace(/\s+/g, ' ')
  );
  return {
    subject: items[0] || null,
    weekLabel: items.length >= 2 ? items[items.length - 2] : null,
  };
}

async function collect() {
  if (cachedData) return cachedData;

  const raw = await requestRawData();
  if (raw.error) return { error: raw.error };

  let parsed;
  try {
    parsed = JSON.parse(raw.jsonContent);
  } catch (e) {
    return { error: 'Failed to parse jsonContent: ' + e.message };
  }

  const result = window.H5PExtractor.extractH5PContent(parsed, raw.contentUrl);
  cachedData = { key: location.href, title: raw.title, ...getBreadcrumbInfo(), ...result };
  return cachedData;
}

function dedupeConsecutive(urls) {
  return urls.filter((url, i) => i === 0 || url !== urls[i - 1]);
}

function safeSend(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (e) {
    // extension was reloaded; this page needs a refresh
  }
}

/* ---------------- floating card (Shadow DOM) ---------------- */

const CARD_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
@keyframes slide-in { from { opacity: 0; transform: translateX(60px); } to { opacity: 1; transform: translateX(0); } }
.card {
  position: fixed; right: 20px; bottom: 20px; width: 320px; z-index: 2147483647;
  background: #1A1A1A; color: #FFFFFF; border: 1px solid #2A2A2A; border-radius: 14px;
  padding: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.55);
  font-family: 'Space Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif;
  animation: slide-in 600ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }
.head { display: flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #22C801; flex-shrink: 0; }
.kicker { font-size: 12px; color: #8A8A8A; flex: 1; letter-spacing: .02em; }
.close { background: none; border: 0; color: #8A8A8A; font-size: 20px; line-height: 1; cursor: pointer; padding: 0 4px; border-radius: 6px; }
.close:hover { color: #FFFFFF; }
.title { margin: 10px 0 2px; font-size: 15px; font-weight: 600; line-height: 1.3; }
.sub { margin: 0; font-size: 12px; color: #8A8A8A; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; padding: 10px 12px; background: #121212; border: 1px solid #2A2A2A; border-radius: 10px; }
.row:hover { background: #202020; }
.label { font-size: 13px; font-weight: 600; }
.meta { font-size: 12px; color: #8A8A8A; margin-top: 2px; }
.meta.err { color: #EF4444; }
.bar { height: 3px; margin-top: 6px; background: #2A2A2A; border-radius: 2px; overflow: hidden; }
.fill { height: 100%; width: 0; background: #22C801; transition: width .2s ease; }
.btn { font: inherit; font-size: 13px; font-weight: 600; color: #FFFFFF; background: transparent; border: 1px solid #2A2A2A; border-radius: 8px; padding: 7px 12px; cursor: pointer; white-space: nowrap; }
.btn:hover { background: #202020; }
.btn:focus-visible { outline: 2px solid #22C801; outline-offset: 2px; }
.btn:disabled { color: #4A4A4A; cursor: not-allowed; }
.btn.busy { color: #8A8A8A; }
.primary { width: 100%; margin-top: 12px; padding: 10px 12px; color: #000000; background: #22C801; border-color: #22C801; }
.primary:hover { background: #1CA601; border-color: #1CA601; }
.primary:disabled { background: #2A2A2A; border-color: #2A2A2A; color: #4A4A4A; }
`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function hideCard() {
  if (hostEl) hostEl.remove();
  hostEl = null;
  ui = null;
}

function showCard(data) {
  if (hostEl) return;

  const slideCount = dedupeConsecutive(data.images || []).length;
  const hasText = data.notes.length + data.quiz.length > 0;
  const hasSlides = slideCount > 0;
  if (!hasText && !hasSlides) return;

  hostEl = document.createElement('div');
  hostEl.id = 'h5p-extractor-host';
  const root = hostEl.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CARD_CSS;
  root.appendChild(style);

  const card = el('div', 'card');

  const head = el('div', 'head');
  const close = el('button', 'close', '×');
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', hideCard);
  head.append(el('span', 'dot'), el('span', 'kicker', 'H5P content detected'), close);
  card.appendChild(head);

  const weekTitle = data.weekLabel ? data.weekLabel.replace(/:\s*/, ' – ') : data.title;
  card.appendChild(el('p', 'title', weekTitle || 'H5P content'));
  card.appendChild(el('p', 'sub', data.subject || ''));

  let txtBtn = null;
  let pdfBtn = null;
  let pdfMeta = null;
  let pdfFill = null;
  let pdfBar = null;
  const idleLabel = { txt: 'Download', pdf: 'Download' };

  if (hasText) {
    const row = el('div', 'row');
    const left = el('div');
    left.append(
      el('div', 'label', 'Notes (.txt)'),
      el('div', 'meta', `${data.notes.length} notes · ${data.quiz.length} questions`)
    );
    txtBtn = el('button', 'btn', idleLabel.txt);
    txtBtn.addEventListener('click', () => {
      txtBtn.disabled = true;
      safeSend({ action: 'buildAndDownload', kind: 'txt', key: data.key, data });
    });
    row.append(left, txtBtn);
    card.appendChild(row);
  }

  if (hasSlides) {
    const row = el('div', 'row');
    const left = el('div');
    left.style.flex = '1';
    pdfMeta = el('div', 'meta', `${slideCount} slides`);
    pdfBar = el('div', 'bar');
    pdfFill = el('div', 'fill');
    pdfBar.appendChild(pdfFill);
    left.append(el('div', 'label', 'Slides (.pdf)'), pdfMeta, pdfBar);
    pdfBtn = el('button', 'btn busy', 'Preparing…');
    pdfBtn.addEventListener('click', () => {
      pdfBtn.disabled = true;
      safeSend({ action: 'buildAndDownload', kind: 'pdf', key: data.key, data });
    });
    row.append(left, pdfBtn);
    card.appendChild(row);
  }

  const bothBtn = el('button', 'btn primary', 'Download both');
  if (hasText && hasSlides) {
    bothBtn.addEventListener('click', () => {
      bothBtn.disabled = true;
      if (txtBtn) txtBtn.disabled = true;
      if (pdfBtn) pdfBtn.disabled = true;
      safeSend({ action: 'buildAndDownload', kind: 'both', key: data.key, data });
    });
    card.appendChild(bothBtn);
  }

  root.appendChild(card);
  document.body.appendChild(hostEl);

  function flashSaved(btn, label) {
    if (!btn) return;
    btn.textContent = 'Saved ✓';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = label; }, 2500);
  }

  ui = {
    update(msg) {
      if (msg.kind === 'pdf-progress' && pdfBtn) {
        if (msg.state === 'building') {
          const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
          pdfFill.style.width = pct + '%';
          pdfBtn.textContent = `Preparing ${msg.done}/${msg.total}`;
          pdfBtn.classList.add('busy');
        } else if (msg.state === 'ready') {
          pdfBar.style.display = 'none';
          pdfBtn.textContent = idleLabel.pdf;
          pdfBtn.classList.remove('busy');
        } else if (msg.state === 'error') {
          pdfBar.style.display = 'none';
          pdfMeta.textContent = "Couldn't build the PDF";
          pdfMeta.classList.add('err');
          pdfBtn.textContent = 'Retry';
          pdfBtn.classList.remove('busy');
          pdfBtn.disabled = false;
        }
      }
      if (msg.kind === 'saved') {
        if (msg.which === 'txt') flashSaved(txtBtn, idleLabel.txt);
        if (msg.which === 'pdf') flashSaved(pdfBtn, idleLabel.pdf);
        if (msg.which === 'error') {
          [txtBtn, pdfBtn].forEach((b) => { if (b) b.disabled = false; });
        }
        bothBtn.disabled = false;
      }
    },
  };

  // Start building the files in the background so they're ready on click
  safeSend({ action: 'prebuild', key: data.key, data });
}

/* ---------------- detection ---------------- */

async function onDetected(data) {
  safeSend({ action: 'h5p-detected' });
  let autoCard = true;
  try {
    const stored = await chrome.storage.sync.get('autoCard');
    if (stored.autoCard === false) autoCard = false;
  } catch (e) {}
  if (autoCard) showCard(data);
}

async function init() {
  // H5PIntegration is usually there at load, but retry a few times just in case
  for (let i = 0; i < 6; i++) {
    const data = await collect();
    if (!data.error) {
      onDetected(data);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/* ---------------- messaging ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'extract') {
    collect().then(sendResponse);
    return true; // async response
  }
  if (msg.action === 'offscreen-status' && ui) {
    ui.update(msg);
  }
});

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.autoCard) return;
    if (changes.autoCard.newValue === false) hideCard();
    else if (cachedData) showCard(cachedData);
  });
} catch (e) {}

init();