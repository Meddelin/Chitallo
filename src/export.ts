// Экспорт перевода (WP-L, Р-9 + PDF): PDF одной кнопкой, HTML вторым, TXT третьим.
// Сборка зеркалит типографику buildTrPage (App.tsx): заголовки по fh/bodyFh,
// висячие отступы списков, капшены не в потоке, дедуп абзацев внутри фигур;
// kind:"furniture" (колонтитулы) не попадает в поток вовсе, страницы из
// store.refPages (библиография — в приложении рендерится оригинал) идут
// честной пометкой, а не мусорным текстом.
//   PDF  — главный путь, БЕЗ диалога: печатный вариант того же документа
//          (buildPrintHtml: типографика в pt, правила разрыва страниц, кропы
//          PNG 2×, refPages — оригинальной страницей-картинкой 1.5×) пишется
//          временным HTML в $APPDATA и уходит скрытому окну WebView2
//          (Rust-команда print_html_to_pdf, A4 портрет, поля 12 мм);
//          результат «<книга> — перевод.pdf» сразу в «Загрузках», временный
//          HTML удаляется в finally. A4 выбран как универсальный печатный
//          формат: кропы масштабируются в процентах от ширины исходной
//          страницы, поэтому пропорции оригинала сохраняются на любом листе.
//   HTML — второй путь, БЕЗ диалога: файл «<книга> — перевод.html» сразу в
//          «Загрузки» (запись туда — осознанное исключение в capabilities,
//          см. default.json), при коллизии имени — « (2)», « (3)», …
//          Автономный документ с ВСТРОЕННЫМИ кропами оригинала (data-URI):
//          фигуры, таблицы/формулы и сбойные абзацы выглядят как в приложении.
//          Страницы с кропами рендерятся офлайн своим PDFDocumentProxy
//          (не зависит от открытого в читалке документа), пустые
//          fig-кандидаты отбрасываются той же пиксельной проверкой, что в
//          drawCrops. Тёмная тема — через prefers-color-scheme.
//   TXT  — третий путь (Настройки), по-прежнему через системный диалог
//          сохранения: плагин dialog добавляет выбранный save()-путь в
//          runtime-scope fs (проверено в tauri-plugin-dialog 2.7.2
//          commands.rs: s.allow_file(&path)), поэтому запись работает и вне
//          $APPDATA/$DOWNLOAD без правки capabilities. Чистый текст: перевод;
//          для непереведённого — честные пометки (оригинал для сбойных
//          абзацев, «[таблица или формула]» для прочего, подпись фигуры в
//          скобках); мгновенная сборка, без рендера.

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { readFile, remove, stat, writeFile } from "@tauri-apps/plugin-fs";
import { appDataDir, downloadDir } from "@tauri-apps/api/path";
import { getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadBookTranslation } from "./booktranslate";
import type { BookTranslation, TrParagraph } from "./booktranslate";
import { splitCitations } from "./cite";
import { FIG_CONTAIN, interArea } from "./paragraphs";
import type { FigureRegion } from "./paragraphs";
import type { Src } from "./crops";
import { CROP_K, blankProbe, blitCrop, cropCanvas, cropSrc, cropViewport, cropWindow, inkProbe, isBlankCrop, releaseCanvas, snapToInk } from "./crops";
import type { CropWindow } from "./crops";

