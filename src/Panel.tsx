// (WP-N) Правая панель направления B: четыре вкладки — «Оглавление · Спросить ·
// Термины · Перевод» — и всё, что не про саму страницу книги, живёт в них.
// Панель — обычный флекс-сосед области чтения, а не оверлей: область чтения
// сжимается, страницу панель не накрывает НИКОГДА.
//
// Хозяин здесь только рисует раму: строку вкладок, крестик, ручку ширины и
// тело активной вкладки. Тела приходят пропсами и остаются СМОНТИРОВАННЫМИ,
// когда вкладка неактивна (`hidden`): у «Спросить» может идти поток ответа, у
// «Оглавления» — фоновое разрешение назначений строк, у «Терминов» — прогон
// по книге, который переживает переключение вкладки.
//
// ---- сколько места просит строка из четырёх вкладок -------------------------
//
// Четвёртая вкладка сделала строку заголовка САМЫМ ШИРОКИМ, что есть в панели,
// и это пришлось померить, а не прикинуть. Ширины ниже — суммы горизонтальных
// метрик Golos Text (src/fonts/golos-*.woff2, upem 1000) на 13 px для подписей
// и 11 px для ярлыков; кернинг не учтён (для этих строк он около нуля):
//
//   Оглавление 76,4 · Спросить 60,7 · Термины 58,3 · Перевод 55,8  = 251,2 px
//   Contents   57,5 · Ask      23,0 · Terms   39,1 · Translation 71,3 = 190,8 px
//   ярлыки: «40%» 22,8 · «100» 17,0 · точка внимания 6
//
// Русский ряд и есть ограничение. При px-2 (16 px на вкладку) и раме
// (px-2 = 16, зазоры 3×2 = 6 внутри группы + 2 до крестика, крестик p-1+14 = 22)
// голый ряд просит 251,2 + 64 + 16 + 6 + 2 + 22 = 361,2 px, а с обоими ярлыками
// (у «Спросить» число, у «Перевода» проценты, каждый со своим зазором 4) —
// 409,0 px. Отсюда PANEL_W_MIN = 412 в App.tsx: минимум панели поднят до него,
// иначе четыре подписи в 320 px (ASK_W_MIN) не помещаются НИКАК — при нулевых
// отступах на подписи остаётся 271 px, ровно впритык, и это ещё до ярлыков.
// Английский ряд влезал бы и в 320 (голый — 300,8), но ширина одна на оба языка.
//
// Отступ вкладки поэтому px-2, а не px-3, как было у трёх: строка из четырёх
// имён — уже плотный ряд, и 32 px, которые это отдаёт, сняты с ширины панели,
// а не с читаемости.
//
// Последний клапан — перенос: при узком ОКНЕ (askWMax() = innerWidth − 360
// может оказаться меньше 412) группа вкладок переносится на вторую строку, и
// заголовок становится выше. Некрасиво и редко, но ни одна вкладка не обрезана
// и крестик остаётся на месте — это ровно то, чего строка со скроллом или с
// многоточием не даёт.

import { useRef } from "react";
import type { ReactNode } from "react";
import { useDependencies } from "./Depends";
import { t } from "./i18n";
import { IconClose } from "./icons";
import { ResizeHandle } from "./resize";

export type PanelTab = "outline" | "ask" | "glossary" | "translate";

// вкладка: 13px, скруглённая заливка на активной; неактивная — тихий текст с
// единственным в приложении языком наведения. Отступы и зазор ярлыка ужаты
// (px-3 → px-2, gap-1.5 → gap-1) под четвёртую вкладку — арифметика вверху.
const TAB = "flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] transition-colors whitespace-nowrap";
const TAB_ON = "bg-neutral-100 dark:bg-neutral-100/8 text-neutral-900 dark:text-neutral-100";
const TAB_OFF =
  "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";

