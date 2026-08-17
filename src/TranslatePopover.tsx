import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { invoke } from "@tauri-apps/api/core";
import { extractTerms, mergeGlossary, translateTerms } from "./glossarygen";
import { isAuxUp, loadGlossaryText, parseGlossary, saveGlossaryText, translateStream } from "./translate";
import {
  MODEL_META,
  Spinner,
  cancelDownload,
  dlBusy,
  dlErrorLine,
  dlPct,
  dlProgressLine,
  fetchModelStatus,
  modelFileReady,
  restartModel,
  startDownload,
  statusUp,
  useDownload,
} from "./ModelSetup";
import { IconClose } from "./icons";

export type Anchor = { x: number; y: number };

// pill controls: the app-wide hover grammar (WP-K) — quiet bg tint, no opacity dim
const PILL_BTN = "rounded-md transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";
// inline text links: muted base, hover strengthens the color (same grammar as QUIET_LINK)
const LINK_HOVER = "transition-colors hover:text-neutral-800 dark:hover:text-neutral-100";

// popover-openings counter for the Alt+click footer hint (Н6, first 3 opens)
const ALT_HINT_KEY = "pdfer:hint:altclick";

function clampToViewport(el: HTMLElement, a: Anchor) {
  const pad = 8;
  const r = el.getBoundingClientRect();
  const x = Math.min(Math.max(pad, a.x), window.innerWidth - r.width - pad);
  const y =
    a.y + r.height + pad > window.innerHeight
      ? Math.max(pad, window.innerHeight - r.height - pad)
      : a.y;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

// ---- selection mini-toolbar: «Перевести» + «Спросить» ----------------------

export function SelectionBar({
  anchor,
  onTranslate,
  onAsk,
}: {
  anchor: Anchor;
  onTranslate: () => void;
  // opens the Claude sidebar seeded with the quoted selection + page context
  onAsk: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) clampToViewport(ref.current, anchor);
  }, [anchor]);
  return (
    <div
      ref={ref}
      data-selbar
      className="overlay-pop fixed z-20 flex items-center gap-1 rounded-full bg-white/90 dark:bg-neutral-800/90 backdrop-blur px-2 py-1 shadow-lg text-sm text-neutral-700 dark:text-neutral-200 select-none"
      // preserve the text selection: never let the bar steal focus/collapse it
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className={`${PILL_BTN} px-1.5`} onClick={onTranslate} title="Перевести выделенное (Enter)">
        Перевести <span className="text-xs text-neutral-500 dark:text-neutral-400">⏎</span>
      </button>
      <span className="text-neutral-300 dark:text-neutral-600">·</span>
      <button className={`${PILL_BTN} px-1.5`} onClick={onAsk} title="Спросить Claude об этом фрагменте">
        Спросить
      </button>
    </div>
  );
}

// ---- translate popover ------------------------------------------------------