// ---- constants mirrored from App.tsx (private there; keep values in sync) ---
const LIST_RE = /^\s*(?:\(\d{1,3}\)|\d{1,3}[.)]|\(?[a-zа-яё]\)|[•◦▪‣–—])\s/i;
const CROP_PAD = 3; // scale-1 px of original context around paragraph crops
const HEAD_RATIO = 1.15;
const HEAD_CAP = 1.8;
// footnote detection — same tuning as App.tsx buildTrPage (.trFoot)
const FOOT_RE = /^(?:\d{1,3}[.)]\s|[†‡])/;
const FOOT_LBL = /^\d{1,3}[.)]\s/;
const FOOT_FH = 0.92; // fh/bodyFh cap
const FOOT_ZONE = 0.55; // paragraph must START below this fraction of the page height
// Кропы рисуются оконным рендером из crops.ts (CROP_K = 4 device px на пункт
// PDF), а затем передискретизируются под НОСИТЕЛЬ — суперсэмплинг: растр вчетверо
// плотнее, чем нужно выходному пикселю, поэтому мелкий шрифт формул и штрихи
// диаграмм не рассыпаются. Отдавать в документ все 4× бессмысленно: на 838
// страницах это сотни мегабайт data-URI, которые ни экран, ни принтер не
// покажут.
//   печать — 300 dpi на листе A4 (210 мм минус поля 12 мм = 186 мм ширины);
//   экран  — 2 device px на CSS-пиксель кропа (ширина в HTML задана в px).
const PRINT_DPI = 300;
const PRINT_W_IN = 186 / 25.4; // печатная ширина A4-полосы в дюймах
const SCREEN_DPR = 2;
const REF_SCALE = 1.5; // full-page render scale for refPages in the print (PDF) export

type TextItem = { kind: "text"; cls: "p" | "head" | "hang" | "foot"; em?: number; text: string };
type CropItem = {
  kind: "crop";
  x: number;
  y: number;
  w: number;
  h: number;
  fig: boolean;
  caption?: string; // original caption text of a figure region, if recognised
  para?: TrParagraph; // the source paragraph of a non-figure crop
};
type Item = TextItem | CropItem;

// one page of the store → flow items, in reading order (mirrors buildTrPage)
function pageItems(paras: TrParagraph[], figures: readonly FigureRegion[], bodyFh: number): Item[] {
  const items: Item[] = [];
  // page-height stand-in for the FOOT_ZONE check: the store carries no page
  // dims and TXT assembly has no document, so the content bottom serves —
  // it undershoots the real height slightly (zone marginally more permissive;
  // the fh cap and label regex still gate)
  const pageB = Math.max(0, ...paras.map((p) => p.y + p.h), ...figures.map((f) => f.y + f.h));
  const figs = figures.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const capOf = (r: FigureRegion) =>
    paras.find((p) => p.kind === "caption" && interArea(p, r) >= FIG_CONTAIN * p.w * p.h)?.text;
  let fi = 0;
  const flushAbove = (y: number, x: number) => {
    for (; fi < figs.length && (figs[fi].y < y || (figs[fi].y === y && figs[fi].x <= x)); fi++) {
      const f = figs[fi];
      items.push({ kind: "crop", x: f.x, y: f.y, w: f.w, h: f.h, fig: true, caption: capOf(f) });
    }
  };
  for (const p of paras) {
    if (p.kind === "furniture") continue; // колонтитулы — не контент (зеркалит buildTrPage)
    if (p.contOf) continue; // stitched continuation half — flowed on an earlier page
    if (p.kind === "caption") continue; // lives inside its figure region
    if (figures.some((r) => interArea(p, r) >= FIG_CONTAIN * p.w * p.h)) continue; // pixels already in the region
    flushAbove(p.y, p.x);
    if (p.kind === "prose" && p.tr) {
      const ratio = bodyFh > 0 && p.fh > 0 ? p.fh / bodyFh : 1;
      if (ratio >= HEAD_RATIO) items.push({ kind: "text", cls: "head", em: Math.min(HEAD_CAP, ratio), text: p.tr });
      else if (ratio <= FOOT_FH && p.y >= FOOT_ZONE * pageB && FOOT_RE.test(p.text)) {
        // the model drops the printed «N.» label now and then — restore it
        // from the source so the footnote keeps its number (mirrors buildTrPage)
        const lbl = FOOT_LBL.exec(p.text)?.[0];
        const tr = lbl && !/^\s*\d{1,3}[.)]/.test(p.tr) ? lbl + p.tr : p.tr;
        items.push({ kind: "text", cls: "foot", text: tr });
      } else items.push({ kind: "text", cls: LIST_RE.test(p.tr) || LIST_RE.test(p.text) ? "hang" : "p", text: p.tr });
    } else {
      items.push({
        kind: "crop",
        x: p.x - CROP_PAD,
        y: p.y - CROP_PAD,
        w: p.w + 2 * CROP_PAD,
        h: p.h + 2 * CROP_PAD,
        fig: false,
        para: p,
      });
    }
  }
  flushAbove(Infinity, Infinity);
  return items;
}

