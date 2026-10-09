# CLAUDE.md — H5P Weekly Extractor

Read this first in any new chat about this project. Paste it (or point Claude at it)
before asking for changes. It describes the code as of **v1.5 with the `src/` layout**.

## What this is

A Manifest V3 Chrome extension for Dee's own use, to be shared with other University of
Moratuwa BIT/CODL students. It feeds the BITprep (bitprep.tech) content pipeline: Dee
generates weekly quiz banks per subject in a Claude Project fed with lecture material
(normally PDF slides). ITE 3313 Data Visualization and ITE 3533 Machine Learning (25S2)
only have interactive H5P content on the LMS (`online.codl.lk`, Moodle `mod/hvp`), with no
downloadable PDFs. The extension turns each H5P week into a `.txt` (notes + quiz Q&A) and a
`.pdf` (slides). Always write the brand as **"BITprep"**.

## Project layout

```
manifest.json
src/
  background/background.js    service worker: toolbar click, message relay, downloads
  content/                    runs on https://online.codl.lk/mod/hvp/*
    inject.js                 MAIN world: reads H5PIntegration, relays via postMessage
    parser.js                 H5P JSON tree -> notes, quiz, images (window.H5PExtractor)
    collect.js                requests raw data, breadcrumb, "Part N of M", collect()
    panel.js                  floating button + panel (Shadow DOM), drag/snap, status UI
    main.js                   detection, settings/storage listeners, init()
  offscreen/
    offscreen.html            loads vendor libs + shared + build.js + offscreen.js
    build.js                  buildBaseName, buildNotesText, buildSlidesPdf (pure builders)
    offscreen.js              cache, jobs (download / library / zip), progress messages
  library/                    the only UI page (opened from the toolbar icon)
    library.html  library.css  library-ui.js
  shared/
    utils.js                  H5PUtils: dedupeConsecutive, questionTotal, sanitizeFilename, clamp
    icons.js                  the one copy of the SVG icons: icon(), setBtn()
    library-db.js             IndexedDB wrapper (H5PDB)
assets/fonts, assets/icons    bundled Space Grotesk font and extension icons
vendor/                       jspdf.umd.min.js, jszip.min.js
```

There is no build step and no bundler. Scripts share globals, so **load order matters**:

- Content scripts (manifest): `icons.js, utils.js, parser.js, collect.js, panel.js, main.js`.
  `main.js` is last because it calls `init()` on load.
- Offscreen (`offscreen.html`): `jspdf, jszip, utils.js, library-db.js, build.js, offscreen.js`.
- Library (`library.html`): `icons.js, utils.js, library-db.js, library-ui.js`.

Top-level `let/const/function` names are global within one context, so a name must be
declared in exactly one file per context (a duplicate `const` is a SyntaxError that stops
the whole script). `build.js` calls `log()`, which lives in `offscreen.js`.

## Architecture

No DOM scraping and no network interception. The extension reads
`window.H5PIntegration.contents[cid].jsonContent` (a stringified JSON blob Moodle embeds)
and walks that tree.

**Message flow**
1. `inject.js` (MAIN world, the only place `H5PIntegration` is visible) answers a
   `postMessage` request from `collect.js` with the raw JSON.
2. `collect.js` parses it with `parser.js`, reads the Moodle breadcrumb (subject + week
   label) and works out "Part N of M" by fetching the week's course-page section.
3. `main.js` calls `showCard()` in `panel.js` (unless the `autoCard` setting is off) and the
   panel sends `prebuild` so files start building in the background immediately.
4. `background.js` relays build / download / library / zip requests to the **offscreen
   document**, creating it on demand.
5. `offscreen.js` builds the `.txt` and `.pdf`, and asks `background.js`
   (`offscreen-download`) to start the actual `chrome.downloads.download()`, because
   offscreen documents cannot use `chrome.downloads`.

**Job and status messages**
- `offscreen-job` `{job: 'download'|'library'|'zip', state: 'start'|'done'|'error', error?}`
  tells the library page what is running (it counts running jobs). The old `"Done."`
  log-string protocol is gone.
- `offscreen-status` goes to the originating tab: `pdf-progress` (building/ready/error),
  `saved` (txt/pdf/error), `library` (saving/saved/error).
- `offscreen-log` is debug text only. `app-error` is the background reporting a failed
  Chrome download.

**Offscreen cache** — `cache` is capped at 4 entries (least recently used evicted); an
evicted entry rebuilds from the data the page sends. Each entry remembers its last PDF
state (`pdfState`) and **replays it on `offscreen-prebuild`**, so a reloaded tab's fresh
"Preparing…" button learns the build is already done. (This fixed a button stuck on
"Preparing…" after a page reload.)

**`onDeterminingFilename`** in `background.js` claims our filenames; another extension with
the `downloads` permission (e.g. IDM) can otherwise rename the file and win the race.
Check for other download extensions first if filenames go wrong.

