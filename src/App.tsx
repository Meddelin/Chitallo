import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
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
import { SelectionBar, TranslatePopover } from "./TranslatePopover";
import type { Anchor } from "./TranslatePopover";
import { ContextMenu } from "./ContextMenu";
import type { CtxItem } from "./ContextMenu";
import { AskSidebar } from "./AskSidebar";
import { askWMax, useAskWidth } from "./askwidth";
import type { AskSeed } from "./AskSidebar";
import { Panel } from "./Panel";
import type { PanelTab } from "./Panel";
import { GlossaryPanel } from "./GlossaryPanel";
import { TranslatePanel } from "./TranslatePanel";
import type { TrExportError, TrState } from "./TranslatePanel";
import { FIG_CONTAIN, buildFrags, growParagraph, interArea, medianLineH, paraText } from "./paragraphs";
import type { FigureRegion, Word } from "./paragraphs";
import type { Rect } from "./crops";
import { CROP_DPR, CROP_K, blankProbe, blitCrop, cropCanvas, cropSrc, cropViewport, cropWindow, inkProbe, isBlankCrop, releaseCanvas, snapToInk } from "./crops";
import type { CropWindow } from "./crops";
import { splitCitations } from "./cite";
import { OUT_MATCH, outDice, outNorm } from "./textsim";
import * as booktranslate from "./booktranslate";
import type { TrParagraph } from "./booktranslate";
import { hydrateGlossary, loadGlossaryText } from "./translate";
import * as glossarygen from "./glossarygen";
import { parseGlossaryLine, parseGlossaryText, termKey } from "./glossary";
import { ModelSetupModal, fetchModelStatus, restartModel, statusUp, useDownload } from "./ModelSetup";
import { AboutModal } from "./About";
import { SettingsModal, TR_FONT_DEFAULT, TR_FONT_MAX, TR_FONT_MIN } from "./Settings";
import { exportTranslationPdf, exportTranslationToDownloads, exportTranslationTxt } from "./export";
import * as exportmod from "./export";
import { IconColumns, IconMoon, IconSun } from "./icons";
// (WP-N) единственный глиф пилюли, которого нет в icons.tsx: створка панели
import { PanelRightIcon } from "lucide-react";
import "./App.css";
import { baseName, host, isMac, joinPath, macKeys } from "./host";
import { copyToClipboard } from "./clipboard";
import { fmtNum, getLang, t, useLang } from "./i18n";
import { Onboarding, needsOnboarding, resetOnboarding } from "./Onboarding";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/// Shortcut hints are written the Windows/Linux way and rewritten to the
/// macOS glyphs here — the same rule i18n's `t()` applies to catalogue strings.
const K = (s: string) => (isMac() ? macKeys(s) : s);

// (WP-N) Минимум ширины панели, который просит её ЗАГОЛОВОК. С четвёртой
// вкладкой строка имён стала самым широким, что в панели есть: голый ряд
// «Оглавление · Спросить · Термины · Перевод» просит 361 px, а с ярлыками у
// «Спросить» и «Перевода» — 409 px (арифметика и замеры Golos Text — в шапке
// Panel.tsx). ASK_W_MIN = 320 из askwidth.ts на это не хватает и хватить не
// может: на четыре подписи там остаётся 271 px при нулевых отступах. Панель
// обязана быть шире собственной шапки, поэтому минимум поднят здесь — там, где
// App отдаёт ширину панели, а не в общем модуле ширины: карточка графа тянется
// той же ручкой, но шапки из четырёх вкладок у неё нет.
const PANEL_W_MIN = 412;

const DEFAULT_SCALE = 1.25;
const PAGE_GAP = 16;
// Panel width: the reading area shrinks by it (flex row, no overlay), the
// fixed toolbar shifts left by half to stay centered over it. Live value +
// drag/persist live in askwidth.ts (useAskWidth, pdfer:askw); the drag handle
// belongs to Panel.tsx (WP-N).

// full-width row of a toolbar flyout (only the zoom presets are left — the
// «Перевод ▾» menu became the panel's third tab, WP-N)
// (WP-N) наведение здесь — тот же единственный язык, что у TB_BTN ниже и у
// строк ContextMenu/Palette: раньше эта строка красилась сплошным neutral-700,
// и одна выпадашка наводилась не так, как весь остальной интерфейс
const MENU_ROW =
  "w-full text-left px-2.5 py-1.5 rounded-lg transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10 whitespace-nowrap";
// pill/toolbar controls: ONE hover language (WP-K) — a quiet bg tint, never an
// opacity dim; padding is added per call site
const TB_BTN = "rounded-md transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";

type Size = { w: number; h: number };
// zoom fit presets: «По ширине» / «Страница целиком» — sticky until a manual zoom
type FitMode = "width" | "page";
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

// « · ~40 min left» from the engine's etaMs (a moving average over the recent
// pages)
function fmtEta(ms?: number): string {
  if (ms === undefined) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return t("tr.etaMinSub");
  if (min < 60) return t("tr.etaMin", { n: min });
  const h = ms / 3600000;
  return t("tr.etaHour", { n: h < 10 ? fmtNum(h) : Math.round(h) });
}

// (WP-N) причина отказа экспорта — фрагмент с маленькой буквы, каким его пишет
// каталог («нет места на диске»). Когда сказать нечего, остаётся машинный
// текст: он честнее, чем выдуманная причина
function exportReason(e: unknown): string {
  const s = String(e).replace(/^Error:\s*/, "");
  if (/ENOSPC|no space|disk\s*full|not enough space/i.test(s)) return t("err.noDiskSpace");
  return s.slice(0, 80);
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

// Весь текст ОДНОЙ страницы, как её сейчас видно: переведённая страница отдаёт
// свои блоки, обычная — слой текста pdf.js. (WP-N) Разбор вынесен сюда, потому
// что дорог к модели стало две: выделение (extractAskContext) и вопрос про то,
// что открыто на экране (askPageText).
function pageElText(pageEl: HTMLElement): string {
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
  return txt;
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
  let txt = pageElText(pageEl);
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

// (WP-N) Текст того, что читатель ВИДИТ СЕЙЧАС, — для вопросов, которые про
// «здесь»: чипы-подсказки и команды «страница» / «наглядно». Номер страницы им
// не помощник, нужен сам текст.
//
// В две колонки на экране два листа, и берутся оба: читатель смотрит на
// разворот целиком, а пилюля называет лишь левый его лист. Каждый блок уходит
// в промпт со СВОИМ номером — так модель не выдаёт соседнюю страницу за
// спрошенную. Бюджет — две страницы текста на всю выборку, иначе «авто» на
// мелком масштабе (пять листов в ряду) утащил бы в промпт полглавы.
function askPageText(root: HTMLElement | null, page: number): { page: number; text: string }[] {
  const first = root?.querySelector<HTMLElement>(`[data-page="${page}"]`);
  if (!root || !first) return [];
  // страницы одного ряда сетки делят offsetTop — тот же признак «ряда», по
  // которому onScroll выбирает текущую страницу
  const row = Array.from(root.querySelectorAll<HTMLElement>("[data-page]")).filter(
    (c) => c.offsetTop === first.offsetTop && Number(c.dataset.page) >= page,
  );
  const out: { page: number; text: string }[] = [];
  let left = 2 * ASK_CTX_CAP;
  for (const el of row.length ? row : [first]) {
    const n = Number(el.dataset.page);
    // страница ещё не отрисована (текстового слоя нет) — молча пропускаем:
    // пустой блок в промпте хуже отсутствующего
    const full = n ? pageElText(el) : "";
    if (!full) continue;
    const cap = Math.min(ASK_CTX_CAP, left);
    const text = full.length > cap ? `${full.slice(0, cap)}…` : full;
    out.push({ page: n, text });
    left -= text.length;
    if (left <= 0) break;
  }
  return out;
}

// Поле ввода текста — там системное меню незаменимо: вставка требует прав на
// буфер, а отмену, проверку орфографии и подсказки IME из JS не воспроизвести.
// Чекбоксы и ползунки полями ввода не считаются: в них системное меню — это
// «Обновить» и «Проверить код», которым в читалке не место.
const TEXT_INPUT_TYPES = /^(text|search|url|email|password|tel|number)$/i;
function isTextField(el: Element | null): boolean {
  const f = el?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])");
  if (!f) return false;
  return f.tagName !== "INPUT" || TEXT_INPUT_TYPES.test((f as HTMLInputElement).type);
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

// Footnote blocks, detected at RENDER time so stores already on disk benefit
// without a re-translation: footnote-sized type (fh ≤ 0.92× the book's body
// median — the test book's footnotes run ~0.85×, bibliography entries ~0.95×
// stay out), sitting in the lower part of the page, opening with a printed
// footnote label («12. », «3) », «†»). Rendered as .trFoot (small type + a
// hairline above the block) — the reflow otherwise erases the rule and size
// cues, and a footnote reads as stray body prose spliced into the page,
// often mid-sentence (the user's «цитирование ломается»).
const FOOT_RE = /^(?:\d{1,3}[.)]\s|[†‡])/;
const FOOT_LBL = /^\d{1,3}[.)]\s/;
const FOOT_FH = 0.92; // fh/bodyFh cap
const FOOT_ZONE = 0.55; // paragraph must START below this fraction of the page height

const CROP_PAD = 3; // scale-1 px of original context kept around a cropped region
const PAGE_PAD_X = 0.085; // trPage horizontal padding as a fraction of page width — mirrors App.css

// fig: candidate figure region (geometric detection) — subject to the
// blank-margin pixel check in drawCrops; para crops are always drawn.
// cssW/cssH: the on-screen size the block already occupies (fixed in addCrop
// before the raster exists), which is what drawCrops sizes the backing store
// against — see CROP_DPR.
type Crop = {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
  cssW: number;
  cssH: number;
  /** widest the display box may get — the reflow's text column */
  maxW: number;
  fig?: boolean;
}; // scale-1 rect

// Translated text → block content. Citation references («[Devlin et al. 2018]»,
// «[Карпухин и др., 2020]») become <span class="cite">: the original prints
// them in the template's link color, the reflow otherwise flattens them into
// the sentence (see cite.ts for what counts as a reference). Everything else
// stays a plain text node, and the runs concatenate BACK to the stored string
// character for character — FindBar addresses tr-mode matches by offsets into
// it, and «Оригинал»/«Спросить» read the block's textContent.
function setTrText(el: HTMLElement, s: string) {
  const runs = splitCitations(s);
  if (runs.length === 1) {
    el.textContent = s;
    return;
  }
  for (const r of runs) {
    if (!r.cite) {
      el.append(r.text);
      continue;
    }
    const sp = document.createElement("span");
    sp.className = "cite";
    sp.textContent = r.text;
    el.append(sp);
  }
}

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
  // Язык переведённой страницы — язык ИНТЕРФЕЙСА, а не «ru»: на него и
  // переводят (i18n.targetLanguage → translate.ts), а от этого атрибута
  // зависит hyphens:auto — по русским правилам переноса английский текст
  // рвётся не там, где надо. Захардкоженное "ru" было незаметно ровно до тех
  // пор, пока читатель не переключил интерфейс на английский.
  root.lang = getLang();
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
    crops.push({ canvas: c, x, y, w, h, cssW, cssH, maxW, fig });
  };
  // rects of the paragraphs this page prints as translated TEXT: a figure
  // snapping out to its ink must not reach into them (crops.ts snapToInk) —
  // whatever ink is there already reaches the reader in Russian, and pulling
  // a sliver of the English original into the figure would print it twice
  const flowedText: Rect[] = [];

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
    // running header/footer: never rendered — the reflow replaces the page
    // geometry these navigation aids annotate (see detectFurniture)
    if (p.kind === "furniture") return;
    // stitched continuation half: this paragraph's text was absorbed by the
    // paragraph it continues on an EARLIER page and translated whole there
    // (booktranslate contOf) — rendering it here would duplicate the text
    if (p.contOf) return;
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
      let tr = p.tr;
      if (ratio >= 1.15) {
        d.className = "trHead";
        d.style.fontSize = `${Math.min(1.8, ratio).toFixed(3)}em`;
      } else if (ratio <= FOOT_FH && p.y >= FOOT_ZONE * baseH && FOOT_RE.test(p.text)) {
        d.className = "trFoot";
        // the model drops the printed «N.» label now and then — restore it
        // from the source so the footnote keeps its number
        const lbl = FOOT_LBL.exec(p.text)?.[0];
        if (lbl && !/^\s*\d{1,3}[.)]/.test(tr)) tr = lbl + tr;
      } else {
        d.className = LIST_RE.test(p.tr) || LIST_RE.test(p.text) ? "trHang" : "trP";
      }
      setTrText(d, tr);
      d.dataset.tridx = String(i);
      root.append(d);
      flowedText.push({ x: p.x, y: p.y, w: p.w, h: p.h });
    } else {
      addCrop(p.x - CROP_PAD, p.y - CROP_PAD, p.w + 2 * CROP_PAD, p.h + 2 * CROP_PAD, i, false);
    }
  });
  flushFigsAbove(Infinity, Infinity);
  return { root, crops, flowedText };
}

