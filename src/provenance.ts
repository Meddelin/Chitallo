// Provenance of a PDF: a licensed book, or a publicly available article?
// The verdict routes the knowledge-graph extraction and nothing else. A book is
// read ONLY by the local model on the reader's own machine; an article may be
// handed to Claude Code, which means its pages leave this computer. So the two
// mistakes this module can make are not symmetric at all: calling an article a
// book costs a slower, dumber graph for that one file, while calling a book an
// article ships somebody's copyrighted text to a cloud service and cannot be
// taken back. Everything below is tilted to make the second mistake hard.
//
// The tilt is implemented three ways, all deliberate. First, «article» needs a
// larger margin than «book» (ARTICLE_MARGIN vs BOOK_MARGIN): the permissive
// verdict has to be earned. Second, a hard book signal — an ISBN is not
// enough, but a printed reproduction ban is — vetoes «article» outright, no
// matter how much article-shaped evidence piled up on the other side. Third,
// when the margin is small the answer is «unknown», and the CALLER TREATS
// UNKNOWN AS LICENSED: graphgen refuses to deepen an unknown file with Claude
// exactly as it refuses a book. That is what makes an under-confident
// classifier safe rather than useless — an unsure verdict degrades the graph,
// never the reader's rights — and it is why absence of evidence is never
// counted as evidence here. A blank, meta-less scan scores nothing, lands on
// «unknown», and stays local.
//
// Why this is a scoring table and not a model call. A model would be slower
// (seconds against microseconds, on every book the library ever opens),
// non-deterministic (the same file classified twice could route differently,
// and the reader would have no way to reason about it), unexplainable to the
// reader who has to trust the routing — and, worst of all, circular: asking a
// model whether these pages may be sent to a model means sending the pages
// first. The classifier that guards the boundary must sit on this side of it.
//
// Why the evidence strings are not in i18n. They quote what was actually found
// inside the file — «ISBN 978-5-4461-1938-6», «arXiv:2401.01234», «Preprint
// submitted to Elsevier» — and quoting is not translating: a Russian UI must
// still show the English line the file really prints, or the reader cannot
// check the verdict against the page. The three signals that have nothing to
// quote (page count, a contents list, a back index) carry a short factual
// Russian label instead. The whole set is 1..4 lines, shown verbatim under
// «Почему» — the panel does its own wrapping, so these are observations, not
// sentences, and they end without a full stop.
//
// Pure function: no IO, no model, no async, no state. Everything the verdict
// depends on arrives in the argument, which is what makes it cheap to call on
// every open and trivial to reason about. The one import is a type.

import type { Provenance } from "./graphstore";

/// What the classifier concluded, how firmly, and the observations behind it.
/// `confidence` is confidence in THIS verdict: 0.5..1 for a decided one,
/// below 0.5 for «unknown», where it reports how close the file came to being
/// decided rather than how sure we are that it is undecidable.
export type Verdict = { prov: Provenance; confidence: number; evidence: string[] };

/// The PDF's own document-information dictionary, as pdf.js hands it over.
/// Every field is optional because half the files in a real library have none.
export type Meta = {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  producer?: string;
  creator?: string;
};

// ---- where a signal is allowed to look --------------------------------------
// Scoping matters as much as the regex. «All rights reserved» on the copyright
// page is the publisher speaking; the same words quoted three hundred pages
// in, inside a screenshot caption, are not. The caller already narrows the
// text for us — the first three pages and the last one — and each row narrows
// it further, so a signal cannot fire from the wrong end of the file.
type Field =
  | "front" // plain text of the first 3 pages: title, abstract, copyright page
  | "back" // plain text of the last page: back index, colophon, back cover
  | "text" // front + back, for signals that legitimately live at either end
  | "tools" // Producer + Creator: the typesetting toolchain, a strong tell
  | "bib"; // Title + Subject + Keywords + Author: the bibliographic fields

type Side = "article" | "book";

// A row of the table. `min` marks a COUNTED signal — the regex must then carry
// /g and the row must carry a fixed `note`, because String.match on a global
// regex returns plain strings with no capture groups to quote from.
type Rule = {
  side: Side;
  weight: number;
  where: Field;
  re: RegExp;
  min?: number;
  note?: string | ((m: RegExpMatchArray) => string);
};

