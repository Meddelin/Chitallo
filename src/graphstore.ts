// Storage and query layer for the library-wide knowledge graph.
//
// The graph is deliberately not one file. Every book owns a shard —
// <appDataDir>\graph\<contentKey>.json, named by the same content-derived key
// as the translation store (bookid.ts), so a shard survives the book file
// being moved or renamed, and so a graph build for one book can never corrupt
// what another book already contributed. Shards are written through the same
// tmp+rename dance as booktranslate.ts: an interrupted build leaves the
// previous complete shard, never a truncated one that would make the whole
// library's merged view disappear.
//
// The merged index — the thing GraphView draws and lookup() searches — is NOT
// persisted. It is recomputed from the shards and cached in memory for the
// session. Persisting it would mean two sources of truth that drift apart the
// moment a build is interrupted, and rebuilding it is cheap: a few hundred
// shards of a few kilobytes each merge in single-digit milliseconds, far below
// the cost of the disk read that produced them. graphSync() hands React the
// cached merge without a promise, so a panel can paint its first frame from
// what the session already knows and only await when it truly has nothing.
//
// Outside Tauri — the vite dev pane, opened as ?test= in a plain browser —
// there is no filesystem plugin, so shards fall back to localStorage under
// «pdfer:graph:<key>», exactly as booktranslate.ts does for translations. The
// engine and the query layer stay testable without the webview.
//
// Everything exported here is defensive by construction. A shard half-written
// by a build that was killed mid-flight, or written by a future version, is
// skipped with a console warning; it never throws out of listShards() and it
// never takes the merged view down with it. The reader's library is the one
// thing this module is not allowed to break.

import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readDir, readFile, remove, rename, stat, writeFile } from "@tauri-apps/plugin-fs";
import { bookKey } from "./bookid";
import { baseName, joinPath } from "./host";
import { t } from "./i18n";

// ---- shard shape ------------------------------------------------------------

export type Provenance = "book" | "article" | "unknown";
export type NodeKind = "book" | "person" | "org" | "place" | "work" | "topic" | "term";
export type EdgeRel = "mentions" | "by" | "shares";

export type GraphNode = {
  // "b:<contentKey>" for a book; for everything else "n:" + the identity key of
  // the label — conceptId(label) for a term or a topic, normId(label) for a
  // person, an organisation, a place or a work. See the two functions below for
  // why names are not folded the way subjects are.
  id: string;
  kind: NodeKind;
  label: string; // display form
  gloss?: string; // one line, from the model; concepts only
  books: string[]; // contentKeys that carry this node
  weight: number; // book: page count/100 capped; concept: summed term frequency
  path?: string; // books only, absolute path
  prov?: Provenance; // books only
  pages?: Record<string, number[]>; // concepts only: contentKey -> 1-based page numbers, max 8 each
};

export type GraphEdge = { a: string; b: string; rel: EdgeRel; weight: number };

export type Shard = {
  version: 1;
  // Which extractor wrote this shard — graphgen.GRAPH_GEN at the time of the
  // write. It is NOT `version` and must never be confused with it: `version`
  // decides whether the file can be parsed at all, this decides only whether
  // the book is worth reading again. A shard below the current generation is
  // read, drawn, searched and used by «Спросить» exactly like any other; the
  // library's catch-up scan merely queues the book, and the shard is replaced
  // only when the new read has written. Shards written before this field
  // existed carry no `gen` and parseShard counts them as generation 1.
  gen: number;
  key: string; // contentKey from src/bookid.ts
  bookPath: string;
  title: string;
  authors: string[];
  year: number | null;
  prov: Provenance;
  provFixed: boolean; // true once the reader overrode the verdict by hand
  evidence: string[]; // human-readable reasons the classifier gave
  stage: "seed" | "deep";
  engine: "none" | "local" | "claude";
  tags: string[];
  summary: string;
  pages: number;
  nodes: GraphNode[]; // concept nodes this book contributes (never the book node)
  edges: GraphEdge[]; // edges originating in this book (book->concept, book->author)
  updated: number; // Date.now() of the last write
};

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; books: number; concepts: number };

// ---- identity keys ----------------------------------------------------------

/// The typographic key, and the identity of every NAME in the graph. Two books
/// that both credit «Baeza-Yates» must land on ONE person node, and this
/// function is what decides they do.
///
/// It folds exactly four kinds of noise, all of them typography rather than
/// meaning: compatibility forms (NFKC, so a ligature or a full-width letter is
/// the same word), letter case, the Russian ё/е spelling variance (a book that
/// prints «её» and one that prints «ее» are not two subjects), and punctuation
/// plus whitespace runs (so "self-organisation", "self organisation" and a
/// non-breaking-hyphen spelling of either agree).
///
/// It touches no morphology at all. Names must not be stemmed: «John Williams»
/// and «John William» are two people, and a graph that welds them together is
/// wrong in a way nothing on screen would reveal. Subjects are a different
/// problem with a different answer — see conceptId.
export function normId(label: string): string {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е") // ё → е; Ё is already lowered by the line above
    .replace(/[^\p{L}\p{N}]+/gu, " ") // Latin, Cyrillic and digits survive; the rest is a separator
    .trim()
    .replace(/\s+/g, " ");
}

/// Latin-script tokens that end in -s without being plurals, or whose singular
/// is a different word. Checked before any suffix rule, because no suffix rule
/// can tell «statistics» from «systems» and the two families need opposite
/// answers. The -ics group is here because «statistics»/«statistic» and
/// «politics»/«politic» really are different words; the rest are singulars and
/// plural-only nouns that the structural guards in foldToken do not catch.
const INVARIANT = new Set([
  "physics", "mathematics", "statistics", "economics", "ethics", "politics", "semantics",
  "linguistics", "informatics", "cybernetics", "aesthetics", "acoustics", "optics", "logistics",
  "bias", "alias", "atlas", "canvas", "gas", "lens", "news", "means", "series", "species",
  "data", "media", "criteria", "phenomena", "headquarters", "glasses", "scissors",
]);

const CYRILLIC = /\p{Script=Cyrillic}/u;

