# CLAUDE.md

Working notes for Claude (and humans) on this repo. Read this before changing code.

## What this is

**H5P Weekly Extractor** is a Chrome MV3 extension for University of Moratuwa BIT / CODL students. On `online.codl.lk` (Moodle, `mod/hvp` pages) it extracts the H5P lecture content of a week into:

- a `.txt` with the notes and the quiz questions and answers
- a `.pdf` with the lecture slides

The files are meant to be fed into per-subject Claude Projects for the BITprep (bitprep.tech) quiz pipeline. Always write the brand as **BITprep**.

Current version: **v1.6** (v1.5 UI overhaul + `src/` restructure + autoSave).

## Working rules

- Give **full file replacements** with the exact destination path, not diffs.
- Don't assume current source: ask for it via the file-collector script (single repo root, list the files needed).
- Ask before guessing non-trivial UX or data decisions.
- Terminal walkthroughs: **one step, then wait for the pasted output.**
- Platform: Windows, PowerShell. Git branch is `master` (not `main`).
- Match the existing UI: dark panel, green accent `#22C801`, font Space Grotesk, no emoji in the UI.

## Layout

```
manifest.json
README.md  CLAUDE.md  .gitignore
src/
  background/background.js     service worker: messaging hub, downloads, library index writes
  content/
    inject.js                  MAIN world: hands H5PIntegration data to the content script
    parser.js                  H5P JSON -> notes / quiz / images (window.H5PExtractor)
    collect.js                 reads page data, week/subject, "Part N of M"
    panel.js                   floating button + panel (Shadow DOM), autoSave trigger
    main.js                    entry: detect, show/hide, settings + message listeners
  offscreen/
    offscreen.html
    build.js                   buildBaseName, buildNotesText, imageUrlToDataUrl, buildSlidesPdf
    offscreen.js               cache, PDF queue, jobs, progress, library save, zip
  library/
    library.html  library.css  library-ui.js
  shared/
    utils.js                   H5PUtils (dedupe, questionTotal, sanitizeFilename, clamp, hashContent, LIB_WARN_BYTES)
    icons.js                   icon() / setBtn() (one copy, used by content + library)
    library-db.js              H5PDB: IndexedDB wrapper for the file blobs
assets/fonts  assets/icons
vendor/                        jspdf, jszip
```

There is no bundler. Files share globals inside one context, so:

**Script load order matters.**

- Content scripts: `icons.js, utils.js, parser.js, collect.js, panel.js, main.js`
- Offscreen html: `jspdf, jszip, utils.js, library-db.js, build.js, offscreen.js`
- Library html: `icons.js, utils.js, library-db.js, library-ui.js`

A top-level `let` / `const` / `function` name may be declared in **only one file per context**. After editing, concatenate the files of a context in load order and run `node --check` on the result to catch redeclarations.

`offscreen.js` uses `sendStatus()` (not `status()`, which clashes with `window.status`).

## How the pieces talk

Content script <-> background <-> offscreen document (the offscreen doc has no `chrome.storage` and no `chrome.downloads`).

| Message (`action`) | From -> to | Meaning |
|---|---|---|
| `h5p-detected` | content -> bg | green badge on the toolbar icon |
| `prebuild` | content -> bg -> offscreen (`offscreen-prebuild`) | start / replay the background build for this week |
| `buildAndDownload` | content -> bg -> offscreen (`offscreen-build`) | download txt / pdf / both |
| `library-add` | content -> bg -> offscreen (`offscreen-library-add`) | save to the library |
| `library-zip` | library -> bg -> offscreen (`offscreen-zip`) | zip selected weeks |
| `offscreen-download` | offscreen -> bg | bg calls `chrome.downloads` (filename via `onDeterminingFilename`) |
| `offscreen-status` | offscreen -> bg -> tab | `pdf-progress`, `saved`, `library` states for the panel |
| `offscreen-job` / `offscreen-log` / `app-error` | -> library page | job lifecycle, debug log, red banner |
| `offscreen-clear-queue` | bg -> offscreen | autoSave switched off: drop waiting PDF builds |
| `open-library` | content -> bg | open or focus the library tab |

