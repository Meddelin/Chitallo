// Client for the local llama-server (HY-MT1.5-7B) at 127.0.0.1:11544.
// Prompt formats follow the model card (huggingface.co/tencent/HY-MT1.5-7B):
//   basic XX<=>XX:  "Translate the following segment into {lang}, without additional explanation.\n\n{text}"
//   terminology:    "参考下面的翻译：\n{src} 翻译成 {dst}\n\n将以下文本翻译为{lang}，注意只需要输出翻译后的结果，不要额外解释：\n{text}"
//   contextual:     "{context}\n参考上面的信息，把下面的文本翻译成{lang}，注意不需要翻译上文，也不要额外解释：\n{text}"
// The chat template lives in the GGUF, so plain messages:[{role:"user",...}] is correct transport.

import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
import { bookKey } from "./bookid";
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
// Files under <appDataDir>\glossaries\<key>.txt, one "термин = перевод" per
// line, named by the same durable content key as translation stores (path-hash
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

async function writeGlossFile(bookPath: string, text: string): Promise<void> {
  if (text.trim()) {
    await mkdir(await glossDir(), { recursive: true }).catch(() => {});
    await writeFile(await glossFile(bookPath), new TextEncoder().encode(text));
  } else {
    await remove(await glossFile(bookPath)).catch(() => {});
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

export function saveGlossaryText(bookPath: string, text: string): void {
  if (!IS_TAURI) {
    if (text.trim()) localStorage.setItem(glossLsKey(bookPath), text);
    else localStorage.removeItem(glossLsKey(bookPath));
    return;
  }
  glossCache.set(bookPath, text);
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

// lenient line parse: "термин = перевод", also "->", "→", "—" as separators.
// A dst of "?" is the glossary generator's "needs manual entry" placeholder —
// the line stays visible in the textarea but is never fed into prompts.
export function parseGlossary(text: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(.+?)\s*(?:=|->|→|—)\s*(.+?)\s*$/);
    if (m && m[2] !== "?") out.push({ src: m[1], dst: m[2] });
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
  opts?: { temperature?: number },
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
        max_tokens: 512,
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