export function TranslatePopover({
  anchor,
  text,
  context,
  bookPath,
  onClose,
  onSetup,
  label,
  noTranslate,
}: {
  anchor: Anchor;
  text: string;
  context?: string;
  bookPath: string;
  onClose: () => void;
  // opens the model setup flow (license + download) — the «Скачать модель» CTA
  onSetup?: () => void;
  // header caption, default «Перевод»
  label?: string;
  // show text as-is, no model call — e.g. the stored original of an
  // already-translated paragraph on a reflowed page (label «Оригинал»)
  noTranslate?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [out, setOut] = useState("");
  const [phase, setPhase] = useState<"stream" | "done" | "starting" | "nomodel" | "dead" | "error">("stream");
  const [copied, setCopied] = useState(false);
  // «Повторить» bumps this to re-run the whole effect
  const [attempt, setAttempt] = useState(0);
  const dl = useDownload("main");
  // discoverability (Н6): the popover's first three openings carry a footer
  // teaching Alt+click; the counter lives in localStorage. Never shown (or
  // counted) on the «Оригинал» popover — that one IS the Alt+click product.
  const [showAltHint] = useState(() => !noTranslate && Number(localStorage.getItem(ALT_HINT_KEY) ?? "0") < 3);
  const altCountedRef = useRef(false);
  useEffect(() => {
    if (noTranslate || altCountedRef.current) return;
    altCountedRef.current = true; // StrictMode's double effect must not count twice
    const n = Number(localStorage.getItem(ALT_HINT_KEY) ?? "0");
    if (n < 3) localStorage.setItem(ALT_HINT_KEY, String(n + 1));
  }, [noTranslate]);

  useEffect(() => {
    if (noTranslate) {
      setOut(text);
      setPhase("done");
      return;
    }
    const ctrl = new AbortController();
    setOut("");
    setPhase("stream");
    (async () => {
      try {
        // Model gate — the shared status source, not a bare /health probe:
        // 503 while the weights load must read «запускается», never «не
        // запущена». The popover stays put (the captured text IS the
        // selection) and auto-retries: "starting" resolves by itself, "none"
        // resolves once the download + spawn finish. Only "dead" waits for
        // an explicit «Перезапустить».
        for (;;) {
          const status = await fetchModelStatus();
          if (ctrl.signal.aborted) return;
          if (statusUp(status)) break;
          if (status === "dead") return setPhase("dead");
          setPhase(status === "starting" ? "starting" : "nomodel");
          await sleep(2500, ctrl.signal);
        }
        setPhase("stream");
        const glossary = parseGlossary(loadGlossaryText(bookPath));
        await translateStream(text, glossary, (d) => setOut((o) => o + d), {
          context,
          signal: ctrl.signal,
        });
        setPhase("done");
      } catch {
        if (!ctrl.signal.aborted) setPhase("error");
      }
    })();
    return () => ctrl.abort();
  }, [text, context, bookPath, noTranslate, attempt]);

  // position: after first paint and whenever content grows
  useEffect(() => {
    if (ref.current) clampToViewport(ref.current, anchor);
  }, [anchor, out, phase]);

  // click outside closes (capture pointerdown so text-layer mousedown doesn't race)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(out).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [out]);

  return (
    <div
      ref={ref}
      data-popover
      className="overlay-pop fixed z-30 w-max max-w-[26rem] rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur shadow-xl text-sm text-neutral-800 dark:text-neutral-100"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 px-3 pt-2 text-xs text-neutral-500 dark:text-neutral-400 select-none">
        <span>{label ?? "Перевод"}</span>
        <span className="flex-1" />
        {(phase === "done" || out) && (
          <button className={LINK_HOVER} onClick={copy}>
            {copied ? "Скопировано" : "Копировать"}
          </button>
        )}
        <button className={`${LINK_HOVER} px-0.5`} onClick={onClose} title="Закрыть (Esc)">
          <IconClose />
        </button>
      </div>
      <div className="px-3 pb-2.5 pt-1 max-h-[45vh] overflow-y-auto leading-relaxed whitespace-pre-wrap">
        {phase === "starting" ? (
          <span className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400">
            <Spinner /> Модель запускается… ≈20 с
          </span>
        ) : phase === "nomodel" ? (
          dlBusy(dl) ? (
            <span className="text-neutral-500 dark:text-neutral-400 tabular-nums">
              Модель скачивается · {dlProgressLine(dl)}
            </span>
          ) : (
            <div className="text-neutral-600 dark:text-neutral-300">
              <div>Для перевода нужна модель — 4,6 ГБ, скачивается один раз, работает офлайн</div>
              {onSetup && (
                <button className={`mt-1.5 underline underline-offset-2 ${LINK_HOVER}`} onClick={onSetup}>
                  Скачать модель
                </button>
              )}
            </div>
          )
        ) : phase === "dead" ? (
          <div className="text-neutral-600 dark:text-neutral-300">
            <div>Модель не отвечает</div>
            <button
              className={`mt-1.5 underline underline-offset-2 ${LINK_HOVER}`}
              onClick={() => {
                void restartModel();
                setAttempt((a) => a + 1);
              }}
            >
              Перезапустить
            </button>
          </div>
        ) : phase === "error" ? (
          <div className="text-neutral-600 dark:text-neutral-300">
            <div>Не удалось перевести. Попробуйте ещё раз</div>
            <button
              className={`mt-1.5 underline underline-offset-2 ${LINK_HOVER}`}
              onClick={() => setAttempt((a) => a + 1)}
            >
              Повторить
            </button>
          </div>
        ) : (
          <>
            {out}
            {phase === "stream" && <span className="animate-pulse opacity-60">▍</span>}
          </>
        )}
      </div>
      {showAltHint && (
        <div className="border-t border-neutral-200/70 dark:border-neutral-700/70 px-3 py-1.5 text-xs text-neutral-500 dark:text-neutral-400 select-none">
          Alt+клик по абзацу — перевод целиком
        </div>
      )}
    </div>
  );
}

// ---- glossary modal ---------------------------------------------------------

type GenState =
  | { phase: "extract"; done: number; total: number }
  | { phase: "modelwait" }
  | { phase: "auxstart" }
  | { phase: "translate"; done: number; total: number }
  | { phase: "done"; added: number; skipped: number; auxUsed: boolean }
  // action: the error is fixable right here — «Скачать модель» / «Перезапустить»
  | { phase: "error"; msg: string; action?: "setup" | "restart" };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const onAbort = () => {
      clearTimeout(t);
      rej(new DOMException("aborted", "AbortError"));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      res();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });

