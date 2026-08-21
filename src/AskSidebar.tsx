import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  BookOpenIcon,
  ChartColumnIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  LightbulbIcon,
  Link2Icon,
  MessagesSquareIcon,
  RefreshCcwIcon,
  SearchIcon,
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
import { copyToClipboard } from "./clipboard";
import { lookup } from "./graphstore";
import { CLAUDE, installCommand } from "./host";
import { fmtNum, getLang, t } from "./i18n";
import { IconClose } from "./icons";

// ---- «Спросить»: тело одноимённой вкладки панели, поверх headless Claude Code
//
// (WP-N) Это больше не самостоятельная панель: рама — строка вкладок, крестик
// и ручка ширины — принадлежит Panel.tsx, здесь остались строка управления
// беседой, диалог, чипы-подсказки и композер. `open` по-прежнему приходит
// пропсом: тело живёт смонтированным и когда вкладка не на виду (идущий поток
// ответа не должен обрываться от переключения), и это флаг «меня видно».
//
// UI: shadcn AI components (shadcn.io/ai patterns — Conversation, Message,
// Response, Actions, Prompt Input, Loader, Suggestion) restyled to the app's
// pill aesthetic. Assistant answers render as STREAMING markdown (Streamdown
// inside MessageResponse; raw HTML is never executed — the hardened renderer
// drops it).
//
// Transport: the Rust `ask_claude` command spawns the Claude CLI (-p stream-json)
// and forwards every stdout NDJSON line RAW over a tauri Channel. This
// component owns the whole NDJSON contract:
//   stream_event/content_block_delta/text_delta  → token stream
//   stream_event/content_block_start/tool_use    → a tool is starting
//   assistant/message.content[]/tool_use         → the same tool, input filled
//   result (always present, synthetic if needed) → final text, session_id,
//                                                  is_error/subtype
// One ask at a time (Rust rejects "busy: ..."). Cancel = ask_claude_cancel →
// the stream still terminates with a synthetic cancelled result line.
//
// Where an answer comes from, in order: the reader's own knowledge graph, then
// the model's own knowledge, then — only with the reader's permission — the web.
//   * the graph is RETRIEVED here, not by the model: lookup() runs before the
//     prompt is assembled and its block is prepended to whatever the prompt
//     turned out to be, on EVERY turn (see the injection site);
//   * `ask.graph` in the system prompt is what teaches that order;
//   * the web is a tool the CLI may only reach for when pdfer:ask:web says so,
//     and every search or fetch it does gets a line in the transcript. An
//     assistant answering out of a silent network is the thing that line exists
//     to prevent.
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
// A record is stored and read back as a whole object (JSON.stringify of the
// message list, JSON.parse straight back into Msg[]), so a flag added to Msg
// survives a restart with no schema bump and no migration — which is why
// `graph` and `tools` are persisted with the answer rather than kept in a
// session-only side table: an answer that leaned on the library still says so
// tomorrow morning.
//
// Panel width lives in pdfer:askw (workspace-wide, see useAskWidth); the drag
// handle on the panel's left edge is Panel.tsx's now.
//
// Outside Tauri (plain-browser ?test= debugging) sends are answered with an
// honest «доступно только в приложении» message — unless a dev mock is set:
//   window.__pdferAskMock = string[] | (prompt) => string[]   // NDJSON lines
//   window.__pdferAskMockDelay = ms per line (default 35)

// seed = a selection-initiated ask: quote + auto-extracted page context; shown
// as a removable chip above the input, consumed by the next sent message.
// `id` makes every «Спросить» click a fresh object so the consume effect fires.
export type AskSeed = { id: number; quote: string; page?: number; pageText?: string };

// One line of tool activity, kept with the answer it happened during. `what` is
// the model's own query or the host it opened — never interface prose, see
// toolNote() — and is empty when the tool announced itself before its input had
// finished streaming and no later line filled it in.
type ToolNote = { tool: "search" | "fetch"; what: string };

type Msg = {
  role: "user" | "assistant";
  text: string;
  quote?: string; // user: the selection this message asked about
  page?: number;
  error?: boolean; // assistant: error text (muted red)
  cancelled?: boolean; // assistant: partial answer kept after a cancel
  md?: boolean; // assistant: markdown (post-rebuild records; old ones are plain)
  graph?: boolean; // assistant: a library block went into the prompt for this turn
  tools?: ToolNote[]; // assistant: the searches and fetches this answer cost
  // (WP-N) Кто ответил и за сколько — подпись под ответом. Записи старее этого
  // поля читаются как прежде: имени нет — в подписи стоит имя самого CLI.
  model?: string; // assistant: machine id out of the stream, «claude-sonnet-4-5-…»
  ms?: number; // assistant: wall time from the question to the finished answer
};

