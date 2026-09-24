const titleEl = document.getElementById('title');
const metaEl = document.getElementById('meta');
const dotEl = document.getElementById('dot');
const logEl = document.getElementById('log');
const bothBtn = document.getElementById('bothBtn');
const txtBtn = document.getElementById('txtBtn');
const pdfBtn = document.getElementById('pdfBtn');
const autoCard = document.getElementById('autoCard');

let pageData = null;

function log(msg, isError) {
  logEl.hidden = false;
  logEl.classList.toggle('error', !!isError);
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function setButtons(enabled) {
  const hasText = pageData && pageData.notes.length + pageData.quiz.length > 0;
  const hasSlides = pageData && pageData.images.length > 0;
  bothBtn.disabled = !enabled || !(hasText || hasSlides);
  txtBtn.disabled = !enabled || !hasText;
  pdfBtn.disabled = !enabled || !hasSlides;
}

// Progress logs relayed from the offscreen document
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'offscreen-log') return;
  log(msg.message, msg.message.startsWith('Error') || msg.message.startsWith('Download error'));
  if (msg.message === 'Done.') setButtons(true);
});

function download(kind) {
  logEl.textContent = '';
  setButtons(false);
  log('Working…');
  chrome.runtime.sendMessage({ action: 'buildAndDownload', kind, key: pageData.key, data: pageData });
}

bothBtn.addEventListener('click', () => download('both'));
txtBtn.addEventListener('click', () => download('txt'));
pdfBtn.addEventListener('click', () => download('pdf'));

autoCard.addEventListener('change', () => {
  chrome.storage.sync.set({ autoCard: autoCard.checked });
});

function showNone(reason) {
  titleEl.textContent = 'No H5P content on this page';
  metaEl.textContent = reason || 'Open a lecture activity on online.codl.lk (and refresh it if you just installed or updated the extension).';
}

async function init() {
  const stored = await chrome.storage.sync.get('autoCard');
  autoCard.checked = stored.autoCard !== false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: 'extract' }, (data) => {
    if (chrome.runtime.lastError || !data || data.error) {
      showNone();
      return;
    }
    pageData = data;
    dotEl.classList.add('on');
    titleEl.textContent = data.weekLabel ? data.weekLabel.replace(/:\s*/, ' – ') : data.title;
    metaEl.textContent = `${data.subject || ''} · ${data.notes.length} notes · ${data.quiz.length} questions · ${data.images.length} slides`;
    setButtons(true);
  });
}

init();