// (WP-N) Вкладка «Перевод» — бывшее выпадающее меню «Перевод ▾», развёрнутое
// в панель. Сверху вниз:
//   карточка прогона   состояние · числа · два глагола (четыре состояния)
//   строки действий    глоссарий, экспорты, перевести заново
//   «Что умеет выделение»  три строки с клавишами (бывшая подсказка библиотеки)
//   строка модели      имя, вес, а при беде — причина с глаголом
//
// Логики здесь нет НИКАКОЙ: запуск, пауза, обновление, экспорт и глоссарий
// приходят пропсами, вычисления и вызовы booktranslate остаются в App.tsx.
// Своего состояния ровно два, и оба раскрывают текст на месте, без экранов:
// взвод подтверждения на «Перевести заново» (разрушительное называет объём и
// ждёт второго клика, §4.6) и одно предложение под отказом по скану.

import { useState } from "react";
import { BookOpenIcon, CodeXmlIcon, FileTextIcon, RotateCcwIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Spinner, dlBusy, dlPct, sizeLabel, statusUp } from "./ModelSetup";
import type { Dl } from "./ModelSetup";
import { t } from "./i18n";

/** Четыре состояния карточки прогона — ровно те, что в макете Translate. */
export type TrState = "idle" | "running" | "paused" | "done";

/** Отказ, который печатается строкой действия: причина слева, глагол справа. */
export type TrExportError = { kind: "pdf" | "html"; reason: string };

const MODEL_NAME = "HY-MT1.5";

// строка действия: иконка · подпись · число или клавиша справа
const ROW =
  "flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";
// главная кнопка карточки — тёмная заливка; тихая — только контур.
// (WP-N) цвета — те же, что у PRIMARY в Depends.tsx и ModelSetup.tsx: размер
// здесь свой (панель узкая), а «чернила на бумаге» в приложении одни
const BTN_MAIN =
  "rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white";
const BTN_QUIET =
  "rounded-lg border border-neutral-200 dark:border-neutral-700 px-3.5 py-1.5 text-[13px] font-medium text-neutral-700 dark:text-neutral-300 transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";
const BTN_RED =
  "-mx-1 rounded-lg px-1 py-1.5 text-[13px] font-medium text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/10";
// заголовок группы: 11px, разрядка, капитель
const CAP = "px-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-neutral-400 dark:text-neutral-500";
// клавиша в подсказке о выделении
const KEY =
  "rounded-md bg-neutral-900/5 dark:bg-neutral-100/8 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500 dark:text-neutral-400";

/** Строка-отказ: причина слева, глагол справа, янтарная подложка. */
function Refusal({
  cause,
  verb,
  expanded,
  onVerb,
}: {
  cause: string;
  verb?: string;
  /** глагол раскрывает текст под строкой — тогда он и рассказывает об этом */
  expanded?: boolean;
  onVerb?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2.5 rounded-lg bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-400">
      <span className="min-w-0">{cause}</span>
      {verb && (
        <button
          aria-expanded={expanded}
          className="shrink-0 rounded-md px-1 text-xs text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          onClick={onVerb}
        >
          {verb}
        </button>
      )}
    </div>
  );
}

function ActionRow({
  icon: Icon,
  label,
  hint,
  sub,
  red,
  disabled,
  title,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  sub?: string;
  red?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      className={`${ROW} ${red ? "text-red-600 dark:text-red-400" : "text-neutral-700 dark:text-neutral-300"} ${
        disabled ? "opacity-50" : ""
      }`}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0 self-start" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {sub && <span className="block truncate text-xs tabular-nums text-neutral-500 dark:text-neutral-400">{sub}</span>}
      </span>
      {hint && <span className="shrink-0 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">{hint}</span>}
    </button>
  );
}

