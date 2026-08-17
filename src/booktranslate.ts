// Whole-book background translation engine (local llama-server only).
// Store: <appDataDir>\translations\<djb2(bookPath)>.json. Paragraph coordinates
// are saved at viewport scale 1, so the reading overlay multiplies by the
// current scale. Resume works across app restarts: completed pages are listed
// in donePages and skipped on the next run.
// In plain-browser dev (vite ?test=, no Tauri IPC) the store falls back to
// localStorage so the engine stays testable outside the webview.

import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
import { OPS } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { FIG_CONTAIN, clusterParagraphs, detectFigures, hash, interArea, mul } from "./paragraphs";
import type { FigureRegion, Paragraph, ParaKind } from "./paragraphs";
import { loadGlossaryText, parseGlossary, translate } from "./translate";
import type { GlossaryEntry } from "./translate";

// dev-console handle: __pdferDev spreads this module, so classification and
// figure detection can be inspected in the browser without UI plumbing
export { clusterParagraphs, detectFigures } from "./paragraphs";

const MODEL = "HY-MT1.5-7B-Q4_K_M";
const CONCURRENCY = 3; // worker count only — actual requests draw from the shared ≤3 budget in translate.ts
const ETA_WINDOW = 5; // moving average over the last N text pages

// v2: paragraphs carry fh (glyph height at scale 1) + kind; kind:"other"
// (display math / tables) and kind:"caption" are never translated — tr stays ""
export type TrParagraph = Paragraph & { tr: string };
export type BookTranslation = {
  version: 2;
  bookPath: string;
  model: string;
  // glossary snapshot at start; later edits do not invalidate the store —
  // re-translating with a new glossary = deleteBookTranslation + fresh start
  glossaryText: string;
  pages: Record<number, TrParagraph[]>;
  // candidate figure regions per page, scale-1 coords, caption bboxes merged
  // in, reading order. Candidates may be blank whitespace — the renderer drops
  // blanks by pixel inspection of the offscreen render it makes for crops.
  figures: Record<number, FigureRegion[]>;
  donePages: number[];
  total: number;
  // median fh across prose paragraphs of completed pages — the v2 typesetter's
  // uniform body size reference; refreshed after every completed page
  bodyFh: number;
};

// on-disk shape across versions: v1 paragraphs lack fh/kind, v1 meta lacks
// bodyFh; stores written before figure detection lack figures
type StoredParagraph = Omit<TrParagraph, "fh" | "kind"> & { fh?: number; kind?: ParaKind };
type StoredBookTranslation = Omit<BookTranslation, "version" | "pages" | "bodyFh" | "figures"> & {
  version: number;
  pages: Record<number, StoredParagraph[]>;
  bodyFh?: number;
  figures?: Record<number, FigureRegion[]>;
};
export type BookProgress = { page: number; total: number; donePages: number; etaMs?: number };

// ---- store I/O -------------------------------------------------------------

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const lsKey = (bookPath: string) => `pdfer:booktr:${hash(bookPath)}`;

let dirP: Promise<string> | null = null;
const storeDir = () => (dirP ??= appDataDir().then((d) => `${d}\\translations`));
const storeFile = async (bookPath: string) => `${await storeDir()}\\${hash(bookPath)}.json`;

async function readStore(bookPath: string): Promise<string | null> {
  if (!IS_TAURI) return localStorage.getItem(lsKey(bookPath));
  try {
    return new TextDecoder().decode(await readFile(await storeFile(bookPath)));
  } catch {
    return null; // no store yet
  }
}

// atomic-ish: the whole JSON rewritten in a single write_file call
async function writeStore(st: BookTranslation): Promise<void> {
  const json = JSON.stringify(st);
  if (!IS_TAURI) {
    localStorage.setItem(lsKey(st.bookPath), json);
    return;
  }
  await mkdir(await storeDir(), { recursive: true }).catch(() => {});
  await writeFile(await storeFile(st.bookPath), new TextEncoder().encode(json));
}

// Accepts v1 and v2 stores. v1 data (pre fh/kind/bodyFh) is normalized in
// memory — fh:0, kind:"prose" — so old translations keep rendering; the
// version field is bumped to 2 here, so the engine's next writeStore persists
// v2 (a mid-book v1→v2 resume simply continues into the same store).
export async function loadBookTranslation(bookPath: string): Promise<BookTranslation | null> {
  try {
    const st = JSON.parse((await readStore(bookPath)) ?? "") as StoredBookTranslation;
    if ((st.version !== 1 && st.version !== 2) || st.bookPath !== bookPath) return null;
    for (const paras of Object.values(st.pages)) {
      for (const p of paras) {
        p.fh ??= 0;
        p.kind ??= "prose";
      }
    }
    st.bodyFh ??= 0;
    // pre-figure-detection stores simply lack regions until a re-translation
    st.figures ??= {};
    st.version = 2;
    return st as BookTranslation;
  } catch {
    return null;
  }
}

export async function hasBookTranslation(bookPath: string): Promise<boolean> {
  return (await loadBookTranslation(bookPath)) !== null;
}

export async function deleteBookTranslation(bookPath: string): Promise<void> {
  if (!IS_TAURI) {
    localStorage.removeItem(lsKey(bookPath));
    return;
  }
  if ((await readStore(bookPath)) === null) return;
  try {
    await remove(await storeFile(bookPath));
  } catch {
    // fs:allow-remove is not in the capability set yet — truncating the file
    // invalidates the store just as well (loadBookTranslation → null)
    await writeFile(await storeFile(bookPath), new Uint8Array()).catch(() => {});
  }
}