/// Singularise ONE Latin token: dictionary-free, deterministic and idempotent.
///
/// Idempotence is a hard requirement, not a nicety: parseShard folds the ids of
/// shards it reads, and a shard written by a current build already carries
/// folded ids, so this function is routinely applied to its own output. If
/// «analyses» folded to «analys» and then again to «analy», the same word would
/// end up with two different ids depending on how many builds had touched it —
/// exactly the split this whole fold exists to close.
function foldToken(w: string): string {
  if (!w || CYRILLIC.test(w)) return w; // rule C1, see conceptId
  if (!/s$/.test(w)) return w;
  if (INVARIANT.has(w)) return w;
  if (w.length <= 3) return w; // its, abs, ads, gas, bus
  if (/(?:ss|us|is|os)$/.test(w)) return w; // class, corpus, analysis, chaos
  if (/[^aeiou]ies$/.test(w) && w.length >= 5) return `${w.slice(0, -3)}y`; // queries -> query
  if (/(?:sh|ch|x|z|s)es$/.test(w)) {
    // matches -> match, boxes -> box, classes -> class. The s-before-es case
    // needs a second look: «biases» really does cut back to «bias», but
    // «phases» would cut to «phas», which the fallback below would cut again to
    // «pha». A two-character cut is therefore only taken when it lands on a
    // token this function would leave alone; when it does not, the word is a
    // «-se» plural and only the final s comes off. The recursion terminates
    // because it is called on a strictly shorter string.
    const cut = w.slice(0, -2);
    if (foldToken(cut) === cut) return cut;
    return w.slice(0, -1); // phases -> phase, responses -> response
  }
  return w.slice(0, -1); // systems -> system
}

/// The CONCEPT key: normId plus a plural fold on the head (last) token. A
/// concept node's id is "n:" + conceptId(label), so anything this folds
/// together is one node across the whole library.
///
/// The measurement that forced it: the reader's graph of one 838-page book
/// carried «IR systems» (counted 6 times) and «IR system» (counted 4) as two
/// separate nodes out of nine, and the same book's 118-term glossary yields 118
/// distinct normIds but 111 conceptIds — seven merges, every one of them
/// genuine («recommender systems»/«recommender system», «knowledge graph»/
/// «knowledge graphs», «query»/«queries», «document»/«documents», …), none of
/// them wrong. Splitting a concept in two does not merely look untidy: the two
/// halves each carry half the frequency, so both can fall below the mining
/// floor and vanish, and neither half's page list is complete.
///
/// Only the head token is folded, so «item ratings» becomes «item rating»
/// without disturbing the modifier. The question this raises — how do you tell
/// «Neural Networks» from «item ratings» — has a comfortable answer: you do not
/// have to. The id is NEVER displayed. mergeShards picks the label by vote from
/// the surface forms the books actually printed, so a mangled key such as
/// «united state» or «baeza yate» still shows as "United States" or
/// "Baeza-Yates". The only failure that can hurt is a COLLISION — two different
/// concepts landing on one key — and the three guards in foldToken (INVARIANT,
/// the ss/us/is/os suffix block, the length floor) exist solely to close the
/// handful of families where the fold does collide: statistics/statistic,
/// ethics/ethic, politics/politic, means/mean, bias/bia.
///
/// RULE C1 — Cyrillic is never folded, and this is not timidity. Russian fuses
/// number with case, so any ending-strip is simultaneously a case-strip, and
/// case-strips collide at a rate English never approaches: «полка» (shelf) onto
/// «полк» (regiment), «банка» (jar) onto «банк» (bank), «поля» (fields) onto
/// «пол» (floor), «стали» (steels) onto a verb, «мыло» (soap) onto «мыл»
/// (washed). Even a correct strip is ambiguous — «системы» is nominative plural
/// AND genitive singular, so there is no ending whose removal means "plural"
/// rather than "case". English has exactly one such ending, word-final -s in a
/// fixed position; that asymmetry is why the fold is monolingual. The cost is
/// accepted and named: a Russian library keeps «нейронная сеть» and «нейронные
/// сети» as two nodes, bridged only by the shares-edge similarity below, until
/// this app ships a lemma dictionary.
///
/// NOT for names. Person, organisation, place and work nodes keep normId, or
/// «John Williams» and «John William» would become one person.
export function conceptId(label: string): string {
  const id = normId(label);
  if (!id) return id;
  // «author's» normalises to «author s»: a bare one-letter «s» is a stripped
  // genitive, never a word, and letting it be the head token would mean folding
  // the genitive marker instead of the noun it hangs off.
  const toks = id.split(" ").filter((w, _i, a) => w !== "s" || a.length === 1);
  if (!toks.length) return id;
  toks[toks.length - 1] = foldToken(toks[toks.length - 1]);
  return toks.join(" ");
}

// The node kinds whose id is conceptId(label) rather than normId(label). Every
// place that rebuilds or matches an id has to make the same distinction, so the
// set lives here rather than being spelled out three times.
const FOLDED_KINDS = new Set<NodeKind>(["term", "topic"]);

// A shard key becomes a file name directly under the app data directory. A key
// carrying a separator or a dot-dot would write outside the graph folder, so a
// malformed one is refused rather than quietly sanitised — renaming a shard
// would orphan it from the book it describes, which is worse than not writing.
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;
const isSafeKey = (key: string): boolean => SAFE_KEY.test(key) && key !== "." && key !== "..";

// ---- shard storage ----------------------------------------------------------

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const LS_PREFIX = "pdfer:graph:";
const lsKey = (key: string): string => `${LS_PREFIX}${key}`;
// Neighbours under the same localStorage prefix that are NOT shards. Both of
// the build queue's switches live here — «pdfer:graph:auto» and
// «pdfer:graph:claude» (graphrun.ts) — and the dev pane's shard scan must not
// try to read either as a book. Getting this set short is not a cosmetic
// mistake: lsShardNames feeds clearGraph, so a switch missing from it is a
// preference that «Перестроить весь граф» silently deletes. Add the suffix
// here whenever a new «pdfer:graph:*» key is frozen.
const LS_NOT_SHARDS = new Set(["auto", "claude"]);

