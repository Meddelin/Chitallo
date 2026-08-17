import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { appDataDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as pdfjs from "pdfjs-dist";
import { AnnotationLayer, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import Library from "./Library";
import FindBar from "./FindBar";
import Outline, { resolveDest } from "./Outline";
import { Palette, ShortcutsOverlay } from "./Palette";
import type { PaletteCommand } from "./Palette";
import { GlossaryModal, SelectionBar, TranslatePopover } from "./TranslatePopover";
import type { Anchor } from "./TranslatePopover";
import { AskSidebar } from "./AskSidebar";
import type { AskSeed } from "./AskSidebar";
import { FIG_CONTAIN, buildFrags, growParagraph, interArea, medianLineH, paraText } from "./paragraphs";
import type { FigureRegion, Word } from "./paragraphs";
import * as booktranslate from "./booktranslate";
import type { TrParagraph } from "./booktranslate";
import { hydrateGlossary } from "./translate";
import * as glossarygen from "./glossarygen";
import { ModelSetupModal, Spinner, dlBusy, dlPct, fetchModelStatus, restartModel, statusUp, useDownload } from "./ModelSetup";
import { AboutModal } from "./About";
import { SettingsModal, TR_FONT_DEFAULT, TR_FONT_MAX, TR_FONT_MIN } from "./Settings";
import { exportTranslation } from "./export";
import * as exportmod from "./export";
import { IconChevronDown, IconColumns, IconMoon, IconSliders, IconSun } from "./icons";
import "./App.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const DEFAULT_SCALE = 1.25;
// Н4: every open path (обложка, Ctrl+O, палитра, pdfer:last) fails into the same toast
const OPEN_FAIL_MSG = "Не удалось открыть файл — он перемещён или повреждён";
const PAGE_GAP = 16;
// «Спросить» sidebar width: the reading area shrinks by this (flex row, no
// overlay), the fixed toolbar shifts left by half to stay centered over it
const ASK_W = 400;

// full-width action row of the «Перевод» dropdown menu
const MENU_ROW =
  "w-full text-left px-2.5 py-1.5 rounded-lg transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700/70 whitespace-nowrap";
// pill/toolbar controls: ONE hover language (WP-K) — a quiet bg tint, never an
// opacity dim; padding is added per call site
const TB_BTN = "rounded-md transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";
// quiet footer rows of the «Перевод» menu (statuses that double as actions):
// explicit ≥4.5:1 colors, hover strengthens the text — the link grammar
const MENU_QUIET =
  "w-full text-left text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-700 dark:hover:text-neutral-200";

type Size = { w: number; h: number };
type Cols = 1 | 2 | "auto";
type ViewMode = "orig" | "tr";
type TrRequest = { anchor: Anchor; text: string; context?: string; label?: string; noTranslate?: boolean };
// selection-bar state: a selection inside the reflowed translation ALSO
// carries the mapped store originals (orig), captured while the selection is
// alive — the bar button / O / Enter / palette merely replay it
type SelBarState = TrRequest & { orig?: string };

// Minimal pdf.js link-service surface — exactly what AnnotationLayer's link
// elements call. The full web/PDFLinkService binds the pdf_viewer EventBus
// stack this app doesn't use (same call as FindBar vs PDFFindController).
type LinkService = {
  addLinkAttributes: (link: HTMLAnchorElement, url: string, newWindow?: boolean) => void;
  getDestinationHash: (dest: unknown) => string;
  getAnchorUrl: (hash: string) => string;
  goToDestination: (dest: unknown) => Promise<void>;
  goToPage: (n: number) => void;
  executeNamedAction: (action: string) => void;
  executeSetOCGState: (state: unknown) => void;
};

// ---- selection → translation helpers ---------------------------------------

// selection strings carry the text layer's EOL newlines; join wrapped lines and
// drop end-of-line hyphenation
function normalizeSelText(raw: string): string {
  return raw.replace(/[-­]\s*\n\s*/g, "").replace(/\s+/g, " ").trim();
}

// « · осталось ~40 мин» from the engine's etaMs (moving average over recent
// pages); копирайт #18 — префикс «осталось», десятичная запятая
function fmtEta(ms?: number): string {
  if (ms === undefined) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return " · осталось <1 мин";
  if (min < 60) return ` · осталось ~${min} мин`;
  const h = ms / 3600000;
  return ` · осталось ~${h < 10 ? h.toFixed(1).replace(".", ",") : Math.round(h)} ч`;
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

// «Спросить» context: page number + surrounding page text for the model. The
// page element the selection starts in supplies its text layer (orig mode) or
// reflowed translation blocks (tr mode); capped to ~2200 chars around the
// selection so long pages don't bloat the prompt.
const ASK_CTX_CAP = 2200;
function extractAskContext(selText: string): { page?: number; pageText?: string } {
  const s = document.getSelection();
  if (!s || s.rangeCount === 0) return {};
  const n = s.getRangeAt(0).startContainer;
  const el = n instanceof Element ? n : n.parentElement;
  const pageEl = el?.closest("[data-page]") as HTMLElement | null;
  if (!pageEl) return {};
  const page = Number(pageEl.dataset.page) || undefined;
  let txt = "";
  const tr = pageEl.querySelector(".trPage");
  if (tr) {
    txt = (tr.textContent ?? "").replace(/\s+/g, " ").trim();
  } else {
    txt = Array.from(pageEl.querySelectorAll<HTMLElement>(".textLayer span"))
      .filter((sp) => (sp.textContent ?? "").trim() && sp.getAttribute("role") !== "img" && !sp.querySelector("span"))
      .map((sp) => sp.textContent ?? "")
      .join(" ")
      .replace(/([A-Za-zА-Яа-яЁё])[-­]\s+([a-zа-яё])/g, "$1$2") // line-wrap hyphens
      .replace(/\s+/g, " ")
      .trim();
  }
  if (!txt) return { page };
  if (txt.length > ASK_CTX_CAP) {
    const pos = txt.toLowerCase().indexOf(selText.toLowerCase());
    const mid = pos >= 0 ? pos + selText.length / 2 : txt.length / 2;
    const start = Math.max(0, Math.min(Math.round(mid - ASK_CTX_CAP / 2), txt.length - ASK_CTX_CAP));
    txt =
      (start > 0 ? "…" : "") + txt.slice(start, start + ASK_CTX_CAP) + (start + ASK_CTX_CAP < txt.length ? "…" : "");
  }
  return { page, pageText: txt };
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

// «Оригинал» peek for a selection inside a reflowed translated page (.trPage):
// every store paragraph the selection touches, matched by data-tridx — the
// same link Alt+click uses. Scope choices, on purpose:
//  - a selection covering PART of one block still yields that block's FULL
//    original: sentence boundaries of the translation and the original don't
//    line up, the store has no sub-paragraph mapping — whole blocks are the
//    simplest honest unit;
//  - blocks are visited in DOM (= reading) order, multi-block selections join
//    with paragraph breaks; crop blocks (kind "other"/failed) that fall inside
//    the range contribute their stored text too, matching Alt+click on a crop;
//  - a mixed selection (trPage + a plain text layer of an untranslated page)
//    yields only the translated blocks' originals — the text-layer part IS
//    original already.
function trOriginalsFromSelection(getTrPage: (n: number) => TrParagraph[] | undefined): string | null {
  const s = document.getSelection();
  if (!s || s.isCollapsed || s.rangeCount === 0) return null;
  const range = s.getRangeAt(0);
  const parts: string[] = [];
  for (const block of document.querySelectorAll<HTMLElement>(".trPage [data-tridx]")) {
    if (!range.intersectsNode(block)) continue;
    const pageEl = block.closest<HTMLElement>("[data-page]");
    const text = getTrPage(Number(pageEl?.dataset.page))?.[Number(block.dataset.tridx)]?.text;
    if (text) parts.push(text);
  }
  return parts.length ? parts.join("\n\n") : null;
}

// ---- reflowed translated page (v2) -----------------------------------------

// list-item openers for hanging indents: "(1) ", "1. ", "1) ", "• ", "a) ", "а) ", "— "
const LIST_RE = /^\s*(?:\(\d{1,3}\)|\d{1,3}[.)]|\(?[a-zа-яё]\)|[•◦▪‣–—])\s/i;

const CROP_PAD = 3; // scale-1 px of original context kept around a cropped region
const PAGE_PAD_X = 0.085; // trPage horizontal padding as a fraction of page width — mirrors App.css

// fig: candidate figure region (geometric detection) — subject to the
// blank-margin pixel check in drawCrops; para crops are always drawn
type Crop = { canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number; fig?: boolean }; // scale-1 rect

// Clean re-typeset page replacing the original render in translation mode.
// Prose paragraphs flow as <p> at ONE uniform body size for the whole book
// (15.5px × scale, via --scale-factor in App.css); headings are recognised by
// the stored glyph height relative to the book's body median (fh/bodyFh ≥ 1.15,
// size capped at 1.8×), list items get a hanging indent. kind:"other" regions
// (display math / tables) and failed paragraphs (tr:"") are never dropped:
// they become placeholder canvases, later filled by drawCrops with image crops
// of the original page render. data-tridx on every block links back to the
// store paragraph (Alt+click «Оригинал», sentence context).
// `figures` (candidate figure regions, caption bboxes already merged in by the
// engine) interleave with the text strictly by reading order (y, then x): each
// region becomes a crop canvas like the others, but flagged fig:true so
// drawCrops can discard blank-margin candidates by pixel inspection.
// kind:"caption" paras are skipped entirely — never flowed as text, never
// cropped on their own: their pixels live inside the merged figure region.
function buildTrPage(
  paras: TrParagraph[],
  figures: readonly FigureRegion[],
  bodyFh: number,
  scale: number,
  baseW: number,
  baseH: number,
) {
  const root = document.createElement("div");
  root.className = "trPage";
  root.lang = "ru"; // enables hyphens:auto for the justified Russian text
  const crops: Crop[] = [];
  const maxW = baseW * scale * (1 - 2 * PAGE_PAD_X); // text column width — crop display cap

  const addCrop = (x0: number, y0: number, w0: number, h0: number, tridx: number | null, fig: boolean) => {
    const x = Math.max(0, x0);
    const y = Math.max(0, y0);
    const w = Math.min(baseW, x0 + w0) - x;
    const h = Math.min(baseH, y0 + h0) - y;
    if (w <= 0 || h <= 0) return;
    const c = document.createElement("canvas");
    // fig-flagged crops carry .trFig — the dark-mode invert skips them, so
    // figures/images keep their original colors (WP-K)
    c.className = fig ? "trCrop trFig" : "trCrop";
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
    if (tridx !== null) c.dataset.tridx = String(tridx);
    c.dataset.crop = `${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`; // dev/test introspection
    root.append(c);
    crops.push({ canvas: c, x, y, w, h, fig });
  };

  // figure regions in reading order; a monotonic cursor interleaves them into
  // the paragraph flow (paras arrive band-ordered from clusterParagraphs)
  const figs = figures.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  let fi = 0;
  const flushFigsAbove = (y: number, x: number) => {
    for (; fi < figs.length && (figs[fi].y < y || (figs[fi].y === y && figs[fi].x <= x)); fi++)
      addCrop(figs[fi].x, figs[fi].y, figs[fi].w, figs[fi].h, null, true);
  };

  paras.forEach((p, i) => {
    if (p.kind === "caption") return; // shown inside its figure region's crop
    // Containment dedup for EVERY kind, prose included: a paragraph mostly
    // inside a figure region (diagram label, table cell, raster-overlapped
    // band) already shows its pixels in the region's crop — flowing it as a
    // translated <p> or as its own crop would duplicate content. Safe: region
    // crops containing glyphs are never blank-dropped. Skipping before
    // flushFigsAbove keeps ordering right — the enclosing region is emitted
    // when the first paragraph BELOW it arrives (or at the end).
    if (figures.some((r) => interArea(p, r) >= FIG_CONTAIN * p.w * p.h)) return;
    flushFigsAbove(p.y, p.x);
    if (p.kind === "prose" && p.tr) {
      const d = document.createElement("p");
      const ratio = bodyFh > 0 && p.fh > 0 ? p.fh / bodyFh : 1;
      if (ratio >= 1.15) {
        d.className = "trHead";
        d.style.fontSize = `${Math.min(1.8, ratio).toFixed(3)}em`;
      } else {
        d.className = LIST_RE.test(p.tr) || LIST_RE.test(p.text) ? "trHang" : "trP";
      }
      d.textContent = p.tr;
      d.dataset.tridx = String(i);
      root.append(d);
    } else {
      addCrop(p.x - CROP_PAD, p.y - CROP_PAD, p.w + 2 * CROP_PAD, p.h + 2 * CROP_PAD, i, false);
    }
  });
  flushFigsAbove(Infinity, Infinity);
  return { root, crops };
}

// Blank-candidate detection: geometric figure candidates are often just tall
// whitespace (TOC leading, chapter-opener margins). The offscreen page render
// already exists for cropping, so sample the candidate's area downsampled to
// ≤32×32 (canvas drawImage area-averages) and measure the luminance spread.
// Blank = variance < BLANK_VAR AND min-max range < BLANK_RANGE. Tuning math
// (255-luminance scale, 32×32 = 1024 samples): a pure margin is a constant
// fill → variance ~0, range 0. One hairline dark rule across the region
// averages to ≈1 row at ~214 → variance ≈ 48; a single small dark mark ≈ 1
// sample at 100 → variance ≈ 22, range ≈ 155; a light-gray diagram (strokes
// ≈ 240 post-averaging, 5% cover) → variance ≈ 10, range ≈ 15+... all pass.
// False-positive side: only marks fainter than ~8 luminance levels off the
// background (invisible in practice) or covering <0.1% of the region can be
// skipped. The check runs on the ORIGINAL render — the dark-mode invert is a
// CSS filter and never reaches these pixels.
const BLANK_VAR = 4;
const BLANK_RANGE = 24;
const SAMPLE = 32;

// copy each crop's region out of the full-page offscreen render (scale × dpr);
// the offscreen canvas is discarded by the caller right after. fig-flagged
// crops (candidate figure regions) that sample as blank are REMOVED from the
// flow instead of drawn.
function drawCrops(off: HTMLCanvasElement, crops: Crop[], scale: number, dpr: number) {
  const k = scale * dpr;
  let probe: CanvasRenderingContext2D | null = null;
  for (const cr of crops) {
    const sx = Math.min(off.width, Math.round(cr.x * k));
    const sy = Math.min(off.height, Math.round(cr.y * k));
    const sw = Math.min(off.width - sx, Math.round(cr.w * k));
    const sh = Math.min(off.height - sy, Math.round(cr.h * k));
    if (sw <= 0 || sh <= 0) {
      if (cr.fig) cr.canvas.remove();
      continue;
    }
    if (cr.fig) {
      if (!probe) {
        const c = document.createElement("canvas");
        c.width = SAMPLE;
        c.height = SAMPLE;
        probe = c.getContext("2d", { willReadFrequently: true })!;
      }
      const pw = Math.min(SAMPLE, sw);
      const ph = Math.min(SAMPLE, sh);
      probe.drawImage(off, sx, sy, sw, sh, 0, 0, pw, ph);
      const d = probe.getImageData(0, 0, pw, ph).data;
      let s = 0;
      let s2 = 0;
      let lo = 255;
      let hi = 0;
      const n = pw * ph;
      for (let i = 0; i < d.length; i += 4) {
        const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        s += y;
        s2 += y * y;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      const mean = s / n;
      if (s2 / n - mean * mean < BLANK_VAR && hi - lo < BLANK_RANGE) {
        cr.canvas.remove(); // blank margin, not a figure
        continue;
      }
    }
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
  getTrFigs,
  getBodyFh,
  linkService,
}: {
  doc: PDFDocumentProxy;
  num: number;
  scale: number;
  baseSize: Size;
  viewMode: ViewMode;
  trVersion: number;
  getTrPage: (n: number) => TrParagraph[] | undefined;
  getTrFigs: (n: number) => FigureRegion[];
  getBodyFh: () => number;
  linkService: LinkService;
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
  // stale-content policy (WP-K): which doc/page the CURRENT children belong to
  const staleKeyRef = useRef<{ doc: PDFDocumentProxy; num: number } | null>(null);

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
    // Stale-content policy (WP-K): re-runs for the SAME page (zoom, view-mode
    // toggle, translation progress) keep the previous render on screen — the
    // old canvas CSS-stretches to the new size — and the fresh render swaps in
    // only when ready, so zoom never flashes white. A doc/num change clears
    // at once (wrong content must not linger).
    if (staleKeyRef.current?.doc !== doc || staleKeyRef.current?.num !== num) el.replaceChildren();
    staleKeyRef.current = { doc, num };
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
            const { root, crops } = buildTrPage(paras, getTrFigs(num), getBodyFh(), scale, vp1.width, vp1.height);
            el.replaceChildren(root); // swap-in: any stale render leaves only now
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

          // canvas and text layer render DETACHED and swap in together when
          // both finish (WP-K): the appear as one, and on zoom the stale
          // render underneath stays visible right until this swap
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(vp.width * dpr);
          canvas.height = Math.floor(vp.height * dpr);
          renderTask = page.render({ canvas, viewport: page.getViewport({ scale: scale * dpr }) });

          const textDiv = document.createElement("div");
          textDiv.className = "textLayer";
          textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport: vp });

          await Promise.all([renderTask.promise, textLayer.render()]).catch(() => {});
          if (cancelled || el.dataset.rendered !== run) return;
          el.replaceChildren(canvas, textDiv);
          // official viewer's selection stabilizer (see TextLayerBuilder): an
          // unselectable div that .selecting expands over the layer so drags
          // through empty areas don't snap the caret to DOM-distant nodes
          const end = document.createElement("div");
          end.className = "endOfContent";
          textDiv.append(end);

          // dark-mode figure exclusion (WP-K): figure rects known from the
          // translation store are re-painted into .figKeep overlays that the
          // .dark canvas invert skips — figures/images keep their original
          // colors. In light mode the pixels are identical, so the overlays
          // are invisible. Books never translated have no rects — no overlays.
          const k = scale * dpr;
          for (const f of getTrFigs(num)) {
            const sx = Math.max(0, Math.round(f.x * k));
            const sy = Math.max(0, Math.round(f.y * k));
            const sw = Math.min(canvas.width - sx, Math.round(f.w * k));
            const sh = Math.min(canvas.height - sy, Math.round(f.h * k));
            if (sw <= 0 || sh <= 0) continue;
            const c = document.createElement("canvas");
            c.className = "figKeep";
            c.width = sw;
            c.height = sh;
            c.getContext("2d")!.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
            c.style.left = `${f.x * scale}px`;
            c.style.top = `${f.y * scale}px`;
            c.style.width = `${f.w * scale}px`;
            c.style.height = `${f.h * scale}px`;
            el.insertBefore(c, textDiv);
          }

          // annotation layer, LINKS ONLY: internal dests jump via the app's
          // link service, external URLs open in the system browser. Forms,
          // popups and other annotation kinds are deliberately not rendered
          // (their CSS/JS never ships). Original-render mode only — the
          // reflowed translation has no matching geometry.
          const anns = (await page.getAnnotations().catch(() => [])).filter((a) => a.subtype === "Link");
          if (anns.length && !cancelled && el.dataset.rendered === run) {
            const annDiv = document.createElement("div");
            annDiv.className = "annotationLayer";
            el.appendChild(annDiv);
            const vpAnn = vp.clone({ dontFlip: true }); // annotation coords are unflipped
            await new AnnotationLayer({
              div: annDiv,
              page,
              viewport: vpAnn,
              accessibilityManager: null,
              annotationCanvasMap: null,
              annotationEditorUIManager: null,
              structTreeLayer: null,
              commentManager: null,
              linkService,
              annotationStorage: null,
            })
              .render({
                annotations: anns,
                div: annDiv,
                viewport: vpAnn,
                page,
                linkService,
                renderForms: false,
              } as unknown as Parameters<AnnotationLayer["render"]>[0])
              .catch(() => {});
          }
        } else if (el.dataset.rendered) {
          // page scrolled far away — free canvas, text layer and pdf.js page resources
          delete el.dataset.rendered;
          renderTask?.cancel();
          textLayer?.cancel();
          page?.cleanup();
          el.replaceChildren();
        } else {
          // far-away page holding only a stale keepsake render (zoom re-run
          // keeps children, see above) — free it, nobody is looking
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
      // children are deliberately NOT cleared here (WP-K): on zoom/view-mode
      // re-runs the stale render must stay visible until the replacement is
      // ready; a doc/num change clears at the top of the next run, and
      // unmount removes the whole node anyway.
      // NOTE: `rendered` (the page's true base size) is also NOT reset —
      // see the placeholder comment above.
    };
  }, [doc, num, scale, viewMode, trDep, getTrPage, getTrFigs, getBodyFh, linkService]);

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
  const [selBar, setSelBar] = useState<SelBarState | null>(null);
  const [pop, setPop] = useState<TrRequest | null>(null);
  const [glossOpen, setGlossOpen] = useState(false);
  // ---- «Спросить» sidebar ----
  // open state is per SESSION (sessionStorage), not per book; the thread
  // itself is per book (AskSidebar persists it in localStorage)
  const [askOpen, setAskOpen] = useState(() => sessionStorage.getItem("pdfer:ask:open") === "1");
  const [askSeed, setAskSeed] = useState<AskSeed | null>(null);
  const askSeedIdRef = useRef(0);
  // ---- Ctrl+F find bar ----
  const [findOpen, setFindOpen] = useState(false);
  // bumped on every Ctrl+F: an already-open bar refocuses + selects its input
  const [findNonce, setFindNonce] = useState(0);
  // palette's «Найти: …» seeds the bar's query; null on every plain Ctrl+F
  const [findSeed, setFindSeed] = useState<{ q: string; n: number } | null>(null);
  const findSeedRef = useRef(0);
  // ---- Ctrl+K command palette + «?» shortcut overlay ----
  const [paletteOpen, setPaletteOpen] = useState(false);
  // selection-bar snapshot taken the moment Ctrl+K opens the palette: the
  // palette input's autofocus collapses the document selection, which clears
  // selBar — the «Оригинал выделенного» command runs off this snapshot
  const [paletteSel, setPaletteSel] = useState<SelBarState | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // ---- «О pdfer» (WP-F): версия, приватность, лицензии ----
  const [aboutOpen, setAboutOpen] = useState(false);
  // ---- Настройки (WP-L): Ctrl+, / меню / глиф в тулбаре библиотеки ----
  const [settingsOpen, setSettingsOpen] = useState(false);
  // кегль текста перевода при 100% (persisted); питает --tr-font-size на корне
  const [trFont, setTrFont] = useState(() => {
    const v = parseFloat(localStorage.getItem("pdfer:trfont") ?? "");
    return Number.isFinite(v) && v >= TR_FONT_MIN && v <= TR_FONT_MAX ? v : TR_FONT_DEFAULT;
  });
  // ---- page-navigation flyout (indicator click: go-to-page + оглавление) ----
  const [navOpen, setNavOpen] = useState(false);
  // ---- «Перевод» dropdown menu ----
  const [menuOpen, setMenuOpen] = useState(false);
  // inline confirm for «Перезапустить перевод»; reset whenever the menu closes
  const [confirmRestart, setConfirmRestart] = useState(false);
  // llama-server state, single vocabulary via ModelSetup.fetchModelStatus:
  // "none"|"external"|"starting"|"spawned"|"dead"; null until the first fetch.
  // Feeds the trigger dot, the menu status row and the startTr gate.
  const [modelStatus, setModelStatus] = useState<string | null>(null);
  // model setup modal (license + user-initiated download) — where none/dead route
  const [setupOpen, setSetupOpen] = useState(false);
  // main model download, surfaced in the menu row while it runs
  const dlMain = useDownload("main");
  // ---- whole-book translation state ----
  const [viewMode, setViewMode] = useState<ViewMode>("orig");
  // store meta for the toolbar: null = no stored translation for this book
  const [trInfo, setTrInfo] = useState<{ done: number; total: number } | null>(null);
  // active background run for the OPEN book only (Р-6: runs are path-keyed in
  // booktranslate's manager and outlive the doc; other books' runs are
  // invisible here — the toolbar reflects only the matching book)
  const [run, setRun] = useState<booktranslate.RunInfo | null>(null);
  // a run somewhere (any book) is waiting out a model outage → sticky toast
  const [anyStall, setAnyStall] = useState(false);
  // startTr is waiting for a "starting" model to come up (auto-starts then)
  const [trWait, setTrWait] = useState(false);
  const trWaitRef = useRef(false);
  // text-layer probe of the open book: null = probing, false = scan (no text)
  const [hasText, setHasText] = useState<boolean | null>(null);
  const hasTextProbeRef = useRef<Promise<boolean> | null>(null);
  // transient bottom toast (auto-hides); sticky engine states override it in render
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number>(undefined);
  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
  }, []);
  // bumped whenever trStoreRef content changes — tr-mode Pages re-read overlays
  const [trVersion, setTrVersion] = useState(0);
  const trStoreRef = useRef<booktranslate.BookTranslation | null>(null);
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
  const findRef = useRef(findOpen);
  findRef.current = findOpen;
  const paletteRef = useRef(paletteOpen);
  paletteRef.current = paletteOpen;
  const shortcutsRef = useRef(shortcutsOpen);
  shortcutsRef.current = shortcutsOpen;
  const aboutRef = useRef(aboutOpen);
  aboutRef.current = aboutOpen;
  const settingsRef = useRef(settingsOpen);
  settingsRef.current = settingsOpen;
  const navOpenRef = useRef(navOpen);
  navOpenRef.current = navOpen;
  const docRef = useRef<PDFDocumentProxy | null>(null);
  docRef.current = doc;
  const curPageRef = useRef(curPage);
  curPageRef.current = curPage;
  // Alt+←/→ jump history: scroll positions, scale-tagged so a zoom change
  // between push and pop still restores the right spot
  const histRef = useRef<{ back: { top: number; scale: number }[]; fwd: { top: number; scale: number }[] }>({
    back: [],
    fwd: [],
  });
  const setupRef = useRef(setupOpen);
  setupRef.current = setupOpen;
  const askOpenRef = useRef(askOpen);
  askOpenRef.current = askOpen;
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
    (window as unknown as Record<string, unknown>).__pdferDev = { doc, path, ...booktranslate, ...glossarygen, ...exportmod };
  }, [doc, path]);

  // dev-only: auto-start/resume the book translation when a marker file
  // in appData names the open book; keeps the batch alive across HMR reloads
  // and app restarts while agent work is ongoing (delete the marker to stop)
  useEffect(() => {
    if (!import.meta.env.DEV || !doc || !path) return;
    let stale = false;
    (async () => {
      const dbg = async (msg: string) => {
        try {
          const { writeFile } = await import("@tauri-apps/plugin-fs");
          const dir = await appDataDir();
          await writeFile(`${dir}\\autotranslate.log`, new TextEncoder().encode(`${new Date().toISOString()} ${msg}`));
        } catch {
          /* ignore */
        }
      };
      try {
        const dir = await appDataDir();
        const bytes = await readFile(`${dir}\\autotranslate.json`);
        const marker = JSON.parse(new TextDecoder().decode(bytes)) as { bookPath?: string };
        if (stale) return void (await dbg("stale after read"));
        if (marker.bookPath !== path) return void (await dbg(`path mismatch: marker=${marker.bookPath} path=${path}`));
        await dbg("marker matched, scheduling startTr");
        setTimeout(() => {
          if (stale) return void dbg("stale at timeout");
          if (booktranslate.getRun(path)) return void dbg("run busy at timeout");
          dbg("calling startTr");
          startTr();
        }, 1500);
      } catch (e) {
        await dbg(`read failed: ${String(e)}`);
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // stable store getters for Page renders (read the ref, never re-created);
  // declared ahead of the selection effect below, which lists getTrPage as a dep
  const getTrPage = useCallback((n: number) => trStoreRef.current?.pages[n], []);
  const getTrFigs = useCallback((n: number) => trStoreRef.current?.figures[n] ?? [], []);
  const getBodyFh = useCallback(() => trStoreRef.current?.bodyFh ?? 0, []);

  // selection mini-toolbar: after a pointerup that leaves a non-empty selection
  // inside a text layer, show «Перевести» near the selection end — or, when the
  // selection lies in a reflowed translation, «Оригинал» (see SelBarState)
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
      const orig = trOriginalsFromSelection(getTrPage) ?? undefined;
      setSelBar({ anchor: { x: last.right + 4, y: last.bottom + 6 }, text, context, orig });
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
  }, [getTrPage]);

  // Mirror the path-keyed run manager (Р-6). The open book's run feeds the
  // toolbar; every progress step of THAT run re-reads the freshly written
  // store (visible pages gain their translation live), and the run ending —
  // pause or completion — re-reads once more for the final meta. Other books'
  // background runs pass through as no-ops (both setStates bail on equality).
  useEffect(() => {
    const p = path;
    let prevDone = -2; // impossible marker: the first change always syncs
    const sync = () => {
      const r = p ? booktranslate.getRun(p) : undefined;
      setRun(r ? { ...r } : null);
      setAnyStall(booktranslate.listRuns().some((x) => x.stalled));
      if (!p) return;
      const d = r ? r.done : -1; // -1 = no active run for this book
      if (d === prevDone) return;
      const hadRun = prevDone >= 0;
      prevDone = d;
      if (!r && !hadRun) return; // initial store load belongs to loadBytes
      booktranslate.loadBookTranslation(p).then((st) => {
        if (st && pathRef.current === p) {
          trStoreRef.current = st;
          setTrInfo({ done: st.donePages.length, total: st.total });
          setTrVersion((v) => v + 1);
        }
      });
    };
    sync();
    return booktranslate.onRunsChange(sync);
  }, [path]);

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

  // model status poll: background while a book is open (feeds the trigger
  // dot), faster while the menu is open — "starting" resolves on its own
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const poll = async () => {
      const s = await fetchModelStatus();
      if (!cancelled) setModelStatus(s);
    };
    poll();
    const t = window.setInterval(poll, menuOpen ? 3000 : 12000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [doc, menuOpen]);

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

  // «Спросить» sidebar open/close (session-persisted)
  const setAsk = useCallback((v: boolean | ((o: boolean) => boolean)) => {
    setAskOpen((o) => {
      const next = typeof v === "function" ? v(o) : v;
      sessionStorage.setItem("pdfer:ask:open", next ? "1" : "0");
      return next;
    });
  }, []);
  const toggleAsk = useCallback(() => setAsk((o) => !o), [setAsk]);

  // SelectionBar «Спросить»: open the sidebar seeded with the quoted selection
  // + auto-extracted page context; the selection bar goes away like on translate
  const askFromSelection = useCallback(() => {
    const bar = selBarRef.current;
    if (!bar) return;
    const ctx = extractAskContext(bar.text);
    setSelBar(null);
    setAskSeed({ id: ++askSeedIdRef.current, quote: bar.text, page: ctx.page, pageText: ctx.pageText });
    setAsk(true);
  }, [setAsk]);

  // SelectionBar «Оригинал» (tr-selections; also O / Enter / palette): replay
  // the originals captured at selection time in the popover — noTranslate, the
  // text IS the answer; same look as Alt+click's «Оригинал» on a trPage block.
  // The palette passes its own snapshot (its input collapses the selection and
  // clears selBar before its commands run); every other caller uses the live bar.
  const peekOriginal = useCallback((bar?: SelBarState | null) => {
    const b = bar ?? selBarRef.current;
    if (!b?.orig) return;
    setSelBar(null);
    setPop({ anchor: b.anchor, text: b.orig, label: "Оригинал", noTranslate: true });
  }, []);

  // Ctrl+F: open (or refocus) the find bar — books only
  const openFind = useCallback(() => {
    if (!pathRef.current) return;
    setFindSeed(null); // plain open never re-applies a stale palette seed
    setFindOpen(true);
    setFindNonce((n) => n + 1);
  }, []);

  // ---- navigation: go-to-page, jump history, pdf.js link service ----

  // jump to a page (1-based); frac = vertical position within it, 0 = top.
  // Every programmatic jump records the previous position for Alt+←.
  const goToPage = useCallback((n: number, frac = 0) => {
    const el = scrollRef.current;
    const total = docRef.current?.numPages ?? 0;
    if (!el || !total) return;
    const p = Math.min(total, Math.max(1, Math.round(n) || 1));
    const pageEl = el.querySelector<HTMLElement>(`[data-page="${p}"]`);
    if (!pageEl) return;
    const h = histRef.current;
    h.back.push({ top: el.scrollTop, scale: scaleRef.current });
    if (h.back.length > 100) h.back.shift();
    h.fwd = [];
    // 10px of air at a page top; dest fractions sit 70px down so the target
    // line clears the floating toolbar
    el.scrollTop = Math.max(0, pageEl.offsetTop + frac * pageEl.offsetHeight - (frac > 0 ? 70 : 10));
  }, []);

  // Alt+←/→ — walk the jump history (positions rescale if zoom changed since)
  const histNav = useCallback((dir: -1 | 1) => {
    const el = scrollRef.current;
    const h = histRef.current;
    const from = dir === -1 ? h.back : h.fwd;
    const to = dir === -1 ? h.fwd : h.back;
    const entry = from.pop();
    if (!el || !entry) return;
    to.push({ top: el.scrollTop, scale: scaleRef.current });
    el.scrollTop = (entry.top * scaleRef.current) / entry.scale;
  }, []);

  // Stable identity (reads refs only) — Page effects never re-run because of
  // it. External URLs go to the system browser via the opener plugin; the
  // window.open fallback covers the plain-browser dev mode.
  const linkService = useMemo<LinkService>(
    () => ({
      addLinkAttributes(link, url) {
        link.href = url;
        link.title = url;
        link.rel = "noopener noreferrer";
        link.onclick = () => {
          openUrl(url).catch(() => window.open(url, "_blank", "noopener"));
          return false;
        };
      },
      getDestinationHash: () => "#",
      getAnchorUrl: () => "#",
      async goToDestination(dest) {
        const d = docRef.current;
        if (!d) return;
        const t = await resolveDest(d, dest);
        if (t && docRef.current === d) goToPage(t.page, t.frac);
      },
      goToPage: (n) => goToPage(n),
      executeNamedAction(action) {
        if (action === "NextPage") goToPage(curPageRef.current + 1);
        else if (action === "PrevPage") goToPage(curPageRef.current - 1);
        else if (action === "FirstPage") goToPage(1);
        else if (action === "LastPage") goToPage(docRef.current?.numPages ?? 1);
        else if (action === "GoBack") histNav(-1);
        else if (action === "GoForward") histNav(1);
      },
      executeSetOCGState: () => {},
    }),
    [goToPage, histNav],
  );

  // page-nav flyout: click outside closes (same pattern as the «Перевод» menu)
  useEffect(() => {
    if (!navOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-pagenav]")) setNavOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [navOpen]);

  // per-book view mode, persisted; default = original
  const setView = useCallback((m: ViewMode) => {
    setViewMode(m);
    if (pathRef.current) localStorage.setItem(`pdfer:view:${pathRef.current}`, m);
  }, []);

  const toggleView = useCallback(() => {
    if (!docRef.current) return;
    if (!trAvailRef.current) {
      // T with nothing to toggle: point at the entry instead of silence (Н5)
      showNotice("Сначала переведите книгу — Перевод ▾");
      return;
    }
    setView(viewModeRef.current === "tr" ? "orig" : "tr");
  }, [setView, showNotice]);

  // One-button whole-book translation. The run itself lives in booktranslate's
  // path-keyed manager (Р-6): it opens its own doc, keeps going when the book
  // is closed or another one is opened, and pause = stopRun (per-page store
  // persistence makes resume free — donePages are skipped). Concurrency 3 of
  // the server's 4 slots — selection translate stays responsive on the spare.
  // Gated: a run only ever starts against a live model. "starting" is waited
  // out (auto-start on ready), "none"/"dead" surface the reason instead of
  // fake-succeeding (WP-B routes these into the model-setup flow), and a book
  // with no text layer never starts a run at all.
  const startTr = useCallback(async () => {
    if (!doc || !path || booktranslate.getRun(path) || trWaitRef.current) return;
    if ((await hasTextProbeRef.current) === false) {
      if (pathRef.current === path) showNotice("В книге нет текстового слоя — нужен OCR");
      return;
    }
    if (pathRef.current !== path || booktranslate.getRun(path)) return; // book changed during the probe
    let status = await fetchModelStatus();
    if (status === "starting") {
      trWaitRef.current = true;
      setTrWait(true);
      try {
        while (status === "starting") {
          await new Promise((r) => setTimeout(r, 2000));
          if (pathRef.current !== path || booktranslate.getRun(path)) return;
          status = await fetchModelStatus();
        }
      } finally {
        trWaitRef.current = false;
        setTrWait(false);
      }
    }
    if (pathRef.current !== path || booktranslate.getRun(path)) return;
    if (status !== "spawned" && status !== "external") {
      // none/dead: no honest run possible — route into the model setup flow
      // (license + download / «Перезапустить») instead of a dead-end toast
      setMenuOpen(false);
      setSetupOpen(true);
      return;
    }
    // rejects only when the book file cannot be re-opened for the run's doc
    booktranslate.startRun(path).catch(() => {
      if (pathRef.current === path) showNotice(OPEN_FAIL_MSG);
    });
  }, [doc, path, showNotice]);

  // «Перевести заново» (glossary modal): drop the store, restart from page 1
  const retranslate = useCallback(async () => {
    if (!path) return;
    setGlossOpen(false);
    await booktranslate.stopRun(path); // let a running pipeline settle before deleting
    await booktranslate.deleteBookTranslation(path).catch(() => {});
    if (pathRef.current !== path) return;
    trStoreRef.current = null;
    setTrInfo(null);
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
          // recency feeds the library's «Читаю» ordering; refreshed on every
          // save so active reading keeps the book on top
          lastOpened: Date.now(),
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
    // Content identity first (WP-M): pdf.js transfers `bytes` to its worker
    // below, and binding is what re-attaches a moved/renamed file to its
    // translation store; glossary hydration (localStorage → appdata file)
    // rides the same moment, ahead of the store read and the popover.
    await booktranslate.bindBook(key, bytes).catch(() => {});
    void hydrateGlossary(key);
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
    // the pos record can be partial: loadFile stamps { lastOpened } before the
    // first scroll-save ever writes scrollTop/scale — guard each field
    const pos = saved ? (JSON.parse(saved) as { scrollTop?: number; scale?: number }) : null;

    // switching books: the previous book's run (if any) keeps going in the
    // background (Р-6 — the manager owns its doc); only swap per-book UI state
    setFindOpen(false); // find state is per book
    setFindSeed(null);
    setNavOpen(false);
    histRef.current = { back: [], fwd: [] }; // jump history is per book
    setAskSeed(null); // a stale seed must not leak into the next book's sidebar
    trStoreRef.current = null;
    setTrInfo(null);
    setViewMode(localStorage.getItem(`pdfer:view:${key}`) === "tr" ? "tr" : "orig");
    pathRef.current = key; // ahead of render, for the async loads' staleness guards
    booktranslate.loadBookTranslation(key).then((st) => {
      if (st && pathRef.current === key) {
        trStoreRef.current = st;
        setTrInfo({ done: st.donePages.length, total: st.total });
        setTrVersion((v) => v + 1);
      }
    });

    // Text-layer probe: sample a few pages spread through the book. A book
    // where none of them yields text is a scan — translation is refused with
    // an honest message (Н8) instead of instantly "completing" with 100%
    // empty pages. startTr awaits the promise; state feeds the menu row.
    const probe = (async () => {
      const picks = [...new Set([1, 2, Math.ceil(d.numPages / 2), d.numPages - 1, d.numPages])].filter(
        (n) => n >= 1 && n <= d.numPages,
      );
      for (const n of picks) {
        try {
          const content = await (await d.getPage(n)).getTextContent();
          let chars = 0;
          for (const it of content.items) if ("str" in it) chars += it.str.trim().length;
          if (chars >= 20) return true;
        } catch {
          // damaged page — keep probing the rest
        }
      }
      return false;
    })();
    hasTextProbeRef.current = probe;
    setHasText(null);
    probe.then((v) => {
      if (pathRef.current === key) setHasText(v);
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

    if (pos && typeof pos.scrollTop === "number") {
      const top = pos.scrollTop;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = top;
        }),
      );
    }
  }, []);

  const loadFile = useCallback(async (p: string) => {
    const bytes = await readFile(p);
    await loadBytes(bytes, p, p.split(/[\\/]/).pop() ?? "pdfer");
    localStorage.setItem("pdfer:last", p);
    // recency stamp for the library's «Читаю» row — merged into the existing
    // pos record so a book opened but never scrolled still counts as opened
    try {
      const k = `pdfer:pos:${p}`;
      const pos = JSON.parse(localStorage.getItem(k) ?? "{}") as Record<string, unknown>;
      pos.lastOpened = Date.now();
      localStorage.setItem(k, JSON.stringify(pos));
    } catch {
      // corrupt pos record — the next savePos rewrites it wholesale
    }
  }, [loadBytes]);

  const openDialog = useCallback(async () => {
    const p = await open({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (typeof p === "string")
      loadFile(p).catch((e) => {
        console.error("open failed", e);
        showNotice(OPEN_FAIL_MSG);
      });
  }, [loadFile, showNotice]);

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
    if (last)
      loadFile(last).catch(() => {
        localStorage.removeItem("pdfer:last");
        showNotice(OPEN_FAIL_MSG); // the book moved/vanished since last session
      });
  }, [loadFile, loadBytes, showNotice]);

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
    // an active run is NOT aborted (Р-6): it owns its own doc and keeps
    // translating in the background — the library card shows its chip
    trStoreRef.current = null;
    setTrInfo(null);
    setHasText(null);
    hasTextProbeRef.current = null;
    pathRef.current = null;
    setDoc(null);
    setPath(null);
    setBaseSize(null);
    setSelBar(null);
    setPop(null);
    setGlossOpen(false);
    setMenuOpen(false);
    setFindOpen(false);
    setFindSeed(null);
    setNavOpen(false);
    setPaletteOpen(false);
    setShortcutsOpen(false);
    histRef.current = { back: [], fwd: [] };
    setAskSeed(null); // askOpen itself survives — it's a session preference
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

  // явная установка темы (сегмент в настройках; toggleDark остаётся для D)
  const setTheme = useCallback((d: boolean) => {
    localStorage.setItem("pdfer:dark", d ? "1" : "0");
    setDark(d);
  }, []);

  // кегль перевода: клампится и сохраняется; CSS-переменная на корне применяет
  // его к каждой .trPage мгновенно (чистый reflow, без ре-рендера страниц)
  const setTrFontPersist = useCallback((px: number) => {
    const v = Math.min(TR_FONT_MAX, Math.max(TR_FONT_MIN, Math.round(px * 2) / 2));
    localStorage.setItem("pdfer:trfont", String(v));
    setTrFont(v);
  }, []);

  // Настройки → «Удалить переводы» (все или одну книгу): файлы уже стёрты —
  // сбросить зеркало открытой книги, чтобы меню и тулбар не показывали
  // несуществующий store; удаление ДРУГОЙ книги открытую не трогает
  const onTranslationsCleared = useCallback((p?: string) => {
    if (p && p !== pathRef.current) return;
    trStoreRef.current = null;
    setTrInfo(null);
    setViewMode("orig");
    setTrVersion((v) => v + 1);
  }, []);

  // «Экспортировать перевод…» (WP-L, Р-9): диалог сохранения решает формат
  // (TXT/HTML); HTML собирает кропы фигур из собственного рендера — прогресс
  // идёт в тост, финал называет результат тем же именем, что и пункт меню
  const exportBusyRef = useRef(false);
  const exportTr = useCallback(async () => {
    const p = pathRef.current;
    if (!p || exportBusyRef.current) return;
    let title = p.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") ?? "перевод";
    try {
      const idx = JSON.parse(localStorage.getItem("pdfer:books") ?? "{}") as Record<string, { title?: string }>;
      title = (idx[p]?.title ?? "").trim() || title;
    } catch {
      // индекса нет — остаётся имя файла
    }
    exportBusyRef.current = true;
    try {
      const res = await exportTranslation(p, title, (done, total) => {
        if (done === total || done % 5 === 0) showNotice(`Экспорт… ${Math.floor((100 * done) / total)}%`);
      });
      if (res === "saved") showNotice("Перевод сохранён");
      else if (res === "cancelled") setNotice(null); // диалог закрыт — тихо
    } catch (e) {
      console.error("export failed", e);
      showNotice("Не удалось экспортировать перевод");
    } finally {
      exportBusyRef.current = false;
    }
  }, [showNotice]);

  // the OS-side window chrome (titlebar) follows the app theme (WP-K); also
  // runs once on start so a persisted dark theme gets a dark titlebar
  useEffect(() => {
    try {
      getCurrentWindow().setTheme(dark ? "dark" : "light").catch(() => {});
    } catch {
      // plain browser (vite dev) — no Tauri
    }
  }, [dark]);

  const setColsMode = useCallback((c: Cols) => {
    localStorage.setItem("pdfer:cols", String(c));
    setCols(c);
  }, []);

  // viewport width for "auto" columns (clientWidth excludes the scrollbar);
  // askOpen is a dep — the sidebar changes the reading width with no resize event
  useEffect(() => {
    const measure = () => setViewportW(scrollRef.current?.clientWidth ?? window.innerWidth);
    measure();
    let t: number | undefined;
    const onResize = () => { clearTimeout(t); t = window.setTimeout(measure, 150); };
    window.addEventListener("resize", onResize);
    return () => { clearTimeout(t); window.removeEventListener("resize", onResize); };
  }, [doc, askOpen]);

  // keyboard: Ctrl+O open, Ctrl +/-/0 zoom, D dark (e.code = layout-independent)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
      if (ctrl && e.code === "KeyO") { e.preventDefault(); openDialog(); }
      else if (ctrl && e.code === "KeyF") { e.preventDefault(); openFind(); }
      else if (ctrl && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomTo(scaleRef.current + 0.125); }
      else if (ctrl && e.key === "-") { e.preventDefault(); zoomTo(scaleRef.current - 0.125); }
      else if (ctrl && e.key === "0") { e.preventDefault(); zoomTo(DEFAULT_SCALE); }
      else if (ctrl && e.code === "Digit1") { e.preventDefault(); setColsMode(1); }
      else if (ctrl && e.code === "Digit2") { e.preventDefault(); setColsMode(2); }
      else if (ctrl && e.code === "Digit3") { e.preventDefault(); setColsMode("auto"); }
      else if (ctrl && e.code === "KeyJ") { e.preventDefault(); toggleAsk(); }
      // Ctrl+K — command palette (flyouts close: one floating layer at a time)
      else if (ctrl && e.code === "KeyK") {
        e.preventDefault();
        setMenuOpen(false);
        setNavOpen(false);
        setShortcutsOpen(false);
        setPaletteSel(selBarRef.current); // before the input focus kills the bar
        setPaletteOpen((o) => !o);
      }
      // «?» / Ctrl+/ — все клавиши одним экраном
      else if (ctrl && e.code === "Slash") { e.preventDefault(); setPaletteOpen(false); setShortcutsOpen((o) => !o); }
      // Ctrl+, — настройки (WP-L)
      else if (ctrl && e.code === "Comma") { e.preventDefault(); setSettingsOpen((o) => !o); }
      else if (!ctrl && !e.altKey && !typing && e.key === "?") { e.preventDefault(); setPaletteOpen(false); setShortcutsOpen((o) => !o); }
      // bare-letter hotkeys stay live while the «Перевод» menu is open — it has
      // no text inputs, and T visibly flips the pill's Ориг|Перевод segment
      else if (!ctrl && !e.altKey && !typing && e.code === "KeyD") toggleDark();
      else if (!ctrl && !e.altKey && !typing && e.code === "KeyT") toggleView();
      // O — «Оригинал» peek for an active tr-selection (bare letter, like D/T;
      // does nothing without a selection bar carrying originals)
      else if (!ctrl && !e.altKey && !typing && e.code === "KeyO" && selBarRef.current?.orig && !popRef.current) {
        e.preventDefault();
        peekOriginal();
      }
      // Alt+←/→ — jump history (link/outline/go-to-page jumps record positions)
      else if (!ctrl && e.altKey && e.code === "ArrowLeft") { e.preventDefault(); histNav(-1); }
      else if (!ctrl && e.altKey && e.code === "ArrowRight") { e.preventDefault(); histNav(1); }
      // reading keys — explicit scroll on the container: works with no prior
      // click (a window handler needs no focus), and preventDefault kills the
      // double-scroll when the container happens to be focused
      else if (
        !ctrl && !e.altKey && scrollRef.current &&
        ["Space", "PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"].includes(e.code)
      ) {
        const el = scrollRef.current;
        const pageStep = Math.max(80, el.clientHeight * 0.85);
        // Space must keep activating focused buttons and typing spaces;
        // arrows/Home/End must keep moving the caret in text inputs
        const onControl = typing || !!t?.closest?.("button, a, select");
        const dy =
          e.code === "PageDown" ? pageStep
          : e.code === "PageUp" ? -pageStep
          : e.code === "Space" && !onControl ? (e.shiftKey ? -pageStep : pageStep)
          : e.code === "ArrowDown" && !typing ? 80
          : e.code === "ArrowUp" && !typing ? -80
          : null;
        if (dy !== null) { e.preventDefault(); el.scrollTop += dy; }
        else if ((e.code === "Home" || e.code === "End") && !typing) {
          e.preventDefault();
          el.scrollTop = e.code === "Home" ? 0 : el.scrollHeight;
        }
      }
      // Enter confirms a visible selection bar — same as clicking its first
      // button: «Перевести ⏎», or «Оригинал» on a tr-selection (no translate
      // is offered there, so Enter must never re-translate the translation)
      else if (
        !ctrl && !e.altKey && !typing && e.key === "Enter" &&
        selBarRef.current && !popRef.current && !t?.closest?.("button, a, select")
      ) {
        e.preventDefault();
        const bar = selBarRef.current;
        if (bar.orig) peekOriginal();
        else {
          setSelBar(null);
          setPop(bar);
        }
      }
      else if (e.key === "Escape") {
        // Esc peels UI layers before closing the book:
        // палитра → шорткаты → «О pdfer» → настройки → оглавление → меню → модель → глоссарий → перевод → поиск → сайдбар (только при фокусе в нём) → выделение
        // (Esc typed INSIDE the find/page/palette inputs is handled there and never reaches this chain)
        const ae = document.activeElement as HTMLElement | null;
        if (paletteRef.current) setPaletteOpen(false);
        else if (shortcutsRef.current) setShortcutsOpen(false);
        else if (aboutRef.current) setAboutOpen(false);
        else if (settingsRef.current) setSettingsOpen(false);
        else if (navOpenRef.current) setNavOpen(false);
        else if (menuRef.current) setMenuOpen(false);
        else if (setupRef.current) setSetupOpen(false);
        else if (glossRef.current) setGlossOpen(false);
        else if (popRef.current) setPop(null);
        else if (findRef.current) setFindOpen(false);
        else if (askOpenRef.current && ae?.closest("[data-asksb]")) {
          // focus inside the sidebar: leave the input first; a focused
          // non-input control closes the panel. An unfocused sidebar is
          // NEVER closed by Esc — the chain falls through to the book.
          if (ae.tagName === "TEXTAREA") ae.blur();
          else setAsk(false);
        } else if (selBarRef.current) {
          setSelBar(null);
          document.getSelection()?.removeAllRanges();
        } else closeBook();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDialog, openFind, zoomTo, toggleDark, closeBook, setColsMode, toggleView, toggleAsk, setAsk, histNav, peekOriginal]);

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
  // active background run for the OPEN book (mirrored from the manager)
  const trRun = run !== null;

  // Ctrl+K commands — every action already in the UI, one name each, with its
  // key as the hint (the palette doubles as the cheat-sheet). Built only while
  // the palette is open; a ~20-element array per render is free.
  const paletteCommands: PaletteCommand[] = [];
  if (paletteOpen) {
    if (doc) {
      paletteCommands.push(
        { id: "toc", label: "Оглавление", keywords: "toc contents содержание страница", run: () => setNavOpen(true) },
        { id: "find", label: "Найти в книге", hint: "Ctrl+F", keywords: "поиск search find", run: openFind },
      );
      if (trInfo !== null)
        paletteCommands.push({
          id: "view",
          label: viewMode === "tr" ? "Показать оригинал" : "Показать перевод",
          hint: "T",
          keywords: "перевод оригинал translation original",
          run: toggleView,
        });
      // tr-selection at palette-open time: the «Оригинал» peek is reachable
      // from the palette too (WP-E: the palette doubles as the cheat-sheet);
      // runs off the snapshot — the live bar died with the input's autofocus
      if (paletteSel?.orig)
        paletteCommands.push({
          id: "selorig",
          label: "Оригинал выделенного",
          hint: "O",
          keywords: "оригинал выделение original selection",
          run: () => peekOriginal(paletteSel),
        });
      if (trRun)
        paletteCommands.push({
          id: "trpause",
          label: "Приостановить перевод",
          keywords: "пауза pause стоп",
          run: () => {
            if (path) void booktranslate.stopRun(path);
          },
        });
      else if (trInfo === null ? hasText !== false : trInfo.done < trInfo.total)
        paletteCommands.push({
          id: "trstart",
          label: trInfo === null ? "Перевести книгу" : `Продолжить перевод · ${trPct}%`,
          keywords: "translate перевод книга",
          run: startTr,
        });
      if (trInfo !== null && trInfo.done > 0)
        paletteCommands.push({
          id: "export",
          label: "Экспортировать перевод…",
          keywords: "экспорт сохранить export txt html",
          run: exportTr,
        });
      paletteCommands.push(
        { id: "gloss", label: "Глоссарий…", keywords: "термины glossary", run: () => setGlossOpen(true) },
        { id: "ask", label: "Спросить", hint: "Ctrl+J", keywords: "вопрос чат claude ask", run: toggleAsk },
        { id: "zin", label: "Крупнее", hint: "Ctrl +", keywords: "масштаб zoom", run: () => zoomTo(scaleRef.current + 0.125) },
        { id: "zout", label: "Мельче", hint: "Ctrl −", keywords: "масштаб zoom", run: () => zoomTo(scaleRef.current - 0.125) },
        { id: "zreset", label: "Сбросить масштаб", hint: "Ctrl+0", keywords: "масштаб zoom", run: () => zoomTo(DEFAULT_SCALE) },
        { id: "c1", label: "Одна страница в ряд", hint: "Ctrl+1", keywords: "колонки columns", run: () => setColsMode(1) },
        { id: "c2", label: "Две страницы в ряд", hint: "Ctrl+2", keywords: "колонки columns", run: () => setColsMode(2) },
        { id: "cauto", label: "Автоподбор по ширине", hint: "Ctrl+3", keywords: "колонки columns авто", run: () => setColsMode("auto") },
        { id: "back", label: "Назад по переходам", hint: "Alt+←", keywords: "история back", run: () => histNav(-1) },
        { id: "fwd", label: "Вперёд по переходам", hint: "Alt+→", keywords: "история forward", run: () => histNav(1) },
        { id: "lib", label: "Библиотека", hint: "Esc", keywords: "закрыть library close", run: closeBook },
      );
    }
    paletteCommands.push(
      { id: "open", label: "Открыть файл…", hint: "Ctrl+O", keywords: "open file pdf", run: openDialog },
      { id: "dark", label: dark ? "Светлая тема" : "Тёмная тема", hint: "D", keywords: "тема theme dark light", run: toggleDark },
      { id: "keys", label: "Клавиши", hint: "?", keywords: "шорткаты клавиатура shortcuts помощь help", run: () => setShortcutsOpen(true) },
      { id: "settings", label: "Настройки…", hint: "Ctrl+,", keywords: "настройки settings тема размер модели хранилище", run: () => setSettingsOpen(true) },
      { id: "about", label: "О pdfer", keywords: "версия лицензии приватность about version license", run: () => setAboutOpen(true) },
    );
  }

  // sticky engine states outrank the transient notice; stall clears itself on
  // recovery. anyStall covers BACKGROUND runs too — a model outage while the
  // library (or another book) is on screen must not fail silently.
  const toastMsg = anyStall
    ? "Модель недоступна — перевод приостановлен, готовые страницы сохранены"
    : trWait
      ? "Модель запускается… Перевод начнётся автоматически"
      : notice;

  return (
    /* no transition-colors on the root: the theme switches everywhere in the
       same instant — a lone animated surface reads as a glitch (WP-K) */
    <div
      className={`${dark ? "dark" : ""} h-screen w-screen overflow-hidden bg-neutral-200 dark:bg-neutral-900`}
      // кегль перевода (WP-L): каждая .trPage читает переменную, зум умножает
      style={{ "--tr-font-size": `${trFont}px` } as React.CSSProperties}
    >
      <div
        className="toolbar fixed top-3 -translate-x-1/2 z-10 flex items-center gap-1 rounded-full bg-white/85 dark:bg-neutral-800/85 backdrop-blur px-3 py-1.5 shadow-lg text-sm text-neutral-700 dark:text-neutral-200 select-none transition-[left] duration-150"
        // stay centered over the READING area: shift by half the sidebar width
        style={{ left: doc && askOpen ? `calc(50% - ${ASK_W / 2}px)` : "50%" }}
      >
        {/* run progress — 2px band along the pill's bottom edge; the trigger
            label stays constant so the pill never resizes mid-run (WP-H) */}
        {doc && trRun && trInfo && (
          <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
            <span
              className="absolute bottom-0 left-0 h-0.5 bg-accent transition-[width] duration-300"
              style={{ width: `${trPct}%` }}
            />
          </span>
        )}
        {/* left: library */}
        <button className={`${TB_BTN} px-1`} onClick={doc ? closeBook : openDialog} title={doc ? "Библиотека (Esc)" : "Открыть файл (Ctrl+O)"}>
          {doc ? "Библиотека" : "Открыть файл"}
        </button>
        {doc && (
          <>
            {/* group «навигация»: Библиотека + страница; the indicator opens
                the go-to-page + оглавление flyout. Width is reserved for the
                widest page number so the pill never shifts while scrolling */}
            <span className="relative" data-pagenav>
              <button
                className={`${TB_BTN} tabular-nums text-neutral-600 dark:text-neutral-300 hover:text-neutral-800 dark:hover:text-neutral-100 px-1 whitespace-nowrap text-center`}
                style={{ minWidth: `calc(${2 * String(doc.numPages).length + 3}ch + 0.5rem)` }}
                onClick={() => setNavOpen((o) => !o)}
                title="Страница и оглавление"
              >
                {curPage} / {doc.numPages}
              </button>
              {navOpen && (
                <Outline
                  doc={doc}
                  onJump={(p, frac) => {
                    setNavOpen(false);
                    goToPage(p, frac);
                  }}
                  onClose={() => setNavOpen(false)}
                />
              )}
            </span>
            <span className="mx-2 h-4 w-px bg-neutral-900/15 dark:bg-neutral-100/20" />
            {/* group «вид»: масштаб · колонки · тема */}
            <button className={`${TB_BTN} px-1.5`} onClick={() => zoomTo(scale - 0.125)} title="Мельче (Ctrl −)">−</button>
            <span className="tabular-nums text-neutral-600 dark:text-neutral-300 w-11 text-center">{Math.round(scale * 100)}%</span>
            <button className={`${TB_BTN} px-1.5`} onClick={() => zoomTo(scale + 0.125)} title="Крупнее (Ctrl +)">+</button>
            <span className="ml-1 flex items-center gap-1">
              {/* active column mode carries the accent — the app's one active color */}
              {([1, 2, "auto"] as const).map((c) => (
                <button
                  key={String(c)}
                  className={`${TB_BTN} px-1.5 py-0.5 ${cols === c ? "text-accent" : "text-neutral-500 dark:text-neutral-400"}`}
                  onClick={() => setColsMode(c)}
                  title={c === 1 ? "Одна страница в ряд (Ctrl+1)" : c === 2 ? "Две страницы в ряд (Ctrl+2)" : "Автоподбор по ширине (Ctrl+3)"}
                >
                  <IconColumns n={c === "auto" ? 3 : c} />
                </button>
              ))}
            </span>
            <button className={`${TB_BTN} ml-1 px-1 py-0.5`} onClick={toggleDark} title={dark ? "Светлая тема (D)" : "Тёмная тема (D)"}>
              {dark ? <IconSun /> : <IconMoon />}
            </button>
            <span className="mx-2 h-4 w-px bg-neutral-900/15 dark:bg-neutral-100/20" />
            {/* group «перевод+инструменты»: Ориг|Перевод сегмент (зеркалит T),
                меню рана, «Спросить» */}
            {trInfo !== null && (
              <div className="flex gap-0.5 p-0.5 mr-1 rounded-full bg-neutral-100 dark:bg-neutral-900/50">
                {(["orig", "tr"] as const).map((m) => (
                  <button
                    key={m}
                    className={`rounded-full px-2 transition-colors ${
                      viewMode === m
                        ? "bg-white dark:bg-neutral-700 shadow-sm"
                        : "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10"
                    }`}
                    onClick={() => setView(m)}
                    title={m === "orig" ? "Оригинал (T)" : "Перевод (T)"}
                  >
                    {m === "orig" ? "Оригинал" : "Перевод"}
                  </button>
                ))}
              </div>
            )}
            <span className="relative" data-trmenu>
              <button
                className={`${TB_BTN} px-1 whitespace-nowrap`}
                onClick={() => setMenuOpen((o) => !o)}
                title="Перевод книги"
              >
                {modelStatus !== null && !statusUp(modelStatus) && (
                  // model not ready — the single «загляни сюда» signal
                  <span
                    className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle ${
                      modelStatus === "starting" || dlBusy(dlMain) ? "animate-pulse" : ""
                    }`}
                  />
                )}
                Перевод <IconChevronDown className="ml-0.5" />
              </button>
              {menuOpen && (
                <div className="overlay-pop absolute right-0 top-full mt-2.5 z-20 w-64 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur shadow-xl p-1.5 text-left">
                  <div>
                    {trRun ? (
                      // копирайт #14: статус некликабелен, пауза — своя кнопка,
                      // подпись постоянна (движок пишет каждую страницу сразу)
                      <div className="px-2.5 py-1.5 select-none">
                        <div className="tabular-nums">
                          {trPct}%{run?.stalled ? " · модель недоступна" : fmtEta(run?.etaMs)}
                        </div>
                        <button
                          className="mt-1 -mx-1 px-1 rounded transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700/70"
                          onClick={() => {
                            if (path) void booktranslate.stopRun(path);
                          }}
                        >
                          Приостановить
                        </button>
                        <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">Готовые страницы сохраняются</div>
                      </div>
                    ) : trInfo === null ? (
                      hasText === false ? (
                        // scan: nothing to feed the model — honest refusal
                        // instead of an instantly-«done» empty translation
                        <div className="px-2.5 py-1.5 text-neutral-500 dark:text-neutral-400 cursor-default">
                          В книге нет текстового слоя — нужен OCR
                        </div>
                      ) : (
                        <button
                          className={MENU_ROW}
                          onClick={() => {
                            setMenuOpen(false);
                            startTr();
                          }}
                          title="Вся книга переводится офлайн, на вашем компьютере. Можно прервать в любой момент"
                        >
                          Перевести книгу
                        </button>
                      )
                    ) : trInfo.done < trInfo.total ? (
                      <button
                        className={`${MENU_ROW} tabular-nums`}
                        onClick={() => {
                          setMenuOpen(false);
                          startTr();
                        }}
                        title={`Продолжить перевод (готово ${trInfo.done} из ${trInfo.total} страниц)`}
                      >
                        Продолжить перевод · {trPct}%
                      </button>
                    ) : (
                      <div className="px-2.5 py-1.5 text-neutral-500 dark:text-neutral-400">Книга переведена</div>
                    )}
                    {/* деструктивное подтверждение (#11): следствие + кнопка,
                        называющая действие; «Перевести заново» (#13) */}
                    {trInfo !== null &&
                      (confirmRestart ? (
                        <div className="px-2.5 py-1.5">
                          <div className="text-neutral-600 dark:text-neutral-300">Готовый перевод будет удалён</div>
                          <div className="mt-1 flex flex-col items-start gap-1">
                            <button
                              className="-mx-1 px-1 rounded text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/10"
                              onClick={() => {
                                setConfirmRestart(false);
                                setMenuOpen(false);
                                retranslate();
                              }}
                            >
                              Удалить и перевести заново
                            </button>
                            <button
                              className="-mx-1 px-1 rounded transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700/70"
                              onClick={() => setConfirmRestart(false)}
                            >
                              Отмена
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          className={MENU_ROW}
                          onClick={() => setConfirmRestart(true)}
                          title="Удалить готовый перевод и перевести книгу заново"
                        >
                          Перевести заново
                        </button>
                      ))}
                    {/* экспорт (WP-L, Р-9): при частичном переводе — честная
                        подпись, сколько страниц попадёт в файл */}
                    {trInfo !== null && trInfo.done > 0 && (
                      <button
                        className={MENU_ROW}
                        onClick={() => {
                          setMenuOpen(false);
                          exportTr();
                        }}
                        title="Сохранить перевод в TXT или HTML"
                      >
                        Экспортировать перевод…
                        {trInfo.done < trInfo.total && (
                          <div className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
                            Готово {trInfo.done} из {trInfo.total} страниц
                          </div>
                        )}
                      </button>
                    )}
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
                  {/* model status row — единый словарь статусов (копирайт #1–4) */}
                  {modelStatus && (
                    <div className="mt-1 border-t border-neutral-200 dark:border-neutral-700 px-2.5 pt-1.5 pb-1 text-xs">
                      {dlBusy(dlMain) ? (
                        <button
                          className={`${MENU_QUIET} tabular-nums`}
                          onClick={() => {
                            setMenuOpen(false);
                            setSetupOpen(true);
                          }}
                          title="Скачивается в фоне — подробности и отмена"
                        >
                          Модель скачивается · {dlPct(dlMain)}%
                        </button>
                      ) : modelStatus === "starting" || (dlMain.status === "done" && !statusUp(modelStatus)) ? (
                        <span className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
                          <Spinner /> Модель перевода: запускается…
                        </span>
                      ) : statusUp(modelStatus) ? (
                        <span className="text-neutral-500 dark:text-neutral-400">Модель перевода: готова</span>
                      ) : modelStatus === "dead" ? (
                        <button
                          className={MENU_QUIET}
                          onClick={() => restartModel().then((s) => setModelStatus(s))}
                        >
                          Модель не отвечает · Перезапустить
                        </button>
                      ) : (
                        <button
                          className={MENU_QUIET}
                          onClick={() => {
                            setMenuOpen(false);
                            setSetupOpen(true);
                          }}
                        >
                          Модель не установлена · Скачать (4,6 ГБ)
                        </button>
                      )}
                    </div>
                  )}
                  {/* «Настройки» (WP-L) + «О pdfer» (WP-F) */}
                  <div className="mt-1 flex flex-col gap-1 border-t border-neutral-200 dark:border-neutral-700 px-2.5 pt-1.5 pb-1 text-xs">
                    <button
                      className={MENU_QUIET}
                      onClick={() => {
                        setMenuOpen(false);
                        setSettingsOpen(true);
                      }}
                    >
                      Настройки…
                    </button>
                    <button
                      className={MENU_QUIET}
                      onClick={() => {
                        setMenuOpen(false);
                        setAboutOpen(true);
                      }}
                    >
                      О pdfer
                    </button>
                  </div>
                </div>
              )}
            </span>
            {/* «Спросить»: chat sidebar over Claude, empty thread from here */}
            <button className={`${TB_BTN} px-1`} onClick={toggleAsk} title="Вопросы по книге (Ctrl+J)">
              Спросить
            </button>
          </>
        )}
        {!doc && (
          <>
            <button className={`${TB_BTN} px-1 py-0.5`} onClick={toggleDark} title={dark ? "Светлая тема (D)" : "Тёмная тема (D)"}>
              {dark ? <IconSun /> : <IconMoon />}
            </button>
            {/* в читалке настройки живут в меню «Перевод»; здесь — свой глиф */}
            <button className={`${TB_BTN} px-1 py-0.5`} onClick={() => setSettingsOpen(true)} title="Настройки (Ctrl+,)">
              <IconSliders />
            </button>
          </>
        )}
      </div>

      {/* Ctrl+F — sibling pill under the toolbar, same centering shift */}
      {doc && findOpen && (
        <FindBar
          doc={doc}
          viewMode={viewMode}
          trVersion={trVersion}
          getTrPage={getTrPage}
          getTrFigs={getTrFigs}
          curPage={curPage}
          focusNonce={findNonce}
          seed={findSeed}
          leftShift={askOpen ? ASK_W / 2 : 0}
          onClose={() => setFindOpen(false)}
        />
      )}

      {/* flex row: reading area shrinks when the «Спросить» sidebar is open — never an overlay */}
      <div className="flex h-full">
        {doc && baseSize ? (
          <div ref={scrollRef} className="h-full flex-1 min-w-0 overflow-y-auto" onScroll={onScroll} onClick={onAltClick}>
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
                  getTrFigs={getTrFigs}
                  getBodyFh={getBodyFh}
                  linkService={linkService}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-w-0 h-full">
            <Library
              onOpen={(p) =>
                loadFile(p).catch((e) => {
                  console.error("open failed", e);
                  showNotice(OPEN_FAIL_MSG);
                })
              }
              onAbout={() => setAboutOpen(true)}
            />
          </div>
        )}
        {/* mounted (hidden) while a book is open so an in-flight ask streams on across toggles */}
        {doc && path && (
          <AskSidebar
            open={askOpen}
            bookPath={path}
            bookTitle={path.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") ?? "книга"}
            page={curPage}
            seed={askSeed}
            onClose={() => setAsk(false)}
          />
        )}
      </div>

      {selBar && !pop && (
        <SelectionBar
          anchor={selBar.anchor}
          // tr-selections swap «Перевести» for «Оригинал» — translating the
          // translation back is nonsense (choice documented in SelectionBar)
          onTranslate={
            selBar.orig
              ? undefined
              : () => {
                  setPop(selBar);
                  setSelBar(null);
                }
          }
          // wrapped: the button's onClick MouseEvent must not land in the
          // optional bar-snapshot parameter
          onOriginal={selBar.orig ? () => peekOriginal() : undefined}
          onAsk={askFromSelection}
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
          onSetup={() => {
            setPop(null);
            setSetupOpen(true);
          }}
        />
      )}
      {glossOpen && path && (
        <GlossaryModal
          bookPath={path}
          doc={doc}
          onClose={() => setGlossOpen(false)}
          onSetup={() => {
            setGlossOpen(false);
            setSetupOpen(true);
          }}
          onRetranslate={trInfo !== null ? retranslate : undefined}
        />
      )}
      {setupOpen && <ModelSetupModal onClose={() => setSetupOpen(false)} />}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {settingsOpen && (
        <SettingsModal
          dark={dark}
          onTheme={setTheme}
          trFont={trFont}
          onTrFont={setTrFontPersist}
          onTranslationsCleared={onTranslationsCleared}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {paletteOpen && (
        <Palette
          commands={paletteCommands}
          numPages={doc?.numPages}
          currentPath={path}
          onOpenBook={(p) =>
            loadFile(p).catch((e) => {
              console.error("open failed", e);
              showNotice(OPEN_FAIL_MSG);
            })
          }
          onGoToPage={goToPage}
          onFind={
            doc
              ? (q) => {
                  setFindSeed({ q, n: ++findSeedRef.current });
                  setFindOpen(true);
                  setFindNonce((n) => n + 1);
                }
              : undefined
          }
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      {toastMsg && (
        <div className="overlay-pop fixed bottom-6 left-1/2 -translate-x-1/2 z-30 rounded-full bg-white/95 dark:bg-neutral-800/95 backdrop-blur px-4 py-2 shadow-xl text-sm text-neutral-700 dark:text-neutral-200 select-none pointer-events-none whitespace-nowrap">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
