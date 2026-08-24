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
  buildFrags,
  clusterParagraphsEx,
  detectCellGrid,
  detectFigures,
  detectFurniture,
  forgetFurnitureVotes,
  fragText,
  hash,
  hyphenKeepSet,
  hyphenKeeper,
  interArea,
  itemWords,
  learnHyphenLine,
  medianLineH,
  mul,
  newFurnitureMemory,
  newHyphenLexicon,
  rememberFurniture,
  rotatedItemShare,
  stitchModel,
  stitchPair,
} from "./paragraphs";
import type {
  FigureRegion,
  FurnitureMemory,
  HyphenDecider,
  LineBox,
  Paragraph,
  ParaKind,
  StitchModel,
} from "./paragraphs";
import { invoke } from "@tauri-apps/api/core";
import { CITE_MARK, loadGlossary } from "./glossarygen";
import {
  ModelUnavailableError,
  auxPoolSize,
  auxSlotSize,
  draftPoolSize,
  echoesPrev,
  hydrateGlossary,
  isAuxUp,
  isServerUp,
  looksRunaway,
  parseGlossary,
  styleComplete,
  translate,
} from "./translate";
import type { GlossaryEntry } from "./translate";
import { STYLE_TERM_CAP, acceptStyleEdit, applyYoPolicy, planStyleEdit } from "./styleguide";
import type { StyleLang, StyleTerm } from "./styleguide";
import { UND, detectBookLang } from "./booklang";
import { getLang } from "./i18n";
import { bookKey, contentKey, setBookKey } from "./bookid";
import { joinPath } from "./host";

// dev-console handle: __pdferDev spreads this module, so classification and
// figure detection can be inspected in the browser without UI plumbing
export { clusterParagraphs, detectFigures } from "./paragraphs";

const MODEL = "translategemma-12b-it-Q4_K_M";
// The style editor's weights, recorded beside the drafter's. `model` has named
// what produced a store's Russian since v1; after a second pass that question
// has two answers, and the store should be able to give both — a book edited by
// one build and re-opened by another must be able to say which editor wrote the
// prose the reader is looking at.
const STYLE_MODEL = "gemma-4-26B-A4B-it-qat-UD-Q4_K_XL";
// ---- how many paragraphs are on the wire at once ----------------------------
//
// Both worker counts are READ from translate.ts's request pools rather than
// written down again here — the bare `CONCURRENCY = 3` and `STYLE_CONCURRENCY =
// 2` that stood in these lines are gone. A worker pool LARGER than the request
// pool translates nothing faster (the extra workers queue inside acquire() while
// the progress bar implies more is happening) and one SMALLER leaves paid-for
// slots idle. The pools are in turn sized off each server's `--parallel`, and
// translate.ts's «request budgets» carries the measured batching table that
// earns those numbers — 1.86× at two concurrent sequences, 5.40× at eight, on
// this card. Both are read PER PAGE rather than captured in a constant, because
// the pools can still be raised after this module loads (llama_slots).
//
// The draft pass takes the whole draft pool. Nothing else runs on 11544 during a
// background sweep except the reader's own alt-click, and translate.ts already
// keeps one server slot free for exactly that.
//
// The style pass takes ONE LESS than the aux pool. translate.ts's auxPool is a
// single budget shared by the style pass, every glossary pass and graphgen's
// typing calls, because all three are the same 14.2 GB of weights on 11545. A
// style run saturating it holds it for HOURS, and the Terms tab would then queue
// behind a full set of in-flight edits of 15–30 s each. The style pass is
// background work and a reader waiting on the Terms tab is not, so one aux slot
// stays free by construction.
//
// CORRECTION. This comment used to argue the style side down on a second ground
// as well: that «the batching argument does not hold for a --cpu-moe model,
// because different sequences route to different experts, so at batch 3 the CPU
// may read up to 3× the expert weights per step». That premise went with the
// flag. `--cpu-moe` was never a hardware limit — it was the co-residency
// assumption written into the spawn, and the two passes cannot overlap in the
// first place, since the style edit consumes the draft's output. With the draft
// server handed the card back (src-tauri/src/lib.rs's swap_out), the 26B's
// experts fit in VRAM on this machine and a batch reads them the way any dense
// model's batch does. What survives is the interactive-surface argument above,
// and it stands on its own.
const STYLE_HEADROOM = 1;

/// The fewest paragraphs a draft slice may hold before the page stops splitting.
///
/// The contiguous-slice chain in the page loop below is what carries «the
/// previous target paragraph» into the next prompt, and a slice of ONE has no
/// chain at all: its single paragraph is a slice head, answered by the page seed
/// and nothing else. With the draft pool at 7 and a typical prose page holding
/// 4–8 paragraphs, sizing the slices off the pool alone would put very nearly
/// every paragraph in a slice of its own — which is the whole-book no-context
/// behaviour this design exists to remove, restored under a different name.
///
/// So the slice count is derived FROM the guaranteed slice length rather than
/// the other way round: a page never splits into more slices than it can chain.
/// Three is the smallest value at which a slice has an interior at all — a head,
/// a chained middle, a chained tail.
///
/// THE DERIVATION IS `floor`, AND IT USED TO BE `ceil`. The cap read
/// `workers = min(pool, ceil(n / MIN_CHAIN))` with `share = ceil(n / workers)`,
/// and that pair does not deliver what this constant promises. At n = 7 it gives
/// three workers of share 3 — slices [0,3) [3,6) [6,7) — so the last paragraph
/// of the page is a slice head with no target context, which is the exact case
/// the cap exists to remove, arrived at by the cap itself. The same tail appears
/// at n = 13 (four slices, last of one) and at n = 10 against a pool of 4. A
/// remainder of one is not rare on a book: it is one page in three.
///
/// `chainSlices` below inverts it. `workers = min(pool, floor(n / MIN_CHAIN))`,
/// then the remainder is SPREAD one paragraph at a time over the leading slices
/// instead of being left to pile up at the end. Since workers ≤ n/3, the base
/// share floor(n / workers) is ≥ 3 and every slice — the last one included — is
/// at least MIN_CHAIN long. n = 7 becomes two slices of 4 and 3; n = 13, four of
/// 4·3·3·3; n = 10 on a pool of 4, three of 4·3·3.
///
/// The cost of `floor` over `ceil`, stated because it is real: a page of 5
/// prose paragraphs now runs ONE slice where it used to run two (3 + 2). That is
/// the trade below taken one step further on exactly the pages where it is
/// cheapest — five paragraphs is the short page that was going to finish first
/// — and it buys the guarantee outright instead of approximately. Pages of 1 or
/// 2 paragraphs still run a single slice of their own length; there is no
/// arithmetic that gives a two-paragraph page an interior.
///
/// THIS DELIBERATELY TRADES SOME WITHIN-PAGE BATCHING FOR THE CONTEXT WINDOW,
/// and the trade is stated rather than hidden: a 6-paragraph page runs two
/// requests where the pool would have allowed six, and the page loop is strictly
/// sequential, so that really is two requests in flight for the length of that
/// page. What pays for it is that the batching is recovered ACROSS pages rather
/// than inside one — a page with 21 or more prose paragraphs still fills all
/// seven slices, dense pages are where most of a book's paragraphs and therefore
/// most of its wall clock live, and the short page that loses the parallelism is
/// also the page that was going to finish first. Context, by contrast, cannot be
/// recovered later at all: a paragraph translated without its predecessor is
/// wrong in the store until somebody re-translates it.
const MIN_CHAIN = 3;

/// Slice boundaries for `n` paragraphs over at most `pool` workers, as
/// `workers + 1` offsets: slice w spans [b[w], b[w+1]), and b[workers] === n.
///
/// One function for BOTH passes. The draft loop and the style loop had the same
/// two lines copied into each, which is how the tail defect above came to exist
/// in two places and would have been fixed in one. They ask the same question —
/// «how do I cut this page so every piece can chain» — and the answer must not
/// be able to differ between them.
///
/// `pool` is clamped up to 1 because the style side subtracts STYLE_HEADROOM
/// from a pool the server is free to report as 1.
function chainSlices(n: number, pool: number): number[] {
  const workers = Math.max(1, Math.min(Math.max(1, pool), Math.floor(n / MIN_CHAIN)));
  const base = Math.floor(n / workers);
  const rem = n % workers; // the first `rem` slices carry one paragraph more
  const b: number[] = [];
  for (let w = 0; w <= workers; w++) b.push(w * base + Math.min(w, rem));
  return b;
}

const ETA_WINDOW = 5; // moving average over the last N text pages