`pdf-progress` states: `queued`, `building`, `ready` (with `skipped` / `incomplete`), `error`, `idle`.

## Storage

- `chrome.storage.sync`: `autoCard` (floating button, default on), `autoSave` (default **off**), `debugLog`, `fabPos` `{side, y}`.
- `chrome.storage.local`: `library` (map id -> meta), `removedIds` (array of ids removed on purpose).
- IndexedDB `h5p-library`, store `files`: id -> `{ txt: Blob, pdf: Blob|null }`.
- Library meta fields: `id` (`cm<cmid>`), `url`, `cmid`, `subject`, `weekLabel`, `title`, `notes`, `quiz`, `slides`, `partIndex`, `partTotal`, `hash`, `bytes`, `savedAt`.
- Entries saved before v1.6 have no `hash` / `bytes`. Treat missing as "unknown": no update prompt, size undercounted.

## autoSave rules (decided, built, tested)

1. Opt-in, **off by default**. Setting lives on the library page (the row is cloned from the "floating button" row by `library-ui.js`).
2. Fires once everything extractable has finished building: after the PDF is ready for weeks with slides, right after extraction for text-only weeks.
3. Never overwrites a saved week. If the content hash differs from the saved one, the panel shows "Content changed ... Update?" and the library button says **Update**. Accepting replaces the entry and sets `savedAt` to now.
4. A week removed from the library page is added to `removedIds` and not auto-saved again. A manual **Add to library** click clears that mark.
5. PDF build retries once on failure or when any slide image failed to load. If images still fail, autoSave skips the week and shows a red message; manual download still works.
6. Max **2** PDFs build at once. Others wait in a FIFO queue. A manual click moves that week to the front. Turning autoSave off clears non-manual queued builds (they go to `idle`, and Download builds on demand). Turning it on re-queues.
7. Ticking autoSave while a finished week page is open saves that page immediately.
8. Status shows in the panel's "In library" state and the floating button badge (no toasts).
9. Library warns (amber) above about 200 MB (`H5PUtils.LIB_WARN_BYTES`) but never stops saving.
10. Each part of a multi-part week saves as its own entry.

Known limits: autoSave only runs while the floating button is enabled and the week page is open (the panel code does the saving). The change check assumes slide image paths are stable between visits (query strings are ignored).

## Parser (`src/content/parser.js`)

Extracted: `H5P.AdvancedText` / `Text`, `Table`, `MultiChoice`, `Blanks`, `SingleChoiceSet`, `Summary`, `Image`, plus Course Presentation slide backgrounds. Structural containers that are only recursed into: `CoursePresentation`, `InteractiveBook`, `Column`, `Accordion`, `InteractiveVideo`. Anything else (for example the video file itself) is reported in the amber "Not extracted: ..." line.

- If a week has a slide deck, only the deck's images go into the PDF; loose images are a fallback.
- `H5P.Summary` is **not yet validated** against a real activity with statements.

## Known quirks and open items

- Library page: selecting a week, then searching so it is hidden, leaves it selected. **Remove selected (N)** can then act on weeks the person can't see. Fix: clear hidden selections or count visible only.
- Error banners are untested until a real failure shows one.
- `getPartInfo` selectors in `collect.js` (`li.section, [data-for="section"], .course-section`, `a[href*="/mod/hvp/view.php"]`) are unverified against real course-page markup.
- The "IDM Integration" warning on `chrome://extensions` is unrelated (IDM, another extension).
- CODL terms on redistributing extracted lecture material are unresolved. No LICENSE file has been chosen.

## Roadmap

- **Phase 3:** batch-save all H5P activities of a course from the course page. Blocked on real HTML of one week section of the ITE3533 course page (right-click the section, Inspect, Copy outer HTML).
- Chrome Web Store prep: privacy policy, listing text, check CODL terms.
- Optional `scripts/` folder (collector script, packaging script).

## Dev loop

1. Edit files, reload the extension at `chrome://extensions`.
2. Refresh the H5P tab (content scripts don't hot-reload).
3. If the extension card shows an **Errors** button, read it first.
4. Commit one git step at a time: `git add -A`, `git status --short`, `git commit -m "..."`, `git push`.