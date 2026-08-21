// ---- Граф знаний: холст, а не SVG -------------------------------------------
//
// Библиотека на несколько сотен книг даёт граф в тысячи узлов, и рисовать его
// приходится каждый кадр, пока раскладка сходится. SVG здесь проигрывает не
// «немного»: узел концепта — это <circle> плюс <text>, то есть два элемента
// DOM, два стиля и два пересчёта раскладки браузера на КАЖДОЕ движение мыши;
// на семистах узлах первый же пан идёт рывками, и никакая мемоизация React это
// не спасает — цена платится ниже, в самом браузере. Холст рисует ту же тысячу
// кругов за один проход, без единого объекта DOM, и панорама остаётся плавной.
//
// Расплата за холст одна и признаётся честно: он недоступен экранному диктору.
// Поэтому карточка подробностей справа — обычный DOM, с настоящими кнопками и
// настоящим текстом, и всё, что можно узнать из картинки, можно узнать и из
// неё. Холст получает aria-label с размером графа и не притворяется большим.
//
// Цвета берутся из CSS-переменных приложения через getComputedStyle — один раз
// на смену темы (useDark). Вторая палитра, зашитая в JS, разошлась бы с App.css
// в первый же день. Читать их надо С ЭЛЕМЕНТА ВНУТРИ дерева: класс `dark`
// висит на диве внутри #root, а не на <html>, так что getComputedStyle корня
// всегда вернул бы светлую половину.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAskWidth } from "./askwidth";
import { seedPositions, step } from "./forcelayout";
import type { LayoutEdge, LayoutNode } from "./forcelayout";
import { graph, graphSync, listShards, onGraphChange, setProvenance } from "./graphstore";
import type { Graph, GraphNode, NodeKind, Provenance, Shard } from "./graphstore";
import {
  autoBuild,
  enqueueAll,
  listGraphRuns,
  onGraphRunsChange,
  queueLength,
  rebuild,
  setAutoBuild,
  stopAll,
} from "./graphrun";
import type { GraphRun } from "./graphrun";
import { isMac, macKeys } from "./host";
import { IconClose } from "./icons";
import { t } from "./i18n";
import type { Key } from "./i18n";
import { ResizeHandle } from "./resize";
import { useDark } from "./theme";

// ---- границы картинки -------------------------------------------------------

// Потолок нарисованных понятий. Дело не в силах — их сетка тянет и больше, — а
// в кадре: на ~700 узлах один тик укладывается примерно в 6 мс на машине без
// дискретной видеокарты, и вместе с отрисовкой это ещё влезает в 16 мс. Дальше
// начинается рывками, а картинка всё равно давно превратилась в туман. Поэтому
// лишнее не рисуется вовсе, а не рисуется плохо: остаются самые тяжёлые узлы —
// те, которые библиотека называет чаще всего.
const MAX_CONCEPTS = 700;

// Потолок подписей в кадре. Даже когда масштаб разрешает подписывать понятия,
// вывести их все — значит получить стену текста вместо графа; ближние к центру
// экрана важнее, поэтому подписи выдаются по порядку обхода и заканчиваются.
const LABEL_BUDGET = 160;

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 3.5;
// С какого масштаба понятия подписываются сами, без наведения и без поиска.
const LABEL_ZOOM = 0.85;

// Расписание затухания. ALPHA_START — «раскладка совсем новая», ALPHA_REHEAT —
// «её потревожили» (потащили узел, добавилась книга), ALPHA_FLOOR — та тишина,
// на которой цикл кадров ОСТАНАВЛИВАЕТСЯ. Граф, тихо жгущий ядро в фоне, —
// это дефект, а не «живая визуализация».
const ALPHA_START = 0.9;
const ALPHA_REHEAT = 0.45;
const ALPHA_DECAY = 0.982;
const ALPHA_FLOOR = 0.02;

// Насколько гаснут узлы, не попавшие в поиск. Не ноль: соседство отвечающих
// узлов — половина ответа, и стирать его нельзя.
const DIM = 0.14;

const EASE = 0.18; // доводка вида к цели за ~10 кадров
const HIT_SLACK = 6; // экранные px запаса вокруг узла при попадании курсором
const NUDGE = 90; // на сколько экранных px сдвигают вид стрелки

const KINDS: NodeKind[] = ["book", "person", "org", "place", "work", "topic", "term"];

const KIND_KEY: Record<NodeKind, Key> = {
  book: "gr.kind.book",
  person: "gr.kind.person",
  org: "gr.kind.org",
  place: "gr.kind.place",
  work: "gr.kind.work",
  topic: "gr.kind.topic",
  term: "gr.kind.term",
};

const PROV_KEY: Record<Provenance, Key> = {
  book: "gr.prov.book",
  article: "gr.prov.article",
  unknown: "gr.prov.unknown",
};

const ENGINE_KEY: Record<Shard["engine"], Key> = {
  none: "gr.engine.none",
  local: "gr.engine.local",
  claude: "gr.engine.claude",
};

const PROVS: Provenance[] = ["book", "article", "unknown"];

// ---- словарь органов управления ---------------------------------------------
//
// (WP-N) Всё, что ниже, — тот же словарь, каким набрана библиотека: тихая
// кнопка, вторичная кнопка, дорожка сегмента и пилюля выбора. Строки повторены,
// а не импортированы, ровно по одной причине: Library.tsx их не экспортирует, а
// чужой файл здесь не правится. Общий модуль (пилюли и поля разом) — работа
// этапа сборки; до тех пор расхождение стоило бы дороже дублирования.

const K = (s: string) => (isMac() ? macKeys(s) : s);

/// Тихая кнопка: только текст, наведение красит текст, не фон.
const QUIET =
  "text-xs whitespace-nowrap text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100";

/// Вторичная кнопка библиотеки — рамка, 14 px, тот же рост.
const SECONDARY =
  "px-4 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 text-sm whitespace-nowrap text-neutral-700 dark:text-neutral-200 transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";

/// Дорожка сегмента и его пилюля: белая приподнятая означает «выбран ОДИН из».
const SEGMENT = "flex gap-0.5 p-0.5 rounded-full bg-neutral-100 dark:bg-neutral-100/8 select-none";
const segClass = (on: boolean) =>
  `flex items-center gap-1.5 px-3 py-1 rounded-full text-[13px] whitespace-nowrap transition-colors ${
    on
      ? "bg-white dark:bg-neutral-700 shadow-sm text-neutral-800 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10"
  }`;

/// Отбор — выбор ЛЮБОГО числа видов, и одевать его как сегмент нельзя: включён
/// здесь означает заливку, а не приподнятую белую пилюлю без дорожки.
const pickClass = (on: boolean) =>
  `flex items-center gap-1.5 px-3 py-1 rounded-full text-[13px] whitespace-nowrap transition-colors ${
    on
      ? "bg-neutral-100 dark:bg-neutral-100/8 text-neutral-800 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10"
  }`;

// Радиусы. У книги он говорит о толщине (вес уже прижат в graphstore), у
// понятия — о том, как часто оно встречается, но через логарифм: термин из
// четырёхсот упоминаний не в сто раз важнее термина из четырёх, а картинка от
// линейного радиуса превращается в одну планету и пыль вокруг.
const bookR = (w: number) => 8 + Math.min(6, w) * 1.5;
const conceptR = (w: number) => 3 + Math.min(6, Math.log1p(Math.max(0, w)) * 1.4);

