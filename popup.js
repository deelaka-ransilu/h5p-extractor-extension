const statusEl = document.getElementById('status');
const btn = document.getElementById('extractBtn');

function log(msg) {
  statusEl.textContent += msg + '\n';
}

function sanitizeFilename(name) {
  return (name || 'h5p-content').replace(/[^a-z0-9\-_ ]/gi, '_').slice(0, 80);
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
    data.quiz.forEach((q, i) => {
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
  // drops an image if it's identical to the one right before it
  // (fixes decks where the title slide gets inserted twice)
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

btn.addEventListener('click', async () => {
  statusEl.textContent = '';
  btn.disabled = true;
  log('Extracting from page…');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: 'extract' }, async (data) => {
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

    log(`Found: ${data.notes.length} note block(s), ${data.quiz.length} question(s), ${data.images.length} image(s).`);

    const zip = new JSZip();
    zip.file('notes.txt', buildNotesText(data));

    if (data.images.length) {
      log('Building slides.pdf (downloading images)…');
      const pdfBlob = await buildSlidesPdf(data.images);
      zip.file('slides.pdf', pdfBlob);
    }

    log('Zipping…');
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const filename = sanitizeFilename(data.title) + '.zip';

    chrome.downloads.download({ url, filename }, () => {
      log(`Downloaded: ${filename}`);
      btn.disabled = false;
    });
  });
});