let dirP: Promise<string> | null = null;

/// Where shards live: <appDataDir>\graph. Resolved once per session.
export function shardsDir(): Promise<string> {
  return (dirP ??= appDataDir().then((d) => joinPath(d, "graph")));
}

const shardFile = async (key: string): Promise<string> => joinPath(await shardsDir(), `${key}.json`);

// Torn-write-proof persistence, copied from booktranslate.ts for the same
// reason: the JSON lands in a sibling .tmp and replaces the shard in one
// rename (std::fs::rename overwrites on Windows), so a crash mid-write leaves
// the previous complete shard rather than a truncated one the next listing
// would have to throw away.
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

async function readTextFile(path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await readFile(path));
  } catch {
    return null;
  }
}

// ---- shard validation -------------------------------------------------------

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const KINDS = new Set<string>(["book", "person", "org", "place", "work", "topic", "term"]);
const RELS = new Set<string>(["mentions", "by", "shares"]);
const PROVS = new Set<string>(["book", "article", "unknown"]);

const MAX_PAGES_PER_BOOK = 8; // the schema's own cap, re-applied on read and on merge

function cleanPages(v: unknown): Record<string, number[]> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, number[]> = {};
  for (const [key, list] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const ps = [...new Set(list.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 1))]
      .sort((a, b) => a - b)
      .slice(0, MAX_PAGES_PER_BOOK);
    if (ps.length) out[key] = ps;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanNode(v: unknown): GraphNode | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const id = str(r.id);
  const label = str(r.label);
  if (!id || !label) return null;
  const kind = KINDS.has(str(r.kind)) ? (r.kind as NodeKind) : "topic";
  const node: GraphNode = { id, kind, label, books: strs(r.books), weight: Math.max(0, num(r.weight, 1)) };
  const gloss = str(r.gloss).trim();
  if (gloss) node.gloss = gloss;
  const path = str(r.path);
  if (path) node.path = path;
  if (PROVS.has(str(r.prov))) node.prov = r.prov as Provenance;
  const pages = cleanPages(r.pages);
  if (pages) node.pages = pages;
  return node;
}

function cleanEdge(v: unknown): GraphEdge | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const a = str(r.a);
  const b = str(r.b);
  if (!a || !b || a === b || !RELS.has(str(r.rel))) return null;
  return { a, b, rel: r.rel as EdgeRel, weight: Math.max(0, num(r.weight, 1)) };
}

// Shards written before concept ids folded plurals carry «n:ir systems» where
// today's build writes «n:ir system», and the two would sit in the merged graph
// as two nodes for ever. Healing them HERE, on the way in, was chosen over a
// version bump: a bump would make every shard in the library unreadable and the
// reader would have to rebuild the whole graph — minutes of local model per
// book — merely to get deduplication. This costs one string operation per node,
// touches nothing on disk, and the folded ids are persisted only if some later
// build rewrites that shard anyway. A shard whose ids are already folded comes
// through unchanged, because conceptId is idempotent.
//
// The fold has to happen where the NODES are, not inside cleanEdge: an edge
// endpoint is a bare id string with no kind attached, and folding «n:john
// williams» because some other endpoint was a term would leave the «by» edge
// pointing at a node that does not exist. mergeShards drops dangling edges, so
// the book would silently lose its author.
function healIds(nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[] {
  const remap = new Map<string, string>();
  for (const n of nodes) {
    if (!n.id.startsWith("n:") || !FOLDED_KINDS.has(n.kind)) continue;
    // The id is normId(label) by construction and conceptId re-normalises, so
    // folding the id rather than the label keeps a hand-edited or future shard
    // on the identity it actually stored.
    const folded = `n:${conceptId(n.id.slice(2))}`;
    if (folded === n.id) continue;
    remap.set(n.id, folded);
    n.id = folded;
  }
  if (!remap.size) return edges;
  const out: GraphEdge[] = [];
  for (const e of edges) {
    const a = remap.get(e.a) ?? e.a;
    const b = remap.get(e.b) ?? e.b;
    // Two concepts that just folded together can carry a co-occurrence edge
    // between them, which is now a self-loop; forcelayout would pull the node
    // into itself for ever.
    if (a === b) continue;
    out.push({ ...e, a, b });
  }
  return out;
}

// A shard is only ever as trustworthy as the build that wrote it, and builds
// get killed by the reader closing the app mid-page. Nothing here throws: an
// unreadable shard is one book missing from the graph, which a rebuild fixes,
// whereas a throw would take the whole library's merged view down with it.
// `whence` names the file (or the localStorage key) in the warning, so the
// offender can actually be found and deleted.
function parseShard(json: string, whence: string): Shard | null {
  if (!json.trim()) return null; // a shard truncated instead of deleted — absent, not corrupt
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    console.warn(`graph: shard ${whence} is not valid JSON, skipping`, e);
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) {
    // written by a newer build: skipping is honest, guessing at the shape is not
    if (r.version !== undefined) console.warn(`graph: shard ${whence} has version ${String(r.version)}, skipping`);
    return null;
  }
  const key = str(r.key);
  const bookPath = str(r.bookPath);
  if (!key || !bookPath) {
    console.warn(`graph: shard ${whence} names no book, skipping`);
    return null;
  }
  const nodes = Array.isArray(r.nodes) ? r.nodes.map(cleanNode).filter((n): n is GraphNode => n !== null) : [];
  const edges = Array.isArray(r.edges) ? r.edges.map(cleanEdge).filter((e): e is GraphEdge => e !== null) : [];
  return {
    version: 1,
    // A missing generation is generation 1, not a reason to reject: every shard
    // written before the field existed came off the old extractor, and refusing
    // them here would empty the graph of exactly the readers this change is for.
    // Floored at 1 so a hand-edited 0 or a negative cannot make a shard look
    // permanently stale and re-enqueue the book on every single scan.
    gen: Math.max(1, Math.floor(num(r.gen, 1))),
    key,
    bookPath,
    title: str(r.title),
    authors: strs(r.authors),
    year: typeof r.year === "number" && Number.isFinite(r.year) ? r.year : null,
    prov: PROVS.has(str(r.prov)) ? (r.prov as Provenance) : "unknown",
    provFixed: r.provFixed === true,
    evidence: strs(r.evidence),
    stage: r.stage === "deep" ? "deep" : "seed",
    engine: r.engine === "local" || r.engine === "claude" ? r.engine : "none",
    tags: strs(r.tags),
    summary: str(r.summary),
    pages: Math.max(0, num(r.pages, 0)),
    nodes,
    edges: healIds(nodes, edges), // mutates node ids in place, then repoints the edges
    updated: num(r.updated, 0),
  };
}