// Copy each crop's region out of the offscreen WINDOW raster (see crops.ts:
// the window covers only the page band that holds crops, rendered at
// CROP_K = 4 device px per PDF point). Each crop's backing store is then
// area-downsampled to CROP_DPR device px per CSS px — supersampling, so the
// 4× raster buys real detail instead of a buffer the compositor has to
// bilinear-crush. The window canvas is released by the caller right after.
// fig-flagged crops (candidate figure regions) that sample as blank are
// REMOVED from the flow instead of drawn.
function drawCrops(off: HTMLCanvasElement, win: CropWindow, crops: Crop[], flowedText: readonly Rect[], dpr: number) {
  let probe: CanvasRenderingContext2D | null = null;
  let ink: CanvasRenderingContext2D | null = null;
  const srcs = crops.map((cr) => cropSrc(win, cr));
  const text = flowedText.map((r) => cropSrc(win, r));
  crops.forEach((cr, i) => {
    let s = srcs[i];
    if (s.sw <= 0 || s.sh <= 0) {
      if (cr.fig) cr.canvas.remove();
      return;
    }
    if (cr.fig) {
      probe ??= blankProbe();
      if (isBlankCrop(probe, off, s.sx, s.sy, s.sw, s.sh)) {
        cr.canvas.remove(); // blank margin, not a figure
        return;
      }
      // the stored rect is geometry and clips the ink that overhangs it
      // (crops.ts snapToInk). The display box follows the rect it recovers —
      // squeezing a taller crop into the box laid out for the shorter one
      // distorted short table bands by up to 20%. The box only ever grows by
      // the strip the snap found (≤ INK_SNAP pt a side), and the page's
      // remembered reflow height is refreshed right after.
      ink ??= inkProbe();
      const s0 = s;
      s = snapToInk(ink, off, win, s0, srcs.slice(0, i).concat(srcs.slice(i + 1), text));
      if (s.sw !== s0.sw || s.sh !== s0.sh) {
        let cssW = (cr.cssW * s.sw) / s0.sw;
        let cssH = (cr.cssH * s.sh) / s0.sh;
        if (cssW > cr.maxW) {
          cssH *= cr.maxW / cssW;
          cssW = cr.maxW;
        }
        cr.cssW = cssW;
        cr.cssH = cssH;
        cr.canvas.style.width = `${cssW}px`;
        cr.canvas.style.height = `${cssH}px`;
      }
    }
    blitCrop(cr.canvas, off, s, cr.cssW * dpr * CROP_DPR, cr.cssH * dpr * CROP_DPR);
  });
}

// ---- translated outline -----------------------------------------------------
// doc.getOutline() speaks the BOOK's language. In translation mode the page
// under it is reflowed Russian, so an English navigator is the one surface that
// never switched over («навигация все равно оригинала»). Each outline row
// already resolves to a page; that page's stored paragraphs hold both the
// original heading text and its translation, so the row can be matched by TEXT
// and relabelled.
//
// A row is matched to a paragraph by Sørensen–Dice similarity over character
// bigrams. That primitive, its normaliser and the OUT_MATCH threshold this book
// calibrated live in textsim.ts — the glossary's near-duplicate folding needs
// exactly the same script-agnostic comparison, and the calibration travelled
// with the number.

// Chapter openers set their title in display type that wraps, and the clusterer
// keeps each line as its own paragraph, so «2 Neural Information Retrieval»
// lives on the page as «Neural Information» + «Retrieval». Runs of consecutive
// same-size heading paragraphs are therefore offered as joined candidates too.
const OUT_RUN = 3; // paragraphs per run, at most
const OUT_HEAD_RATIO = 1.15; // fh/bodyFh over which a paragraph may start a run
const OUT_FH_TOL = 0.06; // same-size tolerance inside a run

/** Translation of the heading `title` names on `paras`, or null when unsure. */
function matchHeadingTr(paras: TrParagraph[] | undefined, bodyFh: number, title: string): string | null {
  if (!paras?.length) return null;
  const want = outNorm(title);
  if (!want) return null;
  let best = 0;
  let bestTr: string | null = null;
  const usable = (p: TrParagraph | undefined) => !!p && p.kind === "prose" && !p.contOf && !!p.tr;
  const take = (text: string, tr: string) => {
    const s = outDice(want, outNorm(text));
    if (s > best) {
      best = s;
      bestTr = tr;
    }
  };
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (!usable(p)) continue;
    take(p.text, p.tr);
    if (!(bodyFh > 0 && p.fh >= OUT_HEAD_RATIO * bodyFh)) continue;
    let text = p.text;
    let tr = p.tr;
    for (let j = i + 1; j < Math.min(paras.length, i + OUT_RUN); j++) {
      const q = paras[j];
      if (!usable(q) || Math.abs(q.fh - p.fh) > OUT_FH_TOL * p.fh) break;
      text += ` ${q.text}`;
      tr += ` ${q.tr}`;
      take(text, tr);
    }
  }
  return best >= OUT_MATCH ? bestTr : null;
}

// Content signature of everything ONE page's render reads out of the
// translation store. In translation mode this is the render effect's
// dependency, in place of the run's global progress counter.
//
// The counter bumps once per completed page, so «Обновить перевод» bumped it
// 838 times — and every bump re-ran the render effect for EVERY mounted page.
// Each re-run tears the page down and rebuilds it: the reflow swaps in
// synchronously but its crops are rasterized from an offscreen render of the
// ORIGINAL and painted a frame or two later, so the whole viewport flickered
// between the reflow and the original for the entire run. Keyed on its own
// content, a page re-renders only when that content actually changed.
//
// Deliberately cheap — this runs for every page of the book on every progress
// event, so it samples the translated text rather than reading all of it: each
// paragraph contributes its kind, its continuation mark, its length and a
// rolling code over every 32nd character. Checked against two full stores of
// the same book produced by different engine versions: of 605 pages that
// genuinely differ it separates 604, with no false alarm. The one it does not
// is a reference page, whose paragraphs are never rendered anyway.
// bodyFh is quantized: it is a median over completed pages and drifts by
// hundredths early in a fresh run, which is invisible and must not invalidate
// every page in the book.
const TR_SIG_STRIDE = 32;
function trPageSig(
  paras: TrParagraph[] | undefined,
  figs: readonly FigureRegion[],
  bodyFh: number,
  refPage: boolean,
): string {
  if (refPage) return `ref|${figs.length}`;
  if (!paras?.length) return `orig|${figs.length}`;
  let s = `${paras.length}|${Math.round(bodyFh * 10)}|${figs.length}`;
  for (const p of paras) {
    let k = 0;
    for (let i = 0; i < p.tr.length; i += TR_SIG_STRIDE) k = (k * 31 + p.tr.charCodeAt(i)) >>> 0;
    s += `|${p.kind[0]}${p.contOf ? "c" : ""}${p.tr.length}.${k.toString(36)}`;
  }
  return s;
}

