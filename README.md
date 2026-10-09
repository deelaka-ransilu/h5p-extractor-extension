# H5P Weekly Extractor

A Chrome (Manifest V3) extension for University of Moratuwa BIT/CODL students. It detects interactive H5P lecture content on the CODL Moodle (`online.codl.lk`), and turns each week into:

- a **`.txt`** file with the lecture notes and quiz questions (correct answers flagged), and
- a **`.pdf`** file with the lecture slides, one slide per page.

Saved weeks are kept in a personal **library** inside the extension, and can be exported as one zip.

It was built to feed lecture material into per-subject Claude Projects for the BITprep quiz pipeline, for subjects whose content only exists as H5P activities with no downloadable PDF.

## Features

- **Automatic detection.** On any `online.codl.lk/mod/hvp/*` page, a small green floating button appears when H5P content is found.
- **Draggable floating button.** Drag it anywhere along the left or right edge. It remembers its position (synced across tabs) and hides itself during fullscreen video.
- **Download panel.** Click the button to see the week title, note/question/slide counts, and download `.txt`, `.pdf`, or both.
- **Background building.** Files start building as soon as the page is detected, so downloads are usually instant.
- **Personal library.** Save weeks with "Add to library". A tick on the button shows when the current week is already saved.
- **Zip export.** Download selected weeks, a whole subject, or the entire library as one zip (one folder per subject).
- **Multiple activities per week.** Each H5P activity is saved separately as "Part N".
- **Honest about gaps.** If a page contains an H5P content type the extension can't read yet, the panel shows an amber "Not extracted: …" line instead of silently missing it.
- **Local only.** Everything is processed in your browser. Nothing is sent to any server.

## Install (unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).
5. Pin the extension if you like. Clicking its toolbar icon opens the library.

## Usage

1. Log in to `online.codl.lk` and open an H5P activity (a URL like `/mod/hvp/view.php?id=…`).
2. Wait for the green floating button to appear, then click it.
3. Choose **Download .txt**, **Download .pdf**, or **Download both**, or click **Add to library** to keep the week.
4. Open the library (toolbar icon, or the library button in the panel) to select weeks and **Download selected** or **Download all as zip**.

### Settings

Found at the bottom of the library page:

- **Show the floating button on H5P pages**: on by default. Turn it off to hide the button everywhere.
- **Show debug log**: off by default. Shows a text log of what the extension is doing, useful when reporting a bug.

## How it works

No page scraping and no network interception. Moodle embeds each activity's content as JSON in `window.H5PIntegration`, and the extension walks that tree.

```
inject.js (page world)  ->  content scripts (isolated)  ->  background.js (service worker)
  reads H5PIntegration       collect.js: parser.js, breadcrumb    relays work to the
  and relays it via          panel.js: floating button + panel    offscreen document,
  postMessage                main.js: detection and settings      runs chrome.downloads

                                                              offscreen.js + build.js
                                                                builds .txt, .pdf (jsPDF),
                                                                zips (JSZip), stores blobs
                                                                in IndexedDB
```

Key points:

- **`inject.js`** runs in the page's `MAIN` world, the only place `H5PIntegration` is visible, and relays the raw data to the content script.
- **`parser.js`** recursively walks the H5P tree. It extracts text (`AdvancedText`, `Text`, `Table`), quiz content (`MultiChoice`, `Blanks`, `SingleChoiceSet`, `Summary`), and images. Slide images (inside a `CoursePresentation`) are kept separate from loose images so lab screenshots don't pollute the slide PDF. Structural containers (`CoursePresentation`, `InteractiveBook`, `Column`, `Accordion`, `InteractiveVideo`) are recursed into.
- **`collect.js`, `panel.js`, `main.js`** (content scripts) gather the page data, draw the floating button and panel inside a Shadow DOM so the page's CSS can't affect it, and handle detection and settings.
- **`offscreen.js` and `build.js`** live in an offscreen document because it can hold blob URLs reliably through the browser's download flow. `build.js` makes the files; `offscreen.js` keeps a small least-recently-used cache of built files (4 entries), replays a finished build's state to a reloaded page, and reports progress with job messages (`offscreen-job`: start / done / error).
- **`background.js`** opens the library from the toolbar icon, relays messages, and claims download filenames (`onDeterminingFilename`) so other download-related extensions can't rename the files.
- **Storage.** File blobs live in IndexedDB (`library-db.js`). Lightweight metadata (subject, week, counts, save date) lives in `chrome.storage.local`. Settings and the button position live in `chrome.storage.sync`.

## Project structure

```
manifest.json
src/
  background/background.js   Service worker: toolbar icon, message relay, downloads
  content/
    inject.js                Page-world script that exposes H5PIntegration data
    parser.js                H5P JSON tree -> notes, quiz, images
    collect.js               Reads page data, breadcrumb and "Part N of M"
    panel.js                 Floating button + panel (Shadow DOM)
    main.js                  Detection, settings listeners, startup
  offscreen/
    offscreen.html           Offscreen document page
    build.js                 Builds the .txt and .pdf
    offscreen.js             Cache, download / library / zip jobs, progress
  library/                   The library page (library.html, library.css, library-ui.js)
  shared/
    utils.js                 Small helpers used everywhere
    icons.js                 SVG icons (single copy)
    library-db.js            IndexedDB wrapper for the file blobs
assets/                      Bundled font (Space Grotesk, SIL OFL) and extension icons
vendor/                      jsPDF and JSZip (bundled)
CLAUDE.md                    Architecture notes and conventions for AI-assisted work
```

There is no build step: the scripts are plain files that share globals, listed in load order in
`manifest.json`, `offscreen.html` and `library.html`.

## Permissions

| Permission | Why |
| --- | --- |
| `downloads` | Save the generated `.txt`, `.pdf` and `.zip` files |
| `offscreen` | Build files in an offscreen document |
| `storage` | Library metadata, settings and button position |
| `unlimitedStorage` | PDFs are large; avoids the default storage quota |
| `https://online.codl.lk/*` | Run on the CODL Moodle and fetch slide images using your logged-in session |

## Known limitations

- Only tested against ITE 3313 (Data Visualization) and ITE 3533 (Machine Learning). Other subjects may use H5P types that aren't handled yet; they will appear as "Not extracted: …".
- `H5P.Summary` extraction hasn't been validated against a real activity with statements.
- Videos themselves are not extracted (they carry no text); quizzes and summaries inside interactive videos are.
- Plan: an auto-save setting, and batch-saving every H5P activity in a course.

## Responsible use

This tool only helps you save content you can already see while logged in to your own account. Lecture material belongs to the University and its lecturers. Use extracted files for your own study, and check the CODL terms before sharing them with anyone.