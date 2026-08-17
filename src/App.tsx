import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import Library from "./Library";
import { GlossaryModal, SelectionBar, TranslatePopover } from "./TranslatePopover";
import type { Anchor } from "./TranslatePopover";
import { buildFrags, growParagraph, medianLineH, paraText } from "./paragraphs";
import type { Word } from "./paragraphs";
import * as booktranslate from "./booktranslate";
import type { TrParagraph } from "./booktranslate";
import * as glossarygen from "./glossarygen";
import { isServerUp } from "./translate";
import "./App.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const DEFAULT_SCALE = 1.25;
const PAGE_GAP = 16;

// full-width action row of the «Перевод» dropdown menu
const MENU_ROW =
  "w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-700/70 whitespace-nowrap";

type Size = { w: number; h: number };
type Cols = 1 | 2 | "auto";
type ViewMode = "orig" | "tr";
type TrRequest = { anchor: Anchor; text: string; context?: string; label?: string; noTranslate?: boolean };

// ---- selection → translation helpers ---------------------------------------

// selection strings carry the text layer's EOL newlines; join wrapped lines and
// drop end-of-line hyphenation
function normalizeSelText(raw: string): string {
  return raw.replace(/[-­]\s*\n\s*/g, "").replace(/\s+/g, " ").trim();
}

// « · ~40 мин» from the engine's etaMs (moving average over recent pages)
function fmtEta(ms?: number): string {
  if (ms === undefined) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return " · <1 мин";
  if (min < 60) return ` · ~${min} мин`;
  const h = ms / 3600000;
  return ` · ~${h < 10 ? h.toFixed(1) : Math.round(h)} ч`;
}