// ---- the scoring table ------------------------------------------------------
// Read as data, top to bottom, strongest first within each side. Weights are
// on one scale: 5 decisive on its own, 4 decisive AND vetoing, 3 strong, 2
// corroborating, 1 a hint that only matters next to something else. Nothing
// here subtracts — a row that does not match contributes nothing at all,
// because a book is not proved by the absence of an abstract.
//
// One trap, paid for once and worth naming: \b in JavaScript is ASCII-only —
// its idea of a word character is [A-Za-z0-9_] — so a Cyrillic alternative
// written behind a \b can NEVER match, silently. The first draft of this table
// did exactly that, and «Поступила в редакцию», «Том 12, № 3», «Издательство»
// and «Тираж 2000 экз.» scored nothing at all on obviously Russian files,
// which is the one failure mode nobody would notice: the verdict merely drifts
// towards «unknown» on half the library. Every row that mixes scripts
// therefore carries /u and spells the boundary out as a \p{L} lookaround; the
// purely ASCII rows keep \b, where it means what it says.
const SIGNALS: readonly Rule[] = [
  // ---- article -------------------------------------------------------------
  {
    // An arXiv identifier is stamped down the spine of the first page by arXiv
    // itself, on a copy arXiv is distributing publicly. Nothing else in this
    // table is as close to a licence statement. Both id schemes: the modern
    // 2401.01234 and the legacy cs.CL/0703001.
    side: "article",
    weight: 5,
    where: "text",
    re: /\barXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i,
    note: (m) => `arXiv:${m[1]}`,
  },
  {
    // Conference and journal boilerplate. The ACM permission block and the
    // «ACM Reference Format» heading appear on the first page of the camera
    // ready and nowhere else; the IEEE line is its counterpart. A book has no
    // reason to carry either.
    side: "article",
    weight: 3,
    where: "front",
    re: /permission to make digital or hard copies|acm reference format|ieee transactions on|personal use is permitted, but republication/i,
  },
  {
    // «Preprint» is the author saying, in print, that this copy is the open
    // one. Russian «препринт» is the same claim.
    side: "article",
    weight: 3,
    where: "front",
    re: /(?<![\p{L}\p{N}])(?:preprint|препринт[а-яё]*)(?![\p{L}])/iu,
  },
  {
    // Submission state: only a manuscript has one. «Поступила в редакцию» is
    // the Russian journal's own received-on stamp and is worth as much.
    side: "article",
    weight: 3,
    where: "front",
    re: /(?<![\p{L}\p{N}])(?:submitted to|to appear in|accepted (?:at|to|for publication)|under review at|направлено в редакцию|поступила в редакцию|принято к печати)(?![\p{L}])/iu,
  },
  {
    // A volume/issue/pages line is the address of an article inside a serial.
    // Books have editions, not issues.
    side: "article",
    weight: 3,
    where: "front",
    re: /(?<![\p{L}\p{N}])(?:vol(?:ume)?\.?\s*\d{1,3}\s*[,(]\s*(?:no|issue|iss|№)\.?\s*\d{1,3}|том\s*\d{1,3}\s*,?\s*(?:вып(?:уск)?\.?|№)\s*\d{1,3})/iu,
  },
  {
    // An «Abstract» heading standing on its own line, or IEEE's run-in form
    // «Abstract—This paper…». A book's blurb is on the cover, never headed
    // like this. Russian «Аннотация»/«Реферат» behave identically.
    side: "article",
    weight: 3,
    where: "front",
    re: /^[ \t]*(?:abstract|аннотация|реферат)[ \t]*$|(?<![\p{L}\p{N}])(?:abstract|аннотация)\s*[—–]\s*\S/imu,
  },
  {
    // An open licence settles the question the routing actually cares about:
    // this copy is meant to be redistributed. Deliberately worth as much as a
    // journal line even though a CC-licensed BOOK also matches — such a book
    // is still one we are allowed to send.
    side: "article",
    weight: 3,
    where: "text",
    re: /\b(?:this work is licensed under|creative commons|cc[ -]by(?:[ -](?:sa|nc|nd))*\b|open[ -]access|открытый доступ|лицензи[ия][а-яё]*\s+creative commons)/i,
  },
  {
    // Overleaf writes itself into Producer only for documents drafted in it,
    // and books are not drafted in it.
    side: "article",
    weight: 3,
    where: "tools",
    re: /\bOverleaf\b/i,
  },
  {
    // A DOI on the opening pages usually resolves to a journal landing page —
    // but Springer and CRC stamp a book DOI on the copyright page too, so this
    // corroborates and never decides on its own.
    side: "article",
    weight: 2,
    where: "front",
    re: /\b(?:doi:\s*|doi\.org\/)(10\.\d{4,9}\/[^\s"'<>,;]+)/i,
    note: (m) => `DOI ${snip(m[1])}`,
  },
  {
    // A venue line. Proceedings volumes are books when bound and articles when
    // downloaded one paper at a time, which is exactly why this is a 2.
    side: "article",
    weight: 2,
    where: "front",
    re: /(?<![\p{L}\p{N}])(?:in proceedings of|proceedings of the|труды\s+[^\n]{0,20}конференции|материалы\s+[^\n]{0,20}конференции)(?![\p{L}])/iu,
  },
  {
    // An e-mail address among the opening pages is an author affiliation
    // block. Publishers print a website, a postal address and a support line —
    // almost never a person's mailbox.
    side: "article",
    weight: 2,
    where: "front",
    re: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/,
    note: (m) => `e-mail @${snip(m[1])} на первых страницах`,
  },
  {
    // The TeX toolchain. Only a 2: a large minority of technical books are set
    // in LaTeX as well, so this leans without deciding.
    side: "article",
    weight: 2,
    where: "tools",
    re: /\b(?:pdfTeX|XeTeX|LuaTeX|LaTeX|dvips|dvipdfm|TeX Live|MiKTeX)\b/i,
  },
  {
    // Journal-ish bibliographic metadata: templates fill Subject with the
    // serial's name, which survives even when the text layer is a scan.
    side: "article",
    weight: 2,
    where: "bib",
    re: /(?<![\p{L}\p{N}])(?:proceedings|journal of|transactions on|preprint|manuscript|вестник|журнал)(?![\p{L}])/iu,
  },
  {
    // A keyword list under the abstract. Alone it proves nothing — hence 1 —
    // but it almost always sits next to a signal that does.
    side: "article",
    weight: 1,
    where: "front",
    re: /^[ \t]*(?:keywords?|index terms|ключевые слова)\s*[:—–-]/im,
  },
  {
    // Word as the producer says «not professionally typeset», which nudges
    // away from a published book without saying much about what it is.
    side: "article",
    weight: 1,
    where: "tools",
    re: /\bMicrosoft.{0,3}\s*Word|\bWord\s*\d{4}\b/i,
  },

  // ---- book ----------------------------------------------------------------
  {
    // An ISBN is the registration of a commercially published edition. Both
    // ISBN-10 and ISBN-13, with or without the hyphens.
    side: "book",
    weight: 5,
    where: "text",
    re: /\bISBN(?:[-\s]?1[03])?\s*[:\s]\s*((?:97[89][-\s]?)?[\d][\d\s-]{7,15}[\dXx])/i,
    note: (m) => `ISBN ${snip(m[1])}`,
  },
  {
    // The printed reproduction ban — the publisher forbidding, in the file
    // itself, the thing we would be doing. This is the hard signal: any row at
    // HARD_BOOK or above vetoes an «article» verdict outright.
    side: "book",
    weight: 4,
    where: "text",
    re: /no part of this (?:publication|book|work|document) may be reproduced|unauthori[sz]ed (?:reproduction|copying)|никакая часть (?:данн|эт|настоящ)[а-яё]*\s+(?:книги|публикации|издания|работы)|охраняется законом об авторском праве/i,
  },
  {
    // A book publisher's imprint. Springer and Elsevier are missing on
    // purpose: they run journals too, and their name on page 1 is as likely to
    // be a serial's masthead as an imprint.
    side: "book",
    weight: 3,
    where: "text",
    re: /(?<![\p{L}\p{N}])(?:O['’]Reilly|Manning Publications|Packt Publishing|No Starch Press|Apress|Addison[- ]Wesley|Prentice Hall|Pearson Education|John Wiley|Wiley & Sons|The MIT Press|Cambridge University Press|Oxford University Press|Routledge|CRC Press|Chapman & Hall|Morgan Kaufmann|Morgan & Claypool|Издательств[оа]|ДМК Пресс|Альпина|Бомбора|БХВ)(?![\p{L}])/iu,
  },
  {
    // Page-layout and e-book toolchains. InDesign and QuarkXPress mean a
    // designer laid this out page by page; calibre and Sigil mean it came out
    // of an e-book library; ABBYY means somebody scanned a printed volume.
    //
    // The scanner names after ABBYY are here for exactly ABBYY's reason and
    // were found the hard way: the reader's own 838-page volume carries
    // «Adobe Acrobat Pro 11.0.20 Paper Capture Plug-in» — Adobe's OCR — and
    // scored nothing at all on this row, because nobody had written down that
    // Adobe's own scanner plug-in means the same thing ABBYY does. A scanned
    // file has no ISBN block and no copyright page for the front-matter rules
    // to find, so this row is often the only book-side signal such a file has
    // besides its length.
    side: "book",
    weight: 3,
    where: "tools",
    re: /\b(?:InDesign|QuarkXPress|calibre|Sigil|FrameMaker|Antenna House|Vellum|ABBYY|Kindle|Paper Capture|ScanSnap|ScanJet|CamScanner|Epson Scan|Readiris|FineReader)/i,
  },
  {
    // A back-of-book index on the last page. Counted, not matched: one stray
    // «Term, 45» is nothing, sixty of them on one page is an apparatus no
    // article has ever had. The binding regex is the one booktranslate.ts uses
    // for isIndexPage — copied rather than imported on purpose: importing it
    // would drag pdf.js, the Tauri fs plugin and the whole translation engine
    // into a module whose entire value is being pure and cheap, and its
    // signature takes Paragraph[], which the classifier does not have.
    side: "book",
    weight: 3,
    where: "back",
    re: /[\p{L}][\p{L}\p{N})\]'’.-]{0,2},\s*\d{1,3}(?:\s*[–—-]\s*\d{1,3})?(?=[\s,]|$)/gu,
    min: 12,
    note: "предметный указатель в конце",
  },
  {
    // «All rights reserved» is a book's copyright page — but also, less often,
    // a conference paper's footer, so it corroborates rather than decides.
    side: "book",
    weight: 2,
    where: "text",
    re: /\ball rights reserved\b|все права защищены/i,
  },
  {
    // A copyright line naming a company rather than a person: the shape of an
    // imprint we do not have on the list above.
    side: "book",
    weight: 2,
    where: "text",
    re: /©\s*(?:19|20)\d\d[^\n]{0,40}?\b(?:Press|Publishing|Publishers|Publications|Ltd|Inc)\b/,
  },
  {
    // Print-run furniture: an edition statement, a printing country, a Russian
    // colophon. Only a printed book has a print run.
    side: "book",
    weight: 2,
    where: "text",
    re: /(?<![\p{L}\p{N}])(?:first published|first (?:edition|printing)|(?:second|third|fourth|revised) edition|printed (?:in|and bound)|подписано в печать|тираж\s+\d+|издание\s+(?:перв|втор|треть|четвёрт)[а-яё]*)(?![\p{L}])/iu,
  },
  {
    // A real table of contents among the opening pages. Counted the same way
    // and for the same reason as the index: a heading, whitespace, a bare page
    // number. A long survey sometimes carries a short contents list, which is
    // why this is a 2.
    //
    // What ENDS the entry is the whole difficulty of this rule, and it has been
    // got wrong twice. The shape is adapted from booktranslate.ts's isTocPage,
    // which applies it per paragraph to space-joined text and so ends the entry
    // on a literal ` `. Here the haystack is the front matter joined with
    // newlines (graphgen builds it as front.map(paraText).join("\n"), and
    // paraText joins paragraphs with "\n" too), so every contents entry is
    // followed by "\n": the literal space matched nothing at all and the rule
    // never fired. Widening it to `(?=\s|$)` fixed that and broke the other
    // side, because any whitespace then satisfies the lookahead — «Figure 1
    // shows» and «Table 3 lists» counted as contents entries, and eight such
    // phrases in an article's front matter dragged the verdict to «unknown» and
    // cost that file the Claude pass it was entitled to.
    //
    // The fact that actually separates the two is positional: a contents entry
    // carries its page number at the END of its line, while a number in running
    // prose is followed by more prose. So the rule is anchored to a line end.
    // The /m is load-bearing and must not be dropped — without it `$` matches
    // only at the very end of the whole string, the rule can fire at most once,
    // never reaches min: 8, and therefore never fires at all. Those are the 2
    // points whose loss let a 45-page booklet printing a nine-entry contents
    // list score «article» on its pdfTeX producer and an author's e-mail — and
    // «article» is the one verdict that sends the file off this machine, which
    // cannot be undone. The neighbouring index rule matches mid-line by design,
    // where entries run several to a line, and keeps its [\s,] lookahead.
    //
    // What SEPARATES the label from the page number was the third way to get
    // this wrong, and it cost the same 2 book points as the first two. Demanding
    // a run of literal spaces scores zero on the two commonest ways a contents
    // page is actually typeset — dot or middot leaders («Введение ..... 7») and
    // a tab — so a properly typeset book contributed nothing and drifted towards
    // «article» exactly like the booklet above. The separator is therefore a run
    // of leader characters: spaces of any width (\p{Zs} catches the non-breaking
    // and thin spaces a text layer is full of), tabs, full stops, middots,
    // bullets, ellipses and en/em dashes. At least one is still required, so a
    // label welded to its number is not a contents entry.
    //
    // The two branches differ only in what may stand immediately before the run,
    // and the split is what keeps the widening honest. A run of plain whitespace
    // keeps the original letter-or-bracket label, because «Глава» and «12 34 56»
    // are not distinguishable once a digit may end the label — nine rows of a
    // numeric table in the front matter would otherwise have counted as a
    // contents list. A run containing a real leader glyph is typography nobody
    // produces by accident, so there the label may end in a digit and «Глава 1
    // ..... 12» counts, as it must.
    side: "book",
    weight: 2,
    where: "front",
    re: /(?:[\p{L})\]][\p{Zs}\t]+|[\p{L}\p{N})\]][\p{Zs}\t]*[.·•‧∙⋅…–—][\p{Zs}\t.·•‧∙⋅…–—]*)\d{1,3}\s*$/gmu,
    min: 8,
    note: "оглавление в начале",
  },
  {
    // A series line. Weak by itself — journals have series too — but it is
    // the shape of a publisher's catalogue entry.
    side: "book",
    weight: 1,
    where: "text",
    re: /(?<![\p{L}\p{N}])(?:библиотека\s+[«"А-ЯЁ]|серия\s*[:«"]|book series|series editor)/iu,
  },
];

