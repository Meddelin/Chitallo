// Client for the local llama-server (TranslateGemma-12B-it) at 127.0.0.1:11544.
//
// WHY THIS MODULE WRITES THE PROMPT ITSELF, AND WHY /v1/chat/completions IS NOT
// USED ON 11544. TranslateGemma's embedded chat template does not read a plain
// string. It reads `source_lang_code` and `target_lang_code` off
// `message.content[0]` — extra keys the model's own harness puts on the content
// part. llama.cpp's OAI bridge (`common_chat_msgs_to_json_oaicompat`) keeps only
// `{type, text}` from a content part and discards everything else, so those two
// keys never reach the template; it then renders "English (en-GB) to English
// (en-GB)" for every language pair, or raises UndefinedError. Open and
// unresolved upstream: ggml-org/llama.cpp#19295. The route taken here is
// therefore POST /completion with the Gemma turn markers written out by hand in
// buildDraftPrompt, which is also the only route on which the glossary block and
// the two continuity blocks can exist at all — the embedded template has no slot
// for either, and those blocks are the whole reason the pronouns, tenses and the
// ты/вы form of address stop drifting between paragraphs.
//
// NO <bos>, EVER. llama-server tokenizes /completion with add_special=true, so
// the BOS token is prepended for us; a literal "<bos>" in the prompt text would
// be a second one, which Gemma-3 does notice. The turn markers
// (<start_of_turn>/<end_of_turn>) are NOT special-token-added by that path and
// must be written out, which is exactly the asymmetry that makes this easy to
// get wrong in one direction or the other.
//
// Streaming consequently reads /completion's SSE shape ({"content":…,
// "stop":false}) rather than the OAI delta shape. The aux client further down
// keeps speaking /v1/chat/completions, because 11545 runs Gemma-4-26B-A4B-it
// with an ordinary instruct template and nothing about it needs bypassing.

import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readFile, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
import { useCallback, useSyncExternalStore } from "react";
import { bookKey } from "./bookid";
import { BOOK_LANGS, UND } from "./booklang";
import { parseGlossaryText } from "./glossary";
import { joinPath } from "./host";
import { targetLanguage } from "./i18n";
import { hash } from "./paragraphs";
import { outDice, outNorm } from "./textsim";

// Dev/test hook: lets a plain-browser engine run point at a controlled port
// (e.g. a dead one, to exercise the outage path) without touching the real
// server. Read once at module load; dead code in production builds.
const DEV_BASE = import.meta.env.DEV ? localStorage.getItem("pdfer:dev:llamabase") : null;
const BASE = DEV_BASE || "http://127.0.0.1:11544";
const AUX_BASE = "http://127.0.0.1:11545"; // style editor + terminologist (Gemma-4-26B-A4B-it), on-demand
// The target language follows the interface language: someone reading Chitallo in
// Russian wants Russian pages. Both the English NAME and the BCP-47 CODE are
// needed, because the prompt below names the pair twice the way TranslateGemma's
// own template does — «Russian (ru)» — see i18n's TARGET_LANGUAGE. The Chinese
// spelling that used to live beside them went with the HY-MT templates.

export type GlossaryEntry = { src: string; dst: string };

// A server that cannot be reached is NOT a model answer. Connection-level
// fetch failures and gateway-ish statuses (502/504, and 503 — llama-server's
// "model still loading") become ModelUnavailableError so callers can wait out
// the outage and retry instead of accepting "" as a translation. Genuine HTTP
// errors (4xx, 500 — malformed request, prompt too long) stay plain Errors:
// retrying those forever would wedge a run on one paragraph.
export class ModelUnavailableError extends Error {
  constructor(detail: string) {
    super(`llama-server unavailable: ${detail}`);
    this.name = "ModelUnavailableError";
  }
}

const UNAVAILABLE_STATUS = new Set([502, 503, 504]);
const isAbortErr = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

async function healthOk(base: string, timeoutMs: number): Promise<boolean> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

export function isServerUp(timeoutMs = 1200): Promise<boolean> {
  return healthOk(BASE, timeoutMs);
}

export function isAuxUp(timeoutMs = 1200): Promise<boolean> {
  return healthOk(AUX_BASE, timeoutMs);
}

// ---- glossary storage (WP-M) ------------------------------------------------
// Files under <appDataDir>\glossaries\<key>.txt, one term per line, in the
// grammar glossary.ts owns and documents: `термин [= перевод] [:: категория
// [:: определение]]`. The last three slots are optional, so a bare term line is
// a valid record — the file is the book's TERM LIST, of which the translation
// pairs are one column. Bookkeeping the reader should not have to look at
// (pages, frequency, source, the graph's node kind) lives in a sidecar JSON
// beside the .txt, written by glossary.ts; this module only moves the text.
// Named by the same durable content key as translation stores (path-hash
// fallback until the book is bound) — a glossary survives the app profile,
// localStorage eviction, and the book file moving. Access goes through a
// session cache so the existing sync call sites keep working; hydrateGlossary
// is awaited at book open (App.loadBytes) and at run start (booktranslate)
// before any sync read matters. Entries written by earlier builds to
// localStorage ("pdfer:glossary:<bookPath>") migrate to files on first
// hydration. Plain-browser dev (?test=, no Tauri IPC) keeps the localStorage
// flavor so the popover stays testable outside the webview.

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const glossCache = new Map<string, string>();
let glossDirP: Promise<string> | null = null;
const glossDir = () => (glossDirP ??= appDataDir().then((d) => joinPath(d, "glossaries")));
const glossFile = async (bookPath: string, key = bookKey(bookPath) ?? hash(bookPath)) =>
  joinPath(await glossDir(), `${key}.txt`);
const glossLsKey = (bookPath: string) => `pdfer:glossary:${bookPath}`;

// Torn-write-proof persistence, the third copy of booktranslate.ts:169 (and
// graphstore.ts:257) rather than a fourth spelling of the same idea: the text
// lands in a sibling .tmp and replaces the glossary in one rename
// (std::fs::rename overwrites on Windows), so a crash or a full disk mid-write
// leaves the reader's previous complete list instead of a truncated one. This
// file matters more than either of the others: a shard or a translation store
// is a re-runnable derivative, while a glossary is hand-curated — the reader
// typed those lines, and half of them is work no pass can give back.
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

async function writeGlossFile(bookPath: string, text: string): Promise<void> {
  const file = await glossFile(bookPath);
  if (text.trim()) {
    await mkdir(await glossDir(), { recursive: true }).catch(() => {});
    await atomicWrite(file, new TextEncoder().encode(text));
  } else {
    await remove(file).catch(() => {});
    // ...and the .tmp an interrupted atomicWrite may have left beside it.
    // graphstore.ts:1124 sweeps its own leftovers when it prunes shards; nothing
    // sweeps this directory at all (Library.tsx:435 prunes shards and never term
    // files), so emptying a glossary is the only moment we get to clean up.
    await remove(`${file}.tmp`).catch(() => {});
  }
}

async function readGlossFile(bookPath: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await readFile(await glossFile(bookPath)));
  } catch {
    // a pre-binding session may have saved under the path hash — adopt silently
    if (bookKey(bookPath) === null || bookKey(bookPath) === hash(bookPath)) return null;
    try {
      const old = await glossFile(bookPath, hash(bookPath));
      const text = new TextDecoder().decode(await readFile(old));
      await writeGlossFile(bookPath, text);
      await remove(old).catch(() => {});
      return text;
    } catch {
      return null;
    }
  }
}

// Load the glossary into the session cache: appdata file first, else a
// one-time migration out of localStorage (removed there only after the file
// write succeeded — a failed migration loses nothing).
//
// Neither this nor readGlossFile's path-hash adoption notifies subscribers, and
// that is not an oversight: both move the SAME text to a new home. What a reader
// would get back is unchanged before and after (loadGlossaryText already answers
// out of the not-yet-migrated localStorage entry), so there is nothing for a
// subscriber to re-read. The notification below is strictly about a write that
// changed the terms.
export async function hydrateGlossary(bookPath: string): Promise<string> {
  if (!IS_TAURI) return loadGlossaryText(bookPath);
  const cached = glossCache.get(bookPath);
  if (cached !== undefined) return cached;
  let text = await readGlossFile(bookPath);
  if (text === null) {
    const legacy = localStorage.getItem(glossLsKey(bookPath));
    if (legacy !== null) {
      text = legacy;
      try {
        await writeGlossFile(bookPath, legacy);
        localStorage.removeItem(glossLsKey(bookPath));
      } catch (e) {
        console.error("glossary migration failed", e);
      }
    }
  }
  const out = text ?? "";
  glossCache.set(bookPath, out);
  return out;
}

