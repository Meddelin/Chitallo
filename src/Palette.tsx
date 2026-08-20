// Ctrl+K command palette + «?» shortcut overlay — the keyboard-teaching
// surfaces (WP-E). The palette is the Linear-style all-in-one: every existing
// action with its key hint, «Страница N» for digit queries, «Найти: …» as the
// search fallback, and fuzzy book switching over the library index
// (pdfer:books). App owns the actions and passes them down as commands; this
// file owns matching, keyboard selection and the two surfaces' rendering —
// both in the app's existing grammar (blurred /95 pill surface for the
// palette, solid modal like GlossaryModal for the overlay).

import { useEffect, useMemo, useRef, useState } from "react";
import { IconClose } from "./icons";
import { baseName, isMac, macKeys } from "./host";
import { t } from "./i18n";

export type PaletteCommand = {
  id: string;
  label: string;
  hint?: string; // key hint, right-aligned, e.g. "Ctrl+F"
  keywords?: string; // extra fuzzy-match targets (latin aliases etc.)
  run: () => void;
};

type BookEntry = { path: string; name: string; title: string };
type Row = { key: string; label: string; hint?: string; tag?: string; run: () => void };

const WORD_START = /[\s\-–—_.():,/\\«»"']/;

// subsequence fuzzy score; null = no match. Substring hits rank far above
// scattered subsequences, word starts above mid-word hits, runs above gaps.
function fuzzy(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  const sub = t.indexOf(q);
  if (sub >= 0) return 100 - Math.min(50, sub) + (sub === 0 || WORD_START.test(t[sub - 1]) ? 30 : 0);
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      score += 1 + streak * 2 + (ti === 0 || WORD_START.test(t[ti - 1]) ? 8 : 0);
      streak++;
    } else streak = 0;
  }
  return qi === q.length ? score : null;
}