/** Ярлык вкладки: число акцентом, или янтарная точка, когда прогон встал (§1). */
function Badge({ text, attention }: { text?: string; attention?: boolean }) {
  if (attention) return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500" />;
  if (!text) return null;
  return <span className="shrink-0 text-[11px] tabular-nums text-accent">{text}</span>;
}

// (WP-N) Ярлыки живут отдельным компонентом ради лени: useDependencies — это
// просмотр PATH, а Panel монтируется на каждое открытие книги, даже когда
// панель закрыта. Ярлыки же монтируются, только когда панель открыли (см.
// ниже), так что за янтарную точку на «Спросить» больше не платит тот, кто
// просто читает.
function Tabs({
  tab,
  onTab,
  askCount,
  glossCount,
  trPct,
  trAttention,
}: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  askCount?: number;
  glossCount?: number;
  trPct?: number | null;
  trAttention?: boolean;
}) {
  // Точка внимания на «Спросить» — это ровно «Claude Code не найден», и панель
  // узнаёт об этом сама. Сигнал из AskSidebar наверх не всплывает (там он
  // рождается только на неудачном запуске, уже после вопроса), а тянуть его
  // через App значило бы вести провод через весь файл ради одного пикселя.
  // Пока ответа нет (null) точку не рисуем: «ещё не спрашивали» — не то же
  // самое, что «не нашли».
  const { claude } = useDependencies();
  const askAttention = claude?.installed === false;

  // Число стоит в ярлыке, только если ему есть что сказать (§1): у переведённой
  // книги «Перевод 100%» — единственный акцент, который никогда не гаснет и
  // тянет на себя взгляд при каждом чтении. Готовому переводу хватает слова.
  // Сотня и есть «готово»: trPct приходит из floor(100·done/total) и достаёт до
  // ста ровно тогда, когда переведены все страницы.
  const pct = typeof trPct === "number" && trPct < 100 ? trPct : null;

  const tabs: { id: PanelTab; label: string; badge?: string; attention?: boolean; title: string }[] = [
    { id: "outline", label: t("panel.outline"), title: t("panel.outline") },
    {
      id: "ask",
      label: t("panel.ask"),
      badge: askCount ? String(askCount) : undefined,
      attention: askAttention,
      // точка называет причину, а не «требует внимания»: причина тут одна
      title: askAttention
        ? t("ob.claudeMissing")
        : askCount
          ? t("panel.askBadge", { n: askCount })
          : t("panel.ask"),
    },
    {
      // (WP-N) Число терминов живёт в подсказке, а не в ярлыке: ярлык — это
      // «требует внимания» или «идёт прогон», а список терминов не меняется
      // сам по себе и торопить им читателя нечем. Плюс два числа в ряду из
      // четырёх вкладок — это ещё 21 px ширины панели (см. арифметику вверху).
      id: "glossary",
      label: t("panel.glossary"),
      title: glossCount ? t("gl.terms", { n: glossCount }) : t("panel.glossary"),
    },
    {
      id: "translate",
      label: t("panel.translate"),
      badge: pct === null ? undefined : `${pct}%`,
      attention: trAttention,
      title: trAttention
        ? t("panel.attention")
        : pct === null
          ? t("panel.translate")
          : t("panel.trBadge", { pct }),
    },
  ];

  return (
    <>
      {tabs.map((x) => (
        <button
          aria-selected={tab === x.id}
          className={`${TAB} ${tab === x.id ? TAB_ON : TAB_OFF}`}
          key={x.id}
          onClick={() => onTab(x.id)}
          role="tab"
          title={x.title}
        >
          {x.label}
          <Badge attention={x.attention} text={x.badge} />
        </button>
      ))}
    </>
  );
}