// for 1-2 word selections: pull the containing sentence out of the surrounding
// text (text-layer spans, or the whole paragraph block for reflowed-translation
// selections), so the model can disambiguate the word
function sentenceAround(range: Range, selText: string): string | undefined {
  const n = range.startContainer;
  const el = n instanceof Element ? n : n.parentElement;
  let txt = "";
  const trPara = el?.closest(".trPage [data-tridx]");
  if (trPara) {
    txt = (trPara.textContent ?? "").replace(/\s+/g, " ").trim();
  } else {
    const span = el?.closest(".textLayer span") as HTMLElement | null;
    const layer = span?.closest(".textLayer");
    if (!span || !layer) return undefined;
    const all = Array.from(layer.querySelectorAll<HTMLElement>("span")).filter(
      (s) => s === span || ((s.textContent ?? "").trim() && !s.querySelector("span")),
    );
    const i = all.indexOf(span);
    if (i < 0) return undefined;
    txt = all
      .slice(Math.max(0, i - 5), i + 6)
      .map((s) => s.textContent ?? "")
      .join(" ")
      .replace(/([A-Za-zА-Яа-яЁё])[-­]\s+([a-zа-яё])/g, "$1$2") // line-wrap hyphens
      .replace(/\s+/g, " ")
      .trim();
  }
  const pos = txt.toLowerCase().indexOf(selText.toLowerCase());
  if (pos < 0) return undefined;
  let start = 0;
  const stops = /[.!?…][")\]]?(?=\s)/g;
  for (let m = stops.exec(txt); m && m.index + m[0].length <= pos; m = stops.exec(txt))
    start = m.index + m[0].length;
  const tail = /[.!?…][")\]]?/g;
  tail.lastIndex = pos + selText.length;
  const m2 = tail.exec(txt);
  const end = m2 ? m2.index + m2[0].length : txt.length;
  const sent = txt.slice(start, Math.min(end, start + 600)).trim();
  return sent.split(" ").length > selText.split(" ").length ? sent : undefined;
}

// Alt+click paragraph detection, DOM entry point: the clicked span's text
// layer supplies span client rects, the clustering math itself lives in
// paragraphs.ts (shared with the whole-book translation engine)
function paragraphAround(clicked: HTMLElement): { text: string; left: number; bottom: number } | null {
  const layer = clicked.closest(".textLayer");
  if (!layer) return null;
  const words: Word[] = Array.from(layer.querySelectorAll<HTMLElement>("span"))
    .filter((s) => (s.textContent ?? "").trim() && s.getAttribute("role") !== "img" && !s.querySelector("span"))
    .map((s) => {
      const r = s.getBoundingClientRect();
      return { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, text: s.textContent ?? "", key: s };
    });

  const frags = buildFrags(words);
  const home = frags.find((f) => f.words.some((w) => w.key === clicked));
  if (!home) return null;
  const lineH = medianLineH(frags);
  const para = growParagraph(frags, home, lineH);
  return {
    text: paraText(para, lineH),
    left: Math.min(...para.map((f) => f.left)),
    bottom: Math.max(...para.map((f) => f.bottom)),
  };
}

// ---- reflowed translated page (v2) -----------------------------------------

// list-item openers for hanging indents: "(1) ", "1. ", "1) ", "• ", "a) ", "а) ", "— "
const LIST_RE = /^\s*(?:\(\d{1,3}\)|\d{1,3}[.)]|\(?[a-zа-яё]\)|[•◦▪‣–—])\s/i;

const CROP_PAD = 3; // scale-1 px of original context kept around a cropped region
const PAGE_PAD_X = 0.085; // trPage horizontal padding as a fraction of page width — mirrors App.css

type Crop = { canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number }; // scale-1 rect

// Clean re-typeset page replacing the original render in translation mode.
// Prose paragraphs flow as <p> at ONE uniform body size for the whole book
// (15.5px × scale, via --scale-factor in App.css); headings are recognised by
// the stored glyph height relative to the book's body median (fh/bodyFh ≥ 1.25,
// size capped at 1.8×), list items get a hanging indent. kind:"other" regions
// (display math / figures / tables) and failed paragraphs (tr:"") are never
// dropped: they become placeholder canvases, later filled by drawCrops with
// image crops of the original page render. data-tridx on every block links back
// to the store paragraph (Alt+click «Оригинал», sentence context).
function buildTrPage(paras: TrParagraph[], bodyFh: number, scale: number, baseW: number, baseH: number) {
  const root = document.createElement("div");
  root.className = "trPage";
  root.lang = "ru"; // enables hyphens:auto for the justified Russian text
  const crops: Crop[] = [];
  const maxW = baseW * scale * (1 - 2 * PAGE_PAD_X); // text column width — crop display cap
  paras.forEach((p, i) => {
    if (p.kind === "prose" && p.tr) {
      const d = document.createElement("p");
      const ratio = bodyFh > 0 && p.fh > 0 ? p.fh / bodyFh : 1;
      if (ratio >= 1.25) {
        d.className = "trHead";
        d.style.fontSize = `${Math.min(1.8, ratio).toFixed(3)}em`;
      } else {
        d.className = LIST_RE.test(p.tr) || LIST_RE.test(p.text) ? "trHang" : "trP";
      }
      d.textContent = p.tr;
      d.dataset.tridx = String(i);
      root.append(d);
    } else {
      const x = Math.max(0, p.x - CROP_PAD);
      const y = Math.max(0, p.y - CROP_PAD);
      const w = Math.min(baseW, p.x + p.w + CROP_PAD) - x;
      const h = Math.min(baseH, p.y + p.h + CROP_PAD) - y;
      if (w <= 0 || h <= 0) return;
      const c = document.createElement("canvas");
      c.className = "trCrop";
      c.width = 0; // transparent until drawCrops fills it
      c.height = 0;
      // natural display size at the current zoom, fixed up front so the flow
      // never jumps when the async original render lands
      let cssW = w * scale;
      let cssH = h * scale;
      if (cssW > maxW) {
        cssH *= maxW / cssW;
        cssW = maxW;
      }
      c.style.width = `${cssW}px`;
      c.style.height = `${cssH}px`;
      c.dataset.tridx = String(i);
      root.append(c);
      crops.push({ canvas: c, x, y, w, h });
    }
  });
  return { root, crops };
}

// copy each crop's region out of the full-page offscreen render (scale × dpr);
// the offscreen canvas is discarded by the caller right after
function drawCrops(off: HTMLCanvasElement, crops: Crop[], scale: number, dpr: number) {
  const k = scale * dpr;
  for (const cr of crops) {
    const sx = Math.min(off.width, Math.round(cr.x * k));
    const sy = Math.min(off.height, Math.round(cr.y * k));
    const sw = Math.min(off.width - sx, Math.round(cr.w * k));
    const sh = Math.min(off.height - sy, Math.round(cr.h * k));
    if (sw <= 0 || sh <= 0) continue;
    cr.canvas.width = sw;
    cr.canvas.height = sh;
    cr.canvas.getContext("2d")!.drawImage(off, sx, sy, sw, sh, 0, 0, sw, sh);
  }
}

function Page({
  doc,
  num,
  scale,
  baseSize,
  viewMode,
  trVersion,
  getTrPage,
  getBodyFh,
}: {
  doc: PDFDocumentProxy;
  num: number;
  scale: number;
  baseSize: Size;
  viewMode: ViewMode;
  trVersion: number;
  getTrPage: (n: number) => TrParagraph[] | undefined;
  getBodyFh: () => number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Placeholder: page-1 size until this page renders once, then its own base
  // (scale-1) size forever. Kept across effect re-runs on purpose — resetting it
  // in cleanup made every visible page snap back to the page-1-sized placeholder
  // on each translation progress event (trVersion re-run) in non-uniform books:
  // row heights jumped, the whole layout below shifted, scroll content leapt.
  // Scale-independent storage also sizes zoom placeholders exactly. The doc
  // guard keeps a newly opened book from inheriting the previous book's sizes.
  const [rendered, setRendered] = useState<{ doc: PDFDocumentProxy; base: Size } | null>(null);
  const base = rendered && rendered.doc === doc ? rendered.base : baseSize;
  const size = { w: base.w * scale, h: base.h * scale };

  // trVersion joins the effect deps ONLY in translation mode: while the engine
  // runs, every finished page bumps it and re-runs the effect (a full page
  // re-render — accepted cost during active translation) so visible pages gain
  // their reflowed translation live, without a manual toggle. In orig mode the
  // dep is pinned to -1, so translation progress never re-renders pages.
  const trDep = viewMode === "tr" ? trVersion : -1;
  // reflow pages own their height: natural flow height, but never shorter than
  // the original render (min-height), so virtualization placeholders keep size
  const reflow = viewMode === "tr" && !!getTrPage(num)?.length;

  useEffect(() => {
    const el = ref.current!;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    let page: PDFPageProxy | null = null;
    let cancelled = false;
    let runId = 0;

    const io = new IntersectionObserver(
      async (entries) => {
        // batches can deliver [leave, enter] for one element — act on the latest state
        const entry = entries[entries.length - 1];
        if (entry.isIntersecting) {
          if (el.dataset.rendered) return;
          const run = String(++runId);
          el.dataset.rendered = run;
          page = await doc.getPage(num);
          // page may have left (or left and re-entered) the band during the await
          if (cancelled || el.dataset.rendered !== run) return;
          const vp = page.getViewport({ scale });
          const vp1 = page.getViewport({ scale: 1 });
          // referential bail-out: same doc + same base size → no extra re-render
          setRendered((prev) =>
            prev && prev.doc === doc && prev.base.w === vp1.width && prev.base.h === vp1.height
              ? prev
              : { doc, base: { w: vp1.width, h: vp1.height } },
          );

          const dpr = window.devicePixelRatio || 1;
          const paras = viewMode === "tr" ? getTrPage(num) : undefined;
          if (paras?.length) {
            // reflowed translated page: NO canvas and NO text layer — the
            // original is rasterized only offscreen (once, if any non-prose
            // region needs an image crop) and discarded after cropping
            const { root, crops } = buildTrPage(paras, getBodyFh(), scale, vp1.width, vp1.height);
            el.appendChild(root);
            if (crops.length) {
              const off = document.createElement("canvas");
              off.width = Math.floor(vp.width * dpr);
              off.height = Math.floor(vp.height * dpr);
              renderTask = page.render({ canvas: off, viewport: page.getViewport({ scale: scale * dpr }) });
              await renderTask.promise.catch(() => {});
              if (!cancelled && el.dataset.rendered === run) drawCrops(off, crops, scale, dpr);
            }
            return;
          }

          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(vp.width * dpr);
          canvas.height = Math.floor(vp.height * dpr);
          el.appendChild(canvas);
          renderTask = page.render({ canvas, viewport: page.getViewport({ scale: scale * dpr }) });

          const textDiv = document.createElement("div");
          textDiv.className = "textLayer";
          el.appendChild(textDiv);
          textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport: vp });

          await Promise.all([renderTask.promise, textLayer.render()]).catch(() => {});
          // official viewer's selection stabilizer (see TextLayerBuilder): an
          // unselectable div that .selecting expands over the layer so drags
          // through empty areas don't snap the caret to DOM-distant nodes
          if (!cancelled && el.dataset.rendered === run) {
            const end = document.createElement("div");
            end.className = "endOfContent";
            textDiv.append(end);
          }
        } else if (el.dataset.rendered) {
          // page scrolled far away — free canvas, text layer and pdf.js page resources
          delete el.dataset.rendered;
          renderTask?.cancel();
          textLayer?.cancel();
          page?.cleanup();
          el.replaceChildren();
        }
      },
      { rootMargin: "1500px 0px" },
    );
    io.observe(el);

    return () => {
      cancelled = true;
      io.disconnect();
      renderTask?.cancel();
      textLayer?.cancel();
      delete el.dataset.rendered;
      el.replaceChildren();
      // NOTE: `rendered` (the page's true base size) is deliberately NOT reset —
      // see the placeholder comment above.
    };
  }, [doc, num, scale, viewMode, trDep, getTrPage, getBodyFh]);

  return (
    <div
      ref={ref}
      data-page={num}
      className="page"
      style={
        {
          width: size.w,
          minHeight: size.h,
          height: reflow ? undefined : size.h,
          "--scale-factor": scale,
        } as React.CSSProperties
      }
    />
  );
}

