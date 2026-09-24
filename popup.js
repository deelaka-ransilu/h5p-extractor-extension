const $ = (id) => document.getElementById(id);
const titleEl = $('title'), metaEl = $('meta'), dotEl = $('dot');
const bothBtn = $('bothBtn'), txtBtn = $('txtBtn'), pdfBtn = $('pdfBtn'), addBtn = $('addBtn');
const autoCard = $('autoCard');
const { log, hooks } = window.H5PLog;

let pageData = null;
let busy = false;

/* ---------- icons on static buttons ---------- */
function paintButtons() {
  setBtn($('openLibBtn'), 'external', null);
  setBtn(bothBtn, 'download', 'Download notes + slides');
  setBtn(txtBtn, 'file', 'Notes .txt');
  setBtn(pdfBtn, 'slides', 'Slides .pdf');
  refreshAddLabel();
}

/* ---------- tabs ---------- */
function showTab(name) {
  const lib = name === 'lib';
  $('viewPage').hidden = lib;
  $('viewLib').hidden = !lib;
  $('tabPage').classList.toggle('active', !lib);
  $('tabLib').classList.toggle('active', lib);
  if (lib) window.H5PLibrary.refresh();
}
$('tabPage').addEventListener('click', () => showTab('page'));
$('tabLib').addEventListener('click', () => showTab('lib'));

$('openLibBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'open-library' });
  window.close();
});

/* ---------- this page ---------- */
function refreshPageButtons() {
  const hasText = pageData && pageData.notes.length + pageData.quiz.length > 0;
  const hasSlides = pageData && pageData.images.length > 0;
  const on = !!pageData && !busy;
  bothBtn.disabled = !on || !(hasText || hasSlides);
  txtBtn.disabled = !on || !hasText;
  pdfBtn.disabled = !on || !hasSlides;
  addBtn.disabled = !on;
}

function setBusy(b) {
  busy = b;
  refreshPageButtons();
}
hooks.onDone = () => setBusy(false);

function download(kind) {
  setBusy(true);
  log('Working…', false, true);
  chrome.runtime.sendMessage({ action: 'buildAndDownload', kind, key: pageData.key, data: pageData });
}
bothBtn.addEventListener('click', () => download('both'));
txtBtn.addEventListener('click', () => download('txt'));
pdfBtn.addEventListener('click', () => download('pdf'));

addBtn.addEventListener('click', () => {
  setBusy(true);
  log('Saving to library…', false, true);
  chrome.runtime.sendMessage({ action: 'library-add', key: pageData.key, data: pageData });
});

autoCard.addEventListener('change', () => {
  chrome.storage.sync.set({ autoCard: autoCard.checked });
});

async function refreshAddLabel() {
  let saved = false;
  if (pageData) {
    const { library = {} } = await chrome.storage.local.get('library');
    saved = !!library[pageData.id];
  }
  setBtn(addBtn, saved ? 'check' : 'plus', saved ? 'In library · update' : 'Add to library');
  addBtn.classList.toggle('inlib', saved);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.library) refreshAddLabel();
});

/* ---------- init ---------- */
async function init() {
  paintButtons();
  const stored = await chrome.storage.sync.get('autoCard');
  autoCard.checked = stored.autoCard !== false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: 'extract' }, async (data) => {
    if (chrome.runtime.lastError || !data || data.error) {
      titleEl.textContent = 'No H5P content on this page';
      metaEl.textContent = 'Open a lecture activity on online.codl.lk (and refresh it if you just installed or updated the extension).';
      const { library = {} } = await chrome.storage.local.get('library');
      if (Object.keys(library).length) showTab('lib');
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