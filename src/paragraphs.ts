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
// the v2 typesetter shows an image crop of the region instead of a translation
export type ParaKind = "prose" | "other";
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

// 1) Y-lines: words whose vertical center falls inside the running band;
// 2) split each Y-line at wide horizontal gaps (column gutters, >2.5x line height)
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
// false stops). `claimed` (whole-page clustering) halts growth at frags
// already assigned to another paragraph.
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
    if (indent(cur, best) && endsShort(best)) break; // cur is a paragraph's indented first line
    para.unshift(best);
    cur = best;
  }
  for (let cur = home; ; ) {
    let best: Frag | null = null;
    for (const f of frags)
      if (f.top > cur.top + 1 && overlaps(f, cur) && (!best || f.top < best.top)) best = f;
    if (!best || claimed?.has(best) || best.top - cur.top >= 1.6 * lineH) break;
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

// 2x3 affine matrix product (pdfjs Util.transform, inlined to keep this module pure)
const mul = (m: readonly number[], n: readonly number[]): number[] => [
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
  }
  return out;
}