export function loadGlossaryText(bookPath: string): string {
  if (!IS_TAURI) return localStorage.getItem(glossLsKey(bookPath)) ?? "";
  // pre-hydration reads see the not-yet-migrated localStorage entry, not ""
  return glossCache.get(bookPath) ?? localStorage.getItem(glossLsKey(bookPath)) ?? "";
}

// ---- «the file changed under you» -------------------------------------------
//
// The glossary has more than one writer now. The Terms panel replaces the WHOLE
// file on a keystroke (its 600 ms debounce, its blur flush and its unmount
// handler all call saveGlossaryText with the textarea's contents), while the
// knowledge graph's deep pass merges into the same file from a background queue
// — graphgen.feedTermStore → glossarygen.saveGlossary → here. That queue is not
// paused while a book is open (graphrun has no «don't build the open book»
// guard, deliberately: the grid unmounts when the reader opens a book and the
// queue has to keep going), so the two writers overlapping is the ordinary case,
// not the exotic one. Nothing told the panel, so it held the string it read at
// mount and the reader's next keystroke wrote that string back over the graph's
// lines — and they were never regenerated, because graphrun returns early on a
// shard that already reached stage «deep» at the current GRAPH_GEN. One
// notification closes that, and it belongs beside the session cache: this module
// is the only door to the bytes, so it is the only place that can know.
//
// The shape is i18n's language switch (i18n.ts:1050), not a second convention: a
// Set of listeners, a snapshot, useSyncExternalStore on top. The snapshot is a
// REVISION COUNTER rather than the text, because the text already lives in the
// subscriber's own state — a controlled textarea — and what it needs is «go
// re-read», not a value. A counter also disposes of the filtering for free: a
// write to another book leaves this book's number alone, so React compares two
// equal numbers and never re-renders the panel of the book in front of the
// reader.
//
// WHY A WRITE CAN NAME ITS WRITER. The panel is both the store's only
// interactive writer and its only subscriber, and waking it on its own write
// would fight the textarea it is trying to protect. Its save fires 600 ms after
// the last keystroke; re-reading the record costs another IPC round-trip for the
// sidecar; the textarea is live through both. So a self-wake would setText a
// string one or two characters behind what is on screen — reverted characters
// and the caret thrown to the end of a 200-line list, which is exactly the
// damage this notification exists to prevent. Hence: a write may name its
// writer, and a subscriber that names the same writer keeps the revision it
// already had, because that writer's own writes are subtracted from the count.
// A write that names nobody is foreign to everybody, which is the safe default
// and the one every current caller takes — glossarygen.saveGlossary, and through
// it both the graph's deep pass and «Add to the glossary», stay untagged and
// always wake the panel.

/// Identity of a writer, for the «don't wake me on my own write» subtraction.
/// Create ONE per writer and keep it — at module scope, or in a ref that outlives
/// the renders. The tally of its own writes hangs off the token itself (rather
/// than off the book, where it would pile up for the whole session), so a token
/// rebuilt on every render would be a different writer each time and would wake
/// itself exactly as if it had never named itself at all.
export type GlossaryWriter = { readonly id: string; readonly wrote: Map<string, number> };

export function glossaryWriter(id: string): GlossaryWriter {
  return { id, wrote: new Map() };
}

const glossRev = new Map<string, number>();
const glossListeners = new Set<(bookPath: string, by?: GlossaryWriter) => void>();

/// Every glossary write that changed something, for callers outside React. The
/// listener is handed the bookPath that changed and the writer that named itself,
/// if one did.
export function subscribeGlossary(fn: (bookPath: string, by?: GlossaryWriter) => void): () => void {
  glossListeners.add(fn);
  return () => {
    glossListeners.delete(fn);
  };
}

/// Opaque, monotonic per book. Only meaningful compared with itself — it exists
/// to sit in a dependency array beside bookPath. Passing `mine` subtracts that
/// writer's own writes, which is what keeps it asleep on them.
export function glossaryRevision(bookPath: string, mine?: GlossaryWriter): number {
  return (glossRev.get(bookPath) ?? 0) - (mine?.wrote.get(bookPath) ?? 0);
}

function bumpGlossary(bookPath: string, by?: GlossaryWriter): void {
  glossRev.set(bookPath, (glossRev.get(bookPath) ?? 0) + 1);
  if (by) by.wrote.set(bookPath, (by.wrote.get(bookPath) ?? 0) + 1);
  // Over a copy: a listener is allowed to unsubscribe from inside its own
  // callback (a panel unmounting on the very write it was just told about), and
  // Set iteration would otherwise visit whatever a listener adds during dispatch.
  for (const fn of [...glossListeners]) fn(bookPath, by);
}

/// Re-renders the caller when someone else writes this book's glossary. Pass the
/// caller's own writer token to stay asleep on its own writes.
export function useGlossaryRevision(bookPath: string, mine?: GlossaryWriter): number {
  const read = useCallback(() => glossaryRevision(bookPath, mine), [bookPath, mine]);
  return useSyncExternalStore(subscribeGlossary, read, read);
}

export function saveGlossaryText(bookPath: string, text: string, by?: GlossaryWriter): void {
  // Before/after rather than a comparison with `text` itself: the plain-browser
  // flavour normalises a blank glossary to «no entry at all», so this is the only
  // spelling that agrees with what a woken subscriber's re-read would actually
  // return. A write that changes nothing wakes nobody — i18n.setLang's
  // `if (l === current) return` for the same reason, and it matters here because
  // the panel's flush() and its unmount handler both fire on text that is often
  // already saved.
  const before = loadGlossaryText(bookPath);
  if (!IS_TAURI) {
    if (text.trim()) localStorage.setItem(glossLsKey(bookPath), text);
    else localStorage.removeItem(glossLsKey(bookPath));
    if (loadGlossaryText(bookPath) !== before) bumpGlossary(bookPath, by);
    return;
  }
  glossCache.set(bookPath, text);
  // Notified off the SESSION CACHE, before the file write settles. The cache is
  // what every reader in this session sees — loadGlossaryText, and hydrateGlossary
  // on a cache hit — so a subscriber woken here reads the new text, and that text
  // is still what survives if writeGlossFile has to fall back to localStorage
  // below. Waiting for the write would mean waking the panel one IPC round-trip
  // later than the value it is being woken about is already visible.
  if (text !== before) bumpGlossary(bookPath, by);
  writeGlossFile(bookPath, text).then(
    () => localStorage.removeItem(glossLsKey(bookPath)), // both directions: the file is now the truth
    (e) => {
      console.error("glossary save failed", e);
      try {
        localStorage.setItem(glossLsKey(bookPath), text); // keep the text durable SOMEWHERE
      } catch {
        // quota — the session cache still holds it
      }
    },
  );
}

// The TRANSLATION VIEW of the term file: the records that actually carry a
// translation, in file order. The grammar itself is not parsed here any more —
// glossary.ts owns the one parser, so the line the terms panel shows, the line
// the context menu appends and the line a prompt quotes can never disagree the
// way three private spellings of the grammar did.
//
// A record with no translation contributes NOTHING here, and that is the entire
// point of the change rather than a gap in it: a bare «полнота» line and a
// «полнота :: метрика :: доля найденных релевантных документов» line are a term
// list, not instructions to a translator, and a book nobody translates is
// allowed to have one. The old "needs manual entry" placeholder needs no special
// case either — glossary.ts calls a field with no letter and no digit («?», «—»,
// «-») empty, which is what glossarygen's own brokenRhs test already said about
// such a right-hand side. Verified against the previous regex over the legacy
// line shapes a booktranslate.ts:87 snapshot holds: the {src,dst} projection is
// identical except that `термин = —` no longer arrives as an authoritative
// rendering of «—».
export function parseGlossary(text: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const rec of parseGlossaryText(text)) {
    if (rec.translation) out.push({ src: rec.term, dst: rec.translation });
  }
  return out;
}

// Entries whose source term actually occurs in the text — as a WORD, not as a
// substring. A raw `includes` test made the two-letter term «Li» (an author
// surname the generator mistook for a term) match inside applications,
// quality, online, click, literature… so `Li 翻译成 инвертированные списки` was
// prepended as an authoritative instruction to 48% of the book's prompts, and
// the model duly wrote «инвертированные списки» over «BOW encodings»,
// «embeddings», a variable name, and once looped on it until the paragraph
// dissolved. Boundaries are letter/digit-class transitions on both sides, so
// acronyms («IR», «QAC») still match while their letters inside longer words
// no longer do; terms are anchored at the edges only where the term itself
// starts/ends with a word character, which keeps entries like «F1-score» or
// «(MRR)» matching.
const WORD_CH = /[\p{L}\p{N}_]/u;
const RX_ESC = /[.*+?^${}()|[\]\\]/g;

