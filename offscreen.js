// key (page URL) -> { data, tabId, baseName, txtBlob, pdfPromise }
const cache = new Map();

function log(msg) {
  chrome.runtime.sendMessage({ action: 'offscreen-log', message: msg }).catch(() => {});
}

function status(tabId, payload) {
  chrome.runtime.sendMessage({ action: 'offscreen-status', tabId, ...payload }).catch(() => {});
}

function sanitizeFilename(name) {
  return (name || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function buildBaseName(data) {
  const week = data.weekLabel ? data.weekLabel.replace(/:\s*/, ' - ') : null;
  const parts = [data.subject, week].filter(Boolean);
  const combined = sanitizeFilename(parts.join(' - ') || data.title || '');
  return combined || `h5p-content-${Date.now()}`;
}

function buildNotesText(data) {
  const lines = [];
  lines.push(`# ${data.title}`, '');

  if (data.notes.length) {
    lines.push('## Notes', '');
    data.notes.forEach(n => lines.push(n, ''));
  }

  if (data.quiz.length) {
    lines.push('## Quiz Questions', '');
    data.quiz.forEach((q) => {
      if (q.type === 'SingleChoiceSet') {
        (q.items || []).forEach(item => {
          lines.push(`Q: ${item.question}`);
          (item.answers || []).forEach(a => lines.push(`  - ${a}${a === item.correctAnswer ? '  [CORRECT]' : ''}`));
          lines.push('');
        });
      } else if (q.type === 'Blanks') {
        lines.push(`Fill-in-the-blank: ${q.question}`, '');
      } else {
        lines.push(`Q: ${q.question || '(untitled)'}`);
        (q.options || []).forEach(o => lines.push(`  - ${o.text}${o.correct ? '  [CORRECT]' : ''}`));
        lines.push('');
      }
    });
  }

  return lines.join('\n');
}

async function imageUrlToDataUrl(url) {
  const resp = await fetch(url, { credentials: 'include' });
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function dedupeConsecutive(urls) {
  return urls.filter((url, i) => i === 0 || url !== urls[i - 1]);
}

async function buildSlidesPdf(urls, onProgress) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'px', format: 'a4', orientation: 'landscape' });
  let first = true;

  for (let i = 0; i < urls.length; i++) {
    try {
      const dataUrl = await imageUrlToDataUrl(urls[i]);
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = dataUrl;
      });

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const ratio = Math.min(pageWidth / img.width, pageHeight / img.height);
      const w = img.width * ratio;
      const h = img.height * ratio;

      if (!first) pdf.addPage();
      pdf.addImage(dataUrl, 'PNG', (pageWidth - w) / 2, (pageHeight - h) / 2, w, h);
      first = false;
    } catch (e) {
      log(`  (skipped one image: ${e.message})`);
    }
    if (onProgress) onProgress(i + 1, urls.length);
  }

  return pdf.output('blob');
}

// Starts (or restarts) the PDF build for a cache entry.
function startPdf(entry) {
  const urls = dedupeConsecutive(entry.data.images || []);
  if (!urls.length) {
    entry.pdfPromise = Promise.resolve(null);
    return;
  }
  status(entry.tabId, { kind: 'pdf-progress', state: 'building', done: 0, total: urls.length });

  entry.pdfPromise = buildSlidesPdf(urls, (done, total) =>
    status(entry.tabId, { kind: 'pdf-progress', state: 'building', done, total })
  )
    .then((blob) => {
      status(entry.tabId, { kind: 'pdf-progress', state: 'ready', done: urls.length, total: urls.length });
      return blob;
    })
    .catch((err) => {
      entry.pdfPromise = null; // allow a retry on the next request
      status(entry.tabId, { kind: 'pdf-progress', state: 'error', error: err.message });
      throw err;
    });

  entry.pdfPromise.catch(() => {}); // avoid an unhandled-rejection warning if nobody awaits it yet
}

function getEntry(key, data, tabId) {
  let entry = cache.get(key);
  if (entry) {
    if (tabId != null) entry.tabId = tabId;
    return entry;
  }
  entry = {
    data,
    tabId,
    baseName: buildBaseName(data),
    txtBlob: new Blob([buildNotesText(data)], { type: 'text/plain' }),
    pdfPromise: null,
  };
  cache.set(key, entry);
  startPdf(entry);
  return entry;
}

// Offscreen documents can't use chrome.downloads, so we hand the blob URL
// to background.js, which starts the actual download.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  return chrome.runtime
    .sendMessage({ action: 'offscreen-download', url, filename })
    .catch(() => {})
    .then(() => {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
}

chrome.runtime.onMessage.addListener((msg) => {
  // Build in the background as soon as the page is detected
  if (msg.action === 'offscreen-prebuild') {
    getEntry(msg.key || msg.data.title, msg.data, msg.tabId);
    return;
  }

  if (msg.action !== 'offscreen-build') return;

  (async () => {
    try {
      const entry = getEntry(msg.key || (msg.data && msg.data.key) || msg.data.title, msg.data, msg.tabId);
      const data = entry.data;
      const kind = msg.kind || 'both';

      log(`Found: ${data.notes.length} note block(s), ${data.quiz.length} question(s), ${data.images.length} image(s).`);
      log(`Filename: ${entry.baseName}`);

      if (kind === 'txt' || kind === 'both') {
        await downloadBlob(entry.txtBlob, `${entry.baseName}.txt`);
        log(`Downloaded: ${entry.baseName}.txt`);
        status(entry.tabId, { kind: 'saved', which: 'txt' });
      }

      if ((kind === 'pdf' || kind === 'both') && data.images.length) {
        if (!entry.pdfPromise) startPdf(entry);
        log('Preparing slides.pdf…');
        const pdfBlob = await entry.pdfPromise;
        if (pdfBlob) {
          await downloadBlob(pdfBlob, `${entry.baseName}.pdf`);
          log(`Downloaded: ${entry.baseName}.pdf`);
          status(entry.tabId, { kind: 'saved', which: 'pdf' });
        }
      }

      log('Done.');
    } catch (e) {
      log('Error: ' + e.message);
      log('Done.'); // re-enables the popup button
      if (msg.tabId != null) status(msg.tabId, { kind: 'saved', which: 'error' });
    }
  })();
});