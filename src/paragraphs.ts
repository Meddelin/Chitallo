// Shared paragraph-clustering heuristics for PDF text.
// Two consumers feed Word rects into buildFrags/growParagraph/paraText:
//   - App.tsx paragraphAround (Alt+click): DOM text-layer spans → client rects
//   - booktranslate.ts (whole-book engine): pdfjs TextContent items → page CSS px
// The math is identical for both — keep it that way: these heuristics are
// verified against real books (single paragraph per Alt+click, hanging-indent
// lists intact, figure-caption left-edge immunity).

export type Rect = { left: number; top: number; right: number; bottom: number };
// key: opaque back-reference for DOM callers (the source span element)
export type Word = { rect: Rect; text: string; key?: unknown };
export type Frag = { words: Word[]; top: number; bottom: number; left: number; right: number };
// prose = translatable text (body, headings, list items, real-sentence captions);
// other = display formulas / figure innards / tables / garbled glyph runs —
// the v2 typesetter shows an image crop of the region instead of a translation;
// caption = "Figure N:"-style paragraph adjacent to a detected figure region —
// never translated, never flowed as text: its bbox is merged into the region,
// so the region's image crop shows figure + caption exactly as the original;
// furniture = running header/footer page furniture (repeated section titles,
// printed page numbers) — never translated AND never rendered at all: the
// reflow replaces the original page geometry, so its navigation aids are
// noise there (see detectFurniture below)
export type ParaKind = "prose" | "other" | "caption" | "furniture";
// fh: median glyph (font) height of the paragraph's items, in the units of the
// viewport passed to clusterParagraphs (the book engine passes scale 1)
export type Paragraph = { x: number; y: number; w: number; h: number; text: string; fh: number; kind: ParaKind };
// One typeset LINE of a paragraph (frags on the same baseline band unioned).
// Kept OUT of Paragraph on purpose: it is engine-only working geometry (the
// cross-page stitch below needs first/last line edges, the store must not grow
// four numbers per line per paragraph). clusterParagraphsEx returns it parallel
// to the paragraph list; clusterParagraphs drops it, so every existing caller
// and the persisted store shape are untouched.
export type LineBox = { top: number; left: number; right: number };

// djb2 — same scheme as Library.tsx's cover-cache keys, so every per-book file
// under appDataDir is named by the same hash of the book path
export const hash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

// Giant glyphs: Springer-style section headings draw a huge section number
// (~3x body size) whose BASELINE lands on the NEXT text line — the first body
// line for one-line titles, the title's own second line for wrapped ones.
// Y-banding welds number+neighbor into one frag (the number's glyph box
// swallows that line's center); the welded frag's inflated top then (a)
// absorbs an adjacent line as a trailing "next line" and (b) detaches the
// welded text line from its own paragraph (seen: "2.4 <first body sentence>
// <title text>" translated as one block, next block starting mid-thought).
// The cure is a post-pass over built frags: split a frag at word boundaries
// where the glyph-height ratio between neighbors reaches GIANT and the big
// side is also GIANT x the page's median line height. BOTH conditions matter:
// the page-relative one keeps figure-label pairs (a 15px Venn label beside 8px
// text) and small outliers (4px nested-list bullets beside 10px text, the
// small side of the cliff) welded as before; the local one keeps mixed-height
// formula lines intact. Sub/superscripts (~0.7x), heading titles (1.2x), and
// LaTeX display operators (body matrix scale) never split. The split-off
// giant becomes its own frag; clusterParagraphs re-attaches it to the right
// PARAGRAPH afterwards (see the adoption pass there).
export const GIANT = 1.8;

// 1) Y-lines: words whose vertical center falls inside the running band;
// 2) split each Y-line at wide horizontal gaps (column gutters, >2.5x line
//    height);
// 3) split giant-glyph runs off mixed frags (GIANT, see above).
export function buildFrags(words: Word[]): Frag[] {
  const sorted = words.slice().sort((a, b) => a.rect.top + a.rect.bottom - (b.rect.top + b.rect.bottom));
  const yLines: Word[][] = [];
  let bandBottom = -Infinity;
  for (const w of sorted) {
    const cy = (w.rect.top + w.rect.bottom) / 2;
    if (yLines.length && cy < bandBottom) {
      yLines[yLines.length - 1].push(w);
      bandBottom = Math.max(bandBottom, w.rect.bottom);
    } else {
      yLines.push([w]);
      bandBottom = w.rect.bottom;
    }
  }

  const mkFrag = (ws: Word[]): Frag => ({
    words: ws,
    top: Math.min(...ws.map((x) => x.rect.top)),
    bottom: Math.max(...ws.map((x) => x.rect.bottom)),
    left: Math.min(...ws.map((x) => x.rect.left)),
    right: Math.max(...ws.map((x) => x.rect.right)),
  });
  const frags: Frag[] = [];
  for (const line of yLines) {
    line.sort((a, b) => a.rect.left - b.rect.left);
    const h = Math.max(...line.map((x) => x.rect.bottom - x.rect.top));
    let cur: Word[] = [];
    let prevRight = -Infinity;
    for (const w of line) {
      if (cur.length && w.rect.left - prevRight > 2.5 * h) {
        frags.push(mkFrag(cur));
        cur = [];
      }
      cur.push(w);
      prevRight = Math.max(prevRight, w.rect.right);
    }
    if (cur.length) frags.push(mkFrag(cur));
  }

  // giant-glyph split (step 3 above); lineH as in medianLineH, over pre-split frags
  const hs = frags.map((f) => f.bottom - f.top).sort((a, b) => a - b);
  const lineH = hs[hs.length >> 1] || 12;
  for (let i = frags.length - 1; i >= 0; i--) {
    const ws = frags[i].words; // already left-sorted
    const parts: Word[][] = [[]];
    for (const w of ws) {
      const part = parts[parts.length - 1];
      const prev = part[part.length - 1];
      if (prev) {
        const a = prev.rect.bottom - prev.rect.top;
        const b = w.rect.bottom - w.rect.top;
        if (Math.max(a, b) >= GIANT * Math.min(a, b) && Math.max(a, b) >= GIANT * lineH) parts.push([]);
      }
      parts[parts.length - 1].push(w);
    }
    if (parts.length > 1) frags.splice(i, 1, ...parts.map(mkFrag));
  }
  return frags;
}

// Median fragment height ≈ line height, the unit for every threshold below.
// WEIGHTED BY FRAGMENT WIDTH, and that weighting is load-bearing: a plain
// median counts a 20pt diagram label the same as a 359pt line of body text, so
// a page whose diagram carries more labels than the page carries body lines
// median-votes itself down to the label size. growParagraph merges lines only
// while their top-to-top gap stays under 1.6×lineH, and a book set at 9.96pt
// glyphs with 13.9pt leading needs lineH ≥ 8.69 — barely 13% of headroom. On
// the test book the plain median collapsed to 7.2–8.5 on 13 pages and EVERY
// body line there became its own one-line "paragraph", each translated
// standalone into a mangled sentence (a line ending in "quality fac-" came
// back as «Торсы»). Width-weighting moves lineH on 19 of 820 pages, always up
// and always to the true body height; furniture detection over the whole book
// is bit-identical before and after.
export function medianLineH(frags: Frag[]): number {
  const items = frags.map((f) => ({ h: f.bottom - f.top, w: Math.max(1, f.right - f.left) })).sort((a, b) => a.h - b.h);
  let total = 0;
  for (const it of items) total += it.w;
  let acc = 0;
  for (const it of items) {
    acc += it.w;
    if (acc * 2 >= total) return it.h || 12;
  }
  return 12;
}

const overlaps = (a: Frag, b: Frag) => a.left < b.right && b.left < a.right;

// Grow a paragraph up/down from `home` across lines whose top-to-top gap is
// < 1.6x lineH and whose x-ranges overlap (overlap keeps growth inside one
// column). Indent heuristic: books with uniform leading mark paragraph starts
// only by a first-line indent, so the vertical-gap criterion alone never stops
// there. A boundary = the lower line starts indented relative to the upper one
// (>0.9*lineH) AND the paragraph's last line ends short of the column's right
// edge (>0.5*lineH; modal right, not max: relative left + ends-short keeps
// hanging-indent lists and margin-poking captions/headings from producing
// false stops). A glyph-size cliff between adjacent lines (>=1.15x either
// way, on the lines' MEDIAN word heights — robust to sub/superscripts) whose
// BIGGER side is also heading-sized for the page (>=1.15x lineH) is a
// boundary regardless of indent: a heading line (1.2x body) never absorbs the
// body line under it even when the leading is tight and both start at the
// column edge, and a tightly-leaded paragraph above a heading never absorbs
// the heading (seen: "3.2 <title>" flowing straight into the body when the
// title-to-body gap is under 1.6x). The page-relative guard is what keeps the
// cliff out of display math: ∑-limit lines, fraction numerators and inline
// "1−p" stacks sit at ~0.7x BELOW body size, so their bigger neighbor is
// plain body text and never qualifies; subsection titles at 1.075x and
// running headers at 1.05x stay under the pairwise cliff. `claimed`
// (whole-page clustering) halts growth at frags already assigned to another
// paragraph.
const fhOf = (f: Frag): number => {
  const hs = f.words.map((w) => w.rect.bottom - w.rect.top).sort((a, b) => a - b);
  return hs[hs.length >> 1] || 0;
};
const fhCliff = (a: Frag, b: Frag, lineH: number): boolean => {
  const x = fhOf(a);
  const y = fhOf(b);
  return x > 0 && y > 0 && Math.max(x, y) >= 1.15 * Math.min(x, y) && Math.max(x, y) >= 1.15 * lineH;
};

export function growParagraph(frags: Frag[], home: Frag, lineH: number, claimed?: ReadonlySet<Frag>): Frag[] {
  const col = frags.filter((f) => overlaps(f, home));
  const q = Math.max(2, lineH / 3);
  const cnt = new Map<number, number>();
  for (const f of col) {
    const k = Math.round(f.right / q);
    cnt.set(k, (cnt.get(k) ?? 0) + 1);
  }
  let colRight = 0;
  let bn = 0;
  for (const [k, n] of cnt) if (n > bn) ((bn = n), (colRight = k * q));
  const endsShort = (f: Frag) => colRight - f.right > 0.5 * lineH;
  const indent = (a: Frag, b: Frag) => a.left - b.left > 0.9 * lineH;

  // The merge gap scales with the LINES' OWN size, not only the page's body
  // unit: leading is proportional to type size, so a chapter title set at 29pt
  // over two lines sits 32pt apart on a page whose lineH is 10, and used to be
  // split in half — «Neural Information» and «Retrieval» went to the model as
  // two separate "paragraphs" and came back as two unrelated Russian phrases.
  // Body text is unaffected (its own height IS the page unit), and a
  // title-over-body pair is still separated by the size cliff below.
  const gate = (a: Frag, b: Frag) => 1.6 * Math.max(lineH, fhOf(a), fhOf(b));

  const para = [home];
  for (let cur = home; ; ) {
    let best: Frag | null = null;
    for (const f of frags)
      if (f.top < cur.top - 1 && overlaps(f, cur) && (!best || f.top > best.top)) best = f;
    if (!best || claimed?.has(best) || cur.top - best.top >= gate(cur, best)) break;
    if (fhCliff(cur, best, lineH)) break; // heading/body size cliff
    if (indent(cur, best) && endsShort(best)) break; // cur is a paragraph's indented first line
    para.unshift(best);
    cur = best;
  }
  for (let cur = home; ; ) {
    let best: Frag | null = null;
    for (const f of frags)
      if (f.top > cur.top + 1 && overlaps(f, cur) && (!best || f.top < best.top)) best = f;
    if (!best || claimed?.has(best) || best.top - cur.top >= gate(cur, best)) break;
    if (fhCliff(cur, best, lineH)) break; // heading/body size cliff
    if (indent(best, cur) && endsShort(cur)) break; // next line starts a new paragraph
    para.push(best);
    cur = best;
  }
  return para;
}

