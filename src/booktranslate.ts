// Whole-book background translation engine (local llama-server only).
// Store: <appDataDir>\translations\<contentKey>.json, where contentKey is the
// content-derived book identity from bookid.ts (WP-M) — the store survives the
// book file being moved or renamed. Stores written by earlier builds under
// <djb2(bookPath)>.json are still readable (path fallback) and are adopted by
// bindBook on first open. Paragraph coordinates are saved at viewport scale 1,
// so the reading overlay multiplies by the current scale. Resume works across
// app restarts: completed pages are listed in donePages and skipped on the
// next run. In plain-browser dev (vite ?test=, no Tauri IPC) the store falls
// back to localStorage so the engine stays testable outside the webview.

import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readFile, remove, rename, stat, writeFile } from "@tauri-apps/plugin-fs";
import { OPS, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  FIG_CONTAIN,
  clusterParagraphs,
  detectFigures,
  detectFurniture,
  forgetFurnitureVotes,
  hash,
  interArea,
  mul,
  newFurnitureMemory,
  rememberFurniture,
} from "./paragraphs";
import type { FigureRegion, FurnitureMemory, Paragraph, ParaKind } from "./paragraphs";
import { CITE_MARK } from "./glossarygen";
import { ModelUnavailableError, hydrateGlossary, isServerUp, parseGlossary, translate } from "./translate";
import type { GlossaryEntry } from "./translate";
import { bookKey, contentKey, setBookKey } from "./bookid";

// dev-console handle: __pdferDev spreads this module, so classification and
// figure detection can be inspected in the browser without UI plumbing
export { clusterParagraphs, detectFigures } from "./paragraphs";

const MODEL = "HY-MT1.5-7B-Q4_K_M";
const CONCURRENCY = 3; // worker count only — actual requests draw from the shared ≤3 budget in translate.ts
const ETA_WINDOW = 5; // moving average over the last N text pages

// v2: paragraphs carry fh (glyph height at scale 1) + kind; only kind:"prose"
// is ever translated — "other" (display math / tables), "caption" and
// "furniture" (running headers/footers) keep tr ""
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
  // bibliography/reference pages (isRefPage): completed WITHOUT translation
  // (every tr stays "") — the viewer must render these pages as the ORIGINAL
  // even in translation mode. Additive: pre-refPage stores simply lack the
  // field (normalized to [] on load) and old builds ignore it.
  refPages: number[];
  donePages: number[];
  total: number;
  // median fh across prose paragraphs of completed pages — the v2 typesetter's
  // uniform body size reference; refreshed after every completed page
  bodyFh: number;
  // «Обновить перевод» watermark, present only mid-update: pages 1..updatedThrough
  // are already re-clustered with the CURRENT engine code (an interrupted update
  // resumes above it); removed when the sweep reaches the last page. Additive —
  // old builds ignore it, version stays 2.
  updatedThrough?: number;
};

// on-disk shape across versions: v1 paragraphs lack fh/kind, v1 meta lacks
// bodyFh; stores written before figure detection lack figures
type StoredParagraph = Omit<TrParagraph, "fh" | "kind"> & { fh?: number; kind?: ParaKind };
type StoredBookTranslation = Omit<BookTranslation, "version" | "pages" | "bodyFh" | "figures" | "refPages"> & {
  version: number;
  pages: Record<number, StoredParagraph[]>;
  bodyFh?: number;
  figures?: Record<number, FigureRegion[]>;
  refPages?: number[];
};
export type BookProgress = { page: number; total: number; donePages: number; etaMs?: number };

// ---- store I/O -------------------------------------------------------------

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
// resolved name: content key once the book is bound, path hash before/without
const storeKey = (bookPath: string) => bookKey(bookPath) ?? hash(bookPath);
// a bound book whose content key differs from the path hash may still have a
// pre-WP-M store under the old name — reads fall back to it
const hasLegacyName = (bookPath: string) => storeKey(bookPath) !== hash(bookPath);
const lsKey = (bookPath: string) => `pdfer:booktr:${storeKey(bookPath)}`;
const lsLegacyKey = (bookPath: string) => `pdfer:booktr:${hash(bookPath)}`;