// ---- shard read/write -------------------------------------------------------

/// One book's shard, or null when it was never built (or cannot be read).
export async function loadShard(key: string): Promise<Shard | null> {
  const cached = cache?.byKey.get(key);
  if (cached) return cached;
  if (!IS_TAURI) {
    const json = localStorage.getItem(lsKey(key));
    return json === null ? null : parseShard(json, lsKey(key));
  }
  if (!isSafeKey(key)) return null;
  const file = await shardFile(key);
  const json = await readTextFile(file);
  return json === null ? null : parseShard(json, file);
}

/// Persist one book's contribution. Stamps `updated` on a copy (the caller's
/// object is never mutated), refreshes the session cache and drops the merged
/// view, so every subscriber repaints from the new data.
export async function writeShard(s: Shard): Promise<void> {
  const shard: Shard = { ...s, version: 1, updated: Date.now() };
  const json = JSON.stringify(shard);
  if (!IS_TAURI) {
    try {
      localStorage.setItem(lsKey(shard.key), json);
    } catch (e) {
      // quota — the dev pane still keeps this shard for the session, in the cache below
      console.warn("graph: shard did not fit localStorage", e);
    }
  } else {
    if (!isSafeKey(shard.key)) throw new Error(`graph: refusing to write a shard named «${shard.key}»`);
    await mkdir(await shardsDir(), { recursive: true }).catch(() => {});
    await atomicWrite(await shardFile(shard.key), new TextEncoder().encode(json));
  }
  await remember(shard);
  bump();
}

/// Forget one book's contribution entirely.
export async function deleteShard(key: string): Promise<void> {
  if (!IS_TAURI) {
    localStorage.removeItem(lsKey(key));
  } else if (isSafeKey(key)) {
    const file = await shardFile(key);
    try {
      await remove(file);
    } catch {
      // file locked — an empty shard reads as absent, which invalidates it just as well
      await writeFile(file, new Uint8Array()).catch(() => {});
    }
  }
  await forget(key);
  bump();
}

/// Drop the shard that describes this book file. Used when the reader removes
/// a book from the library — the graph must not keep pointing at a book that
/// is no longer there.
export async function forgetPath(bookPath: string): Promise<void> {
  const s = (await listShards()).find((x) => x.bookPath === bookPath);
  if (s) await deleteShard(s.key);
}

// ---- session cache ----------------------------------------------------------
//
// One read of the shard directory per session. Writes patch the cache in place
// rather than dropping it, and the reason is provFor: it is a SYNCHRONOUS read
// that library cards make while they render, and a cache that emptied itself
// on every write would make every card in a freshly-built library blink
// through «unknown» for as long as the build queue ran. The MERGED view is
// dropped on every write — it is derived, and re-deriving it is cheap.

type Cache = { byKey: Map<string, Shard>; byPath: Map<string, Shard> };

let cache: Cache | null = null;
let cacheP: Promise<Cache> | null = null;
let merged: Graph | null = null;

const listeners = new Set<() => void>();

/// Fires after any shard write or delete. Returns the unsubscribe function.
export function onGraphChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function bump(): void {
  merged = null;
  // A throwing subscriber must not abort the notification of the others, nor
  // reject the write that triggered it: the shard is already on disk, and a
  // rejected writeShard would make a build think the page failed and retry it.
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.warn("graph: change listener failed", e);
    }
  }
}

function reindex(c: Cache): Cache {
  c.byPath.clear();
  for (const s of c.byKey.values()) c.byPath.set(s.bookPath, s);
  return c;
}

// A write that lands while the first listing is still in flight would be
// overwritten by that listing's result, so it waits for the listing first.
async function remember(s: Shard): Promise<void> {
  if (cacheP) await cacheP.catch(() => {});
  if (!cache) return; // nothing listed yet — the first listShards() will read it off disk
  cache.byKey.set(s.key, s);
  reindex(cache);
}

async function forget(key: string): Promise<void> {
  if (cacheP) await cacheP.catch(() => {});
  if (!cache) return;
  cache.byKey.delete(key);
  reindex(cache);
}

function lsShardNames(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i);
    if (name === null || !name.startsWith(LS_PREFIX)) continue;
    if (LS_NOT_SHARDS.has(name.slice(LS_PREFIX.length))) continue;
    out.push(name);
  }
  return out;
}

async function readAllShards(): Promise<Cache> {
  const byKey = new Map<string, Shard>();
  if (!IS_TAURI) {
    for (const name of lsShardNames()) {
      const json = localStorage.getItem(name);
      if (json === null) continue;
      const s = parseShard(json, name);
      if (s) byKey.set(s.key, s);
    }
    return reindex({ byKey, byPath: new Map() });
  }
  const dir = await shardsDir();
  // a library that was never graphed has no directory at all — not an error
  const entries = await readDir(dir).catch(() => []);
  const names = entries.filter((e) => e.isFile && e.name.endsWith(".json")).map((e) => e.name);
  const read = await Promise.all(
    names.map(async (name) => {
      const file = joinPath(dir, name);
      const json = await readTextFile(file);
      return json === null ? null : parseShard(json, file);
    }),
  );
  for (const s of read) if (s) byKey.set(s.key, s);
  return reindex({ byKey, byPath: new Map() });
}

function loadAll(): Promise<Cache> {
  return (cacheP ??= readAllShards().then(
    (c) => {
      cache = c;
      cacheP = null;
      return c;
    },
    (e) => {
      // The directory read itself failed (permissions, a profile on a drive
      // that went away). An empty graph is the honest answer, and it is not
      // sticky: the next write re-reads, because a failed listing still
      // installs a cache the write can patch.
      console.warn("graph: shard directory could not be listed", e);
      cacheP = null;
      const c = reindex({ byKey: new Map(), byPath: new Map() });
      cache = c;
      return c;
    },
  ));
}