export function TranslatePanel({
  state,
  done,
  total,
  pct,
  eta,
  reason,
  noTextLayer,
  updPct = 0,
  glossaryTerms,
  pdfExport,
  pdfBusy,
  exportError,
  startError,
  modelStatus,
  modelDl,
  onStart,
  onPause,
  onResume,
  onUpdate,
  onRetranslate,
  onCheckModel,
  onGlossary,
  onExportPdf,
  onExportHtml,
  onModelSetup,
  onModelRestart,
}: {
  /** какое из четырёх состояний печатает карточка */
  state: TrState;
  /** страниц сохранено в хранилище */
  done: number;
  /** страниц в книге */
  total: number;
  /** доля, которую показывает полоса, 0–100 (для «обновления» это его свои страницы) */
  pct: number;
  /** остаток времени, УЖЕ со своим « · » впереди — t("tr.etaMin") и родня */
  eta?: string;
  /** причина паузы, УЖЕ со своим « · » впереди — t("tr.modelGone") */
  reason?: string;
  // Оценки «сколько займёт весь перевод» здесь нет и взять её неоткуда:
  // движок считает etaMs скользящим средним по УЖЕ переведённым страницам и
  // хранит его в живом ране, а на диске (BookTranslation) нет ни одной метки
  // времени — ни по этой книге, ни по прошлым. До первой страницы измерять
  // нечего, а константа «столько-то мс на страницу» была бы выдумкой: на
  // 5080 и на ноутбучной интеграшке это разные книги. Молчим (WP-N).
  /** книга — скан: переводить нечего, вместо кнопки честный отказ */
  noTextLayer?: boolean;
  /** водяной знак прерванного «Обновить перевод», 0 — обновление не начиналось */
  updPct?: number;
  /** терминов в глоссарии книги; undefined — числа справа не будет */
  glossaryTerms?: number;
  /** платформа умеет печатать PDF молча (host().pdfExport) */
  pdfExport: boolean;
  /** идёт печать PDF — строка становится спиннером */
  pdfBusy: boolean;
  /** последний отказ экспорта: печатается в своей же строке, без тостов */
  exportError?: TrExportError | null;
  /** прогон не начался — книга не переоткрылась под него (App.startTr) */
  startError?: boolean;
  /** ModelSetup.ModelStatus; null — состояние ещё не спрашивали */
  modelStatus: string | null;
  /** скачивание основной модели (useDownload("main")) */
  modelDl: Dl;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onUpdate: () => void;
  /** вызывается только после подтверждения — карточка взводит его сама */
  onRetranslate: () => void;
  /** «Проверить модель» на паузе; без него кнопки не будет */
  onCheckModel?: () => void;
  onGlossary: () => void;
  onExportPdf: () => void;
  onExportHtml: () => void;
  onModelSetup: () => void;
  onModelRestart: () => void;
}) {
  // взвод «Перевести заново»: разрушительное называет объём и ждёт второго клика
  const [confirmRedo, setConfirmRedo] = useState(false);
  // «Что это значит» под отказом по скану: раскрыто / свёрнуто
  const [ocrHelp, setOcrHelp] = useState(false);

  const running = state === "running";
  const paused = state === "paused";
  const finished = state === "done";
  const hasStore = state !== "idle";
  const dotColor = paused ? "bg-amber-500" : "bg-accent";
  const barColor = paused ? "bg-amber-500" : "bg-accent";
  const stateWord = running
    ? t("tr.stateRunning")
    : paused
      ? t("tr.statePaused")
      : finished
        ? t("tr.stateDone")
        : t("tr.stateIdle");
  // хвост состояния: «Идёт» получает срок, «Пауза» — причину. «Книга
  // переведена» молчит: её числа стоят строкой ниже, повторять их нечего.
  const stateTail = running ? eta : paused ? reason : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-3">
      {/* ---- карточка прогона: состояние, числа, два глагола ---- */}
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-3.5">
        {hasStore ? (
          <>
            <div className="flex items-center gap-2 text-[13px]">
              <span aria-hidden className={`size-[7px] shrink-0 rounded-full ${dotColor}`} />
              <span className="min-w-0">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{stateWord}</span>
                {stateTail && <span className="tabular-nums text-neutral-500 dark:text-neutral-400">{stateTail}</span>}
              </span>
            </div>
            <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-100/8">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ${barColor}`}
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </div>
            <div className="mt-2 flex justify-between gap-3 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
              <span className="min-w-0 truncate">{t("tr.pagesKept", { done, n: total })}</span>
              <span className="shrink-0">{pct}%</span>
            </div>
          </>
        ) : noTextLayer ? (
          // скан: кормить модель нечем — честный отказ вместо кнопки, которая
          // мгновенно «переведёт» пустоту. «Что это значит» разворачивает одно
          // предложение прямо тут же, в этой карточке: отдельного экрана про
          // OCR в приложении нет и заводить его ради одной фразы незачем.
          <>
            <Refusal
              cause={t("err.needOcr")}
              expanded={ocrHelp}
              onVerb={() => setOcrHelp((v) => !v)}
              verb={t("err.whatIsThis")}
            />
            {ocrHelp && (
              <div className="mt-2 px-3 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                {t("err.needOcrBody")}
              </div>
            )}
          </>
        ) : null}

        {/* два глагола — ровно те, что состояние допускает. До старта карточка
            пуста, так что отступ сверху нужен только под уже сказанным. */}
        {!(state === "idle" && noTextLayer) && (
          <div className={`flex flex-wrap gap-2 ${hasStore ? "mt-3" : ""}`}>
            {state === "idle" && (
              <button className={BTN_MAIN} onClick={onStart} title={t("tr.startTitle")}>
                {t("tr.start", { n: total })}
              </button>
            )}
            {running && (
              <button className={BTN_QUIET} onClick={onPause}>
                {t("tr.pause")}
              </button>
            )}
            {paused && (
              <>
                <button className={BTN_MAIN} onClick={onResume} title={t("tr.resumeTitle", { done, total })}>
                  {t("tr.resumeShort")}
                </button>
                {onCheckModel && (
                  <button className={BTN_QUIET} onClick={onCheckModel}>
                    {t("tr.checkModel")}
                  </button>
                )}
              </>
            )}
            {finished && (
              <button className={`${BTN_MAIN} tabular-nums`} onClick={onUpdate} title={t("tr.updateTitle")}>
                {updPct > 0 ? t("tr.updateResume", { pct: updPct }) : t("tr.update")}
              </button>
            )}
          </div>
        )}

        {/* (WP-N) Прогон не начался. Глагол повторяет ровно тот, что не сработал —
            состояние карточки его и называет. */}
        {startError && (
          <div className="mt-2.5">
            <Refusal
              cause={t("tr.startFailed")}
              onVerb={finished ? onUpdate : paused ? onResume : onStart}
              verb={t("ui.retry")}
            />
          </div>
        )}
      </div>

      {/* ---- строки действий ---- */}
      <div className="mt-2.5 flex flex-col gap-0.5">
        {/* (WP-N) Глоссарий перестал быть частью перевода и уехал в свою
            вкладку «Термины»; эта строка осталась перекрёстной ссылкой и
            открывает её (onGlossary у App). Число справа теперь считает
            ЗАПИСИ файла, а не переведённые пары: запись без перевода —
            полноценная запись, и прятать её было бы враньём про размер
            списка. Перевод от глоссария по-прежнему не зависит ничем: ни
            пустой список, ни отсутствие модели терминов его не запирают. */}
        <ActionRow
          hint={glossaryTerms === undefined ? undefined : String(glossaryTerms)}
          icon={BookOpenIcon}
          label={t("tr.glossary")}
          onClick={onGlossary}
          title={t("tr.glossaryTitle")}
        />
        {hasStore && done > 0 && pdfExport && (
          pdfBusy ? (
            <div className={`${ROW} pointer-events-none text-neutral-500 dark:text-neutral-400`}>
              <Spinner /> {t("tr.pdfPreparing")}
            </div>
          ) : exportError?.kind === "pdf" ? (
            <Refusal
              cause={t("err.exportPdf", { reason: exportError.reason })}
              onVerb={onExportPdf}
              verb={t("ui.retry")}
            />
          ) : (
            <ActionRow
              icon={FileTextIcon}
              label={t("tr.exportPdf")}
              onClick={onExportPdf}
              sub={done < total ? t("tr.exportPartial", { done, n: total }) : undefined}
              title={t("tr.exportPdfTitle")}
            />
          )
        )}
        {hasStore && done > 0 &&
          (exportError?.kind === "html" ? (
            <Refusal
              cause={t("err.exportHtml", { reason: exportError.reason })}
              onVerb={onExportHtml}
              verb={t("ui.retry")}
            />
          ) : (
            <ActionRow
              icon={CodeXmlIcon}
              label={t("tr.exportHtml")}
              onClick={onExportHtml}
              title={t("tr.exportHtmlTitle")}
            />
          ))}
        {hasStore &&
          (confirmRedo ? (
            <div className="px-3 py-1.5">
              <div className="text-[13px] text-neutral-600 dark:text-neutral-300">{t("tr.redoWarn", { n: done })}</div>
              <div className="mt-1 flex items-center gap-3">
                <button
                  className={BTN_RED}
                  onClick={() => {
                    setConfirmRedo(false);
                    onRetranslate();
                  }}
                >
                  {t("tr.redoConfirm")}
                </button>
                <button
                  className="-mx-1 rounded-lg px-1 py-1.5 text-[13px] transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10"
                  onClick={() => setConfirmRedo(false)}
                >
                  {t("ui.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <ActionRow
              disabled={running}
              icon={RotateCcwIcon}
              label={t("tr.redo")}
              onClick={() => setConfirmRedo(true)}
              red
              title={t("tr.redoTitle")}
            />
          ))}
      </div>

      {/* ---- что умеет выделение (переехало из подсказки библиотеки) ---- */}
      <div className="mt-3.5 border-t border-neutral-200 dark:border-neutral-700 pt-3">
        <div className={CAP}>{t("tr.selectionTitle")}</div>
        <div className="mt-1.5 flex flex-col gap-0.5">
          {(
            [
              [t("tr.selTranslate"), "Enter"],
              [t("tr.selPara"), t("tr.selParaKey")],
              [t("tr.selToggle"), "T"],
            ] as const
          ).map(([label, key]) => (
            <div
              className="flex items-center justify-between gap-3 px-3 py-1 text-xs text-neutral-500 dark:text-neutral-400"
              key={label}
            >
              <span className="min-w-0 truncate">{label}</span>
              <span className={KEY}>{key}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1" />

      {/* ---- строка модели ---- */}
      <ModelLine
        dl={modelDl}
        onRestart={onModelRestart}
        onSetup={onModelSetup}
        status={modelStatus}
      />
    </div>
  );
}

// Строка модели внизу вкладки. Пока всё в порядке — имя и вес, и больше
// ничего: успех молчит (§4.5). Когда модель требует внимания, строка целиком
// отдаётся причине с глаголом — тем же словарём, что жил в меню «Перевод ▾».
function ModelLine({
  status,
  dl,
  onSetup,
  onRestart,
}: {
  status: string | null;
  dl: Dl;
  onSetup: () => void;
  onRestart: () => void;
}) {
  const base = `${MODEL_NAME} · ${sizeLabel("main")}`;
  const wrap = "mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-2.5 text-xs";
  const quiet = "text-left text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-700 dark:hover:text-neutral-200";

  if (dlBusy(dl))
    return (
      <div className={wrap}>
        <button className={`${quiet} tabular-nums`} onClick={onSetup} title={t("model.bgDownload")}>
          {t("model.downloading", { pct: dlPct(dl) })}
        </button>
      </div>
    );
  if (status === "starting" || (dl.status === "done" && !statusUp(status)))
    return (
      <div className={`${wrap} flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400`}>
        <Spinner /> {t("model.starting")}
      </div>
    );
  if (status === "dead")
    return (
      <div className={wrap}>
        <button className={quiet} onClick={onRestart}>
          {t("model.deadRestart")}
        </button>
      </div>
    );
  if (status === "noengine")
    return (
      <div className={wrap}>
        <button className={quiet} onClick={onSetup}>
          {t("model.noEngine")}
        </button>
      </div>
    );
  if (status === "none")
    return (
      <div className={wrap}>
        <button className={quiet} onClick={onSetup}>
          {t("model.notInstalled", { size: sizeLabel("main") })}
        </button>
      </div>
    );
  return <div className={`${wrap} tabular-nums text-neutral-500 dark:text-neutral-400`}>{base}</div>;
}
