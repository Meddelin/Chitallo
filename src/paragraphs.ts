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
// so the region's image crop shows figure + caption exactly as the original
export type ParaKind = "prose" | "other" | "caption";
// fh: median glyph (font) height of the paragraph's items, in the units of the
// viewport passed to clusterParagraphs (the book engine passes scale 1)
export type Paragraph = { x: number; y: number; w: number; h: number; text: string; fh: number; kind: ParaKind };

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

// median fragment height ≈ line height, the unit for every threshold below
export function medianLineH(frags: Frag[]): number {
  const hs = frags.map((f) => f.bottom - f.top).sort((a, b) => a - b);
  return hs[hs.length >> 1] || 12;
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

  const para = [home];
  for (let cur = home; ; ) {
    let best: Frag | null = null;
    for (const f of frags)
      if (f.top < cur.top - 1 && overlaps(f, cur) && (!best || f.top > best.top)) best = f;
    if (!best || claimed?.has(best) || cur.top - best.top >= 1.6 * lineH) break;
    if (fhCliff(cur, best, lineH)) break; // heading/body size cliff
    if (indent(cur, best) && endsShort(best)) break; // cur is a paragraph's indented first line
    para.unshift(best);
    cur = best;
  }
  for (let cur = home; ; ) {
    let best: Frag | null = null;
    for (const f of frags)
      if (f.top > cur.top + 1 && overlaps(f, cur) && (!best || f.top < best.top)) best = f;
    if (!best || claimed?.has(best) || best.top - cur.top >= 1.6 * lineH) break;
    if (fhCliff(cur, best, lineH)) break; // heading/body size cliff
    if (indent(best, cur) && endsShort(cur)) break; // next line starts a new paragraph
    para.push(best);
    cur = best;
  }
  return para;
}

// assemble: words left→right per line (a space where rects show a word gap —
// whitespace-only words are filtered before clustering), lines joined dehyphenated
export function paraText(para: Frag[], lineH: number): string {
  let text = "";
  for (const f of para) {
    const ws = f.words.slice().sort((a, b) => a.rect.left - b.rect.left);
    let t = "";
    for (let i = 0; i < ws.length; i++) {
      if (i && ws[i].rect.left - ws[i - 1].rect.right > 0.12 * lineH) t += " ";
      t += ws[i].text;
    }
    t = t.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (/[-­]$/.test(text)) text = text.slice(0, -1) + t;
    else text += (text ? " " : "") + t;
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
  /[=+±×÷∗⋅√∞∫∮∑∏∂∇≈≃≅≠≤≥≪≫≡∼∝∈∉∋⊂⊆⊃⊇∪∩∧∨¬∀∃∅⊕⊗⊤⊥⟨⟩⌊⌋⌈⌉‖∣′″]|[Ͱ-Ͽ℀-⅏←-⇿]|[\u{1d400}-\u{1d7ff}]/gu;

export type ParaMetrics = {
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

const LETTER = "A-Za-zÀ-ÖØ-öø-ÿА-Яа-яЁё";
const WORDISH = new RegExp(`[${LETTER}]{2,}`);
const PURE = new RegExp(`^[${LETTER}][${LETTER}'’-]*[${LETTER}]$`);
const EDGE_PUNCT = /^[([{"'«]+|[)\]}"'».,;:!?…]+$/g;

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
  if (m.stopCount >= 3 && m.wordRatio >= 0.5 && !m.hasEq) return "prose"; // sentence override: math-flavored prose ("…as the new dimension ℓ, that is, ℓ + 1 → ℓ")
  if (m.mathDensity > 0.2) return "other"; // saturated with operators/Greek
  if (m.mathDensity > 0.06 && m.wordRatio < 0.55) return "other"; // formula with a few word-like runs (log, tf)
  if (m.mathDensity > 0.03 && m.hSpread > 0.3 && m.singleRatio > 0.3) return "other"; // sub/superscript-heavy display math
  if (m.pureWordRatio < 0.35 && (m.mathDensity > 0.03 || m.structDensity > 0.05)) return "other"; // function-name equations: f(x) = softmax([…])
  if (m.hasEq && m.stopCount === 0 && m.pureWordRatio < 0.7) return "other"; // camelCase equations: [pFalse,pTrue] = softmax(…) — sentences always carry function words
  if (m.wordRatio < 0.3 && m.singleRatio > 0.4) return "other"; // glyph soup
  return "prose";
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

// Whole-page clustering over pdfjs getTextContent() items — DOM-free twin of
// App.tsx's Alt+click path. Rects are derived the way the official text layer
// positions its spans: tr = viewport.transform × item.transform, font height =
// hypot(tr[2], tr[3]), baseline at tr[5]. Returns paragraphs in page CSS px at
// the given viewport's scale, ordered top-to-bottom (left-first within a band;
// columns interleave, which is fine — the overlay places them by coordinates).
export function clusterParagraphs(items: readonly unknown[], viewport: { transform: number[] }): Paragraph[] {
  const vt = viewport.transform;
  const sc = Math.hypot(vt[0], vt[1]) || 1; // viewport scale (rotation-safe)
  const words: Word[] = [];
  for (const raw of items) {
    const it = raw as PdfTextItem;
    if (typeof it.str !== "string" || !it.str.trim() || !Array.isArray(it.transform)) continue;
    const tr = mul(vt, it.transform as number[]);
    const fontH = Math.hypot(tr[2], tr[3]) || 1;
    const w = (typeof it.width === "number" ? it.width : 0) * sc;
    words.push({ rect: { left: tr[4], top: tr[5] - fontH, right: tr[4] + w, bottom: tr[5] }, text: it.str });
  }

  const frags = buildFrags(words);
  if (!frags.length) return [];
  const lineH = medianLineH(frags);
  const band = Math.max(1, lineH / 2);
  const seeds = frags.slice().sort((a, b) => Math.round(a.top / band) - Math.round(b.top / band) || a.left - b.left);

  const claimed = new Set<Frag>();
  const out: Paragraph[] = [];
  const giant: boolean[] = []; // out[i] is a lone giant-glyph frag (split off by buildFrags)
  for (const seed of seeds) {
    if (claimed.has(seed)) continue;
    const para = growParagraph(frags, seed, lineH, claimed);
    for (const f of para) claimed.add(f);
    const text = paraText(para, lineH);
    if (!text) continue;
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
    out.splice(i, 1);
    giant.splice(i, 1);
  }
  return out;
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
export const CAPTION_RE = /^(?:figure|fig\.|table|chart|diagram|listing|algorithm|scheme)\s*\d/i;

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
      if (Math.min(q.x + q.w, col.r) - Math.max(q.x, col.l) <= 0 || q.w < 0.6 * colW) continue;
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
          if (q.w >= 0.6 * cW) break; // full-width prose bounds the table
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
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of out)
      for (const p of paras) {
        const a = interArea(p, r);
        if (a < FIG_CONTAIN * p.w * p.h || a >= p.w * p.h) continue;
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