export function Panel({
  open,
  tab,
  onTab,
  onClose,
  width,
  onWidth,
  askCount,
  glossCount,
  trPct,
  trAttention,
  outline,
  ask,
  glossary,
  translate,
}: {
  open: boolean;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  /** живая ширина панели (useAskWidth, ключ pdfer:askw) — её владелец App */
  width: number;
  onWidth: (w: number) => void;
  /** «Спросить 3» — сообщений в открытой беседе; 0 или undefined — без ярлыка */
  askCount?: number;
  /** терминов в глоссарии книги — только для подсказки вкладки, не для ярлыка */
  glossCount?: number;
  /** «Перевод 40%» — процент прогона; null, undefined или 100 — без ярлыка */
  trPct?: number | null;
  /** прогон на паузе или сорвался — вместо числа янтарная точка */
  trAttention?: boolean;
  outline: ReactNode;
  ask: ReactNode;
  glossary: ReactNode;
  translate: ReactNode;
}) {
  // (WP-N) Ярлыки монтируются с ПЕРВЫМ открытием панели и дальше остаются
  // смонтированными: их useDependencies — просмотр PATH со спавном процесса.
  // Кто панель не открывал, за него не платит вовсе; кто открывает и закрывает
  // её по ходу чтения — платит один раз, а не на каждое переключение.
  const everOpen = useRef(open);
  if (open) everOpen.current = true;

  return (
    <aside
      // data-asksb остаётся: цепочка Esc в App.tsx ищет фокус именно по нему
      data-asksb
      data-panel
      className={`${open ? "flex" : "hidden"} relative h-full shrink-0 flex-col border-l border-neutral-300/70 dark:border-neutral-700/70 bg-neutral-50 dark:bg-neutral-800 text-sm text-neutral-800 dark:text-neutral-100`}
      style={{ width }}
    >
      {/* ручка и правила её протяжки — общий модуль resize.tsx: та же ручка
          стоит у карточки графа, и двумя она быть не имеет права (WP-N) */}
      <ResizeHandle onWidth={onWidth} width={width} />

      {/* min-h-10, а не h-10: группа вкладок умеет переноситься (см. арифметику
          в шапке файла), и в этом единственном случае заголовок становится
          выше вместо того, чтобы что-нибудь обрезать. Крестик стоит рядом с
          группой, а не за распоркой — при переносе распорка увела бы его на
          вторую строку влево. */}
      <div className="flex min-h-10 shrink-0 select-none items-center gap-0.5 border-b border-neutral-200 dark:border-neutral-700 px-2 py-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
          {/* закрытая панель ярлыков не показывает, а их монтирование стоит
              просмотра PATH (см. Tabs) — до первого открытия их тут нет */}
          {everOpen.current && (
            <Tabs
              askCount={askCount}
              glossCount={glossCount}
              onTab={onTab}
              tab={tab}
              trAttention={trAttention}
              trPct={trPct}
            />
          )}
        </div>
        <button
          className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-900/5 hover:text-neutral-700 dark:hover:bg-neutral-100/10 dark:hover:text-neutral-200"
          onClick={onClose}
          title={t("panel.close")}
        >
          <IconClose />
        </button>
      </div>

      {/* Все четыре тела смонтированы всегда, прячется лишь неактивное: у
          «Спросить» может идти поток ответа, у «Оглавления» — фоновое
          разрешение назначений, у «Терминов» — чтение книги целиком.
          `flex`/`hidden` — именно ветвление, а не два класса разом: обе
          утилиты пишут display, и порядок решал бы за нас. */}
      <div className={`min-h-0 flex-1 flex-col ${tab === "outline" ? "flex" : "hidden"}`}>{outline}</div>
      <div className={`min-h-0 flex-1 flex-col ${tab === "ask" ? "flex" : "hidden"}`}>{ask}</div>
      <div className={`min-h-0 flex-1 flex-col ${tab === "glossary" ? "flex" : "hidden"}`}>{glossary}</div>
      <div className={`min-h-0 flex-1 flex-col ${tab === "translate" ? "flex" : "hidden"}`}>{translate}</div>
    </aside>
  );
}