function termMatcher(src: string): RegExp {
  const body = src.replace(RX_ESC, "\\$&");
  const head = WORD_CH.test(src[0]) ? "(?<![\\p{L}\\p{N}_])" : "";
  const tail = WORD_CH.test(src[src.length - 1]) ? "(?![\\p{L}\\p{N}_])" : "";
  return new RegExp(head + body + tail, "iu");
}

const matcherCache = new Map<string, RegExp | null>();

function matched(text: string, glossary: GlossaryEntry[]): GlossaryEntry[] {
  return glossary.filter((g) => {
    if (!g.src) return false;
    let rx = matcherCache.get(g.src);
    if (rx === undefined) {
      try {
        rx = termMatcher(g.src);
      } catch {
        rx = null; // unbuildable term (lone combining mark, etc.) — never matches
      }
      matcherCache.set(g.src, rx);
    }
    return rx ? rx.test(text) : false;
  });
}

// ---- the source language ----------------------------------------------------
//
// TranslateGemma's own template names BOTH ends of the pair, and naming the
// source end is worth real quality on a model trained across 55 languages: told
// what it is reading, it stops inferring the source from the first sentence —
// which is where a paragraph of formulas, a list of author surnames or a table
// caption sends it wrong. The names below are the English ones the template
// uses.
//
// The keys are exactly what detectBookLang can return — booklang.ts:87's
// BOOK_LANGS and nothing besides. `BookLang` is an OPEN type on purpose
// (booklang.ts:58: a reader may override with a subtag we cannot detect), so
// TypeScript cannot make this an exhaustive Record and the DEV check below is
// the substitute. Edit the two lists in the same commit: a language BOOK_LANGS
// gains and this map lacks does not break anything loudly, it silently drops
// every book in that language to the no-source variant of the prompt, which is
// the hardest kind of regression to notice from the outside.
const SRC_NAME: Record<string, string> = {
  ru: "Russian",
  uk: "Ukrainian",
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  pl: "Polish",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  el: "Greek",
  he: "Hebrew",
  ar: "Arabic",
  hi: "Hindi",
};

if (import.meta.env.DEV) {
  const missing = BOOK_LANGS.filter((l) => !(l in SRC_NAME));
  if (missing.length) console.error(`SRC_NAME lacks BOOK_LANGS entries: ${missing.join(", ")}`);
}

/// The English name and the primary subtag of a detected book language, or null
/// when we have no business claiming one.
///
/// `UND` maps to null rather than to the word "Undetermined": telling a machine
/// translator that the source language is undetermined is strictly worse than
/// telling it nothing, and "und" is precisely booklang's «I will not guess»
/// (booklang.ts:69), not a language. A region subtag ("pt-BR") is reduced to its
/// primary the way BookLang documents it.
export function srcLanguage(code?: string): { en: string; code: string } | null {
  if (!code) return null;
  const key = code.toLowerCase().split(/[-_]/)[0];
  if (!key || key === UND) return null;
  const en = SRC_NAME[key];
  return en ? { en, code: key } : null;
}

// ---- the draft prompt -------------------------------------------------------

/// Everything the draft prompt may carry besides the paragraph itself. All three
/// are optional and all three are REFERENCE — the model is told, in as many
/// words, not to translate them and not to repeat them.
///
///   sentence — the sentence the selection sits inside (the popover, and
///              glossarygen's term ladder). Keeps its old meaning exactly.
///   srcPrev  — the preceding SOURCE paragraph. Free: no dependency on any
///              other request having finished.
///   trPrev   — target text already produced for this book. USUALLY the
///              immediately preceding paragraph and not guaranteed to be:
///              booktranslate splits a page into contiguous slices and chains
///              strictly inside each (booktranslate.ts's page loop), so a slice
///              HEAD is answered by the previous page's tail instead, and a
///              two-column page sends no source context at all. The block header
///              therefore says «already produced for this book» rather than «the
///              previous paragraph»: the model is never told something false
///              about adjacency. (This paragraph used to describe three workers
///              pulling from one shared cursor — that design was reversed, and
///              the slice chain is what replaced it.)
export type DraftContext = { sentence?: string; srcPrev?: string; trPrev?: string };

// ---- one slot, and what a single request may spend of it --------------------
//
// llama-server does NOT hand a request the whole `-c`. With the flags the Rust
// side spawns for 11544 (`--parallel 8 -c 24576 -fa on`) its own startup line
// reads, verbatim on this machine:
//
//     srv load_model: initializing, n_slots = 8, n_ctx_slot = 3072, kv_unified = 'false'
//
// `n_ctx_slot` is the number every ceiling in this file is priced against: `-c`
// IS divided across the slots, so a request's honest share is 24576 / 8 = 3072
// cells and not the 24576 the flag names.
//
// (An earlier version of this note, and of the correction under «request
// budgets», hung that division on `kv_unified = true` — «-c buys ONE arena that
// all slots draw from». The startup line above says 'false': this build turns
// unified KV on only when the slot count is left to auto, and the spawn now
// passes an explicit --parallel. The arithmetic was right and the reason was
// wrong. Nothing in this file rests on kv_unified any more; it rests on
// n_ctx_slot, which is what the server actually prints.)
//
// THE WHOLE REQUEST has to fit in that slot — the prompt (head, term block,
// continuity blocks, the paragraph itself) PLUS `n_predict` — and it did not.
// The ceiling on n_predict was itself 3072, the whole slot, while the prompt
// added roughly another 1050 cells on top of it: about 4100 cells asked of a
// 3072-cell slot on a long paragraph. Neither half of the overrun is loud. A
// prompt that alone exceeds the slot is answered 400, which the taxonomy below
// correctly calls a plain Error, so translateRetry gives up after two attempts
// and writes "" — and export.ts:135-145 turns "" into an image crop, so a good
// paragraph comes out of the book as a picture. A prompt that fits but leaves
// no room to generate is worse, because it is silent: the slot fills mid
// sentence and the reply simply stops, and no gate in this file catches that —
// looksRunaway looks for a reply that is too LONG.
//
// HOW OFTEN, on the reader's own book, counted rather than assumed: of the 9603
// source paragraphs in the 838-page monograph in the store (p50 91 characters,
// p90 650, p99 1436, max 3722), SIX would have asked for more than 3072 cells
// under the old arithmetic — the band runs from 2155 characters, where the
// continuity blocks were still attached, to the longest paragraph in the book.
// Six in 9603 is not a reason to leave it: those six are the longest paragraphs
// in the book, which is to say the ones a reader most needs translated, and the
// failure hands back an image crop or half a sentence.
//
// Hence: every clip and every cap below is a share of ONE slot's context, and
// the slot's size is not written here at all — draftSlot() reads it, and what it
// reads is what `llama_slots` took off the spawn (see FALLBACK and the IPC under
// «request budgets»). 3072 is a value in exactly one place in this file — the
// FALLBACK record that stands until that command answers. Everywhere else it is
// only ever quoted, in a comment, to show what a share works out to.

/// Estimated tokens in a string. Budgeting only — never quote it as a count.
///
/// There is no tokenizer in the frontend, and llama-server's /tokenize would
/// cost a slot and a round trip per paragraph on the very path this budget
/// exists to keep fast. So it is an average over prose, and the two divisors are
/// the ones this file already quoted for the reply ceiling: ~4 characters per
/// token for Latin text through a Gemma vocabulary, ~2.2 for Cyrillic. ASCII vs
/// not is the split because that is what predicts the ratio — and it is the
/// conservative direction for the scripts it was not measured on (CJK, Greek,
/// Hebrew all run at or under 2.2). ctxMargin is what pays for it being wrong.
const CHARS_PER_TOKEN_ASCII = 4;
const CHARS_PER_TOKEN_WIDE = 2.2;

function estTokens(s: string): number {
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / CHARS_PER_TOKEN_ASCII + (s.length - ascii) / CHARS_PER_TOKEN_WIDE);
}

/// The safety margin held back from every slot: a tenth of it, plus 64 cells.
///
/// estTokens is an average over prose and not every paragraph is prose. A block
/// of formulas, a list of author surnames, a table caption, a URL and a code
/// identifier all tokenise far worse than four characters a token. The request
/// also carries what this module never sees: the BOS llama-server prepends
/// (add_special=true — see the module header), the turn markers, and whatever
/// the server rounds up for its own bookkeeping. The proportional tenth scales
/// with the slot, the flat 64 covers the fixed part that does not. At the
/// shipped 3072 it reserves 371 cells, and it is taken out of the OPTIONAL parts
/// of the prompt first, never out of the source text.
const ctxMargin = (slot: number) => Math.round(slot / 10) + 64;

