// Small helpers shared by the content scripts, the offscreen document and the library page.
// A plain global object: none of those contexts has a module system.
const H5PUtils = {
  // The library shows a warning once it holds more than this (it never stops saving).
  LIB_WARN_BYTES: 200 * 1024 * 1024,

  // Authors sometimes repeat a slide image back to back; keep only the first.
  dedupeConsecutive(urls) {
    return urls.filter((url, i) => i === 0 || url !== urls[i - 1]);
  },

  // Real number of questions (falls back to the block count for older data).
  questionTotal(data) {
    return typeof data.questionCount === 'number' ? data.questionCount : data.quiz.length;
  },

  // Safe for file names on Windows, macOS and Linux.
  sanitizeFilename(name) {
    return (name || '')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  },

  clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  },

  // Short fingerprint of what was extracted (notes, quiz, slide image paths).
  // Used to tell whether a saved week has changed on the LMS since it was saved.
  // Query strings are dropped from image URLs so session tokens can't cause false changes.
  hashContent(data) {
    const clean = (u) => String(u).split('?')[0];
    const payload = JSON.stringify([data.notes || [], data.quiz || [], (data.images || []).map(clean)]);
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < payload.length; i++) {
      const ch = payload.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  },
};