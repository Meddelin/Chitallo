// Client for the local llama-server (HY-MT1.5-7B) at 127.0.0.1:11544.
// Prompt formats follow the model card (huggingface.co/tencent/HY-MT1.5-7B):
//   basic XX<=>XX:  "Translate the following segment into {lang}, without additional explanation.\n\n{text}"
//   terminology:    "参考下面的翻译：\n{src} 翻译成 {dst}\n\n将以下文本翻译为{lang}，注意只需要输出翻译后的结果，不要额外解释：\n{text}"
//   contextual:     "{context}\n参考上面的信息，把下面的文本翻译成{lang}，注意不需要翻译上文，也不要额外解释：\n{text}"
// The chat template lives in the GGUF, so plain messages:[{role:"user",...}] is correct transport.

import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readFile, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
import { useCallback, useSyncExternalStore } from "react";
import { bookKey } from "./bookid";
import { parseGlossaryText } from "./glossary";
import { joinPath } from "./host";
import { targetLanguage } from "./i18n";
import { hash } from "./paragraphs";

// Dev/test hook: lets a plain-browser engine run point at a controlled port
// (e.g. a dead one, to exercise the outage path) without touching the real
// server. Read once at module load; dead code in production builds.
const DEV_BASE = import.meta.env.DEV ? localStorage.getItem("pdfer:dev:llamabase") : null;
const BASE = DEV_BASE || "http://127.0.0.1:11544";
const AUX_BASE = "http://127.0.0.1:11545"; // aux terminologist (Qwen3.5-4B), on-demand
// The target language follows the interface language: someone reading Chitallo in
// Russian wants Russian pages. The model card words the basic template in
// English and the terminology/contextual ones in Chinese, so both spellings of
// the language name live side by side (see i18n's TARGET_LANGUAGE).

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

export function buildPrompt(text: string, glossary: GlossaryEntry[], context?: string): string {
  const terms = matched(text, glossary);
  const termBlock = terms.length
    ? `参考下面的翻译：\n${terms.map((t) => `${t.src} 翻译成 ${t.dst}`).join("\n")}\n\n`
    : "";
  if (context) {
    return `${termBlock}${context}\n参考上面的信息，把下面的文本翻译成${targetLanguage().zh}，注意不需要翻译上文，也不要额外解释：\n${text}`;
  }
  if (termBlock) {
    return `${termBlock}将以下文本翻译为${targetLanguage().zh}，注意只需要输出翻译后的结果，不要额外解释：\n${text}`;
  }
  return `Translate the following segment into ${targetLanguage().en}, without additional explanation.\n\n${text}`;
}

// sampling per the HY-MT1.5 model card
const SAMPLING = { temperature: 0.7, top_k: 20, top_p: 0.6, repeat_penalty: 1.05 };

// ---- request budgets --------------------------------------------------------
// ONE pool per SERVER. The 11544 pool is shared by every HY-MT consumer —
// interactive popover, batch book translation, glossary fallback. Combined
// in-flight stays ≤3 against n_slots=4, so the server always has a spare slot
// and two pipelines running at once cannot stack their per-module worker pools
// into 6 concurrent requests. The slot count is the llama-server default and
// its unified KV gives every slot the full context — verified from the server's
// own startup line for the spawn in lib.rs ("n_slots = 4, n_ctx_slot = 4096,
// kv_unified = true"), so concurrency here costs no context per request. The
// aux terminologist (11545) gets its OWN separate ≤3 budget — its requests
// never eat into the translator's slots.

function makeLimiter(max: number) {
  let inflight = 0;
  const waiters: (() => void)[] = [];
  return {
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
      waiters.shift()?.();
    },
  };
}

const mainPool = makeLimiter(3);
const auxPool = makeLimiter(3);

function acquireSlot(signal?: AbortSignal): Promise<void> {
  return mainPool.acquire(signal);
}

function releaseSlot(): void {
  mainPool.release();
}

// single non-streaming completion for an already-built prompt, drawing from
// the shared budget (glossarygen's retry framing needs this raw entry point).
// Failure taxonomy: aborts pass through untouched; anything network-shaped
// (fetch rejection, 502/503/504, connection dropped mid-body) becomes
// ModelUnavailableError; other non-ok statuses stay plain Errors.
export async function completeRaw(prompt: string, signal?: AbortSignal): Promise<string> {
  await acquireSlot(signal);
  try {
    let resp: Response;
    try {
      resp = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }], ...SAMPLING }),
        signal,
      });
    } catch (e) {
      if (isAbortErr(e) || signal?.aborted) throw e;
      throw new ModelUnavailableError(String(e)); // refused / reset / unreachable
    }
    if (UNAVAILABLE_STATUS.has(resp.status)) throw new ModelUnavailableError(`HTTP ${resp.status}`);
    if (!resp.ok) throw new Error(`llama-server HTTP ${resp.status}`);
    let data: { choices?: { message?: { content?: string } }[] };
    try {
      data = (await resp.json()) as typeof data;
    } catch (e) {
      if (isAbortErr(e) || signal?.aborted) throw e;
      throw new ModelUnavailableError(`response body lost: ${String(e)}`); // connection died mid-response
    }
    return (data.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    releaseSlot();
  }
}

// ---- aux terminologist client (Qwen3.5-4B on 11545) -------------------------
// Chat-style completion against the on-demand aux server. Qwen3.5 is a
// hybrid-thinking model: thinking is disabled via chat_template_kwargs
// (supported by this llama-server build — verified empirically), and a leading
// <think> block is stripped anyway as a safety net. Low temperature: term
// rendering wants the ESTABLISHED equivalent, not creativity.

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

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
    const resp = await fetch(`${AUX_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        temperature: opts?.temperature ?? 0.2,
        top_p: 0.8,
        max_tokens: opts?.maxTokens ?? 512,
        chat_template_kwargs: { enable_thinking: false },
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

// non-streaming variant (batch book translation): same prompt/sampling as
// translateStream, resolves with the whole translation
export async function translate(
  text: string,
  glossary: GlossaryEntry[],
  opts?: { context?: string; signal?: AbortSignal },
): Promise<string> {
  return completeRaw(buildPrompt(text, glossary, opts?.context), opts?.signal);
}

export async function translateStream(
  text: string,
  glossary: GlossaryEntry[],
  onDelta: (chunk: string) => void,
  opts?: { context?: string; signal?: AbortSignal },
): Promise<string> {
  await acquireSlot(opts?.signal); // slot held until the stream finishes
  try {
    const resp = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: buildPrompt(text, glossary, opts?.context) }],
        stream: true,
        ...SAMPLING,
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
          const delta: unknown = JSON.parse(data);
          const chunk = (delta as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content;
          if (chunk) {
            full += chunk;
            onDelta(chunk);
          }
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