// ---- палитра ----------------------------------------------------------------

type Palette = {
  fg: string;
  muted: string;
  edge: string;
  accent: string;
  card: string;
  font: string;
  kind: Record<NodeKind, string>;
  prov: Record<Provenance, string>;
};

/// Палитра из CSS-переменных приложения. Синий в системе один и означает
/// только выбранное — поэтому на холсте акцент не достаётся НИ ОДНОЙ категории
/// данных: им рисуются кольцо выбранного узла и его рёбра, и больше ничего
/// (WP-N). Отсюда же выпал слот --chart-1: он тоже синий, и рядом с кольцом
/// выбора «Люди» читались бы как второй акцент.
///
/// Книга — главный предмет картинки, и отличают её размер, подпись и фишка
/// происхождения, а не цвет: она набрана цветом текста. Четыре оставшихся
/// слота ленты разошлись по именованным сущностям, а «темы» и «термины»
/// остались приглушённым серым — выдумывать шестой цвет значило бы завести
/// вторую палитру мимо App.css. Термины разводятся с темами не цветом, а
/// прозрачностью в draw(): их на порядок больше, и они должны быть тише.
function readPalette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const muted = v("--muted-foreground", "#78716c");
  const fg = v("--foreground", "#292524");
  return {
    fg,
    muted,
    edge: v("--border", "#e7e5e4"),
    accent: v("--color-accent", "#3b82f6"),
    card: v("--card", "#ffffff"),
    // (WP-N) запасной стек — тот же, что в App.css и mermaid-theme.ts: если
    // переменной вдруг нет, подписи на холсте обязаны остаться шрифтом
    // приложения, а не съехать в system-ui посреди интерфейса
    font: v("--font-sans", '"Golos Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'),
    kind: {
      book: fg,
      person: v("--chart-2", "#eb6834"),
      org: v("--chart-4", "#eda100"),
      place: v("--chart-3", "#1baf7a"),
      work: v("--chart-5", "#e87ba4"),
      topic: muted,
      term: muted,
    },
    prov: {
      book: muted,
      article: v("--chart-3", "#1baf7a"),
      unknown: muted,
    },
  };
}

// ---- сам вид ----------------------------------------------------------------

type View = { x: number; y: number; k: number };
type Sim = { nodes: GraphNode[]; layout: LayoutNode[]; edges: LayoutEdge[] };
type Drag =
  | { kind: "pan"; px: number; py: number; vx: number; vy: number; moved: boolean }
  // Схваченный узел хранится ПО ID: индекс раскладки живёт ровно до следующей
  // дозаписи шарда (см. layoutOf).
  | { kind: "node"; id: string; moved: boolean };

