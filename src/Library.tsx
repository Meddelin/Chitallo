import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, readDir, readFile, remove, stat, watchImmediate, writeFile } from "@tauri-apps/plugin-fs";
import { appDataDir } from "@tauri-apps/api/path";
import * as pdfjs from "pdfjs-dist";
import { ModelSetupCard } from "./ModelSetup";
import { IconClose } from "./icons";
import { listRuns, onRunsChange } from "./booktranslate";
import type { RunInfo } from "./booktranslate";

type Book = {
  path: string;
  name: string;
  title?: string;
  coverUrl?: string;
  progress?: number;
  lastOpened?: number;
};

type IndexEntry = { mtime: number; title: string; cover: string };

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

const collator = new Intl.Collator("ru");
const labelOf = (b: Book) => b.title || b.name;

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

export default function Library({
  onOpen,
  onAbout,
}: {
  // returns the open promise so the clicked card can hold its spinner until
  // the App-side load settles (App handles the error toast itself)
  onOpen: (path: string) => void | Promise<void>;
  onAbout?: () => void;
}) {
  const [dir, setDir] = useState<string | null>(() => localStorage.getItem("pdfer:libdir"));
  const [books, setBooks] = useState<Book[] | null>(null);
  // one-time gesture hint (WP-E): lives above the grid until dismissed, never returns
  const [hintDismissed, setHintDismissed] = useState(() => localStorage.getItem("pdfer:hint:strip") === "1");
  const [q, setQ] = useState("");
  // roving tabindex: exactly one card is Tab-reachable; arrows move the ring
  const [focusIdx, setFocusIdx] = useState(0);
  // path of the card whose open is in flight — dim + spinner within 100 ms
  const [opening, setOpening] = useState<string | null>(null);
  // Н10: «Обложки: N из M» near the heading while covers are being generated
  const [coverProg, setCoverProg] = useState<{ done: number; total: number } | null>(null);
  // background translation runs (Р-6): «N%» chip on the translating book's card
  const [runs, setRuns] = useState<RunInfo[]>(() => listRuns());
  useEffect(() => onRunsChange(() => setRuns(listRuns())), []);
  const urlsRef = useRef<string[]>([]);
  const coverUrlsRef = useRef<Map<string, string>>(new Map());
  const genRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const pickDir = useCallback(async () => {
    const d = await open({ directory: true });
    if (typeof d === "string") {
      localStorage.setItem("pdfer:libdir", d);
      setBooks(null);
      setQ("");
      setFocusIdx(0);
      setDir(d);
    }
  }, []);

  // «Папка библиотеки» в настройках (WP-L) меняет localStorage, пока Library
  // примонтирована — событие доносит смену без ремаунта
  useEffect(() => {
    const onDirChange = (e: Event) => {
      const d = (e as CustomEvent<string>).detail;
      if (typeof d === "string" && d) {
        setBooks(null);
        setQ("");
        setFocusIdx(0);
        setDir(d);
      }
    };
    window.addEventListener("pdfer:libdir", onDirChange);
    return () => window.removeEventListener("pdfer:libdir", onDirChange);
  }, []);

  const rescan = useCallback(async (dir: string) => {
    const gen = ++genRef.current;
    const stale = () => gen !== genRef.current;

    const paths = await scanPdfs(dir).catch(() => [] as string[]);
    if (stale()) return;

    const posOf = (p: string) => {
      try {
        return JSON.parse(localStorage.getItem(`pdfer:pos:${p}`) ?? "") as {
          progress?: number;
          lastOpened?: number;
        };
      } catch {
        return {} as { progress?: number; lastOpened?: number };
      }
    };

    const index = JSON.parse(localStorage.getItem("pdfer:books") ?? "{}") as Record<string, IndexEntry>;
    setBooks(
      paths.map((p) => {
        const pos = posOf(p);
        return {
          path: p,
          name: p.split(/[\\/]/).pop()!.replace(/\.pdf$/i, ""),
          title: index[p]?.title || undefined,
          coverUrl: coverUrlsRef.current.get(p),
          progress: pos.progress,
          lastOpened: pos.lastOpened,
        };
      }),
    );

    const coversDir = `${await appDataDir()}\\covers`;
    await mkdir(coversDir, { recursive: true }).catch(() => {});

    // covers: cached from disk, missing/outdated ones generated one by one.
    // mtimes are collected up front so the counter knows M before work starts.
    const mtimes = new Map<string, number>();
    for (const p of paths) {
      if (stale()) return;
      mtimes.set(p, (await stat(p).catch(() => null))?.mtime?.getTime() ?? 0);
    }
    const total = paths.filter((p) => !index[p] || index[p].mtime !== mtimes.get(p)).length;
    if (total > 0) setCoverProg({ done: 0, total });
    let done = 0;

    for (const p of paths) {
      if (stale()) return;
      const mtime = mtimes.get(p) ?? 0;
      let entry = index[p];
      if (!entry || entry.mtime !== mtime) {
        try {
          entry = await makeCover(p, coversDir, mtime);
        } catch {
          entry = { mtime, title: "", cover: "" };
        }
        index[p] = entry;
        localStorage.setItem("pdfer:books", JSON.stringify(index));
        done++;
        setCoverProg({ done, total });
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
    setCoverProg(null);

    // Уборка кеша обложек (WP-M): записи индекса, чьих файлов больше нет НА
    // ДИСКЕ, удаляются вместе с jpg — иначе covers/ и pdfer:books растут
    // вечно. Книги других папок (прошлые библиотеки) существуют — остаются;
    // всё удалённое здесь пересоздаётся заново при следующей встрече файла.
    // Пустой скан не чистит: он неотличим от временно недоступной папки
    // (сетевой диск), а снос всех обложек по ложной тревоге — дорогой.
    if (paths.length === 0) return;
    const inScan = new Set(paths);
    let pruned = false;
    for (const p of Object.keys(index)) {
      if (stale()) return;
      if (inScan.has(p) || (await stat(p).catch(() => null))) continue;
      if (index[p].cover) await remove(`${coversDir}\\${index[p].cover}`).catch(() => {});
      delete index[p];
      pruned = true;
    }
    if (pruned && !stale()) localStorage.setItem("pdfer:books", JSON.stringify(index));
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

  const openBook = useCallback(
    (p: string) => {
      if (opening) return;
      setOpening(p);
      // App catches failures (toast) — settle just clears the spinner; on
      // success the Library unmounts and the set is a harmless no-op
      void Promise.resolve(onOpen(p)).finally(() => setOpening(null));
    },
    [opening, onOpen],
  );

  // ---- ordering: «Читаю» row (in progress, by recency) on top, rest by name ----
  const nq = q.trim().toLowerCase();
  let reading: Book[] = [];
  let ordered: Book[] = [];
  if (books) {
    if (nq) {
      ordered = books
        .filter((b) => labelOf(b).toLowerCase().includes(nq) || b.name.toLowerCase().includes(nq))
        .sort((a, b) => {
          const ap = labelOf(a).toLowerCase().startsWith(nq) ? 0 : 1;
          const bp = labelOf(b).toLowerCase().startsWith(nq) ? 0 : 1;
          return ap - bp || collator.compare(labelOf(a), labelOf(b));
        });
    } else {
      reading = books
        .filter((b) => (b.progress ?? 0) > 0.005 && (b.progress ?? 0) < 0.995)
        // books read before the lastOpened stamp existed sort after stamped ones
        .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0) || collator.compare(labelOf(a), labelOf(b)));
      const inReading = new Set(reading.map((b) => b.path));
      ordered = [
        ...reading,
        ...books.filter((b) => !inReading.has(b.path)).sort((a, b) => collator.compare(labelOf(a), labelOf(b))),
      ];
    }
  }
  const showSections = !nq && reading.length > 0;
  const fi = ordered.length ? Math.min(focusIdx, ordered.length - 1) : 0;

  const focusItem = useCallback((i: number) => {
    const items = gridRef.current?.querySelectorAll<HTMLButtonElement>("[data-book]");
    if (!items?.length) return;
    items[Math.max(0, Math.min(items.length - 1, i))].focus();
  }, []);

  // arrows move the focus ring geometrically (rows are measured, so the
  // section headers breaking the grid rows can't derail the column math)
  const onGridKey = useCallback(
    (e: React.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!t.hasAttribute("data-book") || e.ctrlKey || e.metaKey || e.altKey) return;
      const items = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("[data-book]") ?? []);
      const cur = items.indexOf(t as HTMLButtonElement);
      if (cur < 0) return;

      const vertical = (dir: 1 | -1) => {
        const curTop = Math.round(items[cur].getBoundingClientRect().top);
        const curLeft = items[cur].getBoundingClientRect().left;
        let bestTop: number | null = null;
        for (const el of items) {
          const top = Math.round(el.getBoundingClientRect().top);
          if (dir > 0 ? top <= curTop : top >= curTop) continue;
          if (bestTop === null || (dir > 0 ? top < bestTop : top > bestTop)) bestTop = top;
        }
        if (bestTop === null) {
          if (dir < 0) inputRef.current?.focus(); // above the first row lives the filter
          return;
        }
        let best: HTMLButtonElement | null = null;
        let bestDx = Infinity;
        for (const el of items) {
          if (Math.round(el.getBoundingClientRect().top) !== bestTop) continue;
          const dx = Math.abs(el.getBoundingClientRect().left - curLeft);
          if (dx < bestDx) {
            bestDx = dx;
            best = el;
          }
        }
        best?.focus();
      };

      if (e.key === "ArrowRight") {
        e.preventDefault();
        items[Math.min(items.length - 1, cur + 1)]?.focus();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        items[Math.max(0, cur - 1)]?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        vertical(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        vertical(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        items[items.length - 1]?.focus();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        setQ((s) => s.slice(0, -1));
        setFocusIdx(0);
        inputRef.current?.focus();
      } else if (e.key.length === 1 && e.key !== " ") {
        // typing anywhere in the grid lands in the filter (space keeps
        // activating the focused card, as buttons normally do)
        e.preventDefault();
        setQ((s) => s + e.key);
        setFocusIdx(0);
        inputRef.current?.focus();
      }
    },
    [],
  );

  const onInputKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && ordered.length) {
        e.preventDefault();
        openBook(ordered[0].path); // top hit
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        focusItem(0);
      } else if (e.key === "Escape") {
        e.stopPropagation(); // the app-level Esc chain must not see this
        if (q) {
          setQ("");
          setFocusIdx(0);
        } else {
          e.currentTarget.blur();
        }
      }
    },
    [ordered, q, openBook, focusItem],
  );

  if (!dir) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-neutral-600 dark:text-neutral-300">
        {/* тихий онбординг (Р-2): идентичность (Н1) и приватность (Н2) вместо welcome-экрана */}
        <div className="text-center select-none">
          <div className="text-2xl font-medium tracking-tight text-neutral-800 dark:text-neutral-200">pdfer</div>
          <div className="mt-2 text-sm">Читалка с локальным переводом EN→RU</div>
          <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            Работает полностью офлайн. Книги и переводы не покидают ваш компьютер
          </div>
        </div>
        <button
          className="mt-4 text-lg px-6 py-3 rounded-xl border border-neutral-300 dark:border-neutral-700 hover:bg-white dark:hover:bg-neutral-800 transition-colors text-neutral-700 dark:text-neutral-200"
          onClick={pickDir}
        >
          Выбрать папку с книгами
        </button>
        <span className="text-sm text-neutral-500 dark:text-neutral-400">Включая все вложенные папки</span>
        {/* модель перевода предлагается прямо здесь — скачивание по явному действию, с лицензией на виду */}
        <div className="mt-5">
          <ModelSetupCard />
        </div>
        {onAbout && (
          <button
            className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-700 dark:hover:text-neutral-200"
            onClick={onAbout}
          >
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
            {coverProg && (
              <span className="text-sm tabular-nums text-neutral-500 dark:text-neutral-400 select-none">
                Обложки: {coverProg.done} из {coverProg.total}
              </span>
            )}
            {onAbout && (
              <button
                className="text-sm text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
                onClick={onAbout}
              >
                О pdfer
              </button>
            )}
            <button
              className="text-sm text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
              onClick={pickDir}
              title={dir}
            >
              Сменить папку
            </button>
          </span>
        </div>
        {books !== null && books.length > 0 && (
          <input
            ref={inputRef}
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setFocusIdx(0);
            }}
            onKeyDown={onInputKey}
            placeholder="Найти книгу…"
            spellCheck={false}
            className="w-full mb-5 bg-transparent pb-2 text-sm text-neutral-800 dark:text-neutral-200 outline-none border-b border-neutral-900/10 dark:border-neutral-100/10 focus:border-neutral-900/30 dark:focus:border-neutral-100/30 placeholder:text-neutral-400 dark:placeholder:text-neutral-600 transition-colors"
          />
        )}
        {!hintDismissed && books !== null && books.length > 0 && (
          <div className="mb-6 flex items-center gap-3 rounded-xl bg-white dark:bg-neutral-800 shadow-sm px-4 py-2.5 text-sm text-neutral-500 dark:text-neutral-400 select-none">
            <span className="flex-1">
              Выделите текст — <span className="text-neutral-700 dark:text-neutral-200">Перевести</span> · Alt+клик —
              абзац · <span className="text-neutral-700 dark:text-neutral-200">T</span> — перевод/оригинал
            </span>
            <button
              className="px-0.5 text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
              onClick={() => {
                localStorage.setItem("pdfer:hint:strip", "1");
                setHintDismissed(true);
              }}
              title="Скрыть подсказку"
            >
              <IconClose />
            </button>
          </div>
        )}
        {books === null ? (
          <div className="py-24 text-center text-neutral-600 dark:text-neutral-300 select-none">
            Поиск PDF…
          </div>
        ) : books.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-24 text-neutral-600 dark:text-neutral-300">
            <span>В этой папке не нашлось PDF</span>
            <button
              className="px-4 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 hover:bg-white dark:hover:bg-neutral-800 transition-colors text-neutral-700 dark:text-neutral-200"
              onClick={pickDir}
            >
              Выбрать другую папку
            </button>
          </div>
        ) : ordered.length === 0 ? (
          <div className="py-24 text-center text-neutral-600 dark:text-neutral-300 select-none">
            Ничего не нашлось
          </div>
        ) : (
          <div
            ref={gridRef}
            onKeyDown={onGridKey}
            className="grid gap-5"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
          >
            {ordered.map((b, i) => {
              const run = runs.find((r) => r.bookPath === b.path);
              return (
              <Fragment key={b.path}>
                {showSections && i === 0 && (
                  <div className="col-span-full text-xs font-medium text-neutral-400 dark:text-neutral-500 select-none">
                    Читаю
                  </div>
                )}
                {showSections && i === reading.length && (
                  <div className="col-span-full mt-4 text-xs font-medium text-neutral-400 dark:text-neutral-500 select-none">
                    Все книги
                  </div>
                )}
                <button
                  data-book
                  tabIndex={i === fi ? 0 : -1}
                  onFocus={() => setFocusIdx(i)}
                  onClick={() => openBook(b.path)}
                  // keyboard focus ring comes from the global :focus-visible rule (WP-K)
                  className="group text-left cursor-pointer rounded-lg"
                >
                  <div className="aspect-[3/4] rounded-lg overflow-hidden bg-white dark:bg-neutral-800 shadow group-hover:shadow-lg transition-shadow relative">
                    {b.coverUrl ? (
                      <img src={b.coverUrl} className="w-full h-full object-cover" alt="" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center p-3 text-center text-xs text-neutral-500 dark:text-neutral-400">
                        {b.name}
                      </div>
                    )}
                    {b.progress != null && b.progress > 0.005 && (
                      <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/15 dark:bg-white/15">
                        <div className="h-full bg-accent" style={{ width: `${Math.round(b.progress * 100)}%` }} />
                      </div>
                    )}
                    {run && (
                      // книга переводится в фоне — живой процент рана (Р-6);
                      // янтарный = модель недоступна, движок ждёт и продолжит сам
                      <div
                        className={`absolute top-1.5 right-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white select-none ${
                          run.stalled ? "bg-amber-500/90" : "bg-accent/90"
                        }`}
                        title={
                          run.stalled
                            ? "Модель недоступна — перевод приостановлен, готовые страницы сохранены"
                            : "Книга переводится"
                        }
                      >
                        {run.total ? Math.floor((100 * run.done) / run.total) : 0}%
                      </div>
                    )}
                    {opening === b.path && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/35">
                        <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/90 border-t-transparent" />
                      </div>
                    )}
                  </div>
                  <div className="mt-2 text-xs leading-snug line-clamp-2 text-neutral-700 dark:text-neutral-300">
                    {b.title || b.name}
                  </div>
                </button>
              </Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
