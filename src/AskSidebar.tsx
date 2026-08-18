import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  BookOpenIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  LightbulbIcon,
  Link2Icon,
  MessagesSquareIcon,
  RefreshCcwIcon,
  SparklesIcon,
  SquarePenIcon,
  TextQuoteIcon,
  Trash2Icon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
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
import { ASK_W_DEFAULT, ASK_W_MIN, askWMax } from "./askwidth";
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
// Per-book persistence (localStorage), schema v2 — MANY threads per book:
//   pdfer:claude:threads:<bookPath>     index {v,active,items[{id,title,ts,n}]}
//   pdfer:claude:th:<bookPath>:<id>     {sid?, msgs[]}  — sid resumes THIS thread
// v1 kept one thread per book in pdfer:claude:<path> + pdfer:claude:hist:<path>
// and «Новая беседа» deleted it; those keys are now read once by the migration
// and never written again (see loadIndex).
// Record migration: messages written before the shadcn rebuild carry no `md`
// flag — they were produced under a "plain text only" persona and keep
// rendering as pre-wrapped plain text. New assistant messages set md: true and
// render as markdown.
//
// Panel width lives in pdfer:askw (workspace-wide, see useAskWidth) and is
// dragged from the handle on the panel's left edge.
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
// static follow-up chips after a completed answer — no extra model calls.
// Three, wrapping, dismissible: the market rule for chips in a narrow panel
// (cap the visible set, never a hidden scroller, never push the composer down).
// label = what the chip reads (short enough to fit one row at 400 px);
// msg = what is actually sent, since the chip becomes the user's own turn
const SUGGESTIONS: { label: string; msg: string }[] = [
  { label: "Объясни проще", msg: "Объясни проще" },
  { label: "Приведи пример", msg: "Приведи пример" },
  { label: "Связь с темой", msg: "Как это связано с темой книги?" },
];
const isTauri = "__TAURI_INTERNALS__" in window;

// ---- quick commands ---------------------------------------------------------
// «/» in an empty composer opens the menu — the settled convention (ChatGPT,
// Cursor, assistant-ui). Only at position 0: a naked «/» mid-sentence is normal
// Russian («и/или»), and a menu there would be hostile. Picking a command sends
// straight away — this is a reader, not an agent, so no directive chip lingers.
// Menu labels are infinitives (UI voice); the payload is 2nd-person imperative
// because it becomes the user's own turn.
type CmdNeed = "seed" | "answer" | "seedOrAnswer";
type Cmd = { id: string; label: string; icon: LucideIcon; msg: (page: number) => string; need?: CmdNeed };
const COMMANDS: Cmd[] = [
  { id: "explain", label: "Объяснить выделенное", icon: TextQuoteIcon, msg: () => "Объясни этот фрагмент", need: "seed" },
  { id: "term", label: "Определить термин", icon: BookOpenIcon, msg: () => "Что означает этот термин в контексте книги?", need: "seed" },
  { id: "page", label: "Пересказать страницу", icon: FileTextIcon, msg: (p) => `Перескажи страницу ${p} своими словами` },
  { id: "link", label: "Связать с темой книги", icon: Link2Icon, msg: () => "Как это связано с темой книги?", need: "seedOrAnswer" },
  { id: "simpler", label: "Объяснить проще", icon: LightbulbIcon, msg: () => "Объясни проще", need: "answer" },
];
const NEED_SEED = "Сначала выделите фрагмент в книге";
const NEED_ANSWER = "Сначала задайте вопрос";

// header icon button, and the destructive-confirm pair (Settings pattern #11:
// consequence + a red button that names the action + «Отмена»)
const HDR_BTN =
  "rounded-md p-1 text-neutral-500 dark:text-neutral-400 transition-colors hover:bg-neutral-900/5 hover:text-neutral-700 dark:hover:bg-neutral-100/10 dark:hover:text-neutral-200";