## Parser (`parser.js`)

- `AdvancedText` / `Text` / `Table` -> `notes`. `MultiChoice` / `Blanks` /
  `SingleChoiceSet` / `Summary` -> `quiz`. `Image` -> resolved URL via `contentUrl/path`.
- **Slides vs loose images:** images inside an `H5P.CoursePresentation` go to `slideImages`;
  all others go to `otherImages`. `images` = `slideImages` if any, else `otherImages`. Do not
  remove this split (lab screenshots once bloated a slide PDF).
- `bookCover` is skipped during the walk (it duplicates real slide 1).
- Structural containers are recursed into and never reported as unknown: `CoursePresentation`,
  `InteractiveBook`, `Column`, `Accordion`, `InteractiveVideo`.
- Any other H5P type found but not handled goes into `unknown`; the panel shows an amber
  "Not extracted: …" line. Empty `H5P.Summary` blocks are skipped.
- `questionCount` is the real question count (sets count once per item).
- `H5P.Summary` extraction (`summaries[].summary[]`, first string correct, plus `tip`) is
  **still unvalidated** against a real Summary that has statements.

## Filenames

`buildBaseName()` in `build.js`: `{subject} - {week label} - Part N`, sanitized by
`H5PUtils.sanitizeFilename`, with a timestamp fallback. Multiple H5P activities in a week are
**separate library entries** ("Part N"). The part lookup silently returns `{}` if the course
page can't be read (no suffix, no error). The selectors in `getPartInfo`
(`li.section, [data-for="section"], .course-section`, `a[href*="/mod/hvp/view.php"]`) have
**not been verified** against real markup.

## Library and storage

- `H5PDB` (IndexedDB, `library-db.js`) holds the `.txt`/`.pdf` blobs per saved week;
  `unlimitedStorage` avoids the quota.
- `chrome.storage.local` key `library` holds lightweight metadata per saved week.
- `chrome.storage.sync`: `autoCard` (show the floating button, default true), `debugLog`
  (show the debug log on the library page, default false), `fabPos {side, y}` (button
  position, synced across tabs).
- Saving to the library is **manual**. Pre-building files is automatic. "Download both"
  stays two separate files (no zip); zip is only for bulk library export (one folder per
  subject).

## UI

- Toolbar icon opens or focuses the library page (`chrome.action.onClicked`); there is no popup.
- Floating button: 46px green circle, draggable, snaps to the left/right edge. The panel opens
  above or below depending on space. Esc, outside click, or window blur (clicking into the H5P
  iframe) closes it. Hidden during fullscreen. A tick badge shows when the week is in the library.
- No visible log box: status is shown on buttons ("Zipping…", "Saving…", "Preparing n/m") and
  in red error banners (panel and library page). The debug log is a Settings toggle.
- Palette: page `#121212`, card `#1A1A1A`, hover `#202020`, border `#2A2A2A`, text
  `#FFFFFF`/`#8A8A8A`/`#4A4A4A`, brand green `#22C801` (hover `#1CA601`), warning `#F0B429`,
  error `#EF4444`. Font: Space Grotesk, bundled; the content script injects the `@font-face`
  into the page `<head>` (it does not work inside a shadow root).
- Icons are hand-rolled Lucide-style SVG built with `DOMParser` + `importNode` (no
  `innerHTML`). One copy only, in `shared/icons.js`, loaded by both the content scripts and
  the library page.
- Remove actions use a two-step confirm (`twoStep()` in `library-ui.js`).

## Permissions

`downloads`, `offscreen`, `storage`, `unlimitedStorage`, plus host permission for
`https://online.codl.lk/*`. `activeTab` and `scripting` were removed (unused).

## Known gaps and plans

- Tested on ITE 3313 and ITE 3533 only. Other subjects may use H5P types we haven't seen;
  the amber "Not extracted" line is how that will show up.
- Phase 2: an `autoSave` setting that saves detected weeks to the library without ever
  overwriting already-saved weeks (re-save stays manual), with at most 2 PDFs building at a
  time in the offscreen document.
- Phase 3: batch-save every H5P activity of a course from the course page (background tabs,
  about 3 s apart). Blocked on real HTML from an ITE3533 course-page week section (Inspect,
  then "Copy outer HTML" on the section element).
- Chrome Web Store: privacy policy and listing text are not written yet. Check CODL's terms
  about redistributing extracted lecture material (unresolved).

## Conventions for working on this project

- Dee wants **full file replacements**, not diffs, listed clearly with their paths.
- Terminal walkthroughs: **one step, then wait for the output** before continuing.
- Ask before guessing non-trivial UX/data decisions.
- Request the current source rather than assuming (use the file-collector script).
- Real bugs are found by Dee testing on live Moodle pages and sending screenshots or
  console output. There is no automated test setup.
- Before delivering JS: `node --check` each file, and lint the concatenated bundles (content
  and offscreen, in load order) for undefined or duplicate names.