/// Every shard in the library. Session-cached; a corrupt shard is skipped with
/// a warning rather than failing the listing.
export async function listShards(): Promise<Shard[]> {
  const c = cache ?? (await loadAll());
  return [...c.byKey.values()];
}

/// The shard for an open book. Tries the durable content key first (bookid.ts
/// caches it for every book the session has opened), which reads exactly one
/// file instead of the whole directory. A shard found by content key belongs
/// to this book even if its stored bookPath is stale — the key is the identity,
/// the path only a convenience.
export async function shardFor(bookPath: string): Promise<Shard | null> {
  const hit = cache?.byPath.get(bookPath);
  if (hit) return hit;
  const key = bookKey(bookPath);
  if (key !== null) {
    const s = await loadShard(key);
    if (s) return s;
  }
  return (await listShards()).find((s) => s.bookPath === bookPath) ?? null;
}

/// Synchronous verdict for a library card. Null means «not listed yet», which
/// is not the same as «unknown»: the card should show nothing at all until the
/// first listing lands, rather than assert a classification nobody made.
export function provFor(bookPath: string): Provenance | null {
  return cache?.byPath.get(bookPath)?.prov ?? null;
}

/// The reader overrules the classifier by hand. `provFixed` is what stops any
/// later build from arguing back.
export async function setProvenance(key: string, prov: Provenance): Promise<void> {
  const s = await loadShard(key);
  if (!s) return;
  await writeShard({ ...s, prov, provFixed: true });
}

// ---- the merged graph -------------------------------------------------------

// Legibility budget, not a truth claim. Every number below trades recall for a
// picture a person can actually read, and all of them were chosen against the
// drawing rather than against any notion of correctness:
//   BOOK_WEIGHT_CAP — a book node's radius comes from its weight, so a
//     1200-page reference work would otherwise be drawn as a planet with the
//     novels in orbit around it; 6 flattens everything past 600 pages.
//   SHARE_TOP — similarity is computed over each book's 30 heaviest concepts.
//     The long tail of a book's concept list is mostly incidental proper nouns
//     that co-occur by accident, and including it makes every pair of books in
//     the library look faintly related.
//   SHARE_FLOOR — below 0.06 Jaccard (roughly two shared concepts out of
//     30 + 30) the pair carries nothing a reader would recognise as a link.
//   SHARE_DEGREE — even above the floor, one anthology can resemble forty
//     books at once and smother the layout; 6 keeps a hub legible AS a hub
//     without letting it own the canvas.
const BOOK_WEIGHT_CAP = 6;
const SHARE_TOP = 30;
const SHARE_FLOOR = 0.06;
const SHARE_DEGREE = 6;
// A concept carried by this many books is furniture («introduction», «theory»)
// and pairing every carrier with every other costs n² for no signal at all.
const SHARE_UBIQUITOUS = 120;

// «shares» is symmetric, so its two orientations must collapse onto one key;
// «mentions» and «by» both run book → concept and keep their direction.
const edgeKey = (e: GraphEdge): string =>
  e.rel === "shares" && e.a > e.b ? `${e.rel}\u0000${e.b}\u0000${e.a}` : `${e.rel}\u0000${e.a}\u0000${e.b}`;

function mergeShards(shards: Shard[]): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  // Display-form vote per concept: books spell the same id with different
  // capitalisation, different hyphenation and — since conceptId folds plurals —
  // different number, and the spelling to show is the one the reader has
  // actually met most often. Occurrences are tallied alongside the votes for
  // the tie-break; see the count below for why they are only the tie-break.
  const spellings = new Map<string, Map<string, { books: number; weight: number }>>();

  const addEdge = (e: GraphEdge): void => {
    const k = edgeKey(e);
    const prev = edges.get(k);
    if (prev) prev.weight += e.weight;
    else edges.set(k, { ...e });
  };

  // One book node per shard, synthesised here rather than stored. The shard
  // already carries every field the node needs, and a stored copy would go
  // stale the moment the reader re-classified the book or moved the file.
  for (const s of shards) {
    nodes.set(`b:${s.key}`, {
      id: `b:${s.key}`,
      kind: "book",
      label: s.title.trim() || baseName(s.bookPath),
      books: [s.key],
      weight: Math.max(0.5, Math.min(BOOK_WEIGHT_CAP, s.pages / 100)),
      path: s.bookPath,
      prov: s.prov,
    });
  }

  for (const s of shards) {
    for (const n of s.nodes) {
      // Shards are documented never to carry their own book node; a build that
      // wrote one anyway must not shadow the synthesised one above.
      if (n.kind === "book" || n.id.startsWith("b:")) continue;
      const votes = spellings.get(n.id) ?? new Map<string, { books: number; weight: number }>();
      const vote = votes.get(n.label) ?? { books: 0, weight: 0 };
      vote.books += 1;
      vote.weight += n.weight;
      votes.set(n.label, vote);
      spellings.set(n.id, votes);

      const cur = nodes.get(n.id);
      if (!cur) {
        // a fresh copy: shard objects stay in the session cache and must not
        // acquire other books' pages when the merge runs again
        nodes.set(n.id, {
          ...n,
          books: [...new Set(n.books.length ? n.books : [s.key])],
          pages: n.pages ? { ...n.pages } : undefined,
        });
        continue;
      }
      cur.weight += n.weight;
      for (const b of n.books.length ? n.books : [s.key]) if (!cur.books.includes(b)) cur.books.push(b);
      // The longest gloss wins: a one-word gloss is almost always a truncated
      // model answer, and length is the only signal available without asking
      // the model again.
      const gloss = n.gloss?.trim() ?? "";
      if (gloss.length > (cur.gloss?.trim().length ?? 0)) cur.gloss = gloss;
      if (n.pages) {
        cur.pages ??= {};
        for (const [key, ps] of Object.entries(n.pages)) {
          const all = [...new Set([...(cur.pages[key] ?? []), ...ps])].sort((a, b) => a - b);
          cur.pages[key] = all.slice(0, MAX_PAGES_PER_BOOK);
        }
      }
    }
    for (const e of s.edges) addEdge(e);
  }

  for (const [id, votes] of spellings) {
    const node = nodes.get(id);
    if (!node) continue;
    // Most books first — one vote per book, never one per occurrence, or a
    // single 900-page volume would dictate the spelling of every concept in the
    // library. Summed occurrences break the tie, and that is what decides the
    // case the plural fold created: a book that prints «IR systems» 6 times and
    // «IR system» 4 times now contributes both spellings to ONE id, one vote
    // each, so without the occurrence count the winner would be whichever form
    // the miner happened to emit first — the two would fight, and the answer
    // would change between builds. Length and then alphabetical order settle
    // the remainder, so the picture is stable from session to session.
    let best = node.label;
    let bestBooks = -1;
    let bestWeight = -1;
    for (const [label, v] of votes) {
      const better =
        v.books > bestBooks ||
        (v.books === bestBooks &&
          (v.weight > bestWeight ||
            (v.weight === bestWeight &&
              (label.length > best.length || (label.length === best.length && label < best)))));
      if (better) {
        best = label;
        bestBooks = v.books;
        bestWeight = v.weight;
      }
    }
    node.label = best;
  }

  addShareEdges(shards, addEdge);

  // A half-written shard can name a node it never got round to writing, and an
  // edge into nothing crashes the layout — so it is dropped here rather than
  // defended against in forcelayout.
  const kept = [...edges.values()].filter((e) => nodes.has(e.a) && nodes.has(e.b));
  const all = [...nodes.values()];
  const books = all.filter((n) => n.kind === "book").length;
  return { nodes: all, edges: kept, books, concepts: all.length - books };
}