// Superscript footnote markers — a tiny RAISED digit run glued to the end of a
// word or of sentence punctuation, with a word break after («cross-encoder¹ in»,
// «Vespa.² In») — are DROPPED during assembly. Flowed into the text they corrupt
// words: the test book's markers came out as «Lucene3», «Vespa4» in translations,
// with the model keeping or dropping the digit at random; the reflow's footnote
// blocks keep their own printed «N.» labels, so the in-body marker carries no
// recoverable meaning there. Math survives by construction: exponents follow
// single-letter variables or brackets ("O(n2)", "(a+b)2" — the 3-letter tail
// rule fails), subscripts sit BELOW the baseline (the raise test fails), and
// display math is kind:"other" whose text never renders. Numeric-citation
// superscripts (other books' "…retrieval12") are dropped too — same rationale.
// A closing bracket or quote counts as part of the word the marker is glued
// to: the marker after «(ELEVATE)» or after a closing quotation mark used to
// fail the tail test and flowed into the body as a bare digit, which the model
// then read as part of the word («Википедии2», «ELEVATE3)») or turned into an
// invented citation. Two letters suffice before a closer — math never puts one
// there («O(n2)», «(a+b)2» have a single variable or digit before the bracket,
// so the digit is still kept).
const SUP_DIGITS = /^\d{1,2}$/;
const SUP_TAIL = /(?:[A-Za-zÀ-ÖØ-öø-ÿА-Яа-яЁё]{3}|[.,;:!?])["'”’)\]]?$|[A-Za-zÀ-ÖØ-öø-ÿА-Яа-яЁё]{2}["'”’)\]]$/;

// one fragment's text: words left→right, a space where rects show a word gap
// (whitespace-only words are filtered before clustering). Exported because the
// hyphen lexicon below is learned from SOURCE LINES — the pre-join view, where
// a line-broken compound is still two tokens and cannot pollute its own counts.
export function fragText(f: Frag, lineH: number): string {
  const ws = f.words.slice().sort((a, b) => a.rect.left - b.rect.left);
  // frag-local metrics for the superscript-marker rule: median glyph height
  // ≈ the line's font size, median bottom ≈ the line's text baseline
  const hs = ws.map((w) => w.rect.bottom - w.rect.top).sort((a, b) => a - b);
  const medH = hs[hs.length >> 1] || 0;
  const bots = ws.map((w) => w.rect.bottom).sort((a, b) => a - b);
  const medBot = bots[bots.length >> 1] || 0;
  let t = "";
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    const spaced = i > 0 && w.rect.left - ws[i - 1].rect.right > 0.12 * lineH;
    if (
      i > 0 &&
      !spaced && // glued to the previous word…
      SUP_DIGITS.test(w.text.trim()) &&
      w.rect.bottom - w.rect.top <= 0.85 * medH && // …smaller (markers run 0.8×)…
      medBot - w.rect.bottom >= 0.25 * medH && // …raised clear off the baseline…
      SUP_TAIL.test(t) && // …after a real word or sentence punctuation…
      (i === ws.length - 1 || /^\s/.test(ws[i + 1].text) || ws[i + 1].rect.left - w.rect.right > 0.12 * lineH) // …at a word break
    )
      continue; // superscript footnote marker — dropped (see above)
    if (spaced) t += " ";
    t += w.text;
  }
  return t.replace(/\s+/g, " ").trim();
}

// verdict for one line-break hyphen: `a` is the word half before it, `b` the
// half after — true keeps the hyphen (see the lexicon further down)
export type HyphenDecider = (a: string, b: string) => boolean;

// assemble: words left→right per line, lines joined dehyphenated.
// `keepHyphen` (engine only — see the lexicon below) decides the ONE case
// plain dehyphenation gets wrong: a compound that was ALREADY hyphenated and
// merely happens to break at its own hyphen («graph-based» → «graphbased»).
export function paraText(para: Frag[], lineH: number, keepHyphen?: HyphenDecider): string {
  let text = "";
  for (const f of para) {
    const t = fragText(f, lineH);
    if (!t) continue;
    if (/[-­]$/.test(text)) {
      const a = text.slice(0, -1).split(" ").pop() ?? "";
      const b = t.split(" ")[0] ?? "";
      text = text.slice(0, -1) + (keepHyphen?.(a, b) ? "-" : "") + t;
    } else text += (text ? " " : "") + t;
  }
  return text;
}

// ---- v2 classification ------------------------------------------------------
// Only clusterParagraphs (engine path) classifies; the DOM Alt+click path in
// App.tsx never calls this, so its behavior is untouched by construction.

// math operators/relations, arrows, big operators, Greek, letterlike (ℝ, ℓ),
// primes, and the Mathematical Alphanumeric Symbols block (𝑞, 𝒅 — how many
// PDFs encode italic math variables)
const MATH_SYM =
  /[=+±×÷∗⋅√∞∫∮∑∏∂∇≈≃≅≠≤≥≪≫≡∼∝∈∉∋⊂⊆⊃⊇∪∩∧∨¬∀∃∅⊕⊗⊤⊥⟨⟩⌊⌋⌈⌉‖∣′″]|[Ͱ-Ͽ℀-⅏←-⇿]|[\u{239b}-\u{23ad}]|[\u{1d400}-\u{1d7ff}]/gu;

export type ParaMetrics = {
  codeShaped: boolean; // a query/code listing — see isCodeShaped
  idRatio: number; // tokens that are catalogue identifiers — ISBN/ISSN/DOI/URL — see ID_TOK
  wordRatio: number; // tokens containing a ≥2-letter run / all tokens — prose ≈ 0.8–1
  pureWordRatio: number; // tokens that are plain words after stripping edge punctuation —
  // separates real sentences from formulas built of function names (softmax([zFalse,…)
  mathDensity: number; // MATH_SYM chars / non-space chars — prose ≈ 0
  structDensity: number; // = [ ] { } | chars — equation/table plumbing, rare in prose
  singleRatio: number; // 1-char tokens / all tokens — isolated glyphs of formulas
  fragLen: number; // mean chars per source item — prose runs long, math is per-glyph
  hSpread: number; // share of glyph heights >20% off the median — sub/superscripts
  stopCount: number; // function-word tokens — every real sentence has them, equations have none
  hasEq: boolean; // contains "=" — combined with stopCount 0 nails camelCase equations
};

// compact function-word list (EN + minimal RU): presence separates sentences
// ("y = Wx, representing the same layer…") from equations ("[p0,p1] = softmax(…)")
const STOP = new Set(
  ("the a an is are was were be of to in on for with as by at from that this these those it its we our which " +
    "where when while than then and such each per into over under between can may should must also " +
    "и в на с по для как что это из не к о от при").split(" "),
);