// ---- pipeline --------------------------------------------------------------

const MTX_ID = [1, 0, 0, 1, 0, 0];

// Raster-image bounding boxes of a page in CSS px at scale 1: walk the
// operator list with a CTM stack (save/restore/transform, inlined form
// XObjects), then map each paint*Image* op's unit square through
// viewport × CTM. Vector-drawn diagrams emit no image ops — the geometric gap
// detector in detectFigures covers those. Exported into __pdferDev via the
// module spread for console inspection.
export async function pageImageBoxes(page: PDFPageProxy): Promise<FigureRegion[]> {
  try {
    const { fnArray, argsArray } = await page.getOperatorList();
    const vt = page.getViewport({ scale: 1 }).transform as number[];
    let ctm = MTX_ID;
    const stack: number[][] = [];
    const boxes: FigureRegion[] = [];
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = argsArray[i] as unknown[] | null;
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? MTX_ID;
      else if (fn === OPS.transform) ctm = mul(ctm, args as number[]);
      else if (fn === OPS.paintFormXObjectBegin) {
        // begin = save + optional matrix (pdfjs inlines the form's ops next)
        stack.push(ctm);
        const m = args?.[0];
        if (Array.isArray(m) && m.length === 6) ctm = mul(ctm, m as number[]);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? MTX_ID;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
        const m = mul(vt, ctm); // device transform of the image's unit square
        const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
        const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        boxes.push({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
      }
    }
    return boxes;
  } catch {
    return []; // op-list failure only loses raster candidates; gap detection stands
  }
}

// uniform body-size reference: median fh over prose paragraphs of every
// completed page (pages map only ever holds completed pages)
function medianBodyFh(pages: Record<number, TrParagraph[]>): number {
  const fhs: number[] = [];
  for (const paras of Object.values(pages)) for (const p of paras) if (p.kind === "prose" && p.fh > 0) fhs.push(p.fh);
  fhs.sort((a, b) => a - b);
  return fhs.length ? fhs[fhs.length >> 1] : 0;
}

// one paragraph: retry a failed request once, then give up with "" (the page
// still completes); aborts always propagate so the page is NOT marked done
async function translateRetry(text: string, glossary: GlossaryEntry[], signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await translate(text, glossary, { signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt >= 1) return "";
    }
  }
}

// Translate the whole book page by page, CONCURRENCY paragraphs in flight.
// Pages already in donePages are skipped (resume). Empty-text pages (covers,
// figures-only) count as done immediately. After every completed page the
// store is rewritten on disk, so cancel (AbortSignal) never loses a page.
export async function startBookTranslation(
  doc: PDFDocumentProxy,
  bookPath: string,
  opts: { onProgress?: (p: BookProgress) => void; signal?: AbortSignal; pageLimit?: number } = {},
): Promise<BookTranslation> {
  const { onProgress, signal, pageLimit } = opts;
  const total = doc.numPages;
  const store: BookTranslation = (await loadBookTranslation(bookPath)) ?? {
    version: 2,
    bookPath,
    model: MODEL,
    glossaryText: loadGlossaryText(bookPath),
    pages: {},
    figures: {},
    donePages: [],
    total,
    bodyFh: 0,
  };
  store.total = total;
  const done = new Set(store.donePages);
  const glossary = parseGlossary(store.glossaryText);
  const durations: number[] = [];
  const last = Math.min(total, Math.max(1, pageLimit ?? total));

  for (let n = 1; n <= last; n++) {
    if (signal?.aborted) break;
    if (done.has(n)) continue;

    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const vp1 = page.getViewport({ scale: 1 });
    const paras = clusterParagraphs(content.items, vp1);
    // candidate figure regions; reclassifies adjacent "Figure N:" prose
    // paragraphs to kind:"caption" (mutates paras) and merges their bboxes
    const figures = detectFigures(paras, vp1.width, vp1.height, await pageImageBoxes(page));

    const t0 = performance.now();
    const out: TrParagraph[] = paras.map((p) => ({ ...p, tr: "" }));
    // kind:"other" (display math / tables) and kind:"caption" are skipped —
    // tr stays "", the v2 typesetter shows original image crops instead.
    // Prose mostly contained in a figure region is skipped too: its pixels
    // are already in the region's crop and the typesetter excludes it from
    // the flow (FIG_CONTAIN) — translating diagram labels only wastes wire
    // requests and invites hallucinated sentence expansions
    const todo = out.filter(
      (p) => p.kind === "prose" && !figures.some((r) => interArea(p, r) >= FIG_CONTAIN * p.w * p.h),
    );
    if (todo.length) {
      let i = 0;
      const worker = async () => {
        for (;;) {
          const k = i++;
          if (k >= todo.length || signal?.aborted) return;
          todo[k].tr = await translateRetry(todo[k].text, glossary, signal);
        }
      };
      let aborted = false;
      try {
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      } catch {
        aborted = true; // only aborts reject (translateRetry swallows other errors)
      }
      if (aborted || signal?.aborted) break; // page incomplete — resume redoes it
    }

    store.pages[n] = out;
    store.figures[n] = figures;
    done.add(n);
    store.donePages = [...done].sort((a, b) => a - b);
    store.bodyFh = medianBodyFh(store.pages);
    await writeStore(store);

    if (todo.length) {
      durations.push(performance.now() - t0);
      if (durations.length > ETA_WINDOW) durations.shift();
    }
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : undefined;
    onProgress?.({
      page: n,
      total,
      donePages: done.size,
      etaMs: avg === undefined ? undefined : Math.round(avg * (total - done.size)),
    });
  }
  return store;
}
