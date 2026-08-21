import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, readDir, readFile, remove, stat, watchImmediate, writeFile } from "@tauri-apps/plugin-fs";
import { appDataDir } from "@tauri-apps/api/path";
import * as pdfjs from "pdfjs-dist";
import { ModelSetupCard } from "./ModelSetup";
import { GraphView } from "./GraphView";
import { IconSliders } from "./icons";
import { listRuns, onRunsChange } from "./booktranslate";
import { GRAPH_GEN } from "./graphgen";
import { autoBuild, enqueue, enqueueAll, getGraphRun, onGraphRunsChange } from "./graphrun";
import { forgetPath, listShards, onGraphChange, provFor } from "./graphstore";
import { baseName, isMac, joinPath, macKeys } from "./host";
import { getLang, t } from "./i18n";
import type { RunInfo } from "./booktranslate";

type Book = {
  path: string;
  name: string;
  title?: string;
  coverUrl?: string;
  pages?: number;
  progress?: number;
  lastOpened?: number;
};

/// Кеш обложек, он же localStorage["pdfer:books"]. Сюда НЕЛЬЗЯ дописывать
/// ничего графового — ни происхождения, ни тегов, ни сводки. Индекс целиком
/// уходит в JSON.stringify один раз на КАЖДУЮ книгу во время скана, поэтому
/// любое лишнее поле умножается на число книг дважды, сериализацией и
/// разбором: на двух сотнях книг скан стал бы квадратичным по байтам ради
/// строки в 11 пикселей. Всё, что знает граф, лежит в осколках
/// (src/graphstore.ts) и читается синхронно через provFor.
type IndexEntry = { mtime: number; title: string; cover: string; pages?: number };

/// (WP-N) Отбор живёт сегментом в строке заголовка — заголовки секций
/// «Читаю» / «Все книги» сняты, порядок карточек прежний.
type Filter = "all" | "reading" | "translating";

/// (WP-M) Сетка карточек или граф знаний. Выбор переживает перезапуск в
/// «pdfer:lib:view» — ключ новый и, как все соседи, заморожен навсегда.
type View = "grid" | "graph";

const K = (s: string) => (isMac() ? macKeys(s) : s);

/// Название на обложке-заглушке набрано книжной гарнитурой — оно же и есть
/// индикатор «обложка ещё готовится» (WP-N: счётчик «Обложки: N из M» снят).
const SERIF = { fontFamily: '"Literata", Georgia, "Iowan Old Style", "Times New Roman", serif' };

const GRID = "repeat(auto-fill, minmax(150px, 1fr))";

/// Пилюля сегмента. Их в строке заголовка теперь два — вид и отбор, — и
/// разъехавшиеся стили читались бы как два разных механизма, поэтому оба
/// сегмента берут разметку отсюда.
const SEGMENT = "flex gap-0.5 p-0.5 rounded-full bg-neutral-100 dark:bg-neutral-100/8 select-none";
const pillClass = (on: boolean) =>
  `flex items-center gap-1.5 px-3 py-1 rounded-full text-[13px] whitespace-nowrap transition-colors ${
    on
      ? "bg-white dark:bg-neutral-700 shadow-sm text-neutral-800 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10"
  }`;

/// Скелеты экрана сканирования: строки разной длины читаются как названия книг,
/// а ровные — как таблица.
const SKELETONS: [number, number][] = [
  [100, 62],
  [92, 48],
  [100, 71],
  [88, 55],
  [100, 66],
  [95, 44],
];

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

const collator = new Intl.Collator(getLang());
const labelOf = (b: Book) => b.title || b.name;
const isReading = (b: Book) => (b.progress ?? 0) > 0.005 && (b.progress ?? 0) < 0.995;

/* лупа поля поиска: единственный глиф, который нужен только здесь, поэтому
   живёт рядом с полем, а не в общем icons.tsx */
function IconSearch() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="inline-block shrink-0"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </svg>
  );
}