// Bring the on-demand terminologist model (Qwen3.5-4B on 11545) up for the
// glossary run. Resolves true when the aux server answers; false → the caller
// falls back to the HY-MT ladder. Outside Tauri the invoke throws — an HTTP
// health probe of the same server stands in (same pattern as the status row).
// Model load takes ~10-30s; give up after 90s so the run never hangs.
async function ensureAux(signal: AbortSignal): Promise<boolean> {
  let s: string;
  try {
    s = await invoke<string>("aux_model_start");
  } catch {
    return isAuxUp();
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (s === "up" || s === "external") return true;
    if (s === "dead" || s === "none") return false;
    await sleep(1500, signal); // "starting"
    try {
      s = await invoke<string>("aux_model_status");
    } catch {
      return isAuxUp();
    }
  }
  return false;
}

// glossary modal hierarchy (WP-J): ONE primary action — the same filled-button
// idiom as ModelSetup's PRIMARY_BTN, compact; every other control is a quiet
// link, and «Перевести заново» is a quiet secondary so it can never be read
// as the modal's main verb.
const GEN_BTN =
  "inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-3 py-1.5 text-[13px] font-medium text-white dark:bg-neutral-100 dark:text-neutral-900";
const QUIET_LINK = "transition-colors hover:text-neutral-700 dark:hover:text-neutral-200 underline underline-offset-2";