// v2: paragraphs carry fh (glyph height at scale 1) + kind; only kind:"prose"
// is ever translated — "other" (display math / tables), "caption" and
// "furniture" (running headers/footers) keep tr ""
// where a stitched continuation half lives / came from
export type ContRef = { page: number; idx: number };
export type TrParagraph = Paragraph & {
  tr: string;
  // v2 cross-page stitch (ADDITIVE — stores without these fields render exactly
  // as before). `contTo`: this paragraph's text absorbed the listed halves from
  // the following page(s) and was translated whole; `contOf`: this paragraph IS
  // such a half — it stays in the store so paragraph indices remain stable for
  // data-tridx and the figure-containment dedup, but it is never translated and
  // never rendered (buildTrPage / export.ts pageItems skip it). The reflow is a
  // re-typeset book, so the joined text renders on the page where it STARTED —
  // page-for-page parity with the original is explicitly not a goal.
  contTo?: ContRef[];
  contOf?: ContRef;
  // The DRAFT the translator produced, kept ONLY from the moment the style pass
  // rewrote `tr` over it (startStyleEdit). A paragraph the editor left alone, or
  // that never met an editor, carries no trRaw at all — so its presence is also
  // the honest answer to «is there anything to undo here».
  //
  // Three readers depend on it, and each would be wrong without it:
  //  - restoreDrafts, which is an exact undo rather than a re-translation;
  //  - the style pass itself, which reads (trRaw ?? tr) so a second run edits the
  //    DRAFT again rather than its own edit — that is what makes the pass
  //    idempotent instead of drifting one step further every time;
  //  - carryOver, so «Обновить перевод» seeds the next draft with Russian a
  //    TRANSLATOR wrote, not with prose the editor has already reflowed.
  // ADDITIVE and optional: a store without it is exactly the store the previous
  // build wrote, and `version` stays 2 (see BookTranslation.version below).
  //
  // The cost, stated rather than hidden: on a fully edited book this roughly
  // doubles the Russian on disk — an 838-page store already runs to several
  // megabytes, which is why headerBookPath at :376 exists at all — and writeStore
  // rewrites the whole file after every page, in both passes. Undo is worth that;
  // nothing else here would be, which is why the style pass sets trRaw only when
  // it actually changed the text.
  trRaw?: string;
};
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
  // Book-wide compound lexicon for the line-break hyphen rule (paragraphs.ts):
  // the set of hyphenated compounds this book attests INSIDE a line, so a break
  // at their own hyphen keeps it («graph-based», not «graphbased»). Built once
  // per book by a text-only prescan (~6.5 s over 838 pages, measured) and then
  // reused by every resume and every «Обновить перевод». Additive: a store
  // without it simply re-scans on the next run.
  hyphens?: string[];
  // «Обновить перевод» watermark, present only mid-update: pages 1..updatedThrough
  // are already re-clustered with the CURRENT engine code (an interrupted update
  // resumes above it); removed when the sweep reaches the last page. Additive —
  // old builds ignore it, version stays 2.
  updatedThrough?: number;
  // «Выправить стиль» watermark: every done page up to and including it has been
  // through startStyleEdit. A THIRD, independent number rather than a flag on
  // either of the two above — donePages is the draft resume set and the source of
  // App's trInfo, trPct and every export gate, updatedThrough is the update
  // watermark read at :1166 and dropped at :1620 — because folding two of the
  // three sweeps together corrupts both features at once. Three sweeps, three
  // orthogonal numbers. Additive, version stays 2.
  //
  // Dropped on completion the way updatedThrough is, but NOT on the same
  // condition — see the drop site in startStyleEdit for why donePages GROWING
  // makes «the sweep reached the end» a different question here.
  styledThrough?: number;
  // Which weights did the editing, beside `model`'s record of which did the
  // drafting. Absent until a style pass has written a page.
  styleModel?: string;
  // The book's own language (a BookLang tag, or UND), decided ONCE at the first
  // run's start and reused by every resume and every update. The draft prompt
  // names BOTH ends of the pair (translate.ts:397) and a detector that answered
  // differently over page 300's spread than over page 1's would change the prompt
  // mid-book — a source of drift, in a change whose entire purpose is to remove
  // one. UND is a real answer and is stored as one: translate.ts:445 maps it to
  // «say nothing about the source», which is strictly better than telling a
  // translator its input is «undetermined».
  srcLang?: string;
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
// `kept` is the style pass's only extra number and it is optional for everyone
// else: paragraphs whose draft survived a refused reply or a failed request, so
// the panel can say «12 абзацев оставлены как были» instead of implying that
// every paragraph on screen was edited.
export type BookProgress = { page: number; total: number; donePages: number; etaMs?: number; kept?: number };

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
const storeDir = () => (dirP ??= appDataDir().then((d) => joinPath(d, "translations")));
const storeFile = async (bookPath: string) => joinPath(await storeDir(), `${storeKey(bookPath)}.json`);
const legacyStoreFile = async (bookPath: string) => joinPath(await storeDir(), `${hash(bookPath)}.json`);

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
    const ckFile = joinPath(dir, `${ck}.json`);
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

// ---- book-wide hyphen lexicon prescan ---------------------------------------
// The line-break hyphen rule needs the WHOLE book's vocabulary before the first
// paragraph goes on the wire (see paragraphs.ts), so the run opens with a
// text-only sweep: getTextContent → frags → line texts → token counters. No
// clustering, no operator lists, no rendering — measured at 6.5 s for the real
// 838-page book, against hours of translation, and the result is persisted so
// resumes and «Обновить перевод» never pay it twice.
//
// HONEST DEGRADATION: only the engine has this book-wide view. App.tsx's
// Alt+click popover clusters ONE paragraph from the DOM text layer with no
// document context, so it keeps the old unconditional dehyphenation — the same
// asymmetry detectFurniture already documents for its cross-page memory. A
// popover translation may therefore still show «graphbased» where the reflow
// shows «graph-based»; nothing is persisted from that path, so the store stays
// consistent.
async function scanHyphenLexicon(doc: PDFDocumentProxy, signal?: AbortSignal): Promise<string[] | null> {
  const lex = newHyphenLexicon();
  for (let n = 1; n <= doc.numPages; n++) {
    if (signal?.aborted) return null;
    const page = await doc.getPage(n);
    try {
      const content = await page.getTextContent();
      const frags = buildFrags(itemWords(content.items, page.getViewport({ scale: 1 })));
      if (!frags.length) continue;
      const lineH = medianLineH(frags);
      for (const f of frags) learnHyphenLine(lex, fragText(f, lineH));
    } catch {
      // one unreadable page only costs its own vocabulary
    } finally {
      page.cleanup();
    }
  }
  return hyphenKeepSet(lex);
}

// ---- cross-page stitching (engine side) -------------------------------------
// The predicate lives in paragraphs.ts; the engine owns page order. Page N's
// decision needs page N+1's paragraphs, so classification runs ONE PAGE AHEAD
// of translation and is cached — the same total work, done a page early, with
// detectFurniture still called exactly once per page in ascending order.
const STITCH_MAX_HOPS = 4; // a logical paragraph may span this many pages
const STITCH_BLANK_SKIP = 2; // consecutive text-less pages walked over
const FURN_WARMUP = 32; // fresh-run furniture vote warm-up, pages

type PageModel = {
  n: number;
  paras: Paragraph[];
  lines: LineBox[][];
  figures: FigureRegion[];
  refPage: boolean;
  model: StitchModel | null;
};

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

// ---- back-of-book index (also a refPage) ------------------------------------
// The index is the bibliography's twin and used to have no gate at all:
// isRefPage keys on citation markers, and an index line ("Term, 45  Other
// term, 88–90") carries no year, DOI or "A. Surname", so every line went to
// the model as if it were a sentence. Worse, growParagraph welds
// alphabetically adjacent entries into one block first, so the model reflows
// the whole block into prose and the page numbers migrate onto the wrong
// terms: on the test book 33 pages / 293 paragraphs / 80KB of Russian, with
// 256 of 1767 "term → page" bindings destroyed and dataset names literally
// translated. There is no per-paragraph repair for this — the damage happens
// before classification sees it — so the page is flagged whole and rendered as
// the original, exactly like a bibliography page.
// Signal: the "headword, page" BINDING — a word ending, a comma, a bare page
// number — measured per 1000 characters of the page. Density, not a count of
// entry-shaped paragraphs: the same welding that ruins the translation collapses
// a whole index page into two or three giant paragraphs, so anything counted
// per paragraph reads three entries where there are sixty. The word-ending
// requirement is what keeps a chart's numeric labels ("0.75, 1") out.
// Measured over the whole test book: index pages run 15.9–41.6 bindings per
// 1000 chars, every other page in the book is at or under 1.7 — a 9× gap, so
// the floor sits comfortably between them. The absolute floor only guards
// against a near-empty page scoring high on a handful of matches.
const IDX_BIND_MIN = 3; // bindings on the page
const IDX_BIND_DENSITY = 8; // …and per 1000 characters
const IDX_BIND_RE = /[\p{L}][\p{L}\p{N})\]'’.-]{0,2},\s*\d{1,3}(?:\s*[–—-]\s*\d{1,3})?(?=[\s,]|$)/gu;

export function isIndexPage(paras: readonly Paragraph[]): boolean {
  let binds = 0;
  let chars = 0;
  for (const p of paras) {
    if (p.kind === "furniture") continue;
    const t = p.text.trim();
    chars += t.length + 1;
    binds += t.match(IDX_BIND_RE)?.length ?? 0;
  }
  return chars >= 50 && binds >= IDX_BIND_MIN && (1000 * binds) / chars >= IDX_BIND_DENSITY;
}

// ---- table of contents (also a refPage) -------------------------------------
// Same failure as the index, same shape of evidence: growParagraph welds a
// dozen contents lines into one paragraph, the model reflows them into prose,
// and the page numbers end up against the wrong headings. The signal is the
// contents BINDING — a word, whitespace, a bare page number — per 1000
// characters. Measured over the test book: contents pages run 23.7–34.0, the
// densest page anywhere else in the book is 13.7 (a numeric table), and
// ordinary body pages sit at 0. The book's real navigation is translated
// separately from the PDF outline, so nothing is lost by showing these pages
// as the original.
const TOC_BIND_MIN = 8;
const TOC_BIND_DENSITY = 18; // per 1000 characters
const TOC_BIND_RE = /[\p{L})\]] +\d{1,3}(?= |$)/gu;

export function isTocPage(paras: readonly Paragraph[]): boolean {
  let binds = 0;
  let chars = 0;
  for (const p of paras) {
    if (p.kind === "furniture") continue;
    const t = p.text.trim();
    chars += t.length + 1;
    binds += t.match(TOC_BIND_RE)?.length ?? 0;
  }
  return chars >= 50 && binds >= TOC_BIND_MIN && (1000 * binds) / chars >= TOC_BIND_DENSITY;
}

// ---- landscape / rotated pages (also a refPage) -----------------------------
// A page whose text is mostly set at 90° is a landscape table. It has no
// reflowable measure: the reading direction runs across the page, so clustering
// yields cell shards, and the model expands each two-word shard into a
// confident invented sentence («shown. is» → «Показано следующее.»). The test
// book's five-page Table 8.1 produced 135 such paragraphs, all translated, with
// no crop of the original anywhere. Rendering the original page is the only
// honest option, so the page joins refPages. The threshold is a clear majority:
// a chart carrying one rotated y-axis label stays a normal page.
const ROT_PAGE_SHARE = 0.5;
export const isRotatedPage = (share: number): boolean => share >= ROT_PAGE_SHARE;

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
// moves existing translations onto the freshly-clustered paragraphs.
//
// The match is EXACT (whitespace-normalized, case-folded) and nothing else.
// An earlier build also accepted a ≥90% common prefix, meaning to absorb a
// dropped superscript or a re-joined hyphenation. That fuzziness is what made
// the running-header bug outlive its own fix: the clusterer used to weld the
// running header into the heading below it, so page 34 stored
// «2.2 Text Representations for Ranking 13» translated as «2.2 Текстовые
// представления для ранжирования 13». After the weld fix the paragraph's text
// is the bare heading — a 90% prefix of the welded string — so the update
// carried the page number straight back onto the repaired paragraph and the
// user kept seeing «… для ранжирования 13». A translation whose source text no
// longer matches is not a translation of this paragraph; it goes back on the
// wire. Old paragraphs are consumed at most once; old tr:"" entries carry
// nothing, so soft-failed paragraphs are re-requested for free.