// onFound считает найденные файлы для строки «Сканирую папку · N файлов» —
// счёт растёт по ходу обхода, до того как список готов
async function scanPdfs(dir: string, onFound?: () => void, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const e of await readDir(dir)) {
    if (e.name.startsWith(".")) continue;
    const p = joinPath(dir, e.name);
    if (e.isDirectory) out.push(...(await scanPdfs(p, onFound, depth + 1)));
    else if (e.name.toLowerCase().endsWith(".pdf")) {
      out.push(p);
      onFound?.();
    }
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
    if (blob) await writeFile(joinPath(coversDir, cover), new Uint8Array(await blob.arrayBuffer()));
    const title = ((meta?.info as { Title?: string } | undefined)?.Title ?? "").trim();
    return { mtime, title, cover, pages: doc.numPages };
  } finally {
    doc.loadingTask.destroy().catch(() => {});
  }
}

/// Число страниц для строки состояния карточки (WP-N). Записи кеша, сделанные
/// до этой строки, числа не знают; досчитывается оно только начатым книгам —
/// прочим хватает «не открывали», и лишний разбор PDF никто не оплачивает.
async function countPages(path: string): Promise<number> {
  const bytes = await readFile(path);
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    return doc.numPages;
  } finally {
    doc.loadingTask.destroy().catch(() => {});
  }
}

