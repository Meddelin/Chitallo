import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, readDir, readFile, stat, watchImmediate, writeFile } from "@tauri-apps/plugin-fs";
import { appDataDir } from "@tauri-apps/api/path";
import * as pdfjs from "pdfjs-dist";
import { ModelSetupCard } from "./ModelSetup";

type Book = {
  path: string;
  name: string;
  title?: string;
  coverUrl?: string;
  progress?: number;
};

type IndexEntry = { mtime: number; title: string; cover: string };

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

async function scanPdfs(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const e of await readDir(dir)) {
    if (e.name.startsWith(".")) continue;
    const p = `${dir}\\${e.name}`;
    if (e.isDirectory) out.push(...(await scanPdfs(p, depth + 1)));
    else if (e.name.toLowerCase().endsWith(".pdf")) out.push(p);
  }
  return out;
}

async function makeCover(path: string, coversDir: string, mtime: number): Promise<IndexEntry> {
  const bytes = await readFile(path);
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 384 / vp1.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvas, viewport: vp }).promise;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.8));
    const cover = blob ? `${hash(path)}.jpg` : "";
    if (blob) await writeFile(`${coversDir}\\${cover}`, new Uint8Array(await blob.arrayBuffer()));
    const title = ((meta?.info as { Title?: string } | undefined)?.Title ?? "").trim();
    return { mtime, title, cover };
  } finally {
    doc.loadingTask.destroy().catch(() => {});
  }
}