// «claude-sonnet-4-5-20250929» → «Claude Sonnet 4.5». Идентификатор разбирается
// по частям, и ни одной части к нему не добавляется: если семейство не читается,
// показываем строку ровно такой, какой она пришла. Дата сборки (восемь цифр) —
// не версия и в подпись не идёт.
const TIERS: Record<string, string | undefined> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
function modelName(id: string): string {
  const parts = id.split("-");
  if (parts[0] !== "claude") return id;
  const tier = parts.map((p) => TIERS[p]).find(Boolean);
  const ver = parts.filter((p) => /^\d{1,2}$/.test(p)).join(".");
  const out = ["Claude", tier, ver].filter(Boolean).join(" ");
  return out === "Claude" ? id : out;
}

// one content block of the model's turn; only `tool_use` is read here
type ToolUse = { type?: string; id?: string; name?: string; input?: Record<string, unknown> };

// minimal shape of the NDJSON lines this component reads
type NdLine = {
  type?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
    // content_block_start: the tool is named here, but its input is still
    // empty — the arguments arrive as input_json_delta fragments afterwards
    content_block?: ToolUse;
    // message_start: the turn's model, before a single token of it has arrived
    message?: { model?: string };
  };
  // the assembled assistant turn: the same tool_use blocks, inputs filled in
  message?: { content?: ToolUse[]; model?: string };
  model?: string; // system/init: the model the CLI started the session with
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
};

type MockLines = string[] | ((prompt: string) => string[]);

const HIST_LIMIT = 50;
const defaultQ = () => t("ask.defaultQ");
// Chips above the composer — no extra model calls. Three, wrapping,
// dismissible: the market rule for chips in a narrow panel (cap the visible
// set, never a hidden scroller, never push the composer down).
// В направлении B это не «дожать ответ», а зацепки по тому, что читатель
// сейчас видит: глава, её термины, короткий пересказ страницы (WP-N).
// label = what the chip reads (short enough to fit one row at 400 px);
// msg = what is actually sent, since the chip becomes the user's own turn
const suggestions = (page: number): { label: string; msg: string }[] => [
  { label: t("ask.chipChapter"), msg: t("ask.chipChapterMsg") },
  { label: t("ask.chipTerms"), msg: t("ask.chipTermsMsg") },
  { label: t("ask.chipShort"), msg: t("ask.chipShortMsg", { n: page }) },
];
const isTauri = "__TAURI_INTERNALS__" in window;

// ---- the web, and the line it leaves behind ---------------------------------
// Frozen key (WP-M), default OFF: a reader who never opened Settings has never
// agreed to let a question about the book they are holding leave the machine.
// The switch itself lives in Settings («Разрешить поиск в интернете»); here it
// is only read, and read at send time rather than cached, so unticking it takes
// effect on the very next question instead of on the next restart.
const WEB_KEY = "pdfer:ask:web";
const WEB_TOOLS = "WebSearch,WebFetch";
const webAllowed = () => {
  try {
    return localStorage.getItem(WEB_KEY) === "1";
  } catch {
    // storage denied (private mode, a locked profile): a permission nobody can
    // read has not been given, and the safe reading of silence is «no»
    return false;
  }
};

// «https://arxiv.org/abs/2001.08361» → «arxiv.org». The whole URL would push the
// row into an ellipsis on its own path, and the host is the part that answers
// the reader's actual question — WHERE did this go.
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/// One tool_use block → the row it earns in the transcript, or null for a tool
/// the reader was never asked about (nothing else is on the allow-list, so this
/// should be unreachable; it is a warning, not a silent drop).
function toolNote(b: ToolUse): ToolNote | null {
  if (b.name === "WebSearch") {
    return { tool: "search", what: typeof b.input?.query === "string" ? b.input.query : "" };
  }
  if (b.name === "WebFetch") {
    const u = typeof b.input?.url === "string" ? b.input.url : "";
    return { tool: "fetch", what: u ? hostOf(u) : "" };
  }
  if (b.name) console.warn("ask: unexpected tool", b.name, b.input);
  return null;
}

// ---- quick commands ---------------------------------------------------------
// «/» in an empty composer opens the menu — the settled convention (ChatGPT,
// Cursor, assistant-ui). Only at position 0: a naked «/» mid-sentence is normal
// prose in both interface languages, and a menu there would be hostile. Picking
// a command sends straight away — this is a reader, not an agent, so no
// directive chip lingers. Menu labels are infinitives (UI voice); the payload
// is 2nd-person imperative, because it becomes the user's own turn.
// `here` — команда спрашивает про открытую страницу, и в промпт к ней уходит
// текст этой страницы, а не только её номер (WP-N).
type CmdNeed = "seed" | "answer" | "seedOrAnswer";
type Cmd = {
  id: string;
  label: string;
  icon: LucideIcon;
  msg: (page: number) => string;
  need?: CmdNeed;
  here?: boolean;
};
const commands = (): Cmd[] => [
  { id: "explain", label: t("ask.cmdExplain"), icon: TextQuoteIcon, msg: () => t("ask.defaultQ"), need: "seed" },
  { id: "term", label: t("ask.cmdTerm"), icon: BookOpenIcon, msg: () => t("ask.cmdTermMsg"), need: "seed" },
  { id: "page", label: t("ask.cmdPage"), icon: FileTextIcon, msg: (p) => t("ask.cmdPageMsg", { n: p }), here: true },
  { id: "chart", label: t("ask.cmdChart"), icon: ChartColumnIcon, msg: (p) => t("ask.cmdChartMsg", { n: p }), here: true },
  { id: "link", label: t("ask.cmdLink"), icon: Link2Icon, msg: () => t("ask.linkTopicMsg"), need: "seedOrAnswer" },
  { id: "simpler", label: t("ask.cmdSimpler"), icon: LightbulbIcon, msg: () => t("ask.simpler"), need: "answer" },
];

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
const RED_BTN = "-mx-1 px-1 rounded-md text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/10";
const PLAIN_BTN =
  "-mx-1 px-1 rounded-md transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";

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

