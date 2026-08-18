import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { CheckIcon, CopyIcon, RefreshCcwIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { Loader } from "@/components/ai-elements/loader";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { IconClose } from "./icons";

// ---- «Спросить»: chat sidebar over headless Claude Code ---------------------
//
// UI: shadcn AI components (shadcn.io/ai patterns — Conversation, Message,
// Response, Actions, Prompt Input, Loader, Suggestion) restyled to the app's
// pill aesthetic. Assistant answers render as STREAMING markdown (Streamdown
// inside MessageResponse; raw HTML is never executed — the hardened renderer
// drops it).
//
// Transport: the Rust `ask_claude` command spawns claude.exe (-p stream-json)
// and forwards every stdout NDJSON line RAW over a tauri Channel. This
// component owns the whole NDJSON contract:
//   stream_event/content_block_delta/text_delta  → token stream
//   result (always present, synthetic if needed) → final text, session_id,
//                                                  is_error/subtype
// One ask at a time (Rust rejects "busy: ..."). Cancel = ask_claude_cancel →
// the stream still terminates with a synthetic cancelled result line.
//
// Per-book persistence (localStorage):
//   pdfer:claude:<bookPath>       — Claude session id (--resume across turns)
//   pdfer:claude:hist:<bookPath>  — last ≤50 messages of the thread
// History migration: records written before the shadcn rebuild carry no `md`
// flag — they were produced under a "plain text only" persona and keep
// rendering as pre-wrapped plain text. New assistant messages set md: true and
// render as markdown.
//
// Outside Tauri (plain-browser ?test= debugging) sends are answered with an
// honest «доступно только в приложении» message — unless a dev mock is set:
//   window.__pdferAskMock = string[] | (prompt) => string[]   // NDJSON lines
//   window.__pdferAskMockDelay = ms per line (default 35)

// seed = a selection-initiated ask: quote + auto-extracted page context; shown
// as a removable chip above the input, consumed by the next sent message.
// `id` makes every «Спросить» click a fresh object so the consume effect fires.
export type AskSeed = { id: number; quote: string; page?: number; pageText?: string };

type Msg = {
  role: "user" | "assistant";
  text: string;
  quote?: string; // user: the selection this message asked about
  page?: number;
  error?: boolean; // assistant: error text (muted red)
  cancelled?: boolean; // assistant: partial answer kept after a cancel
  md?: boolean; // assistant: markdown (post-rebuild records; old ones are plain)
};

// minimal shape of the NDJSON lines this component reads
type NdLine = {
  type?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
};

type MockLines = string[] | ((prompt: string) => string[]);

const HIST_LIMIT = 50;
const DEFAULT_Q = "Объясни этот фрагмент";
// static follow-up chips after a completed answer — no extra model calls
const SUGGESTIONS = ["Объясни проще", "Приведи пример", "Как это связано с темой книги?"];
const isTauri = "__TAURI_INTERNALS__" in window;

const sidKey = (p: string) => `pdfer:claude:${p}`;
const histKey = (p: string) => `pdfer:claude:hist:${p}`;

function loadHist(p: string): Msg[] {
  try {
    const v = JSON.parse(localStorage.getItem(histKey(p)) ?? "[]");
    return Array.isArray(v) ? (v as Msg[]) : [];
  } catch {
    return [];
  }
}
const saveHist = (p: string, m: Msg[]) => localStorage.setItem(histKey(p), JSON.stringify(m.slice(-HIST_LIMIT)));

const getMock = (): MockLines | undefined =>
  import.meta.env.DEV ? (window as unknown as { __pdferAskMock?: MockLines }).__pdferAskMock : undefined;

async function replayMock(lines: string[], onLine: (l: string) => void, isCancelled: () => boolean) {
  const delay = Number((window as unknown as { __pdferAskMockDelay?: unknown }).__pdferAskMockDelay) || 35;
  for (const l of lines) {
    if (isCancelled()) return;
    onLine(l);
    await new Promise((r) => setTimeout(r, delay));
  }
}

// RU reading-assistant persona; goes to claude.exe --append-system-prompt
const sysPrompt = (title: string) =>
  `Ты — помощник в PDF-читалке. Пользователь читает книгу «${title}» (обычно на английском) и задаёт вопросы о ней по-русски. ` +
  `Отвечай на русском, кратко и по существу. Если вопрос про выделенный фрагмент — объясняй именно его в контексте книги. ` +
  `Ссылайся на номера страниц, когда это уместно. Уместна умеренная markdown-разметка (списки, выделение); без заголовков без необходимости.`;

export function AskSidebar({
  open,
  bookPath,
  bookTitle,
  page,
  seed,
  onClose,
}: {
  open: boolean;
  bookPath: string;
  bookTitle: string;
  // current page — book context for the first message of a fresh thread
  page: number;
  seed: AskSeed | null;
  onClose: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>(() => loadHist(bookPath));
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<AskSeed | null>(null);
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState(""); // streamed text of the in-flight answer
  const [copied, setCopied] = useState(-1); // msg index with the «Скопировано» state

  const msgsRef = useRef(msgs);
  const busyRef = useRef(false);
  const streamRef = useRef("");
  const resultRef = useRef<NdLine | null>(null);
  const cancelledRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pathRef = useRef(bookPath);
  pathRef.current = bookPath;

  // append + persist; a book switched mid-flight still gets its answer stored
  const push = (path: string, m: Msg) => {
    if (pathRef.current === path) {
      msgsRef.current = [...msgsRef.current, m].slice(-HIST_LIMIT);
      saveHist(path, msgsRef.current);
      setMsgs(msgsRef.current);
    } else {
      saveHist(path, [...loadHist(path), m]);
    }
  };

  // book switch: drop any in-flight ask, load the new book's thread
  useEffect(() => {
    if (busyRef.current) {
      cancelledRef.current = true;
      if (isTauri) invoke("ask_claude_cancel").catch(() => {});
    }
    msgsRef.current = loadHist(bookPath);
    setMsgs(msgsRef.current);
    setPending(null);
    setStream("");
    setInput("");
  }, [bookPath]);

  // unmount (book closed) with an ask in flight: kill the child
  useEffect(
    () => () => {
      if (busyRef.current) {
        cancelledRef.current = true;
        if (isTauri) invoke("ask_claude_cancel").catch(() => {});
      }
    },
    [],
  );

  // focus the input when the user opens the sidebar (not on a restored mount)
  const prevOpen = useRef(open);
  useEffect(() => {
    if (open && !prevOpen.current) taRef.current?.focus();
    prevOpen.current = open;
  }, [open]);

  // consume a selection ask: show the chip, focus the input
  useEffect(() => {
    if (!seed) return;
    setPending(seed);
    taRef.current?.focus();
  }, [seed]);

  const cancel = () => {
    cancelledRef.current = true;
    if (isTauri) invoke("ask_claude_cancel").catch(() => {});
  };

  const newThread = () => {
    if (busyRef.current) return;
    localStorage.removeItem(sidKey(bookPath));
    localStorage.removeItem(histKey(bookPath));
    msgsRef.current = [];
    setMsgs([]);
    taRef.current?.focus();
  };

  // core ask: q is the question text, pend the (already detached) seed.
  // The form path consumes the pending chip; suggestion/repeat sends pass null
  // and leave any pending chip for the next manual message.
  const ask = async (q: string, pend: AskSeed | null) => {
    if (busyRef.current || !q) return;
    const path = bookPath;
    const sid = localStorage.getItem(sidKey(path));

    // the thread shows only the question + quote chip; the prompt below carries
    // the delimited context (selection, surrounding page text, book/page)
    push(path, { role: "user", text: q, quote: pend?.quote, page: pend?.page });

    let prompt: string;
    if (pend) {
      prompt =
        `Фрагмент из книги «${bookTitle}»${pend.page ? ` (страница ${pend.page})` : ""}:\n<<<\n${pend.quote}\n>>>\n\n` +
        (pend.pageText ? `Окружающий текст страницы:\n<<<\n${pend.pageText}\n>>>\n\n` : "") +
        `Вопрос: ${q}`;
    } else if (!sid) {
      prompt = `Читаю книгу «${bookTitle}», сейчас открыта страница ${page}.\n\n${q}`;
    } else {
      prompt = q; // follow-up: the resumed session already has the context
    }

    busyRef.current = true;
    setBusy(true);
    streamRef.current = "";
    setStream("");
    resultRef.current = null;
    cancelledRef.current = false;

    const onLine = (line: string) => {
      let j: NdLine;
      try {
        j = JSON.parse(line) as NdLine;
      } catch {
        return;
      }
      if (j.type === "stream_event") {
        const ev = j.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          streamRef.current += ev.delta.text;
          if (pathRef.current === path) setStream(streamRef.current);
        }
      } else if (j.type === "result") {
        resultRef.current = j;
      }
    };

    try {
      const mock = getMock();
      if (mock) {
        await replayMock(typeof mock === "function" ? mock(prompt) : mock, onLine, () => cancelledRef.current);
      } else if (isTauri) {
        const ch = new Channel<string>();
        ch.onmessage = onLine;
        await invoke("ask_claude", {
          prompt,
          sessionId: sid ?? undefined,
          systemPrompt: sysPrompt(bookTitle),
          onEvent: ch,
        });
      } else {
        push(path, { role: "assistant", text: "Вопросы к Claude доступны только в приложении pdfer", error: true });
        return;
      }
      // assertion: TS narrows the ref to its pre-await null, blind to onLine's writes
      const r = resultRef.current as NdLine | null;
      if (r && !r.is_error) {
        push(path, { role: "assistant", text: r.result || streamRef.current || "(пустой ответ)", md: true });
        if (r.session_id) localStorage.setItem(sidKey(path), r.session_id);
      } else if ((cancelledRef.current || r?.subtype === "cancelled") && streamRef.current) {
        push(path, { role: "assistant", text: streamRef.current, cancelled: true, md: true });
      } else if (r) {
        push(path, { role: "assistant", text: r.result || `Ошибка: ${r.subtype ?? "неизвестная"}`, error: true });
      } else if (cancelledRef.current) {
        push(path, { role: "assistant", text: "Запрос отменён", error: true });
      } else {
        push(path, { role: "assistant", text: "Ответ не получен", error: true });
      }
    } catch (e) {
      const s = String(e);
      const text = s.startsWith("claude_not_found")
        ? `Claude Code не найден (${s.slice("claude_not_found:".length).trim()}). ` +
          `Установите его с https://claude.com/claude-code и войдите в аккаунт командой claude.`
        : s.startsWith("busy")
          ? "Уже выполняется другой запрос — дождитесь ответа или остановите его"
          : `Не удалось запустить Claude: ${s}`;
      push(path, { role: "assistant", text, error: true });
    } finally {
      busyRef.current = false;
      setBusy(false);
      setStream("");
    }
  };

  // form submit (Enter / send button): consumes the pending seed chip
  const send = () => {
    if (busyRef.current) return;
    const pend = pending;
    const q = input.trim() || (pend ? DEFAULT_Q : "");
    if (!q) return;
    setPending(null);
    setInput("");
    void ask(q, pend);
  };

  const copyMsg = (i: number, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(i);
    window.setTimeout(() => setCopied((c) => (c === i ? -1 : c)), 1500);
  };

  // «Повторить» on an assistant message: resend the user question that led to it
  const repeat = (i: number) => {
    if (busyRef.current) return;
    for (let k = i - 1; k >= 0; k--) {
      if (msgs[k].role === "user") {
        void ask(msgs[k].text, null);
        return;
      }
    }
  };

  const canAsk = isTauri || !!getMock();
  const sendable = !!input.trim() || !!pending;
  const last = msgs[msgs.length - 1];
  const showSuggestions = !busy && canAsk && !!last && last.role === "assistant" && !last.error;

  return (
    <aside
      data-asksb
      className={`${open ? "flex" : "hidden"} w-[400px] shrink-0 flex-col h-full border-l border-neutral-300/70 dark:border-neutral-700/70 bg-neutral-50 dark:bg-neutral-800 text-sm text-neutral-800 dark:text-neutral-100`}
    >
      <div className="flex items-center gap-2 h-10 px-3.5 border-b border-neutral-200 dark:border-neutral-700 select-none shrink-0">
        <span className="font-medium">Вопросы по книге</span>
        <span className="flex-1" />
        {msgs.length > 0 && (
          <button
            className="text-xs text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-700 dark:hover:text-neutral-200 disabled:text-neutral-300 dark:disabled:text-neutral-600"
            disabled={busy}
            onClick={newThread}
            title="Начать новую беседу — история и память беседы будут очищены"
          >
            Новая беседа
          </button>
        )}
        <button
          className="px-0.5 py-0.5 rounded-md transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10"
          onClick={onClose}
          title="Закрыть (Ctrl+J)"
        >
          <IconClose />
        </button>
      </div>

      <Conversation className="flex-1" initial="instant">
        <ConversationContent className="min-h-full gap-3 px-3.5 py-3">
          {!canAsk && (
            <div className="rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2.5 py-1.5 text-xs">
              Доступно только в приложении
            </div>
          )}
          {msgs.length === 0 && !busy && (
            <ConversationEmptyState className="flex-1 select-none">
              <div className="px-2 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400 whitespace-pre-line">
                {"Выделите фрагмент и нажмите «Спросить» —\nили задайте вопрос о книге здесь"}
              </div>
            </ConversationEmptyState>
          )}
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <Message from="user" key={i}>
                <MessageContent>
                  {m.quote && (
                    <div className="mb-1 border-l-2 border-neutral-400/60 dark:border-neutral-500/60 pl-2 text-xs text-neutral-600 dark:text-neutral-300 line-clamp-3">
                      {m.page ? `стр. ${m.page} — ` : ""}
                      {m.quote}
                    </div>
                  )}
                  {m.text}
                </MessageContent>
              </Message>
            ) : (
              <Message from="assistant" key={i}>
                <MessageContent>
                  {m.md && !m.error ? (
                    <MessageResponse>{m.text}</MessageResponse>
                  ) : (
                    // pre-rebuild history and error texts: plain pre-wrapped text;
                    // errors in muted red (inner span — MessageContent's own
                    // group-[.is-assistant]:text-foreground can't defeat it)
                    <span
                      className={
                        m.error
                          ? "whitespace-pre-wrap text-red-600/90 dark:text-red-400/90"
                          : "whitespace-pre-wrap"
                      }
                    >
                      {m.text}
                    </span>
                  )}
                  {m.cancelled && (
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">(остановлено)</span>
                  )}
                </MessageContent>
                {!m.error && (
                  <MessageActions
                    className={`-ml-1.5 transition-opacity ${
                      i === msgs.length - 1 ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    <MessageAction
                      className="text-neutral-500 dark:text-neutral-400"
                      onClick={() => copyMsg(i, m.text)}
                      tooltip={copied === i ? "Скопировано" : "Копировать"}
                    >
                      {copied === i ? <CheckIcon /> : <CopyIcon />}
                    </MessageAction>
                    <MessageAction
                      className="text-neutral-500 dark:text-neutral-400"
                      disabled={busy}
                      onClick={() => repeat(i)}
                      tooltip="Повторить"
                    >
                      <RefreshCcwIcon />
                    </MessageAction>
                  </MessageActions>
                )}
              </Message>
            ),
          )}
          {busy && (
            <Message data-askstream from="assistant">
              <MessageContent>
                {stream ? (
                  <MessageResponse>{stream}</MessageResponse>
                ) : (
                  <Loader className="text-neutral-500 dark:text-neutral-400" />
                )}
              </MessageContent>
            </Message>
          )}
        </ConversationContent>
        <ConversationScrollButton className="bottom-2 bg-neutral-50 dark:bg-neutral-800 shadow-sm" />
      </Conversation>

      <div className="border-t border-neutral-200 dark:border-neutral-700 p-2.5 shrink-0">
        {showSuggestions && (
          <Suggestions className="mb-1.5">
            {SUGGESTIONS.map((s) => (
              <Suggestion
                className="h-6 px-2.5 text-xs text-neutral-600 dark:text-neutral-300"
                key={s}
                onClick={(q) => void ask(q, null)}
                suggestion={s}
              />
            ))}
          </Suggestions>
        )}
        {pending && (
          <div className="mb-1.5 flex items-start gap-2 rounded-lg bg-neutral-200/70 dark:bg-neutral-700/50 px-2.5 py-1.5 text-xs select-none">
            <div className="flex-1 line-clamp-3 text-neutral-600 dark:text-neutral-300">
              {pending.page ? `стр. ${pending.page}: ` : ""}«{pending.quote}»
            </div>
            <button
              className="text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
              onClick={() => setPending(null)}
              title="Убрать фрагмент"
            >
              <IconClose />
            </button>
          </div>
        )}
        <PromptInput onSubmit={send}>
          <PromptInputTextarea
            onChange={(e) => setInput(e.target.value)}
            placeholder={pending ? DEFAULT_Q : "Вопрос по книге…"}
            ref={taRef}
            rows={1}
            value={input}
          />
          <PromptInputToolbar>
            <PromptInputTools />
            <PromptInputSubmit
              className="size-7"
              disabled={!busy && !sendable}
              onClick={busy ? cancel : undefined}
              status={busy ? (stream ? "streaming" : "submitted") : undefined}
              title={busy ? "Остановить" : "Отправить (Enter)"}
              type={busy ? "button" : "submit"}
            />
          </PromptInputToolbar>
        </PromptInput>
      </div>
    </aside>
  );
}
