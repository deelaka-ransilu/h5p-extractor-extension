// Pure builders: turn extracted H5P data into a file name, a notes .txt and a slides .pdf.
// Offscreen-document world: shares globals with offscreen.js (it calls its log()).

function buildBaseName(data) {
  const week = data.weekLabel ? data.weekLabel.replace(/:\s*/, ' - ') : null;
  const part = data.partTotal > 1 && data.partIndex ? `Part ${data.partIndex}` : null;
  const parts = [data.subject, week, part].filter(Boolean);
  const combined = H5PUtils.sanitizeFilename(parts.join(' - ') || data.title || '');
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
      } else if (q.type === 'Summary') {
        if (q.intro) lines.push(q.intro, '');
        (q.items || []).forEach((item) => {
          lines.push('Q: Pick the correct summary statement.');
          lines.push(`  - ${item.correct}  [CORRECT]`);
          (item.wrong || []).forEach(w => lines.push(`  - ${w}`));
          if (item.tip) lines.push(`  (Tip: ${item.tip})`);
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

// Returns { blob, skipped }: skipped = how many slide images couldn't be loaded.
async function buildSlidesPdf(urls, onProgress) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'px', format: 'a4', orientation: 'landscape' });
  let first = true;
  let skipped = 0;

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
      skipped++;
      log(`  (skipped one image: ${e.message})`);
    }
    if (onProgress) onProgress(i + 1, urls.length);
  }

  return { blob: pdf.output('blob'), skipped };
}