// Перевод выделенного: мини-панель у конца выделения и попап с ответом.
//
// Здесь же жила GlossaryModal — глоссарий открывался из перевода, потому что
// был его частью. Он ею быть перестал: тело модалки переехало в
// GlossaryPanel.tsx, во вкладку «Термины», и этот файл снова про одно —
// перевести кусок текста, на который читатель показал. Глоссарий он по-прежнему
// ЧИТАЕТ (parseGlossary ниже кладёт пары в промпт) — как один из потребителей
// хранилища, а не как его хозяин.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadGlossaryText, parseGlossary, translateStream } from "./translate";
import {
  Spinner,
  dlBusy,
  dlProgressLine,
  fetchModelStatus,
  restartModel,
  sizeLabel,
  statusUp,
  useDownload,
} from "./ModelSetup";
import { copyToClipboard } from "./clipboard";
import { fmtNum, t } from "./i18n";
import { IconClose } from "./icons";

export type Anchor = { x: number; y: number };

// pill controls: the app-wide hover grammar (WP-K) — quiet bg tint, no opacity
// dim. Round like the bar around them, so the three verbs read as one control
// strip and not as words with a background. (WP-N)
const PILL_BTN =
  "rounded-full px-2.5 py-0.5 transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";
// inline text links: muted base, hover strengthens the color (same grammar as QUIET_LINK)
const LINK_HOVER = "transition-colors hover:text-neutral-800 dark:hover:text-neutral-100";

// popover-openings counter for the Alt+click footer hint (Н6, first 3 opens)
const ALT_HINT_KEY = "pdfer:hint:altclick";

const PAD = 8;

// Один таймер с отменой на весь файл: попапу он нужен, чтобы переспросить
// состояние модели, пока та поднимается. Свой в каждом модуле — так в этом
// проекте живут все четыре (booktranslate.ts:656, glossarygen.ts:409,
// graphgen.ts:550, здесь); экспортировать его отсюда значило бы сделать
// попап зависимостью тех, кто с ним никак не связан.
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const onAbort = () => {
      clearTimeout(timer);
      rej(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      res();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });

// The anchor rule, in one place: the bar hangs off the END of the selection —
// «Перевести»/«Оригинал» belong to the text the user just finished dragging
// over. Kept identical to the value the App captures at pointerup so a
// re-anchor never visibly moves the bar.
function anchorOf(last: DOMRect): Anchor {
  return { x: last.right + 4, y: last.bottom + 6 };
}

// WP-Q: the translate popover's position is computed ONCE per anchor and never
// again — while the answer streams in, the popover only grows downward and
// then scrolls inside itself, it never slides around under the cursor.
// Reservations make the one-shot clamp safe: the full max-w is reserved
// horizontally (width grows toward it as text streams), and MIN_RESERVE px
// vertically (instantly-full popovers — «Оригинал» — measure real height
// instead). maxHeight caps growth at the viewport edge; past it the flex
// column shrinks the scrollable body.
const MIN_RESERVE = 160;
function placePopover(el: HTMLElement, a: Anchor) {
  const pad = 8;
  const r = el.getBoundingClientRect();
  const maxW = Math.min(parseFloat(getComputedStyle(el).maxWidth) || r.width, window.innerWidth - 2 * pad);
  const x = Math.min(Math.max(pad, a.x), window.innerWidth - maxW - pad);
  const reserve = Math.max(r.height, MIN_RESERVE);
  const y = Math.min(a.y, Math.max(pad, window.innerHeight - reserve - pad));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.maxHeight = `${window.innerHeight - y - pad}px`;
}

// ---- selection mini-toolbar: «Перевести»/«Оригинал» + «Спросить» -----------

