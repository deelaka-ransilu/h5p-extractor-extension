// Library list, selection, remove, zip. Loaded by popup.html and library.html.
(() => {
  const $ = (id) => document.getElementById(id);
  const listEl = $('libList');
  if (!listEl) return;
  const zipSelBtn = $('zipSelBtn'), zipAllBtn = $('zipAllBtn'), rmSelBtn = $('rmSelBtn');
  const searchEl = $('libSearch'), storageEl = $('storageInfo'), logEl = $('log');
  const isFull = document.body.classList.contains('full');

  let items = [];
  let busy = false;
  let query = '';
  let rmArmed = false;
  let rmTimer = null;
  const selected = new Set();

  /* ---------- shared log (popup.js uses this too) ---------- */
  const hooks = { onDone: null };
  function log(msg, isError, reset) {
    if (!logEl) return;
    if (reset) logEl.textContent = '';
    logEl.hidden = false;
    logEl.classList.toggle('error', !!isError);
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
  window.H5PLog = { log, hooks };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action !== 'offscreen-log') return;
    log(msg.message, msg.message.startsWith('Error') || msg.message.startsWith('Download error'));
    if (msg.message === 'Done.') {
      busy = false;
      updateButtons();
      if (hooks.onDone) hooks.onDone();
    }
  });

  /* ---------- helpers ---------- */
  function sanitize(name) {
    return (name || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  function weekNum(label) {
    const m = /week\s*0*(\d+)/i.exec(label || '');
    return m ? parseInt(m[1], 10) : 999;
  }
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Click once = arm (shows a warning label), click again within 3.5s = run
  function twoStep(btn, idle, armedLabel, run) {
    let armed = false, timer = null;
    const reset = () => { armed = false; clearTimeout(timer); btn.classList.remove('danger'); idle(); };
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!armed) {
        armed = true;
        btn.classList.add('danger');
        setBtn(btn, 'trash', armedLabel);
        timer = setTimeout(reset, 3500);
      } else {
        reset();
        run();
      }
    });
    idle();
  }

  // Work out "Part N" for weeks with several activities, and the file names.
  function prepare(list) {
    const groups = {};
    list.forEach((it) => {
      const k = (it.subject || '') + '|' + (it.weekLabel || '');
      (groups[k] = groups[k] || []).push(it);
    });
    Object.values(groups).forEach((g) => {
      g.sort((a, b) => (a.partIndex || 0) - (b.partIndex || 0) || Number(a.cmid || 0) - Number(b.cmid || 0));
      g.forEach((it, i) => {
        if (it.partTotal > 1 && it.partIndex) it._part = it.partIndex;
        else it._part = g.length > 1 ? i + 1 : null;
      });
    });
    const used = new Set();
    list.forEach((it) => {
      const week = it.weekLabel ? it.weekLabel.replace(/:\s*/, ' - ') : it.title;
      let base = sanitize([it.subject, week, it._part ? 'Part ' + it._part : null].filter(Boolean).join(' - ')) || it.id;
      if (used.has(base)) base += ' (' + it.id + ')';
      used.add(base);
      it._base = base;
      it._label = (it.weekLabel ? it.weekLabel.replace(/:\s*/, ' – ') : it.title) + (it._part ? ' · Part ' + it._part : '');
    });
  }

  async function load() {
    const { library = {} } = await chrome.storage.local.get('library');
    items = Object.values(library);
    prepare(items);
    items.sort((a, b) =>
      (a.subject || '').localeCompare(b.subject || '') ||
      weekNum(a.weekLabel) - weekNum(b.weekLabel) ||
      (a._part || 0) - (b._part || 0)
    );
    Array.from(selected).forEach((id) => { if (!library[id]) selected.delete(id); });
  }

  function visible() {
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter((i) => (i._label + ' ' + (i.subject || '')).toLowerCase().includes(q));
  }

  /* ---------- actions ---------- */
  async function removeIds(ids) {
    for (const id of ids) {
      try { await H5PDB.del(id); } catch (e) {}
    }
    const { library = {} } = await chrome.storage.local.get('library');
    ids.forEach((id) => { delete library[id]; selected.delete(id); });
    await chrome.storage.local.set({ library }); // storage.onChanged re-renders
  }

  function zip(list) {
    if (!list.length) return;
    const subjects = new Set(list.map((i) => i.subject || 'Other'));
    const zipName = sanitize(subjects.size === 1 ? `${[...subjects][0]} - H5P content` : 'H5P library') + '.zip';
    busy = true;
    updateButtons();
    log(`Zipping ${list.length} week(s)…`, false, true);
    chrome.runtime.sendMessage({
      action: 'library-zip',
      zipName,
      items: list.map((i) => ({ id: i.id, folder: sanitize(i.subject) || 'H5P', fileBase: i._base })),
    });
  }

  /* ---------- drawing ---------- */
  function updateButtons() {
    const n = selected.size;
    document.querySelectorAll('[data-lib-count]').forEach((e) => { e.textContent = items.length ? `(${items.length})` : ''; });
    if (zipSelBtn) {
      setBtn(zipSelBtn, 'archive', `Download selected (${n})`);
      zipSelBtn.disabled = busy || n === 0;
    }
    if (zipAllBtn) {
      setBtn(zipAllBtn, 'download', 'Download all as zip');
      zipAllBtn.disabled = busy || items.length === 0;
    }
    if (rmSelBtn) {
      rmSelBtn.classList.toggle('danger', rmArmed);
      setBtn(rmSelBtn, 'trash', rmArmed ? 'Click again to remove' : `Remove selected (${n})`);
      rmSelBtn.disabled = n === 0;
    }
  }

  function draw() {
    listEl.textContent = '';
    const list = visible();

    if (!items.length) {
      const empty = h('div', 'empty');
      empty.append(icon('library', 28), h('div', null, 'Your library is empty. Open an H5P page and click “Add to library”. Saved weeks stay here so you can download them all later.'));
      listEl.appendChild(empty);
      updateButtons();
      return;
    }
    if (!list.length) {
      listEl.appendChild(h('div', 'empty', 'No weeks match your search.'));
      updateButtons();
      return;
    }

    const bySubject = {};
    list.forEach((it) => { const k = it.subject || 'Other'; (bySubject[k] = bySubject[k] || []).push(it); });

    Object.keys(bySubject).forEach((subject) => {
      const group = bySubject[subject];

      const head = h('div', 'subject');
      const name = h('div', 'sname');
      name.append(h('span', null, subject), h('span', 'count', String(group.length)));
      const actions = h('div', 'sactions');

      const selBtn = h('button', 'icon-btn');
      selBtn.title = 'Select / deselect all in this subject';
      selBtn.appendChild(icon('select', 15));
      selBtn.addEventListener('click', () => {
        const every = group.every((i) => selected.has(i.id));
        group.forEach((i) => (every ? selected.delete(i.id) : selected.add(i.id)));
        draw();
      });

      const zipBtn = h('button', 'icon-btn');
      zipBtn.title = `Download ${subject} as one zip`;
      zipBtn.appendChild(icon('archive', 15));
      zipBtn.addEventListener('click', () => zip(group));

      const rmBtn = h('button', 'icon-btn');
      rmBtn.title = `Remove all of ${subject} from the library`;
      twoStep(rmBtn, () => setBtn(rmBtn, 'trash', null), 'Remove all?', () => removeIds(group.map((i) => i.id)));

      actions.append(selBtn, zipBtn, rmBtn);
      head.append(name, actions);
      listEl.appendChild(head);

      group.forEach((it) => {
        const row = h('label', 'item');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(it.id);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(it.id); else selected.delete(it.id);
          updateButtons();
        });

        const text = h('div', 'text');
        let subText = `${it.notes} notes · ${it.quiz} questions · ${it.slides} slides`;
        if (isFull && it.savedAt) {
          subText += ' · saved ' + new Date(it.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        }
        text.append(h('div', 'name', it._label), h('div', 'sub', subText));

        const rm = h('button', 'icon-btn');
        rm.title = 'Remove from library';
        twoStep(rm, () => setBtn(rm, 'trash', null), 'Remove?', () => removeIds([it.id]));

        row.append(cb, text, rm);
        listEl.appendChild(row);
      });
    });

    updateButtons();
  }

  async function updateStorage() {
    if (!storageEl || !navigator.storage || !navigator.storage.estimate) return;
    try {
      const { usage = 0 } = await navigator.storage.estimate();
      storageEl.textContent = `${(usage / 1048576).toFixed(usage > 1e8 ? 0 : 1)} MB stored`;
    } catch (e) {}
  }

  async function refresh() {
    await load();
    draw();
    updateStorage();
  }
  window.H5PLibrary = { refresh };

  /* ---------- wiring ---------- */
  if (zipSelBtn) zipSelBtn.addEventListener('click', () => zip(items.filter((i) => selected.has(i.id))));
  if (zipAllBtn) zipAllBtn.addEventListener('click', () => zip(items));
  if (rmSelBtn) {
    rmSelBtn.addEventListener('click', () => {
      if (!selected.size) return;
      if (!rmArmed) {
        rmArmed = true;
        clearTimeout(rmTimer);
        rmTimer = setTimeout(() => { rmArmed = false; updateButtons(); }, 3500);
        updateButtons();
      } else {
        rmArmed = false;
        clearTimeout(rmTimer);
        removeIds(Array.from(selected));
      }
    });
  }
  if (searchEl) {
    const wrap = searchEl.parentElement;
    if (wrap) wrap.prepend(icon('search', 15));
    searchEl.addEventListener('input', () => { query = searchEl.value.trim(); draw(); });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.library) refresh();
  });

  refresh();
})();