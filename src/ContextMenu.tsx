import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Anchor } from "./TranslatePopover";

// ---- Chitallo's right-click menu ----------------------------------------------
//
// Custom surface, deliberately NOT Tauri's Menu.popup():
//  - `accelerator` on a native item REGISTERS the shortcut, it does not merely
//    draw it. Chitallo's bare letters (T, O, D, ?) and Enter-confirms-selection
//    would gain a second owner; here the key is a grey hint column and nothing
//    more;
//  - a native menu cannot render that hint column, the accent primary or the
//    dark theme, and a Win32 menu inside this chromeless reader reads as a bug
//    next to «Перевод ▾», Оглавление, the zoom flyout and Ctrl+K, which are all
//    overlay-pop surfaces;
//  - Menu.new() + popup() are async IPC per right-click, and popup() positions
//    window-relative while our events are viewport-relative;
//  - @tauri-apps/api/menu does not exist in the dev harness (localhost:1420),
//    i.e. the native menu would be invisible to the loop that verifies it.
//
// The cost — arrow-key navigation and edge flipping — is the code below.

// A row names one operation, with the same word the rest of the app uses for
// it; `hint` is the key that already does the same thing. Separators group.
export type CtxItem = { id: string; label: string; hint?: string; run: () => void } | { sep: true };

const PAD = 8;

// Mirrors App's MENU_ROW (the «Перевод» menu grammar) with the hint column
// added; kept local so ContextMenu imports nothing from App.
const ROW =
  "w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-6 transition-colors whitespace-nowrap";

// The one fill direction B uses for «this row is chosen» — the same on the
// palette rows and the panel's tabs, so a highlight never means two things.
const ROW_SEL = "bg-neutral-100 dark:bg-neutral-100/8";

// One-shot placement: the cursor is the menu's top-left, mirrored to the other
// side of the cursor when that would overflow — the Windows convention — and
// finally clamped so a menu taller than the gap still fits on screen.
function place(el: HTMLElement, a: Anchor) {
  const r = el.getBoundingClientRect();
  const flipX = a.x + r.width + PAD > window.innerWidth;
  const flipY = a.y + r.height + PAD > window.innerHeight;
  const x = flipX ? a.x - r.width : a.x;
  const y = flipY ? a.y - r.height : a.y;
  el.style.left = `${Math.min(Math.max(PAD, x), Math.max(PAD, window.innerWidth - r.width - PAD))}px`;
  el.style.top = `${Math.min(Math.max(PAD, y), Math.max(PAD, window.innerHeight - r.height - PAD))}px`;
}

export function ContextMenu({
  at,
  items,
  keyboard,
  onClose,
}: {
  at: Anchor;
  items: CtxItem[];
  // raised by Shift+F10 / the Menu key: row 0 is highlighted up front, so the
  // arrows have something to move from with no pointer in play
  keyboard?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(keyboard ? items.findIndex((it) => !("sep" in it)) : -1);

  useLayoutEffect(() => {
    if (ref.current) place(ref.current, at);
  }, [at, items]);

  const run = useCallback(
    (it: CtxItem) => {
      if ("sep" in it) return;
      onClose();
      it.run();
    },
    [onClose],
  );

  // dismissal: outside pointerdown, ANY scroll, resize, window blur — and Esc.
  // The menu owns its own Escape, capture-phase on document, because it is the
  // topmost layer and the focused element may swallow the key before window
  // ever sees it (the find input stops propagation on its own Escape, and
  // Ctrl+F → right-click leaves focus right there). App's Esc chain keeps the
  // menu as its first branch for the no-focus case; this one just wins first.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-ctxmenu]")) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    const shut = () => onClose();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onEsc, true);
    document.addEventListener("scroll", shut, { capture: true, passive: true });
    window.addEventListener("resize", shut);
    window.addEventListener("blur", shut);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onEsc, true);
      document.removeEventListener("scroll", shut, true);
      window.removeEventListener("resize", shut);
      window.removeEventListener("blur", shut);
    };
  }, [onClose]);

  // ↑/↓ move (separators are skipped), Home/End jump, Enter activates. The
  // listener is on window because the menu never takes focus — stealing it
  // would drop the text selection «Копировать» and «Спросить» run on. App's
  // own key handler stands down while the menu is open (except Escape).
  useEffect(() => {
    const live = items.map((it, i) => ("sep" in it ? -1 : i)).filter((i) => i >= 0);
    if (!live.length) return;
    const onKey = (e: KeyboardEvent) => {
      const pos = live.indexOf(cur);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCur(live[pos < 0 ? 0 : Math.min(live.length - 1, pos + 1)]);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCur(live[pos < 0 ? live.length - 1 : Math.max(0, pos - 1)]);
      } else if (e.key === "Home") {
        e.preventDefault();
        setCur(live[0]);
      } else if (e.key === "End") {
        e.preventDefault();
        setCur(live[live.length - 1]);
      } else if (e.key === "Enter" && cur >= 0) {
        e.preventDefault();
        run(items[cur]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, cur, run]);

  return (
    <div
      ref={ref}
      data-ctxmenu
      role="menu"
      style={{ left: at.x, top: at.y }}
      className="overlay-pop fixed z-[45] flex min-w-[11rem] flex-col gap-0.5 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur shadow-xl p-1.5 text-sm text-neutral-800 dark:text-neutral-100 select-none"
      // never steal focus: the document selection must survive until the
      // chosen row has run (same guard as SelectionBar)
      onMouseDown={(e) => e.preventDefault()}
      // a right-click ON the menu must not raise a second one
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        "sep" in it ? (
          <div key={`sep${i}`} className="my-1 h-px bg-neutral-200 dark:bg-neutral-700" />
        ) : (
          <button
            key={it.id}
            role="menuitem"
            data-idx={i}
            data-sel={i === cur || undefined}
            className={`${ROW} ${i === cur ? ROW_SEL : ""}`}
            // move only — a scroll under a still cursor must not steal the row
            onMouseMove={() => setCur(i)}
            onClick={() => run(it)}
          >
            <span className="flex-1 min-w-0 truncate">{it.label}</span>
            {it.hint && (
              <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
                {it.hint}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
