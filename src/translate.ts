// Client for the local llama-server (HY-MT1.5-7B) at 127.0.0.1:11544.
// Prompt formats follow the model card (huggingface.co/tencent/HY-MT1.5-7B):
//   basic XX<=>XX:  "Translate the following segment into {lang}, without additional explanation.\n\n{text}"
//   terminology:    "参考下面的翻译：\n{src} 翻译成 {dst}\n\n将以下文本翻译为{lang}，注意只需要输出翻译后的结果，不要额外解释：\n{text}"
//   contextual:     "{context}\n参考上面的信息，把下面的文本翻译成{lang}，注意不需要翻译上文，也不要额外解释：\n{text}"
// The chat template lives in the GGUF, so plain messages:[{role:"user",...}] is correct transport.

const BASE = "http://127.0.0.1:11544";
const TARGET_EN = "Russian"; // English-worded template
const TARGET_ZH = "俄语"; // Chinese-worded templates (terminology/contextual are documented only in Chinese)

export type GlossaryEntry = { src: string; dst: string };

export async function isServerUp(timeoutMs = 1200): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

// ---- glossary storage: localStorage "pdfer:glossary:<bookPath>", one "термин = перевод" per line

export function loadGlossaryText(bookPath: string): string {
  return localStorage.getItem(`pdfer:glossary:${bookPath}`) ?? "";
}

export function saveGlossaryText(bookPath: string, text: string): void {
  const key = `pdfer:glossary:${bookPath}`;
  if (text.trim()) localStorage.setItem(key, text);
  else localStorage.removeItem(key);
}

// lenient line parse: "термин = перевод", also "->", "→", "—" as separators
export function parseGlossary(text: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(.+?)\s*(?:=|->|→|—)\s*(.+?)\s*$/);
    if (m) out.push({ src: m[1], dst: m[2] });
  }
  return out;
}

// only entries whose source term actually occurs in the text (case-insensitive)
function matched(text: string, glossary: GlossaryEntry[]): GlossaryEntry[] {
  const lower = text.toLowerCase();
  return glossary.filter((g) => g.src && lower.includes(g.src.toLowerCase()));
}

export function buildPrompt(text: string, glossary: GlossaryEntry[], context?: string): string {
  const terms = matched(text, glossary);
  const termBlock = terms.length
    ? `参考下面的翻译：\n${terms.map((t) => `${t.src} 翻译成 ${t.dst}`).join("\n")}\n\n`
    : "";
  if (context) {
    return `${termBlock}${context}\n参考上面的信息，把下面的文本翻译成${TARGET_ZH}，注意不需要翻译上文，也不要额外解释：\n${text}`;
  }
  if (termBlock) {
    return `${termBlock}将以下文本翻译为${TARGET_ZH}，注意只需要输出翻译后的结果，不要额外解释：\n${text}`;
  }
  return `Translate the following segment into ${TARGET_EN}, without additional explanation.\n\n${text}`;
}

// sampling per the HY-MT1.5 model card
const SAMPLING = { temperature: 0.7, top_k: 20, top_p: 0.6, repeat_penalty: 1.05 };

// non-streaming variant (batch book translation): same prompt/sampling as
// translateStream, resolves with the whole translation
export async function translate(
  text: string,
  glossary: GlossaryEntry[],
  opts?: { context?: string; signal?: AbortSignal },
): Promise<string> {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: buildPrompt(text, glossary, opts?.context) }],
      ...SAMPLING,
    }),
    signal: opts?.signal,
  });
  if (!resp.ok) throw new Error(`llama-server HTTP ${resp.status}`);
  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

export async function translateStream(
  text: string,
  glossary: GlossaryEntry[],
  onDelta: (chunk: string) => void,
  opts?: { context?: string; signal?: AbortSignal },
): Promise<string> {
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
}
