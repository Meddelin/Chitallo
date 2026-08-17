// Whole-book background translation engine (local llama-server only).
// Store: <appDataDir>\translations\<djb2(bookPath)>.json. Paragraph coordinates
// are saved at viewport scale 1, so the reading overlay multiplies by the
// current scale. Resume works across app restarts: completed pages are listed
// in donePages and skipped on the next run.
// In plain-browser dev (vite ?test=, no Tauri IPC) the store falls back to
// localStorage so the engine stays testable outside the webview.

import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { clusterParagraphs, hash } from "./paragraphs";
import type { Paragraph } from "./paragraphs";
import { loadGlossaryText, parseGlossary, translate } from "./translate";
import type { GlossaryEntry } from "./translate";

const MODEL = "HY-MT1.5-7B-Q4_K_M";
const CONCURRENCY = 3; // worker count only — actual requests draw from the shared ≤3 budget in translate.ts
const ETA_WINDOW = 5; // moving average over the last N text pages

export type TrParagraph = Paragraph & { tr: string };
export type BookTranslation = {
  version: 1;
  bookPath: string;
  model: string;
  // glossary snapshot at start; later edits do not invalidate the store —
  // re-translating with a new glossary = deleteBookTranslation + fresh start
  glossaryText: string;
  pages: Record<number, TrParagraph[]>;
  donePages: number[];
  total: number;
};
export type BookProgress = { page: number; total: number; donePages: number; etaMs?: number };

// ---- store I/O -------------------------------------------------------------

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const lsKey = (bookPath: string) => `pdfer:booktr:${hash(bookPath)}`;

let dirP: Promise<string> | null = null;
const storeDir = () => (dirP ??= appDataDir().then((d) => `${d}\\translations`));
const storeFile = async (bookPath: string) => `${await storeDir()}\\${hash(bookPath)}.json`;

async function readStore(bookPath: string): Promise<string | null> {
  if (!IS_TAURI) return localStorage.getItem(lsKey(bookPath));
  try {
    return new TextDecoder().decode(await readFile(await storeFile(bookPath)));
  } catch {
    return null; // no store yet
  }
}

// atomic-ish: the whole JSON rewritten in a single write_file call
async function writeStore(st: BookTranslation): Promise<void> {
  const json = JSON.stringify(st);
  if (!IS_TAURI) {
    localStorage.setItem(lsKey(st.bookPath), json);
    return;
  }
  await mkdir(await storeDir(), { recursive: true }).catch(() => {});
  await writeFile(await storeFile(st.bookPath), new TextEncoder().encode(json));
}

export async function loadBookTranslation(bookPath: string): Promise<BookTranslation | null> {
  try {
    const st = JSON.parse((await readStore(bookPath)) ?? "") as BookTranslation;
    return st.version === 1 && st.bookPath === bookPath ? st : null;
  } catch {
    return null;
  }
}

export async function hasBookTranslation(bookPath: string): Promise<boolean> {
  return (await loadBookTranslation(bookPath)) !== null;
}

export async function deleteBookTranslation(bookPath: string): Promise<void> {
  if (!IS_TAURI) {
    localStorage.removeItem(lsKey(bookPath));
    return;
  }
  if ((await readStore(bookPath)) === null) return;
  try {
    await remove(await storeFile(bookPath));
  } catch {
    // fs:allow-remove is not in the capability set yet — truncating the file
    // invalidates the store just as well (loadBookTranslation → null)
    await writeFile(await storeFile(bookPath), new Uint8Array()).catch(() => {});
  }
}

// ---- pipeline --------------------------------------------------------------

// one paragraph: retry a failed request once, then give up with "" (the page
// still completes); aborts always propagate so the page is NOT marked done
async function translateRetry(text: string, glossary: GlossaryEntry[], signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await translate(text, glossary, { signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt >= 1) return "";
    }
  }
}

// Translate the whole book page by page, CONCURRENCY paragraphs in flight.
// Pages already in donePages are skipped (resume). Empty-text pages (covers,
// figures-only) count as done immediately. After every completed page the
// store is rewritten on disk, so cancel (AbortSignal) never loses a page.
export async function startBookTranslation(
  doc: PDFDocumentProxy,
  bookPath: string,
  opts: { onProgress?: (p: BookProgress) => void; signal?: AbortSignal; pageLimit?: number } = {},
): Promise<BookTranslation> {
  const { onProgress, signal, pageLimit } = opts;
  const total = doc.numPages;
  const store: BookTranslation = (await loadBookTranslation(bookPath)) ?? {
    version: 1,
    bookPath,
    model: MODEL,
    glossaryText: loadGlossaryText(bookPath),
    pages: {},
    donePages: [],
    total,
  };
  store.total = total;
  const done = new Set(store.donePages);
  const glossary = parseGlossary(store.glossaryText);
  const durations: number[] = [];
  const last = Math.min(total, Math.max(1, pageLimit ?? total));

  for (let n = 1; n <= last; n++) {
    if (signal?.aborted) break;
    if (done.has(n)) continue;

    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const paras = clusterParagraphs(content.items, page.getViewport({ scale: 1 }));

    const t0 = performance.now();
    const out: TrParagraph[] = paras.map((p) => ({ ...p, tr: "" }));
    if (paras.length) {
      let i = 0;
      const worker = async () => {
        for (;;) {
          const k = i++;
          if (k >= paras.length || signal?.aborted) return;
          out[k].tr = await translateRetry(paras[k].text, glossary, signal);
        }
      };
      let aborted = false;
      try {
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      } catch {
        aborted = true; // only aborts reject (translateRetry swallows other errors)
      }
      if (aborted || signal?.aborted) break; // page incomplete — resume redoes it
    }

    store.pages[n] = out;
    done.add(n);
    store.donePages = [...done].sort((a, b) => a - b);
    await writeStore(store);

    if (paras.length) {
      durations.push(performance.now() - t0);
      if (durations.length > ETA_WINDOW) durations.shift();
    }
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : undefined;
    onProgress?.({
      page: n,
      total,
      donePages: done.size,
      etaMs: avg === undefined ? undefined : Math.round(avg * (total - done.size)),
    });
  }
  return store;
}
