# CLAUDE.md — H5P Weekly Extractor

Read this first in any new chat about this project. It replaces re-explaining
context from scratch. Paste this file (or point Claude at it) before asking
for changes.

## What this is

A Manifest V3 Chrome extension, **"H5P Weekly Extractor,"** built for Dee's
own use and for sharing with other University of Moratuwa BIT/CODL students.
It's a side tool that feeds the [[bitprep]] (bitprep.tech) content pipeline:
Dee generates weekly quiz banks per subject via a Claude Project fed with
lecture material (normally PDF slides). Two subjects — ITE 3313 Data
Visualization and ITE 3533 Machine Learning (25S2) — only have interactive
H5P content on the LMS (`online.codl.lk`, Moodle, `mod/hvp`), with no
downloadable PDFs. This extension extracts that content into a `.txt`
(notes + quiz Q&A) and a `.pdf` (slides), which then get fed into the
subject's Claude Project as source material.

Note: brand is always **"BITprep,"** never "BitPrep" — same convention
applies loosely here even though this extension is a standalone tool, not
part of the bitprep.tech codebase itself.

## Core architecture

No DOM scraping, no network interception. The extension reads
`window.H5PIntegration.contents[cid].jsonContent` — a stringified JSON blob
Moodle/H5P embeds directly in the page — and walks that tree.

**Message flow for extraction:**
1. `inject.js` runs in the page's **MAIN world** (only place `H5PIntegration`
   is visible) and relays the raw JSON via `postMessage` on request.
2. `content.js` (isolated world, has `chrome.runtime`) requests that data,
   parses it with `parser.js` (`window.H5PExtractor`), and also reads the
   Moodle breadcrumb (`getBreadcrumbInfo()`) for subject code + week label.
3. `parser.js` walks the H5P tree recursively and returns
   `{ notes, quiz, images, slideImages, otherImages }`.
4. `background.js` (service worker) relays build/download requests to an
   **offscreen document**, because offscreen docs are the only place that
   can reliably hold a `blob:` URL through a native Save-As dialog without
   losing the filename.
5. `offscreen.js` builds the `.txt` (plain text) and `.pdf` (jsPDF, one
   image per page) and hands blob URLs back to `background.js` for the
   actual `chrome.downloads.download()` call.

**Why the offscreen document exists at all:** popups close the moment a
native Save-As dialog steals focus, which either randomizes blob-URL
filenames or (for `data:` URLs) makes Chrome ignore the suggested filename
and fall back to `download.ext`. The offscreen document persists through
the save dialog.

**Why `chrome.downloads.onDeterminingFilename` exists in `background.js`:**
even with the offscreen fix, another installed extension with `downloads`
permission (e.g. a video downloader) can rename the file and win the race.
Explicitly claiming the filename in `onDeterminingFilename` fixed this in
testing. Worth remembering if filenames ever go wrong again — check for
other download-related extensions first.

## Parser details (`parser.js`)

- Content type → output:
  - `H5P.AdvancedText` / `H5P.Text` / `H5P.Table` → plain-text `notes`
    (HTML stripped via `stripHtml()`)
  - `H5P.MultiChoice` / `H5P.Blanks` / `H5P.SingleChoiceSet` / `H5P.Summary`
    → `quiz` entries with correct answers flagged
  - `H5P.Image` → resolved to a real URL via `contentUrl + "/" + file.path`
- **Slides vs. loose images:** images are split into `slideImages` (found
  while `inSlides` context is true — i.e. inside an `H5P.CoursePresentation`)
  and `otherImages` (everything else, e.g. a lab screenshot embedded in a
  notes page). `out.images` = `slideImages` if any exist, else falls back to
  `otherImages`. **This was a real bug once:** before this split existed,
  lab/figure images embedded in lecture notes got mixed into the slide PDF
  alongside the actual `CoursePresentation` slides, bloating Week 07's PDF
  hugely. Don't remove this split.