export default function Library({ onOpen, onAbout }: { onOpen: (path: string) => void; onAbout?: () => void }) {
  const [dir, setDir] = useState<string | null>(() => localStorage.getItem("pdfer:libdir"));
  const [books, setBooks] = useState<Book[] | null>(null);
  // one-time gesture hint (WP-E): lives above the grid until dismissed, never returns
  const [hintDismissed, setHintDismissed] = useState(() => localStorage.getItem("pdfer:hint:strip") === "1");
  const urlsRef = useRef<string[]>([]);
  const coverUrlsRef = useRef<Map<string, string>>(new Map());
  const genRef = useRef(0);

  const pickDir = useCallback(async () => {
    const d = await open({ directory: true });
    if (typeof d === "string") {
      localStorage.setItem("pdfer:libdir", d);
      setBooks(null);
      setDir(d);
    }
  }, []);

  const rescan = useCallback(async (dir: string) => {
    const gen = ++genRef.current;
    const stale = () => gen !== genRef.current;

    const paths = await scanPdfs(dir).catch(() => [] as string[]);
    if (stale()) return;

    const progressOf = (p: string) => {
      try {
        return (JSON.parse(localStorage.getItem(`pdfer:pos:${p}`) ?? "") as { progress?: number }).progress;
      } catch {
        return undefined;
      }
    };

    const index = JSON.parse(localStorage.getItem("pdfer:books") ?? "{}") as Record<string, IndexEntry>;
    setBooks(
      paths.map((p) => ({
        path: p,
        name: p.split(/[\\/]/).pop()!.replace(/\.pdf$/i, ""),
        title: index[p]?.title || undefined,
        coverUrl: coverUrlsRef.current.get(p),
        progress: progressOf(p),
      })),
    );

    const coversDir = `${await appDataDir()}\\covers`;
    await mkdir(coversDir, { recursive: true }).catch(() => {});

    // covers: cached from disk, missing/outdated ones generated one by one
    for (const p of paths) {
      if (stale()) return;
      const mtime = (await stat(p).catch(() => null))?.mtime?.getTime() ?? 0;
      let entry = index[p];
      if (!entry || entry.mtime !== mtime) {
        try {
          entry = await makeCover(p, coversDir, mtime);
        } catch {
          entry = { mtime, title: "", cover: "" };
        }
        index[p] = entry;
        localStorage.setItem("pdfer:books", JSON.stringify(index));
      } else if (coverUrlsRef.current.has(p)) {
        continue; // unchanged and already on screen
      }
      if (stale()) return;
      if (entry.cover) {
        try {
          const bytes = await readFile(`${coversDir}\\${entry.cover}`);
          if (stale()) return;
          const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
          urlsRef.current.push(url);
          coverUrlsRef.current.set(p, url);
          const title = entry.title;
          setBooks((bs) => bs?.map((b) => (b.path === p ? { ...b, coverUrl: url, title: title || b.title } : b)) ?? bs);
        } catch {
          // cover unreadable — placeholder stays
        }
      }
    }
  }, []);

  useEffect(() => {
    if (!dir) return;
    void rescan(dir);

    // live watch: rescan ~500ms after the last fs event in the library folder
    let disposed = false;
    let unwatch: (() => void) | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    watchImmediate(
      dir,
      () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => void rescan(dir), 500);
      },
      { recursive: true },
    )
      .then((fn) => {
        if (disposed) fn();
        else unwatch = fn;
      })
      .catch(() => {}); // watch unavailable — focus fallback below still rescans

    // fallback: rescan on window focus, at most once per 2s
    let lastFocus = Date.now();
    const onFocus = () => {
      if (Date.now() - lastFocus < 2000) return;
      lastFocus = Date.now();
      void rescan(dir);
    };
    window.addEventListener("focus", onFocus);

    return () => {
      disposed = true;
      genRef.current++;
      clearTimeout(debounce);
      unwatch?.();
      window.removeEventListener("focus", onFocus);
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlsRef.current = [];
      coverUrlsRef.current.clear();
    };
  }, [dir, rescan]);

  if (!dir) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-neutral-500 dark:text-neutral-400">
        <button
          className="text-lg px-6 py-3 rounded-xl border border-neutral-300 dark:border-neutral-700 hover:bg-white dark:hover:bg-neutral-800 transition-colors"
          onClick={pickDir}
        >
          Выбрать папку с книгами
        </button>
        <span className="text-sm opacity-60">Сканируются папка и подпапки</span>
        {/* тихий онбординг (Р-2): модель перевода предлагается прямо в пустом
            состоянии — скачивание по явному действию, с лицензией на виду */}
        <div className="mt-5">
          <ModelSetupCard />
        </div>
        {onAbout && (
          <button className="mt-2 text-xs opacity-40 hover:opacity-70 transition-opacity" onClick={onAbout}>
            О pdfer
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 pt-16 pb-10">
        <div className="flex items-baseline justify-between mb-6 text-neutral-800 dark:text-neutral-200">
          <h1 className="text-xl font-medium">Библиотека</h1>
          <span className="flex items-baseline gap-4">
            {onAbout && (
              <button className="text-sm opacity-50 hover:opacity-100 transition-opacity" onClick={onAbout}>
                О pdfer
              </button>
            )}
            <button className="text-sm opacity-50 hover:opacity-100 transition-opacity" onClick={pickDir} title={dir}>
              Сменить папку
            </button>
          </span>
        </div>
        {!hintDismissed && books !== null && books.length > 0 && (
          <div className="mb-6 flex items-center gap-3 rounded-xl bg-white dark:bg-neutral-800 shadow-sm px-4 py-2.5 text-sm text-neutral-500 dark:text-neutral-400 select-none">
            <span className="flex-1">
              Выделите текст — <span className="text-neutral-700 dark:text-neutral-200">Перевести</span> · Alt+клик —
              абзац · <span className="text-neutral-700 dark:text-neutral-200">T</span> — перевод/оригинал
            </span>
            <button
              className="opacity-50 hover:opacity-100 px-0.5"
              onClick={() => {
                localStorage.setItem("pdfer:hint:strip", "1");
                setHintDismissed(true);
              }}
              title="Скрыть подсказку"
            >
              ×
            </button>
          </div>
        )}
        {books === null ? (
          <div className="opacity-50 text-neutral-800 dark:text-neutral-200">Сканирую…</div>
        ) : books.length === 0 ? (
          <div className="opacity-50 text-neutral-800 dark:text-neutral-200">В этой папке нет PDF</div>
        ) : (
          <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {books.map((b) => (
              <button key={b.path} onClick={() => onOpen(b.path)} className="group text-left cursor-pointer">
                <div className="aspect-[3/4] rounded-lg overflow-hidden bg-white dark:bg-neutral-800 shadow group-hover:shadow-lg transition-shadow relative">
                  {b.coverUrl ? (
                    <img src={b.coverUrl} className="w-full h-full object-cover" alt="" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center p-3 text-center text-xs opacity-40 text-neutral-800 dark:text-neutral-200">
                      {b.name}
                    </div>
                  )}
                  {b.progress != null && b.progress > 0.005 && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/15 dark:bg-white/15">
                      <div className="h-full bg-blue-500" style={{ width: `${Math.round(b.progress * 100)}%` }} />
                    </div>
                  )}
                </div>
                <div className="mt-2 text-xs leading-snug line-clamp-2 text-neutral-700 dark:text-neutral-300">
                  {b.title || b.name}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