export function GraphView(props: {
  onOpen: (path: string) => void;
  focusPath?: string | null;
  /** (WP-N) Пути всех книг полки: пустой граф отвечает глаголом с объёмом —
   *  «Собрать граф: 40 книг». Без списка кнопке нечего называть, поэтому
   *  проп необязательный, а отказ остаётся одной строкой состояния. */
  paths?: string[];
  /** (WP-N) Путь установки модели живёт в «Настройках»; без него строка
   *  «Модель не установлена» стоит без глагола, и это лучше, чем глагол,
   *  которому некуда вести. */
  onSetupModel?: () => void;
}) {
  const { onOpen, focusPath, paths, onSetupModel } = props;
  const dark = useDark();

  const [g, setG] = useState<Graph | null>(() => graphSync());
  // null — «ещё не знаем», пустой список — «книг в графе нет». Слить их в одно
  // значило бы мигать «Граф пуст» на каждом входе в граф полной библиотеки,
  // пока list едет с диска (WP-N; библиотека рядом различает их так же).
  const [shards, setShards] = useState<Shard[] | null>(null);
  const [q, setQ] = useState("");
  const [kinds, setKinds] = useState<Set<NodeKind>>(() => new Set(KINDS));
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [runs, setRuns] = useState<GraphRun[]>(() => listGraphRuns());
  const [queued, setQueued] = useState<number>(() => queueLength());
  const [why, setWhy] = useState(false); // доказательства классификатора
  const [changing, setChanging] = useState(false); // «Изменить» — выбор происхождения
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Ширина у панели графа и правой панели читалки ОДНА (ключ pdfer:askw): они
  // никогда не видны одновременно — граф живёт в библиотеке, панель в книге, —
  // и две разные памяти о ширине читались бы как две разные панели (WP-N).
  const [panelW, setPanelW] = useAskWidth();

  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sizeRef = useRef({ w: 0, h: 0 });
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const targetRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const simRef = useRef<Sim | null>(null);
  // Позиции узлов переживают перестройку модели: смена фильтра или приход новой
  // книги не должны перетасовывать всё, что читатель уже разглядел.
  const posRef = useRef(new Map<string, { x: number; y: number; pinned: boolean }>());
  const palRef = useRef<Palette | null>(null);
  const alphaRef = useRef(ALPHA_START);
  const rafRef = useRef(0);
  // Ссылка на СВЕЖИЙ кадр: цикл планирует её, а не сам `frame` (см. ниже).
  // Заглушка до первого прохода эффектов обязана освободить слот: иначе rafRef
  // остался бы занятым, и kick уже никогда не завёл бы цикл — граф застыл бы.
  const frameRef = useRef<() => void>(() => {
    rafRef.current = 0;
  });
  const visibleRef = useRef(true);
  const dragRef = useRef<Drag | null>(null);
  const selRef = useRef<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  const matchRef = useRef<Set<string> | null>(null);
  const focusedRef = useRef(false); // focusPath отрабатывает один раз, на первой раскладке
  const lastFocusRef = useRef<string | null>(null); // куда поиск уже подвозил вид
  // (WP-N) Первая подгонка ждёт, пока раскладка успокоится. Спираль сеется по
  // размеру коробки, а разойдясь под отталкиванием, облако становится в разы
  // шире её — и вид, оставленный на k=1 у центра коробки, показывал бы читателю
  // один угол графа, а книги без связей и вовсе за кадром. Гасится, как только
  // читатель берёт вид сам (панорама, колесо) или его увозит focusPath.
  const autoFitRef = useRef(true);
  // Ссылка, а не сам расчёт: `frame` объявлен ВЫШЕ подгонки, и попасть в его
  // список зависимостей она не может — там это чтение до инициализации.
  const fitRef = useRef<() => View | null>(() => null);

  // ---- данные ----
  // Ремни и подтяжки — и удалять их как мёртвый код нельзя. Сегодня ни одно из
  // двух обещаний отказать не может: loadAll в graphstore сам вешает обработчик
  // отказа, а mergeShards — чистая функция. Но если бросок когда-нибудь всё же
  // дойдёт сюда, он станет необработанным отказом промиса, то есть строчкой в
  // консоли и ничем больше: панель молча замрёт на прошлом графе, а читатель не
  // узнает, почему. Поэтому отказ проговаривается вслух, а прежнее состояние
  // остаётся стоять — пустой граф вместо старого был бы худшей из двух неправд.
  const reload = useCallback(() => {
    void graph()
      .then(setG)
      .catch((e) => console.warn("graph: the graph could not be reloaded", e));
    void listShards()
      .then(setShards)
      .catch((e) => console.warn("graph: the shard list could not be reloaded", e));
  }, []);
  useEffect(() => {
    reload();
    return onGraphChange(reload);
  }, [reload]);

  useEffect(
    () =>
      onGraphRunsChange(() => {
        setRuns(listGraphRuns());
        setQueued(queueLength());
      }),
    [],
  );

  const shardByKey = useMemo(() => new Map((shards ?? []).map((s) => [s.key, s])), [shards]);

  // ---- что вообще рисуем ----
  const model = useMemo(() => {
    const books: GraphNode[] = [];
    const concepts: GraphNode[] = [];
    for (const nd of g?.nodes ?? []) (nd.kind === "book" ? books : concepts).push(nd);
    books.sort((a, b) => b.weight - a.weight);
    concepts.sort((a, b) => b.weight - a.weight);
    const kept = concepts.length > MAX_CONCEPTS ? concepts.slice(0, MAX_CONCEPTS) : concepts;

    const counts = { book: books.length } as Record<NodeKind, number>;
    for (const k of KINDS) counts[k] ??= 0;
    for (const nd of kept) counts[nd.kind] = (counts[nd.kind] ?? 0) + 1;

    // Книги идут первыми и потому садятся ближе к центру спирали (см.
    // seedPositions) — библиотека читается от книг наружу, а не наоборот.
    const nodes: GraphNode[] = [];
    if (kinds.has("book")) nodes.push(...books);
    for (const nd of kept) if (kinds.has(nd.kind)) nodes.push(nd);

    const index = new Map<string, number>();
    nodes.forEach((nd, i) => index.set(nd.id, i));
    const edges: LayoutEdge[] = [];
    for (const e of g?.edges ?? []) {
      const a = index.get(e.a);
      const b = index.get(e.b);
      if (a === undefined || b === undefined) continue;
      edges.push({ a, b, w: e.weight });
    }
    return { nodes, index, edges, counts, drawn: kept.length, total: concepts.length, books: books.length };
  }, [g, kinds]);

  // ---- поиск ----
  const matches = useMemo(() => {
    const nq = q.trim().toLowerCase();
    if (!nq) return null;
    const set = new Set<string>();
    let best: GraphNode | null = null;
    let bestRank = -Infinity;
    for (const nd of model.nodes) {
      const label = nd.label.toLowerCase();
      if (!label.includes(nq)) continue;
      set.add(nd.id);
      // Совпадение с начала названия — почти всегда то, что искали; дальше
      // решает вес, а книга при равенстве обходит понятие: искали, скорее
      // всего, книгу.
      const rank =
        (label.startsWith(nq) ? 1000 : 0) + (nd.kind === "book" ? 500 : 0) + Math.log1p(nd.weight);
      if (rank > bestRank) {
        bestRank = rank;
        best = nd;
      }
    }
    return { set, best };
  }, [q, model]);

  // ---- отрисовка ----
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    const pal = palRef.current;
    if (!cv || !pal) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const { w, h } = sizeRef.current;
    if (!w || !h) return;

    // Плотность пикселей проверяется каждый кадр, а не только на ресайзе:
    // окно переезжает между мониторами с разным dpr, и кадр после переезда
    // иначе остался бы мыльным до следующего изменения размера.
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw;
      cv.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const sim = simRef.current;
    if (!sim) return;
    const v = viewRef.current;
    const cx = w / 2;
    const cy = h / 2;
    const sx = (x: number) => (x - v.x) * v.k + cx;
    const sy = (y: number) => (y - v.y) * v.k + cy;
    const match = matchRef.current;
    const lit = (id: string) => match === null || match.has(id);
    const selected = selRef.current;
    const hovered = hoverRef.current;

    // Рёбра — двумя проходами (обычные и погашенные), каждый одним stroke:
    // тысяча отдельных вызовов stroke() стоит дороже самой геометрии.
    const strokeEdges = (alpha: number, wanted: boolean) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = pal.edge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const e of sim.edges) {
        const a = sim.layout[e.a];
        const b = sim.layout[e.b];
        if (!a || !b) continue;
        const on = lit(a.id) || lit(b.id);
        if (on !== wanted) continue;
        ctx.moveTo(sx(a.x), sy(a.y));
        ctx.lineTo(sx(b.x), sy(b.y));
      }
      ctx.stroke();
    };
    strokeEdges(DIM * 0.6, false);
    strokeEdges(0.45, true);

    // Рёбра выбранного узла — акцентом поверх: «где он встречается» видно ещё
    // до того, как читатель опустит глаза в карточку.
    if (selected) {
      const si = model.index.get(selected);
      if (si !== undefined) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (const e of sim.edges) {
          if (e.a !== si && e.b !== si) continue;
          const a = sim.layout[e.a];
          const b = sim.layout[e.b];
          if (!a || !b) continue;
          ctx.moveTo(sx(a.x), sy(a.y));
          ctx.lineTo(sx(b.x), sy(b.y));
        }
        ctx.stroke();
      }
    }

    let labels = 0;
    const bookFont = `12px ${pal.font}`;
    const conceptFont = `11px ${pal.font}`;
    ctx.textBaseline = "middle";
    for (let i = 0; i < sim.layout.length; i++) {
      const ln = sim.layout[i];
      const nd = sim.nodes[i];
      if (!nd) continue;
      const px = sx(ln.x);
      const py = sy(ln.y);
      const r = ln.r * v.k;
      if (px < -160 || py < -60 || px > w + 260 || py > h + 60) continue; // за кадром — и за расходами
      const on = lit(nd.id);
      const isSel = nd.id === selected;
      const isHot = nd.id === hovered;
      // Один язык наведения на всё приложение — заливка, а не второе кольцо
      // (WP-N): узел под курсором горит в полную силу, даже когда поиск погасил
      // всё вокруг, а термины и без того держатся тише тем.
      const quiet = nd.kind === "term" ? 0.62 : 1;
      ctx.globalAlpha = isSel || isHot ? 1 : (on ? 1 : DIM) * quiet;

      ctx.fillStyle = pal.kind[nd.kind];
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1.5, r), 0, Math.PI * 2);
      ctx.fill();
      // Приколотый узел держит место сам — тонкое кольцо цвета фона карточки
      // говорит об этом, не заводя ещё одного цвета в палитре.
      if (ln.pinned) {
        ctx.strokeStyle = pal.card;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      // Кольцо — только у выбранного, и только акцентом: это единственное, что
      // синий цвет означает на холсте.
      if (isSel) {
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(1.5, r) + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (nd.kind === "book") {
        // Фишка происхождения: цветная пилюля перед названием. Слово целиком
        // живёт в подсказке и в карточке — на холсте его негде перевести и
        // некуда перенести, а цвет читается и в свёрнутом масштабе. Открытая
        // статья — единственная, кого фишка выделяет: лицензионная книга и
        // книга неясного происхождения читаются одинаково, локальной моделью,
        // и разным цветом сказали бы о разнице, которой нет (WP-N).
        const lx = px + Math.max(1.5, r) + 6;
        ctx.fillStyle = pal.prov[nd.prov ?? "unknown"];
        pill2d(ctx, lx, py - 2.5, 10, 5);
        ctx.fill();
        ctx.fillStyle = pal.fg;
        ctx.font = bookFont;
        ctx.fillText(clip(ctx, nd.label, 190), lx + 15, py);
      } else if (v.k >= LABEL_ZOOM || isSel || isHot || (match !== null && on)) {
        if (labels < LABEL_BUDGET) {
          labels++;
          ctx.fillStyle = isSel || isHot ? pal.fg : pal.muted;
          ctx.font = conceptFont;
          ctx.fillText(clip(ctx, nd.label, 150), px + Math.max(1.5, r) + 5, py);
        }
      }
    }
    ctx.globalAlpha = 1;

    // Подсказка — настоящий DOM, поэтому её только ставят на место; узел под
    // курсором продолжает двигаться, пока раскладка сходится.
    const tip = tipRef.current;
    if (tip && hovered) {
      const hi = model.index.get(hovered);
      const ln = hi === undefined ? undefined : sim.layout[hi];
      if (ln) tip.style.transform = `translate(${Math.round(sx(ln.x))}px, ${Math.round(sy(ln.y) - ln.r * v.k - 10)}px)`;
    }
  }, [model]);

  // ---- цикл кадров ----
  const frame = useCallback(() => {
    rafRef.current = 0;
    let running = false;

    const v = viewRef.current;
    const tgt = targetRef.current;
    if (Math.abs(v.x - tgt.x) > 0.4 || Math.abs(v.y - tgt.y) > 0.4 || Math.abs(v.k - tgt.k) > 0.002) {
      v.x += (tgt.x - v.x) * EASE;
      v.y += (tgt.y - v.y) * EASE;
      v.k += (tgt.k - v.k) * EASE;
      running = true;
    } else {
      v.x = tgt.x;
      v.y = tgt.y;
      v.k = tgt.k;
    }

    const sim = simRef.current;
    if (sim && alphaRef.current > ALPHA_FLOOR) {
      step(sim.layout, sim.edges, alphaRef.current);
      alphaRef.current *= ALPHA_DECAY;
      running = true;
    } else if (sim && autoFitRef.current && !focusedRef.current) {
      // Раскладка встала — граф садится в кадр целиком, один раз. Цель ставится
      // НАПРЯМУЮ, минуя easeTo: тот зовёт kick, а kick внутри кадра видит
      // свободный слот (rafRef обнулён выше) и завёл бы второй цикл поверх
      // того, что планирует последняя строка.
      // Флаг гасит УДАВШАЯСЯ подгонка: на пустой раскладке считать нечего, и
      // потратить на неё единственную попытку значило бы не подогнать граф,
      // который приедет следом. Холостой проход циклу ничего не стоит — без
      // `running` последняя строка его же и остановит.
      const to = fitRef.current();
      if (to) {
        autoFitRef.current = false;
        targetRef.current = to;
        running = true;
      }
    }

    draw();
    // Ни одного кадра сверх необходимого: раскладка успокоилась, вид доехал —
    // цикл выключается до следующего касания.
    if (running && visibleRef.current) rafRef.current = requestAnimationFrame(() => frameRef.current());
  }, [draw]);

  // Планируется ССЫЛКА на кадр, а не сам `frame`. Без этого работающий цикл
  // навсегда оставался бы с замыканием, снятым при запуске: `frame` заново
  // планирует себя по имени, а `kick` отказывается заводить второй цикл, пока
  // rafRef занят, — так что смена model в новый кадр не попадала бы вовсе.
  // Во время сборки библиотеки каждая дозапись шарда подогревает alpha, цикл
  // не останавливается часами, и draw() продолжает разрешать выбор через
  // СТАРЫЙ model.index против НОВЫХ sim.edges: подсветка уходит к чужим
  // соседям, а подсказка встаёт над другим узлом.
  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

  const kick = useCallback(() => {
    if (!rafRef.current && visibleRef.current) rafRef.current = requestAnimationFrame(() => frameRef.current());
  }, []);

  // Отмена кадра ОБЯЗАНА освободить слот, ровно по причине из заглушки выше:
  // cancelAnimationFrame гасит запланированный кадр, а обнуляет rafRef только
  // сам `frame` — который после отмены уже не выполнится. StrictMode в разработке
  // размонтирует компонент сразу за первым монтированием, ссылки это переживают,
  // и на втором проходе kick видел занятый слот и молча не заводил цикл: данные
  // грузились, раскладка собиралась, focusPath даже выбирал книгу в карточку —
  // а draw() не вызывался НИ РАЗУ, и холст оставался пустым до конца сеанса (WP-N).
  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    },
    [],
  );

  // ---- палитра и размер ----
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    palRef.current = readPalette(box);
    kick();
  }, [dark, kick]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => {
      const rect = box.getBoundingClientRect();
      const next = { w: Math.round(rect.width), h: Math.round(rect.height) };
      if (next.w === sizeRef.current.w && next.h === sizeRef.current.h) return;
      sizeRef.current = next;
      setSize(next);
      kick();
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [kick]);

  // Спрятанный граф не считает. Вкладка в фоне и панель, уехавшая за пределы
  // экрана, — один и тот же случай: никто не смотрит, значит нечего и жечь.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const update = (seen: boolean) => {
      const next = seen && document.visibilityState !== "hidden";
      if (next === visibleRef.current) return;
      visibleRef.current = next;
      if (next) kick();
    };
    let onScreen = true;
    const io = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      update(onScreen);
    });
    io.observe(box);
    const onVis = () => update(onScreen);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [kick]);

  // ---- сборка раскладки ----
  useEffect(() => {
    if (!size.w || !size.h) return;
    const known = posRef.current;
    const prev = simRef.current;
    if (prev) for (const ln of prev.layout) known.set(ln.id, { x: ln.x, y: ln.y, pinned: ln.pinned });

    const layout: LayoutNode[] = model.nodes.map((nd) => {
      const at = known.get(nd.id);
      return {
        id: nd.id,
        x: at?.x ?? 0,
        y: at?.y ?? 0,
        vx: 0,
        vy: 0,
        r: nd.kind === "book" ? bookR(nd.weight) : conceptR(nd.weight),
        pinned: at?.pinned ?? false,
      };
    });
    const fresh = layout.filter((ln) => !known.has(ln.id));
    if (fresh.length === layout.length) {
      seedPositions(layout, size.w, size.h);
      // Первая раскладка: вид смотрит туда же, куда сеялась спираль, — и ждёт
      // подгонки, которая сядет на неё, когда она разойдётся и встанет. Взводим
      // и здесь: собранный из пустого граф — тоже первая раскладка (WP-N).
      viewRef.current = { x: size.w / 2, y: size.h / 2, k: 1 };
      targetRef.current = { ...viewRef.current };
      autoFitRef.current = true;
    } else if (fresh.length) {
      // Новые узлы садятся вокруг НЫНЕШНЕГО центра облака, а не вокруг центра
      // коробки: облако давно уехало от начала координат, и спираль из нуля
      // выбросила бы новую книгу куда-то в поле.
      let mx = 0;
      let my = 0;
      for (const ln of layout) {
        mx += ln.x;
        my += ln.y;
      }
      mx = mx / layout.length - size.w / 2;
      my = my / layout.length - size.h / 2;
      seedPositions(fresh, size.w, size.h);
      for (const ln of fresh) {
        ln.x += mx;
        ln.y += my;
      }
    }

    simRef.current = { nodes: model.nodes, layout, edges: model.edges };
    alphaRef.current = fresh.length === layout.length ? ALPHA_START : ALPHA_REHEAT;
    kick();
  }, [model, size, kick]);

  useEffect(() => {
    matchRef.current = matches?.set ?? null;
    kick();
  }, [matches, kick]);

  useEffect(() => {
    selRef.current = sel;
    setWhy(false);
    setChanging(false);
    kick();
  }, [sel, kick]);

  // Подсказку ставит на место draw(), а появляется она в DOM только после
  // коммита — без этого кадра «вдогонку» она успела бы застрять в левом
  // верхнем углу, если раскладка к тому моменту уже успокоилась.
  useEffect(() => {
    if (hover) kick();
  }, [hover, kick]);

  // ---- вид: перевод координат, доводка, посадка на узел ----
  const toWorld = useCallback((px: number, py: number) => {
    const { w, h } = sizeRef.current;
    const v = viewRef.current;
    return { x: (px - w / 2) / v.k + v.x, y: (py - h / 2) / v.k + v.y };
  }, []);

  const easeTo = useCallback(
    (x: number, y: number, k?: number) => {
      targetRef.current = { x, y, k: k ?? targetRef.current.k };
      kick();
    },
    [kick],
  );

  const focusNode = useCallback(
    (id: string) => {
      const sim = simRef.current;
      const i = model.index.get(id);
      if (!sim || i === undefined) return;
      const ln = sim.layout[i];
      if (!ln) return;
      easeTo(ln.x, ln.y, Math.max(targetRef.current.k, 1));
    },
    [model, easeTo],
  );

  /// Вид, в котором граф виден целиком, — или null, пока считать нечего.
  /// Чистый расчёт без побочных действий: его зовут и кнопка, и кадр, вставший
  /// на успокоившейся раскладке, а кадру нельзя трогать очередь rAF.
  const fitTarget = useCallback((): View | null => {
    const sim = simRef.current;
    const { w, h } = sizeRef.current;
    if (!sim || !sim.layout.length || !w || !h) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const ln of sim.layout) {
      x0 = Math.min(x0, ln.x - ln.r);
      y0 = Math.min(y0, ln.y - ln.r);
      x1 = Math.max(x1, ln.x + ln.r);
      y1 = Math.max(y1, ln.y + ln.r);
    }
    const pad = 48;
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min((w - pad) / (x1 - x0 || 1), (h - pad) / (y1 - y0 || 1))));
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, k };
  }, []);
  useEffect(() => {
    fitRef.current = fitTarget;
  }, [fitTarget]);

  /// «Свести к центру»: весь граф обратно в кадр. Он же — выход из положения,
  /// когда читатель улетел панорамой в пустоту и не понимает, куда делся граф.
  const fitAll = useCallback(() => {
    const to = fitTarget();
    if (to) easeTo(to.x, to.y, to.k);
  }, [fitTarget, easeTo]);

  // Поиск не только гасит лишнее, но и подвозит: лучшее совпадение выезжает в
  // центр. Иначе «нашлось» означало бы «где-то есть», что для графа бесполезно.
  useEffect(() => {
    // matches — новый объект на КАЖДУЮ смену model, а во время сборки она
    // меняется каждые несколько секунд. Без памяти о том, куда уже подвозили,
    // вид рывками возвращался бы к совпадению и заново зажимал масштаб — граф
    // с непустым запросом просто нельзя было бы панорамировать.
    if (matches === null) {
      lastFocusRef.current = null; // запрос очистили (см. memo выше) — следующее совпадение снова подвозит
      return;
    }
    const best = matches.best;
    if (!best || best.id === lastFocusRef.current) return;
    lastFocusRef.current = best.id;
    focusNode(best.id);
  }, [matches, focusNode]);

  // focusPath — книга, из которой читатель сюда пришёл: один раз, на первой
  // готовой раскладке, и больше эта ветка не срабатывает.
  //
  // `size` в зависимостях несущий, хотя в теле не упоминается: на тёплом кеше
  // model полна уже к первому рендеру, но раскладка не собрана, пока размер
  // {0,0}, и эта ветка выходит на пустом simRef. Размер приезжает позже, от
  // ResizeObserver, и без него в списке ничто не перезапустит попытку — graph()
  // отдаёт тот же самый объект, React гасит повторный рендер, и книга, из
  // которой пришли, остаётся ни выбранной, ни в центре — до конца сеанса.
  useEffect(() => {
    if (focusedRef.current || !focusPath || !simRef.current) return;
    const node = model.nodes.find((nd) => nd.kind === "book" && nd.path === focusPath);
    if (!node) return;
    focusedRef.current = true;
    selRef.current = node.id;
    setSel(node.id);
    focusNode(node.id);
  }, [focusPath, model, size, focusNode]);

  // ---- мышь ----
  const hitTest = useCallback(
    (px: number, py: number): number | null => {
      const sim = simRef.current;
      if (!sim) return null;
      const p = toWorld(px, py);
      const slack = HIT_SLACK / viewRef.current.k;
      let best: number | null = null;
      let bestD = Infinity;
      for (let i = sim.layout.length - 1; i >= 0; i--) {
        const ln = sim.layout[i];
        const d = Math.hypot(ln.x - p.x, ln.y - p.y);
        if (d <= ln.r + slack && d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    },
    [toWorld],
  );

  /// Узел жеста ищется ПО ID, а не по индексу раскладки. Дозапись шарда
  /// пересобирает model: книги встают перед понятиями, обе половины
  /// отсортированы по весу — одна новая книга сдвигает почти все индексы
  /// понятий. Индекс, снятый на pointerdown, к следующему движению мыши
  /// показывает на чужой узел: тот телепортируется к курсору и прибивается
  /// вместо схваченного, а на отпускании в карточку попадает третий. null —
  /// узла больше нет в картинке (потолок MAX_CONCEPTS или снятый фильтр).
  const layoutOf = useCallback(
    (id: string): LayoutNode | null => {
      const sim = simRef.current;
      if (!sim) return null;
      const i = model.index.get(id);
      const ln = i === undefined ? undefined : sim.layout[i];
      // Индекс берётся из model, а sim пересобирает эффект уже после коммита:
      // в этом зазоре тот же индекс смотрит в ПРЕЖНЮЮ раскладку, поэтому id
      // сверяется, и при расхождении узел ищется перебором.
      if (ln?.id === id) return ln;
      return sim.layout.find((n) => n.id === id) ?? null;
    },
    [model],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.button !== 0) return;
      // Вид взяли в руки — подгонка больше не вмешивается: рывок кадра под
      // рукой читателя хуже, чем граф, стоящий не по центру (WP-N).
      autoFitRef.current = false;
      const rect = e.currentTarget.getBoundingClientRect();
      const i = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      const id = i === null ? null : (simRef.current?.nodes[i]?.id ?? null);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* синтетический указатель без захвата — тащить всё равно можно */
      }
      dragRef.current =
        id === null
          ? { kind: "pan", px: e.clientX, py: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false }
          : { kind: "node", id, moved: false };
    },
    [hitTest],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const drag = dragRef.current;

      if (drag?.kind === "pan") {
        const v = viewRef.current;
        const nx = drag.vx - (e.clientX - drag.px) / v.k;
        const ny = drag.vy - (e.clientY - drag.py) / v.k;
        if (Math.abs(e.clientX - drag.px) + Math.abs(e.clientY - drag.py) > 3) drag.moved = true;
        // Панораму не доводят: она должна идти ровно за пальцем, поэтому и
        // текущий вид, и цель ставятся сразу.
        v.x = nx;
        v.y = ny;
        targetRef.current = { x: nx, y: ny, k: v.k };
        kick();
        return;
      }
      if (drag?.kind === "node") {
        const ln = layoutOf(drag.id);
        // Узел выбыл из картинки прямо под рукой — жест заканчивается тихо, а
        // не тащит за собой соседа, занявшего освободившийся индекс.
        if (!ln) {
          dragRef.current = null;
          return;
        }
        const p = toWorld(px, py);
        ln.pinned = true; // потащили — значит прибили: место узла теперь решает читатель
        ln.x = p.x;
        ln.y = p.y;
        ln.vx = 0;
        ln.vy = 0;
        drag.moved = true;
        alphaRef.current = Math.max(alphaRef.current, ALPHA_REHEAT);
        kick();
        return;
      }

      const i = hitTest(px, py);
      const sim = simRef.current;
      const id = i === null ? null : (sim?.nodes[i]?.id ?? null);
      if (id === hoverRef.current) return;
      hoverRef.current = id;
      setHover(id);
      kick();
    },
    [hitTest, toWorld, kick, layoutOf],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* захвата и не было */
      }
      if (!drag || drag.moved) return;
      // Клик без протяжки: выбрать узел или снять выбор на пустом месте. Узел
      // проверяется по id — за время клика model могла пересобраться, и старый
      // индекс выбрал бы в карточку совершенно посторонний узел.
      const id = drag.kind === "node" && layoutOf(drag.id) ? drag.id : null;
      selRef.current = id;
      setSel(id);
      kick();
    },
    [kick, layoutOf],
  );

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const i = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      const sim = simRef.current;
      if (i === null || !sim) return;
      sim.layout[i].pinned = false; // отпустить: узел возвращается в общий расчёт
      alphaRef.current = Math.max(alphaRef.current, ALPHA_REHEAT);
      kick();
    },
    [hitTest, kick],
  );

  // Колесо — свой слушатель, а не React-проп: жест надо гасить (passive: false),
  // иначе webview зумит саму страницу вместе с графом.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      autoFitRef.current = false; // масштаб выбран читателем — см. onPointerDown
      const rect = cv.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const before = toWorld(px, py);
      const v = viewRef.current;
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * Math.exp(-e.deltaY * 0.0016)));
      const { w, h } = sizeRef.current;
      // Точка под курсором остаётся под курсором — иначе зум «уводит» картинку
      // и целиться приходится вслепую.
      v.k = k;
      v.x = before.x - (px - w / 2) / k;
      v.y = before.y - (py - h / 2) / k;
      targetRef.current = { x: v.x, y: v.y, k };
      kick();
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [toWorld, kick]);

  // ---- клавиши ----
  // Ни одна из них не отбирается у приложения: Escape ниже уходит дальше, если
  // снимать нечего, а стрелки App слушает только при открытой книге — и всё
  // равно останавливаются здесь, чтобы страница за панелью не уехала вместе с
  // графом.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "Escape") {
        if (typing || !selRef.current) return; // поле чистит себя само, пустой выбор пропускает Esc дальше
        e.preventDefault();
        e.stopPropagation();
        selRef.current = null;
        setSel(null);
        kick();
        return;
      }
      if (typing) return;
      const k = targetRef.current.k;
      const dx = e.key === "ArrowLeft" ? -NUDGE : e.key === "ArrowRight" ? NUDGE : 0;
      const dy = e.key === "ArrowUp" ? -NUDGE : e.key === "ArrowDown" ? NUDGE : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      e.stopPropagation();
      easeTo(targetRef.current.x + dx / k, targetRef.current.y + dy / k);
    },
    [kick, easeTo],
  );

  // Ctrl+F — «найти в графе». Одна клавиша — один смысл: «/» в этом приложении
  // уже значит «команды» в композере «Спросить», а Ctrl+F над библиотекой
  // свободна — строка поиска по книге живёт только при открытой книге (WP-N).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.code !== "KeyF") return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSearchKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Escape") return;
      // Esc в поле никогда не доходит до цепочки приложения: сперва он чистит
      // запрос, потом отпускает поле.
      e.stopPropagation();
      if (q) setQ("");
      else e.currentTarget.blur();
    },
    [q],
  );

  // ---- выбранное ----
  const selNode = sel === null ? null : (model.nodes.find((nd) => nd.id === sel) ?? null);
  const selShard = selNode?.kind === "book" ? (shardByKey.get(selNode.id.slice(2)) ?? null) : null;
  const hoverNode = hover === null ? null : (model.nodes.find((nd) => nd.id === hover) ?? null);

  const empty = shards !== null && shards.length === 0;
  // «Модель не установлена» — тихая приписка, а не тревога: граф в этом
  // состоянии не пустой, просто мельче, чем мог бы быть.
  const shallow = shards !== null && shards.length > 0 && !shards.some((s) => s.stage === "deep");
  // Упавший прогон висит в списке ещё двадцать секунд (graphrun: FAIL_LINGER_MS)
  // — и всё это время считался идущим: строка обещала «Собираю граф · 3 из 40»
  // и предлагала остановить то, что уже стоит. Живые и упавшие разведены (WP-N).
  const live = runs.filter((r) => r.error === null);
  const failed = runs.find((r) => r.error !== null) ?? null;
  const busy = live.length > 0;
  const runDone = live.reduce((a, r) => a + r.done, 0);
  const runTotal = live.reduce((a, r) => a + r.total, 0);

  const buildAll = () => {
    if (!autoBuild()) setAutoBuild(true);
    if (paths?.length) enqueueAll(paths);
  };

  return (
    <div className="h-full flex flex-col" onKeyDown={onKeyDown}>
      {/* (WP-N) Хром графа: имя вида и переключатель «Сетка | Граф» держит
          шапка библиотеки, здесь — отбор, состояние, поиск и выход из
          панорамы. Отдельного заголовка «Граф знаний» тут нет: он уже написан
          в шапке экрана и в сегменте вида. */}
      {/* (WP-N) Строк ДВЕ, и это устройство, а не переполнение. Арифметика не
          оставляет выбора: при открытой панели тулбару достаётся около 1064 px,
          а «Показывать» с семью пилюлями, счётчиком, полем поиска и «Свести к
          центру» просит больше — в одну строку это не помещается НИКОГДА, ни на
          каком окне. Одна строка поэтому и рвалась по случайному месту: крайняя
          пилюля вида уезжала вниз и вставала рядом с полем поиска, читаясь как
          сбой вёрстки. Строки разведены по смыслу: сверху «что показывать»,
          снизу состояние слева и органы вида справа. */}
      <div className="flex flex-col gap-2 px-5 pt-4 pb-3 select-none">
        {/* первая строка — отбор. Переносится внутри себя: пилюль семь, и на
            узком окне вторая их строка читается как продолжение первой */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] text-neutral-500 dark:text-neutral-400 mr-0.5">{t("gr.filter")}</span>
          {KINDS.map((k) => (
            <button
              key={k}
              className={pickClass(kinds.has(k))}
              onClick={() =>
                setKinds((prev) => {
                  const next = new Set(prev);
                  if (next.has(k)) next.delete(k);
                  else next.add(k);
                  return next;
                })
              }
            >
              {t(KIND_KEY[k])}
              {model.counts[k] > 0 && (
                <span className="tabular-nums text-neutral-400 dark:text-neutral-500">{model.counts[k]}</span>
              )}
            </button>
          ))}
        </div>

        {/* вторая строка — состояние слева, органы вида справа */}
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            {/* состояние графа одной строкой: сколько в нём · сколько
                нарисовано. Обрезка ему запрещена (WP-N): «9 поня…» теряет ту
                самую единицу измерения, ради которой число и написано, а
                строка короткая — место под неё есть всегда. Сжимаются соседи
                справа, они длиннее и договаривают то же самое. */}
            <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
              {t("gr.stats", { n: model.books, m: model.total })}
              {model.total > model.drawn ? ` · ${t("gr.drawn", { n: model.drawn, m: model.total })}` : ""}
            </span>

            {busy && (
              <>
                <span className="text-xs tabular-nums truncate text-accent">
                  {`${t("gr.building", { done: runDone, n: runTotal })}${queued > 0 ? ` · ${t("gr.queued", { n: queued })}` : ""}`}
                </span>
                <button className={`${QUIET} shrink-0`} onClick={() => stopAll()}>
                  {t("gr.stopAll")}
                </button>
              </>
            )}

            {/* книга, которая не разобралась: причина слева, глагол справа */}
            {failed && (
              <>
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="size-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden />
                  <span className="text-xs truncate text-neutral-600 dark:text-neutral-300">
                    {t("gr.failed", { title: failed.title })}
                  </span>
                </span>
                <button className={`${QUIET} shrink-0`} onClick={() => rebuild(failed.path)}>
                  {t("gr.rebuild")}
                </button>
              </>
            )}
          </div>

          <span className="flex-1 min-w-[8px]" />

          <div className="flex shrink-0 items-center gap-1.5">
            {/* поле — то же, что в шапке библиотеки, и той же ширины: два поля на
                одном экране, разъехавшиеся на сорок пикселей, читаются как два
                разных органа управления (WP-N) */}
            <div className="flex items-center gap-[7px] w-[200px] h-[30px] px-2 rounded-lg bg-neutral-100 dark:bg-neutral-100/8 border border-neutral-200 dark:border-transparent transition-colors focus-within:border-neutral-300 dark:focus-within:border-neutral-600">
              <span className="text-neutral-400">
                <IconSearch />
              </span>
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder={t("gr.search")}
                spellCheck={false}
                className="flex-1 min-w-0 bg-transparent text-[13px] text-neutral-800 dark:text-neutral-200 outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
              />
              {/* счёт стоит там, где ищут, и при нуле он же и есть «ничего не
                  нашлось» — всплывающей плашки поверх холста больше нет */}
              {q.trim() !== "" && (
                <span className="text-xs tabular-nums whitespace-nowrap text-neutral-400 dark:text-neutral-500">
                  {t("find.count", { done: matches?.set.size ?? 0, n: model.nodes.length })}
                </span>
              )}
              <span
                className="font-mono text-[10px] leading-none py-1 px-1.5 rounded-md whitespace-nowrap select-none text-neutral-400 bg-white dark:bg-neutral-100/8 border border-neutral-200 dark:border-neutral-700"
                title={t("gr.search")}
              >
                {K("Ctrl F")}
              </span>
            </div>

            <button className={QUIET} onClick={fitAll}>
              {t("gr.reset")}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div ref={boxRef} className="relative flex-1 min-w-0">
          <canvas
            ref={canvasRef}
            role="img"
            tabIndex={0}
            aria-label={`${t("gr.title")} · ${t("gr.stats", { n: model.books, m: model.total })}`}
            // outline-none тут не место: холст фокусируемый и владеет стрелками
            // и Escape, а кольцо фокуса приходит само из глобального
            // :focus-visible — гасить его значило бы спрятать от идущего по Tab
            // единственный орган управления графом (WP-N)
            className="absolute inset-0 w-full h-full touch-none"
            style={{ cursor: hover ? "pointer" : "grab" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              if (hoverRef.current === null) return;
              hoverRef.current = null;
              setHover(null);
              kick();
            }}
            onDoubleClick={onDoubleClick}
          />
          {/* подсказка над узлом — тот же оверлей, что у меню, палитры и
              поповера перевода: своей грамматики плашек у графа нет (WP-N) */}
          {hoverNode && (
            <div
              ref={tipRef}
              className="overlay-pop pointer-events-none absolute top-0 left-0 z-10 -translate-x-1/2 -translate-y-full max-w-[240px] px-2 py-1 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur shadow-xl text-[11px] leading-[1.35] text-neutral-800 dark:text-neutral-100 select-none"
            >
              <div className="truncate">{hoverNode.label}</div>
              {hoverNode.kind !== "book" && (
                <div className="tabular-nums text-neutral-500 dark:text-neutral-400">
                  {t("gr.inBooks")} · {hoverNode.books.length}
                </div>
              )}
            </div>
          )}
          {/* пустой граф: состояние слева, глагол с объёмом справа */}
          {empty && (
            <div className="absolute inset-0 flex items-center justify-center px-10 select-none">
              <div className="flex items-center gap-3 flex-wrap justify-center">
                <span className="text-sm text-neutral-800 dark:text-neutral-200">
                  {autoBuild() ? t("gr.empty") : t("gr.emptyOff")}
                </span>
                {autoBuild() ? (
                  paths &&
                  paths.length > 0 && (
                    <button className={SECONDARY} onClick={buildAll}>
                      {t("gr.buildAll", { n: paths.length })}
                    </button>
                  )
                ) : (
                  <button className={SECONDARY} onClick={buildAll}>
                    {t("gr.autoOn")}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Карточка подробностей — настоящий DOM: всё, что нарисовано на
            холсте, читается и здесь, включая экранным диктором. Колонка носит
            раму правой панели приложения (WP-N): поверхность, левая граница,
            шапка 40 px и ручка ширины — второй боковой колонки со своими
            правилами в приложении быть не должно. */}
        <aside
          className="relative flex h-full shrink-0 flex-col border-l border-neutral-300/70 dark:border-neutral-700/70 bg-neutral-50 dark:bg-neutral-800"
          style={{ width: panelW }}
        >
          {/* ручка тянется из общего resize.tsx — та же, что у панели читалки:
              одна ручка на два экрана, и правила протяжки едут вместе с ней */}
          <ResizeHandle onWidth={setPanelW} width={panelW} />

          <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-neutral-200 dark:border-neutral-700 px-3">
            <span className="text-[13px] text-neutral-800 dark:text-neutral-100">{t("gr.title")}</span>
            <span className="flex-1" />
            {/* крестик снимает выбор — ровно то же, что Escape на холсте */}
            {selNode && (
              <button
                className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-900/5 hover:text-neutral-700 dark:hover:bg-neutral-100/10 dark:hover:text-neutral-200"
                onClick={() => {
                  selRef.current = null;
                  setSel(null);
                  kick();
                }}
                title={t("ui.close")}
              >
                <IconClose />
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {/* модель не установлена: состояние, глагол и тихая приписка о том,
                что в графе всё-таки есть */}
            {shallow && (
              <div className="mb-4 pb-4 border-b border-neutral-200 dark:border-neutral-700">
                <div className="flex items-center gap-3">
                  <span className="text-[13px] text-neutral-800 dark:text-neutral-200">{t("gr.noModel")}</span>
                  <span className="flex-1" />
                  {onSetupModel && (
                    <button className={QUIET} onClick={onSetupModel}>
                      {t("model.downloadShort")}
                    </button>
                  )}
                </div>
                <div className="mt-1 text-[11px] leading-[1.45] text-neutral-400 dark:text-neutral-500">
                  {t("gr.noModelHint")}
                </div>
              </div>
            )}

            {!selNode && (
              <div className="text-[13px] leading-[1.45] text-neutral-500 dark:text-neutral-400">
                {t("gr.selectHint")}
              </div>
            )}

            {selNode && selNode.kind === "book" && (
              <div>
                <div className="text-base leading-[1.3] text-neutral-800 dark:text-neutral-200">{selNode.label}</div>
                {selShard && selShard.authors.length > 0 && (
                  <div className="mt-1 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                    {selShard.authors.join(", ")}
                    {selShard.year !== null && ` · ${selShard.year}`}
                  </div>
                )}

                {/* Происхождение: чип с состоянием на своей строке, оба глагола
                    рядом под ним. В одну строку пара помещалась «почти», и
                    решало это слово в чипе — «Открытая статья» строку держала,
                    «Происхождение неясно» рвало, — так что высота карточки
                    зависела от того, какую книгу выбрали и на каком языке она
                    подписана. Перенос, который на штатных 380 случается всё
                    равно, дешевле сделать замыслом (WP-N). «Изменить» при этом
                    остаётся в ряду с «Показать доказательства», а не сиротой
                    строкой ниже. */}
                <div className="mt-3 flex flex-col items-start gap-2">
                  <span className="px-2 py-0.5 rounded-full text-[11px] bg-neutral-100 dark:bg-neutral-100/8 text-neutral-700 dark:text-neutral-300">
                    {t(PROV_KEY[selNode.prov ?? "unknown"])}
                  </span>
                  <span className="flex items-center gap-3">
                    <button
                      className="text-[11px] text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
                      onClick={() => setWhy((v) => !v)}
                    >
                      {t("gr.prov.why")}
                    </button>
                    {selShard && (
                      <button
                        className="text-[11px] text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
                        onClick={() => setChanging((v) => !v)}
                      >
                        {t("gr.prov.change")}
                      </button>
                    )}
                  </span>
                </div>

                {why && (
                  <div className="mt-2 text-[11px] leading-[1.45] text-neutral-500 dark:text-neutral-400">
                    {selShard?.evidence.length ? (
                      <ul>
                        {selShard.evidence.map((line, i) => (
                          <li key={i}>· {line}</li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="mt-1.5">{t("gr.prov.hint")}</div>
                  </div>
                )}

                {/* происхождение — выбор ОДНОГО из трёх, поэтому и одет как
                    сегмент: дорожка и белая приподнятая пилюля (WP-N) */}
                {changing && selShard && (
                  <div className={`mt-2 flex-wrap ${SEGMENT}`}>
                    {PROVS.map((p) => (
                      <button
                        key={p}
                        className={segClass(selShard.prov === p)}
                        onClick={() => {
                          setChanging(false);
                          void setProvenance(selShard.key, p);
                        }}
                      >
                        {t(PROV_KEY[p])}
                      </button>
                    ))}
                  </div>
                )}

                {selShard && selShard.tags.length > 0 && (
                  <div className="mt-3 flex gap-1 flex-wrap">
                    {selShard.tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-0.5 rounded-full text-[11px] text-neutral-600 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-100/8"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Действия книги и подпись к ним. «Локальная модель» висела
                    приглушённой строкой НАД кнопками и не относилась ни к
                    чему видимому — а это и есть причина при глаголе
                    «Перестроить»: чем книга разобрана и чем разберётся заново.
                    Причина слева, глагол справа, одна строка (§4, WP-N).
                    Обрезка подписи запрещена ровно как счётчику графа выше:
                    «Локальная мо…» не говорит уже ничего, ради чего подпись
                    писалась. Поэтому причина и глагол связаны в нерушимую
                    группу, а не ужимаются поодиночке: не хватило места —
                    группа целиком уезжает под кнопку и там читается вся. */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <button
                    className={SECONDARY}
                    onClick={() => {
                      const path = selShard?.bookPath ?? selNode.path;
                      if (path) onOpen(path);
                    }}
                  >
                    {t("gr.openBook")}
                  </button>
                  {selShard && (
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                        {t(ENGINE_KEY[selShard.engine])}
                      </span>
                      <button className={QUIET} onClick={() => rebuild(selShard.bookPath)}>
                        {t("gr.rebuild")}
                      </button>
                    </span>
                  )}
                </div>
              </div>
            )}

            {selNode && selNode.kind !== "book" && (
              <div>
                <div className="text-base leading-[1.3] text-neutral-800 dark:text-neutral-200">{selNode.label}</div>
                <div className="mt-1 text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500">
                  {t(KIND_KEY[selNode.kind])} · {t("gr.mentions", { n: Math.round(selNode.weight) })}
                </div>
                {selNode.gloss && (
                  <div className="mt-2 text-[13px] leading-[1.45] text-neutral-600 dark:text-neutral-300">
                    {selNode.gloss}
                  </div>
                )}
                <div className="mt-4 text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  {t("gr.inBooks")}
                </div>
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {selNode.books.map((key) => {
                    const s = shardByKey.get(key);
                    if (!s) return null;
                    const pages = selNode.pages?.[key] ?? [];
                    return (
                      <button
                        key={key}
                        className="text-left rounded-md px-2 py-1 -mx-2 transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10"
                        onClick={() => onOpen(s.bookPath)}
                      >
                        <div className="text-xs leading-[1.35] text-neutral-700 dark:text-neutral-300">
                          {s.title.trim() || s.bookPath}
                        </div>
                        {pages.length > 0 && (
                          <div className="text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500">
                            {t("gr.page", { n: pages.join(", ") })}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---- рама панели ------------------------------------------------------------

/* Лупа поля поиска — тот же глиф, что в шапке библиотеки (WP-N). */
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

// ---- мелочи -----------------------------------------------------------------

/// Пилюля-фишка происхождения. Своими руками, а не ctx.roundRect: последний
/// появился в WebKit только в 16.4, а приложение собирается и под macOS, где
/// системный webview обновляется вместе с системой — потерять фишку на чужой
/// машине дороже, чем написать две дуги.
function pill2d(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = h / 2;
  ctx.beginPath();
  ctx.arc(x + r, y + r, r, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, (Math.PI * 3) / 2, Math.PI / 2);
  ctx.closePath();
}

/// Обрезка подписи по ШИРИНЕ, а не по числу букв: «Иллюстрированная история»
/// и "Illustrated history" при одинаковой длине занимают разное место, а
/// налезающие друг на друга подписи — первое, что убивает читаемость графа.
/// Двоичный поиск, потому что measureText на каждую букву длинного названия в
/// кадре с сотней подписей уже заметен.
function clip(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${s.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo).trimEnd()}…`;
}