- **`bookCover` is explicitly skipped** during the tree walk — H5P's
  `InteractiveBook` sets a `bookCover.coverMedium` image that's visually
  identical to real slide 1, and including it produced an apparent
  duplicated first slide.
- `H5P.Summary`'s answer-key extraction is **speculative and never
  fully validated** against a real Summary interaction — treat its output
  with suspicion if a week uses that type.
- Parser currently only recognizes the content types listed above. A new
  H5P subtype appearing in an untested week/subject will silently produce
  no notes/quiz for that block (not a crash, just missing output) — worth
  a quick JSON dump-and-inspect if a week's counts look too low.

## Filenames

Built in `offscreen.js` (`buildBaseName`) from `{subject} - {week label} -
{part}` (breadcrumb-derived), OS-invalid characters (`\ / : * ? " < > |`)
stripped via `sanitizeFilename()`, with a timestamp fallback if everything
comes back empty. **Part numbering:** when a week has multiple H5P
activities, `content.js`'s `getPartInfo()` fetches the week's section on the
Moodle course page (using the logged-in session) and finds this activity's
index among that week's `mod/hvp` links, producing "Part 1 of 3" etc. If
that lookup ever fails, it silently returns `{}` (no part suffix) rather
than erroring.

## Library / storage (added after the initial extractor)

- **IndexedDB** (`library-db.js`, `H5PDB`) holds the actual file blobs
  (`.txt` + `.pdf` per saved week), keyed by content ID. `unlimitedStorage`
  permission avoids `chrome.storage`'s 10 MB cap — two subjects × ~13 weeks
  × ~4 MB PDFs adds up fast.
- **`chrome.storage.local`** (`library` key) holds only lightweight metadata
  per saved item (subject, weekLabel, title, counts, savedAt, part info) so
  the UI can render the list instantly without touching IndexedDB.
- **Files are pre-built on page detection**, whether or not the user saves —
  `background.js`'s `prebuild` message triggers `offscreen.js` to start
  building the `.txt`/`.pdf` in the background as soon as H5P content is
  found, cached by page URL (`cache` Map in `offscreen.js`). "Add to
  library" then just writes the already-built blobs to IndexedDB — no
  rebuild, so it's fast.
- **Decision (explicit, from Dee):** multiple H5P activities in one week are
  **not merged** — each becomes its own library entry with a "Part N"
  suffix. Saving is **manual** (a button), not automatic on page load —
  but the *building* happens automatically in the background regardless of
  whether the user ever clicks save.