// Derived book-to-book similarity: Jaccard over each book's heaviest concepts.
// Built from an inverted index (concept -> the books whose top list carries it)
// so that only books which actually share something are ever compared —
// comparing every pair directly is quadratic in a library that only grows.
function addShareEdges(shards: Shard[], addEdge: (e: GraphEdge) => void): void {
  const tops = new Map<string, Set<string>>();
  for (const s of shards) {
    // Summed per id, not per node. A shard written before concept ids folded
    // plurals carries «IR systems» and «IR system» as two entries that healIds
    // has just given one id: ranking them separately would spend two of the
    // thirty slots on one concept and rank it by half its true weight, so the
    // similarity between two books that share it would be understated.
    const byId = new Map<string, number>();
    for (const n of s.nodes) {
      if (n.kind === "book" || n.id.startsWith("b:")) continue;
      byId.set(n.id, (byId.get(n.id) ?? 0) + n.weight);
    }
    const top = [...byId].sort((a, b) => b[1] - a[1]).slice(0, SHARE_TOP);
    if (top.length) tops.set(s.key, new Set(top.map(([id]) => id)));
  }

  const carriers = new Map<string, string[]>();
  for (const [key, ids] of tops) {
    for (const id of ids) {
      const list = carriers.get(id);
      if (list) list.push(key);
      else carriers.set(id, [key]);
    }
  }

  const shared = new Map<string, number>();
  for (const keys of carriers.values()) {
    if (keys.length < 2 || keys.length > SHARE_UBIQUITOUS) continue;
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const k = keys[i] < keys[j] ? `${keys[i]}\u0000${keys[j]}` : `${keys[j]}\u0000${keys[i]}`;
        shared.set(k, (shared.get(k) ?? 0) + 1);
      }
    }
  }

  const cand: { a: string; b: string; sim: number }[] = [];
  for (const [k, n] of shared) {
    const [a, b] = k.split("\u0000");
    const union = (tops.get(a)?.size ?? 0) + (tops.get(b)?.size ?? 0) - n;
    const sim = union > 0 ? n / union : 0;
    if (sim >= SHARE_FLOOR) cand.push({ a, b, sim });
  }
  // Strongest first, so the degree cap keeps each book's BEST neighbours rather
  // than whichever ones the iteration order happened to reach first.
  cand.sort((x, y) => y.sim - x.sim);

  const degree = new Map<string, number>();
  for (const c of cand) {
    if ((degree.get(c.a) ?? 0) >= SHARE_DEGREE || (degree.get(c.b) ?? 0) >= SHARE_DEGREE) continue;
    degree.set(c.a, (degree.get(c.a) ?? 0) + 1);
    degree.set(c.b, (degree.get(c.b) ?? 0) + 1);
    addEdge({ a: `b:${c.a}`, b: `b:${c.b}`, rel: "shares", weight: Math.round(c.sim * 1000) / 1000 });
  }
}

/// The whole library as one graph. Session-cached; the cache is dropped by any
/// shard write or delete.
export async function graph(): Promise<Graph> {
  if (merged) return merged;
  merged = mergeShards(await listShards());
  return merged;
}

/// The cached merge, or null when this session has not built one yet. No IO and
/// no promise — it exists so a React panel can paint its first frame from what
/// is already known and only fall back to `graph()` when there is nothing.
export function graphSync(): Graph | null {
  return merged;
}

// ---- lookup for the in-book assistant ---------------------------------------

// Words that carry no subject at all. Both languages live in one set because a
// question routinely mixes them («что такое spiral dynamics»), and splitting
// the set by alphabet would only mean consulting it twice. The last group is
// question furniture rather than grammar — «объясни», "explain", «страница» —
// which scores concepts no better than «и» would.
const STOP = new Set(
  `а без более больше будет будто бы был была были было быть в вам вас ведь весь во вот все всего всех вы где
  да даже для до его ее ей ему если есть еще же за здесь и из или им их к как какой когда кто ли либо мне
  много может мои мой мы на надо наш не него нее нет ни них но ну о об однако он она они оно от очень по под
  после при про раз разве с сам свое свою себе себя сейчас со так такой там те тем то тогда того тоже только
  том тот ты у уже чего чем через что чтобы чуть эта эти это этой этом этот я
  такое значит объясни объясните расскажи расскажите скажи книга книге книги глава странице страница
  a about above after again against all also am an and any are as at be because been before being below
  between both but by can cannot could did do does doing done down during each few for from further had has
  have having he her here hers him his how i if in into is it its just may me might more most much must my
  never no nor not now of off on once only or other others our out over own same she should so some such than
  that the their them then there these they this those through to too under until up upon us very was we were
  what when where which while who whom whose why will with would you your
  mean means meaning explain tell book page pages chapter author`
    .split(/\s+/)
    .filter(Boolean),
);

