async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Build a PDF/txt from extracted H5P content and trigger a named download.',
    });
  } catch (e) {
    // "Only a single offscreen document may be created": one already exists, that's fine.
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'buildAndDownload') {
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ action: 'offscreen-build', data: msg.data });
    });
    sendResponse({ started: true });
  }

  if (msg.action === 'offscreen-download') {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, saveAs: false },
      () => {
        if (chrome.runtime.lastError) {
          chrome.runtime
            .sendMessage({ action: 'offscreen-log', message: 'Download error: ' + chrome.runtime.lastError.message })
            .catch(() => {});
        }
      }
    );
  }
});