/// What the optional parts of a draft prompt may spend, as SHARES of one slot
/// rather than as token or character counts, so that a spawn with a different
/// CTX_PER_SLOT re-prices all of them at once instead of silently overrunning a
/// smaller slot or wasting a larger one.
///
/// Each share is set to reproduce, at the shipped 3072, the character clip it
/// replaces — a re-derivation of numbers that were already reviewed, not a
/// re-tuning of them. What each buys at 3072, against what it replaces:
///
///   TERM_SHARE      0.16 → 492 tokens. TERM_LINES_MAX was 40 lines and this
///                   file priced a line at ~12 tokens: 480.
///   SRC_PREV_SHARE  0.06 → 184 tokens = 736 characters of English source
///                   (~4 chars/token). SRC_PREV_MAX was 700.
///   TR_PREV_SHARE   0.13 → 399 tokens = 878 characters of Russian (~2.2).
///                   TR_PREV_MAX was 900, and this share stays more than double
///                   srcPrev's for the reason the character clips were uneven:
///                   the target side runs roughly 30% longer in characters, and
///                   much longer again in tokens, than the source it renders.
///   SENTENCE_SHARE  0.03 → 92 tokens = 368 characters of English, 202 of
///                   Russian. SENTENCE_MAX was 300 either way, which is the
///                   confusion of units this replaces in miniature.
const TERM_SHARE = 0.16;
const SRC_PREV_SHARE = 0.06;
const TR_PREV_SHARE = 0.13;
const SENTENCE_SHARE = 0.03;
const CTX_SHARE = SRC_PREV_SHARE + TR_PREV_SHARE + SENTENCE_SHARE;

/// What a reply WANTS, before the slot has had its say. Unchanged in form from
/// the flat ceiling it replaces, and derived from the SOURCE length rather than
/// from the prompt: the prompt now carries reference blocks that are not the
/// thing being translated, so its length is no longer a proxy for how long the
/// answer should be — sizing off it would hand a short paragraph with a full
/// context window enough rope to keep going.
///
/// A translation into Russian runs longer than its English source in characters
/// and much longer in tokens (~2.2 chars/token against ~4), so half the source's
/// character count is a generous-but-honest ceiling, with the +256 covering
/// short inputs. What was NOT honest was the `Math.min(3072, …)` that used to
/// sit in front of it: 3072 is the whole slot, and the prompt has to live there
/// too. draftBudget below is where the slot answers back.
const REPLY_MIN = 256;
const replyWant = (srcLen: number) => Math.max(REPLY_MIN, Math.round(srcLen / 2) + REPLY_MIN);

/// Clip a reference block to a TOKEN budget, keeping its TAIL, because what
/// binds the current paragraph to its predecessor — the last sentence's tense,
/// the pronoun it resolves, the form of address, the term just used — sits at
/// the END.
///
/// The budget is tokens and not characters (it used to be SRC_PREV_MAX /
/// TR_PREV_MAX / SENTENCE_MAX = 700 / 900 / 300 characters): a character budget
/// buys a different number of cells in English and in Russian, and mixing the
/// two units is exactly how the prompt came to outgrow its slot. The character
/// count to keep is estTokens run backwards over the string's own measured
/// density, so a Cyrillic block is clipped harder than a Latin one of the same
/// length without either being told about the other; the density of the tail
/// can differ from the density of the whole, which is one more thing ctxMargin
/// is holding cells back for.
///
/// Same reasoning and same shape as styleguide.ts's `clipPrev`,
/// deliberately not shared — one is about a Russian paragraph on its way to the
/// editor, this one about either language on its way to the translator, and a
/// common helper would only invite one of them to be tuned for the other.
function clipTail(s: string, maxTok: number): string {
  const t = s.trim();
  const tok = estTokens(t);
  if (tok <= maxTok) return t;
  const keep = Math.max(1, Math.floor((t.length * maxTok) / tok));
  // `^\S*\s+` covers both landings in one pass: a cut that fell mid-word loses
  // the fragment and the space after it, a cut that fell on whitespace loses
  // only the whitespace (its first word is already whole). A window holding no
  // whitespace at all — one enormous token — is left exactly as it is rather
  // than emptied.
  return t.slice(t.length - keep).replace(/^\S*\s+/, "");
}

/// The register the book speaks in, one line, per TARGET language.
///
/// This is an addition to the design note's prompt, made because the note left
/// the draft model no register signal at all except «keep the same form of
/// address as the {T} above» — and the FIRST prompt of a book has no «above» by
/// construction. The ты/вы choice would then be a coin flip, and the chain would
/// propagate it, consistently and possibly wrongly, for 838 pages; undoing that
/// costs a full second pass over the whole book to repair what one sentence here
/// decides for free. (The «~5 tok/s per slot» this line used to quote came from
/// the Vulkan-era guess and was refuted by measurement — see the batching table
/// under «request budgets» for what this machine actually does.)
///
/// It says the same thing as the style guide's rule 5 (styleguide.ts:147),
/// worded for a translator instead of an editor and in English because that is
/// the language this prompt is in. THE TWO MUST AGREE: if the guide's register
/// rule changes, change this line in the same edit, or the draft pass and the
/// edit pass will spend the whole book undoing each other.
///
/// (The adversarial review asked for this to be sourced from a constant
/// styleguide.ts exports. That module exports no such constant — its register
/// rule is sentence 5 inside a Russian-worded guide addressed to the editor, and
/// P3 does not own that file. Hence a local constant and a stated invariant.)
const DRAFT_REGISTER: Record<string, string> = {
  ru: "The book addresses the reader as «вы», lower case, in an even and unhurried tone.",
  en: "The book addresses the reader directly, in an even and unhurried tone.",
};