// A query/code listing. It has to be recognised BEFORE the stop-word sentence
// override in classifyMetrics: a SPARQL block is full of English-looking
// keywords ("where", "as", "by"), clears the stop-word bar, and is called
// prose — which sends it to the translator instead of the crop pipeline, so
// the reader gets `?astronaut` → `?астронавт`, `OPTIONAL` → `ОПЦИОНАЛЬНО`,
// and no original anywhere on the page to fall back to. Three independent
// signals, any one of which a real sentence never shows: an opening keyword in
// caps at token 0, a real share of ?/$-prefixed variable tokens, or SPARQL
// brace plumbing around at least one such variable.
// An opening keyword, or pure plumbing at token 0 — prose never starts with a
// closing brace, an @directive or a property map.
const CODE_OPEN =
  /^(?:SELECT|PREFIX|ASK|CONSTRUCT|DESCRIBE|INSERT|DELETE|UPDATE|MATCH|RETURN|WHERE|FILTER|OPTIONAL)\b|^[@}\]]|^\{/;
// A token only source code produces: a ?/$ variable, a lone or leading comment
// mark, a prefixed name (wd:Q873, rdfs:label, ps:P166), or an angle IRI. The
// part AFTER the colon is required, so prose colons ("Note:", "Section 4.2:")
// never match.
const CODE_TOK =
  /^(?:[?$][A-Za-z_]|#$|#[A-Za-z(]|@[a-z]|<[^<>\s]*>$|[A-Za-z][\w-]{0,12}:(?:[A-Za-z_][\w-]*|\d[\w-]*)$)/;
const CODE_SHARE = 0.2; // code tokens / all tokens
// Catalogue identifiers: a grouped number (ISBN 979-8-4007-1050-6, ISSN
// 2374-6769, DOI 10.1145/3674127.3674137) or a bare host/URL. A copyright page
// is mostly these, and translating it produced fragments with nothing to
// translate; the reader wants the printed original of that page anyway.
const ID_TOK = /^(?:https?:\/\/\S+|[\w-]+\.(?:org|com|net|edu|io|acm|gov)(?:\/\S*)?|\d[\d.\-/]{5,})$/i;
const ID_SHARE = 0.25;
const CODE_MAP = /\{[^}]*:\s*"/; // Cypher/JSON property map
const CODE_LANGTAG = /"@[a-z]{2}(?:-[A-Za-z]+)?\b/; // RDF language-tagged literal

function isCodeShaped(t: string, tokens: readonly string[]): boolean {
  if (CODE_OPEN.test(t) || CODE_MAP.test(t) || CODE_LANGTAG.test(t)) return true;
  let code = 0;
  for (const tok of tokens) if (CODE_TOK.test(tok)) code++;
  // an angle IRI may carry spaces ("<Best Costume Design>"), so it is counted
  // over the whole string instead of per token
  const iris = t.match(/<[^<>]{1,40}>/g)?.length ?? 0;
  return code + iris >= 1 && (code + iris) / tokens.length >= CODE_SHARE;
}

const LETTER = "A-Za-zÀ-ÖØ-öø-ÿА-Яа-яЁё";
const WORDISH = new RegExp(`[${LETTER}]{2,}`);
const PURE = new RegExp(`^[${LETTER}][${LETTER}'’-]*[${LETTER}]$`);
const EDGE_PUNCT = /^[([{"'«]+|[)\]}"'».,;:!?…]+$/g;

// ---- line-break hyphenation lexicon -----------------------------------------
// paraText must decide, per line break, whether the trailing hyphen is
// TYPESETTING (the word was split to fit: «docu-ment») or LEXICAL (a compound
// that happens to break at its own hyphen: «graph-based»). No local signal
// separates them — the evidence is the DOCUMENT'S OWN VOCABULARY, so the rule
// is a two-pass one: count the book's tokens first, decide at assembly time.
//
// Measured on the real 838-page book (2 686 line-break joins, 1 510 distinct
// half-pairs): keeping the hyphen when the hyphenated form is attested inside a
// line AND outnumbers the solid form restores 107 joins (86 compounds —
// «graph-based», «pre-trained», «re-ranking», «cross-language»…) with ≤2 false
// positives. The looser "both halves are words elsewhere" rule was measured
// too and REJECTED: it fires on 520 joins and is wrong on 429 of them
// («exam-ple» 23×, «dif-ferent» 20×, «docu-ments» 18×).
//
// Counts come from SOURCE LINES, never from assembled paragraphs: a line ending
// «graph-» yields the token «graph», so a join can never vote for its own solid
// form (the analysis had to subtract that self-pollution; here it cannot occur).
export type HyphenLexicon = {
  hy: Map<string, number>; // lowercase tokens with an INTERNAL hyphen
  sol: Map<string, number>; // lowercase tokens with none
};
export const newHyphenLexicon = (): HyphenLexicon => ({ hy: new Map(), sol: new Map() });

// letter runs, hyphens/apostrophes allowed inside — digits break tokens, so
// «COVID-19» contributes «covid», never a spurious compound
const HY_TOKEN = new RegExp(`[${LETTER}][${LETTER}'’-]*[${LETTER}]|[${LETTER}]`, "g");
const HY_EDGE = new RegExp(`^[^${LETTER}]+|[^${LETTER}]+$`, "g");
const hyClean = (s: string): string => s.replace(HY_EDGE, "").toLowerCase();

export function learnHyphenLine(lex: HyphenLexicon, line: string): void {
  for (const raw of line.match(HY_TOKEN) ?? []) {
    const w = raw.toLowerCase().replace(/^['’]+|['’]+$/g, "");
    if (w.length < 2) continue;
    const m = w.slice(1, -1).includes("-") ? lex.hy : lex.sol;
    m.set(w, (m.get(w) ?? 0) + 1);
  }
}

// compounds whose hyphen survives a line break, sorted (a compact, diffable
// store field — the raw counters are not worth persisting)
export function hyphenKeepSet(lex: HyphenLexicon): string[] {
  const keep: string[] = [];
  for (const [w, n] of lex.hy) if (n > (lex.sol.get(w.replace(/-/g, "")) ?? 0)) keep.push(w);
  return keep.sort();
}

export function hyphenKeeper(keep: Iterable<string>): HyphenDecider {
  const set = keep instanceof Set ? (keep as Set<string>) : new Set(keep);
  return (a, b) => {
    const l = hyClean(a);
    const r = hyClean(b);
    return !!l && !!r && set.has(`${l}-${r}`);
  };
}

export function paraMetrics(text: string, words: readonly Word[], fh: number): ParaMetrics {
  // collapse TOC dot leaders ("Intro . . . . 25") so such lines classify by their words
  const t = text.replace(/(?:[.·•] ){2,}[.·•]?/g, " ").trim();
  const tokens = t.split(/ +/); // paraText output is single-space normalized
  let wordy = 0;
  let pure = 0;
  let single = 0;
  let stop = 0;
  for (const tok of tokens) {
    if (WORDISH.test(tok)) wordy++;
    const core = tok.replace(EDGE_PUNCT, "");
    if (PURE.test(core)) pure++;
    if (STOP.has(core.toLowerCase())) stop++;
    if (tok.length === 1) single++;
  }
  const chars = t.replace(/ /g, "");
  let off = 0;
  let hn = 0;
  for (const w of words) {
    const h = w.rect.bottom - w.rect.top;
    if (h <= 0) continue;
    hn++;
    if (Math.abs(h - fh) > 0.2 * fh) off++;
  }
  return {
    codeShaped: isCodeShaped(t, tokens),
    idRatio: tokens.filter((tok) => ID_TOK.test(tok.replace(EDGE_PUNCT, ""))).length / tokens.length,
    wordRatio: wordy / tokens.length,
    pureWordRatio: pure / tokens.length,
    mathDensity: chars.length ? (chars.match(MATH_SYM)?.length ?? 0) / chars.length : 0,
    structDensity: chars.length ? (chars.match(/[=[\]{}|]/g)?.length ?? 0) / chars.length : 0,
    singleRatio: single / tokens.length,
    fragLen: words.length ? chars.length / words.length : 0,
    hSpread: hn ? off / hn : 0,
    stopCount: stop,
    hasEq: t.includes("="),
  };
}

// Thresholds tuned on the test book (display-math pages vs. running prose,
// headings, hanging lists, real-sentence captions). Kept as data so the dev
// console can inspect the same decision the engine made.
export function classifyMetrics(m: ParaMetrics): ParaKind {
  if (m.wordRatio === 0) return "other"; // no real words: numbers, symbols, glyph shards
  if (m.codeShaped) return "other"; // query/code listing — cropped, never translated (BEFORE the override below, which it would clear)
  if (m.idRatio >= ID_SHARE && m.stopCount < 2) return "other"; // catalogue block: ISBN/ISSN/DOI/URL runs on a copyright page
  if (m.stopCount >= 3 && m.wordRatio >= 0.5 && !m.hasEq) return "prose"; // sentence override: math-flavored prose ("…as the new dimension ℓ, that is, ℓ + 1 → ℓ")
  if (m.mathDensity > 0.2) return "other"; // saturated with operators/Greek
  if (m.mathDensity > 0.06 && m.wordRatio < 0.55) return "other"; // formula with a few word-like runs (log, tf)
  if (m.mathDensity > 0.03 && m.hSpread > 0.3 && m.singleRatio > 0.3) return "other"; // sub/superscript-heavy display math
  if (m.pureWordRatio < 0.35 && (m.mathDensity > 0.03 || m.structDensity > 0.05)) return "other"; // function-name equations: f(x) = softmax([…])
  if (m.hasEq && m.stopCount === 0) return "other"; // equations: [pFalse,pTrue] = softmax(…), «SSError MSError = dfError» — a sentence with an "=" in it always carries function words too
  if (m.mathDensity > 0.1 && m.stopCount === 0) return "other"; // a piecewise brace's own case labels: «⎧5 if France ⎪⎪4 if Germany»
  if (m.wordRatio < 0.3 && m.singleRatio > 0.4) return "other"; // glyph soup
  return "prose";
}

// ---- running-page furniture (headers/footers) -------------------------------
// Running headers («2.4 Системы, ориентированные на представление информации
// 27») and standalone printed page numbers are PAGE FURNITURE: navigation aids
// repeated on every page, not content. Left as prose they get translated and
// rendered as stray one-line blocks at the top of every reflowed page (seen on
// the real book). kind:"furniture" is never translated (the engine only sends
// kind:"prose") and must be skipped entirely by renderers — no text flow, no
// image crop — exactly like kind:"caption" is skipped in App.tsx buildTrPage
// and export.ts pageItems.
//
// Detection = geometric candidates + confirmation.
//   CANDIDATE: a short single-line paragraph hugging the page content's top or
//   bottom edge, separated from the rest of the page by a clear vertical gap,
//   at body-or-smaller glyph size (running headers sit at ~1.05x body, under
//   the 1.12 cap; real section headings at >=1.15x never qualify — the same
//   sizes the fh-cliff in growParagraph is tuned around).
//   CONFIRMED by any of:
//   (a) printed page number — a standalone integer token at the line's start
//       or end equal to physicalPage + learned offset. The printed<->physical
//       offset is LEARNED, never assumed: every candidate whose edge token is
//       a bare integer votes (int − physicalPage); the modal offset wins once
//       it has ≥3 votes and 2x the runner-up (see learnedOffset). Before the
//       offset is known only a PURE number confirms here — a candidate that is
//       nothing but one integer (the classic centered page number) or one
//       roman numeral (front matter, where no arabic offset can ever match).
//   (b) cross-page repetition — the digit-normalized text (digit runs → "#")
//       was seen at a similar Y in the same zone within the last MEMORY_PAGES
//       pages: running titles repeat verbatim page after page (verso/recto
//       alternation lands 2 pages apart, well inside the window), body lines
//       never do. The first page of a fresh header text (chapter start) is
//       caught by (a) instead, since running headers carry the page number.
//   (c) band rescue — an unconfirmed candidate sharing its line with a
//       confirmed one: buildFrags' column-gap rule often splits «title  27»
//       into two frags; the page number confirms via (a), the title frag
//       rides along.
// ASYMMETRY: (b) needs the sequential cross-page memory that only the engine
// (booktranslate.ts) maintains — it sweeps pages in order and owns one
// FurnitureMemory per run. The viewer-side DOM path (App.tsx Alt+click) has no
// page history: a memoryless detectFurniture call degrades to the geometric +
// pure-number rule only, which is deliberate — there a miss merely translates
// one header line on demand in the popover, nothing is persisted.
// Known limits (accepted): a header with NO page number on it is missed on its
// first occurrence per window (repetition needs a second sighting); page-level
// furniture only — this never touches margin notes or footnotes (multi-line,
// mid-gap, and never confirmed).

const FURN_MEMORY_PAGES = 8; // repetition window, pages
const FURN_MAX_CHARS = 120; // headers are short; and shorter than most body lines
const FURN_MAX_TOKENS = 14; // also excludes TOC dot-leader lines outright
const FURN_FH_CAP = 1.12; // headers ≈1.05x body; section headings ≥1.15x stay out
const FURN_EDGE = 0.6; // candidate hugs the content edge, x lineH
const FURN_GAP = 0.7; // min clear gap toward the body (leading gaps are 0.2–0.4)
const FURN_Y_TOL = 1.5; // repetition match: same-Y tolerance across pages, x lineH

export type FurnitureMemory = {
  // printed-number offset votes: (standalone edge number − physical page) →
  // count. Arabic and roman numbering are SEPARATE schemes with separate
  // offsets: front matter prints "Contents xvii" while the body prints
  // "2.4 Title 27" — one modal offset would let the body majority silence the
  // front matter forever (roman page numbers change every page, so repetition
  // can never confirm those headers either).
  votes: Map<number, number>;
  rvotes: Map<number, number>;
  // digit-normalized candidate lines of recent pages (confirmed or not — the
  // first, unconfirmed sighting is what the second one matches against)
  recent: { page: number; zone: "t" | "b"; y: number; key: string }[];
};
export const newFurnitureMemory = (): FurnitureMemory => ({ votes: new Map(), rvotes: new Map(), recent: [] });

const INT_RE = /^\d{1,4}$/;
const ROMAN_RE = /^(?:[ivxlcdm]{1,7}|[IVXLCDM]{1,7})$/; // no mixed case — keeps "Mid"-like words out
const furnKey = (t: string): string => t.toLowerCase().replace(/\d+/g, "#");

const ROMAN_VAL: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
const romanToInt = (s: string): number => {
  const t = s.toLowerCase();
  let v = 0;
  for (let i = 0; i < t.length; i++) {
    const a = ROMAN_VAL[t[i]];
    v += a < (ROMAN_VAL[t[i + 1]] ?? 0) ? -a : a;
  }
  return v;
};

// standalone page-number token at either end of the line — where running
// headers carry the printed number ("2.4 Title 27", "26 Chapter Two",
// "Contents xvii", bare "27"/"xi"); arabic wins when a token parses as both
function edgeNo(text: string): { a: number | null; r: number | null } {
  const toks = text.split(" ");
  for (const t of [toks[toks.length - 1], toks[0]]) {
    const core = (t ?? "").replace(EDGE_PUNCT, "");
    if (INT_RE.test(core)) return { a: parseInt(core, 10), r: null };
    if (ROMAN_RE.test(core)) return { a: null, r: romanToInt(core) };
  }
  return { a: null, r: null };
}

// modal offset with ≥3 votes and a 2x margin over the runner-up: the real
// offset collects one consistent vote per numbered page, while TOC lines,
// "Chapter 2" tails and body coincidences scatter across offsets
export function learnedOffset(votes: ReadonlyMap<number, number>): number | null {
  let off: number | null = null;
  let best = 0;
  let second = 0;
  for (const [o, n] of votes) {
    if (n > best) {
      second = best;
      best = n;
      off = o;
    } else if (n > second) second = n;
  }
  return off !== null && best >= 3 && best >= 2 * second ? off : null;
}

// Re-seed one already-classified furniture paragraph (engine resume: stored
// pages re-vote the offset and refill the repetition window, so a mid-book
// resume confirms its very first header like an uninterrupted run would).
export function rememberFurniture(mem: FurnitureMemory, page: number, p: Paragraph, zone: "t" | "b"): void {
  const e = edgeNo(p.text);
  if (e.a !== null) mem.votes.set(e.a - page, (mem.votes.get(e.a - page) ?? 0) + 1);
  if (e.r !== null) mem.rvotes.set(e.r - page, (mem.rvotes.get(e.r - page) ?? 0) + 1);
  mem.recent.push({ page, zone, y: zone === "t" ? p.y : p.y + p.h, key: furnKey(p.text) });
}

// Withdraw one seeded paragraph's offset votes (update-mode resume: pages the
// sweep will REVISIT seed the memory too — their votes must count for the
// pages before them, but detectFurniture re-votes the page's live candidates,
// so the stored contribution is retracted right before that page's re-sweep).
// The repetition window needs no counterpart: same-page entries never confirm
// their own page and detectFurniture's window update replaces them wholesale.
export function forgetFurnitureVotes(mem: FurnitureMemory, page: number, p: Paragraph): void {
  const e = edgeNo(p.text);
  const drop = (m: Map<number, number>, off: number) => {
    const v = (m.get(off) ?? 0) - 1;
    if (v > 0) m.set(off, v);
    else m.delete(off);
  };
  if (e.a !== null) drop(mem.votes, e.a - page);
  if (e.r !== null) drop(mem.rvotes, e.r - page);
}

// Mark confirmed running headers/footers on one page: kind → "furniture"
// (MUTATES paras). Call BEFORE detectFigures — the caption pass only
// reclassifies prose, so a marked header can no longer be claimed by a figure.
// `mem` is the engine's per-run cross-page memory; omitted (DOM path) the
// detector degrades to the pure-number rule (see the asymmetry note above).
export function detectFurniture(paras: Paragraph[], physPage: number, mem?: FurnitureMemory): void {
  if (!paras.length) return;
  // page line-height unit: median prose glyph height WEIGHTED BY TEXT LENGTH.
  // A plain paragraph-count median is hijacked on figure-heavy pages, where
  // dozens of short 0.8x-body diagram labels (kind prose) outnumber the few
  // real body paragraphs and drag the unit low enough that the actual running
  // header (~0.95x body) reads as "heading-sized" and is never marked (seen
  // on the test book's architecture-diagram pages). Characters concentrate in
  // body paragraphs, so the char-weighted median is the body size.
  const pool = (paras.some((p) => p.kind === "prose" && p.fh > 0) ? paras.filter((p) => p.kind === "prose") : paras)
    .filter((p) => p.fh > 0)
    .sort((a, b) => a.fh - b.fh);
  let lineH = 12;
  const totalChars = pool.reduce((a, p) => a + p.text.length, 0);
  for (let acc = 0, i = 0; i < pool.length; i++) {
    acc += pool[i].text.length;
    if (acc * 2 >= totalChars) {
      lineH = pool[i].fh;
      break;
    }
  }
  lineH = Math.max(6, lineH);
  const cT = Math.min(...paras.map((p) => p.y));
  const cB = Math.max(...paras.map((p) => p.y + p.h));

  type Cand = {
    p: Paragraph;
    zone: "t" | "b";
    edge: { a: number | null; r: number | null };
    pureNo: boolean;
    roman: boolean;
  };
  const cands: Cand[] = [];
  for (const p of paras) {
    if (p.h > 1.8 * lineH) continue; // multi-line paragraphs are body content
    if (p.fh <= 0 || p.fh > FURN_FH_CAP * lineH) continue; // heading-sized → real title
    if (p.text.length > FURN_MAX_CHARS) continue;
    const toks = p.text.split(" ");
    if (toks.length > FURN_MAX_TOKENS) continue;
    const top = p.y <= cT + FURN_EDGE * lineH;
    const bot = !top && p.y + p.h >= cB - FURN_EDGE * lineH;
    if (!top && !bot) continue;
    // clear separation from the body: nearest other band TOWARD the content
    // ("toward" via the 0.4·lineH shift keeps same-line frags — the split-off
    // page number — and same-height paragraphs in other columns out of the
    // measurement). Consecutive body lines sit 0.2–0.4·lineH apart, so a
    // spillover line ending a page/column never passes; header-to-body and
    // footer-to-body gaps run ≥1·lineH.
    let gap = Infinity;
    for (const q of paras) {
      if (q === p) continue;
      if (top && q.y > p.y + 0.4 * lineH) gap = Math.min(gap, q.y - (p.y + p.h));
      if (bot && q.y + q.h < p.y + p.h - 0.4 * lineH) gap = Math.min(gap, p.y - (q.y + q.h));
    }
    if (gap < FURN_GAP * lineH) continue;
    const core = toks.length === 1 ? toks[0].replace(EDGE_PUNCT, "") : "";
    cands.push({
      p,
      zone: top ? "t" : "b",
      edge: edgeNo(p.text),
      pureNo: INT_RE.test(core),
      roman: ROMAN_RE.test(core),
    });
  }

  // offset votes land BEFORE confirmation, so the page that completes the
  // quorum already benefits from it
  if (mem)
    for (const c of cands) {
      if (c.edge.a !== null) mem.votes.set(c.edge.a - physPage, (mem.votes.get(c.edge.a - physPage) ?? 0) + 1);
      if (c.edge.r !== null) mem.rvotes.set(c.edge.r - physPage, (mem.rvotes.get(c.edge.r - physPage) ?? 0) + 1);
    }
  const offA = mem ? learnedOffset(mem.votes) : null;
  const offR = mem ? learnedOffset(mem.rvotes) : null;

  const confirmed = new Set<Paragraph>();
  for (const c of cands) {
    // (a) printed page number, per numbering scheme (offset-checked once
    // learned; conservative pure-number fallback before that and on the
    // memoryless path; a bare roman numeral is always a page number)
    let ok =
      (offA !== null ? c.edge.a === physPage + offA : c.pureNo) ||
      (offR !== null && c.edge.r !== null && c.edge.r === physPage + offR) ||
      c.roman;
    // (b) cross-page repetition
    if (!ok && mem) {
      const key = furnKey(c.p.text);
      const y = c.zone === "t" ? c.p.y : c.p.y + c.p.h;
      ok = mem.recent.some(
        (e) => e.page !== physPage && e.zone === c.zone && Math.abs(e.y - y) <= FURN_Y_TOL * lineH && e.key === key,
      );
    }
    if (ok) confirmed.add(c.p);
  }
  // (c) band rescue: unconfirmed frag on a confirmed line (title beside number)
  for (const c of cands) {
    if (confirmed.has(c.p)) continue;
    const cy = c.p.y + c.p.h / 2;
    if (cands.some((d) => confirmed.has(d.p) && d.zone === c.zone && Math.abs(d.p.y + d.p.h / 2 - cy) <= 0.7 * lineH))
      confirmed.add(c.p);
  }
  for (const p of confirmed) p.kind = "furniture";

  // memory update: every candidate is a future repetition anchor; entries
  // expire out of the rolling window (same-page entries are replaced on a
  // re-run of the same page, e.g. dev HMR double-processing)
  if (mem) {
    mem.recent = mem.recent.filter((e) => e.page < physPage && physPage - e.page < FURN_MEMORY_PAGES);
    for (const c of cands)
      mem.recent.push({
        page: physPage,
        zone: c.zone,
        y: c.zone === "t" ? c.p.y : c.p.y + c.p.h,
        key: furnKey(c.p.text),
      });
  }
}

// 2x3 affine matrix product (pdfjs Util.transform, inlined to keep this module
// pure; exported for booktranslate's operator-list CTM walk)
export const mul = (m: readonly number[], n: readonly number[]): number[] => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

// pdfjs TextContent item, structurally typed (keeps this module free of pdfjs
// imports; TextMarkedContent entries lack `str` and are skipped by the guard)
export type PdfTextItem = { str?: unknown; transform?: unknown; width?: unknown };

// Word rects of one page's pdfjs TextContent items, derived the way the
// official text layer positions its spans: tr = viewport.transform ×
// item.transform, font height = hypot(tr[2], tr[3]), baseline at tr[5].
export function itemWords(items: readonly unknown[], viewport: { transform: number[] }): Word[] {
  const vt = viewport.transform;
  const sc = Math.hypot(vt[0], vt[1]) || 1; // viewport scale (rotation-safe)
  const words: Word[] = [];
  for (const raw of items) {
    const it = raw as PdfTextItem;
    if (typeof it.str !== "string" || !it.str.trim() || !Array.isArray(it.transform)) continue;
    const tr = mul(vt, it.transform as number[]);
    const fontH = Math.hypot(tr[2], tr[3]) || 1;
    const w = (typeof it.width === "number" ? it.width : 0) * sc;
    // Advance and ascent directions come from the transform, NOT from the axes:
    // laying the advance along +x and the ascent along −y unconditionally models
    // a 90°-rotated string (a landscape table, a rotated axis label) as a short
    // WIDE box, so its words share one `left`, buildFrags bands them apart by y,
    // and growParagraph welds words from unrelated table columns into one
    // "paragraph" that classifies as prose and gets translated. The bbox of the
    // four transformed corners is identical arithmetic for unrotated text
    // (advance (1,0), ascent (0,−1)) and correct at every other angle.
    const aLen = Math.hypot(tr[0], tr[1]) || 1;
    const ax = tr[0] / aLen; // unit advance (reading) direction
    const ay = tr[1] / aLen;
    const ux = ay; // unit ascent: the advance rotated −90° in device space
    const uy = -ax;
    const x0 = tr[4];
    const y0 = tr[5]; // baseline origin
    const xs = [x0, x0 + ax * w, x0 + ux * fontH, x0 + ax * w + ux * fontH];
    const ys = [y0, y0 + ay * w, y0 + uy * fontH, y0 + ay * w + uy * fontH];
    const rect = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
    words.push({ rect, text: it.str });
  }
  return words;
}

// Share of a page's text items set at an angle. A landscape table page is
// majority-rotated; a chart with one rotated axis label is not. The engine
// gates whole pages on this (see booktranslate's isRotatedPage): a mostly
// rotated page has no reflowable measure at all, and every attempt to cluster
// it yields cell shards the model expands into invented sentences — the only
// honest rendering is the original page.
export function rotatedItemShare(items: readonly unknown[], viewport: { transform: number[] }): number {
  const vt = viewport.transform;
  let n = 0;
  let rot = 0;
  for (const raw of items) {
    const it = raw as PdfTextItem;
    if (typeof it.str !== "string" || !it.str.trim() || !Array.isArray(it.transform)) continue;
    n++;
    const tr = mul(vt, it.transform as number[]);
    if (Math.abs(tr[1]) > Math.abs(tr[0])) rot++;
  }
  return n ? rot / n : 0;
}

// frags of one paragraph → its typeset lines (frags sharing a baseline band —
// a gutter-split line is one LineBox), top to bottom
function paraLines(para: readonly Frag[], lineH: number): LineBox[] {
  const out: LineBox[] = [];
  for (const f of para.slice().sort((a, b) => a.top - b.top || a.left - b.left)) {
    const last = out[out.length - 1];
    if (last && Math.abs(f.top - last.top) < 0.5 * lineH) {
      last.left = Math.min(last.left, f.left);
      last.right = Math.max(last.right, f.right);
    } else out.push({ top: f.top, left: f.left, right: f.right });
  }
  return out;
}

const mergeLines = (a: LineBox[], b: readonly LineBox[], lineH: number): LineBox[] => {
  const out = a.concat(b.map((l) => ({ ...l }))).sort((p, q) => p.top - q.top || p.left - q.left);
  const res: LineBox[] = [];
  for (const l of out) {
    const last = res[res.length - 1];
    if (last && Math.abs(l.top - last.top) < 0.5 * lineH) {
      last.left = Math.min(last.left, l.left);
      last.right = Math.max(last.right, l.right);
    } else res.push(l);
  }
  return res;
};

export type PageParagraphs = {
  paras: Paragraph[];
  lines: LineBox[][]; // parallel to paras
  lineH: number; // the page's line-height unit (median frag height)
};

// Whole-page clustering over pdfjs getTextContent() items — DOM-free twin of
// App.tsx's Alt+click path. Returns paragraphs in page CSS px at the given
// viewport's scale, ordered top-to-bottom (left-first within a band; columns
// interleave, which is fine — the overlay places them by coordinates).
export function clusterParagraphs(
  items: readonly unknown[],
  viewport: { transform: number[] },
  opts?: { keepHyphen?: HyphenDecider },
): Paragraph[] {
  return clusterParagraphsEx(items, viewport, opts).paras;
}

// Same clustering, plus the per-line geometry the cross-page stitch needs
// (kept off Paragraph so nothing extra reaches the store — see LineBox).
export function clusterParagraphsEx(
  items: readonly unknown[],
  viewport: { transform: number[] },
  opts?: { keepHyphen?: HyphenDecider },
): PageParagraphs {
  const words = itemWords(items, viewport);

  const frags = buildFrags(words);
  if (!frags.length) return { paras: [], lines: [], lineH: 0 };
  const lineH = medianLineH(frags);
  const band = Math.max(1, lineH / 2);
  const seeds = frags.slice().sort((a, b) => Math.round(a.top / band) - Math.round(b.top / band) || a.left - b.left);

  const claimed = new Set<Frag>();
  const out: Paragraph[] = [];
  const lines: LineBox[][] = [];
  const giant: boolean[] = []; // out[i] is a lone giant-glyph frag (split off by buildFrags)
  for (const seed of seeds) {
    if (claimed.has(seed)) continue;
    const para = growParagraph(frags, seed, lineH, claimed);
    for (const f of para) claimed.add(f);
    const text = paraText(para, lineH, opts?.keepHyphen);
    if (!text) continue;
    lines.push(paraLines(para, lineH));
    const x = Math.min(...para.map((f) => f.left));
    const y = Math.min(...para.map((f) => f.top));
    const ws = para.flatMap((f) => f.words);
    const hs = ws.map((w) => w.rect.bottom - w.rect.top).sort((a, b) => a - b);
    const fh = hs[hs.length >> 1] || 0;
    out.push({
      x,
      y,
      w: Math.max(...para.map((f) => f.right)) - x,
      h: Math.max(...para.map((f) => f.bottom)) - y,
      text,
      fh,
      kind: classifyMetrics(paraMetrics(text, ws, fh)),
    });
    giant.push(para.length === 1 && ws.every((w) => w.rect.bottom - w.rect.top >= GIANT * lineH));
  }

  // Giant adoption: re-attach each lone giant-glyph paragraph (the split-off
  // section number) to the y-overlapping, x-adjacent paragraph whose vertical
  // CENTER lies nearest its own — the heading TITLE beside the number (a
  // one-line title, or a wrapped one already assembled by growParagraph),
  // never the body line that merely shares the number's baseline. Working on
  // whole paragraphs sidesteps growParagraph's indent/gap heuristics, which a
  // frag-level merge would derail (a widened first title line makes the
  // wrapped second line look like an indented new paragraph). The merged
  // paragraph keeps the adopter's fh — the number is decoration, not the
  // heading's type size. An unpaired giant (chapter number over its own
  // title line, figure-innard label) stays standalone, as before this pass.
  for (let i = out.length - 1; i >= 0; i--) {
    if (!giant[i]) continue;
    const g = out[i];
    const gc = g.y + g.h / 2;
    let best = -1;
    let bd = Infinity;
    for (let j = 0; j < out.length; j++) {
      if (j === i || giant[j]) continue;
      const p = out[j];
      if (p.y >= g.y + g.h || g.y >= p.y + p.h) continue; // need y-overlap
      if (Math.max(p.x - (g.x + g.w), g.x - (p.x + p.w)) > 2.5 * p.fh) continue; // adjacency, gutter-safe
      const d = Math.abs(p.y + p.h / 2 - gc);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    if (best < 0) continue;
    const p = out[best];
    p.text = g.x <= p.x ? `${g.text} ${p.text}` : `${p.text} ${g.text}`;
    const x = Math.min(p.x, g.x);
    const y = Math.min(p.y, g.y);
    p.w = Math.max(p.x + p.w, g.x + g.w) - x;
    p.h = Math.max(p.y + p.h, g.y + g.h) - y;
    p.x = x;
    p.y = y;
    lines[best] = mergeLines(lines[best], lines[i], lineH);
    out.splice(i, 1);
    lines.splice(i, 1);
    giant.splice(i, 1);
  }
  return { paras: out, lines, lineH };
}

// ---- v2 figure regions ------------------------------------------------------
// Figures/diagrams often contain no text items, so they are invisible to
// clusterParagraphs and would be dropped by the reflow. Detection is GEOMETRIC:
// tall vertical whitespace gaps between paragraph bands (per text column), plus
// raster-image bboxes the caller reads off page.getOperatorList(). Candidates
// may be blank margins — the RENDERER discards blanks by pixel inspection of
// the offscreen page render it already makes for crops; the engine never
// renders and stores every candidate.

export type FigureRegion = { x: number; y: number; w: number; h: number };

// rect intersection area (scale-1) — shared by the reflow (App.tsx) and the
// engine (booktranslate.ts) for the figure-containment dedup below
export const interArea = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// a paragraph with ≥ this share of its area inside a figure region is excluded
// from the text flow AND from translation: its pixels already live in the
// region's image crop (a crop containing glyphs is never blank-dropped), so
// flowing/translating it would duplicate content as stray label lines
export const FIG_CONTAIN = 0.6;

// caption openers: "Figure 3:", "Fig. 2.1", "Table 4 —", "Algorithm 1", …
// A welded table ROW masquerading as body prose. buildFrags keeps a whole
// table row in one fragment (its cell gaps are under the column-split
// threshold) and growParagraph then stacks several rows into one paragraph
// 300–400pt wide — wider than the 0.6×column "this is body text" bar that both
// the caption envelope and the table walk use to decide where figure material
// ends. On the test book the very first row of Table 5.1 stopped both, no
// region was ever claimed, and the table's cells stayed kind:"prose" and were
// translated («Poor Slow» → «Бедняга Слоу…»). A welded row is recognisable by
// what it lacks: function words and a sentence terminator. Only prose is
// tested — a wide display formula (kind:"other") must keep bounding, and a
// body paragraph torn at a page break keeps its function words and so is
// never mistaken for a row.
const ROW_TERM = /[.!?:;][)"'”’]?$/;
const ROW_STOP_MIN = 2;
function weldedRow(p: Paragraph): boolean {
  if (p.kind !== "prose") return false;
  const t = p.text.trim();
  if (ROW_TERM.test(t)) return false;
  let stop = 0;
  for (const tok of t.split(/\s+/)) {
    if (STOP.has(tok.replace(EDGE_PUNCT, "").toLowerCase()) && ++stop >= ROW_STOP_MIN) return false;
  }
  return true;
}

// "Example 6.1 SELECT" labels a worked query exactly the way "Listing 3" labels
// a code block — same role, same claim on the block under it. Without it the
// label stayed prose, no region was claimed, and the example's own lines went
// to the model one by one. isCaptionText still requires the tail to be
// caption-shaped, so ordinary prose ("Example 2 is the simplest…") is unaffected.
export const CAPTION_RE = /^(?:figure|fig\.|table|chart|diagram|listing|algorithm|scheme|example)\s*\d/i;

// "Table 1.1 provides a high-level overview…" is a SENTENCE about the table,
// not its caption (seen on the test book, adjacent to the real table): real
// captions follow the number with punctuation or a capitalized phrase, while a
// sentence continues with a lowercase verb. Bias toward rejecting — a missed
// caption merely stays prose (translated), a swallowed sentence would vanish
// untranslated into the figure crop.
export function isCaptionText(t: string): boolean {
  const m = CAPTION_RE.exec(t);
  if (!m) return false;
  const rest = t.slice(m.index + m[0].length).replace(/^[\d.]*/, ""); // swallow the rest of "…1.1"
  return /^\s*[:.—–-]/.test(rest) || !/^\s*[a-zа-яё]/.test(rest);
}

// Candidate gap threshold, × median PROSE GLYPH height (the module's lineH
// unit is glyph height, not leading — real leading ≈ 1.2×fh, so 2.8×fh ≈
// 2.3× leading). Tuned on the test book: running-header and pre-heading gaps
// reach 2.5–2.7×fh and must NOT become candidates; real figure gaps are ≫.
const GAP_K = 2.8;
const MIN_GAP_PX = 18; // absolute floor — no hair-thin regions on sparse pages with a degenerate lineH
const EDGE_INSET = 0.3; // region inset from adjacent text rows (descender safety), × lineH
const CAPTION_ADJ = 2; // caption-to-region max vertical distance, × lineH
// minimum figure-material height (caption-to-body-paragraph span) for an
// envelope claim, × lineH — a caption amid normally-leaded prose has ≈1×
// on both sides and never claims; a real figure/table body is far taller
const ENV_MIN = 2;
const MIN_IMG = 24; // raster boxes under this (scale-1 px) are bullets/rules/logos

type Band = { top: number; bottom: number };

function mergeBands(bands: Band[]): Band[] {
  bands.sort((a, b) => a.top - b.top);
  const out: Band[] = [];
  for (const b of bands) {
    const last = out[out.length - 1];
    if (last && b.top <= last.bottom) last.bottom = Math.max(last.bottom, b.bottom);
    else out.push({ ...b });
  }
  return out;
}

const xOverlap = (a: { x: number; w: number }, b: { x: number; w: number }) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);

// vertical distance between two rects' y-intervals (negative = they overlap)
const yDist = (a: FigureRegion, b: FigureRegion) => Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));

// union overlapping / near-touching candidates until stable (n is tiny)
function mergeRegions(rs: FigureRegion[], slack: number): FigureRegion[] {
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        if (xOverlap(rs[i], rs[j]) <= 0 || yDist(rs[i], rs[j]) >= slack) continue;
        const a = rs[i];
        const b = rs[j];
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        rs[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
        rs.splice(j, 1);
        changed = true;
        break outer;
      }
  }
  return rs;
}

// Detect candidate figure regions on one page and reclassify captions.
// `paras` comes straight from clusterParagraphs (same scale-1 units as
// pageW/pageH). A prose paragraph opening like "Figure N" that sits within
// ~2 line heights of a candidate region becomes kind:"caption" (MUTATED in
// place) and its bbox is merged into that region; a caption-like paragraph
// with no adjacent region keeps prose behavior (safety). Column-aware: on
// multi-column pages gaps are measured per column and a region spans only its
// column; column top/bottom edge gaps are measured against the page content
// bounds, so a column starting late (figure at its top) still yields a region.
export function detectFigures(
  paras: Paragraph[],
  pageW: number,
  pageH: number,
  imageBoxes: readonly FigureRegion[] = [],
): FigureRegion[] {
  // median glyph height of prose ≈ the module's line-height unit (medianLineH)
  const pool = (paras.some((p) => p.kind === "prose" && p.fh > 0) ? paras.filter((p) => p.kind === "prose") : paras)
    .map((p) => p.fh)
    .filter((fh) => fh > 0)
    .sort((a, b) => a - b);
  const lineH = Math.max(6, pool[pool.length >> 1] || 12);

  const cands: FigureRegion[] = [];
  for (const b of imageBoxes) {
    const x = Math.max(0, b.x);
    const y = Math.max(0, b.y);
    const w = Math.min(pageW, b.x + b.w) - x;
    const h = Math.min(pageH, b.y + b.h) - y;
    if (w < MIN_IMG || h < MIN_IMG) continue; // decorative marks
    if (w * h > 0.9 * pageW * pageH) continue; // full-page background/scan
    cands.push({ x, y, w, h });
  }

  // column geometry + content y-bounds, hoisted for the caption pass below
  let cols: { l: number; r: number }[] = [];
  let cT = 0;
  let cB = 0;
  if (paras.length) {
    const cL = Math.min(...paras.map((p) => p.x));
    const cR = Math.max(...paras.map((p) => p.x + p.w));
    const contentW = cR - cL;

    // Column formation: narrow paragraphs cluster by x-interval overlap (sorted
    // sweep). Spanning (wide) and noise (page numbers, stray glyphs) paragraphs
    // band into every column they overlap but do not define column geometry.
    // Multi-column only when narrow paragraphs dominate the page AND every
    // cluster carries a real share of the page's text height — a figure's
    // internal text labels also x-cluster, but sum to little height, and must
    // not fake a column split on a single-column page (seen on the test book).
    const cT0 = Math.min(...paras.map((p) => p.y));
    const cB0 = Math.max(...paras.map((p) => p.y + p.h));
    const formers = paras.filter((p) => p.w <= 0.6 * contentW && p.text.length >= 8).sort((a, b) => a.x - b.x);
    let clusters: { l: number; r: number; hsum: number }[] = [];
    for (const p of formers) {
      const last = clusters[clusters.length - 1];
      if (last && p.x <= last.r) {
        last.r = Math.max(last.r, p.x + p.w);
        last.hsum += p.h;
      } else clusters.push({ l: p.x, r: p.x + p.w, hsum: p.h });
    }
    clusters = clusters.filter((c) => c.r - c.l >= 0.12 * contentW); // margin-note slivers
    cols =
      clusters.length >= 2 &&
      clusters.length <= 3 &&
      formers.length * 2 >= paras.length &&
      clusters.every((c) => c.hsum >= 0.3 * (cB0 - cT0))
        ? clusters
        : [{ l: cL, r: cR }];

    // page content y-bounds over paragraphs that band into some column (a
    // gutter-stranded stray must not stretch every column's edge gaps)
    const banded = paras.filter((p) => cols.some((c) => Math.min(p.x + p.w, c.r) - Math.max(p.x, c.l) > 0));
    cT = Math.min(...(banded.length ? banded : paras).map((p) => p.y));
    cB = Math.max(...(banded.length ? banded : paras).map((p) => p.y + p.h));

    const thr = Math.max(GAP_K * lineH, MIN_GAP_PX);
    for (const col of cols) {
      const bands = mergeBands(
        paras
          .filter((p) => Math.min(p.x + p.w, col.r) - Math.max(p.x, col.l) > 0)
          .map((p) => ({ top: p.y, bottom: p.y + p.h })),
      );
      const push = (gapTop: number, gapBottom: number) => {
        if (gapBottom - gapTop < thr) return;
        const y = gapTop + EDGE_INSET * lineH;
        const h = gapBottom - EDGE_INSET * lineH - y;
        if (h > 0 && col.r - col.l >= 3 * lineH) cands.push({ x: col.l, y, w: col.r - col.l, h });
      };
      let prev = cT;
      for (const b of bands) {
        push(prev, b.top);
        prev = Math.max(prev, b.bottom);
      }
      push(prev, cB);
    }
  }

  const regions = mergeRegions(cands, 0.5 * lineH);

  // Caption pass — three claim mechanisms, any one suffices:
  //  (a) nearest adjacent candidate region (raster boxes, tall clean gaps):
  //      the caption bbox merges into it, as before;
  //  (b) figure ENVELOPE: diagrams whose internal label bands chop the gap
  //      into sub-threshold slivers produce no usable candidate, and a table
  //      body is a cluster of narrow cell paragraphs with no gaps at all — so
  //      the whole stretch of non-body material between the caption and the
  //      nearest FULL-WIDTH body paragraph (above or below, whichever side
  //      holds more) is claimed as one column-wide region: label bands, gap
  //      slivers, table cells and the vector graphics between them all land
  //      inside one crop, in original layout.
  // A caption-claimed region is widened to its column bounds — a figure is
  // never narrower than the column holding its caption (otherwise the crop
  // clips boxes at the figure's right edge). Overlaps re-merge below.
  // Paragraphs contained in the final regions are excluded from translation
  // and reflow by the callers (FIG_CONTAIN) — their pixels are in the crop.
  // The page's BODY MEASURE — the left edge and right edge that running text
  // shares, taken as the character-weighted mode over prose paragraphs. This is
  // what actually bounds figure material: "wide enough to be body text" is not
  // a usable test, because a welded table row is 300–400pt wide too, but a
  // table row never starts at the body's left margin AND ends at its right one.
  // Cells are inset, ragged, and column-scoped; body paragraphs are neither.
  // Welded rows are excluded from the VOTE as well as from the test: on a page
  // that is almost entirely a table, the rows are the longest text there is and
  // would otherwise elect themselves the body measure, after which the first
  // row bounds the very walk that was meant to swallow it.
  const edge = (get: (q: Paragraph) => number) => {
    const wt = new Map<number, number>();
    for (const q of paras)
      if (q.kind === "prose" && q.text.length > 40 && !weldedRow(q) && !isCaptionText(q.text)) {
        const k = Math.round(get(q));
        wt.set(k, (wt.get(k) ?? 0) + q.text.length);
      }
    let best = 0;
    let bw = 0;
    for (const [k, n] of wt) if (n > bw) ((bw = n), (best = k));
    return bw ? best : null;
  };
  const bodyL = edge((q) => q.x);
  const bodyR = edge((q) => q.x + q.w);
  const BODY_TOL = 3; // px slack on either margin
  const isBodyMeasure = (q: Paragraph): boolean =>
    bodyL !== null &&
    bodyR !== null &&
    Math.abs(q.x - bodyL) <= BODY_TOL &&
    Math.abs(q.x + q.w - bodyR) <= BODY_TOL &&
    !weldedRow(q);

  let claimed = false;
  for (const p of paras) {
    if (p.kind !== "prose" || !isCaptionText(p.text)) continue;
    // column holding the caption = largest x-overlap (cols is non-empty here:
    // paras.length ≥ 1 guaranteed by iterating paras)
    let col = cols[0];
    let bo = -Infinity;
    for (const c of cols) {
      const o = Math.min(p.x + p.w, c.r) - Math.max(p.x, c.l);
      if (o > bo) {
        bo = o;
        col = c;
      }
    }
    const colW = col.r - col.l;

    // (a) nearest adjacent candidate region
    let best: FigureRegion | null = null;
    let bd = CAPTION_ADJ * lineH;
    for (const r of regions) {
      if (xOverlap(p, r) <= 0) continue;
      const d = yDist(r, p);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }

    // (b) envelope: nearest full-width paragraph above/below the caption in
    // its column bounds the figure material ("full-width" = ≥60% of the
    // column; figure labels and table cells are narrower — kind is
    // irrelevant, a wide display formula bounds the envelope too; other
    // caption-like paras never bound, so stacked figures form one envelope)
    let aTop = cT - EDGE_INSET * lineH;
    let bBot = cB + EDGE_INSET * lineH;
    for (const q of paras) {
      if (q === p || isCaptionText(q.text)) continue;
      if (Math.min(q.x + q.w, col.r) - Math.max(q.x, col.l) <= 0) continue;
      // bound = running text at the body measure, or a wide non-prose block
      // (a display formula still bounds the envelope, as it always did)
      const bounds =
        bodyL === null
          ? q.w >= 0.6 * colW && !weldedRow(q)
          : isBodyMeasure(q) || (q.kind !== "prose" && q.w >= 0.6 * colW);
      if (!bounds) continue;
      if (q.y + q.h <= p.y && q.y + q.h > aTop) aTop = q.y + q.h;
      if (q.y >= p.y + p.h && q.y < bBot) bBot = q.y;
    }
    // Running headers/footers bound the envelope regardless of width. They are
    // short, so the width test above never reaches them, and the envelope for a
    // figure at the top of a page therefore ran all the way to the content edge
    // and baked the header into the crop — the reader got an untranslated
    // English running title and the book's printed page number as a raster band
    // in the middle of a translated page (55 pages of the test book).
    // kind:"furniture" means "never rendered, in any form"; that has to hold for
    // pixels too.
    for (const q of paras) {
      if (q.kind !== "furniture") continue;
      if (q.y + q.h <= p.y && q.y + q.h > aTop) aTop = q.y + q.h;
      if (q.y >= p.y + p.h && q.y < bBot) bBot = q.y;
    }
    const spanAbove = p.y - aTop;
    const spanBelow = bBot - (p.y + p.h);
    let env: FigureRegion | null = null;
    if (Math.max(spanAbove, spanBelow) >= ENV_MIN * lineH) {
      const y0 = spanAbove >= spanBelow ? Math.min(p.y, aTop + EDGE_INSET * lineH) : p.y;
      const y1 = spanAbove >= spanBelow ? p.y + p.h : Math.max(p.y + p.h, bBot - EDGE_INSET * lineH);
      env = { x: col.l, y: y0, w: colW, h: y1 - y0 };
    }

    // (c) table-body swallow: a Table/Listing/Algorithm body is a cluster of
    // narrow cell/code paragraphs at ordinary leading — no tall gaps for (a),
    // and its cell columns can fake text columns that derail (b)'s column
    // scoping (Table 7.1: caption over the left cell column, cells spanning
    // two clusters). Walk PAGE-WIDE from the caption in both directions,
    // swallowing sub-body-width paragraphs while the gap stays small; a
    // full-content-width paragraph (real prose) or a real gap stops the walk.
    let tbl: FigureRegion | null = null;
    if (/^(?:table|listing|algorithm)/i.test(p.text)) {
      const cW = Math.max(...paras.map((q) => q.x + q.w)) - Math.min(...paras.map((q) => q.x));
      let x0 = p.x;
      let x1 = p.x + p.w;
      let top = p.y;
      let bot = p.y + p.h;
      const walk = (down: boolean) => {
        const cand = paras
          .filter((q) => q !== p && (down ? q.y >= p.y + p.h : q.y + q.h <= p.y))
          .sort((a, b) => (down ? a.y - b.y : b.y + b.h - (a.y + a.h)));
        for (const q of cand) {
          if ((down ? q.y - bot : top - (q.y + q.h)) >= CAPTION_ADJ * lineH) break; // real gap
          if (q.kind === "furniture") break; // a running header is never crop material
          // running text at the body measure bounds the table; a welded row is
          // just as wide but never sits on both margins at once
          if (bodyL === null ? q.w >= 0.6 * cW && !weldedRow(q) : isBodyMeasure(q)) break;
          x0 = Math.min(x0, q.x);
          x1 = Math.max(x1, q.x + q.w);
          if (down) bot = Math.max(bot, q.y + q.h);
          else top = Math.min(top, q.y);
        }
      };
      walk(true);
      walk(false);
      if (p.y - top + (bot - (p.y + p.h)) >= ENV_MIN * lineH)
        tbl = { x: Math.min(x0, col.l), y: top, w: Math.max(x1, col.r) - Math.min(x0, col.l), h: bot - top };
    }

    // a successful table walk supersedes (a): merging the pre-caption gap
    // candidate would drag the region's top edge up to the column edge inset,
    // slicing through the running-header band above (partially-contained
    // header = dropped from flow with its pixels clipped at the crop edge);
    // an unclaimed blank gap candidate is simply blank-dropped at render
    if (tbl) best = null;

    if (!best && !env && !tbl) continue; // nothing figure-shaped adjacent → stays prose (safety)
    p.kind = "caption";
    claimed = true;
    if (best) {
      // caption bbox merge + widen to the column bounds
      const x = Math.min(best.x, p.x, col.l);
      const y = Math.min(best.y, p.y);
      best.w = Math.max(best.x + best.w, p.x + p.w, col.r) - x;
      best.h = Math.max(best.y + best.h, p.y + p.h) - y;
      best.x = x;
      best.y = y;
    }
    if (env) regions.push(env);
    if (tbl) regions.push(tbl);
  }
  // post-caption re-merge on TRUE OVERLAP only (slack 0): envelopes/table
  // walks legitimately coalesce the sliver candidates they cover, but a
  // near-touching unclaimed candidate (the blank pre-caption gap 3px above a
  // table region) must stay separate — it gets blank-dropped at render, while
  // merging it would drag the region's edge through the running-header band
  const out = claimed ? mergeRegions(regions, 0) : regions;

  // Invariant: a paragraph the callers will EXCLUDE from flow/translation
  // (≥ FIG_CONTAIN of its area inside a region) must sit COMPLETELY inside
  // that region's crop — partial containment would render it as clipped glyph
  // shards at the crop edge and no text elsewhere (seen: a running header
  // sliced by a gap candidate that overlap-merged into a table region).
  // Expand regions over such paragraphs' bboxes to fixpoint (expansion is the
  // safe direction — it can only add pixels to the crop), then re-merge any
  // overlaps the expansion created.
  // The invariant is TWO-SIDED, and the other side used to be missing: a
  // paragraph the callers will INCLUDE in the flow (under FIG_CONTAIN) must sit
  // completely OUTSIDE the region, or the reader sees it twice — once as a band
  // of horizontally sliced English glyphs at the crop edge, once as the
  // translated paragraph below. Straddling at 10–59% is resolved by pulling the
  // region's near edge off the paragraph: it keeps more of itself outside than
  // in, so the crop loses only pixels that were mostly its own text.
  // The iteration cap is a backstop — expansion and shrink pull in opposite
  // directions, so a pathological page could otherwise oscillate.
  for (let changed = true, iter = 0; changed && iter < 64; iter++) {
    changed = false;
    for (const r of out)
      for (const p of paras) {
        const a = interArea(p, r);
        if (a <= 0 || a >= p.w * p.h) continue;
        if (a < FIG_CONTAIN * p.w * p.h) {
          if (p.kind === "furniture" || p.kind === "prose") {
            const pb = p.y + p.h;
            const rb = r.y + r.h;
            // pull whichever edge the paragraph straddles; leave the region be
            // when the pull would collapse it (expansion is unsafe here)
            if (p.y + p.h / 2 >= r.y + r.h / 2) {
              if (p.y > r.y) {
                r.h = p.y - r.y;
                changed = true;
              }
            } else if (pb < rb) {
              r.h = rb - pb;
              r.y = pb;
              changed = true;
            }
          }
          continue;
        }
        const x = Math.min(r.x, p.x);
        const y = Math.min(r.y, p.y);
        r.w = Math.max(r.x + r.w, p.x + p.w) - x;
        r.h = Math.max(r.y + r.h, p.y + p.h) - y;
        r.x = x;
        r.y = y;
        changed = true;
      }
  }
  const fin = mergeRegions(out, 0);
  fin.sort((a, b) => a.y - b.y || a.x - b.x);
  return fin;
}

// ---- cell grids (tables and formula furniture without a caption) ------------
// Not every grid of short fragments has a "Table N" caption to hang a figure
// region on: SPARQL result tables, piecewise-function braces, the two-column
// «metric name | formula» layouts of an appendix. Their fragments classify as
// prose, go to the model one by one, and come back as invented sentences — the
// model has to supply the grammar the source never had («Poor Slow» →
// «Бедняга Слоу…», «Stage Context» → «Контекст сцены»).
//
// The signal is layout, not wording, and a cell belongs to a ROW or to a
// COLUMN: it shares its typeset row with another cell or with a kind:"other"
// block (a formula's own furniture), or it sits in a stack of cells on one
// left edge, which is what a table column is. A short standalone heading —
// «Editors», «Omar Alonso», a chapter title — belongs to neither, and is
// additionally protected by type size: headings are set ABOVE body size, cells
// at or below it. Bullets and numbered subsections are excluded outright.
// Confirmed cells become kind:"other", which the renderers already show as a
// crop of the original: the reader gets the real table instead of a confident
// mistranslation of one cell of it.
const CELL_MAX_TOKENS = 10;
const CELL_MIN = 3; // confirmed cells before the page is treated as gridded
const CELL_ROW_TOL = 0.9; // same typeset row, × lineH
const CELL_NOTATION_TOKENS = 3; // isolated notation is at most this long
const CELL_NOTATION_CH = /[^\p{L}\p{Zs}'’-]/u; // …and carries a character no plain label has
const CELL_ADJ_TOKENS = 4; // "furniture of the formula next door" is this short
const CELL_ADJ_TOL = 1.2; // …and this close to it, × lineH
const CELL_COL_TOL = 3; // same column, px on the left edge
const CELL_COL_GAP = 6; // max vertical gap inside one column stack, × lineH
const CELL_COL_MIN = 3; // cells in a stack before the stack counts as a column
const CELL_FH_CAP = 1.05; // cells run at or below body size; headings above it
const CELL_BULLET = /^\s*(?:[•●▪‣∗*–—]|\(?\d{1,2}[.)]\s|[a-z]\)\s)/;
const CELL_NUMBERED = /^\d+(?:\.\d+)*\.?\s+\S/; // "5.2 Problem Definitions", "22. The geometric…"

export function detectCellGrid(paras: Paragraph[], lineH: number): void {
  // body size: char-weighted mode of prose glyph height, same statistic
  // stitchModel uses — characters concentrate in body text, so labels and
  // headings cannot win the vote
  const wt = new Map<number, number>();
  for (const p of paras) if (p.kind === "prose" && p.fh > 0) wt.set(p.fh, (wt.get(p.fh) ?? 0) + p.text.length);
  let bodyFh = 0;
  let bw = 0;
  for (const [k, n] of wt) if (n > bw) ((bw = n), (bodyFh = k));
  if (!bodyFh) return;

  const candidate = (p: Paragraph): boolean => {
    if (p.kind !== "prose" || p.fh > CELL_FH_CAP * bodyFh) return false;
    const t = p.text.trim();
    if (!t || ROW_TERM.test(t) || CAPTION_RE.test(t) || CELL_BULLET.test(t) || CELL_NUMBERED.test(t)) return false;
    return t.split(/\s+/).length <= CELL_MAX_TOKENS;
  };

  const cands = new Set(paras.filter(candidate));
  if (!cands.size) return;
  const confirmed = new Set<Paragraph>();
  // rules (1)–(3) describe a GRID and need a page-level quorum; rule (4) below
  // is self-evidencing and runs even on a page with a single stray operand
  if (cands.size >= CELL_MIN) {
    // (1) row: a peer cell or a formula block on the same typeset line
    for (const c of cands)
      for (const q of paras) {
        if (q === c || Math.abs(q.y - c.y) > CELL_ROW_TOL * lineH) continue;
        if (q.kind === "other" || cands.has(q)) {
          confirmed.add(c);
          break;
        }
      }
    // (2) adjacency: a very short fragment directly above or below a display-math
    // block is that block's own furniture — a case label, a fraction's numerator
    // gloss, a stray operand run («logb(k)», «DCG(k) iDCG(k)», «sin (»).
    for (const c of cands) {
      if (c.text.trim().split(/\s+/).length > CELL_ADJ_TOKENS) continue;
      for (const q of paras)
        if (
          q.kind === "other" &&
          Math.min(Math.abs(q.y - (c.y + c.h)), Math.abs(c.y - (q.y + q.h))) <= CELL_ADJ_TOL * lineH
        ) {
          confirmed.add(c);
          break;
        }
    }
    // (3) column: a stack of cells on one left edge, no big vertical break
    const byLeft = new Map<number, Paragraph[]>();
    for (const c of cands) {
      const k = Math.round(c.x / CELL_COL_TOL);
      (byLeft.get(k) ?? byLeft.set(k, []).get(k)!).push(c);
    }
    for (const col of byLeft.values()) {
      if (col.length < CELL_COL_MIN) continue;
      col.sort((a, b) => a.y - b.y);
      let run = [col[0]];
      for (let i = 1; i <= col.length; i++) {
        const cont =
          i < col.length && col[i].y - (run[run.length - 1].y + run[run.length - 1].h) <= CELL_COL_GAP * lineH;
        if (cont) run.push(col[i]);
        else {
          if (run.length >= CELL_COL_MIN) for (const c of run) confirmed.add(c);
          if (i < col.length) run = [col[i]];
        }
      }
    }
  } // end of the gridded-page rules
  // (4) isolated notation: a run of at most three tokens, at body size, with no
  // sentence punctuation, that is either a single token or carries a character
  // outside letters and spaces. That is an operand, a label or a fragment of a
  // formula — «logb(k)», «DCG(k) iDCG(k)», «Dis(qloc, ploc)», a lone «sum»
  // between two equation lines. Translating it means inventing a sentence, so
  // the original is cropped instead. A plain two- or three-word label («SPO
  // index», «First Edition») has no such character and keeps its translation.
  // Unlike (1)–(3) this one needs no page-level quorum: it is self-evidencing,
  // and a lone stray operand between two equation lines is the common case.
  const notation: Paragraph[] = [];
  for (const c of cands) {
    const t = c.text.trim();
    const toks = t.split(/\s+/);
    if (toks.length <= CELL_NOTATION_TOKENS && (toks.length === 1 || CELL_NOTATION_CH.test(t))) notation.push(c);
  }
  if (confirmed.size >= CELL_MIN) for (const c of confirmed) c.kind = "other";
  for (const c of notation) c.kind = "other";
}

// ---- v2 cross-page paragraph stitching --------------------------------------
// A paragraph that runs past the bottom of a page is TWO paragraphs to a
// per-page clusterer, and translating each half separately is the single worst
// artifact of the reflow: the model closes the first half with an invented
// sentence ending and opens the second as a new sentence. Measured on the real
// 838-page book: 379 of 638 page transitions (59%) tear a paragraph, producing
// 758 halves = 17% of every translated paragraph, and 272 of the 379 tails got
// a hallucinated ending in Russian.
//
// The decisive signals are GEOMETRIC, not linguistic, and live only here — the
// store keeps a paragraph's bbox, never its per-line edges. Two facts from the
// data drove the design:
//   * This book does not indent the first paragraph on a page (143 of 638
//     breaks show an unindented head after a FINISHED paragraph), so a
//     first-line-indent test carries almost no information — it is not used.
//   * Justified setting means a paragraph that continues always has its last
//     line flush to its own measure: 565 of 1 891 open paragraphs are flush
//     against 58 of 2 017 terminated ones.
//
// Tests (all must hold; thresholds × the page's lineH ≈ 3 pt at body size):
//   G1 flush right — the tail's LAST line reaches the tail's OWN measure
//      (x+w for multi-line tails, the column margin for one-liners), so block
//      quotes and bullets pass on their own inset rather than the page's;
//   G2 same line offset MEASURED FROM THE RIGHT MARGIN — the verso/recto
//      mirror shift cancels exactly, and hanging indents match. Measuring from
//      the left margin instead costs 7 true positives and adds 10 false ones;
//   L1 the tail does not end in a sentence terminator (this alone rejects all
//      20 "flush + unindented but finished" pairs in the book);
//   S1 no heading between the halves (figure-contained heading-sized labels are
//      excluded — without that, one figure label falsely blocks a real tear);
//   S2 identical glyph size; S3 the head is not a list item; S4 an
//      uppercase-starting head needs ≥4 tokens (kills the only 3 errors found,
//      all table cells); S5 neither page is a bibliography page;
//   M1 no wide display-math block between the halves — joining across a formula
//      that is grammatically part of the sentence would emit the formula crop
//      AFTER the joined text (10 such pairs in the book, deliberately skipped).
// Hand-check: 52 adjudicated cases, 0 errors (precision ≈ 100%); recall ≈ 98%,
// the misses being ragged-right blocks where G1 cannot fire.
//
// ACCEPTED LIMITS. G1 assumes justified setting: in a ragged-right book every
// last line is short, the predicate never fires, and nothing is joined — the
// safe direction. stitchModel refuses pages whose body paragraphs form two
// side-by-side x-groups (STITCH_COL_CHARS), so a genuinely multi-column book is
// left un-stitched rather than stitched wrongly; generalising means running
// this per column (detectFigures already forms columns) with tail = last
// paragraph of the last column and head = first of the first — G2's
// right-margin cancellation still holds, since each column has its own margin.

const STITCH_FH_TOL = 0.02; // tail/head glyph-size match, and the body-size band
const STITCH_FLUSH = 0.3; // G1 slack, × lineH
const STITCH_OFFSET = 0.35; // G2 slack, × lineH
const STITCH_HEAD_FH = 1.12; // heading-sized, × the page's dominant prose size
const STITCH_HEAD_LINES = 3; // …and short: a "heading" longer than this is prose
const STITCH_MATH_W = 0.15; // display-math block width, × the column's right edge
const STITCH_MATH_FH = 0.9; // …and set at body size: measured, every display formula
// in the book is exactly 1.000× the dominant prose size while the bottom-of-page
// footnote/URL blocks that classify as "other" too run 0.85× — without this floor
// a footnote block masquerades as a formula and blocks a real tear (p. 591)
const STITCH_COL_CHARS = 0.15; // multi-column guard: a real column's share of body chars
const STITCH_MIN_TOKENS = 4; // S4: minimum head length when it starts uppercase

// sentence terminator, optionally behind a closing quote/bracket
const STITCH_TERM = /[.!?…]["'”’)\]]?$/;
// …except an abbreviation's own period closing a parenthetical: "(…, etc.)"
// ends no sentence, and reading it as one refuses a real continuation. Kept
// deliberately narrow — "et al." DOES end sentences, so it is not listed.
const STITCH_ABBR = /(?:etc|e\.g|i\.e|cf|vs|resp)\.\)$/i;
// a continuation opens lowercase…
const STITCH_LOWER = /^[a-zà-öø-ÿа-яё]/;
// …or with a math/continuation glyph (Greek, letterlike, arrows/operators, and
// the Mathematical Alphanumeric Symbols block — «𝜓 ∈ Ψ is represented as…»)
const STITCH_SYM = /^(?:[Ͱ-Ͽ℀-⅏←-⋿]|[\u{1d400}-\u{1d7ff}])/u;
// list markers: a head that opens one is a new item, never a continuation
const STITCH_LIST = /^\s*(?:[•●▪‣∗*–—]|\(?\d{1,2}[.)]\s|[a-z]\)\s)/;

export type StitchModel = {
  lineH: number;
  domFh: number; // dominant prose glyph height (char-weighted mode)
  colR: number; // justified right margin
  colL: number; // measure's left edge
  body: number[]; // in-column body paragraphs, reading order (indices into paras)
  blockers: Set<number>; // heading-sized prose — S1
  math: Set<number>; // wide display-math blocks — M1
};

// One page's stitching geometry, or null when the page offers no single text
// measure to reason about (no prose at all, or two side-by-side columns).
export function stitchModel(
  paras: readonly Paragraph[],
  lines: readonly (readonly LineBox[])[],
  lineH: number,
  figures: readonly FigureRegion[],
): StitchModel | null {
  if (!paras.length || lineH <= 0) return null;
  // dominant prose size: mode of fh WEIGHTED BY CHARACTER COUNT — characters
  // concentrate in body paragraphs, so figure labels and headings cannot win
  const wt = new Map<string, number>();
  for (const p of paras)
    if (p.kind === "prose" && p.fh > 0) {
      const k = p.fh.toFixed(2);
      wt.set(k, (wt.get(k) ?? 0) + p.text.length);
    }
  if (!wt.size) return null;
  let domFh = 0;
  let bw = -1;
  for (const [k, n] of wt)
    if (n > bw || (n === bw && Number(k) > domFh)) {
      bw = n;
      domFh = Number(k);
    }
  if (domFh <= 0) return null;

  const body: number[] = [];
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (p.kind === "prose" && p.fh > 0 && Math.abs(p.fh - domFh) <= STITCH_FH_TOL * domFh) body.push(i);
  }
  if (!body.length) return null;

  // Multi-column refusal. Every threshold below assumes ONE text measure, so a
  // page whose body paragraphs fall into two side-by-side x-groups (each with a
  // wrapped paragraph and a real share of the page's text) is not stitched at
  // all — the safe direction. A block quote or a hanging list keeps its
  // x-interval INSIDE the body measure and therefore stays one group.
  const chars = body.reduce((a, i) => a + paras[i].text.length, 0);
  const groups: { r: number; multi: boolean; chars: number }[] = [];
  for (const i of body.slice().sort((p, q) => paras[p].x - paras[q].x)) {
    const g = groups[groups.length - 1];
    const p = paras[i];
    if (g && p.x <= g.r) {
      g.r = Math.max(g.r, p.x + p.w);
      g.multi ||= lines[i].length >= 2;
      g.chars += p.text.length;
    } else groups.push({ r: p.x + p.w, multi: lines[i].length >= 2, chars: p.text.length });
  }
  if (groups.filter((g) => g.multi && g.chars >= STITCH_COL_CHARS * chars).length >= 2) return null;

  // the justified right margin: weighted mode of the FIRST line's right edge
  // over multi-line body paragraphs (weight = the count of full-measure lines)
  const multi = body.filter((i) => lines[i].length >= 2);
  let colR = 0;
  if (multi.length) {
    let best = -1;
    for (const i of multi) {
      const v = lines[i][0].right;
      let s = 0;
      for (const j of multi) if (Math.abs(lines[j][0].right - v) <= STITCH_FLUSH * lineH) s += lines[j].length - 1;
      if (s > best || (s === best && v > colR)) {
        best = s;
        colR = v;
      }
    }
  } else colR = Math.max(...body.map((i) => paras[i].x + paras[i].w));
  const colL = Math.min(...body.map((i) => paras[i].x));

  // in-column body: inside the measure, and with a last line long enough to be
  // running text (this is what drops equation numbers and narrow table cells)
  let inCol = body.filter((i) => {
    const p = paras[i];
    const last = lines[i][lines[i].length - 1];
    return p.x + p.w <= colR + STITCH_FLUSH * lineH && colR - last.left >= 0.35 * (colR - colL);
  });
  // colR is voted from FIRST lines, but the filter above tests the WHOLE
  // paragraph bbox: a page where a body paragraph pokes past the voted margin
  // (a hanging citation, a wide inline formula) empties inCol while body is
  // full, and an empty body silently drops the page out of cross-page stitching
  // — tearing whatever paragraph runs over its bottom edge and leaving the
  // model to invent a subject for the orphaned half. Retry against the widest
  // right edge actually observed before giving up on the page.
  if (!inCol.length) {
    const wideR = Math.max(...body.map((i) => paras[i].x + paras[i].w));
    const retry = body.filter((i) => {
      const last = lines[i][lines[i].length - 1];
      return wideR - last.left >= 0.35 * (wideR - colL);
    });
    if (retry.length) {
      inCol = retry;
      colR = wideR;
    } else inCol = body;
  }

  const inFig = (p: Paragraph) => figures.some((r) => interArea(p, r) >= FIG_CONTAIN * p.w * p.h);
  const blockers = new Set<number>();
  const math = new Set<number>();
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (inFig(p)) continue; // its pixels are in a figure crop — not a structural break
    if (p.kind === "prose" && p.fh >= STITCH_HEAD_FH * domFh && lines[i].length <= STITCH_HEAD_LINES) blockers.add(i);
    if (p.kind === "other" && p.w > STITCH_MATH_W * colR && p.fh >= STITCH_MATH_FH * domFh) math.add(i);
  }
  return { lineH, domFh, colR, colL, body: inCol, blockers, math };
}

