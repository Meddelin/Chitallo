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
export type Paragraph = { x: number; y: number; w: number; h: number; text: string };

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
    out.push({
      x,
      y,
      w: Math.max(...para.map((f) => f.right)) - x,
      h: Math.max(...para.map((f) => f.bottom)) - y,
      text,
    });
  }
  return out;
}
