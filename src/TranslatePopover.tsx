import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { invoke } from "@tauri-apps/api/core";
import { extractTerms, mergeGlossary, translateTerms } from "./glossarygen";
import { isAuxUp, isServerUp, loadGlossaryText, parseGlossary, saveGlossaryText, translateStream } from "./translate";

export type Anchor = { x: number; y: number };

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
      className="fixed z-20 flex items-center gap-1 rounded-full bg-white/90 dark:bg-neutral-800/90 backdrop-blur px-2 py-1 shadow-lg text-sm text-neutral-700 dark:text-neutral-200 select-none"
      // preserve the text selection: never let the bar steal focus/collapse it
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className="hover:opacity-60 px-1.5" onClick={onTranslate}>
        Перевести
      </button>
      <span className="opacity-40">·</span>
      <button className="hover:opacity-60 px-1.5" onClick={onAsk} title="Спросить Claude об этом фрагменте">
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
  label,
  noTranslate,
}: {
  anchor: Anchor;
  text: string;
  context?: string;
  bookPath: string;
  onClose: () => void;
  // header caption, default «Перевод»
  label?: string;
  // show text as-is, no model call — e.g. the stored original of an
  // already-translated paragraph on a reflowed page (label «Оригинал»)
  noTranslate?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [out, setOut] = useState("");
  const [phase, setPhase] = useState<"stream" | "done" | "down" | "error">("stream");
  const [copied, setCopied] = useState(false);

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
      if (!(await isServerUp())) {
        if (!ctrl.signal.aborted) setPhase("down");
        return;
      }
      try {
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
  }, [text, context, bookPath, noTranslate]);

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
      className="fixed z-30 w-max max-w-[26rem] rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur shadow-xl text-sm text-neutral-800 dark:text-neutral-100"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 px-3 pt-2 text-xs text-neutral-400 dark:text-neutral-500 select-none">
        <span>{label ?? "Перевод"}</span>
        <span className="flex-1" />
        {(phase === "done" || out) && (
          <button className="hover:opacity-60" onClick={copy}>
            {copied ? "скопировано" : "копировать"}
          </button>
        )}
        <button className="hover:opacity-60 px-0.5" onClick={onClose} title="Закрыть (Esc)">
          ×
        </button>
      </div>
      <div className="px-3 pb-2.5 pt-1 max-h-[45vh] overflow-y-auto leading-relaxed whitespace-pre-wrap">
        {phase === "down" ? (
          <span className="opacity-60">Модель перевода не запущена</span>
        ) : phase === "error" ? (
          <span className="opacity-60">Ошибка перевода</span>
        ) : (
          <>
            {out}
            {phase === "stream" && <span className="animate-pulse opacity-60">▍</span>}
          </>
        )}
      </div>
    </div>
  );
}

// ---- glossary modal ---------------------------------------------------------

type GenState =
  | { phase: "extract"; done: number; total: number }
  | { phase: "auxstart" }
  | { phase: "translate"; done: number; total: number }
  | { phase: "done"; added: number; skipped: number; auxUsed: boolean }
  | { phase: "error"; msg: string };

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

