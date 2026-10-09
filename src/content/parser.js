/**
 * H5P content extractor.
 *
 * Input: the parsed object from JSON.parse(H5PIntegration.contents[cid].jsonContent)
 * plus the content's base URL (H5PIntegration.contents[cid].contentUrl) for
 * resolving relative image paths.
 *
 * Output: { notes, quiz, questionCount, unknown, images, slideImages, otherImages }
 *   notes         -> plain-text blocks from AdvancedText/Text/Table
 *   quiz          -> quiz entries (MultiChoice, Blanks, SingleChoiceSet, Summary)
 *   questionCount -> real number of questions (a SingleChoiceSet / Summary counts
 *                    once per item, not once per block)
 *   unknown       -> [{ library, count }] H5P content types that were found but
 *                    NOT extracted (e.g. H5P.Video), so missing output is visible
 *   slideImages   -> images found inside an H5P.CoursePresentation (the real slides)
 *   otherImages   -> H5P.Image elements found anywhere else (e.g. lab screenshots in notes)
 *   images        -> what goes into the PDF: slideImages if the week has a slide deck,
 *                    otherwise otherImages as a fallback
 */

// Containers we recurse into but that carry no extractable content of their own.
// They are NOT reported as "unknown".
const STRUCTURAL_LIBS = [
  'H5P.CoursePresentation',
  'H5P.InteractiveBook',
  'H5P.Column',
  'H5P.Accordion',
  'H5P.InteractiveVideo', // we recurse into it, so quizzes/summaries inside are still extracted; the video file itself has no text
];

function baseLib(library) {
  return (library || '').split(' ')[0];
}

