# H5P Weekly Extractor

A Chrome extension for University of Moratuwa BIT / CODL students. It reads the H5P lecture content on `online.codl.lk` and gives you each week as:

- **Notes (.txt):** the written notes and the quiz questions with the correct answers marked
- **Slides (.pdf):** the lecture slides as one PDF

It also keeps a personal **library** of the weeks you've saved, so you can download a whole subject as one zip. The files are handy for study, and for loading into a per-subject Claude Project for [BITprep](https://bitprep.tech) quiz practice.

Version 1.6.

## Install

The extension isn't on the Chrome Web Store yet, so load it by hand:

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the folder that contains `manifest.json`.

After updating the files, click the reload icon on the extension's card, then refresh any open LMS tab.

## Use it

1. Log in to `online.codl.lk` and open a week's H5P page.
2. A green floating button appears at the screen edge. Click it to open the panel.
3. In the panel:
   - **Notes (.txt)** and **Slides (.pdf)** download each file. The PDF is built in the background, so its button counts up ("Preparing 12/27") and then says **Download**.
   - **Download both** gets both files.
   - **Add to library** saves the week inside the extension. The button changes to **In library**.
   - The library icon next to it opens the full library page. The toolbar icon opens it too.
4. On the library page you can search, select weeks, download selected weeks or everything as one zip (one folder per subject), and remove weeks. Removing asks you to click twice.

You can drag the floating button anywhere along the screen edges, and it remembers where you left it. It hides itself while a video is fullscreen.

If a week uses an H5P content type the extension can't read yet (for example the video itself), the panel shows an amber "Not extracted: ..." line so you know something was left out.

## Settings

On the library page:

- **Show the floating button on H5P pages** (on by default).
- **Auto-save weeks to my library** (off by default). See below.
- **Show debug log** (off by default): shows what the extension is doing, useful when reporting a problem.

### Auto-save

When this is on, a week is saved to your library by itself once its files are ready, with no click needed. It follows a few rules:

- It never overwrites a week you already saved. If the lecture content changed since you saved it, the panel says so and the button becomes **Update**.
- If you remove a week from the library, auto-save won't put it back. Clicking **Add to library** yourself clears that.
- Only two PDFs are built at a time. Other weeks wait their turn, and a week you click on jumps the queue.
- If some slide images fail to load, auto-save skips that week and tells you. You can still save it by hand.
- The library shows an amber warning once it passes about 200 MB. Saving never stops.

Auto-save runs while the week's page is open in a tab and the floating button is enabled.

## Privacy

Everything stays on your computer. The extension only reads pages on `online.codl.lk` (using your own logged-in session), keeps the library in the browser's local storage, and sends nothing to any other server. Removing the extension removes its data.

## Limits

- Works on `online.codl.lk/mod/hvp/*` pages only.
- Quiz extraction covers Multiple Choice, Fill in the Blanks, Single Choice Set and Summary. Summary hasn't been checked against a real lecture yet.
- Each H5P activity of a week is its own entry ("Part 1", "Part 2") when a week has several.
- Not affiliated with, or endorsed by, CODL or the University of Moratuwa. Check your course's rules before sharing extracted lecture material with others.

## Project layout

```
manifest.json
src/
  background/   service worker (messages, downloads, library index)
  content/      detection, parser, floating button and panel
  offscreen/    PDF / txt / zip building and the PDF queue
  library/      the library page
  shared/       helpers, icons, IndexedDB wrapper
assets/         fonts, icons
vendor/         jsPDF, JSZip
```

There is no build step: it is plain JavaScript loaded straight by Chrome. Developer notes (load order, messages, storage, decisions) are in [CLAUDE.md](CLAUDE.md).

## Licence

Not chosen yet.