/// Assemble the /completion prompt. Gemma turn markers by hand, no <bos> — see
/// the module header for both.
///
/// The FIRST sentence and the LAST sentence are TranslateGemma's own template
/// wording, recovered from the upstream bug report (ggml-org/llama.cpp#19295)
/// and a community port of the template, and they are kept character for
/// character — including the "(en)" after the language name and the comma before
/// "and cultural sensitivities" — so that the prompt stays on the distribution
/// the model was actually tuned on. Everything between them is ours, and is
/// there because the embedded template cannot express it: the register line, the
/// book's own terms, and the continuity blocks.
export function buildDraftPrompt(
  text: string,
  glossary: GlossaryEntry[],
  ctx?: DraftContext,
  srcLang?: string,
): string {
  const S = srcLanguage(srcLang);
  const T = targetLanguage();

  // THE MANDATORY PARTS FIRST, assembled into two strings rather than appended
  // in place, and priced before anything optional is offered a single cell: the
  // head, the paragraph itself and the closing instruction are never cut. This
  // is also why there is no «the head costs about 150 tokens» constant anywhere
  // in this file — the head is a string we are holding, so it is measured.
  let head = "<start_of_turn>user\n";
  // Broken across lines for the margin only — the concatenation is byte-identical
  // to the template's own sentence, spaces included. Verify a change to it by
  // joining the pieces, not by eye.
  head += S
    ? `You are a professional ${S.en} (${S.code}) to ${T.en} (${T.code}) translator. ` +
      `Your goal is to accurately convey the meaning and nuances of the original ${S.en} text ` +
      `while adhering to ${T.en} grammar, vocabulary, and cultural sensitivities.\n`
    : `You are a professional translator into ${T.en} (${T.code}). ` +
      `Your goal is to accurately convey the meaning and nuances of the original text ` +
      `while adhering to ${T.en} grammar, vocabulary, and cultural sensitivities.\n`;
  const register = DRAFT_REGISTER[T.code];
  if (register) head += `${register}\n`;

  let tail = S
    ? `\nPlease translate the following ${S.en} text into ${T.en} (${T.code}):\n\n${text}\n\n`
    : `\nPlease translate the following text into ${T.en} (${T.code}):\n\n${text}\n\n`;
  tail += `Produce only the ${T.en} translation, without any additional explanations or commentary.`;
  tail += "<end_of_turn>\n<start_of_turn>model\n";

  // WHAT IS LEFT OF ONE SLOT once the mandatory parts and the reply the
  // paragraph is going to need are paid for. Everything optional is spent out of
  // `extra`, and when `extra` runs out the prompt simply stops growing — which
  // is the whole fix: the request can no longer ask for more cells than the slot
  // has, whatever the paragraph and whatever the glossary.
  //
  // THE ORDER OF SACRIFICE, and this REVERSES the sentence that used to sit over
  // TERM_LINES_MAX — «term lines first, then the continuity blocks, and NEVER
  // the source text». The code never did that: TERM_LINES_MAX capped the terms
  // at 40 always, while CTX_DROP_OVER threw the continuity blocks away wholesale
  // for any source past 2500 characters. The code was right and the sentence was
  // wrong, and the sentence's own footnote says why — «past 2500 characters a
  // paragraph carries plenty of its own context anyway; the blocks exist for the
  // short paragraph whose pronoun is ambiguous on its own». A long paragraph
  // needs its terms and does not need its predecessor; a short one has room for
  // both, and short paragraphs are where the continuity blocks earn their place.
  // So: terms first out of `extra`, the continuity blocks out of what the terms
  // leave, and the source text still never touched.
  //
  // CTX_DROP_OVER goes with the cliff it defined. The blocks now thin out as the
  // paragraph grows and give out on their own, and where they give out was
  // measured against this arithmetic at slot 3072 rather than guessed: the last
  // English source still carrying a continuity block is 2550 characters when the
  // paragraph also matches a full term block, 3040 when it matches no glossary
  // entry at all. Both bracket the flat 2500 they replace — but they are counted
  // in cells, so a Cyrillic source (~2.2 chars/token against ~4) stops paying for
  // context at the same number of CELLS instead of at the same number of
  // characters, which is the whole reason the old threshold was wrong for half
  // the languages this model speaks.
  //
  // Past about 3090 characters of English source, `extra` is exhausted and it is
  // draftBudget that starts giving ground: the reply ceiling drops below what
  // replyWant asked for. That is the honest end of the line for a single slot,
  // and it is stated there rather than hidden here.
  const slot = draftSlot();
  let extra = slot - ctxMargin(slot) - replyWant(text.length) - estTokens(head) - estTokens(tail);

  // matched() and nothing else — matched terms only, never the whole list. That
  // word-boundary matcher (termMatcher, above) is what stopped `Li 翻译成
  // инвертированные списки` being prepended as an authoritative instruction to
  // 48% of this book's prompts, and handing a 12B model the other 400 lines
  // would re-open it in a new spelling.
  let termBlock = "";
  const terms = extra > 0 ? matched(text, glossary) : [];
  if (terms.length) {
    const allow = Math.min(Math.round(slot * TERM_SHARE), extra);
    const header = `\nEstablished ${T.en} renderings for this book's terms — use them exactly:\n`;
    const kept = new Set<GlossaryEntry>();
    let cost = estTokens(header) + 1; // + the blank line that closes the block
    // Heaviest first for the CUT, original order for the OUTPUT: a longer term
    // is the more specific instruction and the one a translator is likelier to
    // get wrong on its own, while re-ordering the lines that survive would make
    // the block depend on the glossary's contents in a way nothing else does.
    // `continue` rather than `break` on a line that does not fit: the budget is
    // tokens now, so a shorter line further down the sorted list may still fit
    // where the one before it did not, and leaving cells unspent buys nothing.
    for (const t of [...terms].sort((a, b) => b.src.length - a.src.length)) {
      const c = estTokens(`${t.src} → ${t.dst}\n`);
      if (cost + c > allow) continue;
      cost += c;
      kept.add(t);
    }
    if (kept.size) {
      termBlock = header;
      for (const t of terms) if (kept.has(t)) termBlock += `${t.src} → ${t.dst}\n`;
      termBlock += "\n";
      extra -= estTokens(termBlock);
    }
  }

  // The continuity blocks, out of whatever the terms left. Each is clipped to
  // its own share of the slot, scaled down together when `extra` cannot cover
  // all three, and then admitted one at a time in order of value — the target
  // side first (it carries the terminology, the tense and the ты/вы form of
  // address the chain exists to hold), the source side next, the selection's
  // own sentence last, because that one is the popover's nicety rather than the
  // book pass's continuity.
  let refBlock = "";
  const refShare = Math.round(slot * CTX_SHARE);
  const refAllow = Math.min(refShare, extra);
  if (refAllow > 0) {
    // The three per-block budgets shrink together rather than in priority order,
    // so a squeezed prompt still carries all three ends of the continuity — a
    // shortened trPrev still fixes the form of address, while the whole block
    // missing does not. k is 1 whenever the terms left the full share intact.
    const k = refAllow / refShare;
    const srcPrev = ctx?.srcPrev ? clipTail(ctx.srcPrev, Math.round(slot * SRC_PREV_SHARE * k)) : "";
    const trPrev = ctx?.trPrev ? clipTail(ctx.trPrev, Math.round(slot * TR_PREV_SHARE * k)) : "";
    const sent = ctx?.sentence ? clipTail(ctx.sentence, Math.round(slot * SENTENCE_SHARE * k)) : "";
    // Every string is built ONCE and then costed, admitted and emitted — costing
    // a copy of a line and emitting another is how a budget and its prompt drift
    // apart on the next edit to the wording.
    const header = "\nReference material, for continuity only. Do not translate it and do not repeat it.\n";
    const srcLine = srcPrev ? `Preceding ${S ? `${S.en} ` : ""}paragraph:\n${srcPrev}\n` : "";
    const trLine = trPrev ? `${T.en} already produced for this book:\n${trPrev}\n` : "";
    const sentLine = sent ? `The text appears in this sentence:\n${sent}\n` : "";
    const keepLine = `Keep the same terminology, the same tense and the same form of address as the ${T.en} above.\n`;
    let cost = estTokens(header);
    const fits = (s: string): boolean => {
      const c = estTokens(s);
      if (cost + c > refAllow) return false;
      cost += c;
      return true;
    };
    // trLine is costed together with keepLine because the instruction is only
    // ever emitted when the block it points at is there.
    const useTr = trLine !== "" && fits(trLine + keepLine);
    const useSrc = srcLine !== "" && fits(srcLine);
    const useSent = sentLine !== "" && fits(sentLine);
    if (useTr || useSrc || useSent) {
      refBlock =
        header +
        (useSrc ? srcLine : "") +
        (useTr ? trLine : "") +
        (useSent ? sentLine : "") +
        (useTr ? keepLine : "");
    }
  }

  return head + termBlock + refBlock + tail;
}

// GREEDY, and the HY-MT card's four numbers ({0.7, top_k 20, top_p 0.6,
// repeat_penalty 1.05}) are gone with the model they belonged to: they were that
// card's recommendation for that model and mean nothing to a Gemma. Greedy is
// the standard for machine translation and it buys reproducibility, which is
// load-bearing here — carryOver matches paragraphs on their SOURCE text alone,
// so a nondeterministic translation makes «Обновить перевод» carry over
// whichever of two equally valid runs happened to be on disk.
//
// repeat_penalty stays at 1.0 rather than 1.05 because a penalty punishes the
// legitimate repetition of a term, which is exactly what the glossary block is
// asking the model to do. The degenerate-loop risk it used to cover is answered
// honestly instead, by the n_predict ceiling below plus looksRunaway — this
// codebase has watched a paragraph dissolve into one looping term, and a sampler
// tweak was never the right guard for it.
const DRAFT_SAMPLING = { temperature: 0, top_k: 1, repeat_penalty: 1.0 };

/// `n_predict`: what the paragraph WANTS (replyWant, above), cut down to what
/// the MEASURED prompt actually leaves inside one slot. This is the second half
/// of the budget — buildDraftPrompt trims the prompt so that the want normally
/// survives intact, and this is the arithmetic that guarantees the sum whatever
/// the prompt turned out to cost.
///
/// The old ceiling was a flat 3072: one whole slot for the reply, with the
/// prompt's own ~1050 cells unaccounted for. That is the overrun this file now
/// exists to prevent, and the fix is not a smaller literal — it is that the
/// number is derived from the same exported CTX_PER_SLOT the spawn used.
///
/// THE FLOOR OF 256 IS LOAD-BEARING, and not a rounding nicety: `n_predict`
/// must stay positive, because llama-server reads 0 as «generate nothing» and a
/// negative as «unbounded», and both are worse answers to «this paragraph does
/// not fit» than a truncated one. Reaching the floor means the source text alone
/// no longer fits its own slot with room to be translated — at that point the
/// only cut left is the source, and the source is not on the table (see the
/// order of sacrifice in buildDraftPrompt). Splitting such a paragraph is
/// booktranslate's business, not this module's.
const draftBudget = (prompt: string, srcLen: number): number => {
  const slot = draftSlot();
  return Math.max(
    REPLY_MIN,
    Math.min(replyWant(srcLen), slot - ctxMargin(slot) - estTokens(prompt)),
  );
};