const BLOCK_LIMIT = 1400; // characters; the block is injected into a prompt, never shown as UI
const MAX_CONCEPTS = 8;
const MAX_BOOKS_PER_CONCEPT = 3;
const MAX_PAGES_SHOWN = 5;
const MAX_NEARBY = 3;
const SCORE_FLOOR = 0.35;
const NEARBY_BUDGET = 160; // characters held back so the «books nearby» line always fits

// Tiers of match strength, multiplied by log(weight). They are ranked, not
// tuned: an exact label is unambiguous, a verbatim phrase inside the question
// nearly so, a bare substring often a coincidence («art» inside «Bharti»), and
// token overlap the weakest evidence there is.
const HIT_EXACT = 3;
const HIT_PHRASE = 2.2;
const HIT_SUBSTRING = 1.6;
const MIN_SUBSTRING = 5; // shorter ids match inside unrelated words far too often

/// Content words of a question, each in both the form it was written in and its
/// singular. Both are kept because a concept id folds only its HEAD token: a
/// node id «systems engineering» keeps its plural inside the id and can only be
/// met by the written «systems», while «ir system» can only be met by the fold
/// of «systems». Neither form alone scores both nodes.
function queryTokens(s: string): string[] {
  const out: string[] = [];
  for (const w of normId(s).split(" ")) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.push(w);
    const folded = foldToken(w);
    if (folded !== w && folded.length >= 3) out.push(folded);
  }
  return out;
}

/// What the library already knows about this question, as a compact block the
/// in-book assistant pastes in front of its prompt — or null when the graph has
/// nothing worth saying, so the caller skips the injection entirely instead of
/// spending prompt budget on a heading with no content under it.
///
/// Pure in-memory after the first merge: no model, no disk, no network. It runs
/// on every question, before Claude is asked anything, so it has to cost
/// nothing a reader could feel.
export async function lookup(q: string, quote: string | null, bookPath: string | null): Promise<string | null> {
  const g = graphSync() ?? (await graph());
  if (!g.nodes.length) return null;

  const text = `${q} ${quote ?? ""}`;
  const normQ = normId(text);
  if (!normQ) return null;
  // The question in the shape a folded id has. A term or topic id is
  // conceptId(label) and a name's id is normId(label), so the question is
  // prepared both ways and each node is matched against the form its own kind
  // was built with — a reader asking about "IR systems" has to reach the node
  // whose id, and whose displayed label, may be "IR system". Every token is
  // folded here, not just the last one as conceptId does, because a node's id
  // can sit anywhere inside a sentence.
  const foldQ = normQ.split(" ").map(foldToken).join(" ");
  const asked = new Set(queryTokens(text));
  const padded = ` ${normQ} `;
  const paddedFold = ` ${foldQ} `;

  const open = bookPath === null ? null : (cache?.byPath.get(bookPath)?.key ?? bookKey(bookPath));

  const titles = new Map<string, GraphNode>();
  for (const n of g.nodes) if (n.kind === "book") titles.set(n.id.slice(2), n);

  const hits: { node: GraphNode; score: number }[] = [];
  for (const n of g.nodes) {
    if (n.kind === "book") continue;
    // The id is the label's identity key by construction, so no
    // re-normalisation is needed — but WHICH key depends on the kind, and so
    // does the form of the question that can match it. A term or topic is tried
    // against the folded question first and the written one second, because
    // conceptId folds only the head token and «systems engineering» keeps its
    // plural in the id; a name is only ever tried against the written question,
    // since normId never folded it.
    const nid = n.id.startsWith("n:") ? n.id.slice(2) : normId(n.label);
    if (!nid) continue;
    const forms: [string, string][] = FOLDED_KINDS.has(n.kind)
      ? [
          [foldQ, paddedFold],
          [normQ, padded],
        ]
      : [[normQ, padded]];

    let base = 0;
    for (const [q1, p1] of forms) {
      let hit = 0;
      if (nid === q1) hit = HIT_EXACT;
      else if (p1.includes(` ${nid} `)) hit = HIT_PHRASE;
      else if (nid.length >= MIN_SUBSTRING && (q1.includes(nid) || nid.includes(q1))) hit = HIT_SUBSTRING;
      if (hit > base) base = hit;
    }
    if (!base) {
      const parts = nid.split(" ").filter((w) => w.length >= 3 && !STOP.has(w));
      if (!parts.length) continue;
      let met = 0;
      for (const w of parts) if (asked.has(w)) met++;
      if (!met) continue;
      base = met / parts.length;
    }

    // Log, not the raw weight: a term counted 400 times in one book is not 400
    // times better evidence than one counted 4 times, and without the log a
    // single fat book would own every answer. log1p keeps a weight of 1 from
    // zeroing an otherwise perfect label match.
    let score = base * Math.log1p(Math.max(0, n.weight));
    // The reader can already see the book open in front of them, and the
    // assistant already has its text in the prompt. The graph earns its place
    // only by pointing somewhere ELSE in the library, so a concept that also
    // lives in another book outranks one confined to the open one.
    score *= open !== null && !n.books.some((b) => b !== open) ? 0.6 : 1.6;
    if (score >= SCORE_FLOOR) hits.push({ node: n, score });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score);

  const lines: string[] = [];
  for (const h of hits.slice(0, MAX_CONCEPTS)) {
    const n = h.node;
    // same reason as the score bonus above: cite the OTHER books first
    const keys = [...n.books]
      .sort((a, b) => Number(a === open) - Number(b === open))
      .slice(0, MAX_BOOKS_PER_CONCEPT);
    const where = keys.map((k) => {
      const title = `«${titles.get(k)?.label ?? k}»`;
      const ps = (n.pages?.[k] ?? []).slice(0, MAX_PAGES_SHOWN);
      // «с. 12, 40, 118» — one prefix for the whole run, which is how a page
      // reference is written in prose in both languages
      return ps.length ? `${title} (${t("gr.page", { n: ps.join(", ") })})` : title;
    });
    // What this block sends is an index entry: a concept label, the titles that
    // carry it and the pages it sits on. That is a POINTER — it says where to
    // look, the way the back of a book does — and it is the whole reason the
    // reader asked the assistant to consult their library.
    // The gloss is not a pointer. It is a sentence the local model wrote out of
    // one book's own text, describing what that book SAYS, so sending it ships
    // content out of a licensed book the reader has a licence only to read.
    // The line is therefore drawn between the pointer and the description, and
    // not between concepts: the label, the titles and the pages always go, and
    // only the gloss is held back. It is released when some carrier of the
    // concept is an open article — there is nothing to withhold — or is the
    // book already open in front of the reader, whose text the prompt carries
    // anyway, so the gloss reaches nowhere the answer did not already have.
    // The test runs over EVERY carrier, not just the three cited below, because
    // the merge keeps one winning gloss per concept and any carrier could have
    // written it. Do not "simplify" this back: dropping the concept outright
    // would gut the feature for a normal library, which is mostly books, and
    // sending the gloss unconditionally is exactly the leak this prevents.
    const describable = n.books.some((k) => k === open || titles.get(k)?.prov === "article");
    const gloss = describable ? (n.gloss?.trim().replace(/\s+/g, " ") ?? "") : "";
    const parts = [gloss ? `${n.label} — ${gloss}` : n.label];
    if (where.length) parts.push(`${t("gr.inBooks")}: ${where.join(", ")}`);
    lines.push(`• ${parts.join(". ")}.`);
  }

  const nearby: string[] = [];
  if (open !== null) {
    const id = `b:${open}`;
    const linked = g.edges
      .filter((e) => e.rel === "shares" && (e.a === id || e.b === id))
      .sort((a, b) => b.weight - a.weight);
    for (const e of linked) {
      if (nearby.length >= MAX_NEARBY) break;
      const other = titles.get((e.a === id ? e.b : e.a).slice(2));
      if (other) nearby.push(`«${other.label}»`);
    }
  }
  if (!nearby.length) {
    // No shares edge to lean on — a young library, or a question asked from
    // outside any book. Fall back to the books the matched concepts themselves
    // point at, most-cited first.
    const votes = new Map<string, number>();
    for (const h of hits.slice(0, MAX_CONCEPTS)) {
      for (const b of h.node.books) if (b !== open) votes.set(b, (votes.get(b) ?? 0) + 1);
    }
    for (const [key] of [...votes].sort((a, b) => b[1] - a[1]).slice(0, MAX_NEARBY)) {
      const bn = titles.get(key);
      if (bn) nearby.push(`«${bn.label}»`);
    }
  }

  // The block borrows the graph panel's own vocabulary — «Граф знаний»,
  // «В книгах», «Рядом», «с. N» — rather than carrying four catalogue entries
  // of its own. That is deliberate: the reader meets these words in the panel
  // and then meets the same words in the assistant's answer, and one spelling
  // per thing is what makes the two read as one feature. The surrounding
  // «Из вашей библиотеки» heading (ask.graphCtx) belongs to the caller, which
  // is what the ask.graph system rule tells the model to look for.
  const head = `${t("gr.title")}:`;
  let block = head;
  for (const line of lines) {
    if (block.length + line.length + 1 > BLOCK_LIMIT - NEARBY_BUDGET) break;
    block = `${block}\n${line}`;
  }
  if (block === head) return null; // the heading alone says nothing
  if (nearby.length) {
    const tail = `${t("gr.related")}: ${nearby.join(", ")}`;
    if (block.length + tail.length + 1 <= BLOCK_LIMIT) block = `${block}\n${tail}`;
  }
  return block;
}

