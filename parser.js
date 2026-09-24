/**
 * H5P content extractor.
 *
 * Input: the parsed object from JSON.parse(H5PIntegration.contents[cid].jsonContent)
 * plus the content's base URL (H5PIntegration.contents[cid].contentUrl) for
 * resolving relative image paths.
 *
 * Output: { notes: [...], quiz: [...], images: [...], slideImages: [...], otherImages: [...] }
 *   notes       -> plain-text blocks from AdvancedText/Text/Table
 *   quiz        -> { type, question, options: [{text, correct}], subContentId }
 *   slideImages -> images found inside an H5P.CoursePresentation (the real slides)
 *   otherImages -> H5P.Image elements found anywhere else (e.g. lab screenshots in notes)
 *   images      -> what goes into the PDF: slideImages if the week has a slide deck,
 *                  otherwise otherImages as a fallback
 */

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

  if (library.startsWith('H5P.AdvancedText') || library.startsWith('H5P.Text')) {
    if (params && params.text) out.notes.push(stripHtml(params.text));
  } else if (library.startsWith('H5P.Table')) {
    if (params && params.text) out.notes.push(stripHtml(params.text));
  } else if (library.startsWith('H5P.MultiChoice')) {
    out.quiz.push(extractQuizFromMultiChoice(params, subContentId));
  } else if (library.startsWith('H5P.Blanks')) {
    out.quiz.push(extractQuizFromBlanks(params, subContentId));
  } else if (library.startsWith('H5P.SingleChoiceSet')) {
    out.quiz.push(extractQuizFromSingleChoiceSet(params, subContentId));
  } else if (library.startsWith('H5P.Summary')) {
    if (params && params.summaries) {
      out.quiz.push({
        type: 'Summary',
        subContentId,
        intro: stripHtml(params.intro),
        summaries: params.summaries.map(s => stripHtml(s.subContentId ? (s.text || '') : '')),
      });
    }
  } else if (library.startsWith('H5P.Image')) {
    if (params && params.file && params.file.path) {
      const url = resolveImageUrl(params.file.path, ctx.contentUrl);
      if (ctx.inSlides) out.slideImages.push(url);
      else out.otherImages.push(url);
    }
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
  const out = { notes: [], quiz: [], images: [], slideImages: [], otherImages: [] };
  walk(jsonContentParsed, { contentUrl, inSlides: false }, out);

  // Slides win. Only fall back to loose images if the week has no slide deck.
  out.images = out.slideImages.length ? out.slideImages : out.otherImages;
  return out;
}

// Expose as a global for the content script (no module system in a content script context)
window.H5PExtractor = { extractH5PContent, stripHtml };