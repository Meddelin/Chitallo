// Вкладка «Оглавление» правой панели (WP-N): одно поле ищет и по номеру
// страницы, и по заголовку; дерево стоит открытым, пока читаешь; текущий
// раздел помечен акцентной меткой слева. Раньше это было всплывающее окно над
// страницей — рамка, тень и позиционирование ушли вместе с ним, панель даёт
// собственную поверхность.
//
// Row click resolves the item's PDF destination and jumps; external outline
// URLs open in the system browser. Also home of resolveDest — the shared
// destination resolver every jump source funnels through (annotation links,
// outline rows, named actions).

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SearchIcon } from "lucide-react";
import { t } from "./i18n";

export type DestTarget = { page: number; frac: number };

// PDF destination (named string or explicit array) → 1-based page number +
// vertical position as a fraction of the page height FROM THE TOP. Explicit
// dests are [pageRef, {name}, ...args]; XYZ carries [x, y, zoom] and
// FitH/FitBH carry [y], with y in PDF user space counted from the BOTTOM of
// the page's viewBox. Some generators put a bare 0-based page index in place
// of the ref — pdf.js's own link service accepts that too.
export async function resolveDest(doc: PDFDocumentProxy, dest: unknown): Promise<DestTarget | null> {
  try {
    const arr = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const ref = arr[0] as { num: number; gen: number } | number;
    const page = 1 + (typeof ref === "number" ? ref : await doc.getPageIndex(ref));
    if (page < 1 || page > doc.numPages) return null;
    const kind = (arr[1] as { name?: string } | null)?.name;
    const y = kind === "XYZ" ? arr[3] : kind === "FitH" || kind === "FitBH" ? arr[2] : null;
    let frac = 0;
    if (typeof y === "number") {
      const vb = (await doc.getPage(page)).getViewport({ scale: 1 }).viewBox; // [x0, y0, x1, y1]
      if (vb[3] > vb[1]) frac = Math.min(1, Math.max(0, (vb[3] - y) / (vb[3] - vb[1])));
    }
    return { page, frac };
  } catch {
    return null; // malformed dest / damaged xref — the jump just doesn't happen
  }
}

type OutlineItem = {
  title: string;
  bold: boolean;
  dest: string | unknown[] | null;
  url: string | null;
  items: OutlineItem[];
};

// one flattened outline row; `page` fills in asynchronously (dest resolution
// runs in the background after the tree is already on screen), and `tr` with
// it — the translated heading is found by matching the row's title against the
// paragraphs stored for the page it resolves to, so it cannot be known before
// the destination is
type Row = {
  id: number;
  depth: number;
  title: string;
  bold: boolean;
  dest: unknown;
  url: string | null;
  page?: number;
  tr?: string;
};

const ROW =
  "relative flex w-full items-center gap-2.5 rounded-lg py-1.5 pl-3 pr-2.5 text-left text-[13px] leading-snug transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";

// подсветка совпадения: та же семантика, что у поиска по книге — фон акцента,
// без смены кегля, чтобы строка не дёргалась
function Highlight({ text, q }: { text: string; q: string }) {
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="rounded-sm bg-accent/25">{text.slice(at, at + q.length)}</span>
      {text.slice(at + q.length)}
    </>
  );
}