export function GlossaryModal({
  bookPath,
  doc,
  onClose,
  onSetup,
  onRetranslate,
}: {
  bookPath: string;
  // the open book — «Собрать глоссарий» mines terms from all its pages
  doc: PDFDocumentProxy | null;
  onClose: () => void;
  // opens the model setup flow (license + download) — for the «нет модели» error
  onSetup?: () => void;
  // present only when a stored whole-book translation exists: deletes it and
  // restarts the pipeline with the current glossary
  onRetranslate?: () => void;
}) {
  const [text, setText] = useState(() => loadGlossaryText(bookPath));
  const textRef = useRef(text);
  textRef.current = text;
  const [gen, setGen] = useState<GenState | null>(null);
  // inline confirm for «Собрать заново» (a rebuild replaces the whole list)
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const genCtrl = useRef<AbortController | null>(null);
  const closedRef = useRef(false);
  // optional terminologist model (Qwen): offered here, downloaded on demand
  const auxDl = useDownload("aux");
  const [auxReady, setAuxReady] = useState<boolean | null>(null);
  useEffect(() => {
    modelFileReady("aux").then(setAuxReady);
  }, []);
  const showAuxOffer = !!doc && auxReady === false && auxDl.status !== "done";

  // autosave on close/unmount; a running generation is aborted, its partial
  // result is merged into storage by runGen's tail (closedRef branch).
  // closedRef is re-armed in the effect BODY: StrictMode's dev double-mount
  // runs this cleanup once on a still-open modal, and the ref survives the
  // remount — without the reset every later runGen would take the "modal
  // closed" branch and never show its result.
  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      genCtrl.current?.abort();
      saveGlossaryText(bookPath, textRef.current);
    };
  }, [bookPath]);

  // «Собрать глоссарий»: statistical term extraction over the whole book, then
  // the local model translates only the term list (with sentence context).
  // MERGE semantics — every existing line survives (broken "term = ?" artifacts
  // excepted), only new terms appended — so re-clicks are idempotent and cancel
  // keeps everything translated so far. «Собрать заново» reuses the same run
  // with fresh=true: the merge base is empty, so the RESULT replaces the list —
  // the textarea itself is never cleared up front, and an early failure (no
  // model, no terms) costs the user nothing.
  const runGen = useCallback(async (fresh = false) => {
    if (!doc || genCtrl.current) return;
    const ctrl = new AbortController();
    genCtrl.current = ctrl;
    const devCap = import.meta.env.DEV
      ? Number((window as unknown as { __pdferGlossCap?: unknown }).__pdferGlossCap)
      : NaN;
    // model gate — the shared vocabulary (#5/#6/#8): "starting" is waited out,
    // none/dead surface an action instead of a dead-end message. Checked BEFORE
    // the minutes-long extraction (WP-J: no model must fail in a second, not
    // after the mining) and re-checked after it — the model can die meanwhile.
    const modelGate = async (): Promise<boolean> => {
      let ms = await fetchModelStatus();
      while (ms === "starting") {
        setGen({ phase: "modelwait" });
        await sleep(2000, ctrl.signal);
        ms = await fetchModelStatus();
      }
      if (statusUp(ms)) return true;
      setGen(
        ms === "dead"
          ? { phase: "error", msg: "Модель не отвечает", action: "restart" }
          : { phase: "error", msg: "Для перевода нужна модель — 4,6 ГБ, скачивается один раз", action: "setup" },
      );
      return false;
    };
    try {
      if (!(await modelGate())) return;
      setGen({ phase: "extract", done: 0, total: doc.numPages });
      const terms = await extractTerms(doc, {
        cap: Number.isFinite(devCap) && devCap > 0 ? devCap : undefined,
        signal: ctrl.signal,
        onProgress: (done, total) => setGen({ phase: "extract", done, total }),
      });
      if (!terms.length) return setGen({ phase: "error", msg: "В книге не нашлось характерных терминов" });
      if (!(await modelGate())) return;
      // terminologist model: started on demand for this run, stopped in finally
      setGen({ phase: "auxstart" });
      const useAux = await ensureAux(ctrl.signal);
      setGen({ phase: "translate", done: 0, total: terms.length });
      const { pairs, skipped } = await translateTerms(terms, {
        signal: ctrl.signal,
        useAux,
        onProgress: (done, total) => setGen({ phase: "translate", done, total }),
      });
      // fresh (confirmed rebuild): empty base — the result replaces the list
      const base = fresh ? "" : closedRef.current ? loadGlossaryText(bookPath) : textRef.current;
      const { text: merged, added } = mergeGlossary(base, pairs);
      if (closedRef.current) {
        saveGlossaryText(bookPath, merged); // modal closed mid-run — don't lose the work
      } else {
        setText(merged);
        setGen({ phase: "done", added, skipped, auxUsed: useAux });
      }
    } catch {
      if (!ctrl.signal.aborted) setGen({ phase: "error", msg: "Не удалось собрать глоссарий. Попробуйте ещё раз" });
      else if (!closedRef.current) setGen(null); // cancelled before the translate phase
    } finally {
      genCtrl.current = null;
      // always free the aux model's VRAM — done, cancelled or failed alike
      // (no-op outside Tauri or when nothing was started; externals untouched)
      invoke("aux_model_stop").catch(() => {});
    }
  }, [doc, bookPath]);

  return (
    <div
      className="modal-backdrop fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel rounded-xl bg-white dark:bg-neutral-800 shadow-2xl p-4 w-[min(30rem,90vw)] text-sm text-neutral-800 dark:text-neutral-100">
        {/* 14px medium title: the modal has a name; the filename is context */}
        <div className="flex items-center gap-2 mb-2.5 select-none">
          <span className="font-medium">Глоссарий</span>
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-400 dark:text-neutral-500">
            {bookPath.split(/[\\/]/).pop()}
          </span>
          <button
            className="px-0.5 text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
            onClick={onClose}
            title="Закрыть (Esc)"
          >
            <IconClose />
          </button>
        </div>
        <textarea
          autoFocus
          className="w-full h-64 resize-y rounded-lg bg-neutral-100 dark:bg-neutral-900 p-2.5 font-mono text-[13px] leading-relaxed outline-none focus:ring-2 focus:ring-accent/60 dark:focus:ring-accent/50"
          placeholder={"attention = внимание\nпо одной паре на строку"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {(doc || onRetranslate) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-neutral-500 dark:text-neutral-400 select-none">
            {doc &&
              (gen === null || gen.phase === "done" || gen.phase === "error" ? (
                confirmRebuild ? (
                  // rebuild replaces the whole list — inline confirm (#12):
                  // consequence + a button naming the action, never «да/нет»
                  <>
                    <span>Список будет заменён, ручные правки пропадут</span>
                    <button
                      className="text-red-600 dark:text-red-400 underline underline-offset-2 transition-colors hover:text-red-700 dark:hover:text-red-300"
                      onClick={() => {
                        setConfirmRebuild(false);
                        runGen(true); // fresh run — the result replaces the list
                      }}
                    >
                      Заменить
                    </button>
                    <button className={QUIET_LINK} onClick={() => setConfirmRebuild(false)}>
                      Отмена
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={`${GEN_BTN} transition-colors hover:bg-neutral-700 dark:hover:bg-white`}
                      title={
                        text.trim()
                          ? "Пересобрать глоссарий с нуля — текущий список будет заменён (с подтверждением)"
                          : "Статистически извлечь термины из всей книги и перевести их локальной моделью"
                      }
                      onClick={() => (text.trim() ? setConfirmRebuild(true) : runGen())}
                    >
                      {/* non-empty list ⇒ true rebuild (confirm + replace); empty ⇒ first run */}
                      {text.trim() ? "Собрать заново" : "Собрать глоссарий"}
                    </button>
                    <span
                      title={
                        gen?.phase === "done" && !gen.auxUsed
                          ? "Термины переведены основной моделью — качество может быть ниже"
                          : undefined
                      }
                    >
                      {gen === null
                        ? "~2–3 мин, термины извлекаются из всей книги"
                        : gen.phase === "done"
                          ? `Добавлено: ${gen.added}` + (gen.skipped ? ` · не переведено: ${gen.skipped}` : "")
                          : gen.msg}
                    </span>
                    {gen?.phase === "error" && gen.action === "setup" && onSetup && (
                      <button className={QUIET_LINK} onClick={onSetup}>
                        Скачать модель
                      </button>
                    )}
                    {gen?.phase === "error" && gen.action === "restart" && (
                      <button
                        className={QUIET_LINK}
                        onClick={() => {
                          void restartModel();
                          setGen(null);
                        }}
                      >
                        Перезапустить
                      </button>
                    )}
                  </>
                )
              ) : (
                // the running state lives INSIDE the primary button — the modal
                // keeps one clear main action whether idle or working; a click
                // is a no-op (runGen's re-entry guard), cancel is explicit
                <>
                  <span className={`${GEN_BTN} cursor-default`} aria-busy="true">
                    <Spinner />
                    <span className="tabular-nums">
                      {gen.phase === "extract"
                        ? `Поиск терминов… ${gen.done}/${gen.total}`
                        : gen.phase === "modelwait"
                          ? "Модель запускается… ≈20 с"
                          : gen.phase === "auxstart"
                            ? "Загрузка модели… (до 30 с)"
                            : `Перевод терминов… ${gen.done}/${gen.total}`}
                    </span>
                  </span>
                  <button
                    className={QUIET_LINK}
                    onClick={() => genCtrl.current?.abort()}
                    title="Остановить — уже переведённые термины будут добавлены"
                  >
                    Отмена
                  </button>
                </>
              ))}
            <span className="flex-1" />
            {onRetranslate && (
              <button
                className="rounded-lg px-2.5 py-1.5 text-[13px] text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-700/60 dark:hover:text-neutral-200"
                title="Удалить сохранённый перевод книги и перевести заново с текущим глоссарием"
                onClick={() => {
                  // the pipeline snapshots the glossary at start — save the
                  // edits now, before the modal's unmount autosave would
                  saveGlossaryText(bookPath, textRef.current);
                  onRetranslate();
                }}
              >
                Перевести заново
              </button>
            )}
          </div>
        )}
        {/* optional Qwen terminologist (Р-3: user-initiated, license named);
            without it term translation falls back to the main model */}
        {showAuxOffer && (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400 select-none">
            {dlBusy(auxDl) ? (
              <>
                <span className="tabular-nums">Модель терминов: {dlProgressLine(auxDl)}</span>
                <button className={QUIET_LINK} onClick={() => cancelDownload("aux")}>
                  Отменить
                </button>
              </>
            ) : (
              <>
                <span>
                  {auxDl.status === "error"
                    ? dlErrorLine(auxDl.error)
                    : `Перевод терминов точнее с дополнительной моделью — ${MODEL_META.aux.sizeLabel}, лицензия Apache-2.0`}
                </span>
                <button className={QUIET_LINK} onClick={() => startDownload("aux")}>
                  {auxDl.received > 0 && (auxDl.status === "cancelled" || auxDl.status === "error")
                    ? `Продолжить · ${dlPct(auxDl)}%`
                    : "Скачать"}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