function isStructural(library) {
  const base = baseLib(library);
  return STRUCTURAL_LIBS.some((s) => base === s);
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function resolveImageUrl(path, contentUrl) {
  if (!path) return null;
  return `${contentUrl}/${path}`;
}

function extractQuizFromMultiChoice(params, subContentId) {
  return {
    type: 'MultiChoice',
    subContentId,
    question: stripHtml(params.question),
    options: (params.answers || []).map(a => ({
      text: stripHtml(a.text),
      correct: !!a.correct,
    })),
  };
}

function extractQuizFromBlanks(params, subContentId) {
  // Blanks encodes answers inline as *answer1/answer2:hint* inside params.questions[]
  const raw = (params.questions || []).join('\n\n');
  // pull out *...* segments as the "answer key", keep readable text with blanks marked
  const withBlanksMarked = raw.replace(/\*([^*]+)\*/g, (_, inner) => {
    const answerPart = inner.split(':')[0]; // "answer1/answer2" possibly
    return `[BLANK: ${answerPart}]`;
  });
  return {
    type: 'Blanks',
    subContentId,
    question: stripHtml(withBlanksMarked),
    options: [], // answers are embedded inline above, not a discrete option list
  };
}

function extractQuizFromSingleChoiceSet(params, subContentId) {
  return {
    type: 'SingleChoiceSet',
    subContentId,
    // SingleChoiceSet nests multiple choices, each with its own question + answers
    items: (params.choices || []).map(c => ({
      question: stripHtml(c.question),
      // convention: first answer in the array is the correct one for SingleChoiceSet
      answers: (c.answers || []).map(stripHtml),
      correctAnswer: c.answers && c.answers.length ? stripHtml(c.answers[0]) : null,
    })),
  };
}

function extractQuizFromSummary(params, subContentId) {
  // H5P.Summary: params.summaries[] each has `summary: [correct, wrong1, wrong2, ...]`
  // (the FIRST string is the correct statement) and an optional `tip`.
  // Not yet validated against a real Summary activity from the LMS.
  const items = (params.summaries || [])
    .map((s) => {
      const list = Array.isArray(s.summary) ? s.summary.map(stripHtml) : [];
      return {
        correct: list[0] || null,
        wrong: list.slice(1).filter(Boolean),
        tip: stripHtml(s.tip),
      };
    })
    .filter((i) => i.correct);
  return {
    type: 'Summary',
    subContentId,
    intro: stripHtml(params.intro),
    items,
  };
}

function walk(node, ctx, out) {
  if (!node || typeof node !== 'object') return;

  // node shapes vary: sometimes {library, params, subContentId, metadata},
  // sometimes {content: {library, params, ...}}, sometimes plain arrays.
  const actual = node.content && node.content.library ? node.content : node;
  const library = actual.library || '';
  const params = actual.params;
  // subContentId sometimes sits on `actual` itself, sometimes on the wrapper (node)
  const subContentId = actual.subContentId || node.subContentId;

  // Are we inside a Course Presentation (the real slides)?
  const inSlides = ctx.inSlides || library.startsWith('H5P.CoursePresentation');
  const childCtx = inSlides === ctx.inSlides ? ctx : { ...ctx, inSlides };

  let handled = false;

  if (library.startsWith('H5P.AdvancedText') || library.startsWith('H5P.Text')) {
    handled = true;
    if (params && params.text) out.notes.push(stripHtml(params.text));
  } else if (library.startsWith('H5P.Table')) {
    handled = true;
    if (params && params.text) out.notes.push(stripHtml(params.text));
  } else if (library.startsWith('H5P.MultiChoice')) {
    handled = true;
    out.quiz.push(extractQuizFromMultiChoice(params, subContentId));
  } else if (library.startsWith('H5P.Blanks')) {
    handled = true;
    out.quiz.push(extractQuizFromBlanks(params, subContentId));
  } else if (library.startsWith('H5P.SingleChoiceSet')) {
    handled = true;
    out.quiz.push(extractQuizFromSingleChoiceSet(params, subContentId));
  } else if (library.startsWith('H5P.Summary')) {
    handled = true;
    if (params && Array.isArray(params.summaries)) {
      const summary = extractQuizFromSummary(params, subContentId);
      // Authors sometimes leave an empty "Untitled Summary" in a video: skip those
      if (summary.items.length) out.quiz.push(summary);
    }
  } else if (library.startsWith('H5P.Image')) {
    handled = true;
    if (params && params.file && params.file.path) {
      const url = resolveImageUrl(params.file.path, ctx.contentUrl);
      if (ctx.inSlides) out.slideImages.push(url);
      else out.otherImages.push(url);
    }
  } else if (actual.imageSlideBackground && actual.imageSlideBackground.path) {
    // CoursePresentation slide background (no H5P subcontent library wrapper —
    // just a raw file descriptor under slideBackgroundSelector.imageSlideBackground)
    const url = resolveImageUrl(actual.imageSlideBackground.path, ctx.contentUrl);
    if (ctx.inSlides) out.slideImages.push(url);
    else out.otherImages.push(url);
  }

  // A content type we saw but don't extract: remember it so the UI can warn
  if (library && !handled && !isStructural(library)) {
    const name = baseLib(library);
    out._unknown[name] = (out._unknown[name] || 0) + 1;
  }

  // recurse into anything that looks like nested content
  for (const key of Object.keys(actual)) {
    if (key === 'bookCover') continue; // skip the book's title-slide cover image — not a real slide
    const val = actual[key];
    if (Array.isArray(val)) {
      val.forEach(item => walk(item, childCtx, out));
    } else if (val && typeof val === 'object') {
      walk(val, childCtx, out);
    }
  }
}

/**
 * @param {object} jsonContentParsed - JSON.parse(contents[cid].jsonContent)
 * @param {string} contentUrl - contents[cid].contentUrl
 */
function extractH5PContent(jsonContentParsed, contentUrl) {
  const out = {
    notes: [], quiz: [], images: [], slideImages: [], otherImages: [],
    _unknown: {},
  };
  walk(jsonContentParsed, { contentUrl, inSlides: false }, out);

  // Slides win. Only fall back to loose images if the week has no slide deck.
  out.images = out.slideImages.length ? out.slideImages : out.otherImages;

  // Real question count: sets count once per item
  out.questionCount = out.quiz.reduce((n, q) => n + (q.items ? q.items.length : 1), 0);

  out.unknown = Object.entries(out._unknown).map(([library, count]) => ({ library, count }));
  delete out._unknown;
  return out;
}

// Expose as a global for the content script (no module system in a content script context)
window.H5PExtractor = { extractH5PContent, stripHtml };