// ---- the page-count ladder --------------------------------------------------
// Length is the only signal every file has, so it must be graded rather than
// thresholded: a step function that hands 3 points to a 10-page file and 3 to
// a 500-page one, and nothing at all across the wide middle where reports,
// theses, standards and long papers overlap and length genuinely means
// nothing. Note the asymmetry it inherits from the margins: 3 points are
// enough on their own to call a thick file a book (BOOK_MARGIN), and never
// enough on their own to call a thin one an article (ARTICLE_MARGIN) — a
// twelve-page scan with no text layer and no metadata stays «unknown», and
// therefore stays on this machine.
//
// The ladder used to stop at 3 points for everything over 400 pages, and that
// ceiling was measured to be too low twice over. On the reader's own 838-page
// scanned volume it gave book 3 against article 2 — the TeX toolchain row —
// so the margin was 1 against a BOOK_MARGIN of 3 and an obvious book came out
// «unknown». Worse, on a 900-page textbook whose front matter carries a DOI,
// an editor's e-mail and a «Journal of…» subject line the article side reached
// 9 against that same 3 and the verdict was «article» at 0.58 confidence —
// i.e. the table's own last comment, «nobody writes a 400-page article», was
// written down but never enforced. Nothing below 400 pages moves, which is
// what keeps the 200-400 band where open-access theses live exactly as it was.
const PAGE_STEPS: readonly { upTo: number; side: Side; weight: number }[] = [
  { upTo: 12, side: "article", weight: 3 }, // a paper's normal length
  { upTo: 30, side: "article", weight: 2 }, // a long paper or a chapter offprint
  { upTo: 45, side: "article", weight: 1 }, // a survey; still nobody's book
  { upTo: 90, side: "article", weight: 0 }, // the dead zone: reports, theses, standards
  { upTo: 200, side: "book", weight: 1 }, // a thin book, or a very long report
  { upTo: 400, side: "book", weight: 2 }, // an ordinary book
  { upTo: 600, side: "book", weight: 3 }, // a thick one: a textbook, a handbook
  { upTo: 800, side: "book", weight: 4 }, // at this length the binding is the evidence
  { upTo: Infinity, side: "book", weight: 5 }, // a reference work or an omnibus volume
];

