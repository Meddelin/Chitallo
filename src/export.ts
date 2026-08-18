// Экспорт перевода (WP-L, Р-9): HTML одной кнопкой + TXT вторым путём.
// Сборка зеркалит типографику buildTrPage (App.tsx): заголовки по fh/bodyFh,
// висячие отступы списков, капшены не в потоке, дедуп абзацев внутри фигур;
// kind:"furniture" (колонтитулы) не попадает в поток вовсе, страницы из
// store.refPages (библиография — в приложении рендерится оригинал) идут
// честной пометкой, а не мусорным текстом.
//   HTML — главный путь, БЕЗ диалога: файл «<книга> — перевод.html» сразу в
//          «Загрузки» (запись туда — осознанное исключение в capabilities,
//          см. default.json), при коллизии имени — « (2)», « (3)», …
//          Автономный документ с ВСТРОЕННЫМИ кропами оригинала (data-URI):
//          фигуры, таблицы/формулы и сбойные абзацы выглядят как в приложении.
//          Страницы с кропами рендерятся офлайн своим PDFDocumentProxy
//          (не зависит от открытого в читалке документа), пустые
//          fig-кандидаты отбрасываются той же пиксельной проверкой, что в
//          drawCrops. Тёмная тема — через prefers-color-scheme.
//   TXT  — вторичный путь (Настройки), по-прежнему через системный диалог
//          сохранения: плагин dialog добавляет выбранный save()-путь в
//          runtime-scope fs (проверено в tauri-plugin-dialog 2.7.2
//          commands.rs: s.allow_file(&path)), поэтому запись работает и вне
//          $APPDATA/$DOWNLOAD без правки capabilities. Чистый текст: перевод;
//          для непереведённого — честные пометки (оригинал для сбойных
//          абзацев, «[таблица или формула]» для прочего, подпись фигуры в
//          скобках); мгновенная сборка, без рендера.

