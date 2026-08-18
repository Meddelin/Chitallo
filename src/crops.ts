// Rasterization of the image crops that carry the untranslatable parts of a
// reflowed page — display formulas, tables, figures, and paragraphs the model
// failed on. Shared by the on-screen reflow (App.tsx buildTrPage/drawCrops) and
// both exports (export.ts), because the two must not drift: a crop that looks
// crisp in the app and soft in the PDF is the same defect twice.
//
// WHY THIS EXISTS AS A WINDOW RENDER, NOT A PAGE RENDER
// The crops used to be cut out of a full-page raster taken at the page's own
// display density (screen: scale × devicePixelRatio ≈ 1.25; export: 2). At that
// density a 9 pt subscript inside a formula gets ~11 device pixels of height,
// and it shows: the reflow's prose is real DOM text rendered by the system
// rasterizer, so every crop reads as the blurry patch in an otherwise crisp
// page. Raising the whole page to 4 px per PDF point would cost ~38 MB of RGBA
// per page (measured, 821×717 pt book) — too much to hold for several pages at
// once.
// So the raster covers only the WINDOW that actually contains crops. Measured
// over the user's 838-page book (481 pages carry crops, 3 872 crops in all) the
// window is 20.3% of the page on average: 7.6 MB at 4×, which is LESS than the
// 9.4 MB a full page cost at the old 2×. Sharpness up 2–4×, peak memory down.
//
// pdf.js supports this directly: getViewport({ scale, offsetX, offsetY })
// translates the render transform in output pixels, and page.render only ever
// reads viewport.transform — everything outside the canvas is clipped away by
// the 2D context.

import type { PDFPageProxy } from "pdfjs-dist";

/** Device pixels per scale-1 unit (PDF point) in the offscreen window render. */
export const CROP_K = 4;

/**
 * Device pixels per CSS pixel kept in a crop's OWN backing store on screen.
 * The window is rasterized at CROP_K and each crop is then area-downsampled
 * into this density with high-quality smoothing — supersampling. Keeping the
 * raw 4× buffer in the DOM instead would hand the compositor a 3:1 downscale it
 * filters with a plain bilinear tap, which aliases; 2 device px per CSS px is
 * both cheap and exactly what a compositor downscale handles losslessly (a 2:1
 * bilinear reduction IS a 2×2 box filter).
 */
export const CROP_DPR = 2;

/**
 * Ceiling on the offscreen window in device pixels (16 Mpx ≈ 64 MB RGBA).
 * A US-Letter page rendered whole at 4× is 7.8 Mpx and the widest window
 * measured in the test book is 6.4 Mpx, so this only ever bites on fold-outs,
 * posters and deep zoom — where it lowers the density instead of allocating.
 */
export const CROP_BUDGET_PX = 16e6;

export type Rect = { x: number; y: number; w: number; h: number };

/** Offscreen raster covering every crop on one page. Coordinates are scale-1. */
export type CropWindow = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** device px per scale-1 unit actually used (≤ the requested density) */
  k: number;
  /** canvas size in device px */
  cw: number;
  ch: number;
};

/**
 * Bounding window of `rects` GROWN BY `INK_SNAP` on every side, clamped to the
 * page box, at density `minK` (or lower if CROP_BUDGET_PX would be exceeded).
 * Returns null when there is nothing to raster.
 *
 * The margin is what snapToInk walks into: without it a figure sitting on the
 * window's own edge would have no pixels to look at and could never recover the
 * ink it clips. It costs ~13% of a typical window (8 pt of 200×300) and nothing
 * at all in output size — the extra band is rasterized, never cut.
 */
export function cropWindow(
  rects: readonly Rect[],
  pageW: number,
  pageH: number,
  minK = CROP_K,
): CropWindow | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    if (r.w <= 0 || r.h <= 0) continue;
    if (r.x < x0) x0 = r.x;
    if (r.y < y0) y0 = r.y;
    if (r.x + r.w > x1) x1 = r.x + r.w;
    if (r.y + r.h > y1) y1 = r.y + r.h;
  }
  x0 = Math.max(0, x0 - INK_SNAP);
  y0 = Math.max(0, y0 - INK_SNAP);
  x1 = Math.min(pageW, x1 + INK_SNAP);
  y1 = Math.min(pageH, y1 + INK_SNAP);
  const w = x1 - x0;
  const h = y1 - y0;
  if (!(w > 0) || !(h > 0)) return null;
  let k = Math.max(1, minK);
  if (w * h * k * k > CROP_BUDGET_PX) k = Math.max(1, Math.sqrt(CROP_BUDGET_PX / (w * h)));
  return { x: x0, y: y0, w, h, k, cw: Math.max(1, Math.ceil(w * k)), ch: Math.max(1, Math.ceil(h * k)) };
}

/** Canvas sized for `win`, ready to be passed to page.render. */
export function cropCanvas(win: CropWindow): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = win.cw;
  c.height = win.ch;
  return c;
}

/** Viewport that maps the page into `win`'s canvas (origin at the window's corner). */
export function cropViewport(page: PDFPageProxy, win: CropWindow) {
  return page.getViewport({ scale: win.k, offsetX: -win.x * win.k, offsetY: -win.y * win.k });
}

