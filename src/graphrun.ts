// Background build manager for the library-wide knowledge graph.
//
// This is booktranslate.ts's run manager rebuilt for a different job, and the
// difference that matters is the shape: translation is a fan-out of one book
// across three workers, a graph build is a QUEUE. At most one book is ever
// extracted at a time. The reader's machine is already running a translation
// model on the GPU and rasterising pages in the same process, and a library of
// two hundred PDFs is an ordinary library — if enqueue started a job per book
// the scan itself would freeze the app before a single shard was written. The
// queue must trickle, never stampede, and the trickle is the feature: the
// graph fills in over an evening while the reader reads, and nothing in the
// UI ever waits on it.
//
// All the state below is module-scope, exactly as in booktranslate.ts and for
// the same reason: a build outlives the component that started it. The library
// grid unmounts the moment the reader opens a book, and the queue must keep
// going. UI surfaces subscribe with onGraphRunsChange and read snapshots with
// listGraphRuns/getGraphRun; there is no React state anywhere in this file.
//
// Every book is written TWICE on purpose. seedShard produces a shard from the
// PDF alone — title, authors, provenance verdict, page count, the term
// frequencies — and that shard is written before any model is involved, so the
// book joins the graph within seconds of being seen. deepen then spends real
// time (and, for a licensed book, Claude Code) turning those terms into typed,
// glossed concepts, and the second write is the payoff. An abort between the
// two leaves the seed on disk: a partial graph is the promise this feature
// makes, and it is kept even when the reader closes the app mid-build.
//
// Failures are per-book and never fatal. One PDF with a broken xref table must
// not hold a two-hundred-book library hostage, so the error is recorded on the
// run, the book is dropped, and the queue moves on. A failed run stays visible
// for FAIL_LINGER_MS so a chip can show it, then clears itself — long enough
// to be read, short enough that the next rescan may retry the book.
//
// The manager never touches the aux model's lifecycle. ensureAux and
// aux_model_stop belong to graphgen.deepen, which knows when the weights are
// actually needed; a queue that loaded them per book would thrash 16 GB of
// VRAM against the translation engine for no gain.

import { readFile } from "@tauri-apps/plugin-fs";
import { getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { bookKey, contentKey, setBookKey } from "./bookid";
import { canDeepen, deepen, GRAPH_GEN, seedShard } from "./graphgen";
import type { GenPhase, GenProgress } from "./graphgen";
import { deleteShard, shardFor, writeShard } from "./graphstore";
import type { Shard } from "./graphstore";
import { baseName } from "./host";

// ---- tunables ---------------------------------------------------------------

/// The auto-build switch. Frozen name (WP-M): once written, a localStorage key
/// is never renamed. graphstore.ts knows about this neighbour under its own
/// «pdfer:graph:» prefix and excludes it from the dev-pane shard scan.
const AUTO_KEY = "pdfer:graph:auto";

/// The Claude-pass switch, same frozen-name rule as AUTO_KEY. Default OFF —
/// see claudeDeepen() for why that is a default and not a limitation.
const CLAUDE_KEY = "pdfer:graph:claude";

// A build reports progress per extracted page and per resolved term — hundreds
// of times a second on a fast machine. Repainting the library grid that often
// would cost more than the extraction it is reporting, so progress emits are
// throttled to roughly four frames a second (leading edge plus one trailing
// timer). Queue changes ride the same throttle; only reader-visible events —
// a stop, a failure, a finished book — emit immediately.
const EMIT_MS = 250;

// How long a failed run stays in the listing after it is dropped from the
// queue. Twenty seconds is «the reader looked up and saw why», not «the error
// lives in the UI until dismissed» — nothing here is important enough to
// demand an acknowledgement.
const FAIL_LINGER_MS = 20000;

// ---- state ------------------------------------------------------------------

/// One book's build, as the UI sees it. A queued book and a just-started one
/// look identical (phase "seed", 0 of 0) — that is deliberate, both mean «the
/// graph for this book is coming». The book actually being worked on is the
/// one whose counters move; queueLength() says how many wait behind it.
export type GraphRun = {
  path: string;
  title: string;
  phase: GenPhase;
  done: number;
  total: number;
  error: string | null;
};

// What the worker needs and the UI must not see: the job's own abort handle.
type RunState = { info: GraphRun; ctrl: AbortController };

// A queued book. `force` is what makes the worker rebuild rather than skip a
// book it can already see a shard for; it is carried separately from `forget`
// because the old shard is now left standing for the whole rebuild, so its
// mere presence must never be read as «already built». `forget` is what makes
// a rebuild a rebuild rather than a re-run: it re-reads the reader's override
// and retires a shard the rebuild supersedes under a different name.
type Job = { path: string; force: boolean; forget: boolean };

const queue: Job[] = [];
const runs = new Map<string, RunState>();
let active: string | null = null; // the one book being built, by path

const listeners = new Set<() => void>();
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let emittedAt = 0;

/// Fires after any change to the queue or to a run's progress. Returns the
/// unsubscribe function.
export function onGraphRunsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function emit(): void {
  if (emitTimer !== null) {
    clearTimeout(emitTimer);
    emitTimer = null;
  }
  emittedAt = Date.now();
  // A throwing subscriber must not abort the notification of the others, and
  // must never reject the build that triggered it — the shard is already on
  // disk and a rejected write would look to the worker like a failed book.
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.error("graph run listener failed", e);
    }
  }
}