// ---- request budgets --------------------------------------------------------
// ONE pool per SERVER, and its size is DERIVED from that server's `--parallel`
// rather than being a literal repeated in two languages. The 11544 pool is
// shared by every draft consumer — interactive popover, batch book translation,
// glossary fallback — so two pipelines running at once cannot stack their
// per-module worker pools into more concurrent requests than the server has
// slots. The aux server (11545) gets its OWN separate budget: its requests never
// eat into the translator's slots, and the style pass, the terminologist and
// graphgen's typing calls all draw from that one budget because they are the
// same 14.2 GB of weights.
//
// WHY BOTH POOLS GREW OUT OF THE LITERAL 3, AND WHY THIS IS THE LARGEST
// THROUGHPUT LEVER IN THE APP. Decode is weight-bandwidth-bound: N sequences
// read the same weights once per step and share them, so the extra sequences are
// nearly free until the card runs out of arithmetic. Measured on this machine,
// not inferred — `llama-batched-bench -m HY-MT1.5-7B-Q4_K_M.gguf --device CUDA0
// -ngl 99 -fa on -c 32768 -npp 512 -ntg 256 -npl 1,2,4,8,16` on the RTX 5080:
//
//     B (concurrent sequences)   S_TG t/s   scaling
//      1                          142.57      1.00x
//      2                          265.73      1.86x
//      4                          460.06      3.23x
//      8                          769.35      5.40x
//     16                         1298.87      9.11x
//
// It costs NOTHING in quality: the slots are independent sequences and each
// one's output is byte-identical to running it alone. This module used to hold 3
// in flight against a spawn that passed no `--parallel` at all — llama-server's
// default of 4 — which is the 3.23x row at its very best, against the 5.40x the
// spawn now asks for (the doc comment on `LlamaSrv::PARALLEL` in
// src-tauri/src/lib.rs carries the same table from the spawn's end — named
// rather than cited by line, because that file is moving under this one).
//
// ONE SLOT OF HEADROOM is the one thing about the old sizing that survives
// unchanged, and it is still the reason the pool is not simply `--parallel`: a
// slot must stay free for whatever arrives while a background sweep is
// saturating the rest — the paragraph the reader just alt-clicked, the Terms
// tab, a health probe. 8 − 1 = 7 draft requests, 4 − 1 = 3 aux ones.
//
// CORRECTION, and it matters for every ceiling in this file: an earlier version
// of this comment read «its unified KV gives every slot the full context, so
// concurrency here costs no context per request». That is backwards, and the
// version that replaced it — blaming `kv_unified = true` for the division — was
// wrong about the reason. What the server prints for the shipped flags is
// `n_slots = 8, n_ctx_slot = 3072, kv_unified = 'false'`: `-c` is divided across
// the slots whether or not the KV cache is unified, and this build only turns
// unification on when the slot count is left to auto, which an explicit
// `--parallel` no longer does. So a request's share is the per-slot figure that
// llama_slots exports — 3072 cells on 11544, 4096 on 11545 — and every clip and
// cap in buildDraftPrompt, plus draftBudget's ceiling, is a share of it. The
// original sentence would have argued all of them away.
//
// Raising `--parallel` on its own buys none of that back: with `-c` unchanged it
// makes every slot SMALLER. What keeps the per-slot figure constant is that the
// spawn sizes `-c` as PARALLEL × CTX_PER_SLOT, which is precisely why
// CTX_PER_SLOT and not `-c` is the number crossing the IPC.

/// THE ONE PLACE THE TWO LANGUAGES CAN STILL DRIFT APART, and the reason it is
/// a single labelled record rather than four literals sprinkled through the
/// file.
///
/// `llama_slots` (below) is what actually keeps translate.ts and lib.rs
/// agreeing: it reads the spawn's own `PARALLEL` and `CTX_PER_SLOT` off the Rust
/// side and overwrites all four numbers. But `invoke` THROWS in the plain
/// browser — the `?test=` vite pane has no Tauri IPC at all — and it has not
/// answered yet during the first milliseconds of a real session either. These
/// are the values that stand in until it does, and they are the values that
/// stand for good in the dev pane, so they are the only copies that can go stale
/// against a spawn that changes. Change one of the constants in lib.rs
/// (`TranslationState::PARALLEL` / `::CTX_PER_SLOT`, `AuxState::PARALLEL` /
/// `::CTX_PER_SLOT`) and change these in the same commit; nothing will fail
/// loudly if you do not, because the app itself will be reading the IPC.
const FALLBACK = {
  mainParallel: 8,
  mainCtxPerSlot: 3072,
  auxParallel: 4,
  auxCtxPerSlot: 4096,
} as const;

/// One slot's context on each server, in tokens: the number every prompt clip
/// and every reply ceiling in this file is a share of. Mutable, because the IPC
/// below is allowed to correct it; read through the accessors so that a caller
/// cannot capture a pre-IPC value in a constant and hold it for the session.
let mainCtxPerSlot: number = FALLBACK.mainCtxPerSlot;
let auxCtxPerSlot: number = FALLBACK.auxCtxPerSlot;
const draftSlot = (): number => mainCtxPerSlot;
const auxSlot = (): number => auxCtxPerSlot;
/// Slots left free for whatever arrives mid-batch. One, on both servers.
const POOL_HEADROOM = 1;
const poolFor = (parallel: number) => Math.max(1, parallel - POOL_HEADROOM);

