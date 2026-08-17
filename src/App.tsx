import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import "./App.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const DEFAULT_SCALE = 1.25;
const PAGE_GAP = 16;

type Size = { w: number; h: number };
type Cols = 1 | 2 | "auto";
type ViewMode = "orig" | "tr";
type TrRequest = { anchor: Anchor; text: string; context?: string };

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
// text (text-layer spans, or the whole paragraph box for translation-overlay
// selections), so the model can disambiguate the word
function sentenceAround(range: Range, selText: string): string | undefined {
  const n = range.startContainer;
  const el = n instanceof Element ? n : n.parentElement;
  let txt = "";
  const trPara = el?.closest(".trPara");
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

// Fit translated text into its paragraph box: closed-form starting size from
// the box area (height ≈ lines × 1.35 × fs, chars/line ≈ width / (0.5 × fs) ⇒
// fs ≈ √(w·h / (0.675·len))), then shrink stepwise until nothing overflows
// (typically 0-3 iterations, hard floor 9px). Small boxes (footnote lines) and
// Russian's ~1.2x expansion can still overflow at the floor — tighten the
// leading before letting overflow:hidden clip.
function fitTrText(d: HTMLElement) {
  const len = Math.max(1, (d.textContent ?? "").length);
  let fs = Math.sqrt((d.clientWidth * d.clientHeight) / (0.675 * len));
  fs = Math.max(9, Math.min(fs, d.clientHeight / 1.35, 28));
  d.style.fontSize = `${fs}px`;
  while (fs > 9 && d.scrollHeight > d.clientHeight + 1) {
    fs = Math.max(9, fs - Math.max(0.5, fs * 0.08));
    d.style.fontSize = `${fs}px`;
  }
  for (const lh of [1.25, 1.15, 1.05, 1]) {
    if (d.scrollHeight <= d.clientHeight + 1) break;
    d.style.lineHeight = String(lh);
  }
}

// Reading overlay: one absolutely-positioned box per stored paragraph. Coords
// are saved at viewport scale 1, so multiply by the current scale. Paragraphs
// whose translation failed (tr === "") get no box — the original shows through,
// same as figures/formulas around the boxes. The layer is a sibling of the
// canvas, so the dark-mode invert filter (canvas-only) never touches it; its
// colors are explicit in App.css.
function appendTrLayer(el: HTMLElement, paras: TrParagraph[] | undefined, scale: number) {
  if (!paras?.length) return;
  const layer = document.createElement("div");
  layer.className = "trLayer";
  const boxes: HTMLElement[] = [];
  for (const p of paras) {
    if (!p.tr) continue;
    const d = document.createElement("div");
    d.className = "trPara";
    d.style.left = `${p.x * scale}px`;
    d.style.top = `${p.y * scale}px`;
    d.style.width = `${p.w * scale}px`;
    d.style.height = `${p.h * scale}px`;
    d.textContent = p.tr;
    layer.append(d);
    boxes.push(d);
  }
  if (!boxes.length) return;
  el.append(layer);
  boxes.forEach(fitTrText); // after insertion — fitting reads layout
}

function Page({
  doc,
  num,
  scale,
  baseSize,
  viewMode,
  trVersion,
  getTrPage,
}: {
  doc: PDFDocumentProxy;
  num: number;
  scale: number;
  baseSize: Size;
  viewMode: ViewMode;
  trVersion: number;
  getTrPage: (n: number) => TrParagraph[] | undefined;
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
  // their overlay live, without a manual toggle. In orig mode the dep is pinned
  // to -1, so translation progress never re-renders pages.
  const trDep = viewMode === "tr" ? trVersion : -1;

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
            if (viewMode === "tr") appendTrLayer(el, getTrPage(num), scale);
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
  }, [doc, num, scale, viewMode, trDep, getTrPage]);

  return (
    <div
      ref={ref}
      data-page={num}
      className="page"
      style={{ width: size.w, height: size.h, "--scale-factor": scale } as React.CSSProperties}
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
        !toEl(s.focusNode)?.closest(".textLayer, .trLayer") &&
        !toEl(s.anchorNode)?.closest(".textLayer, .trLayer")
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

  // Alt+click on text → translate the whole visual paragraph
  const onAltClick = useCallback((e: React.MouseEvent) => {
    if (!e.altKey) return;
    const span = (e.target as HTMLElement).closest?.(".textLayer span") as HTMLElement | null;
    if (!span) return;
    e.preventDefault();
    const para = paragraphAround(span);
    if (!para?.text) return;
    setSelBar(null);
    setPop({ anchor: { x: para.left, y: para.bottom + 6 }, text: para.text });
  }, []);

  // stable page-data getter for Page overlays (reads the ref, never re-created)
  const getTrPage = useCallback((n: number) => trStoreRef.current?.pages[n], []);

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
          // refresh overlay data from the just-written store (a page completes
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
      else if (!ctrl && !e.altKey && !typing && e.code === "KeyD") toggleDark();
      else if (!ctrl && !e.altKey && !typing && e.code === "KeyT") toggleView();
      else if (e.key === "Escape") {
        // Esc peels UI layers before closing the book: глоссарий → перевод → выделение
        if (glossRef.current) setGlossOpen(false);
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
        <button className="hover:opacity-60 px-1" onClick={doc ? closeBook : openDialog} title={doc ? "Библиотека (Esc)" : "Открыть файл (Ctrl+O)"}>
          {doc ? "Библиотека" : "Открыть файл"}
        </button>
        {doc && (
          <>
            <span className="mx-2 opacity-40">·</span>
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
            <span className="mx-2 opacity-40">·</span>
            <button className="hover:opacity-60 px-1" onClick={() => setGlossOpen(true)} title="Глоссарий книги">
              Глоссарий
            </button>
            <span className="mx-2 opacity-40">·</span>
            {trRun ? (
              <>
                <span className="tabular-nums opacity-70 whitespace-nowrap">
                  Перевод: {trPct}%{fmtEta(trEta)}
                </span>
                <button
                  className="hover:opacity-60 px-1.5"
                  onClick={() => trRunRef.current?.abort()}
                  title="Пауза — готовые страницы сохранены, продолжить можно в любой момент"
                >
                  ⏸
                </button>
              </>
            ) : trInfo === null ? (
              <button
                className="hover:opacity-60 px-1"
                onClick={startTr}
                title="Перевести всю книгу локальной моделью (можно прервать в любой момент)"
              >
                Перевести книгу
              </button>
            ) : trInfo.done < trInfo.total ? (
              <button
                className="hover:opacity-60 px-1"
                onClick={startTr}
                title={`Продолжить перевод (готово ${trInfo.done} из ${trInfo.total} страниц)`}
              >
                ▶ {trPct}%
              </button>
            ) : null}
            {trInfo !== null && (
              <>
                <span className="mx-2 opacity-40">·</span>
                {(["orig", "tr"] as const).map((m) => (
                  <button
                    key={m}
                    className={`hover:opacity-60 px-1.5 ${viewMode === m ? "" : "opacity-40"}`}
                    onClick={() => setView(m)}
                    title={m === "orig" ? "Оригинал (T)" : "Перевод (T)"}
                  >
                    {m === "orig" ? "Ориг" : "Перевод"}
                  </button>
                ))}
              </>
            )}
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
