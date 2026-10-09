// The offscreen document: keeps built files in memory, runs the download / library / zip jobs
// and reports progress. Builders live in build.js; shared helpers in shared/utils.js.

// key (page URL) -> { data, tabId, baseName, txtBlob, pdfPromise, pdfState }
// Insertion order = least recently used first. Capped so many open tabs
// can't pile up blobs (and finished PDFs) in memory forever.
const cache = new Map();
const CACHE_MAX = 4;

function log(msg) {
  chrome.runtime.sendMessage({ action: 'offscreen-log', message: msg }).catch(() => {});
}

function sendStatus(tabId, payload) {
  chrome.runtime.sendMessage({ action: 'offscreen-status', tabId, ...payload }).catch(() => {});
}

// Tells every open extension page (the library) that a job started / finished / failed.
function job(name, state, error) {
  chrome.runtime.sendMessage({ action: 'offscreen-job', job: name, state, error }).catch(() => {});
}

// Remember the PDF build's latest state on the entry AND tell the page.
// Remembering it lets us replay it when the same week is opened again
// (e.g. the tab was reloaded), otherwise the new page would never hear about a finished build.
function setPdfState(entry, payload) {
  entry.pdfState = payload;
  sendStatus(entry.tabId, { kind: 'pdf-progress', ...payload });
}

function replayPdfState(entry) {
  if (entry.pdfState) sendStatus(entry.tabId, { kind: 'pdf-progress', ...entry.pdfState });
}

// Starts (or restarts) the PDF build for a cache entry.
function startPdf(entry) {
  const urls = H5PUtils.dedupeConsecutive(entry.data.images || []);
  if (!urls.length) {
    entry.pdfPromise = Promise.resolve(null);
    return;
  }
  setPdfState(entry, { state: 'building', done: 0, total: urls.length });

  entry.pdfPromise = buildSlidesPdf(urls, (done, total) =>
    setPdfState(entry, { state: 'building', done, total })
  )
    .then((blob) => {
      setPdfState(entry, { state: 'ready', done: urls.length, total: urls.length });
      return blob;
    })
    .catch((err) => {
      entry.pdfPromise = null; // allow a retry on the next request
      setPdfState(entry, { state: 'error', error: err.message });
      throw err;
    });

  entry.pdfPromise.catch(() => {}); // avoid an unhandled-rejection warning if nobody awaits it yet
}

function getEntry(key, data, tabId) {
  let entry = cache.get(key);
  if (entry) {
    // mark as most recently used
    cache.delete(key);
    cache.set(key, entry);
    if (tabId != null) entry.tabId = tabId;
    return entry;
  }
  entry = {
    data,
    tabId,
    baseName: buildBaseName(data),
    txtBlob: new Blob([buildNotesText(data)], { type: 'text/plain' }),
    pdfPromise: null,
    pdfState: null,
  };
  cache.set(key, entry);
  // Evict the least recently used entries. If one is needed again, the next
  // request rebuilds it from the data the page sends along.
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  startPdf(entry);
  return entry;
}

// Offscreen documents can't use chrome.downloads, so we hand the blob URL
// to background.js, which starts the actual download.
function downloadBlob(blob, filename, keepMs = 60000, tabId) {
  const url = URL.createObjectURL(blob);
  return chrome.runtime
    .sendMessage({ action: 'offscreen-download', url, filename, tabId })
    .catch(() => {})
    .then(() => {
      setTimeout(() => URL.revokeObjectURL(url), keepMs);
    });
}

/* ---------------- message handlers ---------------- */

