// Ctrl+F find bar — a sibling pill under the toolbar. Search runs over cached
// getTextContent (orig mode; pages stream on demand starting at the current
// page and wrapping, so nearby hits appear first in long books) or over the
// translation store's tr strings (tr mode, jump via data-tridx). Highlighting
// uses the CSS Custom Highlight API: live Ranges over the rendered text
// layers / reflowed blocks, re-applied when virtualization renders or drops
// pages — no DOM mutation of pdf.js output at all.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { FIG_CONTAIN, interArea } from "./paragraphs";
import type { FigureRegion } from "./paragraphs";
import type { TrParagraph } from "./booktranslate";
import { Spinner } from "./ModelSetup";
import { IconClose } from "./icons";

// one hit. orig mode: start/end are offsets in the page's index text (item
// strs + "\n" per hasEOL — exactly what walkLayer reads back from the DOM,
// so the k-th regex match in the index IS the k-th in the rendered layer).
// tr mode: offsets in the stored paragraph's tr string; tridx → its block.
type Match = { page: number; start: number; end: number; tridx?: number };

const H_ALL = "pdfer-find";
const H_CUR = "pdfer-find-cur";

// pill controls: the app-wide hover grammar (WP-K) — quiet bg tint, no opacity dim
const BAR_BTN = "rounded-md px-1 transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";

const registry = () => ("highlights" in CSS ? CSS.highlights : null);

// literal query → case-insensitive regex; whitespace runs match any (possibly
// empty) gap so phrases cross line breaks: "\n" in the index text, a
// zero-character join between line spans in the DOM
function buildRegex(q: string): RegExp | null {
  const esc = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!esc) return null;
  return new RegExp(esc.replace(/\s+/g, "\\s*"), "giu");
}

// rendered text layer → its text in item order (text nodes concatenated, "\n"
// for every <br> EOL marker) + node offsets for building Ranges
function walkLayer(layer: Element): { text: string; segs: { node: Text; start: number }[] } {
  let text = "";
  const segs: { node: Text; start: number }[] = [];
  const w = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) =>
      n instanceof Element
        ? n.classList.contains("endOfContent")
          ? NodeFilter.FILTER_REJECT
          : n.tagName === "BR"
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n instanceof Element) text += "\n"; // <br> — EOL filler, no selectable node
    else {
      segs.push({ node: n as Text, start: text.length });
      text += (n as Text).data;
    }
  }
  return { text, segs };
}

// [a,b) in walked text → DOM Range; offsets landing on "\n" fillers (which
// have no text node) clamp inward to the neighbouring segments
function toRange(segs: { node: Text; start: number }[], a: number, b: number): Range | null {
  let sa: { node: Text; off: number } | null = null;
  let sb: { node: Text; off: number } | null = null;
  for (const s of segs) {
    const len = s.node.data.length;
    if (!sa && a < s.start + len) sa = { node: s.node, off: Math.max(0, a - s.start) };
    if (s.start < b) sb = { node: s.node, off: Math.min(len, b - s.start) };
  }
  if (!sa || !sb) return null;
  const r = new Range();
  r.setStart(sa.node, sa.off);
  r.setEnd(sb.node, sb.off);
  return r.collapsed ? null : r;
}

