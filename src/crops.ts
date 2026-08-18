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
 * Bounding window of `rects`, clamped to the page box, at density `minK` (or
 * lower if CROP_BUDGET_PX would be exceeded). Returns null when there is
 * nothing to raster.
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
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(pageW, x1);
  y1 = Math.min(pageH, y1);
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
export function cropSrc(win: CropWindow, r: Rect) {
  const sx = Math.max(0, Math.floor((r.x - win.x) * win.k));
  const sy = Math.max(0, Math.floor((r.y - win.y) * win.k));
  const sw = Math.min(win.cw, Math.ceil((r.x + r.w - win.x) * win.k)) - sx;
  const sh = Math.min(win.ch, Math.ceil((r.y + r.h - win.y) * win.k)) - sy;
  return { sx, sy, sw, sh };
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