function emitSoon(): void {
  if (emitTimer !== null) return; // a trailing emit is already booked
  const wait = EMIT_MS - (Date.now() - emittedAt);
  if (wait <= 0) {
    emit();
    return;
  }
  emitTimer = setTimeout(() => {
    emitTimer = null;
    emit();
  }, wait);
}

// ---- reading the queue ------------------------------------------------------

/// Snapshot copies — safe to hold in React state while the live infos mutate.
export function listGraphRuns(): GraphRun[] {
  return [...runs.values()].map((r) => ({ ...r.info }));
}

/// This book's build, or null when the manager knows nothing about it.
export function getGraphRun(path: string): GraphRun | null {
  const state = runs.get(path);
  return state ? { ...state.info } : null;
}

/// Books waiting their turn — the book being built now is not counted.
export function queueLength(): number {
  return queue.length;
}

// ---- the auto-build switch --------------------------------------------------

/// Whether a library scan may enqueue on its own. Default true: the graph is
/// the feature, and a reader who never opens Settings should still get one.
export function autoBuild(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    // storage denied (private mode, a locked profile) — a preference nobody
    // could read is not a preference against the default
    return true;
  }
}

/// Flip the switch. Turning it OFF also stops what is already running: the
/// reader who reaches for this switch is asking the machine to stop working,
/// and leaving a hundred queued books grinding would answer a different
/// question than the one they asked. An explicit «build everything» after the
/// fact starts the queue again.
export function setAutoBuild(on: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, on ? "1" : "0");
  } catch (e) {
    console.warn("graph: the auto-build switch did not persist", e);
  }
  if (!on) stopAll();
  else emit();
}

// ---- the Claude-pass switch -------------------------------------------------

/// May an openly licensed article be deepened by Claude Code? Default FALSE,
/// which is the opposite default from autoBuild() and deliberately so: a build
/// seeds a shard and deepens it in the same breath, so a library pointed at a
/// folder of fifty PDFs would send every file the classifier called «article»
/// off this machine during the very first scan — before the reader has seen a
/// single verdict, let alone corrected one. The network is reached here on an
/// explicit action, never as a side effect of a scan.
///
/// Nothing is missing while this is off: graphgen.deepen falls through to the
/// local model for an article exactly as it does for a book, so the graph is
/// still built. Turning the switch on is one click in Settings.
///
/// Callers must read this at the moment of use rather than caching it, so the
/// switch takes effect on the next book without a restart.
export function claudeDeepen(): boolean {
  try {
    return localStorage.getItem(CLAUDE_KEY) === "1";
  } catch {
    // storage denied (private mode, a locked profile) — an unreadable
    // preference can never be the reader's consent to send pages away
    return false;
  }
}