export function Palette({
  commands,
  numPages,
  currentPath,
  onOpenBook,
  onGoToPage,
  onFind,
  onClose,
}: {
  commands: PaletteCommand[];
  numPages?: number; // undefined = no book open (no page/find rows)
  currentPath: string | null;
  onOpenBook: (path: string) => void;
  onGoToPage: (n: number) => void;
  onFind?: (q: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // library index (pdfer:books): every scanned book, switchable by title/name
  const books = useMemo<BookEntry[]>(() => {
    try {
      const idx = JSON.parse(localStorage.getItem("pdfer:books") ?? "{}") as Record<string, { title?: string }>;
      return Object.entries(idx).map(([path, e]) => ({
        path,
        name: baseName(path).replace(/\.pdf$/i, ""),
        title: (e?.title ?? "").trim(),
      }));
    } catch {
      return [];
    }
  }, []);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const scored: { s: number; row: Row }[] = [];
    // digits → «Page N», always on top
    if (q && /^\d+$/.test(q) && numPages) {
      const n = Math.min(numPages, Math.max(1, parseInt(q, 10)));
      scored.push({
        s: 1e6,
        row: { key: "page", label: t("pal.page", { n }), hint: `1–${numPages}`, run: () => onGoToPage(n) },
      });
    }
    for (const c of commands) {
      const s = q ? Math.max(fuzzy(q, c.label) ?? -1, c.keywords ? (fuzzy(q, c.keywords) ?? -1) : -1) : 0;
      if (s >= 0) scored.push({ s: s + 1, row: { key: c.id, label: c.label, hint: c.hint, run: c.run } });
    }
    if (q) {
      // books join only for a non-empty query (the empty palette is a command
      // cheat-sheet), capped so one common word can't flood the list
      books
        .filter((b) => b.path !== currentPath)
        .map((b) => ({ b, s: fuzzy(q, `${b.title} ${b.name}`) }))
        .filter((x): x is { b: BookEntry; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s)
        .slice(0, 6)
        .forEach(({ b, s }) =>
          scored.push({
            s,
            row: { key: `book:${b.path}`, label: b.title || b.name, tag: t("pal.bookTag"), run: () => onOpenBook(b.path) },
          }),
        );
      // full-text fallback — always last (score below any match)
      if (onFind) scored.push({ s: -1, row: { key: "findq", label: t("pal.findQ", { q }), run: () => onFind(q) } });
    }
    return scored.sort((a, b) => b.s - a.s).map((x) => x.row);
  }, [query, commands, books, numPages, currentPath, onGoToPage, onOpenBook, onFind]);

  useEffect(() => setSel(0), [query]);
  const cur = Math.min(sel, Math.max(0, rows.length - 1));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  const run = (r: Row) => {
    onClose();
    r.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setSel(Math.min(rows.length - 1, cur + 1));
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setSel(Math.max(0, cur - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[cur]) run(rows[cur]);
    } else if (e.key === "Escape") {
      e.stopPropagation(); // App's Esc chain must not also fire
      onClose();
    }
  };

  return (
    <div
      data-palette
      className="modal-backdrop fixed inset-0 z-50 flex items-start justify-center bg-black/20"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="overlay-pop mt-[16vh] w-[min(33rem,92vw)] rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur shadow-xl text-sm text-neutral-800 dark:text-neutral-100 select-none">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={numPages ? t("pal.placeholder") : t("pal.placeholderNoDoc")}
          spellCheck={false}
          className="w-full bg-transparent outline-none px-4 py-3 placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
        />
        <div
          ref={listRef}
          className="border-t border-neutral-200 dark:border-neutral-700 max-h-[45vh] overflow-y-auto overscroll-contain p-1.5"
        >
          {rows.length === 0 ? (
            <div className="px-2.5 py-1.5 text-neutral-500 dark:text-neutral-400 cursor-default">{t("ui.notFound")}</div>
          ) : (
            rows.map((r, i) => (
              <button
                key={r.key}
                data-idx={i}
                data-sel={i === cur || undefined}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 ${
                  i === cur ? "bg-neutral-100 dark:bg-neutral-700/70" : ""
                }`}
                // preserve input focus (Enter keeps working) — same pattern as FindBar's buttons
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setSel(i)} // move only — scroll under a still cursor must not steal selection
                onClick={() => run(r)}
              >
                <span className="flex-1 min-w-0 truncate">{r.label}</span>
                {r.tag && <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">{r.tag}</span>}
                {r.hint && (
                  <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400 tabular-nums whitespace-nowrap">
                    {r.hint}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---- «?» / Ctrl+/ — every key on one screen ---------------------------------
//
// Key names are written the Windows/Linux way; i18n's `t()` rewrites them to
// ⌘/⌥ on macOS, so this table is single-sourced. `keys()` runs the same
// rewrite over the literal names that never pass through the catalogue.

const K = (s: string) => (isMac() ? macKeys(s) : s);

function groups(): { name: string; rows: [string, string][] }[] {
  return [
    {
      name: t("keys.reading"),
      rows: [
        ["Space / PgDn", t("keys.screenFwd")],
        [K("Shift+Space / PgUp"), t("keys.screenBack")],
        ["↓ / ↑", t("keys.scroll")],
        ["Home / End", t("keys.ends")],
        [K("Alt+← / Alt+→"), t("keys.jumps")],
      ],
    },
    {
      name: t("keys.view"),
      rows: [
        [K("Ctrl + / − / ") + t("keys.wheel"), t("keys.zoom")],
        [K("Ctrl+0"), t("keys.fitWidth")],
        [K("Ctrl+1 / 2 / 3"), t("keys.columns")],
        ["D", t("keys.darkTheme")],
      ],
    },
    {
      name: t("keys.book"),
      rows: [
        [K("Ctrl+K"), t("keys.palette")],
        [K("Ctrl+F"), t("keys.find")],
        [K("Ctrl+O"), t("keys.openFile")],
        [K("Ctrl+,"), t("keys.settings")],
        ["Esc", t("keys.close")],
        [K("? / Ctrl+/"), t("keys.keys")],
      ],
    },
    {
      name: t("keys.translation"),
      rows: [
        ["T", t("keys.trToggle")],
        [K("Alt+") + t("keys.click"), t("keys.trPara")],
        ["O", t("keys.origSel")],
        ["Enter", t("keys.trSel")],
        [K("Ctrl+J"), t("keys.ask")],
        // composer-local, not a global binding — listed here because the panel
        // it belongs to is opened by Ctrl+J right above
        ["/", t("keys.askQuick")],
      ],
    },
  ];
}

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      data-shortcuts
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel rounded-xl bg-white dark:bg-neutral-800 shadow-2xl p-4 w-[min(36rem,92vw)] text-sm text-neutral-800 dark:text-neutral-100 select-none">
        <div className="flex items-center mb-3 text-xs text-neutral-500 dark:text-neutral-400">
          <span>{t("keys.title")}</span>
          <span className="flex-1" />
          <button
            className="px-0.5 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
            onClick={onClose}
            title={t("ui.close")}
          >
            <IconClose />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-10 gap-y-4">
          {groups().map((g) => (
            <div key={g.name}>
              <div className="mb-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">{g.name}</div>
              {g.rows.map(([keys, label]) => (
                <div key={keys} className="flex items-center justify-between gap-3 py-[3px]">
                  <span className="text-neutral-600 dark:text-neutral-300">{label}</span>
                  <span className="shrink-0 rounded-md bg-neutral-100 dark:bg-neutral-900/60 px-1.5 py-0.5 text-[11px] tabular-nums text-neutral-600 dark:text-neutral-400 whitespace-nowrap">
                    {keys}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