import { save } from "@tauri-apps/plugin-dialog";
import { readFile, stat, writeFile } from "@tauri-apps/plugin-fs";
import { downloadDir } from "@tauri-apps/api/path";
import { getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadBookTranslation } from "./booktranslate";
import type { BookTranslation, TrParagraph } from "./booktranslate";
import { FIG_CONTAIN, interArea } from "./paragraphs";
import type { FigureRegion } from "./paragraphs";

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
// blank-candidate pixel check — same tuning as App.tsx drawCrops
const BLANK_VAR = 4;
const BLANK_RANGE = 24;
const SAMPLE = 32;
const EXPORT_SCALE = 2; // offscreen render scale for crops (2× display size)

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
// в экспорт идёт пометка — полностраничный скрин весил бы мегабайты на
// страницу и не читался бы как текст, поэтому пиксели не встраиваются
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
.crop { display: block; margin: 0.9em auto; max-width: 100%; height: auto; }
.pg { margin: 2.4em 0 0; text-align: center; color: #a8a29e; font-size: 0.75em; letter-spacing: 0.08em; user-select: none; }
.gap, .ph { color: #78716c; font-style: italic; text-align: center; text-indent: 0; margin-top: 1.6em; }
@media (prefers-color-scheme: dark) {
  body { background: #1c1917; color: #d8d8d8; }
  .meta, .gap, .ph { color: #a8a29e; }
  .pg { color: #78716c; }
  .crop { background: #fff; } /* crops are light-page pixels — keep them on white */
}
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

// crop the region out of the page render; fig candidates that sample blank
// (same variance check as drawCrops) return null and leave the flow entirely
function cropDataUrl(
  off: HTMLCanvasElement,
  it: CropItem,
  probe: CanvasRenderingContext2D,
): { url: string; w: number } | null {
  const k = EXPORT_SCALE;
  const sx = Math.min(off.width, Math.round(Math.max(0, it.x) * k));
  const sy = Math.min(off.height, Math.round(Math.max(0, it.y) * k));
  const sw = Math.min(off.width - sx, Math.round(it.w * k));
  const sh = Math.min(off.height - sy, Math.round(it.h * k));
  if (sw <= 0 || sh <= 0) return null;
  if (it.fig) {
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
    if (s2 / n - mean * mean < BLANK_VAR && hi - lo < BLANK_RANGE) return null; // blank margin
  }
  const c = document.createElement("canvas");
  c.width = sw;
  c.height = sh;
  c.getContext("2d")!.drawImage(off, sx, sy, sw, sh, 0, 0, sw, sh);
  return { url: c.toDataURL("image/jpeg", 0.87), w: Math.round(sw / k) };
}

// crop item without pixels (no doc / render failure) → honest text fallback
function cropFallbackHtml(it: CropItem): string {
  if (it.fig) return it.caption ? `<p class="ph">[${esc(it.caption)}]</p>` : "";
  if (it.para && it.para.kind !== "prose") return `<p class="ph">[таблица или формула]</p>`;
  return it.para ? `<p>${esc(it.para.text)}</p>` : "";
}

export async function assembleHtml(
  store: BookTranslation,
  title: string,
  bookPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const done = new Set(store.donePages);
  const refs = new Set(store.refPages);
  const perPage = new Map<number, Item[]>();
  let needDoc = false;
  for (const n of store.donePages) {
    if (refs.has(n)) continue; // refPage идёт пометкой — её кропы не нужны
    const items = pageItems(store.pages[n] ?? [], store.figures[n] ?? [], store.bodyFh);
    perPage.set(n, items);
    if (items.some((i) => i.kind === "crop")) needDoc = true;
  }

  let doc: PDFDocumentProxy | null = null;
  if (needDoc) doc = await openDoc(bookPath).catch(() => null); // без документа кропы деградируют в пометки

  let probe: CanvasRenderingContext2D | null = null;
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
        const t = refRu(n);
        chunks.push(`<p class="gap">${esc(t[0].toUpperCase() + t.slice(1))}</p>`);
        onProgress?.(++processed, store.donePages.length);
        continue;
      }
      const items = perPage.get(n) ?? [];
      // page render only when this page actually needs pixels
      let off: HTMLCanvasElement | null = null;
      if (doc && items.some((i) => i.kind === "crop")) {
        try {
          const page = await doc.getPage(n);
          const vp = page.getViewport({ scale: EXPORT_SCALE });
          off = document.createElement("canvas");
          off.width = Math.floor(vp.width);
          off.height = Math.floor(vp.height);
          await page.render({ canvas: off, viewport: vp }).promise;
          page.cleanup();
        } catch {
          off = null; // damaged page — fall back to text markers
        }
      }
      const pageChunks: string[] = [];
      for (const it of items) {
        if (it.kind === "text") {
          const cls = it.cls === "p" ? "" : ` class="${it.cls}"`;
          const style = it.cls === "head" && it.em ? ` style="font-size:${it.em.toFixed(3)}em"` : "";
          pageChunks.push(`<p${cls}${style}>${esc(it.text)}</p>`);
        } else if (off) {
          if (!probe) {
            const c = document.createElement("canvas");
            c.width = SAMPLE;
            c.height = SAMPLE;
            probe = c.getContext("2d", { willReadFrequently: true })!;
          }
          const crop = cropDataUrl(off, it, probe);
          if (crop) {
            const alt = it.fig ? (it.caption ? esc(it.caption) : "Рисунок") : "Фрагмент оригинала";
            pageChunks.push(`<img class="crop" style="width:${crop.w}px" alt="${alt}" src="${crop.url}">`);
          }
          // blank fig candidate: dropped, like in the app
        } else {
          const fb = cropFallbackHtml(it);
          if (fb) pageChunks.push(fb);
        }
      }
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
<style>${HTML_CSS}</style>
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

/// TXT — вторичный путь (Настройки), прежний системный диалог сохранения.
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