// ---- thresholds -------------------------------------------------------------
// The whole asymmetry of the module lives in these seven numbers.
const ARTICLE_MARGIN = 5; // to send pages away: a decisive signal, or three corroborating ones
const BOOK_MARGIN = 3; // to keep them here: much less, because keeping them costs nothing
const HARD_BOOK = 4; // a fired book row at this weight forbids «article» outright
const CONF_SPAN = 6; // margin above the threshold that counts as full confidence
const EVIDENCE_MAX = 4; // the panel shows this many lines and no more

// The length veto, the mirror image of HARD_BOOK. Above ARTICLE_MAX_PAGES the
// permissive verdict must be EARNED by a row that is itself a distribution
// licence, never accumulated out of corroborating hints — which is how a
// 900-page textbook with a DOI, an e-mail address and a journal-shaped subject
// line used to be classified «article» and have its terms shipped off the
// machine. HARD_ARTICLE = 5 selects exactly one row today, the arXiv
// identifier, and it is exempt for a real reason: long lecture-note volumes
// and book drafts are posted to arXiv routinely, by the people who wrote them,
// on a copy arXiv is distributing. The Creative-Commons row (weight 3)
// deliberately does NOT exempt — «creative commons» also matches a
// figure-credit line in the front matter of a copyrighted book, and at this
// length the cost of believing it is the irreversible one.
//
// A veto can only ever move a verdict towards «unknown», and the caller treats
// «unknown» exactly as «book», so the worst this can cost is a slower,
// local-only graph for one file.
const ARTICLE_MAX_PAGES = 400;
const HARD_ARTICLE = 5;