// dimmed, inert — but NOT pointer-events-none: the browser draws no `title`
// tooltip over such an element, and these buttons carry their reason («Беседа
// уже пустая») in exactly that tooltip. `disabled` already blocks the click, so
// only the hover paint has to be taken back.
const HDR_BTN_OFF =
  "disabled:text-neutral-300 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-neutral-300 dark:disabled:text-neutral-600 dark:disabled:hover:bg-transparent dark:disabled:hover:text-neutral-600";
const RED_BTN = "-mx-1 px-1 rounded text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/10";
const PLAIN_BTN = "-mx-1 px-1 rounded transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700/70";

// ---- per-book threads (schema v2) -------------------------------------------
// v1 kept exactly ONE thread per book, and «Новая беседа» deleted it. v2 keeps
// a list:
//   pdfer:claude:threads:<path>      {v:2, active, items:[{id,title,ts,n}]}
//   pdfer:claude:th:<path>:<id>      {sid?, msgs[]}     — sid resumes THIS thread
// The v1 keys below are read exactly once, by the migration, and are then left
// untouched forever: a rollback to the previous build still finds the thread
// the user had. Migration is idempotent — it only runs when the index is absent.
const sidKey = (p: string) => `pdfer:claude:${p}`; // v1, read-once
const histKey = (p: string) => `pdfer:claude:hist:${p}`; // v1, read-once
const threadsKey = (p: string) => `pdfer:claude:threads:${p}`;
const threadKey = (p: string, id: string) => `pdfer:claude:th:${p}:${id}`;

const THREAD_LIMIT = 30;
const UNTITLED = "Новая беседа";

type ThreadMeta = { id: string; title: string; ts: number; n: number };
type ThreadIndex = { v: 2; active: string; items: ThreadMeta[] };
type ThreadData = { sid?: string; msgs: Msg[] };

const newThreadId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// «1 сообщение / 2 сообщения / 5 сообщений»
const msgCount = (n: number) => {
  if (!n) return "пусто";
  const t = n % 10;
  const h = n % 100;
  const w = t === 1 && h !== 11 ? "сообщение" : t >= 2 && t <= 4 && (h < 10 || h >= 20) ? "сообщения" : "сообщений";
  return `${n} ${w}`;
};