const normText = (s: string): string => s.replace(/\s+/g, " ").trim();
// carry key: whitespace + case folded. Text comes from the same extractor on
// both sides, so folding never merges genuinely different paragraphs — it only
// absorbs glyph-mapping noise (small caps, ligature fallbacks).
const carryKey = (s: string): string => normText(s).toLowerCase();

// ---- one-shot repair of already-poisoned stores ------------------------------
// Exact matching alone cannot heal a store the old fuzzy matcher already
// poisoned: the repaired paragraph text is stable from now on, so its bad tr
// would match itself exactly and be carried forever. So every stored pair
// (text, tr) is audited before it may enter the carry pool — a pair that fails
// is dropped and the paragraph re-translates on the next «Обновить перевод».
//
// Three signals were measured against the real 838-page store (4514 translated
// paragraphs); each hit was read by hand:
//   - length / word-count ratio: REJECTED. Russian legitimately runs 2–3x the
//     word count of a terse English heading («2.7 Retrieval-augmented
//     Generation» → 7 words). A 0.8–1.6 char-length band flags 451 of the 4514
//     on short blocks alone; even a strict "≥2.2x AND ≥4 extra words" word cut
//     still flags 61, nearly all of them good translations.
//   - ANY digit run in tr absent from text: REJECTED. 65 hits, ~40% wrong —
//     «COVID» → «COVID-19», «(1k works) + 2k songs» → «1000 … 2000 … 3000»,
//     list items the model renumbers, year ranges it completes from a garbled
//     table column («2013–15» → «2013–2015»), and — before the digit-group
//     flattening below — «3, 423 pairs» → «3 423 пары».
//   - DANGLING EDGE NUMBER: PICKED. tr begins or ends with a bare number that
//     occurs nowhere in the source text. That is precisely the residue a welded
//     running head leaves, and translation does not invent a naked number at a
//     string edge. Two guards keep it conservative: the number must be
//     plausibly a printed page number (1..pageCount), and only heading-sized
//     blocks are audited — a long paragraph opening with «1)» is a list the
//     model renumbered, not a weld.
// On the real store the picked rule flags 22 of 4514 paragraphs (0.49%), and
// for all 22 the dangling number is verbatim the page's own running-head page
// number (page 34's heading among them). No false positive, and no weld
// residue found by a furniture cross-check that the rule misses.
const STALE_MAX_LEN = 200; // heading-sized blocks only, chars
// digit-group separators differ between the languages («3,423» / «3 423»)
function flatNum(s: string): string {
  let t = s.replace(/[\u00A0\u202F\u2009]/g, " "); // nbsp / narrow nbsp / thin space
  for (let i = 0; i < 4; i++) t = t.replace(/(\d)[ ,]+(\d{3})(?!\d)/g, "$1$2");
  return t;
}