/// Flip the Claude pass. Unlike setAutoBuild this stops nothing: turning it
/// off means «no more of my files leave this machine», and the books already
/// queued still get their local deep pass, which is work the reader wants.
export function setClaudeDeepen(on: boolean): void {
  try {
    localStorage.setItem(CLAUDE_KEY, on ? "1" : "0");
  } catch (e) {
    console.warn("graph: the Claude-pass switch did not persist", e);
  }
  emit();
}

// ---- filling the queue ------------------------------------------------------

const titleOf = (bookPath: string): string => baseName(bookPath).replace(/\.pdf$/i, "");

// The single entry point for all three public enqueuers. Total by
// construction: it is called from inside the library's filesystem scan, once
// per file, and a throw there would abandon the scan halfway through.
function push(bookPath: string, force: boolean, forget: boolean): void {
  try {
    if (!bookPath) return;
    const known = runs.get(bookPath);
    // Already queued, being built, or lingering after a failure — the second
    // sighting of the same file in the same scan costs nothing.
    if (known && !force) return;
    if (known) {
      // A rebuild of a book the manager already knows: abort it wherever it
      // is and replace it. The worker's identity guard keeps the abort from
      // deleting the fresh entry we are about to install.
      known.ctrl.abort();
      dropJob(bookPath);
      runs.delete(bookPath);
    }
    runs.set(bookPath, {
      info: { path: bookPath, title: titleOf(bookPath), phase: "seed", done: 0, total: 0, error: null },
      ctrl: new AbortController(),
    });
    queue.push({ path: bookPath, force, forget });
    emitSoon(); // a growing queue is not news; the worker's progress is
    pump();
  } catch (e) {
    console.error("graph: could not enqueue", bookPath, e);
  }
}

function dropJob(bookPath: string): void {
  const i = queue.findIndex((j) => j.path === bookPath);
  if (i >= 0) queue.splice(i, 1);
}

/// Note a book the library just saw. Synchronous, never throws, never awaits:
/// the caller is a filesystem scan mid-loop. Honours the auto-build switch —
/// when it is off, nothing is recorded at all, not even a pending job.
///
/// The «is this book already built?» question cannot be answered here — it
/// needs a shard read — so the worker asks it instead, one book before it does
/// any real work. An unchanged book that merely got rescanned therefore costs
/// one cached map lookup and no disk I/O at all: shards are content-keyed, so
/// a rescan of a finished library is very nearly free.
export function enqueue(bookPath: string): void {
  if (!autoBuild()) return;
  push(bookPath, false, false);
}

/// «Построить граф для всей библиотеки» — the reader asking for it explicitly,
/// so the auto-build switch does not apply. Books that already carry a shard
/// finished by the CURRENT extractor generation are still skipped by the
/// worker; this is not a rebuild. A book whose shard predates the extractor we
/// ship is re-read, and this is the entry point the library's catch-up scan
/// uses for it rather than rebuild(): rebuild() aborts and replaces a run that
/// is already in flight for the same path, so a folder that emits filesystem
/// events while a build runs would restart that build over and over, whereas
/// push() here sees the book is already known and costs nothing.
export function enqueueAll(paths: string[]): void {
  for (const p of paths) push(p, false, false);
}

/// Build this book's shard again from the file, replacing whatever is there.
/// Also an explicit reader action, so it too ignores the switch, and it is the
/// one path that bypasses the «already built» check. The old shard is REPLACED
/// by the worker rather than deleted here: a rebuild takes minutes, and a book
/// whose shard was removed up front would drop out of the graph for all of
/// them and stay out for good if the reader stopped the build in between.
export function rebuild(bookPath: string): void {
  push(bookPath, true, true);
}

// ---- stopping ---------------------------------------------------------------