export default function Library({
  onOpen,
  onAbout,
  onSettings,
  onOpenFile,
}: {
  // returns the open promise so the clicked card can hold its spinner until
  // the App-side load settles; a rejection marks the card «Не открылся»
  onOpen: (path: string) => void | Promise<void>;
  onAbout?: () => void;
  onSettings?: () => void;
  /// (WP-N) Книга ЗА пределами папки библиотеки: без этого входа её открывают
  /// только Ctrl+O и палитра. Обработчик тот же, что у них.
  onOpenFile?: () => void;
}) {
  const [dir, setDir] = useState<string | null>(() => localStorage.getItem("pdfer:libdir"));
  const [books, setBooks] = useState<Book[] | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<View>(() => (localStorage.getItem("pdfer:lib:view") === "graph" ? "graph" : "grid"));
  /// «Текущая книга» для графа: библиотека на экране ровно тогда, когда книга
  /// закрыта, поэтому свежайшая — та, что записана в «pdfer:last» (её же App
  /// открывает при запуске). Читается один раз: пока сетка видна, книгу не
  /// открывают, а открыв — библиотеку размонтируют.
  const [lastPath] = useState<string | null>(() => localStorage.getItem("pdfer:last"));
  // roving tabindex: exactly one card is Tab-reachable; arrows move the ring
  const [focusIdx, setFocusIdx] = useState(0);
  // path of the card whose open is in flight — dim + spinner within 100 ms
  const [opening, setOpening] = useState<string | null>(null);
  // (WP-N) отказ живёт на карточке, которая не открылась, а не в тосте в углу
  const [failed, setFailed] = useState<string | null>(null);
  // сколько PDF уже найдено обходом — число в строке «Сканирую папку»
  const [found, setFound] = useState(0);
  // background translation runs (Р-6): «N%» chip on the translating book's card
  const [runs, setRuns] = useState<RunInfo[]>(() => listRuns());
  useEffect(() => onRunsChange(() => setRuns(listRuns())), []);
  // Граф знаний (WP-M) целиком живёт вне React: и склад осколков, и очередь
  // сборки — модульное состояние. Карточка читает их СИНХРОННО (provFor,
  // getGraphRun), поэтому копировать снимок в состояние, как это делает
  // onRunsChange выше, нечего — подписки ниже только просят перерисовку, и
  // значение счётчика намеренно выброшено.
  const [, bumpGraph] = useState(0);
  useEffect(() => onGraphChange(() => bumpGraph((n) => n + 1)), []);
  useEffect(() => onGraphRunsChange(() => bumpGraph((n) => n + 1)), []);
  // Первый за сессию список осколков. provFor читает кеш и только кеш, а
  // наполняет его listShards — без этого чипа «что за книга» не было бы до
  // первой записи осколка, то есть на давно собранной библиотеке не было бы
  // никогда. Ответ выбрасывается: нужен сам факт прогретого кеша.
  useEffect(() => {
    void listShards()
      .then(() => bumpGraph((n) => n + 1))
      .catch(() => {});
  }, []);
  const urlsRef = useRef<string[]>([]);
  const coverUrlsRef = useRef<Map<string, string>>(new Map());
  const genRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // счёт файлов нужен только пока сетки нет: иначе каждый найденный файл
  // перерисовывал бы все карточки на каждом повторном скане
  const hasBooksRef = useRef(false);
  useEffect(() => {
    hasBooksRef.current = books !== null;
  }, [books]);

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

  const chooseView = useCallback((v: View) => {
    setView(v);
    localStorage.setItem("pdfer:lib:view", v);
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

  // «Граф знаний» из палитры и по Ctrl+G (App.tsx, openGraph) — тот же случай,
  // что и «Папка библиотеки» выше: ключ «pdfer:lib:view» читается ОДИН раз, при
  // монтировании, поэтому уже висящая библиотека о смене вида узнаёт только из
  // события. Без этого слушателя команда работала бы ровно один раз — при
  // закрытой книге библиотека размонтирована и прочтёт выбор из localStorage на
  // свежем монтировании, а вот из самой библиотеки Ctrl+G не делал бы НИЧЕГО.
  //
  // Ключ здесь не переписывается: App пишет его до отправки события, а
  // chooseView — до своего setView. Второй записи не нужно, и она же была бы
  // единственным способом их рассинхронизировать.
  useEffect(() => {
    const onViewChange = (e: Event) => {
      const v = (e as CustomEvent<string>).detail;
      if (v === "graph" || v === "grid") setView(v);
    };
    window.addEventListener("pdfer:lib:view", onViewChange);
    return () => window.removeEventListener("pdfer:lib:view", onViewChange);
  }, []);

  const rescan = useCallback(async (dir: string) => {
    const gen = ++genRef.current;
    const stale = () => gen !== genRef.current;
    const patch = (p: string, fields: Partial<Book>) =>
      setBooks((bs) => bs?.map((b) => (b.path === p ? { ...b, ...fields } : b)) ?? bs);

    let n = 0;
    if (!hasBooksRef.current) setFound(0);
    const paths = await scanPdfs(dir, hasBooksRef.current ? undefined : () => setFound(++n)).catch(
      () => [] as string[],
    );
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
    // «начатая» книга — та, чья строка состояния говорит страницами
    const started = (p: string) => {
      const pos = posOf(p);
      return pos.lastOpened != null || (pos.progress ?? 0) > 0.005;
    };

    const index = JSON.parse(localStorage.getItem("pdfer:books") ?? "{}") as Record<string, IndexEntry>;
    setBooks(
      paths.map((p) => {
        const pos = posOf(p);
        return {
          path: p,
          name: baseName(p).replace(/\.pdf$/i, ""),
          title: index[p]?.title || undefined,
          coverUrl: coverUrlsRef.current.get(p),
          pages: index[p]?.pages,
          progress: pos.progress,
          lastOpened: pos.lastOpened,
        };
      }),
    );

    const coversDir = joinPath(await appDataDir(), "covers");
    await mkdir(coversDir, { recursive: true }).catch(() => {});

    // covers: cached from disk, missing/outdated ones generated one by one
    for (const p of paths) {
      if (stale()) return;
      const mtime = (await stat(p).catch(() => null))?.mtime?.getTime() ?? 0;
      if (stale()) return;
      let entry = index[p];
      if (!entry || entry.mtime !== mtime) {
        let made: IndexEntry;
        try {
          made = await makeCover(p, coversDir, mtime);
        } catch {
          made = { mtime, title: "", cover: "" };
        }
        if (stale()) return;
        entry = made;
        index[p] = made;
        localStorage.setItem("pdfer:books", JSON.stringify(index));
        patch(p, { pages: made.pages });
        // Книга попадает в граф в ту же секунду, в какую библиотека её
        // заметила. Ставить очередь именно здесь можно только потому, что
        // enqueue по контракту синхронный и не бросает: КАЖДЫЙ await в rescan
        // огорожен stale(), и исключение отсюда бросило бы обход на середине,
        // оставив хвост библиотеки без обложек. Выключатель автосборки enqueue
        // спрашивает сам.
        enqueue(p);
      } else {
        if (entry.pages == null && started(p)) {
          const pages = await countPages(p).catch(() => 0);
          if (stale()) return;
          if (pages) {
            entry = { ...entry, pages };
            index[p] = entry;
            localStorage.setItem("pdfer:books", JSON.stringify(index));
            patch(p, { pages });
          }
        }
        if (coverUrlsRef.current.has(p)) continue; // unchanged and already on screen
      }
      if (stale()) return;
      if (entry.cover) {
        try {
          const bytes = await readFile(joinPath(coversDir, entry.cover));
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

    // Догон для библиотеки, которая существовала раньше графа: у книги может
    // не быть ни новой mtime, ни осколка — ветка выше её не заметит, а без
    // этого списка граф собрался бы только из книг, добавленных после появления
    // самой возможности. Раз за скан, а не по книге: listShards кеширован на
    // сессию, и один Set дешевле двух сотен обращений к диску. Порядок — тот
    // же, в каком обход отдал пути, то есть тот, в каком читатель видит
    // карточки: очередь наполняется сверху вниз по экрану.
    //
    // enqueueAll — это «построить весь граф», и по контракту он НЕ спрашивает
    // выключатель автосборки: его нажимает читатель. Скан — не читатель,
    // поэтому выключатель спрашиваем здесь сами, иначе снятая галка возвращала
    // бы очередь при первом же движении в папке.
    if (autoBuild()) {
      // Ключ здесь — не сам факт наличия осколка, а два вопроса к нему.
      //
      // Стадия. Книга, засеянная до установки llama.cpp, навсегда осталась бы в
      // «seed», если считать её известной: ни этот догон, ни ветка по mtime
      // (файл не менялся) её больше не поставят в очередь, и граф вечно писал
      // бы «Модель не установлена». build() сам перепроверяет возможность
      // углубления и дёшево выходит, поэтому на машине всё ещё без модели это
      // стоит одного обращения к кешу на книгу.
      //
      // Поколение извлекателя (graphgen.GRAPH_GEN). Осколок, дочитанный до
      // «deep» прошлой версией разбора, по стадии выглядит законченным — и
      // именно поэтому читатель, включивший граф вчера, остался бы с девятью
      // узлами на 838-страничную книгу навсегда, пока не наткнулся бы на
      // «Перестроить весь граф» в настройках. Осколок при этом никуда не
      // девается: он читается, рисуется, ищется и участвует в «Спросить», пока
      // перечитывание не допишет новый — граф не пустеет ни на секунду.
      //
      // Выключатель автосборки выше по-прежнему главнее: обновление приложения
      // не возвращает в очередь того, кто автосборку снял.
      const built = new Map((await listShards().catch(() => [])).map((s) => [s.bookPath, s] as const));
      if (stale()) return;
      const missing = paths.filter((p) => {
        const s = built.get(p);
        return s === undefined || s.stage !== "deep" || s.gen < GRAPH_GEN;
      });
      if (missing.length) enqueueAll(missing);
    }

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
      if (index[p].cover) await remove(joinPath(coversDir, index[p].cover)).catch(() => {});
      // Книга ушла с диска — вместе с обложкой уходит и её осколок графа,
      // иначе граф вечно показывал бы книги, которых нет, и связывал по ним
      // живые. Осечка не отменяет уборку: осколок, который не дался (замок на
      // файле), переживёт скан и уйдёт при следующем — а брошенный на середине
      // цикл оставил бы позади себя мусорные обложки.
      await forgetPath(p).catch(() => {});
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
      setFailed(null);
      // on success the Library unmounts and both sets are harmless no-ops;
      // a rejection stays on the card — «Не открылся» right where it was asked
      void Promise.resolve(onOpen(p)).then(
        () => setOpening(null),
        () => {
          setOpening(null);
          setFailed(p);
        },
      );
    },
    [opening, onOpen],
  );

  // ---- ordering: books in progress (by recency) on top, rest by name ----
  const nq = q.trim().toLowerCase();
  const runOf = (b: Book) => runs.find((r) => r.bookPath === b.path);
  let ordered: Book[] = [];
  if (books) {
    const pool = books.filter((b) =>
      filter === "all" ? true : filter === "reading" ? isReading(b) : !!runOf(b),
    );
    if (nq) {
      ordered = pool
        .filter((b) => labelOf(b).toLowerCase().includes(nq) || b.name.toLowerCase().includes(nq))
        .sort((a, b) => {
          const ap = labelOf(a).toLowerCase().startsWith(nq) ? 0 : 1;
          const bp = labelOf(b).toLowerCase().startsWith(nq) ? 0 : 1;
          return ap - bp || collator.compare(labelOf(a), labelOf(b));
        });
    } else {
      const reading = pool
        .filter(isReading)
        // books read before the lastOpened stamp existed sort after stamped ones
        .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0) || collator.compare(labelOf(a), labelOf(b)));
      const inReading = new Set(reading.map((b) => b.path));
      ordered = [
        ...reading,
        ...pool.filter((b) => !inReading.has(b.path)).sort((a, b) => collator.compare(labelOf(a), labelOf(b))),
      ];
    }
  }
  const fi = ordered.length ? Math.min(focusIdx, ordered.length - 1) : 0;

  /// Самое свежее событие книги одной строкой: идущий или приостановленный
  /// перевод важнее позиции чтения, дальше — где остановились, дальше — что
  /// книгу не открывали.
  const cardState = (b: Book, run?: RunInfo): { text: string; cls: string } => {
    if (run) {
      const pct = run.total ? Math.floor((100 * run.done) / run.total) : 0;
      return run.stalled
        ? { text: t("lib.stalled"), cls: "text-amber-700 dark:text-amber-500" }
        : { text: t("lib.trPct", { pct }), cls: "text-accent" };
    }
    const quiet = "text-neutral-400 dark:text-neutral-400";
    if (b.lastOpened == null && (b.progress ?? 0) <= 0.005) return { text: t("lib.notOpened"), cls: quiet };
    // число страниц ещё не досчитано — строка молчит, а не врёт
    if (!b.pages) return { text: "", cls: quiet };
    const page = Math.min(b.pages, Math.max(1, Math.round((b.progress ?? 0) * b.pages)));
    return { text: t("lib.pageOf", { page, total: b.pages }), cls: quiet };
  };

  const focusItem = useCallback((i: number) => {
    const items = gridRef.current?.querySelectorAll<HTMLButtonElement>("[data-book]");
    if (!items?.length) return;
    items[Math.max(0, Math.min(items.length - 1, i))].focus();
  }, []);

  // arrows move the focus ring geometrically (rows are measured, so a partly
  // filled last row can't derail the column math)
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
      <div className="h-full flex flex-col items-center justify-center text-neutral-600 dark:text-neutral-300">
        {/* quiet onboarding: identity and one line of privacy, no welcome screen */}
        <div className="text-center select-none">
          <div className="text-xl font-medium tracking-tight text-neutral-800 dark:text-neutral-200">Chitallo</div>
          <div className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">{t("app.tagline")}</div>
          <div className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">{t("app.privacy")}</div>
        </div>
        <button
          className="mt-[18px] px-6 py-3 rounded-lg border border-neutral-300 dark:border-neutral-700 text-sm text-neutral-700 dark:text-neutral-200 transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10"
          onClick={pickDir}
        >
          {t("lib.pick")}
        </button>
        <span className="mt-2 text-[13px] text-neutral-400 dark:text-neutral-500">{t("lib.pickNested")}</span>
        {/* the translation model is offered right here — user-initiated, licence in plain sight */}
        <div className="mt-5">
          <ModelSetupCard />
        </div>
        {onAbout && (
          <button
            className="mt-4 text-xs text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-700 dark:hover:text-neutral-200"
            onClick={onAbout}
          >
            {t("app.about")}
          </button>
        )}
      </div>
    );
  }

  const hasBooks = books !== null && books.length > 0;
  /// Граф показывается только там, где есть что показывать: сканирование и
  /// пустая папка говорят сами за себя, а переключатель в этот момент со
  /// страницы снят — оставить экран в графе без выхода из него было бы
  /// ловушкой для того, кто закрыл приложение в графе.
  const graphMode = view === "graph" && hasBooks;

  return (
    <div className={`h-full ${graphMode ? "overflow-hidden" : "overflow-y-auto"}`}>
      <div className={`max-w-6xl mx-auto px-6 pt-11 ${graphMode ? "h-full flex flex-col pb-4" : "pb-8"}`}>
        {/* одна строка заголовка: имя · вид · отбор · поиск · открыть файл · настройки · о программе */}
        <div className="flex items-center gap-4 mb-6 shrink-0">
          <h1 className="text-xl font-medium tracking-tight text-neutral-800 dark:text-neutral-200">
            {t("lib.title")}
          </h1>
          {/* Сетка ⇄ граф. Стоит перед отбором, потому что переключает не
              выборку книг, а сам экран: в графе отбор и сортировка ничего не
              значат, а искать он умеет сам, — поэтому соседи справа не
              притворяются живыми, а сняты. */}
          {hasBooks && (
            <div className={SEGMENT}>
              {(
                [
                  ["grid", t("gr.view.grid")],
                  ["graph", t("gr.view.graph")],
                ] as [View, string][]
              ).map(([id, label]) => (
                <button key={id} className={pillClass(view === id)} onClick={() => chooseView(id)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {hasBooks && !graphMode && (
            <div className={SEGMENT}>
              {(
                [
                  ["all", t("lib.all")],
                  ["reading", t("lib.reading")],
                  ["translating", t("lib.filterTranslating")],
                ] as [Filter, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={pillClass(filter === id)}
                  onClick={() => {
                    setFilter(id);
                    setFocusIdx(0);
                  }}
                >
                  {label}
                  {id === "translating" && runs.length > 0 && (
                    <span className="tabular-nums text-accent">{runs.length}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <span className="flex-1" />
          <div className="flex items-center gap-3">
            {hasBooks && !graphMode && (
              <div className="flex items-center gap-[7px] w-[200px] h-[30px] px-2 rounded-lg bg-neutral-100 dark:bg-neutral-100/8 border border-neutral-200 dark:border-transparent transition-colors focus-within:border-neutral-300 dark:focus-within:border-neutral-600">
                <span className="text-neutral-400">
                  <IconSearch />
                </span>
                <input
                  ref={inputRef}
                  autoFocus
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setFocusIdx(0);
                  }}
                  onKeyDown={onInputKey}
                  placeholder={t("lib.search")}
                  spellCheck={false}
                  className="flex-1 min-w-0 bg-transparent text-[13px] text-neutral-800 dark:text-neutral-200 outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
                />
                {/* палитра команд ищет по тем же книгам — подсказка стоит там, где ищут */}
                <span
                  className="font-mono text-[10px] leading-none py-1 px-1.5 rounded-md whitespace-nowrap select-none text-neutral-400 bg-white dark:bg-neutral-100/8 border border-neutral-200 dark:border-neutral-700"
                  title={t("tb.palette")}
                >
                  {K("Ctrl K")}
                </span>
              </div>
            )}
            {/* книга из любой другой папки: тихо, как соседи справа — главное
                действие экрана остаётся в сетке (WP-N) */}
            {onOpenFile && (
              <button
                className="text-[13px] whitespace-nowrap text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
                onClick={onOpenFile}
                title={`${t("cmd.openFile")} · ${K("Ctrl+O")}`}
              >
                {t("cmd.openFile")}
              </button>
            )}
            {onSettings && (
              <button
                className="flex items-center justify-center w-7 h-7 rounded-lg text-neutral-500 dark:text-neutral-400 transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10"
                onClick={onSettings}
                title={t("tb.settingsKey")}
              >
                <IconSliders />
              </button>
            )}
            {onAbout && (
              <button
                className="text-[13px] whitespace-nowrap text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
                onClick={onAbout}
              >
                {t("app.about")}
              </button>
            )}
          </div>
        </div>
        {graphMode ? (
          // Граф забирает весь остаток колонки: холст меряет свою коробку через
          // ResizeObserver, и в контейнере с высотой по содержимому получил бы
          // ноль и не нарисовал ничего. Поэтому страница в этом виде не
          // прокручивается — прокрутка живёт внутри самого графа.
          <div className="flex-1 min-h-0">
            {/* (WP-N) Полка отдаёт графу два своих знания: список путей — чтобы
                пустой граф предлагал глагол с объёмом («Собрать граф: 40 книг»),
                и путь в «Настройки» — чтобы строка «Модель не установлена» вела
                туда, где её ставят. Пока скан не кончился, books === null, и
                кнопка объёма честно молчит, а не называет ноль книг. */}
            <GraphView
              onOpen={openBook}
              focusPath={lastPath}
              paths={books?.map((b) => b.path)}
              onSetupModel={onSettings}
            />
          </div>
        ) : books === null ? (
          // сканирование: сколько файлов уже найдено, и сетка на их месте
          <div className="pt-10 select-none">
            <div className="text-center text-sm text-neutral-600 dark:text-neutral-300">
              {t("lib.scanning", { n: found })}
            </div>
            <div className="mt-6 grid gap-5" style={{ gridTemplateColumns: GRID }}>
              {SKELETONS.map(([w1, w2], i) => (
                <div key={i}>
                  <div className="aspect-[3/4] rounded-lg bg-neutral-900/5 dark:bg-neutral-100/5" />
                  <div className="mt-2 h-1.5 rounded-[2px] bg-neutral-900/5 dark:bg-neutral-100/5" style={{ width: `${w1}%` }} />
                  <div className="mt-1.5 h-1.5 rounded-[2px] bg-neutral-900/5 dark:bg-neutral-100/5" style={{ width: `${w2}%` }} />
                </div>
              ))}
            </div>
          </div>
        ) : books.length === 0 ? (
          // папка есть, книг в ней нет: причина, путь и один глагол выхода
          <div className="flex flex-col items-center py-24 text-center">
            <div className="text-sm text-neutral-800 dark:text-neutral-200">{t("lib.empty")}</div>
            <div className="mt-2.5 font-mono text-xs text-neutral-600 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-100/8 rounded-md px-2.5 py-1 max-w-full truncate">
              {dir}
            </div>
            <button
              className="mt-[18px] px-4 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 text-sm text-neutral-700 dark:text-neutral-200 transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10"
              onClick={pickDir}
            >
              {t("lib.pickOther")}
            </button>
          </div>
        ) : ordered.length === 0 ? (
          <div className="py-24 text-center text-neutral-600 dark:text-neutral-300 select-none">
            {t("ui.notFound")}
          </div>
        ) : (
          <div ref={gridRef} onKeyDown={onGridKey} className="grid gap-5" style={{ gridTemplateColumns: GRID }}>
            {ordered.map((b, i) => {
              const run = runOf(b);
              const state = cardState(b, run);
              const dead = failed === b.path;
              // Оба чтения синхронные и из памяти: provFor — из списка
              // осколков, getGraphRun — из очереди сборки. Перерисовку
              // приносят подписки наверху, поэтому здесь нет ни ожидания, ни
              // состояния, и карточка ничего не стоит.
              const prov = provFor(b.path);
              const gRun = getGraphRun(b.path);
              return (
                <button
                  key={b.path}
                  data-book
                  // the app's context menu reads the card's book off the DOM
                  data-path={b.path}
                  tabIndex={i === fi ? 0 : -1}
                  onFocus={() => setFocusIdx(i)}
                  onClick={() => openBook(b.path)}
                  // keyboard focus ring comes from the global :focus-visible rule (WP-K)
                  className="group min-w-0 text-left cursor-pointer rounded-lg"
                >
                  <div
                    className={`aspect-[3/4] rounded-lg overflow-hidden bg-white shadow transition-shadow relative ${
                      dead ? "" : "group-hover:shadow-lg"
                    }`}
                  >
                    {b.coverUrl ? (
                      <img src={b.coverUrl} className="w-full h-full object-cover" alt="" />
                    ) : (
                      // обложки ещё нет: название книги серифом — оно и есть индикатор
                      <div className="w-full h-full flex flex-col justify-between px-3 py-3.5">
                        <div
                          className={`text-xs leading-[1.3] line-clamp-5 ${dead ? "text-neutral-400" : "text-neutral-700"} ${run ? "pr-8" : ""}`}
                          style={SERIF}
                        >
                          {labelOf(b)}
                        </div>
                        <div className="h-px bg-neutral-200" />
                      </div>
                    )}
                    {/* Что это за книга. Чип рисуется только для решённого
                        происхождения: «неясно» на карточке — шум, а не
                        сведения, и на нерешённой книге лучше молчать. Слева
                        внизу, потому что справа вверху уже стоит процент
                        перевода, а слева вверху на обложке-заглушке лежит
                        название. */}
                    {(prov === "book" || prov === "article") && (
                      <div
                        className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate rounded-full px-1.5 py-px text-[10px] leading-[1.5] font-medium select-none text-neutral-700 dark:text-neutral-200 bg-white/85 dark:bg-neutral-900/70"
                        title={t(prov === "book" ? "gr.prov.book" : "gr.prov.article")}
                      >
                        {t(prov === "book" ? "gr.prov.book" : "gr.prov.article")}
                      </div>
                    )}
                    {b.progress != null && b.progress > 0.005 && (
                      <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-neutral-900/15">
                        <div className="h-full bg-accent" style={{ width: `${Math.round(b.progress * 100)}%` }} />
                      </div>
                    )}
                    {run && (
                      // the book is translating in the background — the run's live
                      // percentage; amber = model unavailable, the engine waits and resumes
                      <div
                        className={`absolute top-2 right-2 rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums text-white select-none ${
                          run.stalled ? "bg-amber-500" : "bg-accent"
                        }`}
                        title={run.stalled ? t("lib.stalled") : t("lib.translating", { pct: run.total ? Math.floor((100 * run.done) / run.total) : 0 })}
                      >
                        {run.total ? Math.floor((100 * run.done) / run.total) : 0}%
                      </div>
                    )}
                    {dead && (
                      <div className="absolute inset-x-0 bottom-0 px-2.5 py-1.5 text-[11px] text-neutral-50 bg-neutral-900/70 select-none">
                        {t("err.notOpened")}
                      </div>
                    )}
                    {opening === b.path && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/35">
                        <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/90 border-t-transparent" />
                      </div>
                    )}
                  </div>
                  <div
                    className={`mt-2 text-xs leading-[1.35] truncate ${
                      dead ? "text-neutral-400" : "text-neutral-700 dark:text-neutral-300"
                    }`}
                  >
                    {labelOf(b)}
                  </div>
                  {/* самое свежее событие книги, 11 px: перевод · страница · «не открывали» */}
                  <div className={`mt-[3px] min-h-[15px] text-[11px] leading-[1.35] truncate tabular-nums ${state.cls}`}>
                    {state.text}
                  </div>
                  {/* Сборка графа — фон, а не чтение, поэтому она говорит тише
                      строки состояния и только пока идёт. Прогон с ошибкой
                      висит в списке ещё двадцать секунд: писать над ним
                      «Собираю» значило бы врать, и он молчит. */}
                  {gRun && gRun.error === null && (
                    <div className="mt-[2px] text-[11px] leading-[1.35] truncate tabular-nums text-neutral-400 dark:text-neutral-500">
                      {t("gr.building", { done: gRun.done, n: gRun.total })}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