const gapRu = (a: number, b: number) =>
  a === b ? `страница ${a} не переведена` : `страницы ${a}–${b} не переведены`;

// refPages (библиография): в приложении такая страница рендерится оригиналом;
// в TXT/HTML идёт пометка — полностраничный скрин весил бы мегабайты на
// страницу и не читался бы как текст; PDF-экспорт (печать) встраивает
// оригинальную страницу картинкой (refPageImgHtml), пометка — его fallback
const refRu = (n: number) => `страница ${n} — оригинал без перевода`;

function metaLine(store: BookTranslation): string {
  const done = store.donePages.length;
  const partial = done < store.total ? ` · готово ${done} из ${store.total} страниц` : "";
  return `Машинный перевод EN→RU · pdfer${partial}`;
}

// ---- TXT --------------------------------------------------------------------

export function assembleTxt(store: BookTranslation, title: string): string {
  const lines: string[] = [title, metaLine(store)];
  const done = new Set(store.donePages);
  const refs = new Set(store.refPages);
  let gapStart: number | null = null;
  for (let n = 1; n <= store.total; n++) {
    if (!done.has(n)) {
      gapStart ??= n;
      continue;
    }
    if (gapStart !== null) {
      lines.push("", `[${gapRu(gapStart, n - 1)}]`);
      gapStart = null;
    }
    if (refs.has(n)) {
      // refPage завершена без перевода (все tr "") — вместо сырого оригинала
      lines.push("", `[${refRu(n)}]`);
      continue;
    }
    for (const it of pageItems(store.pages[n] ?? [], store.figures[n] ?? [], store.bodyFh)) {
      if (it.kind === "text") lines.push("", it.text);
      else if (it.fig) {
        // only caption-bearing regions are marked: uncaptioned candidates are
        // frequently blank margins, and TXT has no pixels to verify against
        if (it.caption) lines.push("", `[${it.caption}]`);
      } else if (it.para && it.para.kind !== "prose") lines.push("", "[таблица или формула]");
      else if (it.para) lines.push("", it.para.text); // failed prose: original text
    }
  }
  if (gapStart !== null) lines.push("", `[${gapRu(gapStart, store.total)}]`);
  return lines.join("\n") + "\n";
}

// ---- HTML -------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// перевод абзаца → HTML: ссылки на источники в <span class="cite">, как в
// переверстке на экране (App.tsx setTrText, разбор в cite.ts). Класс один и
// тот же в обоих документах — экранном и печатном; цвет задаёт их CSS.
const escCites = (s: string) =>
  splitCitations(s)
    .map((r) => (r.cite ? `<span class="cite">${esc(r.text)}</span>` : esc(r.text)))
    .join("");

// same document voice as .trPage: Georgia serif, justified, hyphenated Russian
const HTML_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; background: #faf9f7; color: #1c1c1c; }
main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 5rem;
  font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-size: 17px; line-height: 1.55; text-align: justify;
  hyphens: auto; overflow-wrap: break-word; }