/// Stop one book, wherever it is — waiting in the queue or being built right
/// now. Whatever reached disk stays there: a seeded book that was stopped
/// before deepening keeps its seed shard and stays in the graph.
export function stopGraphRun(path: string): void {
  const state = runs.get(path);
  dropJob(path);
  if (!state) return;
  state.ctrl.abort();
  runs.delete(path);
  emit();
}

/// Stop everything and forget the queue. Same guarantee: nothing already
/// written is removed. `active` is left as it is — it clears itself when the
/// aborted worker unwinds, which is also when the next book may start.
export function stopAll(): void {
  queue.length = 0;
  for (const state of runs.values()) state.ctrl.abort();
  runs.clear();
  emit();
}

// ---- the worker -------------------------------------------------------------

// The build's own document: bytes re-read from the book file into a dedicated
// proxy (its own worker), with the same asset options as the viewer's
// getDocument — cmaps matter for CID-font text extraction, and a graph built
// from mojibake is worse than no graph. The viewer's doc is destroyed on
// close, so a background build must never borrow it. ?test= dev books are URLs.
//
// The content key is computed BEFORE getDocument, because getDocument transfers
// the buffer to the pdf.js worker and leaves it detached here. Stashing it via
// setBookKey is what lets graphstore address this book's shard by its durable
// identity for the rest of the session (WP-M).
async function openGraphDoc(bookPath: string): Promise<{ doc: PDFDocumentProxy; key: string }> {
  const data = /^https?:\/\//i.test(bookPath)
    ? new Uint8Array(await (await fetch(bookPath)).arrayBuffer())
    : await readFile(bookPath);
  const key = contentKey(data);
  setBookKey(bookPath, key);
  const doc = await getDocument({
    data,
    cMapUrl: "/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/standard_fonts/",
    wasmUrl: "/wasm/",
    iccUrl: "/iccs/",
  }).promise;
  return { doc, key };
}

function report(state: RunState, p: GenProgress): void {
  state.info.phase = p.phase;
  state.info.done = p.done;
  state.info.total = p.total;
  emitSoon();
}

// The second write. A shard returned by an ABORTED deepen is partial, and
// writing it would stamp stage "deep" on a book that was never finished — the
// next scan would then skip it forever. So an abort writes nothing and leaves
// the seed shard standing.
async function runDeepen(shard: Shard, state: RunState, signal: AbortSignal): Promise<void> {
  const deepened = await deepen(shard, (p) => report(state, p), signal);
  if (signal.aborted) return;
  await writeShard(deepened);
}