async function handleBuild(msg) {
  const entry = getEntry(msg.key || (msg.data && msg.data.key) || msg.data.title, msg.data, msg.tabId);
  const data = entry.data;
  const kind = msg.kind || 'both';

  log(`Found: ${data.notes.length} note block(s), ${H5PUtils.questionTotal(data)} question(s), ${data.images.length} image(s).`);
  log(`Filename: ${entry.baseName}`);

  if (kind === 'txt' || kind === 'both') {
    await downloadBlob(entry.txtBlob, `${entry.baseName}.txt`, 60000, entry.tabId);
    log(`Downloaded: ${entry.baseName}.txt`);
    sendStatus(entry.tabId, { kind: 'saved', which: 'txt' });
  }

  if ((kind === 'pdf' || kind === 'both') && data.images.length) {
    if (!entry.pdfPromise) startPdf(entry);
    log('Preparing slides.pdf…');
    const pdfBlob = await entry.pdfPromise;
    if (pdfBlob) {
      await downloadBlob(pdfBlob, `${entry.baseName}.pdf`, 60000, entry.tabId);
      log(`Downloaded: ${entry.baseName}.pdf`);
      sendStatus(entry.tabId, { kind: 'saved', which: 'pdf' });
    }
  }
}

async function handleLibraryAdd(msg) {
  const entry = getEntry(msg.key || msg.data.key || msg.data.title, msg.data, msg.tabId);
  const data = entry.data;
  sendStatus(entry.tabId, { kind: 'library', state: 'saving' });
  log('Saving to library…');

  let pdfBlob = null;
  if (data.images.length) {
    if (!entry.pdfPromise) startPdf(entry);
    pdfBlob = await entry.pdfPromise; // the background build usually finished already
  }

  const id = data.id || msg.key;
  await H5PDB.put(id, { txt: entry.txtBlob, pdf: pdfBlob });

  const meta = {
    id,
    url: data.key,
    cmid: data.cmid || null,
    subject: data.subject || '',
    weekLabel: data.weekLabel || '',
    title: data.title || '',
    notes: data.notes.length,
    quiz: H5PUtils.questionTotal(data),
    slides: H5PUtils.dedupeConsecutive(data.images || []).length,
    partIndex: data.partIndex || null,
    partTotal: data.partTotal || null,
    savedAt: Date.now(),
  };
  sendStatus(entry.tabId, { kind: 'library', state: 'saved', meta });
  log(`Saved to library: ${entry.baseName}`);
}

async function handleZip(msg) {
  const zip = new JSZip();
  const items = msg.items || [];
  let added = 0;

  for (const it of items) {
    const rec = await H5PDB.get(it.id);
    if (!rec) {
      log(`  (missing in storage, skipped: ${it.fileBase})`);
      continue;
    }
    const folder = zip.folder(it.folder);
    folder.file(`${it.fileBase}.txt`, rec.txt);
    if (rec.pdf) folder.file(`${it.fileBase}.pdf`, rec.pdf);
    added++;
    log(`Added ${added}/${items.length}: ${it.fileBase}`);
  }

  if (!added) {
    log('Nothing to zip.');
    return;
  }

  log('Building zip…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }); // PDFs are already compressed
  await downloadBlob(blob, msg.zipName || 'H5P library.zip', 300000);
  log(`Downloaded: ${msg.zipName}`);
}

chrome.runtime.onMessage.addListener((msg) => {
  // Build in the background as soon as the page is detected
  if (msg.action === 'offscreen-prebuild') {
    const entry = getEntry(msg.key || msg.data.title, msg.data, msg.tabId);
    // a reloaded page starts with a fresh "Preparing…" button: tell it where the build is now
    replayPdfState(entry);
    return;
  }

  const handlers = {
    'offscreen-build': handleBuild,
    'offscreen-library-add': handleLibraryAdd,
    'offscreen-zip': handleZip,
  };
  const handler = handlers[msg.action];
  if (!handler) return;

  const jobName = { 'offscreen-build': 'download', 'offscreen-library-add': 'library', 'offscreen-zip': 'zip' }[msg.action];

  (async () => {
    job(jobName, 'start');
    try {
      await handler(msg);
      job(jobName, 'done');
    } catch (e) {
      log('Error: ' + e.message);
      job(jobName, 'error', e.message);
      if (msg.tabId != null) {
        sendStatus(msg.tabId, { kind: msg.action === 'offscreen-library-add' ? 'library' : 'saved', state: 'error', which: 'error', error: e.message });
      }
    }
  })();
});