let dirP: Promise<string> | null = null;
const storeDir = () => (dirP ??= appDataDir().then((d) => `${d}\\translations`));
const storeFile = async (bookPath: string) => `${await storeDir()}\\${storeKey(bookPath)}.json`;
const legacyStoreFile = async (bookPath: string) => `${await storeDir()}\\${hash(bookPath)}.json`;

async function readTextFile(path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await readFile(path));
  } catch {
    return null;
  }
}

async function readStore(bookPath: string): Promise<string | null> {
  if (!IS_TAURI) {
    return (
      localStorage.getItem(lsKey(bookPath)) ??
      (hasLegacyName(bookPath) ? localStorage.getItem(lsLegacyKey(bookPath)) : null)
    );
  }
  const json = await readTextFile(await storeFile(bookPath));
  if (json !== null || !hasLegacyName(bookPath)) return json;
  return readTextFile(await legacyStoreFile(bookPath)); // pre-WP-M store, not migrated yet
}

// Torn-write-proof persistence: the JSON lands in a sibling .tmp first, then
// replaces the store in one rename (std::fs::rename overwrites on Windows), so
// a crash mid-write leaves the previous complete store, never a truncated one
// that would silently restart an 800-page translation from page 1.
async function atomicWrite(file: string, data: Uint8Array): Promise<void> {
  const tmp = `${file}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch {
    await remove(tmp).catch(() => {});
    await writeFile(file, data); // non-atomic beats not persisting (e.g. rename permission missing)
  }
}

async function writeStore(st: BookTranslation): Promise<void> {
  const json = JSON.stringify(st);
  if (!IS_TAURI) {
    localStorage.setItem(lsKey(st.bookPath), json);
    return;
  }
  await mkdir(await storeDir(), { recursive: true }).catch(() => {});
  await atomicWrite(await storeFile(st.bookPath), new TextEncoder().encode(json));
}

// ---- content-identity binding (WP-M) ----------------------------------------

// bookPath is the 2nd field JSON.stringify writes, so the raw prefix answers
// "whose store is this" without parsing many megabytes of pages
function headerBookPath(json: string): string | null {
  const m = json.slice(0, 2048).match(/"bookPath":"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
}

// When a moved book is re-attached to its store, its path-keyed localStorage
// satellites (reading position, view mode, legacy glossary) come along —
// fill-if-absent so data the new path already has is never clobbered.
function migrateSatellites(oldPath: string, newPath: string): void {
  if (!oldPath || oldPath === newPath) return;
  for (const pref of ["pdfer:pos:", "pdfer:view:", "pdfer:glossary:"]) {
    const v = localStorage.getItem(pref + oldPath);
    if (v !== null && localStorage.getItem(pref + newPath) === null) localStorage.setItem(pref + newPath, v);
  }
}

// Bind a book's content identity and reconcile the store on disk. Called with
// the book's bytes wherever they are already in memory: App's loadBytes (before
// pdf.js transfers the buffer to its worker) and openRunDoc. Three cases:
//  - a content-keyed store exists but names another path → the same book was
//    moved/renamed (or a copy opened): rewrite bookPath so the store attaches
//    to the new location, and bring the path-keyed satellites along;
//  - only a pre-WP-M path-keyed store exists → adopt it with a single rename
//    (no parse, no copy: the data is never at risk mid-migration);
//  - neither → fresh book, nothing to do.
// All failures are swallowed: binding is an optimization pass — reads keep
// working through the legacy-name fallback even if every step here fails.
export async function bindBook(bookPath: string, bytes: Uint8Array): Promise<void> {
  const ck = contentKey(bytes);
  if (bookKey(bookPath) === ck) return; // bound and reconciled this session
  setBookKey(bookPath, ck);
  try {
    if (!IS_TAURI) {
      const ckLs = `pdfer:booktr:${ck}`;
      const json = localStorage.getItem(ckLs);
      if (json !== null) {
        const owner = headerBookPath(json);
        if (owner !== bookPath) {
          const st = JSON.parse(json) as StoredBookTranslation;
          migrateSatellites(owner ?? st.bookPath, bookPath);
          st.bookPath = bookPath;
          localStorage.setItem(ckLs, JSON.stringify(st));
        }
      } else {
        const leg = localStorage.getItem(lsLegacyKey(bookPath));
        if (leg !== null) {
          localStorage.setItem(ckLs, leg);
          localStorage.removeItem(lsLegacyKey(bookPath));
        }
      }
      return;
    }
    const dir = await storeDir();
    const ckFile = `${dir}\\${ck}.json`;
    const json = await readTextFile(ckFile);
    if (json !== null) {
      const owner = headerBookPath(json);
      if (owner !== bookPath) {
        const st = JSON.parse(json) as StoredBookTranslation; // parse failure → catch below, file untouched
        migrateSatellites(owner ?? st.bookPath, bookPath);
        st.bookPath = bookPath;
        await atomicWrite(ckFile, new TextEncoder().encode(JSON.stringify(st)));
      }
    } else if (ck !== hash(bookPath)) {
      // adopt a pre-WP-M store; failure (none there / no rename permission)
      // is fine — readStore's legacy fallback still finds it
      await rename(await legacyStoreFile(bookPath), ckFile).catch(() => {});
    }
  } catch (e) {
    console.error("book bind failed", e);
  }
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
    // pre-refPage stores: no pages were classified — nothing to flag
    st.refPages ??= [];
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
    localStorage.removeItem(lsLegacyKey(bookPath));
    return;
  }
  // both names: the resolved (content-keyed) store and a possible pre-WP-M twin
  for (const f of new Set([await storeFile(bookPath), await legacyStoreFile(bookPath)])) {
    if (!(await stat(f).catch(() => null))) continue;
    try {
      await remove(f);
    } catch {
      // file locked — truncating invalidates the store just as well
      // (loadBookTranslation → null)
      await writeFile(f, new Uint8Array()).catch(() => {});
    }
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

// ---- bibliography pages (refPage) -------------------------------------------
// Reference lists come out mangled by translation (author names "translated",
// venues paraphrased — the user reads them as broken «Отображение источников»),
// and their content is citations, not prose: translating them is pure harm.
// Classification is PAGE-LEVEL over citation markers — years, DOI/arXiv, URLs
// (CITE_MARK, the same net glossarygen uses to keep bibliographies out of term
// statistics). Marker DENSITY alone cannot separate a references page from
// citation-heavy running prose (measured on the test book: survey prose peaks
// at the same 4–6 markers per 1000 chars as sparse bibliography pages), so the
// decisive signal is ENTRY SHAPE: paragraphs that BOTH open like a reference
// entry ("[12] …", "A. Askari and S. Verberne. 2021 …", "Salton, G. …") AND
// carry a citation marker. Prose paragraphs virtually never open with an
// author pattern, however many citations they contain; a references page is
// made of nothing else (5+ entries per page at book layouts; the test book
// runs 6–15). The marker floor on top keeps degenerate matches honest.
// Flagged pages complete immediately with every tr:"" and are listed in
// store.refPages — the viewer renders them as the ORIGINAL page in translation
// mode. Deliberately page-level only: a references section STARTING mid-page
// keeps its page translated (the chapter tail above matters more than the
// first few entries). One entry-shape blind spot — a page-long single entry
// (a 100-author collaboration paper) — is closed by the sandwich rule at the
// flag site in startBookTranslation.
const REF_ENTRY_MIN = 5; // entry-shaped, marker-bearing paragraphs per page
const REF_MARKS_MIN = 10; // total citation markers per page
// bracket label, "A. Surname" initials-first, or "Surname, A." surname-first
const REF_ENTRY_RE = /^(?:\[\d+\]\s|[A-ZА-ЯЁ]\.\s?[A-ZА-ЯЁ]|[A-ZА-ЯЁ][A-Za-zà-öø-ÿА-Яа-яЁё'’-]+,\s+[A-ZА-ЯЁ]\.)/;

export function isRefPage(paras: readonly Paragraph[]): boolean {
  let entries = 0;
  let marks = 0;
  for (const p of paras) {
    if (p.kind === "furniture") continue;
    const m = p.text.match(CITE_MARK)?.length ?? 0;
    marks += m;
    if (m && REF_ENTRY_RE.test(p.text)) entries++;
  }
  return entries >= REF_ENTRY_MIN && marks >= REF_MARKS_MIN;
}

// uniform body-size reference: median fh over prose paragraphs of every
// completed page (pages map only ever holds completed pages). refPages are
// excluded: bibliography entries are typeset smaller than body (0.9x on the
// test book) and 100+ reference pages of them would drag the median down,
// silently re-labeling ordinary subsection headings as trHead in the reflow.
function medianBodyFh(pages: Record<number, TrParagraph[]>, refPages: readonly number[]): number {
  const skip = new Set(refPages);
  const fhs: number[] = [];
  for (const [k, paras] of Object.entries(pages)) {
    if (skip.has(Number(k))) continue;
    for (const p of paras) if (p.kind === "prose" && p.fh > 0) fhs.push(p.fh);
  }
  fhs.sort((a, b) => a - b);
  return fhs.length ? fhs[fhs.length >> 1] : 0;
}

// ---- incremental update («Обновить перевод») --------------------------------
// After engine improvements (better clustering, furniture/refPage detection)
// the stored page structure is stale, but most paragraph TEXT is unchanged —
// a full re-translation would spend hours re-doing identical work. carryOver
// moves existing translations onto the freshly-clustered paragraphs: exact
// normalized-text match first, then a high-overlap prefix match (a superscript
// marker dropped near the paragraph tail, a re-joined hyphenation). A changed
// opening (split/merged paragraphs, an early in-text change) deliberately
// fails both matches — those paragraphs are re-translated, which is the whole
// point of the update. Old paragraphs are consumed at most once; old tr:""
// entries carry nothing, so soft-failed paragraphs are re-requested for free.

const normText = (s: string): string => s.replace(/\s+/g, " ").trim();

function lcpLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

const CARRY_PREFIX = 0.9; // common prefix must cover ≥90% of the LONGER text
const CARRY_MIN = 12; // both texts non-trivial, chars

type CarryEntry = { tr: string; k: string; used: boolean };

// mutates matched paragraphs' tr in place; returns those still needing the wire
function carryOver(todo: TrParagraph[], old: readonly TrParagraph[]): TrParagraph[] {
  const pool: CarryEntry[] = old
    .filter((o) => o.tr !== "")
    .map((o) => ({ tr: o.tr, k: normText(o.text), used: false }));
  const byText = new Map<string, CarryEntry[]>();
  for (const e of pool) {
    const l = byText.get(e.k);
    if (l) l.push(e);
    else byText.set(e.k, [e]);
  }
  const rest: TrParagraph[] = [];
  for (const p of todo) {
    const e = byText.get(normText(p.text))?.find((c) => !c.used);
    if (e) {
      e.used = true;
      p.tr = e.tr;
    } else rest.push(p);
  }
  const wire: TrParagraph[] = [];
  for (const p of rest) {
    const k = normText(p.text);
    const e = pool.find(
      (c) =>
        !c.used &&
        Math.min(k.length, c.k.length) >= CARRY_MIN &&
        lcpLen(k, c.k) >= CARRY_PREFIX * Math.max(k.length, c.k.length),
    );
    if (e) {
      e.used = true;
      p.tr = e.tr;
    } else wire.push(p);
  }
  return wire;
}

// abortable delay; rejects with AbortError so worker loops unwind like a fetch abort
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const abortErr = () => new DOMException("translate aborted", "AbortError");
    if (signal?.aborted) return rej(abortErr());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      res();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      rej(abortErr());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Shared per-run outage gate. On a network-level failure every worker funnels
// through here: a single health probe decides "transient blip" (return at
// once, redo the request) vs "server down" (report the stall once, poll
// /health every 3s until it answers, report recovery). Concurrent callers
// join the same in-flight wait, so one outage produces one stall
// notification and one polling loop, not CONCURRENCY of them.
function makeHealthGate(onStall?: (stalled: boolean) => void): (signal?: AbortSignal) => Promise<void> {
  let waiting: Promise<void> | null = null;
  return (signal?: AbortSignal) => {
    waiting ??= (async () => {
      if (await isServerUp()) return; // single-request blip — server is fine
      onStall?.(true);
      try {
        do {
          await sleep(3000, signal); // abort rejects here → run unwinds
        } while (!(await isServerUp()));
      } finally {
        onStall?.(false); // recovered (or aborted — the run's teardown resets state anyway)
      }
    })().finally(() => {
      waiting = null;
    });
    return waiting;
  };
}

// One paragraph. Failure handling is asymmetric on purpose:
//  - network failure (ModelUnavailableError): NEVER resolves to "" — the
//    paragraph waits out the outage via the shared gate and is re-requested,
//    so an unreachable server can no longer mint fake "translated" pages;
//  - bad output (HTTP 4xx/500, parse-level errors): one retry, then give up
//    with "" — the page still completes and the typesetter shows the original
//    as an image crop;
//  - aborts always propagate so the page is NOT marked done.
async function translateRetry(
  text: string,
  glossary: GlossaryEntry[],
  waitHealthy: (signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<string> {
  let soft = 0;
  for (let net = 0; ; ) {
    try {
      return await translate(text, glossary, { signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e instanceof ModelUnavailableError) {
        net++;
        // backoff bounds the loop rate if /health answers but completions
        // keep dying (misconfig, proxy) — stalled honestly, never ""
        await sleep(Math.min(500 * net, 5000), signal);
        await waitHealthy(signal);
        continue;
      }
      if (++soft >= 2) return "";
    }
  }
}

// Translate the whole book page by page, CONCURRENCY paragraphs in flight.
// Pages already in donePages are skipped (resume). Empty-text pages (covers,
// figures-only) count as done immediately. After every completed page the
// store is rewritten on disk, so cancel (AbortSignal) never loses a page.
// A model outage never completes pages: the run stalls in place (onStall
// reports it) and resumes by itself when /health answers again.
// update:true («Обновить перевод») changes the sweep, not the machinery: done
// pages above store.updatedThrough are re-clustered with current code,
// translations are carried over by text match (carryOver) and only new/changed
// paragraphs hit the model — a page whose paragraphs all match completes with
// zero requests. donePages/glossary/version semantics are untouched.
export async function startBookTranslation(
  doc: PDFDocumentProxy,
  bookPath: string,
  opts: {
    onProgress?: (p: BookProgress) => void;
    onStall?: (stalled: boolean) => void;
    signal?: AbortSignal;
    pageLimit?: number;
    update?: boolean;
  } = {},
): Promise<BookTranslation> {
  const { onProgress, onStall, signal, pageLimit, update } = opts;
  const waitHealthy = makeHealthGate(onStall);
  const total = doc.numPages;
  const store: BookTranslation = (await loadBookTranslation(bookPath)) ?? {
    version: 2,
    bookPath,
    model: MODEL,
    // hydrate, not the sync getter: a run may start before any UI touched the
    // glossary this session, and the snapshot must see the appdata file
    glossaryText: await hydrateGlossary(bookPath),
    pages: {},
    figures: {},
    refPages: [],
    donePages: [],
    total,
    bodyFh: 0,
  };
  store.total = total;
  // update resume point: pages at or below it already carry current-code
  // structure and are skipped; 0 = fresh update, sweep from page 1
  const updatedFrom = update ? store.updatedThrough ?? 0 : 0;
  // per-run cross-page furniture memory; a resumed store re-seeds it (offset
  // votes + repetition window from already-stored furniture, zone re-derived
  // from each page's own content bounds), so the first page after a resume
  // confirms its running header exactly like an uninterrupted run would —
  // detectFurniture prunes whatever falls outside its rolling window.
  // ALL stored furniture pages seed — including pages an update will revisit:
  // a paused update otherwise resumes with a vote pool below quorum and
  // re-translates the very headers it already knew (the running-header bug,
  // resurrected). The revisit double-count is handled at the sweep site: a
  // page retracts its own seeded votes right before detectFurniture re-votes
  // its live candidates (forgetFurnitureVotes).
  const furn: FurnitureMemory = newFurnitureMemory();
  for (const [k, paras] of Object.entries(store.pages)) {
    if (!paras.some((p) => p.kind === "furniture")) continue;
    const cT = Math.min(...paras.map((p) => p.y));
    const cB = Math.max(...paras.map((p) => p.y + p.h));
    for (const p of paras)
      if (p.kind === "furniture") rememberFurniture(furn, Number(k), p, p.y - cT <= cB - (p.y + p.h) ? "t" : "b");
  }
  // never mint pages against a dead server: one probe up front — an outage
  // stalls the run right here, before even a text-less page can complete and
  // write the first store byte (auto-resumes when /health answers)
  await waitHealthy(signal);
  const done = new Set(store.donePages);
  const glossary = parseGlossary(store.glossaryText);
  const durations: number[] = [];
  const last = Math.min(total, Math.max(1, pageLimit ?? total));

  for (let n = 1; n <= last; n++) {
    if (signal?.aborted) break;
    // update mode revisits done pages above the watermark; a page the update
    // has never completed (partial store) is translated in full either way
    if (done.has(n) && (!update || n <= updatedFrom)) continue;

    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const vp1 = page.getViewport({ scale: 1 });
    const paras = clusterParagraphs(content.items, vp1);
    // running headers/footers → kind:"furniture", BEFORE figure detection
    // (the caption pass only reclassifies prose — a marked header can no
    // longer be claimed) and BEFORE the refPage gate (reference pages carry
    // headers too and must keep feeding the cross-page memory).
    // Update revisit: this page seeded the memory at run start (its votes fed
    // the quorum for the pages before it) — withdraw its own stored votes now
    // so detectFurniture's re-vote of the live candidates doesn't double-count
    if (update && n > updatedFrom)
      for (const p of store.pages[n] ?? []) if (p.kind === "furniture") forgetFurnitureVotes(furn, n, p);
    detectFurniture(paras, n, furn);
    // bibliography page: completes untranslated below (todo stays empty) and
    // skips the figure pass — the viewer shows the original page wholesale,
    // stored regions would never render
    const refPage = isRefPage(paras);
    // candidate figure regions; reclassifies adjacent "Figure N:" prose
    // paragraphs to kind:"caption" (mutates paras) and merges their bboxes
    const figures = refPage ? [] : detectFigures(paras, vp1.width, vp1.height, await pageImageBoxes(page));

    const t0 = performance.now();
    const out: TrParagraph[] = paras.map((p) => ({ ...p, tr: "" }));
    // Only kind:"prose" is translated: kind:"other" (display math / tables)
    // and kind:"caption" get image crops instead, kind:"furniture" (running
    // headers/footers) is dropped from the reflow entirely — tr stays "".
    // Prose mostly contained in a figure region is skipped too: its pixels
    // are already in the region's crop and the typesetter excludes it from
    // the flow (FIG_CONTAIN) — translating diagram labels only wastes wire
    // requests and invites hallucinated sentence expansions
    let todo = refPage
      ? []
      : out.filter((p) => p.kind === "prose" && !figures.some((r) => interArea(p, r) >= FIG_CONTAIN * p.w * p.h));
    // update: pull translations over from the old clustering of this page —
    // only genuinely new/changed paragraphs stay on the wire list
    const old = update ? store.pages[n] : undefined;
    if (old) todo = carryOver(todo, old);
    if (todo.length) {
      let i = 0;
      const worker = async () => {
        for (;;) {
          const k = i++;
          if (k >= todo.length || signal?.aborted) return;
          todo[k].tr = await translateRetry(todo[k].text, glossary, waitHealthy, signal);
        }
      };
      let aborted = false;
      try {
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      } catch {
        // only aborts reject: translateRetry waits out network outages and
        // swallows bad-output errors — anything else unwinding here must not
        // mark the page done either, so "treat as aborted" is the safe read
        aborted = true;
      }
      if (aborted || signal?.aborted) break; // page incomplete — resume redoes it
    }

    store.pages[n] = out;
    store.figures[n] = figures;
    // update: this page's classification is fresh — an old flag no longer
    // backed by isRefPage on the CURRENT clustering must not survive
    if (update) store.refPages = store.refPages.filter((p) => p !== n);
    if (refPage && !store.refPages.includes(n)) {
      store.refPages = [...store.refPages, n].sort((a, b) => a - b);
      // sandwich rule: a lone non-ref page between two ref pages sits INSIDE
      // a bibliography run — isRefPage's entry-shape test loses only to a
      // page-long single entry (seen: a 100-author collaboration paper), and
      // that only ever happens mid-bibliography. Flag it retroactively; its
      // already-spent translation simply stops rendering (original shown).
      if (store.refPages.includes(n - 2) && !store.refPages.includes(n - 1) && done.has(n - 1))
        store.refPages = [...store.refPages, n - 1].sort((a, b) => a - b);
    }
    done.add(n);
    store.donePages = [...done].sort((a, b) => a - b);
    if (update) store.updatedThrough = n;
    store.bodyFh = medianBodyFh(store.pages, store.refPages);
    await writeStore(store);

    // update pages complete in milliseconds when nothing hit the wire — their
    // durations belong in the ETA too (it forecasts the sweep, not translation)
    if (update || todo.length) {
      durations.push(performance.now() - t0);
      if (durations.length > ETA_WINDOW) durations.shift();
    }
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : undefined;
    // update progress counts swept pages (the sequential position), not
    // donePages — a fully-translated store is 100% done before page 1
    const prog = update ? n : done.size;
    onProgress?.({
      page: n,
      total,
      donePages: prog,
      etaMs: avg === undefined ? undefined : Math.round(avg * (total - prog)),
    });
  }
  // full-book update finished: every page now carries current-code structure —
  // drop the watermark so a future update sweeps from page 1 again
  if (update && !signal?.aborted && last === total && (store.updatedThrough ?? 0) >= total) {
    delete store.updatedThrough;
    await writeStore(store);
  }
  return store;
}

// ---- path-keyed run manager (решение Р-6: ран живёт фоном) ------------------
//
// Runs are keyed by bookPath and own their whole lifecycle: the engine keeps
// translating when the reader returns to the library or opens another book.
// Each run opens its OWN PDFDocumentProxy from the book file (the viewer's doc
// is destroyed on close/switch — the run must not depend on it) and destroys
// it when the run settles. UI surfaces subscribe via onRunsChange and read
// snapshots with getRun/listRuns; pause = stopRun (abort + settle). The store
// on disk stays the single source of truth — the manager only mirrors live
// progress for chips and toolbars.

export type RunInfo = {
  bookPath: string;
  done: number; // completed pages — or swept pages for an update run (seeded from the store before page 1)
  total: number; // 0 only for the moment before the run's doc is open
  etaMs?: number;
  stalled: boolean; // engine is waiting out a model outage (auto-resumes)
  update: boolean; // «Обновить перевод» sweep, not a fresh/resumed translation
};

type Run = { ctrl: AbortController; promise: Promise<void>; info: RunInfo };
const runs = new Map<string, Run>();
const runListeners = new Set<() => void>();
const emitRuns = () => runListeners.forEach((fn) => fn());

export function onRunsChange(fn: () => void): () => void {
  runListeners.add(fn);
  return () => void runListeners.delete(fn);
}

export const getRun = (bookPath: string): RunInfo | undefined => runs.get(bookPath)?.info;
// snapshot copies — safe to hold in React state while the live infos mutate
export const listRuns = (): RunInfo[] => [...runs.values()].map((r) => ({ ...r.info }));

// The run's own document: bytes re-read from the book file into a dedicated
// proxy (its own worker), same asset options as the viewer's getDocument —
// cmaps matter for CID-font text extraction. ?test= dev books are URLs.
async function openRunDoc(bookPath: string): Promise<PDFDocumentProxy> {
  const data = /^https?:\/\//i.test(bookPath)
    ? new Uint8Array(await (await fetch(bookPath)).arrayBuffer())
    : await readFile(bookPath);
  // content identity before getDocument transfers the buffer to the worker —
  // the run's store I/O must address the durable key (WP-M)
  await bindBook(bookPath, data);
  return getDocument({
    data,
    cMapUrl: "/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/standard_fonts/",
    wasmUrl: "/wasm/",
    iccUrl: "/iccs/",
  }).promise;
}

// abort the run and wait until the pipeline fully settles (last store write
// flushed, run doc destroyed) — safe to delete the store right after
export async function stopRun(bookPath: string): Promise<void> {
  const r = runs.get(bookPath);
  if (!r) return;
  r.ctrl.abort();
  await r.promise.catch(() => {});
}

// One launcher for both run flavors. A book has at most ONE active run: a
// second start (either flavor) joins the run already in flight — the menu
// hides «Обновить перевод» while a run is active, so the join is a guard,
// not a UI path. The returned promise settles when the run does; it rejects
// ONLY when the book file cannot be opened — pipeline errors (abort included)
// are logged and swallowed, because the per-page store already holds every
// finished page.
function launchRun(bookPath: string, update: boolean, pageLimit?: number): Promise<void> {
  const existing = runs.get(bookPath);
  if (existing) return existing.promise;
  const ctrl = new AbortController();
  const info: RunInfo = { bookPath, done: 0, total: 0, stalled: false, update };
  const promise = (async () => {
    // resumed runs show their real percentage BEFORE the (slow) doc open: the
    // toolbar band must move within the click's first beat, not after a 38MB
    // file read — completed pages for translation, the watermark for an update.
    // Best-effort: a moved book resolves its store only after bindBook inside
    // openRunDoc — the post-open seeding below covers that case.
    const st0 = await loadBookTranslation(bookPath).catch(() => null);
    if (st0) {
      info.done = update ? st0.updatedThrough ?? 0 : st0.donePages.length;
      info.total = st0.total;
      emitRuns();
    }
    const doc = await openRunDoc(bookPath); // open failure surfaces to the caller
    try {
      info.total = doc.numPages;
      // re-seed after binding: the pre-open read misses a just-moved book's store
      const st = await loadBookTranslation(bookPath);
      if (st) info.done = update ? st.updatedThrough ?? 0 : st.donePages.length;
      emitRuns();
      if (ctrl.signal.aborted) return;
      await startBookTranslation(doc, bookPath, {
        signal: ctrl.signal,
        update,
        pageLimit,
        onStall: (stalled) => {
          info.stalled = stalled;
          emitRuns();
        },
        onProgress: (p) => {
          info.done = p.donePages;
          info.total = p.total;
          info.etaMs = p.etaMs;
          emitRuns();
        },
      }).catch((e) => {
        if (!ctrl.signal.aborted) console.error("book translation failed", e);
      });
    } finally {
      doc.loadingTask.destroy().catch(() => {});
    }
  })().finally(() => {
    runs.delete(bookPath);
    emitRuns();
  });
  runs.set(bookPath, { ctrl, promise, info });
  emitRuns();
  return promise;
}

// Start the background translation run for a book (or join the active run).
export function startRun(bookPath: string): Promise<void> {
  return launchRun(bookPath, false);
}

// «Обновить перевод» — incremental re-translation after engine improvements:
// sweep EVERY stored page through the CURRENT clustering/classification code
// (furniture, refPages and figures are recomputed), carry translations over by
// paragraph-text match and send only new/changed paragraphs to the model —
// unchanged pages complete instantly, with zero requests. Runs through the
// same run manager as a normal translation: progress/pause (stopRun)/
// background semantics are identical, resume via store.updatedThrough.
// opts.pageLimit is the same dev/test hook startBookTranslation has.
export function updateBookTranslation(bookPath: string, opts: { pageLimit?: number } = {}): Promise<void> {
  return launchRun(bookPath, true, opts.pageLimit);
}