async function build(job: Job, state: RunState): Promise<void> {
  const path = job.path;
  const signal = state.ctrl.signal;
  let doc: PDFDocumentProxy | null = null;
  let old: Shard | null = null;
  let fixed: Shard | null = null;
  try {
    if (job.forget) {
      // A rebuild READS the old shard here and leaves it exactly where it is.
      // Deleting it up front opened a window minutes wide — the whole
      // extraction and the whole deep pass — in which the book existed nowhere
      // but in this local variable, and every `if (signal.aborted) return`
      // below was a place where «Остановить сборку», a closed window or a
      // crash left the book with no shard at all. The next scan then re-seeded
      // it from the classifier with provFixed: false: a reader who had
      // corrected a conference paper to «Лицензионная книга» on the node card
      // got the paper reclassified as an article — and, with the Claude pass
      // on, its mined term list shipped off the machine. «Перестроить весь
      // граф» held that window open book after book for a whole library. So
      // nothing is deleted until a replacement has actually been written.
      //
      // Nothing is lost by waiting. Shards are named by content key, so the
      // rebuild's own write lands on the same file and supersedes it in one
      // rename; and seedShard does not need the file gone in order to think
      // again — it runs the classifier unconditionally and consults the old
      // shard only to honour a provFixed verdict, which is precisely the
      // «re-classify, but keep the reader's override» behaviour a rebuild
      // wants.
      try {
        old = await shardFor(path);
      } catch (e) {
        // A read that FAILED is not evidence that there was nothing to read,
        // and it must not be allowed to look like one: the rescue below is
        // skipped, but so is the retirement further down, so a shard we could
        // not read is a shard we do not touch. seedShard's own read of the
        // verdict is the remaining rescue.
        console.warn("graph: the old shard could not be read before rebuild", e);
      }
      if (old?.provFixed === true) fixed = old;
    }
    if (signal.aborted) return;

    const existing = job.force ? null : await shardFor(path);
    // «Already built» is two questions, not one: is this book finished, and was
    // it finished by the extractor we now ship. The stage answers the first,
    // the generation the second, and only a shard that passes both may be left
    // alone. Asking the stage alone is what left the reader who ran this
    // feature yesterday with nine nodes for an 838-page book for ever: every
    // scan saw stage «deep» and returned, so the rewrite that now finds 118
    // could only reach that book if the reader happened to find «Перестроить
    // весь граф» in Settings.
    if (existing !== null && existing.gen >= GRAPH_GEN) {
      // Finished already — this is the rescan case, and it must cost nothing.
      if (existing.stage === "deep") return;
      // Seeded, but the machine cannot deepen it (no Claude Code for a
      // licensed book, no aux model). Re-extracting the whole PDF on every
      // scan to arrive at the same seed would be pure waste, so stop here
      // and let a later scan pick it up once deepening becomes possible.
      if (!(await canDeepen(existing.prov))) return;
      state.info.title = existing.title || state.info.title;
      // Bind the book's content identity before deepening it, because this is
      // the one road to a deep pass that never opens the file — and openGraphDoc
      // is the only place in this module that calls setBookKey.
      //
      // That mattered for nothing while the deep pass only produced a shard:
      // shards are addressed by the key, and this branch already holds the
      // shard. It matters now that the pass WRITES — graphgen feeds what it
      // learned back into the reader's glossary for the book — because every
      // per-book file in this app is addressed through bookid, and with the map
      // empty translate.ts falls back to a hash of the PATH. The write would
      // land on a file belonging to no book, and would leave that stray list in
      // the glossary session cache, which is keyed by path and never
      // invalidated: the reader opens the book afterwards and their Terms tab
      // shows the stray list, savedRef and all, and the next blur writes it over
      // the hand-curated file. A background rescan deepens books the reader has
      // NOT opened — that is what the queue is for — so this was the common
      // case, not the exotic one.
      //
      // The shard already knows the answer and it costs neither a read nor a
      // hash to use it: a shard's key IS contentKey() over the bytes
      // openGraphDoc read, handed to seedShard and stored under that name.
      //
      // Only when nothing has bound this path yet. A key computed from the
      // bytes is evidence; a key remembered from an older shard is a claim
      // about a file that may have been edited since, and it must never be
      // allowed to replace the real one — bindBook and openGraphDoc write the
      // truth, and this line defers to both. graphgen re-checks the same
      // equality at its write and stays silent when it does not hold.
      if (bookKey(path) === null) setBookKey(path, existing.key);
      await runDeepen(existing, state, signal);
      return;
    }
    if (existing !== null) {
      // A shard from an older generation. It is NOT deepened in place — the
      // extraction is what changed, so the nodes a deep pass would type are the
      // wrong nodes — and it is NOT deleted: the code below re-reads the book
      // and writes over it, so this book keeps its old graph, unchanged and
      // still drawn, for every second of the minutes that takes. Falling
      // through here rather than into the branch above is the whole difference
      // between «the graph improves while you read» and «the graph goes blank
      // and comes back».
      //
      // From this line on the job behaves exactly as «Перестроить» does, and
      // that includes the reader's verdict: a hand-corrected provenance is
      // rescued onto the new shard below, and the superseded shard is retired
      // only if the re-read lands under a different content key. An upgrade
      // that silently reclassified a paper the reader had marked as a licensed
      // book would — with the Claude pass on — ship its term list off the
      // machine, which is the one thing a background rescan must never do.
      old ??= existing;
      if (existing.provFixed === true) fixed ??= existing;
    }

    const opened = await openGraphDoc(path);
    doc = opened.doc;
    if (signal.aborted) return;
    // a real denominator before the first page is parsed: the seed phase counts
    // pages, and a band that starts at 0 of 0 reads as a hang
    state.info.total = doc.numPages;
    emitSoon();

    const fresh = await seedShard(doc, path, opened.key, (p) => report(state, p), signal);
    if (signal.aborted) return;
    // The hand-set verdict rescued above, put back on the new shard. seedShard
    // usually carries it across by itself now that the old shard is still on
    // disk, but only when the book's content key is unchanged — a book whose
    // file was edited seeds under a NEW key and seedShard's own lookup finds
    // nothing, so this line is what keeps the override across that case. Its
    // evidence travels with it, because the «Почему» panel must keep
    // explaining the verdict the card actually shows. A rebuild redoes the
    // extraction, never the routing decision the reader made.
    const seeded: Shard =
      fixed === null ? fresh : { ...fresh, prov: fixed.prov, provFixed: true, evidence: fixed.evidence };
    state.info.title = seeded.title || state.info.title;
    // The first write, before any model runs: from this moment the book is IN
    // the graph — searchable, drawable, related to its neighbours by shared
    // terms — even if the app is closed one second later.
    await writeShard(seeded);
    // Only now — with the replacement on disk — may the old shard be retired,
    // and only when the rebuild landed under a different name. An unchanged
    // book keys to the same file and has already been superseded by the write
    // above, so deleting anything here would delete the shard we just made.
    // A book whose file changed keys elsewhere and would otherwise leave its
    // predecessor behind as a second book node for the same path, which the
    // merged view would draw as two copies of one book. This runs BEFORE the
    // abort check on purpose: the write has landed, and an abort arriving in
    // between must not be what leaves that duplicate in the graph.
    if (old !== null && old.key !== seeded.key) {
      await deleteShard(old.key).catch((e) => console.warn("graph: the superseded shard survived rebuild", e));
    }
    if (signal.aborted) return;

    if (!(await canDeepen(seeded.prov))) return;
    await runDeepen(seeded, state, signal);
  } catch (e) {
    // An abort is not a failure and must not leave a red chip behind.
    if (signal.aborted) return;
    // Raw detail, not a sentence: the words the reader sees are the UI's job.
    state.info.error = e instanceof Error ? e.message : String(e);
    console.error("graph build failed", path, e);
  } finally {
    doc?.loadingTask.destroy().catch(() => {});
    // Identity guard: a rebuild (or a stop-then-enqueue) may already have
    // replaced this entry with a fresh one for the same path, and the run we
    // are unwinding must not delete its successor.
    if (runs.get(path) === state) {
      if (state.info.error === null) runs.delete(path);
      else scheduleClear(path, state);
    }
    emit();
  }
}

// A failed run is dropped from the queue immediately and from the listing a
// little later, so the UI has a window in which to show what went wrong.
function scheduleClear(path: string, state: RunState): void {
  setTimeout(() => {
    if (runs.get(path) !== state) return;
    runs.delete(path);
    emit();
  }, FAIL_LINGER_MS);
}

// The next job whose run is still wanted. A job cancelled while it waited its
// turn has had its entry removed (or its signal fired) by stopGraphRun/stopAll
// and is simply skipped — the queue array is never searched for cancellations.
function nextJob(): { job: Job; state: RunState } | null {
  for (;;) {
    const job = queue.shift();
    if (job === undefined) return null;
    const state = runs.get(job.path);
    if (state && !state.ctrl.signal.aborted) return { job, state };
  }
}

// One book at a time, forever. pump() is a no-op while a build is in flight,
// and the build's own settlement calls it again — the chain runs through
// promise callbacks, so a library of two hundred books costs no stack.
function pump(): void {
  if (active !== null) return;
  const next = nextJob();
  if (next === null) return;
  active = next.job.path;
  emitSoon();
  void build(next.job, next.state).finally(() => {
    active = null;
    pump();
  });
}