export default function Outline({
  doc,
  onJump,
  onClose,
  trTitle,
  page,
  active,
}: {
  doc: PDFDocumentProxy;
  onJump: (page: number, frac: number) => void;
  onClose: () => void;
  // translation mode only: the row's heading as the reflowed page prints it, or
  // null when the match isn't confident (App.tsx matchHeadingTr). Reading a
  // book in Russian and navigating it in English was the mismatch this closes.
  trTitle?: (page: number, title: string) => string | null;
  /** страница под читателем: акцентная метка на разделе + строка прогресса внизу */
  page?: number;
  /** вкладка на виду — тогда и только тогда поле забирает фокус */
  active?: boolean;
}) {
  const [rows, setRows] = useState<Row[] | null>(null); // null while getOutline runs
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // фокус приходит вместе с вкладкой, а не с монтированием: тело живёт в
  // панели всегда, и фокус на старте отняли бы у книги
  const prevActive = useRef(false);
  useEffect(() => {
    if (active && !prevActive.current) inputRef.current?.focus();
    prevActive.current = !!active;
  }, [active]);

  // flatten the outline once per doc, then resolve row page numbers in the
  // background (sequential worker round-trips, chunked state updates)
  useEffect(() => {
    let stale = false;
    (async () => {
      const outline = ((await doc.getOutline().catch(() => null)) ?? []) as OutlineItem[];
      const flat: Row[] = [];
      const walk = (items: OutlineItem[], depth: number) => {
        for (const it of items) {
          flat.push({
            id: flat.length,
            depth,
            title: it.title.replace(/\s+/g, " ").trim(),
            bold: !!it.bold,
            dest: it.dest,
            url: it.url,
          });
          if (it.items?.length && depth < 6) walk(it.items, depth + 1);
        }
      };
      walk(outline, 0);
      if (stale) return;
      setRows([...flat]);
      for (let i = 0; i < flat.length; i++) {
        if (flat[i].dest) {
          const t = await resolveDest(doc, flat[i].dest);
          if (stale) return;
          if (t) {
            flat[i].page = t.page;
            flat[i].tr = trTitle?.(t.page, flat[i].title) ?? undefined;
          }
        }
        if (i % 16 === 15) setRows([...flat]);
      }
      setRows([...flat]);
    })();
    return () => {
      stale = true;
    };
  }, [doc, trTitle]);

  const q = input.trim().toLowerCase();
  const numeric = /^\d+$/.test(q);
  // одно поле на два поиска: цифры отбирают по номеру страницы (и Enter прыгает
  // прямо туда), буквы — по заголовку, в том числе переведённому
  const shown = (rows ?? []).filter((r) =>
    !q
      ? true
      : numeric
        ? String(r.page ?? "").startsWith(q)
        : r.title.toLowerCase().includes(q) || (r.tr?.toLowerCase().includes(q) ?? false),
  );

  // текущий раздел: последняя строка, чья страница уже позади читателя.
  // Считается по ПОЛНОМУ дереву — отбор не должен переносить метку.
  let current = -1;
  if (page !== undefined && rows)
    for (const r of rows) if (r.page !== undefined && r.page <= page) current = r.id;

  const submit = () => {
    const n = parseInt(input, 10);
    if (!Number.isFinite(n) || n < 1) return;
    onJump(Math.min(doc.numPages, n), 0);
  };

  const activate = async (r: Row) => {
    if (r.url) {
      // external outline entry → system browser, never the webview
      const url = r.url;
      openUrl(url).catch(() => window.open(url, "_blank", "noopener"));
      return;
    }
    const t = await resolveDest(doc, r.dest);
    if (t) onJump(t.page, t.frac);
  };

  const pct = page !== undefined && doc.numPages > 0 ? Math.round((100 * page) / doc.numPages) : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-neutral-200 dark:border-neutral-700 px-4 py-3">
        <SearchIcon aria-hidden className="size-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" />
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (numeric) submit();
              else if (shown.length) void activate(shown[0]);
            } else if (e.key === "Escape") {
              e.stopPropagation(); // App's Esc chain must not also fire
              if (input) setInput("");
              else onClose();
            }
          }}
          placeholder={t("out.pagePlaceholder")}
          aria-label={t("out.pageLabel")}
          spellCheck={false}
          className="w-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-1.5">
        {rows !== null &&
          (shown.length === 0 ? (
            <div className="px-3 py-1.5 text-[13px] text-neutral-500 dark:text-neutral-400">
              {rows.length === 0 ? t("out.noToc") : t("ui.notFound")}
            </div>
          ) : (
            shown.map((r) => (
              // the row prints the translated heading when there is one; the
              // tooltip keeps the original underneath it, so a row is always
              // traceable back to the printed book
              <button
                key={r.id}
                className={`${ROW} ${
                  r.id === current
                    ? "font-medium text-neutral-900 dark:text-neutral-100"
                    : r.depth
                      ? "text-neutral-500 dark:text-neutral-400"
                      : "text-neutral-700 dark:text-neutral-300"
                }`}
                onClick={() => void activate(r)}
                title={r.tr ? `${r.tr}\n${r.title}` : r.title}
              >
                {r.id === current && (
                  <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-r-sm bg-accent" />
                )}
                <span
                  className={`min-w-0 flex-1 truncate ${r.bold && r.id !== current ? "font-medium" : ""}`}
                  style={r.depth ? { paddingLeft: Math.min(r.depth, 2) * 16 } : undefined}
                >
                  <Highlight q={numeric ? "" : q} text={r.tr ?? r.title} />
                </span>
                {r.page !== undefined && (
                  <span className="shrink-0 text-xs tabular-nums text-neutral-400 dark:text-neutral-500">{r.page}</span>
                )}
              </button>
            ))
          ))}
      </div>

      {page !== undefined && (
        <div className="shrink-0 border-t border-neutral-200 dark:border-neutral-700 px-4 py-2.5 text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500">
          {t("panel.pageOf", { page, total: doc.numPages, pct })}
        </div>
      )}
    </div>
  );
}
