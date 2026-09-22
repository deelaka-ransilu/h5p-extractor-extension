// Runs in the isolated world (default), so chrome.runtime works here.
// It asks inject.js (page world) for the raw H5PIntegration data via
// postMessage, then runs the parser on the result.

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

    // safety timeout in case inject.js never responds
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ error: 'Timed out waiting for page data. Try reloading the page.' });
    }, 3000);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'extract') return;

  requestRawData().then((raw) => {
    if (raw.error) {
      sendResponse({ error: raw.error });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw.jsonContent);
    } catch (e) {
      sendResponse({ error: 'Failed to parse jsonContent: ' + e.message });
      return;
    }

    const result = window.H5PExtractor.extractH5PContent(parsed, raw.contentUrl);
    sendResponse({ title: raw.title, ...result });
  });

  return true; // keep the message channel open for the async response above
});