export default function FindBar({
  doc,
  viewMode,
  trVersion,
  getTrPage,
  getTrFigs,
  curPage,
  focusNonce,
  seed,
  leftShift,
  onClose,
}: {
  doc: PDFDocumentProxy;
  viewMode: "orig" | "tr";
  trVersion: number; // tr mode re-indexes as the store grows
  getTrPage: (n: number) => TrParagraph[] | undefined;
  getTrFigs: (n: number) => FigureRegion[];
  curPage: number;
  focusNonce: number; // Ctrl+F while open → refocus + select
  seed?: { q: string; n: number } | null; // palette's «Найти: …» query
  leftShift: number; // px — mirror the toolbar's centering over the reading area
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [cur, setCur] = useState<Match | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const genRef = useRef(0);
  const reRef = useRef<RegExp | null>(null);
  const pagesRef = useRef(new Map<number, Match[]>());
  const matchesRef = useRef<Match[]>([]);
  const curRef = useRef<Match | null>(null);
  const curPageRef = useRef(curPage);
  curPageRef.current = curPage;
  // jump issued before the target page rendered — apply() finishes the scroll
  const pendingRef = useRef<{ m: Match; until: number } | null>(null);
  const textCache = useRef<{ doc: PDFDocumentProxy; texts: Map<number, string> } | null>(null);
  const lastQueryRef = useRef("");
  const applyTimer = useRef<number>(undefined);

  // page index text, built lazily and cached per doc (a few MB for a big book)
  const getPageText = useCallback(
    async (n: number) => {
      if (textCache.current?.doc !== doc) textCache.current = { doc, texts: new Map() };
      const cache = textCache.current.texts;
      const hit = cache.get(n);
      if (hit !== undefined) return hit;
      let t = "";
      try {
        const content = await (await doc.getPage(n)).getTextContent();
        for (const it of content.items)
          if ("str" in it) {
            t += it.str;
            if (it.hasEOL) t += "\n";
          }
      } catch {
        // damaged page — searches as empty
      }
      cache.set(n, t);
      return t;
    },
    [doc],
  );

  // (Re)build both Highlight registrations from the currently rendered pages.
  // O(rendered pages with hits); called on match/cur changes and, debounced,
  // on every DOM change (virtualization, zoom re-renders, tr reflow).
  const apply = useCallback(() => {
    const reg = registry();
    if (!reg) return; // no Highlight API — search still counts and jumps
    const re = reRef.current;
    const all: Range[] = [];
    let curRange: Range | null = null;
    if (re) {
      for (const layer of document.querySelectorAll(".page > .textLayer, .page > .trPage")) {
        const pageEl = layer.closest("[data-page]") as HTMLElement | null;
        const pm = pagesRef.current.get(Number(pageEl?.dataset.page));
        if (!pm?.length) continue;
        if (layer.classList.contains("trPage")) {
          // hits live inside single-text-node <p> blocks, addressed by tridx
          for (const m of pm) {
            const block = layer.querySelector(`[data-tridx="${m.tridx}"]`);
            const tn = block?.tagName === "P" ? block.firstChild : null;
            if (!(tn instanceof Text)) continue; // crop canvas / re-typeset race
            const r = new Range();
            r.setStart(tn, Math.min(m.start, tn.data.length));
            r.setEnd(tn, Math.min(m.end, tn.data.length));
            if (r.collapsed) continue;
            all.push(r);
            if (m === curRef.current) curRange = r;
          }
        } else {
          // the k-th DOM match pairs with the k-th index match (same text)
          const { text, segs } = walkLayer(layer);
          const dom = [...text.matchAll(re)].filter((m) => m[0]);
          for (let k = 0; k < dom.length; k++) {
            const r = toRange(segs, dom[k].index, dom[k].index + dom[k][0].length);
            if (!r) continue;
            all.push(r);
            if (pm[k] && pm[k] === curRef.current) curRange = r;
          }
        }
      }
    }
    reg.set(H_ALL, new Highlight(...all));
    reg.set(H_CUR, curRange ? new Highlight(curRange) : new Highlight());
    // finish a jump whose page has just rendered; drop stale/expired ones
    const p = pendingRef.current;
    if (p && (p.m !== curRef.current || Date.now() > p.until)) pendingRef.current = null;
    else if (p && curRange) {
      pendingRef.current = null;
      const rect = curRange.getBoundingClientRect();
      if (rect.top < 64 || rect.bottom > window.innerHeight - 24)
        curRange.startContainer.parentElement?.scrollIntoView({ block: "center" });
    }
  }, []);

  const scheduleApply = useCallback(() => {
    clearTimeout(applyTimer.current);
    applyTimer.current = window.setTimeout(apply, 80);
  }, [apply]);

  // virtualization renders/drops page content without React state changes
  // here — watch the DOM instead (highlight registration itself is not a
  // DOM mutation, so this cannot loop)
  useEffect(() => {
    const mo = new MutationObserver(scheduleApply);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [scheduleApply]);

  useEffect(() => {
    apply();
  }, [matches, cur, apply]);

  // unmount: cancel the scan, drop highlights
  useEffect(
    () => () => {
      genRef.current++;
      clearTimeout(applyTimer.current);
      registry()?.delete(H_ALL);
      registry()?.delete(H_CUR);
    },
    [],
  );

  const jumpTo = useCallback(
    (m: Match) => {
      curRef.current = m;
      setCur(m);
      pendingRef.current = { m, until: Date.now() + 2500 };
      const pageEl = document.querySelector(`[data-page="${m.page}"]`);
      // unrendered page: bring its shell into view so the observer renders
      // it — apply() then refines the scroll to the exact match
      if (pageEl && !pageEl.querySelector(".textLayer, .trPage")) pageEl.scrollIntoView({ block: "start" });
      apply();
    },
    [apply],
  );

  // ---- the scan ----
  const trDep = viewMode === "tr" ? trVersion : -1;
  useEffect(() => {
    const gen = ++genRef.current;
    const re = buildRegex(query);
    reRef.current = re;
    pagesRef.current = new Map();
    matchesRef.current = [];
    curRef.current = null;
    pendingRef.current = null;
    setMatches([]);
    setCur(null);
    // auto-jump only when the QUERY changed (typing) — never on re-scans
    // driven by mode switches or translation progress (no scroll yanking)
    const autoJump = query !== lastQueryRef.current;
    lastQueryRef.current = query;
    if (!re) {
      setBusy(false);
      scheduleApply();
      return;
    }
    setBusy(true);
    (async () => {
      const total = doc.numPages;
      const anchor = Math.min(Math.max(1, curPageRef.current), total);
      let jumped = false;
      for (let i = 0; i < total; i++) {
        const n = ((anchor - 1 + i) % total) + 1; // current page first, wrap
        if (genRef.current !== gen) return;
        const pm: Match[] = [];
        if (viewMode === "tr") {
          // stored translation only; mirrors buildTrPage's skips so every
          // counted hit has (or will have) a visible block to land on
          const paras = getTrPage(n);
          if (paras?.length) {
            const figs = getTrFigs(n);
            paras.forEach((p, idx) => {
              if (!p.tr || p.kind === "caption") return;
              if (figs.some((r) => interArea(p, r) >= FIG_CONTAIN * p.w * p.h)) return;
              for (const m of p.tr.matchAll(re))
                if (m[0]) pm.push({ page: n, tridx: idx, start: m.index, end: m.index + m[0].length });
            });
          }
          if (i % 40 === 39) await new Promise((r) => setTimeout(r)); // keep the UI live
        } else {
          const t = await getPageText(n);
          if (genRef.current !== gen) return;
          for (const m of t.matchAll(re)) if (m[0]) pm.push({ page: n, start: m.index, end: m.index + m[0].length });
        }
        if (pm.length) {
          pagesRef.current.set(n, pm);
          const flat = [...pagesRef.current.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, v]) => v);
          matchesRef.current = flat;
          setMatches(flat);
          if (!curRef.current) {
            // scan starts at the current page — the first hit is the target
            curRef.current = pm[0];
            setCur(pm[0]);
            if (autoJump && !jumped) {
              jumped = true;
              jumpTo(pm[0]);
            } else scheduleApply();
          } else scheduleApply();
        }
      }
      if (genRef.current === gen) setBusy(false);
    })();
  }, [query, doc, viewMode, trDep, getPageText, getTrPage, getTrFigs, jumpTo, scheduleApply]);

  const step = useCallback(
    (dir: 1 | -1) => {
      const list = matchesRef.current;
      if (!list.length) return;
      const idx = curRef.current ? list.indexOf(curRef.current) : -1;
      const next = idx < 0 ? (dir === 1 ? 0 : list.length - 1) : (idx + dir + list.length) % list.length;
      jumpTo(list[next]);
    },
    [jumpTo],
  );

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  // palette's «Найти: …» — seed the query (App nulls the seed on plain Ctrl+F,
  // so an old palette query never resurfaces on a later open)
  useEffect(() => {
    if (seed) setQuery(seed.q);
  }, [seed]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.stopPropagation(); // App's Esc chain must not also fire
      onClose();
    }
  };

  const idx = cur ? matches.indexOf(cur) : -1;
  const hasQuery = !!query.trim();

  return (
    <div
      data-findbar
      className="overlay-pop fixed top-[52px] -translate-x-1/2 z-10 flex items-center gap-1 rounded-full bg-white/85 dark:bg-neutral-800/85 backdrop-blur px-3 py-1.5 shadow-lg text-sm text-neutral-700 dark:text-neutral-200 select-none transition-[left] duration-150"
      style={{ left: leftShift ? `calc(50% - ${leftShift}px)` : "50%" }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Найти в книге"
        spellCheck={false}
        className="w-52 bg-transparent outline-none px-1 placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
      />
      {hasQuery && (
        <span className="tabular-nums whitespace-nowrap px-1 text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5">
          {matches.length ? `${(idx < 0 ? 0 : idx) + 1}/${matches.length}` : busy ? null : "Не найдено"}
          {busy && <Spinner />}
        </span>
      )}
      <span className="mx-1 h-4 w-px bg-neutral-900/15 dark:bg-neutral-100/20" />
      {/* mousedown-preventDefault keeps focus (and Enter cycling) in the input */}
      <button
        className={`${BAR_BTN} disabled:text-neutral-300 dark:disabled:text-neutral-600 disabled:hover:bg-transparent dark:disabled:hover:bg-transparent disabled:cursor-default`}
        disabled={!matches.length}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(-1)}
        title="Предыдущее совпадение (Shift+Enter)"
      >
        ↑
      </button>
      <button
        className={`${BAR_BTN} disabled:text-neutral-300 dark:disabled:text-neutral-600 disabled:hover:bg-transparent dark:disabled:hover:bg-transparent disabled:cursor-default`}
        disabled={!matches.length}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(1)}
        title="Следующее совпадение (Enter)"
      >
        ↓
      </button>
      <span className="mx-1 h-4 w-px bg-neutral-900/15 dark:bg-neutral-100/20" />
      <button className={`${BAR_BTN} py-0.5`} onClick={onClose} title="Закрыть (Esc)">
        <IconClose />
      </button>
    </div>
  );
}
