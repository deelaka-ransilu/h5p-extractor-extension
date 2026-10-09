// Entry point of the content scripts: detects H5P content, shows or hides the
// floating button, and listens for messages and settings changes.
// Loaded last (see manifest.json), so everything it calls already exists.

async function loadFabPos() {
  try {
    const { fabPos: stored } = await chrome.storage.sync.get('fabPos');
    const p = normalizeFabPos(stored);
    if (p) fabPos = p;
  } catch (e) {}
}

async function onDetected(data) {
  safeSend({ action: 'h5p-detected' });
  let autoCard = true;
  try {
    const stored = await chrome.storage.sync.get('autoCard');
    if (stored.autoCard === false) autoCard = false;
  } catch (e) {}
  if (autoCard) {
    await loadFabPos();
    showCard(data);
  }
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'offscreen-status' && ui) {
    ui.update(msg);
  }
});

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.autoCard) {
      if (changes.autoCard.newValue === false) hideCard();
      else if (cachedData) loadFabPos().then(() => showCard(cachedData));
    }
    // another tab moved the button: follow it
    if (area === 'sync' && changes.fabPos && changes.fabPos.newValue) {
      const p = normalizeFabPos(changes.fabPos.newValue);
      if (p) {
        fabPos = p;
        if (ui) ui.placeFab();
      }
    }
    if (area === 'local' && changes.library && ui) ui.refreshLib();
  });
} catch (e) {}

init();