- Export is a **zip** (JSZip, built in `offscreen.js`'s `handleZip`), with
  one folder per subject. Note: **the two-file-per-week download (Download
  both) is deliberately NOT zipped** — Dee wants separate `.txt`/`.pdf` for
  direct upload into the Claude Project workflow; zip only makes sense for
  bulk library export.

## UI / theme

- Palette (also used in `ui.css` and the in-page card's inline `CARD_CSS`):
  page `#121212`, card `#1A1A1A`, hover `#202020`, border `#2A2A2A`,
  text `#FFFFFF`/`#8A8A8A`/`#4A4A4A`, brand green `#22C801`
  (hover `#1CA601`), warning `#F0B429`, error `#EF4444`. These match Dee's
  Tailwind `@theme` tokens from another project — keep consistent if asked
  to restyle.
- Font: Space Grotesk, bundled locally (`fonts/SpaceGrotesk.woff2`) and
  loaded via a `@font-face` injected into the *page's* `<head>` (not the
  shadow root — `@font-face` doesn't work scoped inside shadow DOM).
- **In-page floating card** (`content.js`, Shadow DOM, `CARD_CSS`) appears
  bottom-right on detected H5P pages: shows week title, note/question/slide
  counts, Download .txt / .pdf / both buttons, Add to library, and a link to
  open the full library page.
- **Icons:** hand-rolled inline SVG (Lucide-style paths), built via
  `DOMParser` + `importNode`, no `innerHTML`. Duplicated in three places
  (`content.js`'s `ICON_PATHS`, `icons.js`'s `ICON_PATHS`) — if adding a new
  icon, it currently needs to go in both. `icons.js` is the one loaded by
  `popup.html`/`library.html`; `content.js` has its own inline copy since
  it can't easily import a separate script into its Shadow DOM context.
- **Toolbar popup** (`popup.html`/`popup.js`): two tabs, "This page" (same
  actions as the floating card) and "Library" (list, search, select, zip,
  remove). Loads `icons.js`, `library-db.js`, `library-ui.js`.
- **Full-page library** (`library.html`): same `library-ui.js` logic as the
  popup's Library tab, rendered full-width (`body.full` CSS variants) with
  more room, plus a storage-usage readout via `navigator.storage.estimate()`.
  Opened via `background.js`'s `open-library` handler, which focuses an
  existing tab if one's already open rather than duplicating it.
- Remove actions use a **two-step confirm** pattern (`twoStep()` in
  `library-ui.js`): first click arms the button ("Click again to remove"),
  a second click within 3.5s confirms, otherwise it resets. Applies to
  per-week, per-subject, and bulk-selected removal.

## Known open items / discussed-but-not-yet-built

A UI overhaul was discussed and planned in detail but **has not been
implemented** as of the current file structure (popup.html/popup.js still
exist, the floating card is still a fixed corner card, not a draggable
floater). If picking this back up, the agreed plan was:

- **Phase 1:** toolbar icon opens/focuses the library directly (remove
  `popup.html`/`popup.js` and `default_popup` from the manifest); remove the
  visible log box (replace with button-level status + a small red error
  banner, with an optional "Debug log" toggle in Settings); turn the fixed
  in-page card into a **draggable, edge-snapping floating button** (like a
  Next.js dev-mode indicator) that expands into the current panel on click
  and collapses on Esc/outside-click; hides during fullscreen video.
- **Phase 2:** an "auto-save weeks to library" setting (still respects
  "don't overwrite already-saved weeks" — re-save stays manual), with the
  offscreen document limited to building 2 PDFs at a time to avoid memory
  spikes from many tabs opened at once.
- **Phase 3:** batch-save all H5P activities in a course from the course
  page itself (open each in a background tab, save, close, ~3s delay
  between), to avoid the tab-hopping Dee was doing manually. **Blocked on**
  Dee sending real HTML from an ITE3533 course-page week section — the
  selectors for grouping activities by week were never written because
  they need to match real Moodle markup, not guessed.

Other known gaps:
- Only tested against ITE 3313 Data Visualization; **ITE 3533 Machine
  Learning has not been tested** — could use H5P subtypes the parser
  doesn't handle yet, or a different breadcrumb structure.
- `libs/jszip.min.js` is used again now (for the zip-export feature) —
  an earlier handoff called it dead weight, that's no longer true.
- Manifest permissions `activeTab` and `scripting` were flagged as unused
  and worth removing before any Chrome Web Store submission (Web Store
  review checks for unused permissions).
- No privacy policy or store listing text written yet.
- Copyright/permissions consideration flagged but unresolved: the tool only
  helps a student view content they're already entitled to see, but wider
  distribution of extracted lecture material is a separate question from
  distributing the extraction tool itself — worth checking CODL's terms
  before any public release.

## Conventions for working on this project

- Dee wants **full file replacements**, not diffs, sent one at a time (or a
  small clearly-listed set) — this matches the [[bitprep]] working
  preference too.
- Ask before guessing UX/data decisions on anything non-trivial (e.g. the
  "merge multi-part weeks or not" and "manual vs auto-save" choices were
  both explicitly asked and answered before building).
- Request the actual current source before making edits — file contents
  drift from what's in chat history (e.g. `icon.js` vs `icons.js` naming
  slip caught by inspecting the real file tree, not assumed).
- Real bugs so far were almost always caught by Dee testing against live
  Moodle pages and sending screenshots/console output — there's no
  automated test setup for this extension.