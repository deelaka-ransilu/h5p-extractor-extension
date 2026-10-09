// The offscreen document: keeps built files in memory, runs the download / library / zip jobs
// and reports progress. Builders live in build.js; shared helpers in shared/utils.js.

// key (page URL) -> { data, tabId, baseName, txtBlob, pdfPromise, pdfJob, pdfState }
// Insertion order = least recently used first. Capped so many open tabs
// can't pile up blobs (and finished PDFs) in memory forever.
const cache = new Map();
const CACHE_MAX = 4;

// PDF builds are queued: at most PDF_MAX run at once, the rest wait first-in-first-out.
// A manual click (Download / Add to library) moves that week to the front of the queue.
const PDF_MAX = 2;
const pdfQueue = [];
let pdfRunning = 0;

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

/* ---------------- PDF queue ---------------- */

// Queues the PDF build for a cache entry. priority = a person clicked something for this week.
function startPdf(entry, priority) {
  const urls = H5PUtils.dedupeConsecutive(entry.data.images || []);
  if (!urls.length) {
    entry.pdfPromise = Promise.resolve(null);
    return;
  }

  let resolveFn;
  let rejectFn;
  entry.pdfPromise = new Promise((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  entry.pdfPromise.catch(() => {}); // avoid an unhandled-rejection warning if nobody awaits it

  const pdfJob = { entry, urls, resolve: resolveFn, reject: rejectFn, started: false, manual: !!priority };
  entry.pdfJob = pdfJob;
  setPdfState(entry, { state: 'queued' });

  if (priority) pdfQueue.unshift(pdfJob);
  else pdfQueue.push(pdfJob);
  pumpPdfQueue();
}

function pumpPdfQueue() {
  while (pdfRunning < PDF_MAX && pdfQueue.length) {
    runPdfJob(pdfQueue.shift());
  }
}

// Builds the PDF. If it throws, or some slide images couldn't be loaded, it tries once more.
async function runPdfJob(pdfJob) {
  const { entry, urls } = pdfJob;
  pdfRunning++;
  pdfJob.started = true;
  try {
    let result = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      setPdfState(entry, { state: 'building', done: 0, total: urls.length });
      try {
        result = await buildSlidesPdf(urls, (done, total) =>
          setPdfState(entry, { state: 'building', done, total })
        );
        if (!result.skipped) break;
        if (attempt === 1) log(`${result.skipped} slide image(s) failed to load, retrying once…`);
      } catch (e) {
        if (attempt === 2) throw e;
        log('PDF build failed, retrying once: ' + e.message);
      }
    }
    entry.pdfJob = null;
    setPdfState(entry, {
      state: 'ready',
      done: urls.length,
      total: urls.length,
      skipped: result.skipped,
      incomplete: result.skipped > 0,
    });
    pdfJob.resolve(result.blob);
  } catch (err) {
    entry.pdfPromise = null; // allow a retry on the next request
    entry.pdfJob = null;
    setPdfState(entry, { state: 'error', error: err.message });
    pdfJob.reject(err);
  } finally {
    pdfRunning--;
    pumpPdfQueue();
  }
}

// A person clicked something for this week: move its queued build to the front.
function prioritize(entry) {
  const pdfJob = entry.pdfJob;
  if (!pdfJob || pdfJob.started) return;
  pdfJob.manual = true;
  const i = pdfQueue.indexOf(pdfJob);
  if (i > 0) {
    pdfQueue.splice(i, 1);
    pdfQueue.unshift(pdfJob);
  }
}

// autoSave was switched off: forget builds that were only waiting in the queue.
// Weeks a person clicked on (manual) stay queued. Cleared weeks go back to "Download",
// which builds on demand.
function clearPdfQueue() {
  for (let i = pdfQueue.length - 1; i >= 0; i--) {
    const pdfJob = pdfQueue[i];
    if (pdfJob.manual) continue;
    pdfQueue.splice(i, 1);
    pdfJob.entry.pdfPromise = null;
    pdfJob.entry.pdfJob = null;
    setPdfState(pdfJob.entry, { state: 'idle' });
    pdfJob.reject(new Error('Queue cleared'));
  }
}

// An entry is leaving the cache: don't keep a build for it waiting in the queue.
function dropQueuedJob(entry) {
  const pdfJob = entry.pdfJob;
  if (!pdfJob || pdfJob.started || pdfJob.manual) return;
  const i = pdfQueue.indexOf(pdfJob);
  if (i >= 0) pdfQueue.splice(i, 1);
  entry.pdfPromise = null;
  entry.pdfJob = null;
  pdfJob.reject(new Error('Evicted'));
}

/* ---------------- cache ---------------- */

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
    pdfJob: null,
    pdfState: null,
  };
  cache.set(key, entry);
  // Evict the least recently used entries. If one is needed again, the next
  // request rebuilds it from the data the page sends along.
  while (cache.size > CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    dropQueuedJob(cache.get(oldestKey));
    cache.delete(oldestKey);
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
    if (!entry.pdfPromise) startPdf(entry, true);
    else prioritize(entry);
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
    if (!entry.pdfPromise) startPdf(entry, true);
    else prioritize(entry);
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
    hash: H5PUtils.hashContent(data),
    bytes: entry.txtBlob.size + (pdfBlob ? pdfBlob.size : 0),
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
  // Build in the background as soon as the page is detected (or autoSave was switched on)
  if (msg.action === 'offscreen-prebuild') {
    const entry = getEntry(msg.key || msg.data.title, msg.data, msg.tabId);
    // idle / failed earlier: queue it again. Otherwise a reloaded page starts with a fresh
    // "Preparing…" button, so tell it where the build is now.
    if (!entry.pdfPromise) startPdf(entry);
    else replayPdfState(entry);
    return;
  }

  // autoSave was switched off
  if (msg.action === 'offscreen-clear-queue') {
    clearPdfQueue();
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