export function SelectionBar({
  anchor,
  scrollerRef,
  liveAnchorRef,
  layoutKey,
  onGone,
  onTranslate,
  onOriginal,
  onAsk,
}: {
  anchor: Anchor;
  // the reading scroller. It — not the window — is the bar's world: it is the
  // clipping box the hide rule tests against, and the box the bar is clamped
  // into, so an open «Спросить» sidebar never gets the bar parked on top of it.
  scrollerRef?: React.RefObject<HTMLElement | null>;
  // out-param: where the bar actually sits at this instant. The popover opens
  // at the bar's live spot, not at the point the selection had when it was made
  // — otherwise «Перевести» after a scroll answers off-screen.
  liveAnchorRef?: React.MutableRefObject<Anchor>;
  // any value that changes page layout (масштаб, колонки, режим, кегль): the
  // bar re-anchors once the new layout has settled
  layoutKey?: string | number;
  // the selection the bar points at is gone — it collapsed, or a zoom/mode
  // re-render replaced the very nodes it covered (which fires NO
  // selectionchange, so this callback is the only signal)
  onGone?: () => void;
  // original-text selections: translate them (absent on translated pages)
  onTranslate?: () => void;
  // selections inside the reflowed translation: peek at the stored original
  // (label «Оригинал», key O). «Перевести» is deliberately dropped there —
  // translating already-translated Russian back to Russian is nonsense, and
  // an EN target would be a different feature; one honest primary per surface.
  onOriginal?: () => void;
  // opens the Claude sidebar seeded with the quoted selection + page context
  onAsk: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(undefined);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;

  // Re-anchor from the LIVE selection, every time. The bar is position:fixed,
  // so an anchor captured once in viewport coordinates drifts 1:1 with every
  // scrolled pixel — the bug this exists to kill. Reading the selection afresh
  // also makes keyboard-extended selections (Shift+→/↓) track, and makes an
  // empty rect list the collapse/teardown detector.
  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const s = document.getSelection();
    const range = s && s.rangeCount > 0 && !s.isCollapsed ? s.getRangeAt(0) : null;
    const rects = range ? range.getClientRects() : null;
    if (!rects || rects.length === 0) return void goneRef.current?.();
    const first = rects[0];
    const last = rects[rects.length - 1];
    const r = el.getBoundingClientRect();

    const sc = scrollerRef?.current?.getBoundingClientRect();
    const minX = Math.max(PAD, sc ? sc.left + PAD : PAD);
    const maxX = Math.min(window.innerWidth - PAD, sc ? sc.right - PAD : window.innerWidth - PAD);
    const minY = Math.max(PAD, sc ? sc.top + PAD : PAD);
    const maxY = Math.min(window.innerHeight - PAD, sc ? sc.bottom - PAD : window.innerHeight - PAD);

    // Floating UI's referenceHidden rule: once the anchored end of the
    // selection is fully outside the reading area, hide — but stay MOUNTED, so
    // scrolling back brings the same bar, with its captured payload, back.
    if (sc && (last.top > sc.bottom - PAD || last.bottom < sc.top + PAD || last.left > sc.right || last.right < sc.left)) {
      el.style.visibility = "hidden";
      el.style.pointerEvents = "none";
      return;
    }
    el.style.visibility = "";
    el.style.pointerEvents = "";

    // Below the selection normally; above it when the line sits too close to
    // the bottom edge. The old clamp pinned the bar to the viewport bottom
    // instead, which parked it right on top of the text it belongs to.
    const below = anchorOf(last);
    const flip = below.y + r.height > maxY;
    const y = flip ? Math.max(minY, first.top - r.height - 6) : below.y;
    // flipped-up bars align with the selection's START — hugging the first
    // line's left edge, the way every bubble menu does it
    const x = Math.min(Math.max(minX, flip ? first.left : below.x), Math.max(minX, maxX - r.width));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (liveAnchorRef) liveAnchorRef.current = { x, y };
  }, [scrollerRef, liveAnchorRef]);

  // one shared rAF token for every trigger: a scroll storm re-anchors once per
  // frame, and the writes are imperative — no setState, no re-render, no thrash
  const schedule = useCallback(() => {
    if (rafRef.current !== undefined) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = undefined;
      place();
    });
  }, [place]);

  useLayoutEffect(() => {
    place();
  }, [place, anchor]);

  // a zoom / column / view-mode / font change re-lays the page out
  // asynchronously — measure after it has settled (the double-rAF the App
  // already uses for its own post-layout scroll fixes)
  useLayoutEffect(() => {
    place();
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(place);
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [layoutKey, place]);

  useEffect(() => {
    // capture + document: catches the reading scroller AND any other scroller
    // an ancestor might introduce; selectionchange covers Shift+arrow edits
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("resize", schedule);
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    };
  }, [schedule]);

  return (
    <div
      ref={ref}
      data-selbar
      style={{ left: anchor.x, top: anchor.y }}
      className="overlay-pop fixed z-20 flex items-center gap-0.5 rounded-full bg-white/90 dark:bg-neutral-800/90 backdrop-blur px-2 py-1 shadow-lg text-sm text-neutral-700 dark:text-neutral-200 select-none"
      // preserve the text selection: never let the bar steal focus/collapse it
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {onOriginal ? (
        <button className={PILL_BTN} onClick={onOriginal} title={t("sel.originalTitle")}>
          {t("sel.original")}
        </button>
      ) : onTranslate ? (
        <button className={PILL_BTN} onClick={onTranslate} title={t("sel.translateTitle")}>
          {t("sel.translate")}
        </button>
      ) : null}
      <button className={PILL_BTN} onClick={onAsk} title={t("sel.askTitle")}>
        {t("sel.ask")}
      </button>
    </div>
  );
}

// ---- translate popover ------------------------------------------------------