function makeLimiter(max: number) {
  let inflight = 0;
  const waiters: (() => void)[] = [];
  // Grant as many queued waiters as the ceiling now allows, rather than exactly
  // one: setMax can raise the ceiling by several slots at once, and release()
  // never grants more than the single slot it freed anyway.
  const pump = () => {
    while (inflight < max && waiters.length) waiters.shift()!();
  };
  return {
    /// Re-size the pool once the server's real `--parallel` is known. Raising it
    /// releases whatever is already queued; lowering it (a build that spawns
    /// fewer slots than the literals above) admits nothing new until the excess
    /// drains, which is why release() re-tests the ceiling instead of granting
    /// unconditionally the way it used to.
    setMax(n: number): void {
      max = Math.max(1, n);
      pump();
    },
    size(): number {
      return max;
    },
    acquire(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return Promise.reject(new DOMException("translate aborted", "AbortError"));
      if (inflight < max) {
        inflight++;
        return Promise.resolve();
      }
      return new Promise((res, rej) => {
        const grant = () => {
          signal?.removeEventListener("abort", onAbort);
          inflight++;
          res();
        };
        const onAbort = () => {
          const i = waiters.indexOf(grant);
          if (i >= 0) waiters.splice(i, 1);
          rej(new DOMException("translate aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort);
        waiters.push(grant);
      });
    },
    release(): void {
      inflight--;
      pump();
    },
  };
}

const mainPool = makeLimiter(poolFor(FALLBACK.mainParallel));
const auxPool = makeLimiter(poolFor(FALLBACK.auxParallel));

/// How many requests this module will hold in flight against each server.
///
/// Read these rather than re-deriving the number anywhere else: booktranslate
/// sizes its worker pools off them (booktranslate.ts:81), and a worker pool
/// larger than the request pool does not translate anything faster — it queues
/// inside acquire() while claiming on screen that more is happening. They are
/// FUNCTIONS and not constants because the IPC below can still raise them after
/// this module has finished loading.
export const draftPoolSize = (): number => mainPool.size();
export const auxPoolSize = (): number => auxPool.size();

/// One aux slot's share of `-c`, for callers that BUILD a prompt rather than
/// send one. `auxComplete` already clamps what it is given (auxBudget), but a
/// clamp at the wire can only shorten the REPLY — by then the prompt is
/// assembled and a paragraph that did not fit has already lost the room its own
/// echo needs. styleguide's planStyleEdit prices the whole request against this
/// number instead, and declines a paragraph it cannot serve honestly rather
/// than sending one that will come back truncated.
///
/// A function for the same reason draftPoolSize is: readSlots() below can still
/// raise it after this module has loaded, and a caller that captured it into a
/// constant would price against the fallback for the rest of the session.
export const auxSlotSize = (): number => auxSlot();

// Ask the Rust side what it actually spawned — how many slots AND how much
// context each slot got — and re-price everything against the answer.
//
// Two numbers in two languages have to agree, and the only way they agree for
// certain is if one of them is read from the other; `LlamaSlots` in
// src-tauri/src/lib.rs states the same invariant from the spawn's end, which is
// why the command exists at all. The comment there has always claimed that
// translate.ts derives its caps from `main_ctx_per_slot`; until this change the
// claim was false — the pools read `main_parallel` and the caps were hardcoded
// at four separate sites. Both halves of the record are consumed now, which is
// what makes the claim true.
//
// Module scope and fire-and-forget, the way ModelSetup's aux_lease_reset is: it
// has to land before any surface can take a slot, and it must not re-fire when a
// panel remounts.
//
// NOTHING WAITS FOR IT, and nothing needs to. A request that beats the answer
// runs under FALLBACK — the spawn's own values, copied — and a probe that fails
// leaves both pools and both slot sizes exactly where a successful one would
// have. The failure direction is the conservative one this whole file takes: too
// few requests in flight is slow, never wrong, and a slot size that is too small
// clips a context block rather than overrunning the server.
if (IS_TAURI) {
  void invoke<{
    main_parallel: number;
    main_ctx_per_slot: number;
    aux_parallel: number;
    aux_ctx_per_slot: number;
  }>("llama_slots").then(
    (s) => {
      if (s.main_parallel > 0) mainPool.setMax(poolFor(s.main_parallel));
      if (s.aux_parallel > 0) auxPool.setMax(poolFor(s.aux_parallel));
      if (s.main_ctx_per_slot > 0) mainCtxPerSlot = s.main_ctx_per_slot;
      if (s.aux_ctx_per_slot > 0) auxCtxPerSlot = s.aux_ctx_per_slot;
    },
    (e) => {
      // Plain browser (vite dev, `?test=`), or a build without the command:
      // FALLBACK stands, and FALLBACK is the only copy of these numbers that can
      // be wrong. Said out loud in dev, because a stale fallback is invisible
      // otherwise — the pane keeps working, it just budgets against a slot the
      // server does not have.
      if (import.meta.env.DEV) {
        console.warn("llama_slots unavailable — budgeting against FALLBACK", FALLBACK, e);
      }
    },
  );
}

function acquireSlot(signal?: AbortSignal): Promise<void> {
  return mainPool.acquire(signal);
}

function releaseSlot(): void {
  mainPool.release();
}

// The body every /completion request on 11544 sends. `stop` carries BOTH turn
// markers: <end_of_turn> is how the model ends its turn, and <start_of_turn> is
// the belt-and-braces catch for a reply that runs past it and starts inventing
// the next exchange — a shape a hand-formatted prompt can provoke and a chat
// endpoint would have hidden from us. cache_prompt lets the server keep the
// prefix it has already prefilled, which is worth having even here where only
// the head line and (usually) the term block are invariant between paragraphs.
const draftBody = (prompt: string, srcLen: number) => ({
  prompt,
  n_predict: draftBudget(prompt, srcLen),
  stop: ["<end_of_turn>", "<start_of_turn>"],
  cache_prompt: true,
  ...DRAFT_SAMPLING,
});

// single non-streaming completion for an already-built prompt, drawing from
// the shared budget (glossarygen's retry framing needs this raw entry point).
// Failure taxonomy, unchanged from the /v1/chat/completions days and load-bearing
// for booktranslate's retry policy: aborts pass through untouched; anything
// network-shaped (fetch rejection, 502/503/504, connection dropped mid-body)
// becomes ModelUnavailableError; other non-ok statuses stay plain Errors.
//
// srcLen is the length of the text being TRANSLATED, not of the prompt — see
// draftBudget. It defaults to 400 for the one caller that has no such text:
// glossarygen's term-retry ladder (glossarygen.ts:1881), whose input is a single
// term and whose reply is one quoted phrase, so 456 tokens is far more than it
// can use.
export async function completeRaw(
  prompt: string,
  signal?: AbortSignal,
  opts?: { srcLen?: number },
): Promise<string> {
  await acquireSlot(signal);
  try {
    let resp: Response;
    try {
      resp = await fetch(`${BASE}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftBody(prompt, opts?.srcLen ?? 400)),
        signal,
      });
    } catch (e) {
      if (isAbortErr(e) || signal?.aborted) throw e;
      throw new ModelUnavailableError(String(e)); // refused / reset / unreachable
    }
    if (UNAVAILABLE_STATUS.has(resp.status)) throw new ModelUnavailableError(`HTTP ${resp.status}`);
    if (!resp.ok) throw new Error(`llama-server HTTP ${resp.status}`);
    let data: { content?: string };
    try {
      data = (await resp.json()) as typeof data;
    } catch (e) {
      if (isAbortErr(e) || signal?.aborted) throw e;
      throw new ModelUnavailableError(`response body lost: ${String(e)}`); // connection died mid-response
    }
    // /completion answers with a flat `content` string, not choices[0].message.
    return (data.content ?? "").trim();
  } finally {
    releaseSlot();
  }
}

// ---- output gates -----------------------------------------------------------
//
// Both are exported rather than applied here, because completeRaw is also the
// glossary ladder's entry point and a three-word term legitimately produces a
// reply several times its own length. The caller that knows what it sent is the
// caller that can judge the answer; booktranslate applies both.

/// A reply far longer than its source is the degenerate-loop shape: the model
/// stops translating and starts repeating, usually on a term the glossary block
/// told it to keep. 3× plus 200 characters clears the honest expansion of
/// English into Russian (~1.3×) with room to spare, so anything past it is not a
/// translation of this paragraph.
export function looksRunaway(src: string, out: string): boolean {
  return out.length > src.length * 3 + 200;
}

/// Did the model translate the reference block instead of skipping it?
///
/// This is the one real risk the continuity blocks introduce: TranslateGemma is
/// a pure MT model, and «do not translate it and do not repeat it» is an
/// instruction, not a guarantee. The failure has a specific and quiet shape —
/// the reply opens with a copy of trPrev and then goes on to translate the
/// actual paragraph. looksRunaway cannot see it: a 400-character source with a
/// 700-character reference block yields ~1100 characters against a 1400
/// ceiling, so the paragraph is written to the store and shipped to the reader
/// with the previous paragraph glued to its front.
///
/// The detector is free, because trPrev is a string we already hold: compare the
/// reply's first trPrev.length characters against trPrev itself. outDice takes
/// ALREADY-normalised strings and does no normalisation of its own — every call
/// site in this project is outDice(outNorm(a), outNorm(b)) (glossarygen.ts:1405).
///
/// The floor exists because Dice over two short strings is noise: a 20-character
/// trPrev that happens to be a section heading would match half the paragraphs
/// in the book. 0.8 rather than OUT_MATCH's 0.75 because this gate discards a
/// finished translation, so it should fire on a near-copy and not on a
/// coincidence of vocabulary.
const ECHO_PREFIX_SIM = 0.8;
const ECHO_MIN_CHARS = 40;

export function echoesPrev(out: string, trPrev?: string): boolean {
  if (!trPrev || !out) return false;
  const prev = outNorm(trPrev);
  const head = outNorm(out.slice(0, trPrev.length));
  if (prev.length < ECHO_MIN_CHARS || head.length < ECHO_MIN_CHARS) return false;
  return outDice(head, prev) > ECHO_PREFIX_SIM;
}

// ---- aux client (Gemma-4-26B-A4B-it on 11545) -------------------------------
// Chat-style completion against the on-demand aux server. It is one set of
// weights serving three consumers — the style edit, every glossary pass, and
// graphgen's typing calls — which is why they all share auxPool's single budget
// (auxPoolSize(), 3 against that server's `--parallel 4`) rather than each
// opening their own.
//
// `chat_template_kwargs: { enable_thinking: false }` is GONE with Qwen3.5: it
// was that model's switch for its hybrid-thinking mode, and Gemma's template
// does not read the key at all — sending it would be a no-op that reads like a
// live setting. The <think> stripping below stays, as a net that now costs
// nothing and catches any future model that opens with one.
//
// Low temperature throughout: term rendering wants the ESTABLISHED equivalent,
// not creativity, and a style edit wants the smallest correction that fixes the
// sentence.

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/// `max_tokens` for a request to 11545, clamped to what the measured prompt
/// leaves in ONE aux slot — 4096 cells at the shipped `--parallel 4 -c 16384`,
/// read off `llama_slots` like the draft server's 3072.
///
/// The same arithmetic as draftBudget, on the server that carries the largest
/// prompts in the app: styleguide's invariant block (the guide plus the book's
/// term list) is about 2100 tokens before the paragraph is added, and
/// glossarygen and graphgen send batched lists against the same weights.
///
/// It does NOT shorten a reply the server would otherwise have finished. The
/// slot is the same boundary either way, and a generation that reaches it stops
/// there whatever max_tokens said; what this buys is that the stopping point is
/// ours and stated, and that a request is never sent asking for room the slot
/// does not have. The callers' own figures — styleguide's styleBudget,
/// graphgen's per-chunk count — stay the WANT and are untouched: this only ever
/// lowers them, and never below draftBudget's floor, for the same reason (0 and
/// negative both mean something other than «a short answer» to llama-server).
const auxBudget = (prompt: string, want: number): number => {
  const slot = auxSlot();
  return Math.max(REPLY_MIN, Math.min(want, slot - ctxMargin(slot) - estTokens(prompt)));
};

/// Fold a leading system message into the head of the first user message,
/// separated by a blank line.
///
/// Nothing about the callers changes — glossarygen and graphgen keep writing
/// system + user — but nothing downstream then depends on how gemma-4's jinja
/// chooses to treat a system role. Gemma's template family has historically had
/// no system role at all and implementations differ on whether they prepend it,
/// merge it, or drop it on the floor; dropping it silently would strip the
/// instruction and leave the model answering a bare question, which looks like a
/// bad model rather than a bad request. Folding is behaviour-neutral for any
/// template that would have merged it anyway, and it removes the whole class.
function foldSystem(messages: ChatMessage[]): ChatMessage[] {
  if (messages[0]?.role !== "system") return messages;
  const [sys, ...rest] = messages;
  const i = rest.findIndex((m) => m.role === "user");
  if (i < 0) return [{ role: "user", content: sys.content }, ...rest];
  const out = [...rest];
  out[i] = { role: "user", content: `${sys.content}\n\n${out[i].content}` };
  return out;
}

export async function auxComplete(
  messages: ChatMessage[],
  signal?: AbortSignal,
  // maxTokens defaults to 512 — plenty for one term's rendering, and far too
  // little for a caller that asks for a dozen answers in one reply (graphgen's
  // typing chunks), where the truncation would look like a model that simply
  // stopped answering halfway down the list.
  opts?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  await auxPool.acquire(signal);
  try {
    // Folded once and then both sent and measured — the budget has to be priced
    // against the bytes that actually go on the wire, not against the caller's
    // pre-fold list.
    const msgs = foldSystem(messages);
    const resp = await fetch(`${AUX_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: msgs,
        temperature: opts?.temperature ?? 0.2,
        top_p: 0.8,
        max_tokens: auxBudget(
          msgs.map((m) => m.content).join("\n\n"),
          opts?.maxTokens ?? 512,
        ),
      }),
      signal,
    });
    if (!resp.ok) throw new Error(`aux llama-server HTTP ${resp.status}`);
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    let text = (data.choices?.[0]?.message?.content ?? "").trim();
    // safety net: closed think block → strip; unclosed (truncated) → unusable
    text = text.replace(/^<think>[\s\S]*?<\/think>\s*/i, "").trim();
    if (/^<think>/i.test(text)) return "";
    return text;
  } finally {
    auxPool.release();
  }
}

/// One style-edit call: a single user message carrying the whole prompt
/// styleguide.ts assembled, and completeRaw's FULL failure taxonomy.
///
/// WHY NOT auxComplete. auxComplete collapses every non-ok status into a plain
/// Error (:1249 above), which is right for a glossary pass that simply skips a
/// term it could not render. The style pass has to tell «the 13.3 GB of MoE
/// weights are still faulting in» (503) from «that request was malformed» (400):
/// the first is worth waiting on, the second must never be retried, and both
/// arrive on the same code path. So the taxonomy is the translator's, not the
/// terminologist's — ModelUnavailableError for a fetch rejection, 502/503/504
/// and a body lost mid-response; a plain Error for anything else.
///
/// cache_prompt is set EXPLICITLY. styleguide.ts:283-291 orders the prompt so
/// the ~600-token guide is byte-identical at the front of every paragraph's
/// request, which is worth nothing at all unless the server keeps the prefix it
/// prefilled; whether /v1/chat/completions defaults it to true varies by build,
/// and the engine on this machine is now the CUDA build 10581 (it was the Vulkan
/// build 10453 when this line was written). If this line is ever removed, the
/// ordering argument in styleguide.ts goes with it.
///
/// temperature 0.2 / top_p 0.9 rather than the draft's greedy: an editor
/// choosing between «модели» and «модель» in a case it must infer is doing
/// something closer to writing than to decoding, and a hard-greedy 26B tends to
/// return the input unchanged rather than commit. It is not greedy, so the pass
/// is not bit-reproducible — which is fine, because the store keeps trRaw and a
/// re-run edits the draft again rather than the edit.
export async function styleComplete(
  prompt: string,
  signal?: AbortSignal,
  opts?: { maxTokens?: number },
): Promise<string> {
  await auxPool.acquire(signal);
  try {
    let resp: Response;
    try {
      resp = await fetch(`${AUX_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          top_p: 0.9,
          max_tokens: auxBudget(prompt, opts?.maxTokens ?? 512),
          cache_prompt: true,
        }),
        signal,
      });
    } catch (e) {
      if (isAbortErr(e) || signal?.aborted) throw e;
      throw new ModelUnavailableError(String(e)); // refused / reset / unreachable
    }
    if (UNAVAILABLE_STATUS.has(resp.status)) throw new ModelUnavailableError(`HTTP ${resp.status}`);
    if (!resp.ok) throw new Error(`aux llama-server HTTP ${resp.status}`);
    let data: { choices?: { message?: { content?: string } }[] };
    try {
      data = (await resp.json()) as typeof data;
    } catch (e) {
      if (isAbortErr(e) || signal?.aborted) throw e;
      throw new ModelUnavailableError(`response body lost: ${String(e)}`); // connection died mid-response
    }
    let text = (data.choices?.[0]?.message?.content ?? "").trim();
    text = text.replace(/^<think>[\s\S]*?<\/think>\s*/i, "").trim();
    if (/^<think>/i.test(text)) return "";
    return text;
  } finally {
    auxPool.release();
  }
}

/// Everything a caller may add to a draft request.
///
/// `context` KEEPS ITS OLD MEANING — «the sentence this text sits inside» — and
/// maps to DraftContext.sentence, so TranslatePopover (:346) and glossarygen's
/// term ladder (:1881) need no thought and no edit. The three new fields are
/// what booktranslate fills in; every one of them is optional, and a call that
/// passes none produces the same single-paragraph prompt it always did.
export type TranslateOpts = {
  context?: string;
  srcPrev?: string;
  trPrev?: string;
  srcLang?: string;
  signal?: AbortSignal;
};

const draftCtx = (o?: TranslateOpts): DraftContext | undefined =>
  o && (o.context || o.srcPrev || o.trPrev)
    ? { sentence: o.context, srcPrev: o.srcPrev, trPrev: o.trPrev }
    : undefined;

// non-streaming variant (batch book translation): same prompt/sampling as
// translateStream, resolves with the whole translation
export async function translate(
  text: string,
  glossary: GlossaryEntry[],
  opts?: TranslateOpts,
): Promise<string> {
  return completeRaw(buildDraftPrompt(text, glossary, draftCtx(opts), opts?.srcLang), opts?.signal, {
    srcLen: text.length,
  });
}

export async function translateStream(
  text: string,
  glossary: GlossaryEntry[],
  onDelta: (chunk: string) => void,
  opts?: TranslateOpts,
): Promise<string> {
  await acquireSlot(opts?.signal); // slot held until the stream finishes
  try {
    const resp = await fetch(`${BASE}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...draftBody(buildDraftPrompt(text, glossary, draftCtx(opts), opts?.srcLang), text.length),
        stream: true,
      }),
      signal: opts?.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`llama-server HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return full;
        try {
          const ev = JSON.parse(data) as {
            content?: string;
            stop?: boolean;
            choices?: { delta?: { content?: string } }[];
          };
          // TWO SHAPES. /completion streams {"content":"…","stop":false} and
          // marks the last event with stop:true rather than a [DONE] sentinel;
          // the OAI delta shape below it is what /v1/chat/completions sent and
          // is kept only so a dev stub pointed at pdfer:dev:llamabase can speak
          // either. `content` is checked first because that is the live path.
          const chunk = ev.content ?? ev.choices?.[0]?.delta?.content;
          if (chunk) {
            full += chunk;
            onDelta(chunk);
          }
          if (ev.stop === true) return full;
        } catch {
          // partial/keepalive line — ignore
        }
      }
    }
    return full;
  } finally {
    releaseSlot();
  }
}