/** Frees a window raster immediately instead of waiting for GC (a page's worth of RGBA). */
export function releaseCanvas(c: HTMLCanvasElement) {
  c.width = 0;
  c.height = 0;
}

/**
 * Source rect of `r` inside `win`'s canvas, in device px.
 * Both edges are snapped OUTWARD (floor the near edge, ceil the far one) so
 * rounding can never slice ink off a crop's boundary — the old code rounded
 * both the origin and the size to nearest, which could eat up to a device pixel
 * on each side of every crop and showed up as clipped glyph stems and cut
 * figure rules. Clamped to the canvas, so a rect the window could not fully
 * cover degrades to its visible part rather than reading out of bounds.
 */
export function cropSrc(win: CropWindow, r: Rect): Src {
  const sx = Math.max(0, Math.floor((r.x - win.x) * win.k));
  const sy = Math.max(0, Math.floor((r.y - win.y) * win.k));
  const sw = Math.min(win.cw, Math.ceil((r.x + r.w - win.x) * win.k)) - sx;
  const sh = Math.min(win.ch, Math.ceil((r.y + r.h - win.y) * win.k)) - sy;
  return { sx, sy, sw, sh };
}

// ---- snapping a figure edge out to its ink ----------------------------------
// A stored figure region is GEOMETRY, not ink: the detector's box lands on the
// last baseline of a table, on the bounding box of a plotted path, on a
// diagram's frame — while the descenders, the axis labels and the arrowheads
// live a few points OUTSIDE it. Cutting the crop on that box shaves them off,
// and nothing else on the reflowed page shows those pixels. Measured on the
// user's 838-page book: 126 of 278 stored figure regions clip ink that is
// reproduced nowhere else — 9 to 16 device px past the edge in the bulk of
// the cases, and 16 pt or more in the worst ones.
//
// A CONSTANT pad does not fix this — measured on the same book, padding every
// region by 1/2/3 pt takes the straddling count from 132 to 201/155/159,
// because a fixed pad walks the edge into the NEXT text line about as often as
// it rescues the current one.
//
// So each edge is snapped to the ink itself. An edge only moves where ink
// actually CROSSES it (a dark pixel on both sides at the same column/row), and
// it then moves exactly as far as that ink continues — stopping at the first
// clear line, at INK_SNAP points, at the window, or at pixels another crop on
// the page already reproduces.
export type Src = { sx: number; sy: number; sw: number; sh: number };

/** Farthest a figure edge may travel while snapping to ink, in scale-1 pt. */
export const INK_SNAP = 4;
/** Luminance below which a pixel counts as ink (the straddle audit's threshold). */
const INK_DARK = 160;

/**
 * Reusable strip context for snapToInk. Deliberately NOT the window canvas:
 * keeping the readback on a small willReadFrequently scratch (the same trick
 * blankProbe uses) leaves the page raster itself GPU-backed — only four thin
 * edge strips per figure ever come back across the bus.
 */
export function inkProbe(): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  return c.getContext("2d", { willReadFrequently: true })!;
}

type Side = "t" | "b" | "l" | "r";

/** Device px one edge of `s` must travel outward to stop cutting ink. */
function edgeGrow(
  probe: CanvasRenderingContext2D,
  off: CanvasImageSource,
  win: CropWindow,
  s: Src,
  side: Side,
  max: number,
  others: readonly Src[],
): number {
  const vert = side === "t" || side === "b";
  // room left outside this edge inside the window raster
  const n = Math.min(
    max,
    side === "t" ? s.sy : side === "l" ? s.sx : side === "b" ? win.ch - (s.sy + s.sh) : win.cw - (s.sx + s.sw),
  );
  if (n <= 0) return 0;
  // strip = the last line INSIDE the crop plus the n lines outside it
  const sw = vert ? s.sw : n + 1;
  const sh = vert ? n + 1 : s.sh;
  if (sw <= 0 || sh <= 0) return 0;
  const sx = side === "l" ? s.sx - n : side === "r" ? s.sx + s.sw - 1 : s.sx;
  const sy = side === "t" ? s.sy - n : side === "b" ? s.sy + s.sh - 1 : s.sy;
  probe.canvas.width = sw;
  probe.canvas.height = sh;
  probe.drawImage(off, sx, sy, sw, sh, 0, 0, sw, sh);
  const d = probe.getImageData(0, 0, sw, sh).data;
  // line 0 is the inside line, line k is k px outside it; j runs along the edge
  const dark = (line: number, j: number) => {
    const col = vert ? j : side === "l" ? n - line : line;
    const row = side === "t" ? n - line : side === "b" ? line : j;
    const p = (row * sw + col) * 4;
    return 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2] < INK_DARK;
  };
  // ink already reproduced by another crop of this page is not lost, and
  // reaching for it would only duplicate it in two images
  const covered = (line: number, j: number) => {
    const px = side === "l" ? s.sx - line : side === "r" ? s.sx + s.sw - 1 + line : s.sx + j;
    const py = side === "t" ? s.sy - line : side === "b" ? s.sy + s.sh - 1 + line : s.sy + j;
    return others.some((o) => px >= o.sx && px < o.sx + o.sw && py >= o.sy && py < o.sy + o.sh);
  };
  let grow = 0;
  for (let j = 0; j < (vert ? sw : sh); j++) {
    if (!dark(0, j) || !dark(1, j) || covered(1, j)) continue; // no ink crosses here
    let k = 1;
    while (k < n && dark(k + 1, j) && !covered(k + 1, j)) k++;
    if (k > grow) grow = k;
  }
  return grow;
}