export default function App() {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [baseSize, setBaseSize] = useState<Size | null>(null);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [curPage, setCurPage] = useState(1);
  const [dark, setDark] = useState(() => localStorage.getItem("pdfer:dark") === "1");
  const [cols, setCols] = useState<Cols>(() => {
    const c = localStorage.getItem("pdfer:cols");
    return c === "2" ? 2 : c === "auto" ? "auto" : 1;
  });
  const [viewportW, setViewportW] = useState(() => window.innerWidth);
  const [selBar, setSelBar] = useState<TrRequest | null>(null);
  const [pop, setPop] = useState<TrRequest | null>(null);
  const [glossOpen, setGlossOpen] = useState(false);
  // ---- «Перевод» dropdown menu ----
  const [menuOpen, setMenuOpen] = useState(false);
  // inline confirm for «Перезапустить перевод»; reset whenever the menu closes
  const [confirmRestart, setConfirmRestart] = useState(false);
  // llama-server state for the menu's status row: Tauri translation_status
  // ("none"|"external"|"starting"|"spawned"|"dead"), plain-browser dev falls
  // back to an HTTP /health probe; null until the first fetch resolves
  const [modelStatus, setModelStatus] = useState<string | null>(null);
  // ---- whole-book translation state ----
  const [viewMode, setViewMode] = useState<ViewMode>("orig");
  // store meta for the toolbar: null = no stored translation for this book
  const [trInfo, setTrInfo] = useState<{ done: number; total: number } | null>(null);
  const [trRun, setTrRun] = useState(false);
  const [trEta, setTrEta] = useState<number | undefined>(undefined);
  // bumped whenever trStoreRef content changes — tr-mode Pages re-read overlays
  const [trVersion, setTrVersion] = useState(0);
  const trStoreRef = useRef<booktranslate.BookTranslation | null>(null);
  const trRunRef = useRef<AbortController | null>(null);
  const trPromiseRef = useRef<Promise<unknown> | null>(null);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const trAvailRef = useRef(false);
  trAvailRef.current = trInfo !== null;
  const selBarRef = useRef(selBar);
  selBarRef.current = selBar;
  const popRef = useRef(pop);
  popRef.current = pop;
  const glossRef = useRef(glossOpen);
  glossRef.current = glossOpen;
  const menuRef = useRef(menuOpen);
  menuRef.current = menuOpen;
  const scrollRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const pathRef = useRef(path);
  pathRef.current = path;
  const saveTimer = useRef<number>(undefined);

  // free the previous document (its dedicated worker + parsed data) when replaced
  useEffect(() => () => { doc?.loadingTask.destroy().catch(() => {}); }, [doc]);

  // dev-only console handle for the batch translation engine (no UI this phase):
  //   __pdferDev.startBookTranslation(__pdferDev.doc, __pdferDev.path, { pageLimit: 3 })
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__pdferDev = { doc, path, ...booktranslate, ...glossarygen };
  }, [doc, path]);

  // while a mouse selection is in progress, mark all text layers .selecting so
  // their .endOfContent covers gaps (mirrors TextLayerBuilder's global listener)
  useEffect(() => {
    const start = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.(".textLayer"))
        document.querySelectorAll(".textLayer").forEach((t) => t.classList.add("selecting"));
    };
    const stop = () =>
      document.querySelectorAll(".textLayer.selecting").forEach((t) => t.classList.remove("selecting"));
    document.addEventListener("mousedown", start);
    document.addEventListener("pointerup", stop);
    window.addEventListener("blur", stop);
    return () => {
      document.removeEventListener("mousedown", start);
      document.removeEventListener("pointerup", stop);
      window.removeEventListener("blur", stop);
    };
  }, []);

  // selection mini-toolbar: after a pointerup that leaves a non-empty selection
  // inside a text layer, show «Перевести» near the selection end
  useEffect(() => {
    const evaluate = () => {
      const s = document.getSelection();
      if (!s || s.isCollapsed || s.rangeCount === 0) return setSelBar(null);
      const toEl = (n: Node | null) => (n instanceof Element ? n : n?.parentElement ?? null);
      if (
        !toEl(s.focusNode)?.closest(".textLayer, .trPage") &&
        !toEl(s.anchorNode)?.closest(".textLayer, .trPage")
      )
        return setSelBar(null);
      const text = normalizeSelText(s.toString());
      if (!text) return setSelBar(null);
      const range = s.getRangeAt(0);
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      const context = text.split(" ").length <= 2 ? sentenceAround(range, text) : undefined;
      setSelBar({ anchor: { x: last.right + 4, y: last.bottom + 6 }, text, context });
    };
    const onUp = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-selbar],[data-popover]")) return;
      setTimeout(evaluate, 0); // let the browser settle the selection first
    };
    const onSelChange = () => {
      const s = document.getSelection();
      if (!s || s.isCollapsed) setSelBar(null);
    };
    document.addEventListener("pointerup", onUp);
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("selectionchange", onSelChange);
    };
  }, []);

  // stable store getters for Page renders (read the ref, never re-created)
  const getTrPage = useCallback((n: number) => trStoreRef.current?.pages[n], []);
  const getBodyFh = useCallback(() => trStoreRef.current?.bodyFh ?? 0, []);

  // «Перевод» menu: click outside closes (capture, same pattern as the
  // popover); closing always disarms the restart confirm
  useEffect(() => {
    if (!menuOpen) {
      setConfirmRestart(false);
      return;
    }
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-trmenu]")) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [menuOpen]);

  // menu status row: poll translation_status while the menu is open (3s — the
  // "starting" state resolves on its own). Outside Tauri the invoke throws;
  // an HTTP health probe of the same server stands in.
  useEffect(() => {
    if (!menuOpen) return;
    let cancelled = false;
    const poll = async () => {
      let s: string;
      try {
        s = await invoke<string>("translation_status");
      } catch {
        s = (await isServerUp()) ? "external" : "none";
      }
      if (!cancelled) setModelStatus(s);
    };
    poll();
    const t = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [menuOpen]);

  // Alt+click on text → translate the whole visual paragraph; on a reflowed
  // translated block the translation is already on screen, so show the stored
  // ORIGINAL paragraph instead (matched by store index via data-tridx)
  const onAltClick = useCallback(
    (e: React.MouseEvent) => {
      if (!e.altKey) return;
      const target = e.target as HTMLElement;
      const block = target.closest?.(".trPage [data-tridx]") as HTMLElement | null;
      if (block) {
        const pageEl = block.closest("[data-page]") as HTMLElement | null;
        const orig = getTrPage(Number(pageEl?.dataset.page))?.[Number(block.dataset.tridx)]?.text;
        if (!orig) return;
        e.preventDefault();
        const r = block.getBoundingClientRect();
        setSelBar(null);
        setPop({ anchor: { x: r.left, y: r.bottom + 6 }, text: orig, label: "Оригинал", noTranslate: true });
        return;
      }
      const span = target.closest?.(".textLayer span") as HTMLElement | null;
      if (!span) return;
      e.preventDefault();
      const para = paragraphAround(span);
      if (!para?.text) return;
      setSelBar(null);
      setPop({ anchor: { x: para.left, y: para.bottom + 6 }, text: para.text });
    },
    [getTrPage],
  );

  // per-book view mode, persisted; default = original
  const setView = useCallback((m: ViewMode) => {
    setViewMode(m);
    if (pathRef.current) localStorage.setItem(`pdfer:view:${pathRef.current}`, m);
  }, []);

  const toggleView = useCallback(() => {
    if (!trAvailRef.current) return; // no stored translation — T is a no-op
    setView(viewModeRef.current === "tr" ? "orig" : "tr");
  }, [setView]);

  // one-button whole-book translation. Pause = abort: progress is persisted per
  // page by the engine, so pressing the button again later resumes for free
  // (donePages are skipped). Runs with concurrency 3 of the server's 4 slots —
  // selection translate stays responsive on the free slot.
  const startTr = useCallback(() => {
    if (!doc || !path || trRunRef.current) return;
    const ctrl = new AbortController();
    trRunRef.current = ctrl;
    setTrRun(true);
    trPromiseRef.current = booktranslate
      .startBookTranslation(doc, path, {
        signal: ctrl.signal,
        onProgress: (p) => {
          if (trRunRef.current !== ctrl) return;
          setTrInfo({ done: p.donePages, total: p.total });
          setTrEta(p.etaMs);
          // refresh page data from the just-written store (a page completes
          // every ~10-30s; the reload is cheap next to that)
          booktranslate.loadBookTranslation(path).then((st) => {
            if (st && pathRef.current === path) {
              trStoreRef.current = st;
              setTrVersion((v) => v + 1);
            }
          });
        },
      })
      .then((st) => {
        // resolves on natural completion AND on abort (partial store)
        if (pathRef.current === path) {
          trStoreRef.current = st;
          setTrInfo({ done: st.donePages.length, total: st.total });
          setTrVersion((v) => v + 1);
        }
      })
      .catch((e) => console.error("book translation failed", e))
      .finally(() => {
        if (trRunRef.current === ctrl) {
          trRunRef.current = null;
          setTrRun(false);
          setTrEta(undefined);
        }
      });
  }, [doc, path]);

  // «Перевести заново» (glossary modal): drop the store, restart from page 1
  const retranslate = useCallback(async () => {
    if (!path) return;
    setGlossOpen(false);
    trRunRef.current?.abort();
    await trPromiseRef.current; // let a running pipeline settle before deleting
    await booktranslate.deleteBookTranslation(path).catch(() => {});
    if (pathRef.current !== path) return;
    trStoreRef.current = null;
    setTrInfo(null);
    setTrEta(undefined);
    setView("orig");
    setTrVersion((v) => v + 1);
    startTr();
  }, [path, setView, startTr]);

  const savePos = useCallback(() => {
    const el = scrollRef.current;
    if (el && pathRef.current) {
      localStorage.setItem(
        `pdfer:pos:${pathRef.current}`,
        JSON.stringify({
          scrollTop: el.scrollTop,
          scale: scaleRef.current,
          progress: Math.min(1, el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)),
        }),
      );
    }
  }, []);

  // flush position on close (debounced scroll save alone loses the last ~300ms)
  useEffect(() => {
    let un: Promise<() => void> | null = null;
    try {
      un = getCurrentWindow().onCloseRequested(() => savePos());
    } catch {
      // plain browser (vite dev) — no Tauri
    }
    window.addEventListener("pagehide", savePos);
    return () => {
      un?.then((f) => f());
      window.removeEventListener("pagehide", savePos);
    };
  }, [savePos]);

  const loadBytes = useCallback(async (bytes: Uint8Array, key: string, title: string) => {
    const d = await pdfjs.getDocument({
      data: bytes,
      cMapUrl: "/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/standard_fonts/",
      wasmUrl: "/wasm/",
      iccUrl: "/iccs/",
    }).promise;
    const p1 = await d.getPage(1);
    const vp = p1.getViewport({ scale: 1 });

    const saved = localStorage.getItem(`pdfer:pos:${key}`);
    const pos = saved ? (JSON.parse(saved) as { scrollTop: number; scale: number }) : null;

    // switching books: stop any running translation, load the new book's store
    trRunRef.current?.abort();
    trStoreRef.current = null;
    setTrInfo(null);
    setTrEta(undefined);
    setViewMode(localStorage.getItem(`pdfer:view:${key}`) === "tr" ? "tr" : "orig");
    pathRef.current = key; // ahead of render, for the async loads' staleness guards
    booktranslate.loadBookTranslation(key).then((st) => {
      if (st && pathRef.current === key) {
        trStoreRef.current = st;
        setTrInfo({ done: st.donePages.length, total: st.total });
        setTrVersion((v) => v + 1);
      }
    });

    setBaseSize({ w: vp.width, h: vp.height });
    setScale(pos?.scale ?? DEFAULT_SCALE);
    setDoc(d);
    setPath(key);
    setCurPage(1);
    try {
      getCurrentWindow().setTitle(title).catch(() => {});
    } catch {
      document.title = title;
    }

    if (pos) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = pos.scrollTop;
        }),
      );
    }
  }, []);

  const loadFile = useCallback(async (p: string) => {
    const bytes = await readFile(p);
    await loadBytes(bytes, p, p.split(/[\\/]/).pop() ?? "pdfer");
    localStorage.setItem("pdfer:last", p);
  }, [loadBytes]);

  const openDialog = useCallback(async () => {
    const p = await open({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (typeof p === "string") loadFile(p).catch((e) => console.error("open failed", e));
  }, [loadFile]);

  // reopen last book on start; ?test=<url> loads a PDF over HTTP (browser-based UI debugging)
  useEffect(() => {
    const test = import.meta.env.DEV ? new URLSearchParams(location.search).get("test") : null;
    if (test) {
      fetch(test)
        .then(async (r) => loadBytes(new Uint8Array(await r.arrayBuffer()), test, test))
        .catch((e) => console.error("test load failed", e));
      return;
    }
    const last = localStorage.getItem("pdfer:last");
    if (last) loadFile(last).catch(() => localStorage.removeItem("pdfer:last"));
  }, [loadFile, loadBytes]);

  const zoomTo = useCallback(
    (next: number) => {
      const clamped = Math.min(4, Math.max(0.5, next));
      const prev = scaleRef.current;
      if (clamped === prev) return;
      const el = scrollRef.current;
      // anchor by the page row at the viewport top: in "auto" mode the column
      // count can change with scale, so a linear scrollTop rescale drifts
      let anchor: HTMLElement | null = null;
      const top = el?.scrollTop ?? 0;
      if (el) {
        for (const c of el.querySelectorAll<HTMLElement>("[data-page]"))
          if (c.offsetTop <= top && (!anchor || c.offsetTop > anchor.offsetTop)) anchor = c;
      }
      const frac = anchor ? (top - anchor.offsetTop) / Math.max(1, anchor.offsetHeight) : 0;
      setScale(clamped);
      if (el) {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            el.scrollTop = anchor
              ? anchor.offsetTop + frac * anchor.offsetHeight
              : (top * clamped) / prev;
            savePos();
          }),
        );
      }
    },
    [savePos],
  );

  const closeBook = useCallback(() => {
    savePos();
    trRunRef.current?.abort(); // the doc proxy is about to be destroyed
    trStoreRef.current = null;
    setTrInfo(null);
    setTrEta(undefined);
    pathRef.current = null;
    setDoc(null);
    setPath(null);
    setBaseSize(null);
    setSelBar(null);
    setPop(null);
    setGlossOpen(false);
    setMenuOpen(false);
    try {
      getCurrentWindow().setTitle("pdfer").catch(() => {});
    } catch {
      document.title = "pdfer";
    }
  }, [savePos]);

  const toggleDark = useCallback(() => {
    setDark((d) => {
      localStorage.setItem("pdfer:dark", d ? "0" : "1");
      return !d;
    });
  }, []);

  const setColsMode = useCallback((c: Cols) => {
    localStorage.setItem("pdfer:cols", String(c));
    setCols(c);
  }, []);

  // viewport width for "auto" columns (clientWidth excludes the scrollbar)
  useEffect(() => {
    const measure = () => setViewportW(scrollRef.current?.clientWidth ?? window.innerWidth);
    measure();
    let t: number | undefined;
    const onResize = () => { clearTimeout(t); t = window.setTimeout(measure, 150); };
    window.addEventListener("resize", onResize);
    return () => { clearTimeout(t); window.removeEventListener("resize", onResize); };
  }, [doc]);

  // keyboard: Ctrl+O open, Ctrl +/-/0 zoom, D dark (e.code = layout-independent)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
      if (ctrl && e.code === "KeyO") { e.preventDefault(); openDialog(); }
      else if (ctrl && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomTo(scaleRef.current + 0.125); }
      else if (ctrl && e.key === "-") { e.preventDefault(); zoomTo(scaleRef.current - 0.125); }
      else if (ctrl && e.key === "0") { e.preventDefault(); zoomTo(DEFAULT_SCALE); }
      else if (ctrl && e.code === "Digit1") { e.preventDefault(); setColsMode(1); }
      else if (ctrl && e.code === "Digit2") { e.preventDefault(); setColsMode(2); }
      else if (ctrl && e.code === "Digit3") { e.preventDefault(); setColsMode("auto"); }
      // bare-letter hotkeys stay live while the «Перевод» menu is open — it has
      // no text inputs, and T visibly flips the menu's own Ориг/Перевод row
      else if (!ctrl && !e.altKey && !typing && e.code === "KeyD") toggleDark();
      else if (!ctrl && !e.altKey && !typing && e.code === "KeyT") toggleView();
      else if (e.key === "Escape") {
        // Esc peels UI layers before closing the book:
        // меню → глоссарий → перевод → выделение
        if (menuRef.current) setMenuOpen(false);
        else if (glossRef.current) setGlossOpen(false);
        else if (popRef.current) setPop(null);
        else if (selBarRef.current) {
          setSelBar(null);
          document.getSelection()?.removeAllRanges();
        } else closeBook();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDialog, zoomTo, toggleDark, closeBook, setColsMode, toggleView]);

  // Ctrl+wheel zoom (non-passive, to suppress webview page zoom)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        zoomTo(scaleRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [doc, zoomTo]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !path) return;
    const y = el.scrollTop + el.clientHeight * 0.4;
    // pages of one grid row share offsetTop — advance only on a new row, so
    // multi-column layouts report the first page of the deepest row above y
    let cur = 1;
    let curTop = -1;
    el.querySelectorAll<HTMLElement>("[data-page]").forEach((c) => {
      if (c.offsetTop <= y && c.offsetTop > curTop) { cur = Number(c.dataset.page); curTop = c.offsetTop; }
    });
    setCurPage(cur);
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(savePos, 300);
  };

  // "auto" packs as many pages per row as fit, one gap counted per page
  const nCols =
    cols === "auto"
      ? baseSize ? Math.max(1, Math.floor(viewportW / (baseSize.w * scale + PAGE_GAP))) : 1
      : cols;
  // empty max-content tracks are 0-wide but their gaps remain, off-centering
  // docs with fewer pages than columns — never build more tracks than pages
  const nColsEff = doc ? Math.min(nCols, doc.numPages) : nCols;

  const trPct = trInfo ? Math.floor((100 * trInfo.done) / Math.max(1, trInfo.total)) : 0;

  return (
    <div className={`${dark ? "dark" : ""} h-screen w-screen overflow-hidden bg-neutral-200 dark:bg-neutral-900 transition-colors`}>
      <div className="toolbar fixed top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 rounded-full bg-white/85 dark:bg-neutral-800/85 backdrop-blur px-3 py-1.5 shadow-lg text-sm text-neutral-700 dark:text-neutral-200 select-none">
        {/* left: library */}
        <button className="hover:opacity-60 px-1" onClick={doc ? closeBook : openDialog} title={doc ? "Библиотека (Esc)" : "Открыть файл (Ctrl+O)"}>
          {doc ? "Библиотека" : "Открыть файл"}
        </button>
        {doc && (
          <>
            <span className="mx-2 h-4 w-px bg-neutral-900/15 dark:bg-neutral-100/20" />
            {/* center: view controls — pages · zoom · columns */}
            <span className="tabular-nums opacity-70">{curPage} / {doc.numPages}</span>
            <span className="mx-2 opacity-40">·</span>
            <button className="hover:opacity-60 px-1.5" onClick={() => zoomTo(scale - 0.125)} title="Мельче (Ctrl −)">−</button>
            <span className="tabular-nums opacity-70 w-11 text-center">{Math.round(scale * 100)}%</span>
            <button className="hover:opacity-60 px-1.5" onClick={() => zoomTo(scale + 0.125)} title="Крупнее (Ctrl +)">+</button>
            <span className="mx-2 opacity-40">·</span>
            {([1, 2, "auto"] as const).map((c) => (
              <button
                key={String(c)}
                className={`hover:opacity-60 px-1.5 ${cols === c ? "" : "opacity-40"}`}
                onClick={() => setColsMode(c)}
                title={c === 1 ? "Одна страница в ряд (Ctrl+1)" : c === 2 ? "Две страницы в ряд (Ctrl+2)" : "Автоподбор по ширине (Ctrl+3)"}
              >
                {c === "auto" ? "Авто" : c}
              </button>
            ))}
            <span className="mx-2 h-4 w-px bg-neutral-900/15 dark:bg-neutral-100/20" />
            {/* right: «Перевод» dropdown (trigger shows live % while running) */}
            <span className="relative" data-trmenu>
              <button
                className="hover:opacity-60 px-1 whitespace-nowrap tabular-nums"
                onClick={() => setMenuOpen((o) => !o)}
                title="Перевод книги"
              >
                {trRun ? `Перевод · ${trPct}%` : "Перевод"} <span className="text-[9px] opacity-60">▾</span>
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-2.5 z-20 w-64 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur shadow-xl p-1.5 text-left">
                  {/* Ориг|Перевод segmented — mirrors hotkey T */}
                  <div className={`flex gap-0.5 p-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-900/50 ${trInfo === null ? "opacity-40" : ""}`}>
                    {(["orig", "tr"] as const).map((m) => (
                      <button
                        key={m}
                        disabled={trInfo === null}
                        className={`flex-1 rounded-md px-2 py-1 ${
                          viewMode === m && trInfo !== null
                            ? "bg-white dark:bg-neutral-700 shadow-sm"
                            : trInfo === null
                              ? "cursor-default"
                              : "opacity-50 hover:opacity-90"
                        }`}
                        onClick={() => setView(m)}
                        title={trInfo === null ? "Сначала переведите книгу" : m === "orig" ? "Оригинал (T)" : "Перевод (T)"}
                      >
                        {m === "orig" ? "Оригинал" : "Перевод"}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1">
                    {trRun ? (
                      <button
                        className={`${MENU_ROW} tabular-nums`}
                        onClick={() => trRunRef.current?.abort()}
                        title="Пауза — готовые страницы сохранены, продолжить можно в любой момент"
                      >
                        Пауза · {trPct}%{fmtEta(trEta)}
                      </button>
                    ) : trInfo === null ? (
                      <button
                        className={MENU_ROW}
                        onClick={startTr}
                        title="Перевести всю книгу локальной моделью (можно прервать в любой момент)"
                      >
                        Перевести книгу
                      </button>
                    ) : trInfo.done < trInfo.total ? (
                      <button
                        className={`${MENU_ROW} tabular-nums`}
                        onClick={startTr}
                        title={`Продолжить перевод (готово ${trInfo.done} из ${trInfo.total} страниц)`}
                      >
                        Продолжить · {trPct}%
                      </button>
                    ) : (
                      <div className="px-2.5 py-1.5 opacity-50">Переведено · 100%</div>
                    )}
                    {trInfo !== null &&
                      (confirmRestart ? (
                        <div className="px-2.5 py-1.5">
                          <div className="opacity-70">Точно? Прогресс будет удалён</div>
                          <div className="mt-0.5 flex gap-4">
                            <button
                              className="hover:opacity-60 text-red-600 dark:text-red-400"
                              onClick={() => {
                                setConfirmRestart(false);
                                retranslate();
                              }}
                            >
                              да
                            </button>
                            <button className="hover:opacity-60" onClick={() => setConfirmRestart(false)}>
                              нет
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          className={MENU_ROW}
                          onClick={() => setConfirmRestart(true)}
                          title="Удалить сохранённый перевод книги и начать заново"
                        >
                          Перезапустить перевод
                        </button>
                      ))}
                    <button
                      className={MENU_ROW}
                      onClick={() => {
                        setMenuOpen(false);
                        setGlossOpen(true);
                      }}
                      title="Глоссарий книги (термин = перевод, по строке)"
                    >
                      Глоссарий…
                    </button>
                  </div>
                  {modelStatus && (
                    <div className="mt-1 border-t border-neutral-200 dark:border-neutral-700 px-2.5 pt-1.5 pb-1 text-xs opacity-50">
                      Модель:{" "}
                      {modelStatus === "spawned" || modelStatus === "external"
                        ? "работает"
                        : modelStatus === "starting"
                          ? "запускается"
                          : "не найдена"}
                    </div>
                  )}
                </div>
              )}
            </span>
          </>
        )}
        <span className="mx-2 opacity-40">·</span>
        <button className="hover:opacity-60 px-1" onClick={toggleDark} title="Тёмная тема (D)">
          {dark ? "☀" : "☾"}
        </button>
      </div>

      {doc && baseSize ? (
        <div ref={scrollRef} className="h-full overflow-y-auto" onScroll={onScroll} onClick={onAltClick}>
          <div
            className="grid w-fit mx-auto py-14"
            style={{ gridTemplateColumns: `repeat(${nColsEff}, max-content)`, gap: PAGE_GAP }}
          >
            {Array.from({ length: doc.numPages }, (_, i) => (
              <Page
                key={i + 1}
                doc={doc}
                num={i + 1}
                scale={scale}
                baseSize={baseSize}
                viewMode={viewMode}
                trVersion={trVersion}
                getTrPage={getTrPage}
                getBodyFh={getBodyFh}
              />
            ))}
          </div>
        </div>
      ) : (
        <Library onOpen={(p) => loadFile(p).catch((e) => console.error("open failed", e))} />
      )}

      {selBar && !pop && (
        <SelectionBar
          anchor={selBar.anchor}
          onTranslate={() => {
            setPop(selBar);
            setSelBar(null);
          }}
        />
      )}
      {pop && path && (
        <TranslatePopover
          anchor={pop.anchor}
          text={pop.text}
          context={pop.context}
          bookPath={path}
          label={pop.label}
          noTranslate={pop.noTranslate}
          onClose={() => setPop(null)}
        />
      )}
      {glossOpen && path && (
        <GlossaryModal
          bookPath={path}
          doc={doc}
          onClose={() => setGlossOpen(false)}
          onRetranslate={trInfo !== null ? retranslate : undefined}
        />
      )}
    </div>
  );
}