// ---- housekeeping -----------------------------------------------------------

/// What the graph costs on disk, for the Settings panel. Sizes come from the
/// filesystem where it can answer; where it cannot (the dev pane, or a stat the
/// plugin refuses) the shard's own serialised byte length is the honest
/// estimate — it is exactly what was written.
export async function graphStats(): Promise<{ shards: number; bytes: number; concepts: number }> {
  const shards = await listShards();
  let bytes = 0;
  for (const s of shards) {
    let size: number | null = null;
    if (IS_TAURI && isSafeKey(s.key)) {
      const info = await stat(await shardFile(s.key)).catch(() => null);
      size = info === null ? null : info.size;
    }
    bytes += size ?? new TextEncoder().encode(JSON.stringify(s)).length;
  }
  return { shards: shards.length, bytes, concepts: (await graph()).concepts };
}

/// Throw the whole graph away. The directory itself stays — the next build
/// would only have to create it again.
export async function clearGraph(): Promise<void> {
  if (!IS_TAURI) {
    for (const name of lsShardNames()) localStorage.removeItem(name);
  } else {
    const dir = await shardsDir();
    const entries = await readDir(dir).catch(() => []);
    for (const e of entries) {
      // .tmp leftovers of an interrupted atomicWrite go too
      if (!e.isFile || !(e.name.endsWith(".json") || e.name.endsWith(".json.tmp"))) continue;
      await remove(joinPath(dir, e.name)).catch(() => {});
    }
  }
  // The same wait remember() and forget() do, and here for a sharper reason: a
  // listing that began before the files were removed resolves into `cache`
  // AFTER this function installs its empty one, and the stale shards it puts
  // back would make the build worker's shardFor() answer «already built» for
  // every book — «Перестроить» would wipe the disk and then rebuild nothing at
  // all, which is the one outcome that command must never produce. Dropping
  // cacheP instead of awaiting it was rejected: the promise is shared with
  // whoever called listShards(), and cancelling it would hand them an empty
  // graph for a library whose shards were still on disk.
  if (cacheP) await cacheP.catch(() => {});
  cache = reindex({ byKey: new Map(), byPath: new Map() });
  bump();
}