// Every refusal the popover can show has the same shape (WP-N): what happened
// on the left, the one verb out of it on the right — and the verb is a button,
// never a word inside the sentence.
function Refusal({ cause, verb, onVerb }: { cause: string; verb?: string; onVerb?: () => void }) {
  return (
    <div className="flex items-baseline gap-3 text-neutral-600 dark:text-neutral-300">
      <span className="min-w-0 flex-1">{cause}</span>
      {verb && onVerb && (
        <button className={`shrink-0 ${LINK_HOVER}`} onClick={onVerb}>
          {verb}
        </button>
      )}
    </div>
  );
}

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
  // opens the model setup flow (licence + download) — the «Download» CTA
  onSetup?: () => void;
  // header caption, default «Translation»
  label?: string;
  // show text as-is, no model call — e.g. the stored original of an
  // already-translated paragraph on a reflowed page (label «Оригинал»)
  noTranslate?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // noTranslate mounts with its full text so the one-shot placement below
  // measures the real height (no stream will ever grow it)
  const [out, setOut] = useState(() => (noTranslate ? text : ""));
  const [phase, setPhase] = useState<"stream" | "done" | "starting" | "nomodel" | "dead" | "error">(
    noTranslate ? "done" : "stream",
  );
  const [copied, setCopied] = useState(false);
  // seconds the model spent on this fragment — the footer's number once it is
  // done. Direction B says status out loud in numbers, and this is the only
  // number a selection translation has. (WP-N)
  const [took, setTook] = useState<number | null>(null);
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
    setTook(null);
    (async () => {
      try {
        // Model gate — the shared status source, not a bare /health probe:
        // 503 while the weights load must read «starting», never «not
        // running». The popover stays put (the captured text IS the
        // selection) and auto-retries: "starting" resolves by itself, "none"
        // resolves once the download + spawn finish. Only "dead" waits for an
        // explicit «Restart».
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
        // the clock starts here, past the model gate: a cold start is
        // «Модель запускается · ~20 с», not slow translation
        const t0 = performance.now();
        await translateStream(text, glossary, (d) => setOut((o) => o + d), {
          context,
          signal: ctrl.signal,
        });
        setTook((performance.now() - t0) / 1000);
        setPhase("done");
      } catch {
        if (!ctrl.signal.aborted) setPhase("error");
      }
    })();
    return () => ctrl.abort();
  }, [text, context, bookPath, noTranslate, attempt]);

  // position: once per anchor, before first paint — and never on content
  // growth (WP-Q: no jumping while the translation streams in)
  useLayoutEffect(() => {
    if (ref.current) placePopover(ref.current, anchor);
  }, [anchor]);

  // click outside closes (capture pointerdown so text-layer mousedown doesn't race)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  // What the footer says about the run: «Перевожу…» while it streams, the model
  // and the seconds it took once it is over. Nothing at all on the «Оригинал»
  // popover — nothing ran there. (WP-N)
  const status = noTranslate
    ? null
    : phase === "stream"
      ? t("pop.translating")
      : phase === "done" && took !== null
        ? // floored, so a cached or very short answer never reads «0,0 с»
          t("pop.took", { sec: fmtNum(Math.max(0.1, took)) })
        : null;

  const copy = useCallback(() => {
    void copyToClipboard(out).then((ok) => {
      if (!ok) return; // nothing was copied — do not claim otherwise
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [out]);

  return (
    <div
      ref={ref}
      data-popover
      className="overlay-pop fixed z-30 flex w-max max-w-[26rem] flex-col rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur shadow-xl text-sm text-neutral-800 dark:text-neutral-100"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2 text-xs text-neutral-500 dark:text-neutral-400 select-none">
        <span>{label ?? t("tb.translation")}</span>
        <span className="flex-1" />
        {(phase === "done" || out) && (
          <button className={LINK_HOVER} onClick={copy}>
            {copied ? t("ui.copied") : t("ui.copy")}
          </button>
        )}
        <button className={`${LINK_HOVER} px-0.5`} onClick={onClose} title={t("ui.close")}>
          <IconClose />
        </button>
      </div>
      <div className="min-h-0 px-3 pb-2.5 pt-1 max-h-[45vh] overflow-y-auto leading-relaxed whitespace-pre-wrap">
        {phase === "starting" ? (
          <span className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400">
            <Spinner /> {t("model.startingShort")}
          </span>
        ) : phase === "nomodel" ? (
          dlBusy(dl) ? (
            <span className="text-neutral-500 dark:text-neutral-400 tabular-nums">
              {t("model.downloadingDetail", { detail: dlProgressLine(dl) })}
            </span>
          ) : (
            <Refusal
              cause={t("model.needed", { size: sizeLabel("main") })}
              verb={onSetup ? t("model.downloadShort") : undefined}
              onVerb={onSetup}
            />
          )
        ) : phase === "dead" ? (
          <Refusal
            cause={t("pop.modelGone")}
            verb={t("pop.check")}
            onVerb={() => {
              void restartModel();
              setAttempt((a) => a + 1);
            }}
          />
        ) : phase === "error" ? (
          <Refusal cause={t("pop.failed")} verb={t("ui.retry")} onVerb={() => setAttempt((a) => a + 1)} />
        ) : (
          <>
            {out}
            {phase === "stream" && <span className="animate-pulse opacity-60">▍</span>}
          </>
        )}
      </div>
      {(status || showAltHint) && (
        <div className="shrink-0 border-t border-neutral-200/70 dark:border-neutral-700/70 px-3 py-1.5 text-xs text-neutral-500 dark:text-neutral-400 select-none">
          {status && <div className="tabular-nums">{status}</div>}
          {showAltHint && <div className={status ? "mt-0.5" : ""}>{t("pop.altHint")}</div>}
        </div>
      )}
    </div>
  );
}
