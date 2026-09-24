async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Build PDFs/zips from extracted H5P content and trigger named downloads.',
    });
  } catch (e) {
    // "Only a single offscreen document may be created": one already exists, that's fine.
  }
}

function toOffscreen(message) {
  return ensureOffscreenDocument().then(() => chrome.runtime.sendMessage(message).catch(() => {}));
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

// Serialise writes to the library index so two quick saves can't overwrite each other
let libraryChain = Promise.resolve();
function saveLibraryMeta(meta) {
  libraryChain = libraryChain.then(async () => {
    const { library = {} } = await chrome.storage.local.get('library');
    library[meta.id] = meta;
    await chrome.storage.local.set({ library });
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : undefined;

  // Content script found H5P content -> green badge on the toolbar icon
  if (msg.action === 'h5p-detected' && tabId != null) {
    chrome.action.setBadgeText({ tabId, text: '✓' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#22C801' });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ tabId, color: '#000000' });
  }

  // Build the files in the background as soon as a page is detected (whether or not it's saved)
  if (msg.action === 'prebuild') {
    toOffscreen({ action: 'offscreen-prebuild', key: msg.key, data: msg.data, tabId });
  }

  // Download this page's files (from the page card or the toolbar popup)
  if (msg.action === 'buildAndDownload') {
    toOffscreen({
      action: 'offscreen-build',
      kind: msg.kind || 'both',
      key: msg.key || (msg.data && msg.data.key),
      data: msg.data,
      tabId,
    });
    sendResponse({ started: true });
  }

  // Save this page's files into the library
  if (msg.action === 'library-add') {
    toOffscreen({ action: 'offscreen-library-add', key: msg.key || msg.data.key, data: msg.data, tabId });
  }

  // Zip up library items and download
  if (msg.action === 'library-zip') {
    toOffscreen({ action: 'offscreen-zip', items: msg.items, zipName: msg.zipName });
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

  // Progress from the offscreen doc
  if (msg.action === 'offscreen-status') {
    if (msg.kind === 'library' && msg.state === 'saved' && msg.meta) saveLibraryMeta(msg.meta);
    if (msg.tabId != null) chrome.tabs.sendMessage(msg.tabId, msg).catch(() => {});
  }
});