const SNIP_MAX = 48;

// A PDF text layer is full of hard line breaks and column gutters, and the
// panel prints evidence verbatim — so every quote is flattened to one short
// line before it is shown.
function snip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= SNIP_MAX ? one : `${one.slice(0, SNIP_MAX - 1).trimEnd()}…`;
}

// Russian plural for the one evidence line that has nothing to quote. Written
// out here rather than routed through t(): the evidence set is deliberately
// outside i18n (see the header), and t() would need a plural form for a string
// that is not a translation of anything.
function pagesWord(n: number): string {
  const ones = n % 10;
  const tens = n % 100;
  if (ones === 1 && tens !== 11) return "страница";
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return "страницы";
  return "страниц";
}

function noteOf(r: Rule, m: RegExpMatchArray): string {
  if (typeof r.note === "string") return r.note;
  if (typeof r.note === "function") return r.note(m);
  return snip(m[0]);
}

// ---- the classifier ---------------------------------------------------------

/// Weigh a document's front matter, its last page, its metadata and its length
/// and decide how the knowledge graph may read it. Returns «unknown» whenever
/// the evidence is thin or contradictory; the caller must treat «unknown»
/// exactly as it treats «book», i.e. local model only.
export function classify(input: {
  pages: number;
  meta: Meta;
  front: string; // plain text of the first 3 pages, joined
  back: string; // plain text of the last page
}): Verdict {
  const front = input.front ?? "";
  const back = input.back ?? "";
  const meta = input.meta ?? {};
  const hay: Record<Field, string> = {
    front,
    back,
    text: `${front}\n${back}`,
    tools: `${meta.producer ?? ""} ${meta.creator ?? ""}`,
    bib: `${meta.title ?? ""} ${meta.subject ?? ""} ${meta.keywords ?? ""} ${meta.author ?? ""}`,
  };

  const hits: { side: Side; weight: number; text: string }[] = [];
  let art = 0;
  let bk = 0;
  let hardBook = false;
  let hardArticle = false;

  for (const r of SIGNALS) {
    // String.match resets lastIndex itself, so the module-level regexes stay
    // reusable even with /g — .exec would carry state between two classify
    // calls and silently skip signals on the second file.
    const m = hay[r.where].match(r.re);
    if (!m) continue;
    if (r.min !== undefined && m.length < r.min) continue;
    const text = noteOf(r, m).trim();
    if (!text) continue;
    hits.push({ side: r.side, weight: r.weight, text });
    if (r.side === "article") {
      art += r.weight;
      if (r.weight >= HARD_ARTICLE) hardArticle = true;
    } else {
      bk += r.weight;
      if (r.weight >= HARD_BOOK) hardBook = true;
    }
  }

  const pages = Math.max(0, Math.round(input.pages || 0));
  if (pages > 0) {
    const step = PAGE_STEPS.find((s) => pages <= s.upTo);
    if (step && step.weight > 0) {
      hits.push({ side: step.side, weight: step.weight, text: `объём ${pages} ${pagesWord(pages)}` });
      if (step.side === "article") art += step.weight;
      else bk += step.weight;
    }
  }

  // The verdict. Note that the article branch carries all three guards: the
  // wider margin, the reproduction-ban veto, and the length veto — so a file
  // that prints its own reproduction ban can never be sent away however many
  // arXiv ids the front matter quotes, and neither can a nine-hundred-page
  // volume that merely looks journal-shaped.
  const margin = Math.abs(art - bk);
  const tooLongForArticle = pages > ARTICLE_MAX_PAGES && !hardArticle;
  let prov: Provenance = "unknown";
  if (bk > art && margin >= BOOK_MARGIN) prov = "book";
  else if (art > bk && margin >= ARTICLE_MARGIN && !hardBook && !tooLongForArticle) prov = "article";

  // Confidence. A verdict that just cleared its threshold is a 0.5; one that
  // cleared it by CONF_SPAN or more is a 1. «Unknown» is reported below 0.5 as
  // a fraction of the threshold it failed to reach — the reader sees how close
  // the call was, and the routing does not care either way.
  let confidence: number;
  if (prov === "unknown") {
    const thr = art > bk ? ARTICLE_MARGIN : BOOK_MARGIN;
    confidence = Math.min(0.49, (0.5 * margin) / thr);
  } else {
    const thr = prov === "article" ? ARTICLE_MARGIN : BOOK_MARGIN;
    confidence = 0.5 + 0.5 * Math.min(1, (margin - thr) / CONF_SPAN);
  }

  // Evidence, strongest first within each side, ties keeping table order —
  // which is already strongest-first. A decided verdict leads with the side
  // that won and lets the other side follow if there is room. An UNDECIDED one
  // alternates instead, and that is the whole point: «unknown» is almost
  // always a contradiction, and the four lines have to show both halves of it
  // or «Почему» answers the wrong question. A paper carrying a publisher's
  // reproduction ban must show the ban, not four more reasons it looks like a
  // paper — the ban is why it stays on this machine.
  const byWeight = (a: { weight: number }, b: { weight: number }) => b.weight - a.weight;
  const lead = (prov === "unknown" ? (art >= bk ? "article" : "book") : prov) as Side;
  const won = hits.filter((h) => h.side === lead).sort(byWeight);
  const lost = hits.filter((h) => h.side !== lead).sort(byWeight);
  const ordered: typeof hits = [];
  if (prov === "unknown") {
    for (let i = 0; i < Math.max(won.length, lost.length); i++) {
      if (won[i]) ordered.push(won[i]);
      if (lost[i]) ordered.push(lost[i]);
    }
  } else ordered.push(...won, ...lost);
  const evidence: string[] = [];
  for (const h of ordered) {
    if (evidence.length >= EVIDENCE_MAX) break;
    if (!evidence.includes(h.text)) evidence.push(h.text);
  }

  return { prov, confidence: Math.round(confidence * 100) / 100, evidence };
}
