const $ = (id) => document.getElementById(id);
const titleEl = $('title'), metaEl = $('meta'), dotEl = $('dot'), logEl = $('log');
const bothBtn = $('bothBtn'), txtBtn = $('txtBtn'), pdfBtn = $('pdfBtn'), addBtn = $('addBtn');
const autoCard = $('autoCard');
const zipSelBtn = $('zipSelBtn'), zipAllBtn = $('zipAllBtn'), libList = $('libList');

let pageData = null;
let busy = false;
let libItems = [];
const selected = new Set();

/* ---------------- helpers ---------------- */

function log(msg, isError) {
  logEl.hidden = false;
  logEl.classList.toggle('error', !!isError);
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function sanitize(name) {
  return (name || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function weekNum(label) {
  const m = /week\s*0*(\d+)/i.exec(label || '');
  return m ? parseInt(m[1], 10) : 999;
}

function setBusy(b) {
  busy = b;
  refreshPageButtons();
  refreshLibButtons();
}

// Progress logs relayed from the offscreen document
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'offscreen-log') return;
  log(msg.message, msg.message.startsWith('Error') || msg.message.startsWith('Download error'));
  if (msg.message === 'Done.') setBusy(false);
});

/* ---------------- tabs ---------------- */

function showTab(name) {
  const lib = name === 'lib';
  $('viewPage').hidden = lib;
  $('viewLib').hidden = !lib;
  $('tabPage').classList.toggle('active', !lib);
  $('tabLib').classList.toggle('active', lib);
  if (lib) renderLibrary();
}
$('tabPage').addEventListener('click', () => showTab('page'));
$('tabLib').addEventListener('click', () => showTab('lib'));

/* ---------------- This page ---------------- */

function refreshPageButtons() {
  const hasText = pageData && pageData.notes.length + pageData.quiz.length > 0;
  const hasSlides = pageData && pageData.images.length > 0;
  const on = !!pageData && !busy;
  bothBtn.disabled = !on || !(hasText || hasSlides);
  txtBtn.disabled = !on || !hasText;
  pdfBtn.disabled = !on || !hasSlides;
  addBtn.disabled = !on;
}

function download(kind) {
  logEl.textContent = '';
  setBusy(true);
  log('Working…');
  chrome.runtime.sendMessage({ action: 'buildAndDownload', kind, key: pageData.key, data: pageData });
}
bothBtn.addEventListener('click', () => download('both'));
txtBtn.addEventListener('click', () => download('txt'));
pdfBtn.addEventListener('click', () => download('pdf'));

addBtn.addEventListener('click', () => {
  logEl.textContent = '';
  setBusy(true);
  chrome.runtime.sendMessage({ action: 'library-add', key: pageData.key, data: pageData });
});

autoCard.addEventListener('change', () => {
  chrome.storage.sync.set({ autoCard: autoCard.checked });
});

async function refreshAddLabel() {
  if (!pageData) return;
  const { library = {} } = await chrome.storage.local.get('library');
  const saved = !!library[pageData.id];
  addBtn.textContent = saved ? 'In library ✓ · update' : '+ Add to library';
  addBtn.classList.toggle('inlib', saved);
}

/* ---------------- Library ---------------- */

// Work out "Part N" for weeks that have several activities, and the file names.
function prepare(items) {
  const groups = {};
  items.forEach((it) => {
    const k = (it.subject || '') + '|' + (it.weekLabel || '');
    (groups[k] = groups[k] || []).push(it);
  });

  Object.values(groups).forEach((g) => {
    g.sort((a, b) => (a.partIndex || 0) - (b.partIndex || 0) || Number(a.cmid || 0) - Number(b.cmid || 0));
    g.forEach((it, i) => {
      if (it.partTotal > 1 && it.partIndex) it._part = it.partIndex;
      else it._part = g.length > 1 ? i + 1 : null;
    });
  });

  const used = new Set();
  items.forEach((it) => {
    const week = it.weekLabel ? it.weekLabel.replace(/:\s*/, ' - ') : it.title;
    let base = sanitize([it.subject, week, it._part ? 'Part ' + it._part : null].filter(Boolean).join(' - ')) || it.id;
    if (used.has(base)) base += ' (' + it.id + ')';
    used.add(base);
    it._base = base;
    it._label = (it.weekLabel ? it.weekLabel.replace(/:\s*/, ' – ') : it.title) + (it._part ? ' · Part ' + it._part : '');
  });
}

