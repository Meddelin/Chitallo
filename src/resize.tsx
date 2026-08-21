// ---- Ручка ширины правой колонки --------------------------------------------
//
// Одна ручка на два экрана: панель читалки (Panel.tsx) и карточка подробностей
// графа (GraphView.tsx). Пока подрядчики правили свои файлы, ручка жила в обоих
// копией; отдельный модуль сводит их обратно (WP-N) — боковая колонка тянется в
// приложении одинаково, и расходиться этим двум местам больше нечем.
//
// Своим файлом, а не экспортом из Panel.tsx, по причине из askwidth.ts: модуль,
// который отдаёт и компонент, и значения, теряет Fast Refresh, а тянуть графу
// зависимость от всей панели читалки ради восьмидесяти строк незачем.
//
// VS Code / Cursor grammar: an invisible 8 px strip on the panel edge, a 2 px
// tint on hover or drag, col-resize cursor. No grip dots — they would be the
// only ornamented control in an app of quiet pills (WP-K).

import { useEffect, useRef } from "react";
import { ASK_W_DEFAULT, ASK_W_MIN, askWMax } from "./askwidth";
import { t } from "./i18n";

export function ResizeHandle({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
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
    cancelAnimationFrame(raf.current); // one width write per frame — Conversation and the graph canvas re-lay out on every change
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
    // book back to page 1 while the handle only resized the panel), and on the
    // graph screen the same keys pan the canvas
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <>
      {/* Правила протяжки едут вместе с ручкой: нужны они только пока тянут, а
          App.css — общий файл, куда ради этого лезть незачем. Оба экрана ставят
          один и тот же флаг html[data-askresize], так что и правило одно.
          `.toolbar` есть только у читалки; на экране графа селектор молчит. */}
      <style>{
        "html[data-askresize]{cursor:col-resize;user-select:none}" +
        "html[data-askresize] .toolbar{transition:none}"
      }</style>
      <div
        aria-label={t("ask.panelWidth")}
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
        title={t("ask.panelWidthTitle")}
      >
        <div className="pointer-events-none mx-auto h-full w-0.5 bg-transparent transition-colors group-hover/rz:bg-neutral-400/70 group-focus-visible/rz:bg-neutral-400/70 dark:group-hover/rz:bg-neutral-500/70 dark:group-focus-visible/rz:bg-neutral-500/70" />
      </div>
    </>
  );
}
