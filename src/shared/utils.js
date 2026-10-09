// Small helpers shared by the content scripts, the offscreen document and the library page.
// A plain global object: none of those contexts has a module system.
const H5PUtils = {
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
};