export function GlossaryModal({
  bookPath,
  doc,
  onClose,
  onRetranslate,
}: {
  bookPath: string;
  // the open book — «Собрать глоссарий» mines terms from all its pages
  doc: PDFDocumentProxy | null;
  onClose: () => void;
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
  // keeps everything translated so far. «Собрать заново» reuses the same run:
  // the confirmed rebuild clears the textarea first, so the merge base is empty
  // and the result is a fresh list.
  const runGen = useCallback(async () => {
    if (!doc || genCtrl.current) return;
    const ctrl = new AbortController();
    genCtrl.current = ctrl;
    const devCap = import.meta.env.DEV
      ? Number((window as unknown as { __pdferGlossCap?: unknown }).__pdferGlossCap)
      : NaN;
    try {
      setGen({ phase: "extract", done: 0, total: doc.numPages });
      const terms = await extractTerms(doc, {
        cap: Number.isFinite(devCap) && devCap > 0 ? devCap : undefined,
        signal: ctrl.signal,
        onProgress: (done, total) => setGen({ phase: "extract", done, total }),
      });
      if (!terms.length) return setGen({ phase: "error", msg: "термины не найдены" });
      if (!(await isServerUp())) return setGen({ phase: "error", msg: "модель перевода не запущена" });
      // terminologist model: started on demand for this run, stopped in finally
      setGen({ phase: "auxstart" });
      const useAux = await ensureAux(ctrl.signal);
      setGen({ phase: "translate", done: 0, total: terms.length });
      const { pairs, skipped } = await translateTerms(terms, {
        signal: ctrl.signal,
        useAux,
        onProgress: (done, total) => setGen({ phase: "translate", done, total }),
      });
      const base = closedRef.current ? loadGlossaryText(bookPath) : textRef.current;
      const { text: merged, added } = mergeGlossary(base, pairs);
      if (closedRef.current) {
        saveGlossaryText(bookPath, merged); // modal closed mid-run — don't lose the work
      } else {
        setText(merged);
        setGen({ phase: "done", added, skipped, auxUsed: useAux });
      }
    } catch {
      if (!ctrl.signal.aborted) setGen({ phase: "error", msg: "ошибка генерации" });
      else if (!closedRef.current) setGen(null); // cancelled during extraction/aux start
    } finally {
      genCtrl.current = null;
      // always free the aux model's VRAM — done, cancelled or failed alike
      // (no-op outside Tauri or when nothing was started; externals untouched)
      invoke("aux_model_stop").catch(() => {});
    }
  }, [doc, bookPath]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="rounded-xl bg-white dark:bg-neutral-800 shadow-2xl p-4 w-[min(30rem,90vw)] text-sm text-neutral-800 dark:text-neutral-100">
        <div className="flex items-center mb-2 text-xs text-neutral-400 dark:text-neutral-500 select-none">
          <span>Глоссарий — {bookPath.split(/[\\/]/).pop()}</span>
          <span className="flex-1" />
          <button className="hover:opacity-60 px-0.5" onClick={onClose} title="Закрыть (Esc)">
            ×
          </button>
        </div>
        <textarea
          autoFocus
          className="w-full h-64 resize-y rounded-lg bg-neutral-100 dark:bg-neutral-900 p-2.5 font-mono text-[13px] leading-relaxed outline-none"
          placeholder={"термин = перевод, по строке"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {(doc || onRetranslate) && (
          <div className="mt-2 flex items-center gap-2 text-xs text-neutral-400 dark:text-neutral-500 select-none">
            {doc &&
              (gen === null || gen.phase === "done" || gen.phase === "error" ? (
                confirmRebuild ? (
                  // rebuild replaces the whole list — inline confirm, same
                  // pattern as «Перезапустить перевод» in the App menu
                  <>
                    <span>Заменить текущий глоссарий? Ручные правки будут потеряны</span>
                    <button
                      className="hover:text-neutral-600 dark:hover:text-neutral-300 underline underline-offset-2"
                      onClick={() => {
                        setConfirmRebuild(false);
                        setText(""); // fresh list: empty merge base, no old content
                        runGen();
                      }}
                    >
                      да
                    </button>
                    <span className="opacity-40">·</span>
                    <button
                      className="hover:text-neutral-600 dark:hover:text-neutral-300 underline underline-offset-2"
                      onClick={() => setConfirmRebuild(false)}
                    >
                      нет
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="hover:text-neutral-600 dark:hover:text-neutral-300 underline underline-offset-2"
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
                    <span className="opacity-80">
                      {gen === null
                        ? "~2–3 мин, термины извлекаются из всей книги"
                        : gen.phase === "done"
                          ? `добавлено: ${gen.added}` +
                            (gen.skipped ? `, пропущено: ${gen.skipped}` : "") +
                            (gen.auxUsed ? "" : " · без модели терминов")
                          : gen.msg}
                    </span>
                  </>
                )
              ) : (
                <>
                  <span className="tabular-nums">
                    {gen.phase === "extract"
                      ? `Извлечение… ${gen.done}/${gen.total}`
                      : gen.phase === "auxstart"
                        ? "Запуск модели терминов…"
                        : `Перевод терминов ${gen.done}/${gen.total}`}
                  </span>
                  <button
                    className="hover:text-neutral-600 dark:hover:text-neutral-300 underline underline-offset-2"
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
                className="hover:text-neutral-600 dark:hover:text-neutral-300 underline underline-offset-2"
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
      </div>
    </div>
  );
}
