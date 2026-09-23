function log(msg) {
  chrome.runtime.sendMessage({ action: 'offscreen-log', message: msg }).catch(() => {});
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

async function buildSlidesPdf(imageUrls) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'px', format: 'a4', orientation: 'landscape' });
  const urls = dedupeConsecutive(imageUrls);
  let first = true;

  for (const url of urls) {
    try {
      const dataUrl = await imageUrlToDataUrl(url);
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
  }

  return pdf.output('blob');
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
  if (msg.action !== 'offscreen-build') return;
  const data = msg.data;

  (async () => {
    try {
      log(`Found: ${data.notes.length} note block(s), ${data.quiz.length} question(s), ${data.images.length} image(s).`);
      log(`Subject: ${data.subject || '(none found)'} | Week: ${data.weekLabel || '(none found)'}`);

      const baseName = buildBaseName(data);
      log(`Filename: ${baseName}`);

      const notesBlob = new Blob([buildNotesText(data)], { type: 'text/plain' });
      await downloadBlob(notesBlob, `${baseName}.txt`);
      log(`Downloaded: ${baseName}.txt`);

      if (data.images.length) {
        log('Building slides.pdf (downloading images)…');
        const pdfBlob = await buildSlidesPdf(data.images);
        await downloadBlob(pdfBlob, `${baseName}.pdf`);
        log(`Downloaded: ${baseName}.pdf`);
      }

      log('Done.');
    } catch (e) {
      log('Error: ' + e.message);
      log('Done.'); // re-enables the popup button
    }
  })();
});