// title = first user message, per the market convention (ChatGPT/Cloudscape)
function titleOf(msgs: Msg[]): string {
  const first = msgs.find((m) => m.role === "user")?.text.replace(/\s+/g, " ").trim();
  if (!first) return UNTITLED;
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

function loadHist(p: string): Msg[] {
  try {
    const v = JSON.parse(localStorage.getItem(histKey(p)) ?? "[]");
    return Array.isArray(v) ? (v as Msg[]) : [];
  } catch {
    return [];
  }
}

function loadThread(p: string, id: string): ThreadData {
  try {
    const v = JSON.parse(localStorage.getItem(threadKey(p, id)) ?? "null") as ThreadData | null;
    if (v && Array.isArray(v.msgs)) return v;
  } catch {
    /* corrupt record — start this thread empty rather than crash the panel */
  }
  return { msgs: [] };
}
const saveThread = (p: string, id: string, d: ThreadData) =>
  localStorage.setItem(threadKey(p, id), JSON.stringify({ sid: d.sid, msgs: d.msgs.slice(-HIST_LIMIT) }));
const saveMsgs = (p: string, id: string, msgs: Msg[]) => saveThread(p, id, { ...loadThread(p, id), msgs });
const saveSid = (p: string, id: string, sid: string) => saveThread(p, id, { ...loadThread(p, id), sid });

const saveIndex = (p: string, ix: ThreadIndex) => localStorage.setItem(threadsKey(p), JSON.stringify(ix));

/** The book's thread index — migrating the v1 pair on first sight. Never
 *  destructive: the v1 keys stay exactly as they were. */
function loadIndex(p: string): ThreadIndex {
  try {
    const v = JSON.parse(localStorage.getItem(threadsKey(p)) ?? "null") as ThreadIndex | null;
    if (v && v.v === 2 && Array.isArray(v.items) && v.items.length) {
      // an index whose active id vanished (hand-edited storage) still opens
      if (!v.items.some((t) => t.id === v.active)) return { ...v, active: v.items[0].id };
      return v;
    }
  } catch {
    /* fall through to a fresh index */
  }
  const msgs = loadHist(p);
  const sid = localStorage.getItem(sidKey(p)) ?? undefined;
  const id = "t0";
  saveThread(p, id, { sid, msgs });
  const ix: ThreadIndex = { v: 2, active: id, items: [{ id, title: titleOf(msgs), ts: Date.now(), n: msgs.length }] };
  saveIndex(p, ix);
  return ix;
}

/** Write back the meta of one thread (count, title, recency) and re-cap. */
function bumpMeta(p: string, id: string, msgs: Msg[]): ThreadIndex {
  const ix = loadIndex(p);
  const prev = ix.items.find((t) => t.id === id);
  const meta: ThreadMeta = {
    id,
    // a title, once earned from the first user message, never drifts
    title: prev && prev.title !== UNTITLED ? prev.title : titleOf(msgs),
    ts: Date.now(),
    n: msgs.length,
  };
  let items = [meta, ...ix.items.filter((t) => t.id !== id)];
  if (items.length > THREAD_LIMIT) {
    // prune: empty threads first, then the least recently touched; the open one
    // and the one being written are never candidates
    const dropped = new Set(
      items
        .filter((t) => t.id !== id && t.id !== ix.active)
        .sort((a, b) => (a.n === 0 ? 0 : 1) - (b.n === 0 ? 0 : 1) || a.ts - b.ts)
        .slice(0, items.length - THREAD_LIMIT)
        .map((t) => t.id),
    );
    items = items.filter((t) => !dropped.has(t.id));
    for (const gone of dropped) localStorage.removeItem(threadKey(p, gone));
  }
  const next: ThreadIndex = { ...ix, items };
  saveIndex(p, next);
  return next;
}

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

// VS Code / Cursor grammar: an invisible 8 px strip on the panel edge, a 2 px
// tint on hover or drag, col-resize cursor. No grip dots — they would be the
// only ornamented control in an app of quiet pills (WP-K).
function ResizeHandle({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const raf = useRef(0);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, w: width };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no capture (synthetic pointer): the drag still tracks over the handle */
    }
    // one global flag: kills the toolbar's left-transition (it would lag a
    // frame behind the drag) and keeps the col-resize cursor over the book
    document.documentElement.dataset.askresize = "";
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // the panel is on the RIGHT: dragging left grows it
    const next = d.w - (e.clientX - d.x);
    cancelAnimationFrame(raf.current); // one width write per frame — Conversation re-lays out on every change
    raf.current = requestAnimationFrame(() => onWidth(next));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture was never taken */
    }
    delete document.documentElement.dataset.askresize;
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") onWidth(width + step);
    else if (e.key === "ArrowRight") onWidth(width - step);
    else if (e.key === "Home") onWidth(ASK_W_DEFAULT);
    else return;
    // the keys the handle claims are ITS keys: without stopPropagation the app's
    // window-level reading-keys listener also acts on them (Home scrolled the
    // book back to page 1 while the handle only resized the panel)
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <div
      aria-label="Ширина панели"
      aria-orientation="vertical"
      aria-valuemax={askWMax()}
      aria-valuemin={ASK_W_MIN}
      aria-valuenow={width}
      className="group/rz absolute left-0 top-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize touch-none"
      onDoubleClick={() => onWidth(ASK_W_DEFAULT)}
      onKeyDown={onKeyDown}
      onLostPointerCapture={endDrag}
      onPointerCancel={endDrag}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      role="separator"
      tabIndex={0}
      title="Ширина панели · двойной клик вернёт исходную"
    >
      <div className="pointer-events-none mx-auto h-full w-0.5 bg-transparent transition-colors group-hover/rz:bg-neutral-400/70 group-focus-visible/rz:bg-neutral-400/70 dark:group-hover/rz:bg-neutral-500/70 dark:group-focus-visible/rz:bg-neutral-500/70" />
    </div>
  );
}

