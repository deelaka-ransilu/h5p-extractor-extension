// Reads the H5P data from the page and works out which week / part it belongs to.
// Content-script world: shares globals with parser.js, panel.js and main.js.
// inject.js (page world) hands us the raw H5PIntegration data via postMessage.

let cachedData = null;

function requestRawData() {
  return new Promise((resolve) => {
    function handler(event) {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'H5P_EXTRACTOR_RESPONSE') return;
      window.removeEventListener('message', handler);
      resolve(event.data);
    }
    window.addEventListener('message', handler);
    window.postMessage({ type: 'H5P_EXTRACTOR_REQUEST' }, '*');

    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ error: 'Timed out waiting for page data. Try reloading the page.' });
    }, 3000);
  });
}

function getBreadcrumbInfo() {
  const items = Array.from(document.querySelectorAll('.breadcrumb-item')).map((item) =>
    item.textContent.trim().replace(/\s+/g, ' ')
  );
  return {
    subject: items[0] || null,
    weekLabel: items.length >= 2 ? items[items.length - 2] : null,
  };
}

// If a week has several H5P activities, find which one this is ("Part 2 of 3")
// by reading the week's section on the course page, in the order Moodle lists them.
async function getPartInfo(cmid) {
  try {
    if (!cmid) return {};
    const crumbs = document.querySelectorAll('.breadcrumb-item');
    const weekCrumb = crumbs.length >= 2 ? crumbs[crumbs.length - 2] : null;
    const anchor = weekCrumb && weekCrumb.querySelector('a');
    if (!anchor) return {};

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(anchor.href, { credentials: 'include', signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return {};

    const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
    const idRe = new RegExp('[?&]id=' + cmid + '(&|$)');
    const link = Array.from(doc.querySelectorAll('a[href*="/mod/hvp/view.php"]')).find((a) =>
      idRe.test(a.getAttribute('href') || '')
    );
    if (!link) return {};

    const section = link.closest('li.section, [data-for="section"], .course-section');
    if (!section) return {};

    const ids = [];
    section.querySelectorAll('a[href*="/mod/hvp/view.php"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/[?&]id=(\d+)/);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    });
    const idx = ids.indexOf(String(cmid));
    if (idx < 0) return {};
    return { partIndex: idx + 1, partTotal: ids.length };
  } catch (e) {
    return {};
  }
}

// Everything we know about this page's H5P content (cached after the first call)
async function collect() {
  if (cachedData) return cachedData;

  const raw = await requestRawData();
  if (raw.error) return { error: raw.error };

  let parsed;
  try {
    parsed = JSON.parse(raw.jsonContent);
  } catch (e) {
    return { error: 'Failed to parse jsonContent: ' + e.message };
  }

  const result = window.H5PExtractor.extractH5PContent(parsed, raw.contentUrl);
  const cmid = new URLSearchParams(location.search).get('id');
  const part = await getPartInfo(cmid);

  cachedData = {
    key: location.href,
    id: cmid ? 'cm' + cmid : location.pathname + location.search,
    cmid,
    title: raw.title,
    ...getBreadcrumbInfo(),
    ...part,
    ...result,
  };
  return cachedData;
}