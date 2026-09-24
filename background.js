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

// blob URL -> the filename we want for it
const pendingNames = new Map();

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const wanted = pendingNames.get(item.url);
  if (wanted) {
    pendingNames.delete(item.url);
    suggest({ filename: wanted, conflictAction: 'uniquify' });
  } else {
    suggest(); // not ours, leave it alone
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : undefined;

  // Content script found H5P content -> green badge on the toolbar icon
  if (msg.action === 'h5p-detected' && tabId != null) {
    chrome.action.setBadgeText({ tabId, text: '✓' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#22C801' });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ tabId, color: '#000000' });
  }

  // Start building the files in the background so they're ready when clicked
  if (msg.action === 'prebuild') {
    ensureOffscreenDocument().then(() => {
      chrome.runtime
        .sendMessage({ action: 'offscreen-prebuild', key: msg.key, data: msg.data, tabId })
        .catch(() => {});
    });
  }

  // Download request from the page card or the toolbar popup
  if (msg.action === 'buildAndDownload') {
    ensureOffscreenDocument().then(() => {
      chrome.runtime
        .sendMessage({
          action: 'offscreen-build',
          kind: msg.kind || 'both',
          key: msg.key || (msg.data && msg.data.key),
          data: msg.data,
          tabId,
        })
        .catch(() => {});
    });
    sendResponse({ started: true });
  }

  // Offscreen doc can't use chrome.downloads, so it asks us to do it
  if (msg.action === 'offscreen-download') {
    pendingNames.set(msg.url, msg.filename);
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false }, () => {
      if (chrome.runtime.lastError) {
        pendingNames.delete(msg.url);
        chrome.runtime
          .sendMessage({ action: 'offscreen-log', message: 'Download error: ' + chrome.runtime.lastError.message })
          .catch(() => {});
      }
    });
  }

  // Progress from the offscreen doc -> forward to the page card
  if (msg.action === 'offscreen-status' && msg.tabId != null) {
    chrome.tabs.sendMessage(msg.tabId, msg).catch(() => {});
  }
});