const SIDES: readonly Side[] = ["t", "b", "l", "r"];
/** Passes over the four edges — an edge that moves can expose ink on the next. */
const SNAP_PASSES = 4;

/**
 * `s` grown outward on each side until it stops cutting ink. Cheap when there
 * is nothing to fix: the four strips are ≤ INK_SNAP pt deep, the common case
 * exits on the first (inside-line) test of every column, and a pass that moves
 * nothing ends the walk.
 *
 * Iterated, because widening one edge puts a longer stretch of the page under
 * the next one: on the user's book a single pass leaves 39 of 161 regions still
 * cutting ink, four passes leave the 10 that are simply wider than INK_SNAP.
 */
export function snapToInk(
  probe: CanvasRenderingContext2D,
  off: CanvasImageSource,
  win: CropWindow,
  s: Src,
  others: readonly Src[],
): Src {
  const max = Math.max(1, Math.round(INK_SNAP * win.k));
  const grown: Record<Side, number> = { t: 0, b: 0, l: 0, r: 0 };
  let cur = s;
  for (let pass = 0; pass < SNAP_PASSES; pass++) {
    let moved = false;
    for (const side of SIDES) {
      const room = max - grown[side];
      if (room <= 0) continue;
      const d = edgeGrow(probe, off, win, cur, side, room, others);
      if (d <= 0) continue;
      grown[side] += d;
      moved = true;
      cur = {
        sx: s.sx - grown.l,
        sy: s.sy - grown.t,
        sw: s.sw + grown.l + grown.r,
        sh: s.sh + grown.t + grown.b,
      };
    }
    if (!moved) break;
  }
  return cur;
}

// ---- blank-candidate detection ---------------------------------------------
// Geometric figure candidates are often just tall whitespace (TOC leading,
// chapter-opener margins). Sample the candidate downsampled to ≤32×32 (canvas
// drawImage area-averages) and measure the luminance spread. Blank = variance
// below BLANK_VAR AND min-max range below BLANK_RANGE. Tuning math
// (255-luminance scale, 32×32 = 1024 samples): a pure margin is a constant fill
// → variance ~0, range 0. One hairline dark rule across the region averages to
// ≈1 row at ~214 → variance ≈ 48; a single small dark mark ≈ 1 sample at 100 →
// variance ≈ 22, range ≈ 155; a light-gray diagram (strokes ≈ 240 post-
// averaging, 5% cover) → variance ≈ 10, range ≈ 15+... all pass. False-positive
// side: only marks fainter than ~8 luminance levels off the background
// (invisible in practice) or covering <0.1% of the region can be skipped. The
// check runs on the ORIGINAL render — the dark-mode invert is a CSS filter and
// never reaches these pixels.
export const BLANK_VAR = 4;
export const BLANK_RANGE = 24;
export const SAMPLE = 32;

/** Reusable 32×32 probe context for isBlankCrop. */
export function blankProbe(): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = SAMPLE;
  c.height = SAMPLE;
  return c.getContext("2d", { willReadFrequently: true })!;
}

export function isBlankCrop(
  probe: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): boolean {
  const pw = Math.min(SAMPLE, sw);
  const ph = Math.min(SAMPLE, sh);
  probe.drawImage(src, sx, sy, sw, sh, 0, 0, pw, ph);
  const d = probe.getImageData(0, 0, pw, ph).data;
  let s = 0;
  let s2 = 0;
  let lo = 255;
  let hi = 0;
  const n = pw * ph;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    s += y;
    s2 += y * y;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const mean = s / n;
  return s2 / n - mean * mean < BLANK_VAR && hi - lo < BLANK_RANGE;
}

/**
 * Copy one crop out of the window raster into `dst`, sized to `dstW × dstH`
 * device px (never above the source resolution — supersample down, never up).
 * High-quality smoothing is what makes the 4× source pay off: Skia reduces in
 * steps/with mip levels, so the result is area-averaged rather than point-
 * sampled.
 */
export function blitCrop(
  dst: HTMLCanvasElement,
  off: CanvasImageSource,
  s: { sx: number; sy: number; sw: number; sh: number },
  dstW: number,
  dstH: number,
) {
  const w = Math.max(1, Math.min(s.sw, Math.round(dstW)));
  const h = Math.max(1, Math.min(s.sh, Math.round(dstH)));
  dst.width = w;
  dst.height = h;
  const g = dst.getContext("2d")!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(off, s.sx, s.sy, s.sw, s.sh, 0, 0, w, h);
}