export function looksStaleTr(text: string, tr: string, pageCount: number): boolean {
  const t = normText(text);
  const r = flatNum(normText(tr));
  if (!r || t.length > STALE_MAX_LEN) return false;
  const src = new Set(flatNum(t).match(/\d+/g) ?? []);
  // a bare number the source never mentions, small enough to be a page number
  const dangling = (d: string) => !src.has(d) && Number(d) >= 1 && Number(d) <= Math.max(pageCount, 1);
  // tail: «… для ранжирования 13» — the separator class deliberately excludes
  // "." so a trailing formula tag «(2.1)» or a glued footnote marker «…текста.15»
  // is left alone
  const tail = r.match(/(?:^|[\s(\[«"])(\d{1,4})\s*[.)\]»"]?$/);
  if (tail && dangling(tail[1])) return true;
  // head: «13 2.2 Текстовые …» — the verso running head («14 Chapter 2 …»)
  const head = r.match(/^[(\[«"]?(\d{1,4})[\s.)\]]/);
  return !!head && dangling(head[1]);
}

type CarryEntry = { tr: string; k: string; used: boolean };

// Mutates matched paragraphs' tr in place; returns those still needing the
// wire. Exported for the same reason pageImageBoxes is: __pdferDev spreads this
// module, so the matcher can be exercised on a seeded store from the console.
//
// WHAT IS CARRIED IS THE DRAFT, NOT WHAT IS ON SCREEN. After a style pass `tr`
// holds the editor's Russian and trRaw the translator's, so the pool is built
// from (o.text, o.trRaw ?? o.tr) and what lands on the new paragraph is that
// draft, with trRaw left UNSET. Carrying the EDIT forward instead would compound
// two ways: the next style run would read an already-edited string as its input,
// so every update would move the prose one more step away from the translation
// (and its guardrails would be measuring drift against the wrong baseline), and
// the dangling-page-number audit below would be run against prose the editor may
// have reflowed — an audit whose whole calibration is «22 of 4514, no false
// positives» on TRANSLATOR output. An updated page is a fresh draft again, and a
// later style run edits it from the start.
export function carryOver(todo: TrParagraph[], old: readonly TrParagraph[], pageCount: number): TrParagraph[] {
  const byText = new Map<string, CarryEntry[]>();
  for (const o of old) {
    const draft = o.trRaw ?? o.tr;
    if (draft === "" || looksStaleTr(o.text, draft, pageCount)) continue;
    const e: CarryEntry = { tr: draft, k: carryKey(o.text), used: false };
    const l = byText.get(e.k);
    if (l) l.push(e);
    else byText.set(e.k, [e]);
  }
  const wire: TrParagraph[] = [];
  for (const p of todo) {
    const e = byText.get(carryKey(p.text))?.find((c) => !c.used);
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

/// Why a run is stalled, when the frontend can say something better than «the
/// model is unavailable».
///
/// "swapping" is the one case that is not a fault at all: another local pass
/// asked for the card, the draft server's child was stopped to make room, and it
/// will be started again by itself when that lease drops (src-tauri/src/lib.rs,
/// restore_after_handover). `undefined` keeps the generic wording — a crashed
/// server, a killed process, an external server the reader stopped by hand.
export type StallReason = "swapping";

// Shared per-run outage gate. On a network-level failure every worker funnels
// through here: a single health probe decides "transient blip" (return at
// once, redo the request) vs "server down" (report the stall once, poll
// /health every 3s until it answers, report recovery). Concurrent callers
// join the same in-flight wait, so one outage produces one stall
// notification and one polling loop, not one per worker.
//
// THE LOOP ASKS WHY, NOT ONLY WHETHER. A draft or update run on book A now has
// an ordinary way to lose its server that has nothing to do with an outage: a
// style pass on book B, the Terms tab, or graphrun's background queue takes the
// aux lease, and the native side stops this server to free the 16 GB card
// (swap_out). The run then arrives here and waits — correctly, because the
// server is coming back — but every surface it feeds said only «модель
// недоступна», which reads as a fault the reader is supposed to do something
// about, on a machine where nothing is wrong.
//
// So each failed probe also asks translation_status for the reason and hands it
// out beside the flag. It costs one extra IPC round trip per 3 s of an outage
// that is already measured in seconds, and only while stalled — and the
// notification is repeated ONLY when the answer changed, because every call runs
// emitRuns and a fresh notification every three seconds for an unchanged fact
// would redraw the panel, the toolbar band and the library chip for nothing, for
// hours. The stall notification stays what it always was: one per change.
//
// THE WAIT STAYS DEADLINE-FREE, and that is the same decision as before rather
// than an oversight carried forward. A draft run may wait out an outage for ever
// because a missing translation is nothing lost (the failure policy above
// startStyleEdit sets this out and contrasts it with the style pass, which does
// have a deadline because its input is already good Russian). Under a handover
// the forever-wait is not merely tolerable, it is the correct answer: the other
// pass runs for as long as it runs, and a deadline here would end a book
// translation because a graph scan the reader never asked for was still going.
// What was actually missing was the WORD on screen, and that is what this adds.
function makeHealthGate(
  onStall?: (stalled: boolean, reason?: StallReason) => void,
): (signal?: AbortSignal) => Promise<void> {
  let waiting: Promise<void> | null = null;
  return (signal?: AbortSignal) => {
    waiting ??= (async () => {
      if (await isServerUp()) return; // single-request blip — server is fine
      let why = await stallReason();
      onStall?.(true, why);
      try {
        for (;;) {
          await sleep(3000, signal); // abort rejects here → run unwinds
          if (await isServerUp()) break;
          // A handover can begin AFTER the stall started (the outage was a real
          // one and a pass took the card while we waited), and it can end while
          // the server is still booting back up — so the reason is re-read every
          // turn rather than latched at the first probe, and re-announced only
          // when it actually moved.
          const now = await stallReason();
          if (now !== why) {
            why = now;
            onStall?.(true, why);
          }
        }
      } finally {
        onStall?.(false); // recovered (or aborted — the run's teardown resets state anyway)
      }
    })().finally(() => {
      waiting = null;
    });
    return waiting;
  };
}

/// Ask the native side why the draft server is not answering. Never throws and
/// never blocks the gate: outside Tauri (the plain-browser vite path) there is
/// no such command, and an external server nobody spawned has no handover to
/// report either — both answer `undefined`, which is the generic wording.
async function stallReason(): Promise<StallReason | undefined> {
  if (!IS_TAURI) return undefined;
  try {
    return (await invoke<string>("translation_status")) === "swapping" ? "swapping" : undefined;
  } catch {
    return undefined;
  }
}

/// What the draft prompt is told besides the paragraph itself: the previous
/// SOURCE paragraph, target text already produced for this book, and the book's
/// own language. Assembled per paragraph by ctxOf in the page loop below and
/// handed straight to translate.ts, which owns every clip and every block header.
type DraftCtx = { srcPrev?: string; trPrev?: string; srcLang?: string };

// One paragraph. Failure handling is asymmetric on purpose:
//  - network failure (ModelUnavailableError): NEVER resolves to "" — the
//    paragraph waits out the outage via the shared gate and is re-requested,
//    so an unreachable server can no longer mint fake "translated" pages;
//  - bad output (HTTP 4xx/500, parse-level errors): one retry, then give up
//    with "" — the page still completes and the typesetter shows the original
//    as an image crop;
//  - aborts always propagate so the page is NOT marked done.
//
// TWO OUTPUT GATES, and both of them are new with the context window. A prompt
// that carries reference blocks can fail in ways a bare one could not:
//  - looksRunaway: the degenerate loop this codebase has already watched happen —
//    a paragraph that dissolved into one repeated term after the glossary block
//    told the model to keep it (translate.ts:1149 tells that story in full);
//  - echoesPrev: the model translating or copying the «Reference material» block
//    instead of skipping it, which looksRunaway structurally cannot see (a 400-
//    character source with a 700-character trPrev lands under its ceiling).
//
// The retry for both DROPS THE CONTEXT rather than repeating the request. Draft
// sampling is greedy (translate.ts:840), so an identical prompt is very nearly
// an identical answer and a plain retry would be a wasted 30 seconds; a bare
// prompt is the pre-context behaviour, cannot echo a block it was never given,
// and is the honest fallback for a paragraph the blocks are hurting. srcLang
// stays — it is not a continuity block, it is what language the input is in.
async function translateRetry(
  text: string,
  glossary: GlossaryEntry[],
  waitHealthy: (signal?: AbortSignal) => Promise<void>,
  ctx: DraftCtx,
  signal?: AbortSignal,
): Promise<string> {
  let soft = 0;
  let bare = false; // the context blocks have already been blamed once
  for (let net = 0; ; ) {
    try {
      const use: DraftCtx = bare ? { srcLang: ctx.srcLang } : ctx;
      const out = await translate(text, glossary, { ...use, signal });
      if (out && (looksRunaway(text, out) || echoesPrev(out, use.trPrev))) {
        if (bare) return ""; // a bare prompt still ran away — this one is beyond us
        bare = true;
        continue;
      }
      return out;
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

// ---- the previous paragraph, out of the store --------------------------------
//
// Both passes need «what came before this page» and the store is the only place
// that has it: the page loop is strictly sequential and writeStore lands before
// page n+1 begins, so the previous page's translations ARE on disk (and, for the
// run that wrote them, in this same in-memory copy).
//
// It returns the DRAFT (trRaw ?? tr), not what is on screen, for the same reason
// carryOver does: the draft chain must read the same whether or not an editor has
// been over the book. Nothing else is filtered, because nothing else needs to be —
// furniture, captions, display maths, reference pages and figure-contained labels
// all carry tr "" by construction, so «has a translation» already means «is prose
// the reader reads».
//
// A continuation half is followed to the paragraph that ABSORBED it (contOf.of,
// set at the stitch site below): the text physically above this page's first line
// is that paragraph's tail, and its translation is where the Russian for it lives.
//
// The one weak spot is the same one the page loop guards against for its own
// page: stored order is y-band then x, so on a two-column PREVIOUS page «the last
// prose paragraph» is the bottom-most, right-most one. That is usually also the
// last one read, which is why this is used unconditionally where the page loop
// refuses to trust adjacency — the seed is one paragraph at a page boundary,
// not every paragraph of every page.
type PrevPara = { text: string; tr: string };
const SEED_BACK_PAGES = 3; // …far enough to step over a full-page figure or a blank

function seedBack(store: BookTranslation, page: number, before = Number.MAX_SAFE_INTEGER): PrevPara | null {
  let from = before;
  for (let n = page, back = 0; n >= 1 && back < SEED_BACK_PAGES; n--, back++) {
    const paras = store.pages[n];
    if (paras?.length) {
      for (let i = Math.min(from, paras.length) - 1; i >= 0; i--) {
        const p = paras[i];
        if (p.kind !== "prose") continue;
        if (p.contOf) {
          const own = store.pages[p.contOf.page]?.[p.contOf.idx];
          const tr = own ? own.trRaw ?? own.tr : "";
          if (own && tr) return { text: own.text, tr };
          continue;
        }
        const tr = p.trRaw ?? p.tr;
        if (tr) return { text: p.text, tr };
      }
    }
    from = Number.MAX_SAFE_INTEGER; // only the first page examined has a starting index
  }
  return null;
}

// ---- the book's own language -------------------------------------------------
//
// Decided once per store and kept there (BookTranslation.srcLang). The glossary
// sidecar is asked first because a book whose terms have been mined already has a
// vote taken over pages this run has not read yet, and because agreeing with it
// costs one file read instead of sixteen page extractions.
//
// The sampler is a TWIN of glossarygen.ts:849's spreadPages and the extraction is
// the same one scanHyphenLexicon does above — text only, no clustering, no
// operator lists. It is not shared with either: glossarygen's is private to a
// module this one must not start depending on for a five-line helper, and the
// extraction here is two calls. If the spread rule changes, change both.
const LANG_PAGES = 16;

function spreadPages(total: number, want: number): number[] {
  if (total <= want) return Array.from({ length: total }, (_, i) => i + 1);
  const out: number[] = [];
  for (let i = 0; i < want; i++) out.push(1 + Math.round((i * (total - 1)) / (want - 1)));
  return [...new Set(out)];
}

async function detectSrcLang(doc: PDFDocumentProxy, signal?: AbortSignal): Promise<string> {
  const samples: string[] = [];
  for (const n of spreadPages(doc.numPages, LANG_PAGES)) {
    if (signal?.aborted) break;
    const page = await doc.getPage(n);
    try {
      const content = await page.getTextContent();
      const frags = buildFrags(itemWords(content.items, page.getViewport({ scale: 1 })));
      if (!frags.length) continue;
      const lineH = medianLineH(frags);
      const text = frags.map((f) => fragText(f, lineH)).join(" ");
      if (text.trim()) samples.push(text);
    } catch {
      // one unreadable page only costs its own vote — detectBookLang pools
    } finally {
      page.cleanup();
    }
  }
  // UND is a real answer, not a failure: booklang refuses to guess on a book of
  // formulas or a broken text layer, and translate.ts turns that into a prompt
  // that names only the target end of the pair.
  return detectBookLang(samples).lang;
}

// Translate the whole book page by page, one contiguous slice per worker, each
// prompted WITH ITS CONTEXT: the preceding source paragraph and target text
// already produced for this book (see «the draft's context window» inside the
// page loop for how both are derived, and why they come off `out` rather than off
// the wire list). This is the draft half of the two-pass design — startStyleEdit
// below is the other, and neither touches the other's watermark.
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
    /// `reason` is optional and only the draft gate ever supplies one — see
    /// StallReason. A caller that ignores the second argument keeps the exact
    /// behaviour it had.
    onStall?: (stalled: boolean, reason?: StallReason) => void;
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
  // what each page contributed to the pool before it is swept, so the sweep can
  // retract exactly its own votes (stored classification, or the warm-up below)
  const seeded = new Map<number, Paragraph[]>();
  for (const [k, paras] of Object.entries(store.pages)) {
    const f = paras.filter((p) => p.kind === "furniture");
    if (!f.length) continue;
    const cT = Math.min(...paras.map((p) => p.y));
    const cB = Math.max(...paras.map((p) => p.y + p.h));
    for (const p of f) rememberFurniture(furn, Number(k), p, p.y - cT <= cB - (p.y + p.h) ? "t" : "b");
    seeded.set(Number(k), f);
  }
  // never mint pages against a dead server: one probe up front — an outage
  // stalls the run right here, before even a text-less page can complete and
  // write the first store byte (auto-resumes when /health answers)
  await waitHealthy(signal);
  // …and the source language is settled inside that same guard region, before a
  // single page can be minted: the prompt names both ends of the pair, and a run
  // that started against a dead server would otherwise have written pages under
  // a language decided by a detector nobody was waiting on.
  //
  // Sidecar first (the terminologist has usually seen a spread of the whole book
  // by the time anyone translates it), detector second, and the answer — UND
  // included — is stored so every resume and every update prompts identically.
  if (store.srcLang === undefined) {
    const known = await loadGlossary(bookPath)
      .then((g) => g.meta.lang)
      .catch(() => UND);
    store.srcLang = known && known !== UND ? known : await detectSrcLang(doc, signal);
  }
  // An update REPLACES the input every style edit was made from: §5's carryOver
  // re-seeds tr with the draft and leaves trRaw unset, so a page the update
  // touches is un-edited again. Leaving styledThrough at, say, 200 would then
  // make the next style run skip exactly the 200 pages that most need it, with
  // nothing on screen saying so. Cleared at update START rather than per page
  // because the sweep is ascending and the watermark is a prefix: a partial
  // update whose first page is 1 invalidates every number above it anyway.
  //
  // THE SAME PROLOGUE CLEARING styleModel WAS A DEFECT UNTIL App.tsx:171 STOPPED
  // READING IT AS AN INDEX. `trRaw` is stripped only from the pages the sweep
  // actually reaches, so between this line and the last page there were stores
  // holding drafts to restore while the field that announced them was already
  // gone — and an interrupted update left that state on disk. The fix chosen was
  // in the reader, not here: hasStyleDrafts now answers from the paragraphs, and
  // this field went back to being what its declaration (:283) always called it,
  // a record of WHICH WEIGHTS did the editing, not an index of where. Nothing
  // else in the app reads it, so clearing it beside styledThrough is safe again
  // and stays where it is — the two describe the same invalidated edit and
  // separating them would be one more thing to keep in step.
  //
  // The alternative — moving this delete to the end of a completed sweep — was
  // not taken. It repairs the invariant in one direction and breaks it in the
  // other: the completion block at :1619 only fires for a whole-book update
  // (`last === total`), so a page-limited one would leave the field set for ever
  // over a book with no edit left in it. A summary three independent sweeps can
  // invalidate cannot be made exactly right; the paragraphs always are.
  if (update) {
    delete store.styledThrough;
    delete store.styleModel;
  }
  const done = new Set(store.donePages);
  const glossary = parseGlossary(store.glossaryText);
  const durations: number[] = [];
  const last = Math.min(total, Math.max(1, pageLimit ?? total));

  // book-wide compound lexicon: reuse the stored one, otherwise prescan once
  let keepHyphen: HyphenDecider | undefined;
  if (!store.hyphens) {
    const keep = await scanHyphenLexicon(doc, signal);
    if (keep) store.hyphens = keep; // persisted with this run's first page
  }
  if (store.hyphens) keepHyphen = hyphenKeeper(store.hyphens);

  // Fresh-run warm-up for the furniture vote pool. detectFurniture's repetition
  // rule and its learned printed-page offset both need a quorum, and a
  // resumed/updated run starts with one seeded from the WHOLE store — so the
  // same book translated from scratch used to keep four running headers as body
  // text (pages 9, 10, 23, 24 of the test book) that an update correctly
  // dropped. Same book, two outputs, the from-scratch one strictly worse. A
  // bounded prescan closes it where it actually bites — the front of the book,
  // before any header text has been seen twice; later chapter starts confirm
  // through the page number instead. Votes are recorded in `seeded` and
  // retracted page by page at the sweep site, exactly like stored ones, so
  // nothing is counted twice.
  if (!seeded.size) {
    for (let n = 1; n <= Math.min(last, FURN_WARMUP); n++) {
      if (signal?.aborted) break;
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        const { paras } = clusterParagraphsEx(content.items, page.getViewport({ scale: 1 }), { keepHyphen });
        detectFurniture(paras, n, furn);
        const f = paras.filter((p) => p.kind === "furniture");
        if (f.length) seeded.set(n, f);
      } catch {
        // one unreadable page only costs its own warm-up votes
      } finally {
        page.cleanup();
      }
    }
  }

  // ---- classification with a one-page lookahead (see PageModel above) -------
  const models = new Map<number, PageModel>();
  const willSweep = (n: number) => n >= 1 && n <= last && (!done.has(n) || (update && n > updatedFrom));
  const classifyPage = async (n: number): Promise<PageModel | null> => {
    const hit = models.get(n);
    if (hit) return hit;
    if (n < 1 || n > total) return null;
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const vp1 = page.getViewport({ scale: 1 });
    const { paras, lines, lineH } = clusterParagraphsEx(content.items, vp1, { keepHyphen });
    // running headers/footers → kind:"furniture", BEFORE figure detection
    // (the caption pass only reclassifies prose — a marked header can no
    // longer be claimed) and BEFORE the refPage gate (reference pages carry
    // headers too and must keep feeding the cross-page memory).
    // A stored classification of this page seeded the memory at run start (its
    // votes fed the quorum for the pages before it) and is about to be
    // replaced — withdraw those votes so detectFurniture's re-vote of the live
    // candidates doesn't double-count them.
    for (const p of seeded.get(n) ?? []) forgetFurnitureVotes(furn, n, p);
    seeded.delete(n);
    detectFurniture(paras, n, furn);
    // "show the original page wholesale" pages: completes untranslated below
    // (todo stays empty) and skips the figure pass — stored regions would never
    // render. Three kinds qualify, for the same reason: their content is not
    // reflowable prose and translating it does pure harm — bibliography
    // (citations), back-of-book index (term→page bindings the model reshuffles),
    // and landscape/rotated pages (no reading measure at all).
    const refPage =
      isRefPage(paras) || isIndexPage(paras) || isTocPage(paras) || isRotatedPage(rotatedItemShare(content.items, vp1));
    // candidate figure regions; reclassifies adjacent "Figure N:" prose
    // paragraphs to kind:"caption" (mutates paras) and merges their bboxes
    const figures = refPage ? [] : detectFigures(paras, vp1.width, vp1.height, await pageImageBoxes(page));
    // grids without a caption to hang a region on (SPARQL result tables,
    // piecewise braces, appendix formula tables): their cells become
    // kind:"other" and render as a crop instead of being translated one by one.
    // AFTER detectFigures on purpose — cells already inside a claimed region
    // need no reclassification, and a caption's bounds are computed against the
    // page's prose, which this pass would otherwise thin out.
    if (!refPage) detectCellGrid(paras, lineH);
    const m: PageModel = { n, paras, lines, figures, refPage, model: stitchModel(paras, lines, lineH, figures) };
    models.set(n, m);
    return m;
  };
  // next page carrying text — blank / figure-only pages are walked over (18 in
  // the real book); never past `last`, since a head this run will not sweep
  // must not be absorbed
  const nextTextPage = async (from: number): Promise<PageModel | null> => {
    for (let m = from + 1, blank = 0; m <= last && blank <= STITCH_BLANK_SKIP; m++) {
      const pm = await classifyPage(m);
      if (!pm) return null;
      // "carries text" must mean BODY text. A full-page figure or table is full
      // of kind:"prose" paragraphs — its labels and cells — so testing the kind
      // alone made every such page count as a text page, the blank-skip never
      // ran, and the paragraph running across it stayed torn (the model then
      // rewrote the orphaned half into a whole sentence the book never states).
      // The FIG_CONTAIN test is the same one the translation todo list uses.
      if (
        pm.paras.some((p) => p.kind === "prose" && !pm.figures.some((r) => interArea(p, r) >= FIG_CONTAIN * p.w * p.h))
      )
        return pm;
      blank++;
    }
    return null;
  };
  type StitchHead = { page: number; idx: number; text: string };
  // Does this page's last body paragraph run over onto the next page(s)?
  const stitchFrom = async (cur: PageModel): Promise<{ tail: number; heads: StitchHead[] }> => {
    const heads: StitchHead[] = [];
    let tail = -1;
    if (!cur.model?.body.length || cur.refPage) return { tail, heads };
    for (let hop = 0, src = cur; hop < STITCH_MAX_HOPS; hop++) {
      const nxt = await nextTextPage(src.n);
      // the head's page must still be swept by this run, or its stored half
      // would keep rendering beside the joined text
      if (!nxt || !willSweep(nxt.n)) break;
      const j = stitchPair(src, nxt);
      if (!j) break;
      if (hop === 0) tail = j.tail;
      heads.push({ page: nxt.n, idx: j.head, text: nxt.paras[j.head].text });
      // chain only while the head IS the next page's own tail (a page holding a
      // single body paragraph) — otherwise the run ends there
      if (nxt.model?.body.length !== 1) break;
      src = nxt;
    }
    return { tail, heads };
  };
  // heads claimed by an earlier page, consumed when their own page is swept
  const pendingHeads = new Map<number, { idx: number; of: ContRef }>();

  // Resume boundary. The page before the first one this run sweeps was finished
  // by an EARLIER run, so its tail never got the chance to absorb this page's
  // head; without this repair every pause would leave one paragraph torn. It is
  // done before any other classification so page order stays ascending, and the
  // stored tail is found by TEXT (stored indices come from an older clustering).
  let boundaryTail: TrParagraph | null = null;
  // …and its context, resolved against ITS OWN page (p0-1) rather than the page
  // whose batch it rides in. Two separate values because the source half and the
  // target half have different licences: srcPrev claims adjacency and may only be
  // given when that page had a single readable measure (prev.model), while trPrev
  // claims nothing but «Russian already produced for this book» and is safe
  // whatever the layout was.
  let boundaryPrev: PrevPara | null = null;
  let boundaryOrder = false;
  let p0 = 0;
  for (let n = 1; n <= last && !p0; n++) if (willSweep(n)) p0 = n;
  if (p0 > 1 && store.pages[p0 - 1]?.length) {
    const prev = await classifyPage(p0 - 1);
    const st = prev ? await stitchFrom(prev) : null;
    if (prev && st && st.tail >= 0 && st.heads.length) {
      const stored = store.pages[p0 - 1];
      const joined = [prev.paras[st.tail].text, ...st.heads.map((h) => h.text)].join(" ");
      const of = (idx: number): ContRef => ({ page: p0 - 1, idx });
      // an interrupted earlier run may have stitched the tail already and died
      // before the head's page completed — then only the head marks are missing
      let j = stored.findIndex((p) => carryKey(p.text) === carryKey(joined));
      if (j < 0) {
        j = stored.findIndex((p) => carryKey(p.text) === carryKey(prev.paras[st.tail].text));
        if (j >= 0) {
          stored[j].text = joined;
          stored[j].tr = "";
          stored[j].contTo = st.heads.map((h) => ({ page: h.page, idx: h.idx }));
          boundaryTail = stored[j]; // joins the first swept page's wire batch
          boundaryPrev = seedBack(store, p0 - 1, j); // the paragraph above it, on its own page
          boundaryOrder = !!prev.model;
        }
      }
      if (j >= 0) for (const h of st.heads) pendingHeads.set(h.page, { idx: h.idx, of: of(j) });
    }
  }

  for (let n = 1; n <= last; n++) {
    if (signal?.aborted) break;
    for (const k of models.keys()) if (k < n) models.delete(k); // one page of lookahead is kept
    // update mode revisits done pages above the watermark; a page the update
    // has never completed (partial store) is translated in full either way
    if (done.has(n) && (!update || n <= updatedFrom)) continue;

    const cur = await classifyPage(n);
    if (!cur) continue;
    const { paras, figures, refPage } = cur;

    const t0 = performance.now();
    const out: TrParagraph[] = paras.map((p) => ({ ...p, tr: "" }));
    // a continuation half absorbed by an earlier page: kept in the store so
    // paragraph indices stay stable, but never translated and never rendered
    const ph = pendingHeads.get(n);
    if (ph) {
      pendingHeads.delete(n);
      if (out[ph.idx]) out[ph.idx].contOf = ph.of;
    }
    // …and does this page's own tail run over onto the next one?
    const st = await stitchFrom(cur);
    if (st.tail >= 0 && st.heads.length) {
      out[st.tail].text = [paras[st.tail].text, ...st.heads.map((h) => h.text)].join(" ");
      out[st.tail].contTo = st.heads.map((h) => ({ page: h.page, idx: h.idx }));
      for (const h of st.heads) pendingHeads.set(h.page, { idx: h.idx, of: { page: n, idx: st.tail } });
    }
    // Only kind:"prose" is translated: kind:"other" (display math / tables)
    // and kind:"caption" get image crops instead, kind:"furniture" (running
    // headers/footers) is dropped from the reflow entirely — tr stays "".
    // Prose mostly contained in a figure region is skipped too: its pixels
    // are already in the region's crop and the typesetter excludes it from
    // the flow (FIG_CONTAIN) — translating diagram labels only wastes wire
    // requests and invites hallucinated sentence expansions
    // …and a stitched continuation half is skipped as well: its text already
    // travelled with the paragraph that absorbed it
    let todo = refPage
      ? []
      : out.filter(
          (p) => p.kind === "prose" && !p.contOf && !figures.some((r) => interArea(p, r) >= FIG_CONTAIN * p.w * p.h),
        );
    // update: pull translations over from the old clustering of this page —
    // only genuinely new/changed paragraphs (and ones whose stored translation
    // fails the staleness audit) stay on the wire list
    const old = update ? store.pages[n] : undefined;
    if (old) todo = carryOver(todo, old, total);
    // the repaired resume-boundary tail rides this page's batch (it belongs to
    // page p0-1 and must NOT be matched against this page's old clustering)
    if (boundaryTail) {
      todo = [boundaryTail, ...todo];
      boundaryTail = null;
    }

    // ---- the draft's context window ----------------------------------------
    //
    // The prompt carries the previous SOURCE paragraph and target text already
    // produced for this book, because without them pronouns, tenses and the ты/вы
    // form of address drift from paragraph to paragraph. Both are indexed off the
    // page's OWN reading order (`out`), never off `todo`: `todo` is `out` filtered
    // to prose, then run through carryOver, and in «Обновить перевод» — the mode
    // where most paragraphs match and only a handful hit the wire — todo[k-1] is
    // routinely a paragraph from a completely different part of the page. Update
    // mode is also where the best possible trPrev is free: carryOver has just
    // filled `tr` on the paragraph that really does precede this one.
    //
    // READING ORDER, HONESTLY: clusterParagraphsEx sorts by y-band then x
    // (paragraphs.ts:891), so on a two-column page the paragraph before this one
    // in `out` is the one BESIDE it, not above it. stitchModel returns null for
    // exactly those pages (paragraphs.ts:1641-1683 — no prose, or two side-by-side
    // measures), so that null is read here as «reading order unknown» and NO
    // source context is sent at all. A wrong antecedent is worse than none: it
    // teaches the model a false referent, which is the very drift the context
    // window exists to remove. trPrev survives that case because its block header
    // claims no adjacency — translate.ts:469 labels it «already produced for this
    // book» and nothing more.
    const outIdx = new Map<TrParagraph, number>();
    out.forEach((p, i) => outIdx.set(p, i));
    const readingOrder = !!cur.model;
    // the previous page's tail, for the paragraph that opens this one
    const pageSeed = seedBack(store, n - 1);
    const prevOf = (i: number): PrevPara | null => {
      for (let j = i - 1; j >= 0; j--) {
        const q = out[j];
        // everything that is not translated is not read either: furniture,
        // captions, display maths and table cells, and prose whose pixels are
        // inside a figure's crop (the same FIG_CONTAIN test the todo list uses)
        if (q.kind !== "prose") continue;
        if (figures.some((r) => interArea(q, r) >= FIG_CONTAIN * q.w * q.h)) continue;
        if (q.contOf) {
          // a half absorbed by an earlier page: the text above belongs to the
          // paragraph that swallowed it, and so does its translation
          const own = store.pages[q.contOf.page]?.[q.contOf.idx];
          return own ? { text: own.text, tr: own.trRaw ?? own.tr } : null;
        }
        return { text: q.text, tr: q.tr };
      }
      return pageSeed;
    };
    const ctxOf = (k: number, chain: string): DraftCtx => {
      const i = outIdx.get(todo[k]);
      // boundaryTail is not one of this page's paragraphs — it belongs to p0-1,
      // and its own predecessor was resolved against that page at the repair site
      const known = i === undefined ? boundaryOrder : readingOrder;
      const prev = i === undefined ? boundaryPrev : prevOf(i);
      return {
        srcLang: store.srcLang,
        srcPrev: known ? prev?.text : undefined,
        // the real predecessor when it has already resolved (carried over, or
        // translated earlier in this slice), else this worker's own last output,
        // else the previous page's tail. Never "" — an empty block would print a
        // header with nothing under it.
        trPrev: prev?.tr || chain || pageSeed?.tr || undefined,
      };
    };

    if (todo.length) {
      // CONTIGUOUS SLICES, STRICTLY CHAINED INSIDE EACH — and this reverses the
      // shared cursor that stood here (a single `i++` three workers pulled from).
      //
      // The cursor was kept on the argument that trPrev could be a «trailing
      // anchor»: whatever nearby translation happened to have resolved. That is
      // not what the mechanism does. All three workers call ctxOf BEFORE any
      // await resolves, so at page start todo[0], todo[1] and todo[2] all see
      // every tr still empty, and in steady state the nearest resolved index is
      // k-3, not k-1. On a typical prose page of 4–8 paragraphs that means most
      // of the page gets only the previous page's tail — which is the whole-book
      // no-context behaviour this change exists to remove.
      //
      // Contiguous slices give the true immediate predecessor for every
      // paragraph but the head of each slice — and the head is answered by the
      // page seed, which we are building anyway. What they give up is work
      // stealing: a slice of long paragraphs finishes after the others, so the
      // page's wall clock is its slowest slice rather than its average. Bounded
      // by one paragraph's latency on a page of this size, and paid once per page.
      //
      // THE CHAIN IS AUTHORITATIVE, THE POOL IS NOT. The draft pool is 7 now
      // rather than the 3 this loop was written against (translate.ts's «request
      // budgets», and the batching table under it), and against a page of six
      // prose paragraphs seven slices would be six slices of one — no chain, no
      // previous target paragraph, the exact behaviour the context window exists
      // to remove. So the slice count is the pool capped by what the page can
      // actually chain: see MIN_CHAIN and chainSlices above for the trade this
      // makes, why it is payable, and why the cap is derived from the slice
      // length rather than the slice length from the cap. `todo.length` needs no
      // separate clamp — floor(n / 3) never exceeds n.
      const bounds = chainSlices(todo.length, draftPoolSize());
      const worker = async (w: number) => {
        const hi = bounds[w + 1];
        let chain = ""; // this slice's own last translation — always resolved
        for (let k = bounds[w]; k < hi; k++) {
          if (signal?.aborted) return;
          const tr = await translateRetry(todo[k].text, glossary, waitHealthy, ctxOf(k, chain), signal);
          todo[k].tr = tr;
          if (tr) chain = tr;
        }
      };
      let aborted = false;
      try {
        await Promise.all(Array.from({ length: bounds.length - 1 }, (_, w) => worker(w)));
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

// ---- the style pass («Выправить стиль») --------------------------------------
//
// The second half of the two-model design. The draft model translates; this pass
// reads the RUSSIAN BACK, one paragraph at a time, with the original nowhere in
// sight, and repairs agreement, cases, typos, spacing, register and the foreign
// script the previous translator left behind («использует модель большого语言
// моделя» — measured in the reader's own store, 10 of 2961 paragraphs). The guide,
// the prompt and every guardrail live in styleguide.ts; the wire client is
// translate.ts's styleComplete. What is here is the sweep, the store and the
// failure policy.
//
// IT TAKES NO PDFDocumentProxy. It reads and rewrites the store only — no page
// render, no clustering, no 38 MB file read — which is why it starts in a beat
// where a draft run takes seconds, and why launchRun skips openRunDoc for it.
//
// FAILURE POLICY, and it is the OPPOSITE of translateRetry's on purpose. A draft
// run may wait out an outage for ever because a missing translation is nothing
// lost. Here the input is already good Russian: every failure — a dead server, a
// 400, a reply that failed a guardrail — KEEPS THE DRAFT and moves on, and the
// pass never assigns "" (export.ts:135-145 turns "" into an image crop, so an
// empty string here would delete a good translation and show the reader a
// picture of the English). The aux server is probed ONCE up front; absent means
// return with nothing written, because nobody has the 14.2 GB by default and
// «model missing» is the ordinary case, not the exception.
//
// IT TAKES THE CARD, ONCE, AT THE START. Both models no longer sit on the GPU
// together: whichever server is asked for evicts the other's spawned child and
// leaves it in "swapping" (src-tauri/src/lib.rs's swap_out). The trigger here is
// the aux LEASE, which ensureAux takes once below and the `finally` releases
// once — so the handover happens exactly twice per pass, at the two ends, and
// never per paragraph. Two properties of the native side are what make that
// true, and both are load-bearing: a held lease makes AuxState::in_use true, so
// nothing can evict these weights while the sweep is running; and releasing the
// last lease restores the draft server by itself (restore_after_handover), so
// the reader is not left without a translator on a book the sweep just finished.
//
// CONTENTION, stated because it is real and nothing here prevents it: these are
// the same weights and the same auxPool the Terms tab and graphgen's background
// deep passes draw from, and graphrun's queue deliberately keeps running while a
// book is open (translate.ts:1193, graphrun.ts:35). An hours-long style run and
// the graph queue WILL interleave on one set of 26B weights and roughly halve
// each other. The worker count leaves one aux slot free so the interactive
// surfaces still answer; it does not make the graph any faster.

/// Poll ceilings for the aux server, in ms.
///
/// AUX_BOOT_MS is deliberately LONGER than the native side's own boot ceiling
/// (LlamaSrv::BOOT_POLLS = 600 × 500 ms = 300 s). Setting the two equal makes a
/// load that finishes at 299.5 s a coin flip between «up» and a frontend timeout
/// — and this frontend's timeout means «the model is not installed» and writes
/// nothing, which would be a flat lie about a server that is now running and
/// holding 13.3 GB. The native side owns the timeout; we only outlast it.
const AUX_BOOT_MS = 360_000;
const AUX_POLL_MS = 1500;
/// …and the mid-run gate, which is a different question: the server was up and
/// stopped answering. One minute, then the pass ends with what it has written.
const AUX_GATE_MS = 60_000;

/// Take the aux lease for `owner` and wait for the weights, once.
///
/// The shape is GlossaryPanel's ensureAux (:275) and the reasoning is the same:
/// outside Tauri there is no IPC, so an externally started server on 11545 is the
/// only thing that can answer. Every status but "starting" is terminal —
/// "none"/"dead"/"nomem"/"crashed" (lib.rs `aux_model_status`) — and treating them as ends of
/// the wait is what keeps this from spinning to its own deadline against a server
/// that is never coming up.
async function ensureAux(owner: string, signal?: AbortSignal): Promise<boolean> {
  if (!IS_TAURI) return isAuxUp();
  let s: string;
  try {
    s = await invoke<string>("aux_model_start", { owner });
  } catch {
    return isAuxUp();
  }
  const deadline = Date.now() + AUX_BOOT_MS;
  while (Date.now() < deadline) {
    if (s === "up" || s === "external") return true;
    if (s !== "starting") {
      // Named in the console, because the four terminal statuses mean four very
      // different things and the frontend collapses them into one silent «the
      // pass did nothing»: "none" is «you never downloaded the 14.2 GB», while
      // "nomem"/"crashed" on a machine that DID download them is a resource
      // failure — and llama-server's own stderr is where the reason lives.
      console.warn(`aux server unavailable for the style pass: ${s}`);
      return false;
    }
    await sleep(AUX_POLL_MS, signal); // abort rejects here → the run unwinds
    try {
      s = await invoke<string>("aux_model_status");
    } catch {
      return isAuxUp();
    }
  }
  return false;
}

/// The mid-run outage gate: makeHealthGate's shape against 11545, with a deadline
/// instead of a forever loop. `false` means «give up» — see the header on why
/// this pass must never stall indefinitely. Concurrent callers join the same
/// wait, so one outage produces one notification, not one per style worker.
function makeAuxGate(
  onStall?: (stalled: boolean, reason?: StallReason) => void,
): (signal?: AbortSignal) => Promise<boolean> {
  let waiting: Promise<boolean> | null = null;
  return (signal?: AbortSignal) => {
    waiting ??= (async () => {
      if (await isAuxUp()) return true; // single-request blip
      onStall?.(true);
      try {
        const deadline = Date.now() + AUX_GATE_MS;
        while (Date.now() < deadline) {
          await sleep(3000, signal);
          if (await isAuxUp()) return true;
        }
        return false;
      } finally {
        onStall?.(false);
      }
    })().finally(() => {
      waiting = null;
    });
    return waiting;
  };
}

/// The book's terms, as the editor needs them: the LIVE glossary file, ranked by
/// frequency, capped.
///
/// The live file and not store.glossaryText, which is frozen at :1155 when the
/// draft run first started and never refreshed — on an 838-page book it can be
/// hundreds of pages stale. The whole point of an edit pass is to bring finished
/// prose into line with the terms AS THEY NOW STAND, including the ones the reader
/// fixed by hand after reading three chapters. The snapshot is a record of what
/// the draft was made with; it is not what the edit should enforce.
///
/// loadGlossary rather than parseGlossary(hydrateGlossary(...)): the ranking wants
/// `freq`, which only the sidecar carries and only records have (parseGlossary
/// projects to {src,dst} and drops it). Without the sort the cap would cut by file
/// order — the reader's editing order — instead of by importance.
async function styleTerms(bookPath: string): Promise<StyleTerm[]> {
  const { records } = await loadGlossary(bookPath).catch(() => ({ records: [] }));
  return records
    .filter((r) => r.translation)
    .sort((a, b) => (b.freq ?? 0) - (a.freq ?? 0))
    .slice(0, STYLE_TERM_CAP)
    .map((r) => ({ src: r.term, dst: r.translation as string }));
}

/// Sweep the store's finished pages through the style editor. Returns the store
/// (edited in place and written page by page), or null when there is nothing to
/// edit. Never throws for a model fault; an abort unwinds through the workers and
/// leaves every completed page on disk.
export async function startStyleEdit(
  bookPath: string,
  opts: {
    onProgress?: (p: BookProgress) => void;
    /// Widened to match startBookTranslation's, so launchRun can hand the SAME
    /// callback to both. The style pass never fills the reason in: what stalls
    /// it is the aux server it holds a lease on, and a handover cannot take that
    /// card away while the lease is held (AuxState::in_use).
    onStall?: (stalled: boolean, reason?: StallReason) => void;
    signal?: AbortSignal;
    pageLimit?: number;
  } = {},
): Promise<BookTranslation | null> {
  const { onProgress, onStall, signal, pageLimit } = opts;
  const store = await loadBookTranslation(bookPath);
  if (!store || !store.donePages.length) return null;

  const owner = `style:${bookPath}`;
  try {
    // The lease is taken by ensureAux and released in the finally below whatever
    // happens — including the «never came up» path, where releasing a lease that
    // was taken and then failed is exactly what stops 13.3 GB being held by a
    // pass that gave up. aux_model_stop with a name that holds nothing is a
    // documented no-op (lib.rs `aux_model_stop`), so the unconditional release is safe.
    if (!(await ensureAux(owner, signal))) return store; // untouched, and NOT ONE BYTE written

    const lang = getLang() as StyleLang;
    const terms = await styleTerms(bookPath);
    const ref = new Set(store.refPages);
    const lastPage = Math.min(store.total, Math.max(1, pageLimit ?? store.total));
    // The sweep set is donePages, not 1..total: a page nobody has translated has
    // nothing to edit, and a reference page's every tr is "" by construction.
    const pages = store.donePages.filter((n) => n > (store.styledThrough ?? 0) && n <= lastPage && !ref.has(n));
    const auxGate = makeAuxGate(onStall);
    // Its OWN ETA window. A style page and a draft page cost wildly different
    // amounts of time, and one shared average would oscillate between them.
    const durations: number[] = [];
    let kept = 0; // paragraphs whose draft survived a refusal or a failure
    let dead = false; // the aux server went away mid-run and did not come back

    for (let pi = 0; pi < pages.length; pi++) {
      if (signal?.aborted || dead) break;
      const n = pages[pi];
      const t0 = performance.now();
      // Same filter the draft pass uses, plus «has something to edit». A
      // continuation half's Russian lives on the paragraph that absorbed it, and
      // everything else in the page — furniture, captions, maths, figure labels —
      // carries tr "" and would fail acceptStyleEdit's empty gate anyway.
      const todo = (store.pages[n] ?? []).filter(
        (p) => p.kind === "prose" && !p.contOf && (p.trRaw ?? p.tr).trim() !== "",
      );
      if (todo.length) {
        // The draft pass's slice pool, one below the aux request pool: contiguous
        // ranges, chained strictly inside each, so the paragraph handed to the
        // model as «the previous paragraph, already edited» really is the previous
        // one. MIN_CHAIN applies for the same reason it does on the draft side —
        // a slice of one has no chain — and here it also keeps the page from
        // splitting past the slots the pass is allowed to hold (STYLE_HEADROOM).
        // The cut itself is chainSlices', shared with the draft loop: the two
        // used to carry the same two lines each, and the tail defect chainSlices
        // fixes lived in both copies.
        const bounds = chainSlices(todo.length, auxPoolSize() - STYLE_HEADROOM);
        const worker = async (w: number) => {
          const hi = bounds[w + 1];
          let chain = "";
          for (let k = bounds[w]; k < hi; k++) {
            if (signal?.aborted || dead) return;
            const p = todo[k];
            // (trRaw ?? tr) — the DRAFT. A second run therefore edits the
            // translator's text again rather than its own edit, which is what
            // makes the pass idempotent instead of drifting further every time.
            const draft = p.trRaw ?? p.tr;
            // this slice's own last result; at a slice head the page-order
            // predecessor, which is at worst still Russian from this book
            const prevEdited = chain || (k > 0 ? todo[k - 1].tr : "") || undefined;
            // What this paragraph ends up with. It STARTS as the draft and stays
            // the draft on every failure path — a refused reply, a 400, a request
            // the gate gave up on — which is what lets the ё/е fold below run over
            // a kept draft exactly as it runs over an accepted edit. `accepted`
            // is tracked separately because only a reply that cleared the
            // guardrails may seed the chain the next paragraph is shown.
            let out = draft;
            let accepted = false;
            let retried = false;
            for (;;) {
              try {
                // Priced against ONE aux slot before anything goes on the wire.
                // auxComplete's own clamp can only shorten the reply, and by then
                // the prompt is already assembled — a paragraph too long for the
                // slot would be sent with less room than its own echo costs and
                // come back truncated, which acceptStyleEdit then blames on the
                // model as `"length"`. planStyleEdit refuses it instead, and the
                // refusal lands in `kept` beside every other reason a paragraph
                // keeps its draft, so «оставлено как есть» stays one number the
                // reader can read (styleguide.ts:791, StyleReject's "budget").
                const plan = planStyleEdit(draft, terms, prevEdited, lang, auxSlotSize());
                if (!plan.ok) {
                  kept++;
                  break;
                }
                const raw = await styleComplete(plan.prompt, signal, { maxTokens: plan.maxTokens });
                const v = acceptStyleEdit(draft, raw, terms, lang);
                if (v.ok) {
                  out = v.text;
                  accepted = true;
                } else kept++;
                break;
              } catch (e) {
                if (signal?.aborted) throw e;
                if (e instanceof ModelUnavailableError && !retried) {
                  retried = true;
                  if (await auxGate(signal)) continue;
                  dead = true; // gate gave up — end the pass with what is written
                  return;
                }
                kept++; // any other failure: the draft stands
                break;
              }
            }
            // ё/е, DETERMINISTICALLY AND NOT BY PROMPT. The policy and its whole
            // argument live in styleguide.ts (YO_POLICY, applyYoPolicy); what
            // belongs here is only WHERE it is applied, and that placement is the
            // half of the defect this module owns. It runs AFTER acceptStyleEdit,
            // because the guardrails compare the model's reply against the draft
            // it was actually given and a draft we had already rewritten is not
            // that text. And it runs on `out` rather than on the accepted branch
            // alone, because the defect is not a wrong spelling but TWO spellings:
            // a paragraph whose edit was refused sits in the same book as one
            // whose edit was taken, and folding only the second would leave the
            // reader exactly the «ё and е in adjacent paragraphs» that CHANGELOG
            // claims this stage fixes. It is a no-op for a target language with no
            // ё (YO_POLICY.en), so no branch on `lang` is wanted here.
            const text = applyYoPolicy(out, lang);
            // Against p.tr and not against the draft: on a second run p.tr is the
            // previous edit, and this is the honest «did anything change» test in
            // both. An accepted reply identical to what is already stored is the
            // guide's «если абзац уже хорош, верни его без изменений» and costs
            // nothing to store — writing trRaw for it would double the paragraph
            // on disk to record that nothing happened, and would light up the
            // Restore verb for a book with nothing to restore. A fold that DID
            // change the spelling is a real change and is recorded as one, so
            // «Вернуть черновой перевод» gives the reader back their ё.
            if (text !== p.tr) {
              p.trRaw ??= p.tr;
              p.tr = text;
            }
            // The FOLDED text seeds the chain, so the next paragraph is shown the
            // spelling that is actually in the book rather than the one the model
            // happened to reply with.
            if (accepted) chain = text;
          }
        };
        try {
          await Promise.all(Array.from({ length: bounds.length - 1 }, (_, w) => worker(w)));
        } catch {
          break; // only an abort rejects; the page is unwritten and a resume redoes it
        }
      }
      if (signal?.aborted || dead) break;
      // The watermark and nothing else. Not donePages, not updatedThrough, not
      // refPages, not figures, not bodyFh, not hyphens — every one of those is
      // another sweep's state, and this pass has no business in any of them.
      store.styledThrough = n;
      store.styleModel = STYLE_MODEL;
      await writeStore(store);

      durations.push(performance.now() - t0);
      if (durations.length > ETA_WINDOW) durations.shift();
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      // The denominator is the BOOK's page count, not pages.length: styledThrough
      // is a page number, App reads styledPct as styledThrough/total, and a bar
      // fed from a different denominator than the number beside it is how a
      // percentage ends up over 100 on a half-translated book.
      onProgress?.({
        page: n,
        total: store.total,
        donePages: n,
        etaMs: Math.round(avg * (pages.length - 1 - pi)),
        kept,
      });
    }

    // COMPLETION, and it is NOT updatedThrough's condition (:1619). That
    // watermark's domain is the whole book, so re-sweeping from page 1 is the
    // intended meaning of «finished». styledThrough's domain is donePages, which
    // GROWS: a reader who styles a half-translated book, then finishes the
    // translation, then runs the pass again would otherwise get a full sweep from
    // page 1 re-editing every already-edited paragraph — hours to days on this
    // hardware, to gain nothing. So the watermark drops only when it covers the
    // WHOLE book, which is the same shape as update's `last === total` guard.
    const maxDone = store.donePages[store.donePages.length - 1] ?? 0;
    if (
      !signal?.aborted &&
      !dead &&
      lastPage >= store.total &&
      store.donePages.length >= store.total &&
      (store.styledThrough ?? 0) >= maxDone
    ) {
      delete store.styledThrough;
      await writeStore(store);
    }
    if (kept) console.info(`style pass: ${kept} paragraph(s) kept as drafted`);
    return store;
  } finally {
    if (IS_TAURI) invoke("aux_model_stop", { owner }).catch(() => {});
  }
}

/// «Вернуть черновой перевод»: undo the style pass everywhere it touched.
///
/// stopRun FIRST, exactly as App's retranslate does (App.tsx:1776) and for the
/// same reason: a live run holds its own in-memory copy of the store and its next
/// writeStore lands that whole JSON, so restoring underneath one would be undone
/// a page later. The Restore verb is only rendered in the finished row, but a
/// background run started from the Library on the same book is reachable, and one
/// awaited line removes the whole class.
export async function restoreDrafts(bookPath: string): Promise<void> {
  await stopRun(bookPath);
  const store = await loadBookTranslation(bookPath);
  if (!store) return;
  let n = 0;
  for (const paras of Object.values(store.pages)) {
    for (const p of paras) {
      if (p.trRaw === undefined) continue;
      p.tr = p.trRaw;
      delete p.trRaw;
      n++;
    }
  }
  // Both, and unconditionally: with no trRaw left there is no edit for either to
  // describe, and a stale styledThrough would make the next style run skip pages
  // that now hold nothing but drafts.
  delete store.styledThrough;
  delete store.styleModel;
  await writeStore(store);
  console.info(`style pass undone: ${n} paragraph(s) back to the draft`);
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

/// Which sweep is in flight. Was a boolean `update` while there were two; a third
/// verb makes it a name, because «not an update» stopped being a useful thing to
/// know the moment a style pass could also be the thing that is running.
export type RunMode = "fresh" | "update" | "style";

export type RunInfo = {
  bookPath: string;
  done: number; // completed pages — or the swept/styled watermark (seeded from the store before page 1)
  total: number; // 0 only for the moment before the run's doc is open
  etaMs?: number;
  stalled: boolean; // engine is waiting out a model outage (auto-resumes)
  // Why, when there is anything better to say than «модель недоступна».
  // Meaningful only while `stalled` — it is cleared with the flag, so a surface
  // may read the pair without checking the order they arrived in.
  stallReason?: StallReason;
  mode: RunMode;
  kept?: number; // style runs only: paragraphs left as drafted
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

// One launcher for all three run flavors. A book has at most ONE active run, and
// the guard now REFUSES A MISMATCH rather than joining it. It used to return the
// in-flight promise whatever was asked for, which was harmless while the two
// verbs were mutually exclusive on screen; with three it is not. «Выправить
// стиль» is reachable from the palette as well as the panel, so clicking it while
// a draft run is in flight would have returned the DRAFT run's promise: no style
// pass ever happens, no error, and nothing on screen. The rejection lands in
// App's existing startError path (the panel's Refusal row) — a surface that
// already exists and already says «that did not start».
//
// Two runs on one book must not coexist either, and that is not a UI nicety:
// both hold their own in-memory copy of the store and both call writeStore, so
// whichever finishes a page last writes the whole JSON and the other's work is
// gone.
//
// THE GUARD IS PER BOOK AND STAYS PER BOOK. A style pass on book B beside a
// draft run on book A is a real and reachable pair — the Library starts
// background runs, «Выправить стиль» is in the palette — and the aux spawn then
// evicts the draft server, so book A's run funnels into makeHealthGate and waits
// there for as long as book B's pass runs. The other repair for that was to
// refuse the style run whenever ANY draft or update run is active anywhere.
// This code does not, and the reason is coverage: the aux lease has three
// owners, and style is the rarest of them. «glossary» is taken by the Terms tab
// and «graph» by graphrun's background queue, which with autoBuild on takes it
// WITHOUT THE READER ASKING FOR ANYTHING (i18n's model.swapping comment sets out
// the same list). A cross-book refusal here would leave two of the three
// evictions producing exactly the symptom it was written to fix, while removing
// a pass the reader explicitly asked for on a book that is not even involved.
// Naming the cause fixes all three at once and refuses nothing: makeHealthGate
// reads the reason off translation_status and it reaches the panel as the
// stalled run's own words, the way the start path already routes «swapping» into
// a wait rather than into the download modal (App.tsx's startTr).
//
// What that leaves unfixed is the wall clock — book A really does stop for the
// length of book B's pass — and that is not a defect this guard could have
// removed anyway. One card, one model at a time, is the premise; the honest
// version of it is a run that says why it is waiting.
//
// The returned promise settles when the run does; it rejects on a mode clash and
// when the book file cannot be opened — pipeline errors (abort included) are
// logged and swallowed, because the per-page store already holds every finished
// page.
function launchRun(bookPath: string, mode: RunMode, pageLimit?: number): Promise<void> {
  const existing = runs.get(bookPath);
  if (existing) {
    if (existing.info.mode === mode) return existing.promise;
    return Promise.reject(new Error(`book busy: a "${existing.info.mode}" run is already active`));
  }
  const ctrl = new AbortController();
  const info: RunInfo = { bookPath, done: 0, total: 0, stalled: false, mode };
  const onStall = (stalled: boolean, reason?: StallReason) => {
    info.stalled = stalled;
    // Cleared with the flag rather than left behind: a run that recovered and
    // later stalls for a plain outage must not still be blaming the handover
    // that ended ten minutes ago.
    info.stallReason = stalled ? reason : undefined;
    emitRuns();
  };
  const onProgress = (p: BookProgress) => {
    info.done = p.donePages;
    info.total = p.total;
    info.etaMs = p.etaMs;
    info.kept = p.kept;
    emitRuns();
  };
  // the watermark each flavor resumes from, for the seeding below
  const seed = (st: BookTranslation) =>
    mode === "update" ? st.updatedThrough ?? 0 : mode === "style" ? st.styledThrough ?? 0 : st.donePages.length;
  const promise = (async () => {
    // resumed runs show their real percentage BEFORE the (slow) doc open: the
    // toolbar band must move within the click's first beat, not after a 38MB
    // file read — completed pages for translation, the watermark for an update.
    // Best-effort: a moved book resolves its store only after bindBook inside
    // openRunDoc — the post-open seeding below covers that case.
    const st0 = await loadBookTranslation(bookPath).catch(() => null);
    if (st0) {
      info.done = seed(st0);
      info.total = st0.total;
      emitRuns();
    }
    // A style pass reads and rewrites the store only — no clustering, no render,
    // no 38 MB file read — so it opens no document at all. Its denominator is the
    // book's page count for the reason startStyleEdit's onProgress states: the
    // number beside the bar is a page number and the bar must divide by the same
    // thing.
    if (mode === "style") {
      if (ctrl.signal.aborted) return;
      await startStyleEdit(bookPath, { signal: ctrl.signal, pageLimit, onStall, onProgress }).catch((e) => {
        if (!ctrl.signal.aborted) console.error("style pass failed", e);
      });
      return;
    }
    const doc = await openRunDoc(bookPath); // open failure surfaces to the caller
    try {
      info.total = doc.numPages;
      // re-seed after binding: the pre-open read misses a just-moved book's store
      const st = await loadBookTranslation(bookPath);
      if (st) info.done = seed(st);
      emitRuns();
      if (ctrl.signal.aborted) return;
      await startBookTranslation(doc, bookPath, {
        signal: ctrl.signal,
        update: mode === "update",
        pageLimit,
        onStall,
        onProgress,
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

// Start the background translation run for a book (or join the active one).
export function startRun(bookPath: string): Promise<void> {
  return launchRun(bookPath, "fresh");
}

// «Выправить стиль» — the second pass over an already-translated book: every
// finished page's Russian is read back one paragraph at a time by the style model
// and returned with its agreement, cases, typos, spacing and register repaired,
// with the original never in view. Runs through the same manager as the other two
// (progress / pause via stopRun / background semantics are identical, resume via
// store.styledThrough) and opens no PDF at all. Rejects if a draft or update run
// holds this book.
export function startStyleRun(bookPath: string, opts: { pageLimit?: number } = {}): Promise<void> {
  return launchRun(bookPath, "style", opts.pageLimit);
}

// «Обновить перевод» — incremental re-translation after engine improvements:
// sweep EVERY stored page through the CURRENT clustering/classification code
// (furniture, refPages and figures are recomputed), carry translations over by
// EXACT paragraph-text match and send only new/changed paragraphs to the model
// — unchanged pages complete instantly, with zero requests. Stored pairs whose
// translation no longer fits their text (looksStaleTr — the running-header weld
// residue) are dropped from the carry pool and re-translated. Runs through the
// same run manager as a normal translation: progress/pause (stopRun)/
// background semantics are identical, resume via store.updatedThrough.
// opts.pageLimit is the same dev/test hook startBookTranslation has.
export function updateBookTranslation(bookPath: string, opts: { pageLimit?: number } = {}): Promise<void> {
  return launchRun(bookPath, "update", opts.pageLimit);
}