function refreshLibButtons() {
  const n = selected.size;
  zipSelBtn.textContent = `Download selected (${n})`;
  zipSelBtn.disabled = busy || n === 0;
  zipAllBtn.disabled = busy || libItems.length === 0;
  $('tabLib').textContent = libItems.length ? `Library (${libItems.length})` : 'Library';
}

async function loadLibrary() {
  const { library = {} } = await chrome.storage.local.get('library');
  libItems = Object.values(library);
  prepare(libItems);
  libItems.sort((a, b) =>
    (a.subject || '').localeCompare(b.subject || '') ||
    weekNum(a.weekLabel) - weekNum(b.weekLabel) ||
    (a._part || 0) - (b._part || 0)
  );
  Array.from(selected).forEach((id) => { if (!library[id]) selected.delete(id); });
}

async function renderLibrary() {
  await loadLibrary();
  libList.textContent = '';

  if (!libItems.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing saved yet. Open an H5P page and click “Add to library”. Saved weeks stay here so you can download them all later.';
    libList.appendChild(p);
    refreshLibButtons();
    return;
  }

  const bySubject = {};
  libItems.forEach((it) => { (bySubject[it.subject || 'Other'] = bySubject[it.subject || 'Other'] || []).push(it); });

  Object.keys(bySubject).forEach((subject) => {
    const head = document.createElement('div');
    head.className = 'subject';
    const name = document.createElement('span');
    name.textContent = subject;
    const all = document.createElement('button');
    all.className = 'link';
    all.textContent = 'Select all';
    all.addEventListener('click', () => {
      const ids = bySubject[subject].map((i) => i.id);
      const every = ids.every((id) => selected.has(id));
      ids.forEach((id) => (every ? selected.delete(id) : selected.add(id)));
      renderLibrary();
    });
    head.append(name, all);
    libList.appendChild(head);

    bySubject[subject].forEach((it) => {
      const row = document.createElement('label');
      row.className = 'item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(it.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(it.id); else selected.delete(it.id);
        refreshLibButtons();
      });
      const text = document.createElement('div');
      text.className = 'text';
      const nm = document.createElement('div');
      nm.className = 'name';
      nm.textContent = it._label;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${it.notes} notes · ${it.quiz} questions · ${it.slides} slides`;
      text.append(nm, sub);
      const rm = document.createElement('button');
      rm.className = 'remove';
      rm.title = 'Remove from library';
      rm.textContent = '×';
      rm.addEventListener('click', async (e) => {
        e.preventDefault();
        await H5PDB.del(it.id);
        const { library = {} } = await chrome.storage.local.get('library');
        delete library[it.id];
        await chrome.storage.local.set({ library });
        selected.delete(it.id);
      });
      row.append(cb, text, rm);
      libList.appendChild(row);
    });
  });

  refreshLibButtons();
}

function zipItems(list) {
  if (!list.length) return;
  const subjects = new Set(list.map((i) => i.subject || 'Other'));
  const zipName = sanitize(subjects.size === 1 ? `${[...subjects][0]} - H5P content` : 'H5P library') + '.zip';
  logEl.textContent = '';
  setBusy(true);
  log(`Zipping ${list.length} week(s)…`);
  chrome.runtime.sendMessage({
    action: 'library-zip',
    zipName,
    items: list.map((i) => ({ id: i.id, folder: sanitize(i.subject) || 'H5P', fileBase: i._base })),
  });
}
zipSelBtn.addEventListener('click', () => zipItems(libItems.filter((i) => selected.has(i.id))));
zipAllBtn.addEventListener('click', () => zipItems(libItems));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.library) return;
  refreshAddLabel();
  renderLibrary();
});

/* ---------------- init ---------------- */

async function init() {
  const stored = await chrome.storage.sync.get('autoCard');
  autoCard.checked = stored.autoCard !== false;
  await loadLibrary();
  refreshLibButtons();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: 'extract' }, (data) => {
    if (chrome.runtime.lastError || !data || data.error) {
      titleEl.textContent = 'No H5P content on this page';
      metaEl.textContent = 'Open a lecture activity on online.codl.lk (and refresh it if you just installed or updated the extension).';
      if (libItems.length) showTab('lib');
      return;
    }
    pageData = data;
    dotEl.classList.add('on');
    const part = data.partTotal > 1 ? ` · Part ${data.partIndex} of ${data.partTotal}` : '';
    titleEl.textContent = (data.weekLabel ? data.weekLabel.replace(/:\s*/, ' – ') : data.title) + part;
    metaEl.textContent = `${data.subject || ''} · ${data.notes.length} notes · ${data.quiz.length} questions · ${data.images.length} slides`;
    refreshPageButtons();
    refreshAddLabel();
  });
}

init();