export function AskSidebar({
  open,
  bookPath,
  bookTitle,
  page,
  seed,
  width,
  onWidth,
  onClose,
}: {
  open: boolean;
  bookPath: string;
  bookTitle: string;
  // current page — book context for the first message of a fresh thread
  page: number;
  seed: AskSeed | null;
  width: number;
  onWidth: (w: number) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState<ThreadIndex>(() => loadIndex(bookPath));
  const [msgs, setMsgs] = useState<Msg[]>(() => loadThread(bookPath, index.active).msgs);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<AskSeed | null>(null);
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState(""); // streamed text of the in-flight answer
  const [copied, setCopied] = useState(-1); // msg index with the «Скопировано» state
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null); // thread id armed for delete
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdSel, setCmdSel] = useState(0);
  const [sugHideAt, setSugHideAt] = useState(-1); // turn number at which the chips were dismissed

  const msgsRef = useRef(msgs);
  const busyRef = useRef(false);
  const streamRef = useRef("");
  const resultRef = useRef<NdLine | null>(null);
  const cancelledRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pathRef = useRef(bookPath);
  pathRef.current = bookPath;
  const tidRef = useRef(index.active);
  tidRef.current = index.active;
  // monotonic turn counter — the identity «which answer is on screen». msgs.length
  // stops moving once a thread hits HIST_LIMIT, and a dismissal keyed to it would
  // then match every later answer, silencing the chips in that thread forever.
  const turn = useRef(0);

  // append + persist; a book/thread switched mid-flight still gets its answer
  // stored in the thread that asked for it
  const push = (path: string, tid: string, m: Msg) => {
    if (pathRef.current === path && tidRef.current === tid) {
      turn.current += 1;
      msgsRef.current = [...msgsRef.current, m].slice(-HIST_LIMIT);
      saveMsgs(path, tid, msgsRef.current);
      setMsgs(msgsRef.current);
      setIndex(bumpMeta(path, tid, msgsRef.current));
    } else {
      const kept = [...loadThread(path, tid).msgs, m].slice(-HIST_LIMIT);
      saveMsgs(path, tid, kept);
      bumpMeta(path, tid, kept);
    }
  };

  const killInFlight = () => {
    if (!busyRef.current) return;
    cancelledRef.current = true;
    if (isTauri) invoke("ask_claude_cancel").catch(() => {});
  };

  // book switch: drop any in-flight ask, load the new book's threads
  useEffect(() => {
    killInFlight();
    const ix = loadIndex(bookPath);
    setIndex(ix);
    tidRef.current = ix.active;
    msgsRef.current = loadThread(bookPath, ix.active).msgs;
    setMsgs(msgsRef.current);
    setPending(null);
    setStream("");
    setInput("");
    setThreadsOpen(false);
    setConfirmDel(null);
    setCmdOpen(false);
    setSugHideAt(-1);
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

  // outside pointerdown closes the two in-panel menus (the pattern Palette and
  // the toolbar popovers already use — no Radix popover is vendored)
  useEffect(() => {
    if (!threadsOpen && !cmdOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (threadsOpen && !t?.closest("[data-askthreads],[data-askthreadsbtn]")) {
        setThreadsOpen(false);
        setConfirmDel(null);
      }
      // the composer counts as inside: typing the filter must not close the menu
      if (cmdOpen && !t?.closest("[data-askcmd],[data-askcmdbtn],[data-askcomposer]")) setCmdOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [threadsOpen, cmdOpen]);

  // Esc peels the in-panel menus BEFORE the app's chain gets it — and it must
  // do so wherever the focus sits (the app's Esc handler is a bubble-phase
  // window listener that would otherwise close the book while a menu is open)
  useEffect(() => {
    if (!threadsOpen && !cmdOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (cmdOpen) setCmdOpen(false);
      else {
        setThreadsOpen(false);
        setConfirmDel(null);
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [threadsOpen, cmdOpen]);

  // focus the input when the user opens the sidebar (not on a restored mount);
  // hiding it (Ctrl+J) folds the menus away — an invisible open menu would keep
  // swallowing Esc
  const prevOpen = useRef(open);
  useEffect(() => {
    if (open && !prevOpen.current) taRef.current?.focus();
    if (!open) {
      setCmdOpen(false);
      setThreadsOpen(false);
      setConfirmDel(null);
    }
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

  // move to another thread of the same book — never destroys anything
  const openThread = (id: string, ix: ThreadIndex) => {
    killInFlight();
    tidRef.current = id;
    const next = { ...ix, active: id };
    saveIndex(bookPath, next);
    setIndex(next);
    msgsRef.current = loadThread(bookPath, id).msgs;
    setMsgs(msgsRef.current);
    setStream("");
    setCmdOpen(false);
    setSugHideAt(-1);
  };

  // «Новая беседа»: adds a thread, deletes none (v1 wiped the only one there was)
  const newThread = () => {
    if (busyRef.current || msgs.length === 0) return;
    const id = newThreadId();
    saveThread(bookPath, id, { msgs: [] });
    const ix = loadIndex(bookPath);
    openThread(id, { ...ix, items: [{ id, title: UNTITLED, ts: Date.now(), n: 0 }, ...ix.items] });
    setThreadsOpen(false);
    setConfirmDel(null);
    taRef.current?.focus();
  };

  const switchThread = (id: string) => {
    if (id === index.active) {
      setThreadsOpen(false);
      return;
    }
    openThread(id, loadIndex(bookPath));
    setThreadsOpen(false);
    setConfirmDel(null);
    setPending(null);
  };

  const deleteThread = (id: string) => {
    const ix = loadIndex(bookPath);
    const items = ix.items.filter((t) => t.id !== id);
    localStorage.removeItem(threadKey(bookPath, id));
    setConfirmDel(null);
    if (id !== ix.active) {
      const next = { ...ix, items };
      saveIndex(bookPath, next);
      setIndex(next);
      return;
    }
    // deleting the open thread: land in the next most recent one, or a fresh
    // empty one (openThread kills anything in flight)
    if (!items.length) {
      const fresh = newThreadId();
      saveThread(bookPath, fresh, { msgs: [] });
      items.push({ id: fresh, title: UNTITLED, ts: Date.now(), n: 0 });
    }
    const next = items.reduce((a, b) => (b.ts > a.ts ? b : a)); // most recent survivor
    openThread(next.id, { ...ix, items });
  };

  // core ask: q is the question text, pend the (already detached) seed.
  // The form path consumes the pending chip; suggestion/repeat sends pass null
  // and leave any pending chip for the next manual message.
  const ask = async (q: string, pend: AskSeed | null) => {
    if (busyRef.current || !q) return;
    const path = bookPath;
    const tid = tidRef.current; // this thread owns the answer even if the user switches away
    const sid = loadThread(path, tid).sid ?? null;

    // the thread shows only the question + quote chip; the prompt below carries
    // the delimited context (selection, surrounding page text, book/page)
    push(path, tid, { role: "user", text: q, quote: pend?.quote, page: pend?.page });

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
          if (pathRef.current === path && tidRef.current === tid) setStream(streamRef.current);
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
        push(path, tid, { role: "assistant", text: "Вопросы к Claude доступны только в приложении pdfer", error: true });
        return;
      }
      // assertion: TS narrows the ref to its pre-await null, blind to onLine's writes
      const r = resultRef.current as NdLine | null;
      if (r && !r.is_error) {
        push(path, tid, { role: "assistant", text: r.result || streamRef.current || "(пустой ответ)", md: true });
        if (r.session_id) saveSid(path, tid, r.session_id); // --resume is per THREAD now
      } else if ((cancelledRef.current || r?.subtype === "cancelled") && streamRef.current) {
        push(path, tid, { role: "assistant", text: streamRef.current, cancelled: true, md: true });
      } else if (r) {
        push(path, tid, { role: "assistant", text: r.result || `Ошибка: ${r.subtype ?? "неизвестная"}`, error: true });
      } else if (cancelledRef.current) {
        push(path, tid, { role: "assistant", text: "Запрос отменён", error: true });
      } else {
        push(path, tid, { role: "assistant", text: "Ответ не получен", error: true });
      }
    } catch (e) {
      const s = String(e);
      const text = s.startsWith("claude_not_found")
        ? `Claude Code не найден (${s.slice("claude_not_found:".length).trim()}). ` +
          `Установите его с https://claude.com/claude-code и войдите в аккаунт командой claude.`
        : s.startsWith("busy")
          ? "Уже выполняется другой запрос — дождитесь ответа или остановите его"
          : `Не удалось запустить Claude: ${s}`;
      push(path, tid, { role: "assistant", text, error: true });
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
  const showSuggestions =
    !busy && canAsk && !!last && last.role === "assistant" && !last.error && sugHideAt !== turn.current;

  // ---- quick commands ----
  const hasAnswer = msgs.some((m) => m.role === "assistant" && !m.error);
  const cmdBlocker = (c: Cmd): string | null => {
    if (c.need === "seed" && !pending) return NEED_SEED;
    if (c.need === "answer" && !hasAnswer) return NEED_ANSWER;
    if (c.need === "seedOrAnswer" && !pending && !hasAnswer) return NEED_SEED;
    return null;
  };
  const cmdQuery = cmdOpen && input.startsWith("/") ? input.slice(1).trim().toLowerCase() : "";
  // every command stays listed even when unavailable — the user asked to be able
  // to FIND these; a dimmed row with its reason beats a row that isn't there
  const cmdList = COMMANDS.filter((c) => !cmdQuery || c.label.toLowerCase().includes(cmdQuery));
  const cmdEnabled = cmdList.filter((c) => !cmdBlocker(c));

  const closeCmd = () => setCmdOpen(false);
  const openCmd = () => {
    setCmdOpen(true);
    setCmdSel(0);
    taRef.current?.focus();
  };
  const runCmd = (c: Cmd) => {
    if (busyRef.current || cmdBlocker(c)) return;
    setCmdOpen(false);
    const pend = c.need === "seed" || c.need === "seedOrAnswer" ? pending : null;
    if (pend) setPending(null);
    if (input.startsWith("/")) setInput(""); // the typed «/filter» was the trigger, not a question
    taRef.current?.focus();
    void ask(c.msg(page), pend);
  };

  const onInput = (v: string) => {
    if (!cmdOpen && input === "" && v === "/") {
      setCmdOpen(true);
      setCmdSel(0);
    } else if (cmdOpen && !v.startsWith("/")) {
      setCmdOpen(false);
    } else if (cmdOpen) {
      setCmdSel(0);
    }
    setInput(v);
  };

  // capture phase: these keys belong to the open menu, and must reach neither
  // the textarea's Enter-submits handler nor the app's global Esc chain
  const onKeyCapture = (e: React.KeyboardEvent) => {
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    // Escape is handled by the window-capture effect above (it must win from
    // anywhere, not only from inside the panel)
    if (!cmdOpen) return;
    const n = cmdEnabled.length;
    if (e.key === "ArrowDown" && n) return stop(), setCmdSel((s) => (s + 1) % n);
    if (e.key === "ArrowUp" && n) return stop(), setCmdSel((s) => (s + n - 1) % n);
    if (e.key === "Enter" || e.key === "Tab") {
      stop();
      const c = cmdEnabled[Math.min(cmdSel, n - 1)];
      if (c) runCmd(c);
    }
  };

  // ---- thread rows, newest first, grouped by day (Cloudscape) ----
  const dayOf = (ts: number) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = dayOf(Date.now());
  const groups: { key: string; items: ThreadMeta[] }[] = [];
  for (const t of [...index.items].sort((a, b) => b.ts - a.ts)) {
    const day = dayOf(t.ts);
    const key = day === today ? "Сегодня" : day === today - 864e5 ? "Вчера" : "Раньше";
    const g = groups[groups.length - 1];
    if (g?.key === key) g.items.push(t);
    else groups.push({ key, items: [t] });
  }
  const stamp = (ts: number) =>
    dayOf(ts) >= today - 864e5
      ? new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
      : new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

  return (
    <aside
      data-asksb
      className={`${open ? "flex" : "hidden"} relative shrink-0 flex-col h-full border-l border-neutral-300/70 dark:border-neutral-700/70 bg-neutral-50 dark:bg-neutral-800 text-sm text-neutral-800 dark:text-neutral-100`}
      onKeyDownCapture={onKeyCapture}
      style={{ width }}
    >
      {/* scoped here, not in App.css (contended): only the drag needs them */}
      <style>{
        "html[data-askresize]{cursor:col-resize;user-select:none}" +
        "html[data-askresize] .toolbar{transition:none}"
      }</style>
      <ResizeHandle onWidth={onWidth} width={width} />
      <div className="flex items-center gap-1 h-10 pl-3.5 pr-2 border-b border-neutral-200 dark:border-neutral-700 select-none shrink-0">
        <span className="truncate font-medium">Вопросы по книге</span>
        <span className="flex-1" />
        <button
          aria-expanded={threadsOpen}
          className={`${HDR_BTN} ${threadsOpen ? "bg-neutral-900/5 dark:bg-neutral-100/10" : ""}`}
          data-askthreadsbtn
          onClick={() => {
            setThreadsOpen((v) => !v);
            setConfirmDel(null);
            setCmdOpen(false);
          }}
          title={index.items.length > 1 ? `Беседы по книге · ${index.items.length}` : "Беседы по книге"}
        >
          <MessagesSquareIcon className="size-3.5" />
          <span className="sr-only">Беседы по книге</span>
        </button>
        <button
          aria-disabled={busy || msgs.length === 0}
          className={`${HDR_BTN} ${HDR_BTN_OFF}`}
          disabled={busy || msgs.length === 0}
          onClick={newThread}
          title={msgs.length === 0 ? "Новая беседа — эта беседа уже пустая" : "Новая беседа"}
        >
          <SquarePenIcon className="size-3.5" />
          <span className="sr-only">Новая беседа</span>
        </button>
        <button className={HDR_BTN} onClick={onClose} title="Закрыть (Ctrl+J)">
          <IconClose />
        </button>
      </div>

      {threadsOpen && (
        <div
          className="absolute left-2 right-2 top-10 z-30 max-h-[60%] overflow-y-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-800"
          data-askthreads
        >
          <div className="px-3 pb-1 pt-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 select-none">
            Беседы
          </div>
          {index.items.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
              Здесь появятся беседы по этой книге
            </div>
          )}
          {groups.map((g) => (
            <div key={g.key}>
              <div className="px-3 pb-0.5 pt-2 text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 select-none">
                {g.key}
              </div>
              {g.items.map((t) => (
                <div
                  className={`group/th relative px-3 py-1.5 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700/60 ${
                    t.id === index.active ? "bg-neutral-100/70 dark:bg-neutral-700/40" : ""
                  }`}
                  key={t.id}
                >
                  {t.id === index.active && (
                    <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-neutral-500 dark:bg-neutral-300" />
                  )}
                  <div className="flex items-center gap-2">
                    <button className="min-w-0 flex-1 text-left" onClick={() => switchThread(t.id)} title={t.title}>
                      <div className="truncate text-[13px]">{t.title}</div>
                      <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        {msgCount(t.n)} · {stamp(t.ts)}
                      </div>
                    </button>
                    {confirmDel !== t.id && (
                      <button
                        className="shrink-0 rounded-md p-1 text-neutral-400 opacity-0 transition-colors hover:text-red-600 group-hover/th:opacity-100 focus-visible:opacity-100 dark:hover:text-red-400"
                        onClick={() => setConfirmDel(t.id)}
                        title="Удалить беседу"
                      >
                        <Trash2Icon className="size-3.5" />
                        <span className="sr-only">Удалить беседу</span>
                      </button>
                    )}
                  </div>
                  {confirmDel === t.id && (
                    <div className="mt-1 text-xs">
                      <div className="text-neutral-600 dark:text-neutral-300">
                        Беседа и её память будут удалены
                      </div>
                      <div className="mt-1 flex items-center gap-3">
                        <button className={RED_BTN} onClick={() => deleteThread(t.id)}>
                          Удалить
                        </button>
                        <button className={PLAIN_BTN} onClick={() => setConfirmDel(null)}>
                          Отмена
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

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

      <div className="relative border-t border-neutral-200 dark:border-neutral-700 p-2.5 shrink-0">
        {showSuggestions && (
          // `wrap`: at 400 px the row is 371 px and fits; at the 320 px minimum
          // it becomes two rows instead of hiding a chip behind a scrollbar that
          // Radix renders as nothing
          <Suggestions className="mb-1.5" wrap>
            {SUGGESTIONS.map((s) => (
              <Suggestion
                className="h-6 px-2.5 text-xs text-neutral-600 dark:text-neutral-300"
                key={s.label}
                onClick={() => void ask(s.msg, null)}
                suggestion={s.label}
              />
            ))}
            <button
              className="rounded-md p-1 text-neutral-400 transition-colors hover:text-neutral-700 dark:hover:text-neutral-200"
              onClick={() => setSugHideAt(turn.current)}
              title="Скрыть подсказки"
            >
              <IconClose size={12} />
              <span className="sr-only">Скрыть подсказки</span>
            </button>
          </Suggestions>
        )}
        {pending && (
          <div className="mb-1.5 flex items-start gap-2 rounded-lg bg-neutral-200/70 dark:bg-neutral-700/50 px-2.5 py-1.5 text-xs select-none">
            {/* break-words: line-clamp hides the overflow, so a long unbroken
                token would be silently cut with no ellipsis on that line */}
            <div className="min-w-0 flex-1 line-clamp-3 break-words text-neutral-600 dark:text-neutral-300">
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

        {cmdOpen && (
          <div
            className="absolute bottom-full left-2.5 right-2.5 z-30 mb-1 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-800"
            data-askcmd
          >
            {cmdList.length === 0 && (
              <div className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">Команда не найдена</div>
            )}
            {cmdList.map((c) => {
              const why = cmdBlocker(c);
              const i = cmdEnabled.indexOf(c);
              const sel = !why && i === Math.min(cmdSel, cmdEnabled.length - 1);
              return (
                <button
                  className={`flex w-full items-start gap-2.5 px-3 py-1.5 text-left transition-colors ${
                    why
                      ? "cursor-default text-neutral-400 dark:text-neutral-500"
                      : `hover:bg-neutral-100 dark:hover:bg-neutral-700/60 ${sel ? "bg-neutral-100 dark:bg-neutral-700/60" : ""}`
                  }`}
                  disabled={!!why}
                  key={c.id}
                  onClick={() => runCmd(c)}
                  onMouseEnter={() => !why && setCmdSel(i)}
                  title={c.label}
                  type="button"
                >
                  <c.icon className="mt-0.5 size-3.5 shrink-0" />
                  {/* the precondition goes on its OWN line: sharing the row with
                      the label ate it («Объя…») at narrow panel widths, and the
                      command name is the one thing that must always be readable */}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{c.label}</span>
                    {why && <span className="block truncate text-[11px] opacity-80">{why}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <PromptInput data-askcomposer onSubmit={send}>
          <PromptInputTextarea
            onChange={(e) => onInput(e.target.value)}
            placeholder={pending ? DEFAULT_Q : "Вопрос по книге… «/» — команды"}
            ref={taRef}
            rows={1}
            value={input}
          />
          <PromptInputToolbar>
            <PromptInputTools>
              <button
                aria-disabled={busy || !canAsk}
                aria-expanded={cmdOpen}
                className={`${HDR_BTN} ${HDR_BTN_OFF} ${
                  cmdOpen ? "bg-neutral-900/5 dark:bg-neutral-100/10" : ""
                }`}
                data-askcmdbtn
                disabled={busy || !canAsk}
                onClick={() => (cmdOpen ? closeCmd() : openCmd())}
                title="Быстрые команды (/)"
                type="button"
              >
                <SparklesIcon className="size-3.5" />
                <span className="sr-only">Быстрые команды</span>
              </button>
            </PromptInputTools>
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