function Page({
  doc,
  num,
  scale,
  baseSize,
  viewMode,
  getTrPage,
  getTrFigs,
  getBodyFh,
  isRefPage,
  linkService,
}: {
  doc: PDFDocumentProxy;
  num: number;
  scale: number;
  baseSize: Size;
  viewMode: ViewMode;
  getTrPage: (n: number) => TrParagraph[] | undefined;
  getTrFigs: (n: number) => FigureRegion[];
  getBodyFh: () => number;
  isRefPage: (n: number) => boolean;
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
  // trH (optional): measured natural reflow height at scale 1 — see the
  // measurement after buildTrPage below. Same doc guard, same keep-across-runs
  // policy as `base`.
  const [rendered, setRendered] = useState<{ doc: PDFDocumentProxy; base: Size; trH?: number } | null>(null);
  const base = rendered && rendered.doc === doc ? rendered.base : baseSize;
  const trNatH = rendered && rendered.doc === doc ? rendered.trH : undefined;
  const size = { w: base.w * scale, h: base.h * scale };
  // stale-content policy (WP-K): which doc/page the CURRENT children belong to
  const staleKeyRef = useRef<{ doc: PDFDocumentProxy; num: number } | null>(null);

  // bibliography/reference pages (store.refPages, set by the engine's isRefPage
  // classifier) keep the ORIGINAL render even in translation mode — translated
  // reference entries come out corrupted, the original is strictly better
  const refPage = viewMode === "tr" && isRefPage(num);
  // reflow pages own their height: natural flow height, but never shorter than
  // the original render (min-height), so virtualization placeholders keep size
  const reflow = viewMode === "tr" && !refPage && !!getTrPage(num)?.length;
  // The render effect's translation dependency: THIS page's own store content
  // (see trPageSig), recomputed on every progress event but only re-running the
  // effect when this page changed. So a page gains its reflowed translation the
  // moment the engine finishes it — no manual toggle — while the rest of the
  // viewport is left alone. In orig mode the dep is pinned, exactly as before:
  // translation progress never re-renders an untranslated view.
  const trSig = viewMode === "tr" ? trPageSig(getTrPage(num), getTrFigs(num), getBodyFh(), refPage) : "";

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
          // refPage → paras undefined → the original canvas+textLayer path below
          const paras = viewMode === "tr" && !isRefPage(num) ? getTrPage(num) : undefined;
          if (paras?.length) {
            // reflowed translated page: NO canvas and NO text layer — the
            // original is rasterized only offscreen (once, if any non-prose
            // region needs an image crop) and discarded after cropping
            const { root, crops, flowedText } = buildTrPage(paras, getTrFigs(num), getBodyFh(), scale, vp1.width, vp1.height);
            el.replaceChildren(root); // swap-in: any stale render leaves only now
            // Scroll hardening, secondary to .page:empty{overflow-anchor:none}:
            // persist the measured natural reflow height (scale-independent).
            // The layout is settled synchronously — crops get their final CSS
            // size up front — so offsetHeight is trustworthy here. A collapsed
            // (unrendered) translated page keeps this footprint as placeholder
            // min-height, making the later re-render a Δ≈0 height change even
            // when anchoring fails. Refreshed on every tr re-render (trVersion,
            // zoom); small drift across zoom levels is acceptable and the ≥1px
            // bail-out keeps sub-pixel churn from re-rendering.
            const measured = el.offsetHeight / scale;
            setRendered((prev) =>
              prev && prev.doc === doc && prev.trH !== undefined && Math.abs(prev.trH - measured) < 1
                ? prev
                : { doc, base: { w: vp1.width, h: vp1.height }, trH: measured },
            );
            // Crops are rasterized from a WINDOW render (crops.ts) — only the
            // band of the page that actually holds crops, at 4 device px per
            // PDF point or the current display density, whichever is higher.
            // Nothing else on a reflowed page needs the original pixels, so
            // this is the whole cost of the original render here.
            const win = crops.length
              ? cropWindow(crops, vp1.width, vp1.height, Math.max(CROP_K, scale * dpr * CROP_DPR))
              : null;
            if (win) {
              const off = cropCanvas(win);
              renderTask = page.render({ canvas: off, viewport: cropViewport(page, win) });
              await renderTask.promise.catch(() => {});
              if (!cancelled && el.dataset.rendered === run) {
                drawCrops(off, win, crops, flowedText, dpr);
                // a figure that snapped out to its ink (crops.ts) is a few
                // points taller than the box measured above — re-persist the
                // reflow height so the placeholder still matches
                const grown = el.offsetHeight / scale;
                setRendered((prev) =>
                  prev && prev.doc === doc && prev.trH !== undefined && Math.abs(prev.trH - grown) < 1
                    ? prev
                    : { doc, base: { w: vp1.width, h: vp1.height }, trH: grown },
                );
              }
              releaseCanvas(off); // a page-band's worth of RGBA — do not wait for GC
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
  }, [doc, num, scale, viewMode, trSig, getTrPage, getTrFigs, getBodyFh, isRefPage, linkService]);

  return (
    <div
      ref={ref}
      data-page={num}
      className="page"
      style={
        {
          width: size.w,
          // reflow placeholder keeps the measured natural footprint (never
          // shorter than the original page) so unrender→re-render is Δ≈0
          minHeight: reflow && trNatH ? Math.max(size.h, trNatH * scale) : size.h,
          height: reflow ? undefined : size.h,
          "--scale-factor": scale,
        } as React.CSSProperties
      }
    />
  );
}

export default function App() {
  // Subscribing to the language here re-renders the whole tree on a switch:
  // nothing below is memoised, so one subscription covers every surface.
  useLang();
  // First run: the setup wizard owns the screen until it is finished or
  // skipped. `setup` is also how Settings re-opens it later.
  const [setup, setSetup] = useState(needsOnboarding);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [baseSize, setBaseSize] = useState<Size | null>(null);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  // active fit preset; kept across resizes/column changes, cleared by any
  // manual zoom (Ctrl±, колесо, число из меню)
  const [fitMode, setFitMode] = useState<FitMode | null>(null);
  const [curPage, setCurPage] = useState(1);
  const [dark, setDark] = useState(() => localStorage.getItem("pdfer:dark") === "1");
  const [cols, setCols] = useState<Cols>(() => {
    const c = localStorage.getItem("pdfer:cols");
    return c === "2" ? 2 : c === "auto" ? "auto" : 1;
  });
  const [viewportW, setViewportW] = useState(() => window.innerWidth);
  const [viewportH, setViewportH] = useState(() => window.innerHeight);
  const [selBar, setSelBar] = useState<SelBarState | null>(null);
  // where the selection bar actually sits right now — SelectionBar keeps this
  // current as the page scrolls. Everything that opens the popover "from the
  // bar" reads it, so the answer appears where the button was, not where the
  // selection happened to be when it was made.
  const selAnchorRef = useRef<Anchor>({ x: 0, y: 0 });
  const [pop, setPop] = useState<TrRequest | null>(null);
  // Chitallo's right-click menu (см. ContextMenu.tsx): items are built per event
  const [ctxMenu, setCtxMenu] = useState<{ at: Anchor; items: CtxItem[]; keyboard?: boolean } | null>(null);
  // ---- термины книги (вкладка «Термины») ----
  // Записей в файле: число справа в строке «Открыть глоссарий» и подсказка
  // вкладки. Считает их сама вкладка — она и так разбирает текст поля на
  // каждое изменение, а у App нет ни этого текста, ни момента, когда прогон
  // дописал файл (AskSidebar сообщает число сообщений ровно так же).
  const [glossaryTerms, setGlossaryTerms] = useState(0);
  // ---- правая панель: «Оглавление · Спросить · Термины · Перевод» (WP-N) ----
  // open state is per SESSION (sessionStorage), not per book; the thread
  // itself is per book (AskSidebar persists it in localStorage). Ключ прежний —
  // сайдбар «Спросить» стал одной из вкладок, а не отдельной поверхностью.
  const [panelOpen, setPanelOpen] = useState(() => sessionStorage.getItem("pdfer:ask:open") === "1");
  const [panelTab, setPanelTab] = useState<PanelTab>(() => {
    const s = sessionStorage.getItem("pdfer:panel:tab");
    return s === "outline" || s === "glossary" || s === "translate" ? s : "ask";
  });
  // width is a workspace preference (pdfer:askw) — the panel owns the drag
  const [askW, setAskW] = useAskWidth();
  // Ширина, которую панель получает и которой её тянут. Минимум поднят до
  // PANEL_W_MIN, но НЕ выше askWMax(): книге всегда остаётся её READ_MIN, и на
  // узком окне панель честно опускается ниже — тогда строка вкладок
  // переносится на вторую строку (Panel.tsx), а не обрезается.
  const panelW = Math.min(Math.max(askW, PANEL_W_MIN), askWMax());
  const setPanelW = useCallback((w: number) => setAskW(Math.max(w, PANEL_W_MIN)), [setAskW]);
  const [askSeed, setAskSeed] = useState<AskSeed | null>(null);
  const askSeedIdRef = useRef(0);
  // сообщений в открытой беседе — число на ярлыке вкладки «Спросить»
  const [askCount, setAskCount] = useState(0);
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
  // ---- «О Chitallo» (WP-F): версия, приватность, лицензии ----
  const [aboutOpen, setAboutOpen] = useState(false);
  // ---- Настройки (WP-L): Ctrl+, / меню / глиф в тулбаре библиотеки ----
  const [settingsOpen, setSettingsOpen] = useState(false);
  // кегль текста перевода при 100% (persisted); питает --tr-font-size на корне
  const [trFont, setTrFont] = useState(() => {
    const v = parseFloat(localStorage.getItem("pdfer:trfont") ?? "");
    return Number.isFinite(v) && v >= TR_FONT_MIN && v <= TR_FONT_MAX ? v : TR_FONT_DEFAULT;
  });
  // ---- zoom-preset flyout (клик по «125%»: По ширине / целиком / числа) ----
  const [zoomOpen, setZoomOpen] = useState(false);
  // llama-server state, single vocabulary via ModelSetup.fetchModelStatus:
  // "none"|"external"|"starting"|"spawned"|"dead"; null until the first fetch.
  // Feeds the panel's model line and the startTr gate.
  const [modelStatus, setModelStatus] = useState<string | null>(null);
  // model setup modal (license + user-initiated download) — where none/dead route
  const [setupOpen, setSetupOpen] = useState(false);
  // main model download, surfaced in the panel's model line while it runs
  const dlMain = useDownload("main");
  // ---- whole-book translation state ----
  const [viewMode, setViewMode] = useState<ViewMode>("orig");
  // store meta for the toolbar: null = no stored translation for this book
  const [trInfo, setTrInfo] = useState<{ done: number; total: number } | null>(null);
  // active background run for the OPEN book only (Р-6: runs are path-keyed in
  // booktranslate's manager and outlive the doc; other books' runs are
  // invisible here — the toolbar reflects only the matching book)
  const [run, setRun] = useState<booktranslate.RunInfo | null>(null);
  // a run somewhere (any book) is waiting out a model outage: янтарная точка
  // на ярлыке вкладки «Перевод» здесь и строка на карточке в библиотеке (WP-N)
  const [anyStall, setAnyStall] = useState(false);
  // startTr is waiting for a "starting" model to come up (auto-starts then).
  // Ref, not state: ждать видно по строке модели в карточке «Перевод»
  const trWaitRef = useRef(false);
  // text-layer probe of the open book: null = probing, false = scan (no text)
  const [hasText, setHasText] = useState<boolean | null>(null);
  const hasTextProbeRef = useRef<Promise<boolean> | null>(null);
  // transient bottom toast (auto-hides). (WP-N) От всех тостов остался один —
  // отказ проводника, и только потому, что рядом с ним стоит глагол-выход
  // «Повторить». Всё остальное печатают карточки на месте действия: прогон и
  // экспорт — вкладка «Перевод», книга, которая не открылась, — её карточка в
  // библиотеке. Тост с кнопкой живёт дольше: по кнопке надо успеть щёлкнуть
  const [notice, setNotice] = useState<{ msg: string; action?: { label: string; run: () => void } } | null>(null);
  const noticeTimer = useRef<number>(undefined);
  const showNotice = useCallback((msg: string, action?: { label: string; run: () => void }) => {
    setNotice({ msg, action });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), action ? 10000 : 6000);
  }, []);
  // «Показать в папке» из контекстного меню карточки. Отказ проводника печатать
  // негде — меню к этому времени закрыто, — поэтому он и остаётся единственным
  // тостом приложения: причина слева, глагол-выход справа (WP-N)
  const reveal = useCallback(
    (p: string) => {
      // объявлением, а не const: «Повторить» ссылается на себя же
      function go(): Promise<void> {
        return revealItemInDir(p).catch((e) => {
          console.warn("reveal failed", e);
          showNotice(t("ui.openFolderFailed"), { label: t("ui.retry"), run: () => void go() });
        });
      }
      return go();
    },
    [showNotice],
  );
  // bumped whenever trStoreRef content changes — tr-mode Pages re-read overlays
  const [trVersion, setTrVersion] = useState(0);
  const trStoreRef = useRef<booktranslate.BookTranslation | null>(null);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const trAvailRef = useRef(false);
  trAvailRef.current = trInfo !== null;
  const selBarRef = useRef(selBar);
  selBarRef.current = selBar;
  const ctxRef = useRef(ctxMenu);
  ctxRef.current = ctxMenu;
  const popRef = useRef(pop);
  popRef.current = pop;
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
  const zoomOpenRef = useRef(zoomOpen);
  zoomOpenRef.current = zoomOpen;
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
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  const panelTabRef = useRef(panelTab);
  panelTabRef.current = panelTab;
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
    (window as unknown as Record<string, unknown>).__pdferDev = {
      doc,
      path,
      ...booktranslate,
      ...glossarygen,
      ...exportmod,
      // прямой прогон PDF-экспорта без меню (агентские E2E-проверки):
      //   __pdferDev.exportPdf() — открытая книга; __pdferDev.exportPdf(bookPath) — любая
      exportPdf: (bp?: string) => {
        const p = bp ?? path;
        if (!p) return Promise.reject(new Error("no book"));
        return exportmod.exportTranslationPdf(p, baseName(p).replace(/\.pdf$/i, ""));
      },
    };
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
          await writeFile(joinPath(dir, "autotranslate.log"), new TextEncoder().encode(`${new Date().toISOString()} ${msg}`));
        } catch {
          /* ignore */
        }
      };
      try {
        const dir = await appDataDir();
        const bytes = await readFile(joinPath(dir, "autotranslate.json"));
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
  // (WP-N) Текст открытой страницы для «Спросить» — читается в момент вопроса,
  // а не при рендере: читатель листает книгу между сообщениями, и панель обязана
  // спрашивать про ту страницу, что перед ним сейчас. Режим просмотра учтён сам
  // собой — pageElText берёт переведённые блоки, когда они на странице стоят.
  const getAskPageText = useCallback((n: number) => askPageText(scrollRef.current, n), []);
  // refPages is a short sorted list (a handful of bibliography pages) —
  // linear includes() per Page render is fine
  const isRefPage = useCallback((n: number) => trStoreRef.current?.refPages.includes(n) ?? false, []);

  // (WP-N) Оглавление теперь смонтировано, пока открыта книга, а свой обход
  // назначений оно перезапускает на каждую новую identity trTitle. Раньше
  // флайаут жил секунды и trVersion был безобиден; постоянной вкладке он бы не
  // дал ни разу дойти до конца — номера страниц пропадали бы каждые пару
  // секунд, пока идёт прогон. Поэтому идентичность двигает редкий тик: раз в
  // 15 с и только если с прошлого тика что-то доперевелось.
  const [trTick, setTrTick] = useState(0);
  const trVersionRef = useRef(trVersion);
  trVersionRef.current = trVersion;
  useEffect(() => {
    if (viewMode !== "tr") return; // в режиме оригинала заголовки не переводятся
    let seen = trVersionRef.current;
    const id = window.setInterval(() => {
      if (trVersionRef.current === seen) return;
      seen = trVersionRef.current;
      setTrTick((v) => v + 1);
    }, 15000);
    return () => window.clearInterval(id);
  }, [viewMode]);

  // Outline row → its translated heading (matchHeadingTr), only in translation
  // mode. Identity changes with the tick above, so an outline open while the
  // engine runs picks up headings as their pages land.
  const trOutlineTitle = useCallback(
    (page: number, title: string) => {
      if (viewMode !== "tr") return null;
      const st = trStoreRef.current;
      return st ? matchHeadingTr(st.pages[page], st.bodyFh, title) : null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewMode, trTick],
  );

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
      const anchor = { x: last.right + 4, y: last.bottom + 6 };
      selAnchorRef.current = anchor; // SelectionBar keeps it live from here on
      setSelBar({ anchor, text, context, orig });
    };
    let down = false;
    let reeval: number | undefined;
    const onDown = () => {
      down = true;
    };
    const onUp = (e: PointerEvent) => {
      down = false;
      if ((e.target as Element | null)?.closest?.("[data-selbar],[data-popover],[data-ctxmenu]")) return;
      setTimeout(evaluate, 0); // let the browser settle the selection first
    };
    const onSelChange = () => {
      const s = document.getSelection();
      if (!s || s.isCollapsed) return setSelBar(null);
      // Shift+→/↓ extends a selection without ever firing pointerup. The bar
      // itself follows the rects on its own; the captured payload has to catch
      // up too, or «Перевести» would act on the text the selection used to be.
      // Only refreshes a bar that already exists, only once the extension has
      // settled, and never mid-drag — the payload walk re-reads the store.
      if (!selBarRef.current || down) return;
      clearTimeout(reeval);
      reeval = window.setTimeout(evaluate, 180);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      clearTimeout(reeval);
      document.removeEventListener("pointerdown", onDown);
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
          // referential bail-out, like setRun/setAnyStall above: an update run
          // re-sweeps pages that are already done, so donePages does not move
          // for the whole sweep and a fresh object here would re-render the
          // page grid ~838 times for nothing
          setTrInfo((prev) =>
            prev && prev.done === st.donePages.length && prev.total === st.total
              ? prev
              : { done: st.donePages.length, total: st.total },
          );
          setTrVersion((v) => v + 1);
        }
      });
    };
    sync();
    return booktranslate.onRunsChange(sync);
  }, [path]);

  // model status poll: background while a book is open (feeds the panel's
  // model line), faster while the «Перевод» tab is on screen — "starting"
  // resolves on its own and the line has to see it (WP-N)
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const poll = async () => {
      const s = await fetchModelStatus();
      if (!cancelled) setModelStatus(s);
    };
    poll();
    const t = window.setInterval(poll, panelOpen && panelTab === "translate" ? 3000 : 12000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [doc, panelOpen, panelTab]);

  // Alt+click on text → translate the whole visual paragraph; on a reflowed
  // translated block the translation is already on screen, so show the stored
  // ORIGINAL paragraph instead (matched by store index via data-tridx)
  // The paragraph under a point, as a popover — shared by Alt+click and the
  // context menu's «Перевести абзац» / «Оригинал абзаца», so both gestures
  // resolve the paragraph the same way. Returns false when there is none.
  const paragraphPopover = useCallback(
    (target: HTMLElement): boolean => {
      const block = target.closest?.(".trPage [data-tridx]") as HTMLElement | null;
      if (block) {
        const pageEl = block.closest("[data-page]") as HTMLElement | null;
        const orig = getTrPage(Number(pageEl?.dataset.page))?.[Number(block.dataset.tridx)]?.text;
        if (!orig) return false;
        const r = block.getBoundingClientRect();
        setSelBar(null);
        setPop({ anchor: { x: r.left, y: r.bottom + 6 }, text: orig, label: t("tb.original"), noTranslate: true });
        return true;
      }
      const span = target.closest?.(".textLayer span") as HTMLElement | null;
      if (!span) return false;
      const para = paragraphAround(span);
      if (!para?.text) return false;
      setSelBar(null);
      setPop({ anchor: { x: para.left, y: para.bottom + 6 }, text: para.text });
      return true;
    },
    [getTrPage],
  );

  const onAltClick = useCallback(
    (e: React.MouseEvent) => {
      if (!e.altKey) return;
      if (paragraphPopover(e.target as HTMLElement)) e.preventDefault();
    },
    [paragraphPopover],
  );

  // панель: открыть/закрыть и на какой вкладке (открытость — на сессию, вкладка
  // рядом с ней: вернувшись из библиотеки, читатель застаёт ту же вкладку)
  const setPanel = useCallback((v: boolean) => {
    sessionStorage.setItem("pdfer:ask:open", v ? "1" : "0");
    setPanelOpen(v);
  }, []);
  const selectTab = useCallback((tab: PanelTab) => {
    sessionStorage.setItem("pdfer:panel:tab", tab);
    setPanelTab(tab);
  }, []);
  // всё, что раньше открывало флайаут или меню, теперь просит вкладку
  const openPanel = useCallback(
    (tab: PanelTab) => {
      selectTab(tab);
      setPanel(true);
    },
    [selectTab, setPanel],
  );
  // Ctrl+J: вторым нажатием панель закрывается, но только если «Спросить» уже
  // на виду — иначе клавиша переводит на неё, а не гасит панель
  const toggleAsk = useCallback(() => {
    if (panelOpenRef.current && panelTabRef.current === "ask") setPanel(false);
    else openPanel("ask");
  }, [openPanel, setPanel]);

  // SelectionBar «Спросить»: open the panel seeded with the quoted selection
  // + auto-extracted page context; the selection bar goes away like on translate
  const askFromSelection = useCallback(() => {
    const bar = selBarRef.current;
    if (!bar) return;
    const ctx = extractAskContext(bar.text);
    setSelBar(null);
    setAskSeed({ id: ++askSeedIdRef.current, quote: bar.text, page: ctx.page, pageText: ctx.pageText });
    openPanel("ask");
  }, [openPanel]);

  // SelectionBar «Оригинал» (tr-selections; also O / Enter / palette): replay
  // the originals captured at selection time in the popover — noTranslate, the
  // text IS the answer; same look as Alt+click's «Оригинал» on a trPage block.
  // The palette passes its own snapshot (its input collapses the selection and
  // clears selBar before its commands run); every other caller uses the live bar.
  const peekOriginal = useCallback((bar?: SelBarState | null) => {
    const b = bar ?? selBarRef.current;
    if (!b?.orig) return;
    // the LIVE bar has travelled with the page since the selection was made —
    // answer where the bar is now; the palette's dead snapshot keeps its own
    setSelBar(null);
    setPop({ anchor: bar ? b.anchor : selAnchorRef.current, text: b.orig, label: t("tb.original"), noTranslate: true });
  }, []);

  // «Перевести» off the live selection bar — its button, ⏎ and the context menu
  // all land here, so one place decides where the popover opens
  const translateSelection = useCallback(() => {
    const b = selBarRef.current;
    if (!b || b.orig) return;
    setSelBar(null);
    setPop({ ...b, anchor: selAnchorRef.current });
  }, []);

  // Ctrl+F: open (or refocus) the find bar — books only
  const openFind = useCallback(() => {
    if (!pathRef.current) return;
    setFindSeed(null); // plain open never re-applies a stale palette seed
    setFindOpen(true);
    setFindNonce((n) => n + 1);
  }, []);

  // Ctrl+K и бейдж «Ctrl K» в пилюле — один вход в палитру (WP-N)
  const togglePalette = useCallback(() => {
    setZoomOpen(false);
    setShortcutsOpen(false);
    setPaletteSel(selBarRef.current); // before the input focus kills the bar
    setPaletteOpen((o) => !o);
  }, []);

  // Ctrl+F with a query already in hand — палитра и контекстное меню
  const findSeeded = useCallback((q: string) => {
    if (!pathRef.current) return;
    setFindSeed({ q, n: ++findSeedRef.current });
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

  // zoom-preset flyout: click outside closes (the one flyout the pill still has)
  useEffect(() => {
    if (!zoomOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-zoommenu]")) setZoomOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [zoomOpen]);

  // per-book view mode, persisted; default = original
  const setView = useCallback((m: ViewMode) => {
    setViewMode(m);
    if (pathRef.current) localStorage.setItem(`pdfer:view:${pathRef.current}`, m);
  }, []);

  const toggleView = useCallback(() => {
    if (!docRef.current) return;
    if (!trAvailRef.current) {
      // T с нечем переключать: вместо тоста «книга не переведена» открываем
      // вкладку, где эта же причина стоит рядом с глаголом (WP-N)
      openPanel("translate");
      return;
    }
    setView(viewModeRef.current === "tr" ? "orig" : "tr");
  }, [openPanel, setView]);

  // One-button whole-book translation. The run itself lives in booktranslate's
  // path-keyed manager (Р-6): it opens its own doc, keeps going when the book
  // is closed or another one is opened, and pause = stopRun (per-page store
  // persistence makes resume free — donePages are skipped). Concurrency 3 of
  // the server's 4 slots — selection translate stays responsive on the spare.
  // Gated: a run only ever starts against a live model. "starting" is waited
  // out (auto-start on ready), "none"/"dead" surface the reason instead of
  // fake-succeeding (WP-B routes these into the model-setup flow), and a book
  // with no text layer never starts a run at all.
  // update === true routes into «Update the translation» (incremental re-clustering,
  // booktranslate.updateBookTranslation) instead of a translation run; the
  // model gate is shared — an update may need the wire for changed paragraphs
  // (WP-N) Прогон не начался (книга не переоткрылась): причина печатается
  // строкой в карточке вкладки «Перевод», рядом с глаголом «Повторить» —
  // тоста для неё больше нет. Держится до следующей попытки.
  const [startError, setStartError] = useState(false);
  const startTr = useCallback(async (update?: boolean) => {
    if (!doc || !path || booktranslate.getRun(path) || trWaitRef.current) return;
    setStartError(false);
    if ((await hasTextProbeRef.current) === false) {
      // скан: отказ печатает карточка вкладки «Перевод», а не тост — статус
      // стоит там, где живёт действие (WP-N)
      if (pathRef.current === path) openPanel("translate");
      return;
    }
    if (pathRef.current !== path || booktranslate.getRun(path)) return; // book changed during the probe
    // (WP-N) ожидание «Модель запускается» печатает строка модели в карточке
    // вкладки «Перевод» — статус стоит там, где живёт действие. Отсюда каждый
    // опрос кладётся в modelStatus сразу, не дожидаясь фонового поллинга
    let status = await fetchModelStatus();
    setModelStatus(status);
    if (status === "starting") {
      trWaitRef.current = true;
      try {
        while (status === "starting") {
          await new Promise((r) => setTimeout(r, 2000));
          if (pathRef.current !== path || booktranslate.getRun(path)) return;
          status = await fetchModelStatus();
          setModelStatus(status);
        }
      } finally {
        trWaitRef.current = false;
      }
    }
    if (pathRef.current !== path || booktranslate.getRun(path)) return;
    if (status !== "spawned" && status !== "external") {
      // none/dead: no honest run possible — route into the model setup flow
      // (license + download / «Перезапустить») instead of a dead-end toast
      setSetupOpen(true);
      return;
    }
    // rejects only when the book file cannot be re-opened for the run's doc.
    // (WP-N) Тоста здесь больше нет: место этой строки — карточка вкладки
    // «Перевод», рядом с глаголом «Повторить» (startError → TranslatePanel).
    (update === true ? booktranslate.updateBookTranslation(path) : booktranslate.startRun(path)).catch((e) => {
      console.error("run start failed", e);
      if (pathRef.current === path) setStartError(true);
    });
  }, [doc, path, openPanel]);

  // «Проверить модель» на паузе (WP-N): спросить состояние заново и, если
  // модель так и не поднялась, открыть тот же вход, что и в отказе запуска
  const checkModel = useCallback(async () => {
    const s = await fetchModelStatus();
    setModelStatus(s);
    if (s !== "starting" && !statusUp(s)) setSetupOpen(true);
  }, []);

  // «Перевести заново» (вкладка «Перевод»): drop the store, restart from page 1
  const retranslate = useCallback(async () => {
    if (!path) return;
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
      // never let this throw: Tauri prevents the native close while a
      // close-requested listener exists and only closes the window from this
      // handler's continuation, so a rejection here would strand the X
      un = getCurrentWindow().onCloseRequested(() => {
        try {
          savePos();
        } catch {
          // full localStorage quota — losing the last scroll beats not closing
        }
      });
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
    histRef.current = { back: [], fwd: [] }; // jump history is per book
    setAskSeed(null); // a stale seed must not leak into the next book's panel
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
    setFitMode(null); // the saved numeric scale wins over a stale fit preset
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
    await loadBytes(bytes, p, p.split(/[\\/]/).pop() ?? "Chitallo");
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

  // (WP-N) Отказ печатает та карточка, по которой щёлкнули: промис долетает до
  // библиотеки отклонённым — она держит спиннер до конца загрузки и сама
  // помечает книгу, которая не открылась. Тоста здесь больше нет; входы без
  // карточки (Ctrl+O, палитра, контекстное меню) гасят отказ явным .catch.
  const openPath = useCallback(
    (p: string) =>
      loadFile(p).catch((e) => {
        console.error("open failed", e);
        throw e;
      }),
    [loadFile],
  );

  // те самые входы без карточки: жаловаться некуда, отказ уже в консоли
  const openPathQuiet = useCallback((p: string) => void openPath(p).catch(() => {}), [openPath]);

  const openDialog = useCallback(async () => {
    const p = await open({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (typeof p === "string") openPathQuiet(p);
  }, [openPathQuiet]);

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
      loadFile(last).catch((e) => {
        // the book moved/vanished since last session: забываем её и открываем
        // библиотеку — она и есть ответ, тост поверх неё сказал бы то же (WP-N)
        localStorage.removeItem("pdfer:last");
        console.error("last book gone", e);
      });
  }, [loadFile, loadBytes]);

  const zoomTo = useCallback(
    (next: number, opts?: { at?: { x: number; y: number }; fit?: FitMode }) => {
      // a plain zoom leaves fit mode; «По ширине»/«Страница целиком» pass
      // their mode through to stay sticky across resizes (before the equal-
      // scale early return: re-picking the preset must still arm the mode)
      setFitMode(opts?.fit ?? null);
      const clamped = Math.min(4, Math.max(0.5, next));
      const prev = scaleRef.current;
      if (clamped === prev) return;
      const el = scrollRef.current;
      // anchor by the page under `at` (viewport coords — Ctrl+wheel passes the
      // cursor; default is the container's top-left, i.e. the old row-top
      // behavior): in "auto" mode the column count can change with scale, so
      // a linear scrollTop rescale drifts
      const rect = el?.getBoundingClientRect();
      const py = opts?.at && rect ? opts.at.y - rect.top : 0;
      const px = opts?.at && rect ? opts.at.x - rect.left : 0;
      const contentY = (el?.scrollTop ?? 0) + py;
      const contentX = (el?.scrollLeft ?? 0) + px;
      let anchor: HTMLElement | null = null;
      if (el) {
        for (const c of el.querySelectorAll<HTMLElement>("[data-page]"))
          if (c.offsetTop <= contentY && (!anchor || c.offsetTop > anchor.offsetTop)) anchor = c;
        if (anchor && opts?.at) {
          // within that row, the page nearest the cursor horizontally — the
          // row's first page would anchor X a whole column off
          let bestD = Infinity;
          for (const c of el.querySelectorAll<HTMLElement>("[data-page]")) {
            if (c.offsetTop !== anchor.offsetTop) continue;
            const d = Math.max(c.offsetLeft - contentX, contentX - c.offsetLeft - c.offsetWidth, 0);
            if (d < bestD) { bestD = d; anchor = c; }
          }
        }
      }
      const a = anchor;
      const fracY = a ? (contentY - a.offsetTop) / Math.max(1, a.offsetHeight) : 0;
      const fracX = a ? (contentX - a.offsetLeft) / Math.max(1, a.offsetWidth) : 0;
      // flushSync: the anchor's fresh offsets must be read from the committed
      // re-layout — rAF timing is NOT guaranteed to follow the async commit
      // (a stale read reproduces the old scrollTop and the view drifts)
      flushSync(() => setScale(clamped));
      if (el) {
        el.scrollTop = a ? a.offsetTop + fracY * a.offsetHeight - py : (contentY * clamped) / prev - py;
        // X only matters for cursor-anchored zoom (h-overflow at high zoom);
        // the browser clamps when the content fits
        if (a && opts?.at) el.scrollLeft = a.offsetLeft + fracX * a.offsetWidth - px;
        savePos();
      }
    },
    [savePos],
  );

  // fit scale from the live geometry. Column count: fixed modes as chosen;
  // «авто» keeps the count it currently shows (the resulting scale re-yields
  // the same count under the packing rule, so the pair is stable)
  const fitScaleFor = useCallback(
    (mode: FitMode): number | null => {
      if (!baseSize) return null;
      // live clientWidth/clientHeight, not the memoized viewport state: the
      // state is re-measured only on resize/panel changes, and a transient
      // horizontal scrollbar (overflow at the pre-fit zoom) would otherwise
      // keep shaving ~15px off clientHeight long after it's gone.
      // viewportW/viewportH stay in the deps so the sticky-fit effect still
      // recomputes on resize/panel changes
      const vw = scrollRef.current?.clientWidth ?? viewportW;
      const vh = scrollRef.current?.clientHeight ?? viewportH;
      const n = Math.max(
        1,
        Math.min(
          cols === "auto" ? Math.floor(vw / (baseSize.w * scaleRef.current + PAGE_GAP)) || 1 : cols,
          docRef.current?.numPages ?? 1,
        ),
      );
      // PAGE_GAP of air on both sides; in «авто» this also keeps
      // floor(vw / (w·scale + gap)) at exactly n
      const fitW = (vw - (n + 1) * PAGE_GAP) / (n * baseSize.w);
      return mode === "width" ? fitW : Math.min(fitW, (vh - 2 * PAGE_GAP) / baseSize.h);
    },
    [baseSize, cols, viewportW, viewportH],
  );

  const applyFit = useCallback(
    (mode: FitMode) => {
      const s = fitScaleFor(mode);
      if (s === null) return;
      zoomTo(s, { fit: mode });
      // the fit may have just removed the horizontal scrollbar, growing
      // clientHeight — zoomTo flushSyncs, so a fresh read sees the final
      // geometry; re-apply once if the fit moved
      const s2 = fitScaleFor(mode);
      if (s2 !== null && Math.abs(s2 - s) > 1e-4) zoomTo(s2, { fit: mode });
    },
    [fitScaleFor, zoomTo],
  );

  // sticky fit: window resizes, the panel and column-mode
  // changes all land in fitScaleFor's inputs — recompute until a manual zoom
  // clears the mode. Deferred via setTimeout: zoomTo flushSyncs, which React
  // rejects when this effect is flushed inside another sync render
  useEffect(() => {
    if (!fitMode || !doc) return;
    const id = window.setTimeout(() => applyFit(fitMode), 0);
    return () => window.clearTimeout(id);
  }, [fitMode, applyFit, doc]);

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
    setZoomOpen(false);
    setFitMode(null);
    setFindOpen(false);
    setFindSeed(null);
    setPaletteOpen(false);
    setShortcutsOpen(false);
    histRef.current = { back: [], fwd: [] };
    setAskSeed(null); // panelOpen itself survives — it's a session preference
    setExportError(null); // отказ экспорта принадлежал закрытой книге
    setStartError(false); // как и отказ запуска прогона
    try {
      getCurrentWindow().setTitle("Chitallo").catch(() => {});
    } catch {
      document.title = "Chitallo";
    }
  }, [savePos]);

  // Граф знаний — не отдельный экран, а вкладка библиотеки, поэтому «открыть
  // граф» это всегда «вернуться в библиотеку и переключить вид». Возврат идёт
  // тем же closeBook, что и кнопка «Библиотека» с Esc: второй путь закрытия
  // книги разошёлся бы с первым на первой же правке (позиция не сохранилась
  // бы, заголовок окна остался бы от закрытой книги).
  //
  // Ключ пишем ДО закрытия, а событие шлём после: пока открыта книга,
  // библиотека размонтирована и прочтёт выбор из localStorage на свежем
  // монтировании; уже висящая библиотека читает ключ один раз и о смене
  // узнаёт только из события — ровно как «pdfer:libdir» из настроек.
  const openGraph = useCallback(() => {
    localStorage.setItem("pdfer:lib:view", "graph");
    if (pathRef.current) closeBook();
    window.dispatchEvent(new CustomEvent("pdfer:lib:view", { detail: "graph" }));
  }, [closeBook]);

  // (WP-N) При закрытой книге Ctrl+G — переключатель «сетка ⇄ граф»: библиотека
  // уже на экране, и обратной дороги из графа с клавиатуры нет вовсе — пилюля
  // вида есть только у мыши. Над открытой книгой аккорд остаётся односторонним:
  // «показать граф» там значит «уйти с книги», и возвращать второму нажатию
  // нечего. Текущий вид спрашиваем у localStorage: ключ пишут синхронно оба
  // владельца — openGraph выше и Library.chooseView, каждый до своего setView, —
  // поэтому он, а не собственная память App, знает, что сейчас на экране.
  const toggleGraph = useCallback(() => {
    if (pathRef.current || localStorage.getItem("pdfer:lib:view") !== "graph") return void openGraph();
    localStorage.setItem("pdfer:lib:view", "grid");
    window.dispatchEvent(new CustomEvent("pdfer:lib:view", { detail: "grid" }));
  }, [openGraph]);

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

  // Экспорт перевода (WP-L, Р-9 + PDF): ОДИН клик — файл сразу в «Загрузки»,
  // без диалога; кропы фигур собираются из собственного рендера, прогресс идёт
  // в тост, финал — «Сохранено в Загрузки» с кнопкой «Открыть» (файл
  // подсвечивается в Проводнике). PDF — главный путь (печать скрытым окном
  // WebView2, print_html_to_pdf), HTML — второй, TXT — третий из Настроек,
  // прежний диалог сохранения.
  const exportBusyRef = useRef(false);
  // PDF-экспорт на большой книге живёт минуты (рендер кропов + печать) — на
  // это время строка вкладки «Экспортировать в PDF» становится спиннером
  // «Подготовка PDF…»: эффект клика виден ровно там, где кликнули
  const [pdfBusy, setPdfBusy] = useState(false);
  // (WP-N) отказ экспорта печатается строкой в панели, на месте самого
  // действия, и держится до следующей попытки — тоста об ошибке больше нет
  const [exportError, setExportError] = useState<TrExportError | null>(null);
  const exportTitle = useCallback(() => {
    const p = pathRef.current!;
    const file = baseName(p).replace(/\.pdf$/i, "") || t("tr.untitled");
    try {
      const idx = JSON.parse(localStorage.getItem("pdfer:books") ?? "{}") as Record<string, { title?: string }>;
      return (idx[p]?.title ?? "").trim() || file;
    } catch {
      return file; // no index — the file name stands
    }
  }, []);
  // (WP-N) Успех молчит: «Сохранено в Загрузки» — одна из строк, которых в B
  // не осталось. Куда лёг файл, скажет сама строка экспорта в карточке
  // «Перевод», превратившись в «Показать в папке»; отказ печатается там же,
  // строкой exportError. Тоста об экспорте здесь нет ни успешного, ни нет.
  const exportTr = useCallback(async () => {
    const p = pathRef.current;
    if (!p || exportBusyRef.current) return;
    exportBusyRef.current = true;
    setExportError(null);
    try {
      await exportTranslationToDownloads(p, exportTitle());
    } catch (e) {
      console.error("export failed", e);
      setExportError({ kind: "html", reason: exportReason(e) });
    } finally {
      exportBusyRef.current = false;
    }
  }, [exportTitle]);
  const exportPdf = useCallback(async () => {
    const p = pathRef.current;
    if (!p || exportBusyRef.current) return;
    exportBusyRef.current = true;
    setExportError(null);
    setPdfBusy(true);
    try {
      await exportTranslationPdf(p, exportTitle());
    } catch (e) {
      console.error("pdf export failed", e);
      setExportError({ kind: "pdf", reason: exportReason(e) });
    } finally {
      exportBusyRef.current = false;
      setPdfBusy(false);
    }
  }, [exportTitle]);
  const exportTxt = useCallback(async () => {
    const p = pathRef.current;
    if (!p || exportBusyRef.current) return;
    exportBusyRef.current = true;
    setExportError(null);
    try {
      await exportTranslationTxt(p, exportTitle());
    } catch (e) {
      console.error("export failed", e);
      setExportError({ kind: "html", reason: exportReason(e) });
    } finally {
      exportBusyRef.current = false;
    }
  }, [exportTitle]);

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

  // viewport size for "auto" columns and the fit presets (clientWidth
  // excludes the scrollbar); panelOpen is a dep — the panel changes the
  // reading width with no resize event
  useEffect(() => {
    const measure = () => {
      setViewportW(scrollRef.current?.clientWidth ?? window.innerWidth);
      setViewportH(scrollRef.current?.clientHeight ?? window.innerHeight);
    };
    measure();
    let t: number | undefined;
    const onResize = () => { clearTimeout(t); t = window.setTimeout(measure, 150); };
    window.addEventListener("resize", onResize);
    return () => { clearTimeout(t); window.removeEventListener("resize", onResize); };
  }, [doc, panelOpen, panelW]);

  // «Добавить в глоссарий»: термин ложится в список книги ГОЛОЙ СТРОКОЙ, и
  // вкладка «Термины» открывается на нём.
  //
  // Раньше сюда писалось `${term} = ?`: строка без разделителя считалась
  // мусором, поэтому термину придумывали пустой перевод, а этот же «?» потом
  // приходилось отдельно не пускать в промпт. Теперь голый термин — полная и
  // законная запись (glossary.ts), и заглушка не нужна вовсе.
  //
  // Проверка на повтор идёт через ОБЩИЙ разборщик. Здесь жила третья, ни к
  // чему не привязанная запись грамматики (split по /=|->|→|—/), и она
  // расходилась с обоими настоящими: «std::vector» она резала не там, а «C++»
  // и «C#» считала разными терминами — termKey сворачивает их в один ключ, и
  // именно этим ключом запись живёт в сайдкаре.
  //
  // Через разборщик идёт И ВХОДЯЩАЯ сторона, и это не педантизм. Строка
  // уходит в файл, а из файла её читает тот же разборщик — и режет по первому
  // разделителю, включая унаследованное «—», которое в русском тексте просто
  // тире. Выделение «Инвертированный индекс — структура данных» ложилось в
  // файл, читалось обратно как термин «Инвертированный индекс», и ключ,
  // посчитанный от ВСЕЙ фразы, с ним не совпадал: проверка на повтор не
  // срабатывала никогда (одинаковая строка дописывалась на каждое добавление),
  // а запись сайдкара уходила на ключ, которого в файле нет, — то есть
  // source: "user" не получался вовсе. Поэтому выделение СНАЧАЛА разбирается,
  // и дальше живёт разобранная запись: она же идёт в файл, она же даёт ключ.
  // Из выделенного при этом не теряется ничего — хвост фразы становится полем
  // записи, видимым и правимым во вкладке. Строка, в которой разборщик термина
  // не видит вовсе (выделили «###» или одну пунктуацию), не пишется: вкладка
  // просто откроется.
  //
  // Пишем через saveGlossary, а не сырым saveGlossaryText: так у строки
  // появляется source: "user", а это ровно то, что запрещает третьему проходу
  // когда-либо свести её в чужой синоним. О самой записи вкладка узнаёт от
  // хранилища (translate.subscribeGlossary), а не от App: пишущих в файл
  // больше двух (ещё глубокий проход графа), и отдельный канал «App сказал
  // панели перечитать» учит думать, что их двое.
  const addToGlossary = useCallback(
    (term: string) => {
      const p = pathRef.current;
      const flat = term.replace(/\s+/g, " ").trim();
      if (!p) return;
      const rec = flat ? parseGlossaryLine(flat) : null;
      if (rec) {
        const key = termKey(rec.term);
        const dup = parseGlossaryText(loadGlossaryText(p)).some((r) => termKey(r.term) === key);
        // Повторное добавление — не действие, а просто открытие списка: писать
        // заново значило бы переписать сайдкар и переклеить чужой source.
        if (!dup)
          void glossarygen
            .saveGlossary(p, [{ ...rec, source: "user" }])
            .catch((e) => console.error("glossary add failed", e));
      }
      openPanel("glossary");
    },
    [openPanel],
  );

  // копирование молчит в обе стороны (§4.5, Voice): успех обратимого действия
  // не сообщается, а отказ буфера читателю нечем исправить
  const copyText = useCallback((text: string) => {
    void copyToClipboard(text).then((ok) => {
      if (!ok) console.warn("clipboard write refused");
    });
  }, []);

  // ---- right click: our own menu instead of the platform webview's ---------
  //
  // One document-level listener, three outcomes (see the table in
  // ContextMenu.tsx):
  //  - inside a text field we do NOT interfere: cut/paste, undo, spellcheck and
  //    IME candidates honestly live only in the system menu;
  //  - in the book, on a library card, or over any selection — our own menu;
  //  - anywhere else in the chrome — preventDefault and NOTHING: «Reload»,
  //    «Save as…» and «Inspect» make no sense in a reader.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (isTextField(el)) return; // the system menu stands
      // right click ON the open menu: suppress the system one and leave —
      // otherwise the menu would rebuild under the cursor and lose items (the
      // target is outside scrollRef, i.e. inReader === false)
      if (el?.closest("[data-ctxmenu]")) {
        e.preventDefault();
        return;
      }
      e.preventDefault();

      // A keyboard invocation (Shift+F10 / the Menu key) arrives as the same
      // event but with button 0 and no meaningful coordinates — aim at the end
      // of the selection, else at the focused element.
      const byKey = e.button !== 2;
      // «in the book» is the only area where the page items and find-selection
      // belong: a quote from an «Ask» answer is a paraphrase, and searching the
      // book for it would promise a result that cannot exist
      const inReader = !!(el && scrollRef.current?.contains(el));
      const s = document.getSelection();
      const selText = s && !s.isCollapsed ? normalizeSelText(s.toString()) : "";
      const rects = s && !s.isCollapsed && s.rangeCount ? s.getRangeAt(0).getClientRects() : null;
      const lastRect = rects?.length ? rects[rects.length - 1] : null;
      let at: Anchor = { x: e.clientX, y: e.clientY };
      if (byKey) {
        const fb = (document.activeElement as HTMLElement | null)?.getBoundingClientRect();
        at = lastRect
          ? { x: lastRect.right, y: lastRect.bottom + 4 }
          : fb && (fb.width || fb.height)
            ? { x: fb.left, y: fb.bottom + 4 }
            : { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) };
      }

      const items: CtxItem[] = [];

      // ---- library card ----
      const card = el?.closest<HTMLElement>("[data-book][data-path]");
      if (card) {
        const p = card.dataset.path!;
        items.push(
          { id: "open", label: t("ui.open"), run: () => openPathQuiet(p) },
          {
            id: "reveal",
            label: t("ctx.revealInFolder"),
            // отказ проводника — единственное, о чём нечем сказать на месте:
            // меню к этому времени закрыто. Тост остаётся, но с глаголом-
            // выходом рядом — иначе это сообщение в никуда (WP-N)
            run: () => void reveal(p),
          },
        );
        // Export is deliberately absent here: whether THIS book has a finished
        // translation is only known after an async read of the store — the item
        // would either lie, or appear under the cursor after the menu opened.
        setCtxMenu({ at, items, keyboard: byKey });
        return;
      }

      // ---- selection ----
      // A right click outside the selection collapses it before this event
      // fires, so a live selection here is already the right answer; the
      // selection bar (whose payload carries the originals) is only good while
      // that text is still in place.
      const bar = selText ? selBarRef.current : null;
      if (bar) {
        if (bar.orig) items.push({ id: "orig", label: t("tb.original"), hint: "O", run: () => peekOriginal() });
        // «Translate» and «Add to the glossary» are missing over a translation
        // on purpose: the selected text is already in the reader's language, so
        // the term would be entered in the wrong one — the glossary's records
        // are keyed on the surface form the BOOK uses (the same honest choice
        // the selection bar makes)
        else items.push({ id: "tr", label: t("sel.translate"), hint: "⏎", run: translateSelection });
        items.push({ id: "ask", label: t("tb.ask"), run: askFromSelection });
      }
      if (selText) {
        items.push({ id: "copy", label: t("ui.copy"), hint: "Ctrl+C", run: () => copyText(selText) });
        if (inReader && path)
          items.push({ id: "find", label: t("cmd.find"), hint: "Ctrl+F", run: () => findSeeded(selText) });
        // a term, not a paragraph: the glossary is a list of the book's terms,
        // and half a page of prose is meaningless in it
        if (bar && !bar.orig && selText.length <= 60 && selText.split(" ").length <= 6)
          items.push({ id: "gloss", label: t("ctx.addToGlossary"), run: () => addToGlossary(selText) });
      }

      // ---- link under the cursor ----
      const link = el?.closest<HTMLAnchorElement>("a[href]");
      const href = link?.href ?? "";
      if (!selText && /^https?:/i.test(href)) {
        items.push(
          { id: "openurl", label: t("ctx.openInBrowser"), run: () => void openUrl(href).catch(() => {}) },
          { id: "copyurl", label: t("ctx.copyLink"), run: () => copyText(href) },
        );
      }

      // ---- paragraph under the cursor (no selection) ----
      if (!selText && !byKey && el) {
        const block = el.closest(".trPage [data-tridx]");
        const span = !block && el.closest(".textLayer span");
        if (block || span)
          items.push({
            id: "para",
            label: block ? t("ctx.originalPara") : t("ctx.translatePara"),
            hint: `Alt+${t("keys.click")}`,
            run: () => paragraphPopover(el),
          });
      }

      // ---- the page: its own group, but only inside the reading area ----
      // A click on the chrome (toolbar, panel, the empty field around) gets
      // NOTHING: the system menu is suppressed and there is no menu of ours —
      // «Reload» and «Inspect» have no place in a reader, and the page items
      // have no place there. A selection inside an «Ask» answer is not the book
      // either: only «Copy» survives there.
      if (doc && inReader) {
        const page: CtxItem[] = [];
        if (trInfo !== null)
          page.push({
            id: "view",
            label: viewMode === "tr" ? t("cmd.showOriginal") : t("cmd.showTranslation"),
            hint: "T",
            run: toggleView,
          });
        page.push({ id: "toc", label: t("cmd.toc"), run: () => openPanel("outline") });
        if (!selText) page.push({ id: "findplain", label: t("cmd.find"), hint: "Ctrl+F", run: openFind });
        if (page.length) {
          if (items.length) items.push({ sep: true });
          items.push(...page);
        }
      }

      // one popup over the book at a time — the same rule Ctrl+K follows
      if (!items.length) return void setCtxMenu(null);
      setZoomOpen(false);
      setCtxMenu({ at, items, keyboard: byKey });
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, [
    doc,
    path,
    trInfo,
    viewMode,
    openPathQuiet,
    reveal,
    peekOriginal,
    translateSelection,
    askFromSelection,
    copyText,
    findSeeded,
    addToGlossary,
    paragraphPopover,
    toggleView,
    openFind,
    openPanel,
  ]);

  // keyboard: Ctrl+O open, Ctrl +/-/0 zoom, D dark (e.code = layout-independent)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
      // the context menu is the topmost transient layer: while it is up it owns
      // ↑/↓/Home/End/⏎ (ContextMenu's own listener), and only Escape gets
      // through — to the chain below, which peels the menu first
      if (ctxRef.current && e.key !== "Escape") return;
      if (ctrl && e.code === "KeyO") { e.preventDefault(); openDialog(); }
      else if (ctrl && e.code === "KeyF") { e.preventDefault(); openFind(); }
      else if (ctrl && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomTo(scaleRef.current + 0.125); }
      else if (ctrl && e.key === "-") { e.preventDefault(); zoomTo(scaleRef.current - 0.125); }
      else if (ctrl && e.key === "0") { e.preventDefault(); applyFit("width"); }
      else if (ctrl && e.code === "Digit1") { e.preventDefault(); setColsMode(1); }
      else if (ctrl && e.code === "Digit2") { e.preventDefault(); setColsMode(2); }
      else if (ctrl && e.code === "Digit3") { e.preventDefault(); setColsMode("auto"); }
      else if (ctrl && e.code === "KeyJ") { e.preventDefault(); toggleAsk(); }
      // Ctrl+G — граф знаний. Свободный аккорд: «следующее совпадение» в этой
      // читалке висит на ⏎ («Следующее · Enter» в строке поиска), так что
      // привычного Ctrl/⌘+G здесь не у кого отнимать. Голая G не годится:
      // в библиотеке любая одиночная буква с карточки уходит в фильтр
      // (Library.onGridKey), и G открывала бы граф и печаталась одновременно
      else if (ctrl && e.code === "KeyG") { e.preventDefault(); toggleGraph(); }
      // Ctrl+K — command palette (the zoom flyout closes: one floating layer at a time)
      else if (ctrl && e.code === "KeyK") {
        e.preventDefault();
        togglePalette();
      }
      // «?» / Ctrl+/ — every key on one screen
      else if (ctrl && e.code === "Slash") { e.preventDefault(); setPaletteOpen(false); setShortcutsOpen((o) => !o); }
      // Ctrl+, — settings
      else if (ctrl && e.code === "Comma") { e.preventDefault(); setSettingsOpen((o) => !o); }
      else if (!ctrl && !e.altKey && !typing && e.key === "?") { e.preventDefault(); setPaletteOpen(false); setShortcutsOpen((o) => !o); }
      // bare-letter hotkeys stay live while the translation menu is open — it
      // has no text inputs, and T visibly flips the pill's Orig|Translation segment
      else if (!ctrl && !e.altKey && !typing && e.code === "KeyD") toggleDark();
      else if (!ctrl && !e.altKey && !typing && e.code === "KeyT") toggleView();
      // O — the «Original» peek for an active tr-selection (bare letter, like D/T;
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
        // контекстное меню → палитра → шорткаты → «О Chitallo» → настройки → масштаб → модель → перевод → поиск → панель (только при фокусе в ней) → выделение
        // (Esc typed INSIDE the find/page/palette inputs is handled there and never reaches this chain)
        // Контекстное меню снимает себя само (capture на document в
        // ContextMenu.tsx) — иначе Esc из поля поиска до сюда не дошёл бы;
        // ветка ниже остаётся страховкой и держит порядок слоёв на виду.
        const ae = document.activeElement as HTMLElement | null;
        if (ctxRef.current) setCtxMenu(null);
        else if (paletteRef.current) setPaletteOpen(false);
        else if (shortcutsRef.current) setShortcutsOpen(false);
        else if (aboutRef.current) setAboutOpen(false);
        else if (settingsRef.current) setSettingsOpen(false);
        else if (zoomOpenRef.current) setZoomOpen(false);
        else if (setupRef.current) setSetupOpen(false);
        else if (popRef.current) setPop(null);
        else if (findRef.current) setFindOpen(false);
        else if (panelOpenRef.current && ae?.closest("[data-asksb]")) {
          // focus inside the panel: leave the input first; a focused
          // non-input control closes the panel. An unfocused panel is
          // NEVER closed by Esc — the chain falls through to the book.
          // (поле «Оглавления» гасит Esc само: сначала чистит запрос, потом
          // закрывает панель — сюда такой Esc не доходит)
          if (ae.tagName === "TEXTAREA") ae.blur();
          else setPanel(false);
        } else if (selBarRef.current) {
          setSelBar(null);
          document.getSelection()?.removeAllRanges();
        } else closeBook();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDialog, openFind, zoomTo, applyFit, toggleDark, closeBook, toggleGraph, setColsMode, toggleView, toggleAsk, setPanel, togglePalette, histNav, peekOriginal]);

  // Ctrl+wheel zoom, anchored at the cursor (non-passive, to suppress webview
  // page zoom). metaKey too, for Cmd+wheel on macOS — trackpad pinch already
  // arrives as ctrlKey there, so both idioms land on the same handler.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomTo(scaleRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { at: { x: e.clientX, y: e.clientY } });
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
  // run-based percent: an update sweeps a 100%-done store, so donePages-based
  // trPct is a motionless 100% for its whole duration («прогресс-бар
  // потерялся») — the band must mirror the RUN's swept pages instead
  const runPct = run && run.total > 0 ? Math.floor((100 * run.done) / run.total) : 0;
  const bandPct = run?.update ? runPct : trPct;
  // interrupted update watermark (store.updatedThrough mid-update): the idle
  // menu row resumes from here — surface the percentage so the click's effect
  // is legible before AND after the run
  const updPct = trInfo && (trStoreRef.current?.updatedThrough ?? 0) > 0
    ? Math.floor((100 * (trStoreRef.current?.updatedThrough ?? 0)) / Math.max(1, trInfo.total))
    : 0;
  // (WP-N) одно из четырёх состояний карточки вкладки «Перевод». Живой прогон
  // главнее хранилища: он знает и про паузу по недоступной модели (stalled).
  const trState: TrState =
    run !== null
      ? run.stalled
        ? "paused"
        : "running"
      : trInfo === null
        ? "idle"
        : trInfo.done < trInfo.total
          ? "paused"
          : "done";
  // Ctrl+K commands — every action already in the UI, one name each, with its
  // key as the hint (the palette doubles as the cheat-sheet). Built only while
  // the palette is open; a ~20-element array per render is free.
  const paletteCommands: PaletteCommand[] = [];
  if (paletteOpen) {
    if (doc) {
      paletteCommands.push(
        // keywords stay bilingual on purpose: the palette should answer to
        // whichever word comes to mind, not only to the current interface language
        { id: "toc", label: t("cmd.toc"), keywords: "toc contents содержание оглавление страница", run: () => openPanel("outline") },
        { id: "find", label: t("cmd.find"), hint: K("Ctrl+F"), keywords: "поиск найти search find", run: openFind },
      );
      if (trInfo !== null)
        paletteCommands.push({
          id: "view",
          label: viewMode === "tr" ? t("cmd.showOriginal") : t("cmd.showTranslation"),
          hint: "T",
          keywords: "перевод оригинал translation original",
          run: toggleView,
        });
      // tr-selection at palette-open time: the «Original» peek is reachable
      // from the palette too (the palette doubles as the cheat-sheet); it runs
      // off the snapshot — the live bar died with the input's autofocus
      if (paletteSel?.orig)
        paletteCommands.push({
          id: "selorig",
          label: t("cmd.originalSel"),
          hint: "O",
          keywords: "оригинал выделение original selection",
          run: () => peekOriginal(paletteSel),
        });
      // (WP-N) прогон и экспорт жили в меню «Перевод ▾», а оно исчезло: их дом —
      // вкладка «Перевод», и только там видно, чем действие кончилось (проценты,
      // пауза, причина отказа экспорта). Поэтому команда сначала открывает
      // вкладку, а потом действует — иначе результат остался бы за кадром.
      if (trRun)
        paletteCommands.push({
          id: "trpause",
          label: t("cmd.pauseTr"),
          keywords: "пауза pause стоп stop",
          run: () => {
            openPanel("translate");
            if (path) void booktranslate.stopRun(path);
          },
        });
      else if (trInfo === null ? hasText !== false : trInfo.done < trInfo.total)
        paletteCommands.push({
          id: "trstart",
          label: trInfo === null ? t("cmd.translateBook") : t("cmd.resumeTr", { pct: trPct }),
          keywords: "translate перевод книга book",
          run: () => {
            openPanel("translate");
            void startTr();
          },
        });
      if (trInfo !== null && trInfo.done > 0)
        paletteCommands.push(
          ...(host().pdfExport
            ? [
                {
                  id: "exportpdf",
                  label: t("tr.exportPdf"),
                  keywords: "экспорт сохранить export pdf печать print загрузки downloads",
                  run: () => {
                    openPanel("translate");
                    void exportPdf();
                  },
                },
              ]
            : []),
          {
            id: "export",
            label: t("tr.exportHtml"),
            keywords: "экспорт сохранить export html загрузки downloads",
            run: () => {
              openPanel("translate");
              void exportTr();
            },
          },
        );
      paletteCommands.push(
        { id: "gloss", label: t("tr.glossary"), keywords: "термины glossary terms", run: () => openPanel("glossary") },
        { id: "ask", label: t("tb.ask"), hint: K("Ctrl+J"), keywords: "вопрос чат claude ask chat", run: toggleAsk },
        { id: "zin", label: t("cmd.zoomIn"), hint: K("Ctrl +"), keywords: "масштаб zoom", run: () => zoomTo(scaleRef.current + 0.125) },
        { id: "zout", label: t("cmd.zoomOut"), hint: K("Ctrl −"), keywords: "масштаб zoom", run: () => zoomTo(scaleRef.current - 0.125) },
        { id: "zwidth", label: t("tb.fitWidth"), hint: K("Ctrl+0"), keywords: "масштаб zoom ширина fit width", run: () => applyFit("width") },
        { id: "zpage", label: t("tb.fitPage"), keywords: "масштаб zoom страница fit page", run: () => applyFit("page") },
        { id: "c1", label: t("cmd.col1"), hint: K("Ctrl+1"), keywords: "колонки columns", run: () => setColsMode(1) },
        { id: "c2", label: t("cmd.col2"), hint: K("Ctrl+2"), keywords: "колонки columns", run: () => setColsMode(2) },
        { id: "cauto", label: t("cmd.colAuto"), hint: K("Ctrl+3"), keywords: "колонки columns авто auto", run: () => setColsMode("auto") },
        { id: "back", label: t("cmd.histBack"), hint: K("Alt+←"), keywords: "история back", run: () => histNav(-1) },
        { id: "fwd", label: t("cmd.histFwd"), hint: K("Alt+→"), keywords: "история forward", run: () => histNav(1) },
        { id: "lib", label: t("lib.title"), hint: "Esc", keywords: "закрыть library close", run: closeBook },
      );
    }
    paletteCommands.push(
      { id: "open", label: t("cmd.openFile"), hint: K("Ctrl+O"), keywords: "open file pdf открыть", run: openDialog },
      // граф стоит в блоке «без книги» намеренно: он про всю полку сразу, и
      // из открытой книги команда сама вернёт в библиотеку
      // (WP-N) одно имя на одну вещь: «Граф знаний» пишется ключом gr.title
      // здесь, в листе клавиш и в настройках — синонимов у названия нет
      { id: "graph", label: t("gr.title"), hint: K("Ctrl+G"), keywords: "граф знания связи понятия graph knowledge links concepts", run: openGraph },
      { id: "dark", label: dark ? t("cmd.lightTheme") : t("cmd.darkTheme"), hint: "D", keywords: "тема theme dark light", run: toggleDark },
      { id: "keys", label: t("cmd.keys"), hint: "?", keywords: "шорткаты клавиатура shortcuts keyboard помощь help", run: () => setShortcutsOpen(true) },
      { id: "settings", label: t("cmd.settings"), hint: K("Ctrl+,"), keywords: "настройки settings тема размер модели хранилище", run: () => setSettingsOpen(true) },
      { id: "about", label: t("app.about"), keywords: "версия лицензии приватность about version license", run: () => setAboutOpen(true) },
    );
  }

  return (
    /* no transition-colors on the root: the theme switches everywhere in the
       same instant — a lone animated surface reads as a glitch (WP-K) */
    <div
      className={`${dark ? "dark" : ""} h-screen w-screen overflow-hidden bg-neutral-200 dark:bg-neutral-900`}
      // translated type size: every .trPage reads this variable, zoom multiplies it
      style={{ "--tr-font-size": `${trFont}px` } as React.CSSProperties}
    >
      {/* (WP-N) Пилюля — часть читалки. Над библиотекой её нет: открыть файл,
          тему и настройки там держит строка заголовка самой библиотеки, а
          клавиши Ctrl+O · D · Ctrl+, и палитра Ctrl+K работают и без книги */}
      {doc && (
        <div
          className="toolbar fixed top-3 -translate-x-1/2 z-10 flex items-center gap-1 rounded-full bg-white/85 dark:bg-neutral-800/85 backdrop-blur px-3 py-1.5 shadow-lg text-sm text-neutral-700 dark:text-neutral-200 select-none transition-[left] duration-150"
          // stay centered over the READING area: shift by half the panel width
          style={{ left: panelOpen ? `calc(50% - ${panelW / 2}px)` : "50%" }}
        >
          {/* run progress — 2px band along the pill's bottom edge; the pill's
              composition stays constant so it never resizes mid-run (WP-H).
              bandPct, not trPct: an update run's store is already 100% done.
              Акцент, пока идёт; янтарь, когда встало (WP-N) */}
          {trInfo && (trRun || trState === "paused") && (
            <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
              <span
                className={`absolute bottom-0 left-0 h-0.5 transition-[width] duration-300 ${
                  trState === "paused" ? "bg-amber-500" : "bg-accent"
                }`}
                // 2% floor: a run at 0 swept pages must still show a living
                // sliver — a zero-width band reads as «the click did nothing»
                style={{ width: `${Math.max(2, bandPct)}%` }}
              />
            </span>
          )}
          {/* left: library */}
          <button className={`${TB_BTN} px-1`} onClick={closeBook} title={t("tb.libraryEsc")}>
            {t("tb.library")}
          </button>
          {/* the «navigation» group: library + page. Оглавление стало первой
              вкладкой панели, и номер страницы — вход в неё. Width is
              reserved for the widest page number so the pill never shifts
              while scrolling */}
          <button
            className={`${TB_BTN} tabular-nums text-neutral-600 dark:text-neutral-300 hover:text-neutral-800 dark:hover:text-neutral-100 px-1 whitespace-nowrap text-center`}
            style={{ minWidth: `calc(${2 * String(doc.numPages).length + 3}ch + 0.5rem)` }}
            onClick={() => openPanel("outline")}
            title={t("tb.pageOfTitle", { page: curPage, total: doc.numPages })}
          >
            {t("tb.pageOf", { page: curPage, total: doc.numPages })}
          </button>
          <span className="mx-2 h-4 w-px bg-neutral-900/15 dark:bg-neutral-100/20" />
          {/* the «view» group: zoom · columns · theme */}
          <button className={`${TB_BTN} px-1.5`} onClick={() => zoomTo(scale - 0.125)} title={t("tb.zoomOut")}>
            −
          </button>
          <span className="relative" data-zoommenu>
            <button
              className={`${TB_BTN} tabular-nums text-neutral-600 dark:text-neutral-300 hover:text-neutral-800 dark:hover:text-neutral-100 w-11 text-center`}
              onClick={() => setZoomOpen((o) => !o)}
              title={t("tb.zoomPresets")}
            >
              {Math.round(scale * 100)}%
            </button>
            {zoomOpen && (
              <div className="overlay-pop absolute left-1/2 -translate-x-1/2 top-full mt-2.5 z-20 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur shadow-xl p-1.5 text-left">
                {(
                  [
                    ["width", t("tb.fitWidth"), K("Ctrl+0")],
                    ["page", t("tb.fitPage"), null],
                  ] as const
                ).map(([m, label, hint]) => (
                  <button
                    key={m}
                    className={`${MENU_ROW} flex items-baseline justify-between gap-4${fitMode === m ? " text-accent" : ""}`}
                    onClick={() => { setZoomOpen(false); applyFit(m); }}
                  >
                    {label}
                    {hint && <span className="text-xs text-neutral-400 dark:text-neutral-500">{hint}</span>}
                  </button>
                ))}
                <div className="mx-1 my-1 h-px bg-neutral-900/10 dark:bg-neutral-100/10" />
                {[1, 1.25, 1.5, 2].map((s) => (
                  <button
                    key={s}
                    className={`${MENU_ROW} tabular-nums${fitMode === null && Math.round(scale * 100) === s * 100 ? " text-accent" : ""}`}
                    onClick={() => { setZoomOpen(false); zoomTo(s); }}
                  >
                    {s * 100}%
                  </button>
                ))}
              </div>
            )}
          </span>
          <button className={`${TB_BTN} px-1.5`} onClick={() => zoomTo(scale + 0.125)} title={t("tb.zoomIn")}>
            +
          </button>
          <span className="ml-1 flex items-center gap-1">
            {/* active column mode carries the accent — the app's one active color */}
            {([1, 2, "auto"] as const).map((c) => (
              <button
                key={String(c)}
                className={`${TB_BTN} px-1.5 py-0.5 ${cols === c ? "text-accent" : "text-neutral-500 dark:text-neutral-400"}`}
                onClick={() => setColsMode(c)}
                title={c === 1 ? t("tb.col1") : c === 2 ? t("tb.col2") : t("tb.colAuto")}
              >
                <IconColumns n={c === "auto" ? 3 : c} />
              </button>
            ))}
          </span>
          <button
            className={`${TB_BTN} ml-1 px-1 py-0.5`}
            onClick={toggleDark}
            title={dark ? t("tb.light") : t("tb.dark")}
          >
            {dark ? <IconSun /> : <IconMoon />}
          </button>
          <span className="mx-2 h-4 w-px bg-neutral-900/15 dark:bg-neutral-100/20" />
          {/* последняя группа: сегмент «Оригинал | Перевод» (зеркало T —
              вид принадлежит тулбару), вход в палитру и створка панели.
              Прогон, оглавление и «Спросить» уехали во вкладки (WP-N) */}
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
                  title={m === "orig" ? t("tb.originalKey") : t("tb.translationKey")}
                >
                  {m === "orig" ? t("tb.original") : t("tb.translation")}
                </button>
              ))}
            </div>
          )}
          {/* Ctrl K — палитра команд; бейдж-клавиша, а не слово: он
              называет вход и заодно учит клавише */}
          <button
            className={`${TB_BTN} ml-0.5 rounded-md border border-neutral-200 bg-white px-1.5 py-px font-mono text-[10px] text-neutral-400 dark:border-transparent dark:bg-neutral-100/8 dark:text-neutral-500`}
            onClick={togglePalette}
            title={t("tb.palette")}
          >
            {K("Ctrl K")}
          </button>
          {/* створка панели: акцент, пока она открыта */}
          <button
            className={`${TB_BTN} ml-0.5 px-1 py-0.5 ${
              panelOpen ? "text-accent" : "text-neutral-500 dark:text-neutral-400"
            }`}
            onClick={() => setPanel(!panelOpen)}
            title={t("tb.panel")}
          >
            <PanelRightIcon aria-hidden className="inline-block size-3.5 align-[-0.125em]" strokeWidth={1.5} />
          </button>
        </div>
      )}

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
          leftShift={panelOpen ? panelW / 2 : 0}
          onClose={() => setFindOpen(false)}
        />
      )}

      {/* flex row: reading area shrinks when the panel is open — never an overlay */}
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
                  getTrPage={getTrPage}
                  getTrFigs={getTrFigs}
                  getBodyFh={getBodyFh}
                  isRefPage={isRefPage}
                  linkService={linkService}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-w-0 h-full">
            {/* (WP-N) пилюли над библиотекой нет, поэтому её строка заголовка
                держит оба входа, что раньше висели на пилюле: настройки (Ctrl+,)
                и «Открыть файл» (Ctrl+O) — последний единственный доступен мышью
                для книги вне папки библиотеки */}
            <Library
              onOpen={openPath}
              onAbout={() => setAboutOpen(true)}
              onSettings={() => setSettingsOpen(true)}
              onOpenFile={openDialog}
            />
          </div>
        )}
        {/* Панель — последний флекс-ребёнок того же ряда: область чтения
            сжимается, страницу панель не накрывает. Смонтирована, пока открыта
            книга (даже закрытой): поток ответа «Спросить» переживает
            переключения, а вкладка «Перевод» — единственное место, где видно
            прогон. */}
        {doc && path && (
          <Panel
            open={panelOpen}
            tab={panelTab}
            onTab={selectTab}
            onClose={() => setPanel(false)}
            width={panelW}
            onWidth={setPanelW}
            askCount={askCount}
            glossCount={glossaryTerms}
            trPct={trInfo ? bandPct : null}
            trAttention={trState === "paused" || anyStall}
            outline={
              <Outline
                doc={doc}
                page={curPage}
                active={panelOpen && panelTab === "outline"}
                trTitle={trOutlineTitle}
                // прыжок панель не закрывает: оглавление стоит открытым, пока читают
                onJump={goToPage}
                onClose={() => setPanel(false)}
              />
            }
            ask={
              <AskSidebar
                open={panelOpen && panelTab === "ask"}
                bookPath={path}
                bookTitle={baseName(path).replace(/\.pdf$/i, "")}
                page={curPage}
                total={doc.numPages}
                pageText={getAskPageText}
                seed={askSeed}
                onCount={setAskCount}
              />
            }
            glossary={
              <GlossaryPanel
                bookPath={path}
                doc={doc}
                onCount={setGlossaryTerms}
              />
            }
            translate={
              <TranslatePanel
                state={trState}
                done={trInfo?.done ?? 0}
                total={trInfo?.total ?? doc.numPages}
                pct={bandPct}
                eta={trState === "running" ? fmtEta(run?.etaMs) : undefined}
                reason={run?.stalled ? t("tr.modelGone") : undefined}
                noTextLayer={hasText === false}
                updPct={updPct}
                glossaryTerms={glossaryTerms}
                pdfExport={host().pdfExport}
                pdfBusy={pdfBusy}
                exportError={exportError}
                startError={startError}
                modelStatus={modelStatus}
                modelDl={dlMain}
                onStart={() => void startTr()}
                onPause={() => void booktranslate.stopRun(path)}
                onResume={() => void startTr()}
                onUpdate={() => void startTr(true)}
                onRetranslate={() => void retranslate()}
                onCheckModel={checkModel}
                onGlossary={() => openPanel("glossary")}
                onExportPdf={() => void exportPdf()}
                onExportHtml={() => void exportTr()}
                onModelSetup={() => setSetupOpen(true)}
                onModelRestart={() => void restartModel().then(setModelStatus)}
              />
            }
          />
        )}
      </div>

      {selBar && !pop && (
        <SelectionBar
          anchor={selBar.anchor}
          // the bar re-anchors itself off the live selection: it must know the
          // reading area (clip + clamp), report where it ended up (the popover
          // opens there) and hear about layout changes it cannot observe
          scrollerRef={scrollRef}
          liveAnchorRef={selAnchorRef}
          // trVersion belongs here: every page the engine finishes re-typesets
          // the reflow blocks (replaceChildren), which silently collapses a
          // selection inside them — Chromium fires no selectionchange for that,
          // so without this key the bar would hang over dead nodes with a stale
          // payload while the book translates under the reader.
          layoutKey={`${scale}|${nColsEff}|${viewMode}|${trFont}|${panelOpen ? panelW : 0}|${trVersion}`}
          onGone={() => setSelBar(null)}
          // tr-selections swap «Перевести» for «Оригинал» — translating the
          // translation back is nonsense (choice documented in SelectionBar)
          onTranslate={selBar.orig ? undefined : translateSelection}
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
      {setup && <Onboarding onDone={() => setSetup(false)} />}
      {setupOpen && <ModelSetupModal onClose={() => setSetupOpen(false)} />}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {settingsOpen && (
        <SettingsModal
          dark={dark}
          onTheme={setTheme}
          trFont={trFont}
          onTrFont={setTrFontPersist}
          onTranslationsCleared={onTranslationsCleared}
          onExportTxt={doc && trInfo !== null && trInfo.done > 0 ? exportTxt : undefined}
          onRerunSetup={() => {
            resetOnboarding();
            setSettingsOpen(false);
            setSetup(true);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {paletteOpen && (
        <Palette
          commands={paletteCommands}
          numPages={doc?.numPages}
          currentPath={path}
          onOpenBook={openPathQuiet}
          onGoToPage={goToPage}
          onFind={doc ? findSeeded : undefined}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      {ctxMenu && (
        <ContextMenu
          at={ctxMenu.at}
          items={ctxMenu.items}
          keyboard={ctxMenu.keyboard}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {notice && (
        /* z-40 and last in the DOM: the toast reads even over a modal's scrim
           (TXT export from Settings); the palette (z-50) still wins. The toast
           itself passes clicks through — only its action button is live */
        <div
          className="overlay-pop fixed bottom-6 -translate-x-1/2 z-40 rounded-2xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur px-4 py-2 shadow-xl text-sm text-neutral-700 dark:text-neutral-200 select-none pointer-events-none text-center"
          // centered over the READING area, like the toolbar: a nowrap pill at
          // 50% ran under the panel (118 px at a 1100 px window). Width
          // is capped against that same reading area, not the viewport: the panel
          // is draggable, and a viewport-wide cap let a long message run under it.
          style={{
            left: doc && panelOpen ? `calc(50% - ${panelW / 2}px)` : "50%",
            maxWidth: `calc(min(40rem, 100vw - ${doc && panelOpen ? panelW : 0}px - 2rem))`,
          }}
        >
          {notice.msg}
          {notice.action && (
            <button
              className="pointer-events-auto ml-3 font-medium text-neutral-900 dark:text-neutral-50 transition-colors hover:text-neutral-500 dark:hover:text-neutral-300"
              onClick={notice.action.run}
            >
              {notice.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
