// Page-navigation flyout under the toolbar's page indicator: a go-to-page
// input + the book's outline (doc.getOutline) as an indented tree. Row click
// resolves the item's PDF destination and jumps; external outline URLs open
// in the system browser. Also home of resolveDest — the shared destination
// resolver every jump source funnels through (annotation links, outline rows,
// named actions).

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { openUrl } from "@tauri-apps/plugin-opener";

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
// runs in the background after the tree is already on screen)
type Row = {
  id: number;
  depth: number;
  title: string;
  bold: boolean;
  dest: unknown;
  url: string | null;
  page?: number;
};

const ROW =
  "w-full text-left px-2.5 py-1 rounded-lg transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700/70 flex items-center gap-2";

export default function Outline({
  doc,
  onJump,
  onClose,
}: {
  doc: PDFDocumentProxy;
  onJump: (page: number, frac: number) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null); // null while getOutline runs
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
          if (t) flat[i].page = t.page;
        }
        if (i % 16 === 15) setRows([...flat]);
      }
      setRows([...flat]);
    })();
    return () => {
      stale = true;
    };
  }, [doc]);

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
      onClose();
      return;
    }
    const t = await resolveDest(doc, r.dest);
    if (t) onJump(t.page, t.frac);
  };

  return (
    <div className="overlay-pop absolute left-0 top-full mt-2.5 z-20 w-80 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur shadow-xl p-1.5 text-left">
      <input
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value.replace(/\D/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.stopPropagation(); // App's Esc chain must not also fire
            onClose();
          }
        }}
        inputMode="numeric"
        placeholder={`Страница 1–${doc.numPages}`}
        aria-label="Номер страницы"
        spellCheck={false}
        className="w-full bg-transparent outline-none px-2.5 py-1 tabular-nums placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
      />
      {rows !== null && (
        <div className="mt-1 border-t border-neutral-200 dark:border-neutral-700 pt-1 max-h-[55vh] overflow-y-auto overscroll-contain">
          {rows.length === 0 ? (
            <div className="px-2.5 py-1.5 text-neutral-500 dark:text-neutral-400 cursor-default">В книге нет оглавления</div>
          ) : (
            rows.map((r) => (
              <button key={r.id} className={ROW} onClick={() => activate(r)} title={r.title}>
                <span
                  className={`flex-1 min-w-0 truncate ${r.bold ? "font-medium" : ""} ${
                    r.depth ? "text-neutral-600 dark:text-neutral-300" : ""
                  }`}
                  style={r.depth ? { paddingLeft: r.depth * 14 } : undefined}
                >
                  {r.title}
                </span>
                {r.page !== undefined && (
                  <span className="shrink-0 tabular-nums text-xs text-neutral-500 dark:text-neutral-400">{r.page}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