h1 { font-size: 1.5em; line-height: 1.25; margin: 0; text-align: left; }
.meta { margin: 0.4em 0 0; color: #78716c; font-size: 0.8em; text-align: left; text-indent: 0; }
p { margin: 0.55em 0 0; text-indent: 1.5em; }
.head { font-weight: 600; line-height: 1.25; text-align: left; text-indent: 0; margin-top: 1.1em; }
.hang { text-indent: -1.4em; padding-left: 1.4em; }
.foot { font-size: 0.85em; text-indent: 0; margin-top: 1.3em; padding-top: 0.6em;
  border-top: 1px solid color-mix(in srgb, currentColor 30%, transparent); }
.foot + .foot { margin-top: 0.45em; padding-top: 0; border-top: 0; }
/* ссылки на источники — тот же приглушённый акцент, что в приложении
   (App.css .trPage .cite): смесь акцента #3b82f6 с цветом текста страницы,
   посчитанная в hex, — документ автономный, переменных темы в нём нет */
.cite { color: #2f5ba3; }
.crop { display: block; margin: 0.9em auto; max-width: 100%; height: auto; }
.pg { margin: 2.4em 0 0; text-align: center; color: #a8a29e; font-size: 0.75em; letter-spacing: 0.08em; user-select: none; }
.gap, .ph { color: #78716c; font-style: italic; text-align: center; text-indent: 0; margin-top: 1.6em; }
@media (prefers-color-scheme: dark) {
  body { background: #1c1917; color: #d8d8d8; }
  .meta, .gap, .ph { color: #a8a29e; }
  .cite { color: #6a9ced; }
  .pg { color: #78716c; }
  .crop { background: #fff; } /* crops are light-page pixels — keep them on white */
}
`;

// Печатная типографика (Экспорт в PDF). Поля даёт print_html_to_pdf (12 мм со
// всех сторон), поэтому body без отступов и без @page (размер листа тоже
// задаёт печать: A4 портрет). Правила разрыва: кропы, сноски и refPages не
// рвутся между страницами, заголовок не отрывается от следующего абзаца.
// Печать всегда светлая — тёмной ветки нет, цвета фиксированы.
const PRINT_CSS = `
:root { color-scheme: light; }
body { margin: 0; background: #fff; color: #111;
  font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-size: 11pt; line-height: 1.5; text-align: justify;
  hyphens: auto; overflow-wrap: break-word; }
h1 { font-size: 1.5em; line-height: 1.25; margin: 0; text-align: left;
  break-after: avoid; page-break-after: avoid; }
.meta { margin: 0.4em 0 0; color: #555; font-size: 0.8em; text-align: left; text-indent: 0; }
p { margin: 0.55em 0 0; text-indent: 1.5em; }
.head { font-weight: 600; line-height: 1.25; text-align: left; text-indent: 0; margin-top: 1.1em;
  break-after: avoid; page-break-after: avoid; break-inside: avoid; page-break-inside: avoid; }
.hang { text-indent: -1.4em; padding-left: 1.4em; }
.foot { font-size: 0.85em; text-indent: 0; margin-top: 1.3em; padding-top: 0.6em;
  border-top: 1px solid #999; break-inside: avoid; page-break-inside: avoid; }
.foot + .foot { margin-top: 0.45em; padding-top: 0; border-top: 0; }
/* ссылки на источники: тот же цвет, что в светлой теме экранных документов;
   print-color-adjust — чтобы печать не «сэкономила» краску на тексте (на
   чёрно-белом принтере цвет ляжет серым, как в оригинальном PDF) */
.cite { color: #2f5ba3; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.crop { display: block; margin: 0.9em auto; max-width: 100%; height: auto;
  break-inside: avoid; page-break-inside: avoid; }
.refpg { display: block; width: 100%; margin: 0.9em 0;
  break-inside: avoid; page-break-inside: avoid; }
.pg { margin: 1.8em 0 0; text-align: center; color: #999; font-size: 0.7em; letter-spacing: 0.08em;
  break-after: avoid; page-break-after: avoid; }
.gap, .ph { color: #555; font-style: italic; text-align: center; text-indent: 0; margin-top: 1.4em; }
`;

// own document for crop rendering — independent of the viewer's lifecycle
// (?test= dev books are URLs, mirrors booktranslate.openRunDoc)
async function openDoc(bookPath: string): Promise<PDFDocumentProxy> {
  const data = /^https?:\/\//i.test(bookPath)
    ? new Uint8Array(await (await fetch(bookPath)).arrayBuffer())
    : await readFile(bookPath);
  return getDocument({
    data,
    cMapUrl: "/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/standard_fonts/",
    wasmUrl: "/wasm/",
    iccUrl: "/iccs/",
  }).promise;
}

// crop the region out of the window render (crops.ts); fig candidates that
// sample blank (same variance check as drawCrops) return null and leave the
// flow entirely. `frac` — доля ширины исходной страницы, которую занимает кроп:
// в печати из неё получается ширина в процентах полосы, на экране — px.
function cropDataUrl(
  off: HTMLCanvasElement,
  win: CropWindow,
  it: CropItem,
  pageW: number,
  probe: CanvasRenderingContext2D,
  png: boolean, // print wants lossless PNG; the screen HTML keeps lighter JPEG
  ink: CanvasRenderingContext2D,
  others: readonly Src[], // the page's other crop rects — see crops.ts snapToInk
): { url: string; frac: number; w: number; px: number } | null {
  let s = cropSrc(win, { x: Math.max(0, it.x), y: Math.max(0, it.y), w: it.w, h: it.h });
  if (s.sw <= 0 || s.sh <= 0) return null;
  if (it.fig && isBlankCrop(probe, off, s.sx, s.sy, s.sw, s.sh)) return null; // blank margin
  // figure rects are geometry and clip the ink that overhangs them — the same
  // snap the app applies on screen, so the two documents stay the same document
  if (it.fig) s = snapToInk(ink, off, win, s, others);
  const frac = Math.min(1, s.sw / win.k / pageW);
  // целевая ширина в пикселях выходной картинки (blitCrop не даст выйти за
  // разрешение растра — вверх не интерполируем)
  const dstW = png ? frac * PRINT_W_IN * PRINT_DPI : (s.sw / win.k) * SCREEN_DPR;
  const c = document.createElement("canvas");
  blitCrop(c, off, s, dstW, (dstW * s.sh) / s.sw);
  const px = c.width;
  const url = png ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.87);
  releaseCanvas(c);
  return { url, frac, w: Math.round(s.sw / win.k), px };
}

// refPage в печати: оригинальная страница целиком, картинкой (1.5×). JPEG, не
// PNG — полностраничный PNG весил бы мегабайты на страницу; текст библиографии
// при 1.5×/0.9 в печати читается. Сбойная страница → null → прежняя пометка.
async function refPageImgHtml(doc: PDFDocumentProxy, n: number): Promise<string | null> {
  try {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: REF_SCALE });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    await page.render({ canvas: c, viewport: vp }).promise;
    page.cleanup();
    return `<img class="refpg" alt="Страница ${n} оригинала" src="${c.toDataURL("image/jpeg", 0.9)}">`;
  } catch {
    return null;
  }
}

// crop item without pixels (no doc / render failure) → honest text fallback
function cropFallbackHtml(it: CropItem): string {
  if (it.fig) return it.caption ? `<p class="ph">[${esc(it.caption)}]</p>` : "";
  if (it.para && it.para.kind !== "prose") return `<p class="ph">[таблица или формула]</p>`;
  return it.para ? `<p>${esc(it.para.text)}</p>` : "";
}

// Общая сборка документа. print=false — экранный HTML (JPEG-кропы в px,
// тёмная тема, пометки вместо refPages); print=true — печатный вариант для
// print_html_to_pdf (PNG-кропы шириной в % от исходной страницы, правила
// разрыва, refPages — страницей-картинкой).
async function assembleDoc(
  store: BookTranslation,
  title: string,
  bookPath: string,
  print: boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const done = new Set(store.donePages);
  const refs = new Set(store.refPages);
  const perPage = new Map<number, Item[]>();
  let needDoc = false;
  for (const n of store.donePages) {
    if (refs.has(n)) continue; // refPage идёт пометкой/картинкой — её кропы не нужны
    const items = pageItems(store.pages[n] ?? [], store.figures[n] ?? [], store.bodyFh);
    perPage.set(n, items);
    if (items.some((i) => i.kind === "crop")) needDoc = true;
  }
  // печать встраивает refPages картинками — документ нужен и без кропов
  if (print && store.donePages.some((n) => refs.has(n))) needDoc = true;

  let doc: PDFDocumentProxy | null = null;
  if (needDoc) doc = await openDoc(bookPath).catch(() => null); // без документа кропы деградируют в пометки

  let probe: CanvasRenderingContext2D | null = null;
  let ink: CanvasRenderingContext2D | null = null;
  const chunks: string[] = [];
  let processed = 0;
  const gapHtml = (a: number, b: number) => {
    const t = gapRu(a, b);
    return `<p class="gap">${esc(t[0].toUpperCase() + t.slice(1))}</p>`;
  };
  try {
    let gapStart: number | null = null;
    for (let n = 1; n <= store.total; n++) {
      if (!done.has(n)) {
        gapStart ??= n;
        continue;
      }
      if (gapStart !== null) {
        chunks.push(gapHtml(gapStart, n - 1));
        gapStart = null;
      }
      if (refs.has(n)) {
        const ref = print && doc ? await refPageImgHtml(doc, n) : null;
        if (ref) chunks.push(`<div class="pg">${n}</div>`, ref);
        else {
          const t = refRu(n);
          chunks.push(`<p class="gap">${esc(t[0].toUpperCase() + t.slice(1))}</p>`);
        }
        onProgress?.(++processed, store.donePages.length);
        continue;
      }
      const items = perPage.get(n) ?? [];
      // page render only when this page actually needs pixels, and only over
      // the band that holds them (crops.ts cropWindow) — на этой книге окно в
      // среднем занимает пятую часть страницы, так что растр вчетверо плотнее
      // прежнего стоит меньше памяти, чем стоил полностраничный 2×
      let off: HTMLCanvasElement | null = null;
      let win: CropWindow | null = null;
      let pageW = 0;
      const cropRects = items.filter((i): i is CropItem => i.kind === "crop");
      if (doc && cropRects.length) {
        try {
          const page = await doc.getPage(n);
          const vp1 = page.getViewport({ scale: 1 });
          pageW = vp1.width;
          win = cropWindow(
            cropRects.map((i) => ({ x: Math.max(0, i.x), y: Math.max(0, i.y), w: i.w, h: i.h })),
            vp1.width,
            vp1.height,
            CROP_K,
          );
          if (win) {
            off = cropCanvas(win);
            await page.render({ canvas: off, viewport: cropViewport(page, win) }).promise;
          }
          page.cleanup();
        } catch {
          off = null; // damaged page — fall back to text markers
        }
      }
      // source rects of every crop on the page, so a figure snapping out to its
      // ink stops at pixels a neighbouring crop already carries (crops.ts)
      const srcs: Src[] = win
        ? cropRects.map((i) => cropSrc(win!, { x: Math.max(0, i.x), y: Math.max(0, i.y), w: i.w, h: i.h }))
        : [];
      const pageChunks: string[] = [];
      for (const it of items) {
        if (it.kind === "text") {
          const cls = it.cls === "p" ? "" : ` class="${it.cls}"`;
          const style = it.cls === "head" && it.em ? ` style="font-size:${it.em.toFixed(3)}em"` : "";
          pageChunks.push(`<p${cls}${style}>${escCites(it.text)}</p>`);
        } else if (off && win) {
          probe ??= blankProbe();
          ink ??= inkProbe();
          const k = cropRects.indexOf(it);
          const crop = cropDataUrl(off, win, it, pageW, probe, print, ink, srcs.slice(0, k).concat(srcs.slice(k + 1)));
          if (crop) {
            const alt = it.fig ? (it.caption ? esc(it.caption) : "Рисунок") : "Фрагмент оригинала";
            // печать: ширина в % от исходной страницы — пропорции оригинала
            // сохраняются на любом листе; экран: прежние px
            const wStyle = print ? `width:${(100 * crop.frac).toFixed(2)}%` : `width:${crop.w}px`;
            pageChunks.push(`<img class="crop" style="${wStyle}" alt="${alt}" src="${crop.url}">`);
          }
          // blank fig candidate: dropped, like in the app
        } else {
          const fb = cropFallbackHtml(it);
          if (fb) pageChunks.push(fb);
        }
      }
      if (off) releaseCanvas(off); // окно страницы — десятки МБ RGBA, не ждём GC
      if (pageChunks.length) chunks.push(`<div class="pg">${n}</div>`, ...pageChunks);
      onProgress?.(++processed, store.donePages.length);
    }
    if (gapStart !== null) chunks.push(gapHtml(gapStart, store.total));
  } finally {
    doc?.loadingTask.destroy().catch(() => {});
  }

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — перевод</title>
<style>${print ? PRINT_CSS : HTML_CSS}</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<p class="meta">${esc(metaLine(store))}</p>
${chunks.join("\n")}
</main>
</body>
</html>
`;
}

export function assembleHtml(
  store: BookTranslation,
  title: string,
  bookPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  return assembleDoc(store, title, bookPath, false, onProgress);
}

/// Печатный вариант того же документа — вход скрытой печати print_html_to_pdf.
export function buildPrintHtml(
  store: BookTranslation,
  title: string,
  bookPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  return assembleDoc(store, title, bookPath, true, onProgress);
}

// ---- entry ------------------------------------------------------------------

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "-").trim() || "перевод";

/// Одна кнопка (волна 3): HTML без диалога — сразу в «Загрузки» ($DOWNLOAD
/// в fs:allow-write-file, см. заметку в capabilities/default.json). Имя
/// «<книга> — перевод.html»; занято (stat успешен) — « (2)», « (3)», …
/// "none" — для книги нет ни одной готовой страницы (меню и так скрывает пункт).
export async function exportTranslationToDownloads(
  bookPath: string,
  title: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ path: string } | "none"> {
  const store = await loadBookTranslation(bookPath);
  if (!store || store.donePages.length === 0) return "none";
  const html = await assembleHtml(store, title, bookPath, onProgress);
  const dir = await downloadDir();
  const base = `${dir}\\${safeName(title)} — перевод`;
  let target = `${base}.html`;
  for (let i = 2; await stat(target).then(() => true, () => false); i++) target = `${base} (${i}).html`;
  await writeFile(target, new TextEncoder().encode(html));
  return { path: target };
}

/// Одна кнопка, главный путь: PDF без диалога — печатный HTML во временный
/// файл $APPDATA (имя с Date.now(): параллельных экспортов нет, но след от
/// упавшего не мешает следующему), скрытая печать print_html_to_pdf (Rust,
/// WebView2 PrintToPdf: A4 портрет, поля 12 мм — умолчания команды), результат
/// «<книга> — перевод.pdf» в «Загрузках», при коллизии — « (2)», « (3)», …
/// Временный HTML удаляется в finally при любом исходе. onProgress покрывает
/// сборку кропов (долгая фаза); сама печать прогресса не даёт — вызывающий
/// держит на это время спиннер. "none" — нет ни одной готовой страницы.
export async function exportTranslationPdf(
  bookPath: string,
  title: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ path: string } | "none"> {
  const store = await loadBookTranslation(bookPath);
  if (!store || store.donePages.length === 0) return "none";
  const html = await buildPrintHtml(store, title, bookPath, onProgress);
  const tmp = `${await appDataDir()}\\pdf-export-${Date.now()}.html`;
  await writeFile(tmp, new TextEncoder().encode(html));
  try {
    const dir = await downloadDir();
    const base = `${dir}\\${safeName(title)} — перевод`;
    let target = `${base}.pdf`;
    for (let i = 2; await stat(target).then(() => true, () => false); i++) target = `${base} (${i}).pdf`;
    await invoke("print_html_to_pdf", { htmlPath: tmp, pdfPath: target });
    return { path: target };
  } finally {
    await remove(tmp).catch(() => {});
  }
}

/// TXT — третий путь (Настройки), прежний системный диалог сохранения.
/// "none" — для книги нет ни одной готовой страницы (кнопка и так скрыта).
export async function exportTranslationTxt(bookPath: string, title: string): Promise<"saved" | "cancelled" | "none"> {
  const store = await loadBookTranslation(bookPath);
  if (!store || store.donePages.length === 0) return "none";
  const target = await save({
    defaultPath: `${safeName(title)} — перевод.txt`,
    filters: [{ name: "Текст", extensions: ["txt"] }],
  });
  if (!target) return "cancelled";
  await writeFile(target, new TextEncoder().encode(assembleTxt(store, title)));
  return "saved";
}