export type StitchPage = {
  paras: readonly Paragraph[];
  lines: readonly (readonly LineBox[])[];
  model: StitchModel | null;
  refPage: boolean;
};

// Does page `a`'s last body paragraph continue as page `b`'s first one?
// Returns the two paragraph indices, or null. Pure — the caller owns page
// order, blank-page skipping and multi-page chaining.
export function stitchPair(a: StitchPage, b: StitchPage): { tail: number; head: number } | null {
  if (a.refPage || b.refPage) return null; // S5
  const A = a.model;
  const B = b.model;
  if (!A?.body.length || !B?.body.length) return null;
  const ti = A.body[A.body.length - 1];
  const hi = B.body[0];
  const tail = a.paras[ti];
  const head = b.paras[hi];
  const tl = a.lines[ti];
  const hl = b.lines[hi];
  if (!tl?.length || !hl?.length) return null;
  // S1 + M1: nothing structural between the halves, on either page
  for (let i = ti + 1; i < a.paras.length; i++) if (A.blockers.has(i) || A.math.has(i)) return null;
  for (let i = 0; i < hi; i++) if (B.blockers.has(i) || B.math.has(i)) return null;
  // G1 — the tail's last line is flush to the tail's own measure
  const measureR = tl.length >= 2 ? tail.x + tail.w : A.colR;
  if (measureR - tl[tl.length - 1].right > STITCH_FLUSH * A.lineH) return null;
  // G2 — both lines sit at the same offset, measured from the right margin
  const off = A.colR - tl[tl.length - 1].left - (B.colR - hl[0].left);
  if (Math.abs(off) > STITCH_OFFSET * A.lineH) return null;
  // L1 — the tail is an unfinished sentence
  const tt = tail.text.replace(/\s+$/, "");
  if (STITCH_TERM.test(tt) && !STITCH_ABBR.test(tt)) return null;
  // S2 — same type size
  if (Math.abs(tail.fh - head.fh) > STITCH_FH_TOL * Math.max(tail.fh, head.fh)) return null;
  // S3 / S4 — the head reads like a continuation
  if (STITCH_LIST.test(head.text)) return null;
  const ht = head.text.replace(/^\s+/, "");
  if (!STITCH_LOWER.test(ht) && !STITCH_SYM.test(ht) && ht.split(/\s+/).length < STITCH_MIN_TOKENS) return null;
  return { tail: ti, head: hi };
}
