const statusEl = document.getElementById('status');
const btn = document.getElementById('extractBtn');

function log(msg) {
  statusEl.textContent += msg + '\n';
}

// Listen for progress logs relayed from the offscreen document (via background.js).
// This keeps working even if this popup gets closed and reopened mid-process.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'offscreen-log') {
    log(msg.message);
    if (msg.message === 'Done.') btn.disabled = false;
  }
});

btn.addEventListener('click', async () => {
  statusEl.textContent = '';
  btn.disabled = true;
  log('Extracting from page…');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: 'extract' }, (data) => {
    if (chrome.runtime.lastError) {
      log('Error: ' + chrome.runtime.lastError.message);
      btn.disabled = false;
      return;
    }
    if (data.error) {
      log('Error: ' + data.error);
      btn.disabled = false;
      return;
    }

    // Hand off to the background/offscreen document — it builds the files
    // and starts the downloads independently of this popup's lifetime.
    chrome.runtime.sendMessage({ action: 'buildAndDownload', data });
  });
});