type ThreadMeta = { id: string; title: string; ts: number; n: number };
type ThreadIndex = { v: 2; active: string; items: ThreadMeta[] };
type ThreadData = { sid?: string; msgs: Msg[] };

const newThreadId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// «1 сообщение / 2 сообщения / 5 сообщений», «1 message / 2 messages»
const msgCount = (n: number) => (n ? t("ask.msgs", { n }) : t("ask.emptyThread"));

// title = first user message, per the market convention (ChatGPT/Cloudscape)
function titleOf(msgs: Msg[]): string {
  const first = msgs.find((m) => m.role === "user")?.text.replace(/\s+/g, " ").trim();
  if (!first) return t("ask.newThread");
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
    title: prev && prev.title !== t("ask.newThread") ? prev.title : titleOf(msgs),
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

// Reading-assistant persona, in the interface language so the answers come back
// in it; goes to the CLI as --append-system-prompt. With it, the two formats an
// answer may carry besides prose — maths in LaTeX and a ```chart fence — and
// the order in which the assistant is to look for what it answers with. Kept as
// three catalogue entries rather than one:
// `ask.viz` describes a machine contract that must stay in step with
// chart-block.tsx, and it has no business being buried inside the voice;
// `ask.graph` is a rule about ORDER — library, then own knowledge, then the web
// — and it is what makes sense of the «Из вашей библиотеки» block the prompt
// carries. It is appended unconditionally, even on a turn where the graph found
// nothing: --resume replays the system prompt of the FIRST turn of a thread,
// and a rule that came and went with the block would apply to the wrong turns.
const sysPrompt = (title: string) =>
  `${t("ask.system", { title })}\n\n${t("ask.viz")}\n\n${t("ask.graph")}`;

// Tool activity, in the quiet register of «Остановлено» and «По графу
// библиотеки» — under the answer's weight, never competing with it. One line,
// truncated: an assistant that searched eleven times must not push the answer
// itself off the screen, so these rows never scroll and never grow.
//
// The row carries NO interface prose — a magnifier and the query the model
// typed, a link and the host it opened. That is a constraint, not a taste:
// every user-visible sentence in this app comes out of the i18n catalogue,
// `t()` takes its key from a closed union, and this task may not touch that
// file. A query and a hostname are the model's words and the network's, so
// neither needs translating; the tool NAME is the fallback when the input never
// arrived, and it is a proper noun. A catalogue entry, when there is one,
// belongs at the head of this row and nowhere else.
const ToolRow = ({ note }: { note: ToolNote }) => {
  const search = note.tool === "search";
  // guillemets only around a query — it is a quotation of what the model typed;
  // a host is a name and takes none. Same spelling as the fragment chip above
  // the composer, which is the reader's other «this is quoted material» cue.
  const text = note.what ? (search ? `«${note.what}»` : note.what) : search ? "WebSearch" : "WebFetch";
  return (
    <div className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400" title={text}>
      {search ? <SearchIcon className="size-3 shrink-0" /> : <Link2Icon className="size-3 shrink-0" />}
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
};

export function AskSidebar({
  open,
  bookPath,
  bookTitle,
  page,
  total,
  pageText,
  seed,
  onCount,
}: {
  /** вкладка «Спросить» видна: тело остаётся смонтированным и в фоне (WP-N) */
  open: boolean;
  bookPath: string;
  bookTitle: string;
  // current page — reading position, sent with EVERY message of a thread (WP-N)
  page: number;
  /** страниц в книге — вторая половина «стр. N из M» */
  total: number;
  /** (WP-N) Текст того, что читатель видит: страница, названная в пилюле, и её
   *  соседка по ряду, если книга открыта в две колонки. Читается в момент
   *  вопроса — за время беседы читатель уходит на сотни страниц вперёд. */
  pageText: (n: number) => { page: number; text: string }[];
  seed: AskSeed | null;
  /** сообщений в открытой беседе — число на ярлыке вкладки панели (WP-N) */
  onCount?: (n: number) => void;
}) {
  const [index, setIndex] = useState<ThreadIndex>(() => loadIndex(bookPath));
  const [msgs, setMsgs] = useState<Msg[]>(() => loadThread(bookPath, index.active).msgs);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<AskSeed | null>(null);
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState(""); // streamed text of the in-flight answer
  const [live, setLive] = useState<ToolNote[]>([]); // tool rows of the in-flight answer
  const [copied, setCopied] = useState(-1); // msg index showing the «Copied» state
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null); // thread id armed for delete
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdSel, setCmdSel] = useState(0);
  const [sugHideAt, setSugHideAt] = useState(-1); // turn number at which the chips were dismissed

  const msgsRef = useRef(msgs);
  const busyRef = useRef(false);
  const streamRef = useRef("");
  const liveRef = useRef<ToolNote[]>([]);
  // tool_use id → its row in liveRef. The CLI announces a tool twice — once at
  // content_block_start, where the name is known and the input is still empty,
  // and again in the assembled assistant turn with the query filled in. Without
  // this map the reader would get every search twice, once nameless.
  const toolAtRef = useRef(new Map<string, number>());
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
    setLive([]);
    setInput("");
    setThreadsOpen(false);
    setConfirmDel(null);
    setCmdOpen(false);
    setSugHideAt(-1);
  }, [bookPath]);

  // число на ярлыке вкладки «Спросить» — сообщения открытой беседы (WP-N)
  useEffect(() => {
    onCount?.(msgs.length);
  }, [msgs.length, onCount]);

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
    setLive([]);
    setCmdOpen(false);
    setSugHideAt(-1);
  };

  // «Новая беседа»: adds a thread, deletes none (v1 wiped the only one there was)
  const newThread = () => {
    if (busyRef.current || msgs.length === 0) return;
    const id = newThreadId();
    saveThread(bookPath, id, { msgs: [] });
    const ix = loadIndex(bookPath);
    openThread(id, { ...ix, items: [{ id, title: t("ask.newThread"), ts: Date.now(), n: 0 }, ...ix.items] });
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
      items.push({ id: fresh, title: t("ask.newThread"), ts: Date.now(), n: 0 });
    }
    const next = items.reduce((a, b) => (b.ts > a.ts ? b : a)); // most recent survivor
    openThread(next.id, { ...ix, items });
  };

  // core ask: q is the question text, pend the (already detached) seed.
  // The form path consumes the pending chip; suggestion/repeat sends pass null
  // and leave any pending chip for the next manual message.
  // `here` — вопрос про открытую страницу (чип-подсказка, «страница»,
  // «наглядно»): в промпт уходит текст того, что читатель видит (WP-N).
  const ask = async (q: string, pend: AskSeed | null, here = false) => {
    if (busyRef.current || !q) return;
    const t0 = Date.now(); // время ответа — то, что читатель прождал
    let modelId = ""; // кто ответил: имя приходит в потоке, см. onLine
    const path = bookPath;
    const tid = tidRef.current; // this thread owns the answer even if the user switches away
    const sid = loadThread(path, tid).sid ?? null;

    // the thread shows only the question + quote chip; the prompt below carries
    // the delimited context (selection, surrounding page text, book/page)
    push(path, tid, { role: "user", text: q, quote: pend?.quote, page: pend?.page });

    // Busy goes up BEFORE retrieval, not after it as it used to. The question is
    // already on screen (push above is synchronous and stays above this line),
    // but lookup() is the first thing in a session to touch the graph, and
    // graph() reads every shard off disk to merge them — hundreds of
    // milliseconds on a real library, during which a composer that still looked
    // idle would invite a second Enter.
    busyRef.current = true;
    setBusy(true);
    streamRef.current = "";
    setStream("");
    liveRef.current = [];
    setLive([]);
    toolAtRef.current = new Map();
    resultRef.current = null;
    cancelledRef.current = false;

    let graphCtx: string | null = null;
    try {
      graphCtx = await lookup(q, pend?.quote ?? null, path);
    } catch (e) {
      // A graph that cannot be read costs this answer its library context and
      // nothing else — the question itself must still go through, and the model
      // has been told to say plainly what the library does not cover. The detail
      // goes to the console rather than into the reader's thread.
      console.warn("ask: graph lookup failed", e);
    }

    let prompt: string;
    if (pend) {
      // (WP-N) Номер у цитаты может и не быть: выделение, начавшееся вне
      // [data-page], приходит из extractAskContext без страницы. Тогда позицию
      // называет пилюля — читатель выделял то, на что смотрел, и ответ без
      // позиции хуже ответа с соседней страницей.
      const where = t("ask.quoteFrom", {
        title: bookTitle,
        page: t("ask.quotePage", { n: pend.page ?? page }),
      });
      prompt =
        `${where}\n<<<\n${pend.quote}\n>>>\n\n` +
        (pend.pageText ? `${t("ask.surrounding")}\n<<<\n${pend.pageText}\n>>>\n\n` : "") +
        t("ask.question", { q });
    } else if (!sid) {
      prompt = `${t("ask.readingCtx", { title: bookTitle, page })}\n\n${q}`;
    } else {
      // (WP-N) Продолжение беседы больше не голый вопрос. --resume помнит ту
      // страницу, что стояла в ПЕРВОМ сообщении, а читатель за разговор уходит
      // на сотни страниц вперёд — и модель отвечала про давно прочитанное.
      // Строка стоит одну фразу и идёт с каждым сообщением.
      prompt = `${t("ask.readingHere", { title: bookTitle, page, total })}\n\n${q}`;
    }

    // Вопрос про «здесь» получает САМ ТЕКСТ открытой страницы: номер модель
    // прочесть не может, и без текста она отвечала по обрывкам, оставшимся в
    // истории беседы от прошлых вопросов. Каждый блок идёт со своим номером —
    // в две колонки их два, и модель обязана видеть, где чей. Ручной вопрос
    // текста не получает: раздувать страницей книги каждое сообщение незачем.
    if (here) {
      const seen = pageText(page)
        .map((p) => `${t("ask.openPage", { n: p.page })}\n<<<\n${p.text}\n>>>`)
        .join("\n\n");
      if (seen) prompt = `${seen}\n\n${prompt}`;
    }

    // The injection sits AFTER the chain, and that placement is the whole point.
    // The obvious place is inside it — one more branch, one more template — and
    // it is wrong: the follow-up branch above carries the reading position and
    // the question, nothing more, so a graph built into the branches would reach
    // the model on the first turn of a thread and silently vanish from the
    // second one onwards. Nothing would
    // look broken; the answers would just quietly stop knowing about the
    // library. Prepending here is the only shape that cannot drift out of step
    // with the branches, whatever anyone adds to them later.
    if (graphCtx) prompt = `${t("ask.graphCtx")}\n<<<\n${graphCtx}\n>>>\n\n${prompt}`;
    const usedGraph = !!graphCtx;

    // Add or refine one tool row. Refine, because the first sight of a tool has
    // no input yet: replacing the row in place is what turns a bare «WebSearch»
    // into the query the model actually ran, on the same line, without the
    // transcript jumping.
    const noteTool = (b: ToolUse) => {
      const note = toolNote(b);
      if (!note) return;
      // no id (a shape the CLI has never emitted, but the field is optional):
      // fall back to a key that can never collide, and accept the duplicate
      const key = b.id ?? `${b.name}#${liveRef.current.length}`;
      const at = toolAtRef.current.get(key);
      if (at === undefined) {
        toolAtRef.current.set(key, liveRef.current.length);
        liveRef.current = [...liveRef.current, note];
      } else if (liveRef.current[at]?.what !== note.what) {
        liveRef.current = liveRef.current.map((n, i) => (i === at ? note : n));
      } else {
        return; // the same row again — a repaint nobody would see
      }
      if (pathRef.current === path && tidRef.current === tid) setLive(liveRef.current);
    };

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
        } else if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          noteTool(ev.content_block);
        } else if (ev?.type === "message_start" && ev.message?.model) {
          modelId = ev.message.model;
        }
      } else if (j.type === "assistant") {
        // имя модели приходит с самим ходом — фронт его просто не читал (WP-N)
        if (j.message?.model) modelId = j.message.model;
        for (const b of j.message?.content ?? []) {
          if (b?.type === "tool_use") noteTool(b);
        }
      } else if (j.type === "result") {
        resultRef.current = j;
      } else if (j.type === "system" && j.model) {
        modelId = j.model; // событие старта сессии — на случай, если ход не назвался
      }
    };

    try {
      // «Стоп» pressed while the graph was being read: the button is live from
      // the moment busy went up, but there is no child process to kill yet, so
      // the cancel would be swallowed and the answer to an abandoned question
      // would arrive as if nothing had happened.
      if (cancelledRef.current) {
        push(path, tid, { role: "assistant", text: t("ask.cancelled"), error: true });
        return;
      }
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
          // Read now, not at mount: the reader may have just ticked the box in
          // Settings, and «next question» is the promise that switch makes. The
          // empty string is not «no opinion» — it is an explicit empty
          // allow-list, which is what keeps the default ask offline.
          tools: webAllowed() ? WEB_TOOLS : "",
        });
      } else {
        push(path, tid, { role: "assistant", text: t("ask.appOnly"), error: true });
        return;
      }
      // assertion: TS narrows the ref to its pre-await null, blind to onLine's writes
      const r = resultRef.current as NdLine | null;
      // Where the answer came from travels WITH the answer: the graph mark and
      // the tool rows are set on the message, not held in a side table, so they
      // survive a thread switch and a restart. Refusals below get neither —
      // there is no answer under them to attribute.
      const from = { graph: usedGraph || undefined, tools: liveRef.current.length ? liveRef.current : undefined };
      // (WP-N) Подпись едет с ответом по той же причине, что и строки поиска:
      // кто ответил, читатель должен видеть и завтра утром, а не только пока
      // сообщение свежее. Отказам подписи не достаётся — под ними нет ответа.
      const by = { model: modelId || undefined, ms: Date.now() - t0 };
      if (r && !r.is_error) {
        push(path, tid, {
          role: "assistant",
          text: r.result || streamRef.current || t("ask.emptyAnswer"),
          md: true,
          ...from,
          ...by,
        });
        if (r.session_id) saveSid(path, tid, r.session_id); // --resume is per THREAD now
      } else if ((cancelledRef.current || r?.subtype === "cancelled") && streamRef.current) {
        push(path, tid, { role: "assistant", text: streamRef.current, cancelled: true, md: true, ...from, ...by });
      } else if (r) {
        // the backend puts only the raw process detail in `result` (it never
        // words anything the reader sees) — the sentence is composed here
        const detail = (r.result ?? "").trim();
        const text =
          r.subtype === "cancelled"
            ? t("ask.cancelled")
            : r.subtype === "error_process"
              ? t("ask.exited")
              : detail || t("ask.errUnknown", { what: r.subtype ?? t("ask.errUnknownWhat") });
        // (WP-N) «вышел без ответа» больше не несёт сырой детали процесса:
        // читателю остаётся одна причина, а глагол под ней — кнопка повтора в
        // строке действий сообщения. Диагностика уходит в консоль, чтобы не
        // пропасть совсем.
        console.warn("ask failed", r.subtype, detail);
        push(path, tid, { role: "assistant", text, error: true });
      } else if (cancelledRef.current) {
        push(path, tid, { role: "assistant", text: t("ask.cancelled"), error: true });
      } else {
        push(path, tid, { role: "assistant", text: t("ask.noAnswer"), error: true });
      }
    } catch (e) {
      const s = String(e);
      const text = s.startsWith("claude_not_found")
        ? `${t("ask.notFound")}\n\n${installCommand(CLAUDE) ?? CLAUDE.docs}`
        : s.startsWith("busy")
          ? t("ask.busy")
          : t("ask.launchFail", { detail: s });
      push(path, tid, { role: "assistant", text, error: true });
    } finally {
      busyRef.current = false;
      setBusy(false);
      setStream("");
      // the rows are on the pushed message now; the live copy would otherwise
      // hang under the next question before its own first tool line
      liveRef.current = [];
      setLive([]);
    }
  };

  // form submit (Enter / send button): consumes the pending seed chip
  const send = () => {
    if (busyRef.current) return;
    const pend = pending;
    const q = input.trim() || (pend ? defaultQ() : "");
    if (!q) return;
    setPending(null);
    setInput("");
    void ask(q, pend);
  };

  const copyMsg = (i: number, text: string) => {
    void copyToClipboard(text);
    setCopied(i);
    window.setTimeout(() => setCopied((c) => (c === i ? -1 : c)), 1500);
  };

  // (WP-N) Подпись под ответом: имя модели · время, тем же складом, что «HY-MT1.5
  // · 0,8 с» у поповера перевода. Имени в записи может не быть — у бесед, что
  // старше этого поля, и у потока, который его не назвал; тогда стоит имя самого
  // CLI: отвечает здесь только он, и это единственное место, где приложение
  // выходит в сеть. Секунды с сотой снизу — «0,0 с» не бывает.
  const sigOf = (m: Msg) => {
    const name = m.model ? modelName(m.model) : CLAUDE.name;
    return m.ms ? t("ask.took", { model: name, sec: fmtNum(Math.max(0.1, m.ms / 1000)) }) : name;
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
  // видны и в пустой беседе: чипы направления B — заход в разговор, а не
  // только продолжение уже начатого
  const showSuggestions =
    !busy &&
    canAsk &&
    (msgs.length === 0 || (!!last && last.role === "assistant" && !last.error)) &&
    sugHideAt !== turn.current;

  // ---- quick commands ----
  const hasAnswer = msgs.some((m) => m.role === "assistant" && !m.error);
  const cmdBlocker = (c: Cmd): string | null => {
    if (c.need === "seed" && !pending) return t("ask.needSeed");
    if (c.need === "answer" && !hasAnswer) return t("ask.needAnswer");
    if (c.need === "seedOrAnswer" && !pending && !hasAnswer) return t("ask.needSeed");
    return null;
  };
  const cmdQuery = cmdOpen && input.startsWith("/") ? input.slice(1).trim().toLowerCase() : "";
  // every command stays listed even when unavailable — the user asked to be able
  // to FIND these; a dimmed row with its reason beats a row that isn't there
  const cmdList = commands().filter((c) => !cmdQuery || c.label.toLowerCase().includes(cmdQuery));
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
    void ask(c.msg(page), pend, c.here);
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
  for (const th of [...index.items].sort((a, b) => b.ts - a.ts)) {
    const day = dayOf(th.ts);
    const key = day === today ? t("ask.today") : day === today - 864e5 ? t("ask.yesterday") : t("ask.earlier");
    const g = groups[groups.length - 1];
    if (g?.key === key) g.items.push(th);
    else groups.push({ key, items: [th] });
  }
  const stamp = (ts: number) =>
    dayOf(ts) >= today - 864e5
      ? new Date(ts).toLocaleTimeString(getLang(), { hour: "2-digit", minute: "2-digit" })
      : new Date(ts).toLocaleDateString(getLang(), { day: "numeric", month: "short" });

  // «Беседа · сегодня» — заголовок панели съеден вкладкой, и здесь остаётся
  // ровно то, чего у вкладки нет: КАКАЯ беседа открыта. Метка дня идёт со
  // строчной — она стоит в середине фразы, а не начинает её.
  const activeMeta = index.items.find((x) => x.id === index.active);
  const when = (activeMeta ? groups.find((g) => g.items.includes(activeMeta))?.key : null) ?? t("ask.today");

  return (
    // (WP-N) без data-asksb: маркер для цепочки Esc теперь один и стоит на
    // <aside> панели — он накрывает все три вкладки, а не одну «Спросить»
    <div className="relative flex min-h-0 flex-1 flex-col" onKeyDownCapture={onKeyCapture}>
      {/* строка управления беседой: какая беседа открыта + беседы + новая */}
      <div className="flex h-[30px] shrink-0 select-none items-center gap-1 px-3">
        <span className="min-w-0 truncate text-xs text-neutral-400 dark:text-neutral-500">
          {t("ask.threadOn", { when: when.toLocaleLowerCase(getLang()) })}
        </span>
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
          title={index.items.length > 1 ? t("ask.threadsN", { n: index.items.length }) : t("ask.threads")}
        >
          <MessagesSquareIcon className="size-3.5" />
          <span className="sr-only">{t("ask.threads")}</span>
        </button>
        <button
          aria-disabled={busy || msgs.length === 0}
          className={`${HDR_BTN} ${HDR_BTN_OFF}`}
          disabled={busy || msgs.length === 0}
          onClick={newThread}
          title={msgs.length === 0 ? t("ask.newThreadEmpty") : t("ask.newThreadTitle")}
        >
          <SquarePenIcon className="size-3.5" />
          <span className="sr-only">{t("ask.newThreadTitle")}</span>
        </button>
      </div>

      {threadsOpen && (
        <div
          className="absolute left-2 right-2 top-8 z-30 max-h-[60%] overflow-y-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-800"
          data-askthreads
        >
          <div className="px-3 pb-1 pt-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 select-none">
            {t("ask.threadsHeading")}
          </div>
          {index.items.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
              {t("ask.threadsEmpty")}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.key}>
              <div className="px-3 pb-0.5 pt-2 text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 select-none">
                {g.key}
              </div>
              {g.items.map((th) => (
                <div
                  // (WP-N) наведение — единственный язык приложения, открытая
                  // беседа — та же заливка «выбрано», что у строк палитры и
                  // контекстного меню; полоска слева и так называет активную
                  className={`group/th relative px-3 py-1.5 transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10 ${
                    th.id === index.active ? "bg-neutral-100 dark:bg-neutral-100/8" : ""
                  }`}
                  key={th.id}
                >
                  {th.id === index.active && (
                    <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-neutral-500 dark:bg-neutral-300" />
                  )}
                  <div className="flex items-center gap-2">
                    <button className="min-w-0 flex-1 text-left" onClick={() => switchThread(th.id)} title={th.title}>
                      <div className="truncate text-[13px]">{th.title}</div>
                      <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        {msgCount(th.n)} · {stamp(th.ts)}
                      </div>
                    </button>
                    {confirmDel !== th.id && (
                      <button
                        className="shrink-0 rounded-md p-1 text-neutral-400 opacity-0 transition-colors hover:text-red-600 group-hover/th:opacity-100 focus-visible:opacity-100 dark:hover:text-red-400"
                        onClick={() => setConfirmDel(th.id)}
                        title={t("ask.deleteThread")}
                      >
                        <Trash2Icon className="size-3.5" />
                        <span className="sr-only">{t("ask.deleteThread")}</span>
                      </button>
                    )}
                  </div>
                  {confirmDel === th.id && (
                    <div className="mt-1 text-xs">
                      <div className="text-neutral-600 dark:text-neutral-300">
                        {t("ask.deleteThreadWarn")}
                      </div>
                      <div className="mt-1 flex items-center gap-3">
                        <button className={RED_BTN} onClick={() => deleteThread(th.id)}>
                          {t("ui.delete")}
                        </button>
                        <button className={PLAIN_BTN} onClick={() => setConfirmDel(null)}>
                          {t("ui.cancel")}
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
              {t("ask.appOnlyBadge")}
            </div>
          )}
          {msgs.length === 0 && !busy && (
            <ConversationEmptyState className="flex-1 select-none">
              <div className="px-2 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400 whitespace-pre-line">
                {t("ask.empty")}
              </div>
            </ConversationEmptyState>
          )}
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <Message from="user" key={i}>
                <MessageContent>
                  {m.quote && (
                    <div className="mb-1 border-l-2 border-neutral-400/60 dark:border-neutral-500/60 pl-2 text-xs text-neutral-600 dark:text-neutral-300 line-clamp-3">
                      {m.page ? t("ask.quotePagePrefix", { n: m.page }) : ""}
                      {m.quote}
                    </div>
                  )}
                  {m.text}
                </MessageContent>
              </Message>
            ) : (
              <Message from="assistant" key={i}>
                <MessageContent>
                  {/* what the answer cost, ABOVE it: this is the order it
                      happened in, and the reader who scrolls back to an answer
                      full of facts the book does not contain should meet the
                      searches before the prose, not after it */}
                  {m.tools?.map((n, k) => <ToolRow key={k} note={n} />)}
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
                  {/* «По графу библиотеки» — под ответом, в том же тихом
                      регистре, что и «Остановлено». Это не похвальба фичей:
                      ответ, опирающийся на другие книги читателя, обязан
                      сказать, откуда он их взял, иначе совпадение выглядит
                      всезнанием. Ставится только там, где блок и правда ушёл
                      в промпт. */}
                  {m.graph && (
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">{t("ask.graphUsed")}</span>
                  )}
                  {m.cancelled && (
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">{t("ask.stopped")}</span>
                  )}
                </MessageContent>
                {/* (WP-N) У отказа тоже есть строка действий, и в ней ровно одна
                    кнопка — повтор: это тот самый случай, когда действие обязано
                    стоять рядом с причиной (§1), поэтому сами тексты отказов
                    глагола больше не несут. Копировать нечего: копируют ответ. */}
                {/* (WP-N) Подпись-факт слева от кнопок и, в отличие от них, без
                    угасания: чей это ответ, видно без наведения — «Спросить»
                    единственной в приложении уходит в сеть. */}
                <div className="-ml-1.5 flex items-center gap-1.5">
                  {!m.error && (
                    <span className="pl-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">{sigOf(m)}</span>
                  )}
                  <MessageActions
                    className={`transition-opacity ${
                      i === msgs.length - 1 ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    {!m.error && (
                      <MessageAction
                        className="text-neutral-500 dark:text-neutral-400"
                        onClick={() => copyMsg(i, m.text)}
                        tooltip={copied === i ? t("ui.copied") : t("ui.copy")}
                      >
                        {copied === i ? <CheckIcon /> : <CopyIcon />}
                      </MessageAction>
                    )}
                    <MessageAction
                      className="text-neutral-500 dark:text-neutral-400"
                      disabled={busy}
                      onClick={() => repeat(i)}
                      tooltip={t("ui.retry")}
                    >
                      <RefreshCcwIcon />
                    </MessageAction>
                  </MessageActions>
                </div>
              </Message>
            ),
          )}
          {busy && (
            <Message data-askstream from="assistant">
              <MessageContent>
                {/* the wait with the web on is not the wait it used to be: a
                    search can take ten seconds before the first token, and the
                    spinner alone said nothing about where they went */}
                {live.map((n, k) => <ToolRow key={k} note={n} />)}
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
            {suggestions(page).map((s) => (
              <Suggestion
                className="h-6 px-2.5 text-xs text-neutral-600 dark:text-neutral-300"
                key={s.label}
                // чип — вопрос про то, что читатель ВИДИТ: с ним уходит текст
                // открытой страницы, иначе модель отвечает по обрывкам из
                // истории беседы (WP-N)
                onClick={() => void ask(s.msg, null, true)}
                suggestion={s.label}
              />
            ))}
            <button
              className="rounded-md p-1 text-neutral-400 transition-colors hover:text-neutral-700 dark:hover:text-neutral-200"
              onClick={() => setSugHideAt(turn.current)}
              title={t("ask.hideSuggestions")}
            >
              <IconClose size={12} />
              <span className="sr-only">{t("ask.hideSuggestions")}</span>
            </button>
          </Suggestions>
        )}
        {pending && (
          <div className="mb-1.5 flex items-start gap-2 rounded-lg bg-neutral-200/70 dark:bg-neutral-700/50 px-2.5 py-1.5 text-xs select-none">
            {/* break-words: line-clamp hides the overflow, so a long unbroken
                token would be silently cut with no ellipsis on that line */}
            <div className="min-w-0 flex-1 line-clamp-3 break-words text-neutral-600 dark:text-neutral-300">
              {pending.page ? t("ask.pageShort", { n: pending.page }) : ""}«{pending.quote}»
            </div>
            <button
              className="text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
              onClick={() => setPending(null)}
              title={t("ask.removeFragment")}
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
              <div className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">{t("ask.cmdNotFound")}</div>
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
                      : `hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10 ${sel ? "bg-neutral-100 dark:bg-neutral-100/8" : ""}`
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
            placeholder={pending ? defaultQ() : t("ask.placeholder")}
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
                title={t("ask.quickCommands")}
                type="button"
              >
                <SparklesIcon className="size-3.5" />
                <span className="sr-only">{t("ask.quickCommandsShort")}</span>
              </button>
            </PromptInputTools>
            <PromptInputSubmit
              className="size-7"
              disabled={!busy && !sendable}
              onClick={busy ? cancel : undefined}
              status={busy ? (stream ? "streaming" : "submitted") : undefined}
              title={busy ? t("ask.stop") : t("ask.send")}
              type={busy ? "button" : "submit"}
            />
          </PromptInputToolbar>
        </PromptInput>
      </div>
    </div>
  );
}
