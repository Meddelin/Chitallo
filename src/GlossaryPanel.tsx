// (WP-N) Вкладка «Термины» — глоссарий книги, ставший самостоятельным.
//
// До этой волны он был модалкой, которую открывали из перевода, лежал на полке
// «Перевод» в палитре и везде назывался переводом терминов. Теперь это своя
// вкладка со своим хранилищем, а перевод — один из потребителей наравне с
// графом, «Спросить» и экспортом. Соответственно и словарь тут другой: не
// «собрать и перевести», а «найти · определить · проверить».
//
// Тело пришло из GlossaryModal (TranslatePopover.tsx): поле файла, кнопка с
// прогоном внутри неё, «Остановить», взвод «Собрать заново» с подтверждением,
// предложение поставить модель терминов, автосохранение и правила слияния на
// полпути — всё это выстрадано и перенесено, а не переписано. Новое здесь
// ровно три вещи:
//
//   1. Язык книги — поле записи, а не язык интерфейса. От него зависит, какие
//      слова вообще считаются терминами (см. terms.ts), поэтому строка стоит
//      ВЫШЕ прогонов и её можно поправить до того, как книгу прочитают.
//   2. Три прохода — три отдельных действия со своим прогрессом и своим
//      отчётом. Первый не требует модели вовсе и об этом сказано вслух.
//   3. Книге, которую переводить не нужно, про перевод терминов не говорят
//      ни слова — вместо этого одна честная строка о том, почему колонка
//      перевода останется пустой.
//
// СРОК ЖИЗНИ — то, что переезд из модалки поменял под всей этой логикой, и
// то, из чего вышла половина дефектов первой правки. Модалку размонтировали
// вместе с книгой: «панель закрылась» и «книга кончилась» были одним и тем же
// событием, и любое состояние, принадлежащее книге, чистилось само собой.
// Вкладка так не живёт. App рисует её, пока `doc && path` (App.tsx), Panel
// держит все четыре тела смонтированными и прячет неактивное классом, а
// loadBytes при переходе к другой книге не обнуляет `doc` — он идёт прямо в
// setDoc/setPath. То есть при смене книги панель НЕ пересоздаётся: меняется
// одно свойство `bookPath`.
//
// Отсюда два правила, которые здесь соблюдаются буквально:
//
//   - closedRef значит «панели больше нет» и НИЧЕГО про книгу. Взводить его на
//     смене bookPath нельзя: React выполняет все уборки до всех тел, поэтому
//     проход, начатый на прежней книге, увидел бы closedRef уже сброшенным и
//     дописал бы её глоссарий в панель, показывающую следующую. Вопрос «моя ли
//     это ещё книга» задаётся отдельно — gone().
//   - всё, что принадлежит книге, а не панели, чистится вручную в эффекте
//     [bookPath]: текст, сохранённое, язык, уверенность, отчёт, идущий прогон,
//     взведённое подтверждение. Список полный намеренно — забытое поле здесь
//     выглядит не как ошибка, а как чужая книга на экране.
//
// ФАЙЛ — общий. Кроме поля в него пишут «Добавить в глоссарий» из книги и
// глубокий проход графа, который идёт фоном и на открытую книгу не смотрит.
// Поэтому запись поля не замена файла, а свод с ним (commit/merge3), а о
// чужой записи панель узнаёт подпиской (translate.subscribeGlossary через
// useGlossaryRevision) и перечитывает файл, не трогая набранного.
//
// Логика проходов живёт в glossarygen.ts; здесь — только их запуск, отмена,
// показ чисел и запись результата. Ни один проход не бросает из-за модели:
// мёртвый сервер, отсутствующая модель и ответ, не прошедший ворота, — это
// «термины остались как были», а не исключение. Бросает только отмена, и
// только первый проход (список из первых тридцати страниц — это не «часть
// работы», а другой и худший список).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { invoke } from "@tauri-apps/api/core";
import { BOOK_LANGS, UND, langName, needsTranslation, type BookLang } from "./booklang";
import { mergeRecords, parseGlossaryText, termKey } from "./glossary";
import {
  enrichTerms,
  loadGlossary,
  mineGlossary,
  saveGlossary,
  validateTerms,
} from "./glossarygen";
import {
  glossaryWriter,
  isAuxUp,
  loadGlossaryText,
  saveGlossaryText,
  useGlossaryRevision,
} from "./translate";
import {
  Spinner,
  cancelDownload,
  dlBusy,
  dlErrorFix,
  dlPct,
  dlProgressLine,
  modelFileReady,
  sizeLabel,
  startDownload,
  useDownload,
} from "./ModelSetup";
import { getLang, t } from "./i18n";

// ---- classes ----------------------------------------------------------------
//
// (WP-J) Один главный глагол на поверхность. Здесь их три подряд, поэтому
// главным сделан ПЕРВЫЙ — единственный, который работает всегда и без модели;
// два других тише, и вместе они читаются лестницей: найти → определить →
// проверить.

// буква в букву GEN_BTN из бывшей GlossaryModal (и PRIMARY_BTN из ModelSetup)
const RUN_BTN =
  "inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white";
// буква в букву BTN_QUIET из TranslatePanel.tsx: тихая кнопка в панели одна
const RUN_BTN_QUIET =
  "inline-flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-700 px-3 py-1.5 text-[13px] font-medium text-neutral-700 dark:text-neutral-300 transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";
const QUIET_LINK =
  "transition-colors hover:text-neutral-700 dark:hover:text-neutral-200 underline underline-offset-2";
// общий в приложении разрушительный взвод (WP-Q, #11/#12): последствие текстом,
// красная кнопка называет действие, рядом «Отмена»
const RED_BTN = "-mx-1 px-1 rounded-md text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/10";
// буква в букву PLAIN_BTN из Settings.tsx и AskSidebar.tsx
const PLAIN_BTN =
  "-mx-1 px-1 rounded-md transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";
// пилюля выбора — та же, что у переключателя языка интерфейса в Settings.tsx
const PILL = "rounded-full px-2 py-0.5 transition-colors";
const PILL_ON = "bg-white shadow-sm dark:bg-neutral-700";
const PILL_OFF = "text-neutral-500 hover:bg-neutral-900/5 dark:text-neutral-400 dark:hover:bg-neutral-100/10";

const QUIET = "text-xs text-neutral-500 dark:text-neutral-400";

// ---- сколько ждать перед записью --------------------------------------------
//
// Модалка сохраняла файл на закрытии — у вкладки закрытия нет, она живёт,
// пока открыта книга. Значит правки нужно класть на диск по ходу: иначе
// «Перевести заново» снимет снимок глоссария (booktranslate.ts:87) с того,
// что было до правок, а «Добавить в глоссарий» из книги допишет строку к
// старому тексту. 600 мс — пауза, после которой человек уже не печатает;
// плюс сохранение по blur, а blur случается раньше любого другого сценария:
// чтобы выделить термин в книге, из поля надо уйти.
const SAVE_DEBOUNCE = 600;

/** Ниже этого разбор языка помечается как слабый — обоснование у langLabel. */
const WEAK_CONF = 0.35;

// ---- кто пишет и как сводится -----------------------------------------------
//
// Подпись панели под её собственными записями. Одна на модуль и на весь сеанс:
// счётчик своих записей висит на самой метке (translate.ts), поэтому метка,
// созданная заново на каждый рендер, была бы каждый раз НОВЫМ писателем и
// будила бы сама себя — ровно тот перескок каретки, ради которого подпись и
// заведена.
const PANEL = glossaryWriter("terms-panel");

/// Свести набранное в поле с файлом, который поменяли под ним.
///
/// Трёхсторонний свод. `base` — то, что панель в файле последний раз видела
/// (прочитала или записала), `mine` — то, что читатель набрал с тех пор,
/// `disk` — то, что в файле сейчас. Стволом всегда остаётся текст читателя:
/// mergeRecords не переписывает ни одной существующей строки, только заполняет
/// её ПУСТЫЕ поля и дописывает недостающие термины в конец, так что ни один
/// набранный символ не переезжает.
///
/// Отдельно приходится думать ровно об одном — об удалении. Термин, который
/// был в `base` и которого не стало в `mine`, читатель стёр нарочно, и вернуть
/// его из файла значило бы отменить это руками машины. Такие термины из
/// входящих вычёркиваются. Остальное делится надвое: термин, который у
/// читателя есть, — чужому проходу позволено дозаполнить его пустые поля;
/// термин, новый для обеих сторон, — дописывается.
///
/// Цена, названная вслух: удаление РАСПОЗНАЁТСЯ по термину, а не по строке,
/// потому что термин — единственная общая единица у файла, сайдкара и графа
/// (termKey). Читатель, стёрший у строки только определение, получит его
/// обратно, если чужой проход как раз это определение и написал. Потерянное
/// предложение прозы — та потеря, которую в этом проекте уже выбрали как
/// меньшую (glossarygen: неверное определение снимается, термин остаётся).
function merge3(base: string, mine: string, disk: string): string {
  const had = new Set(parseGlossaryText(base).map((r) => termKey(r.term)));
  const has = new Set(parseGlossaryText(mine).map((r) => termKey(r.term)));
  const incoming = parseGlossaryText(disk).filter((r) => {
    const k = termKey(r.term);
    return has.has(k) || !had.has(k);
  });
  return mergeRecords(mine, incoming).text;
}

// ---- aux model --------------------------------------------------------------

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const onAbort = () => {
      clearTimeout(timer);
      rej(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      res();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });

// Поднять модель терминов (Qwen3.5-4B на 11545) на время прогона. Приехало из
// GlossaryModal без изменений: вне Tauri invoke бросает — тогда за ответ
// отвечает HTTP-проба того же сервера; загрузка весов занимает 10–30 с, и
// после 90 с ожидания прогон сдаётся, а не висит.
//
// Отличие от модалки одно, и оно в том, ЧТО значит false. Там ответ «нет
// модели» означал «переводим терминов основной моделью, качество ниже» —
// молчаливый запасной путь. Здесь его нет: второй и третий проходы спрашивают
// у модели терминов и без неё не делают ничего, поэтому false — это состояние
// «модель не установлена», названное вслух (gl.noAux), с уже сохранёнными на
// диске терминами и страницами за спиной.
async function ensureAux(signal: AbortSignal): Promise<boolean> {
  let s: string;
  try {
    s = await invoke<string>("aux_model_start");
  } catch {
    return isAuxUp();
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (s === "up" || s === "external") return true;
    if (s === "dead" || s === "none") return false;
    await sleep(1500, signal); // "starting"
    try {
      s = await invoke<string>("aux_model_status");
    } catch {
      return isAuxUp();
    }
  }
  return false;
}

// ---- состояния прогона -------------------------------------------------------

type Pass = "mine" | "enrich" | "validate";

/** Идёт прогон. `total: 0` — этап без чисел (поднимается модель, читается файл). */
type Run = { pass: Pass; done: number; total: number };

/** Чем кончилось. Одна запись на проход — отчёт стоит у своей же кнопки. */
type Report =
  | { pass: "mine"; kind: "done"; added: number; updated: number; found: number }
  | {
      pass: "enrich";
      kind: "done";
      enriched: number;
      skipped: number;
      translated: number;
      noTarget: boolean;
    }
  | {
      pass: "validate";
      kind: "done";
      checked: number;
      cleared: number;
      folded: number;
      groups: number;
      aliases: string;
      /// Подтверждённые дубли, которые остались в файле: строки читателя не
      /// сводит никто, и промолчать об этом нельзя — иначе проход выглядит
      /// так, будто он ничего не нашёл, хотя он нашёл и не тронул.
      kept: number;
      keptList: string;
    }
  | { pass: Pass; kind: "stopped" | "silent" | "noTerms" | "noAux" | "failed" | "saveFailed" };

/** Строка одного прохода: глагол, а во время работы — прогресс внутри него. */
function PassRow({
  label,
  title,
  primary,
  running,
  progress,
  disabled,
  status,
  extra,
  onRun,
  onStop,
  stopTitle,
}: {
  label: string;
  title: string;
  /** первый проход — единственный, который работает всегда: он и главный */
  primary?: boolean;
  running: boolean;
  /** что написано внутри кнопки, пока идёт прогон */
  progress?: string;
  disabled?: boolean;
  /** строка рядом с кнопкой: что будет или что вышло */
  status?: string;
  /** вторая, тихая строка под рядом — причина, синонимы, подсказка */
  extra?: ReactNode;
  onRun: () => void;
  onStop: () => void;
  stopTitle?: string;
}) {
  const btn = primary ? RUN_BTN : RUN_BTN_QUIET;
  return (
    <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 ${QUIET}`}>
      {running ? (
        // прогон живёт ВНУТРИ той же кнопки — у ряда один глагол и в покое,
        // и в работе; отмена всегда рядом и всегда явная
        <>
          <span aria-busy="true" className={`${btn} cursor-default`}>
            <Spinner />
            <span className="tabular-nums">{progress}</span>
          </span>
          <button className={QUIET_LINK} onClick={onStop} title={stopTitle}>
            {t("gl.stop")}
          </button>
        </>
      ) : (
        <>
          <button
            className={`${btn} ${disabled ? "opacity-50" : ""}`}
            disabled={disabled}
            onClick={onRun}
            title={title}
          >
            {label}
          </button>
          {status && <span className="min-w-0">{status}</span>}
        </>
      )}
      {extra && <div className="w-full">{extra}</div>}
    </div>
  );
}

export function GlossaryPanel({
  bookPath,
  doc,
  onCount,
}: {
  bookPath: string;
  /** открытая книга — первый проход читает её целиком; null у закрытой */
  doc: PDFDocumentProxy | null;
  /** записей в файле: число справа в строке «Открыть глоссарий» и подсказка вкладки */
  onCount: (n: number) => void;
}) {
  const [text, setText] = useState("");
  const textRef = useRef(text);
  textRef.current = text;
  // Что уже лежит на диске. Нужен, чтобы не переписывать файл на каждый уход
  // из поля: глоссарий — рукописный файл читателя, запись атомарна (tmp+rename
  // в translate.ts), и делать её вхолостую при каждом blur незачем.
  const savedRef = useRef("");
  // Язык КНИГИ, не интерфейса. Пока не известен — UND, и это не ошибка, а
  // «не угадываю» (booklang). Уверенность знаем только сразу после разбора:
  // в сайдкар она не пишется, и язык, прочитанный оттуда, уже либо принят
  // читателем, либо им же назначен — переспрашивать не о чем.
  const [lang, setLang] = useState<BookLang>(UND);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  // взвод «Собрать заново»: перечитывание с пустой базы заменяет весь список
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const closedRef = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  // Какая книга на экране ПРЯМО СЕЙЧАС. Проставляется в рендере, то есть до
  // любого эффекта следующего коммита, поэтому проход, вернувшийся из await,
  // спрашивает у него, а не у своего замыкания.
  const bookRef = useRef(bookPath);
  bookRef.current = bookPath;
  // Чужая запись в файл этой книги. Не значение, а счётчик: текст живёт в
  // состоянии поля, и панели нужно «перечитай», а не «вот тебе строка».
  // Своих записей счётчик не считает (PANEL) — иначе панель будила бы себя
  // сама и возвращала каретку в конец списка на каждом сохранении.
  const rev = useGlossaryRevision(bookPath, PANEL);
  // модель терминов: предлагается здесь, качается по требованию
  const auxDl = useDownload("aux");
  const [auxReady, setAuxReady] = useState<boolean | null>(null);
  useEffect(() => {
    modelFileReady("aux").then(setAuxReady);
  }, []);
  const showAuxOffer = auxReady === false && auxDl.status !== "done";

  // Записей в файле. Одно разбирание на изменение текста обслуживает и число
  // на этой вкладке, и число, которое App показывает в строке «Открыть
  // глоссарий» и в подсказке вкладки.
  const count = useMemo(() => parseGlossaryText(text).length, [text]);
  const onCountRef = useRef(onCount);
  onCountRef.current = onCount;
  useEffect(() => {
    onCountRef.current(count);
  }, [count]);

  // Панель жива. Только это — про книгу здесь не сказано ничего, и эффект
  // намеренно без зависимостей: взвести closedRef на смене bookPath значит
  // отдать книге A ту же ветку «панели больше нет», по которой идёт настоящее
  // размонтирование, и снять её в том же коммите. Проход книги A вернулся бы
  // из await с closedRef === false и дописал бы её глоссарий в панель,
  // показывающую книгу B. Сброс в ТЕЛЕ нужен для dev StrictMode: он гасит и
  // заново монтирует живую вкладку, а ref это переживает.
  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
    };
  }, []);

  /// «Отвечать уже некому»: панели нет ИЛИ на экране другая книга. Один
  /// вопрос на оба случая, и задавать его надо ПОСЛЕ каждого await, до любого
  /// setState и до любого adopt — иначе проход прежней книги допишет свой
  /// результат в панель, которая показывает следующую.
  const gone = useCallback(() => closedRef.current || bookRef.current !== bookPath, [bookPath]);

  /// Записать текст поля в файл — сведя его с тем, что там сейчас.
  ///
  /// Раньше это была замена файла целиком, и она стирала всё, что успел
  /// написать туда кто-то другой: «Добавить в глоссарий» из книги и глубокий
  /// проход графа, который идёт фоном и на открытую книгу не смотрит. Быстрая
  /// проверка `disk === savedRef` отделяет обычный случай — под панелью никто
  /// не писал — и тогда текст уходит в файл байт в байт, без разбора и без
  /// переформатирования рукописных строк. Разошлось — значит писали, и тогда
  /// свод (merge3), а не чей-нибудь проигрыш.
  ///
  /// Возвращает то, что легло в файл: оно же становится текстом поля, если
  /// свод что-то добавил.
  const commit = useCallback((book: string, v: string): string => {
    const disk = loadGlossaryText(book);
    const merged = disk === savedRef.current ? v : merge3(savedRef.current, v, disk);
    savedRef.current = merged;
    // Подписью PANEL: своя запись не должна будить собственное перечитывание.
    saveGlossaryText(book, merged, PANEL);
    return merged;
  }, []);

  /// Свести поле с тем, что в файле сейчас, — после чужой записи или после
  /// своего же прохода.
  ///
  /// Ничего не набрано с прошлой записи — поле становится файлом, и это
  /// подавляющее большинство случаев. Набрано — молча подменять набранное
  /// нельзя, это был бы другой дефект, а не починка: текст читателя остаётся
  /// стволом, из файла в него приходит только то, чего он не удалял, и
  /// результат тут же уходит на диск, чтобы поле и файл снова совпали.
  const land = useCallback((book: string, disk: string): string => {
    if (textRef.current === savedRef.current) {
      savedRef.current = disk;
      setText(disk);
      return disk;
    }
    clearTimeout(saveTimer.current);
    const merged = merge3(savedRef.current, textRef.current, disk);
    savedRef.current = merged;
    setText(merged);
    if (merged !== disk) saveGlossaryText(book, merged, PANEL);
    return merged;
  }, []);

  // Всё, что принадлежит КНИГЕ, а не файлу, начинается заново при её смене —
  // потому что панель при этом НЕ пересоздаётся (см. «СРОК ЖИЗНИ» вверху) и
  // ни одно из этих полей само не обнулится. Список полный намеренно: язык и
  // уверенность (иначе следующая книга разбиралась бы по стоп-листам
  // предыдущей), раскрытый выбор языка, отчёт прошлого прохода, сам прогон
  // (иначе у новой книги крутится чужой счётчик), взведённое «Собрать заново»
  // (иначе у новой книги вместо «Найти термины» стоит красная «Заменить»,
  // взведённая для чужого файла) и текст с его «уже сохранено» — до чтения,
  // чтобы в окне между сменой книги и ответом диска на экране не стоял чужой
  // список, в который можно печатать.
  //
  // Уборка — для ПРЕЖНЕЙ книги: замыкание держит её bookPath. Отложенная
  // запись уходит в её файл (иначе набранное для A легло бы в B), идущий
  // проход останавливается, а его завершение само поймёт, что отвечать уже
  // некому (gone).
  useEffect(() => {
    ctrlRef.current = null;
    setRun(null);
    setLang(UND);
    setConfidence(null);
    setPicking(false);
    setReport(null);
    setConfirmRebuild(false);
    savedRef.current = "";
    setText("");
    return () => {
      clearTimeout(saveTimer.current);
      ctrlRef.current?.abort();
      if (textRef.current !== savedRef.current) commit(bookPath, textRef.current);
    };
  }, [bookPath, commit]);

  // Чтение файла и его бухгалтерии. Асинхронное намеренно: hydrateGlossary
  // переносит старый localStorage-глоссарий в файл приложения и запускается
  // одновременно с открытием книги — синхронный loadGlossaryText в этот момент
  // вернул бы пустоту.
  //
  // `rev` — чужая запись в этот же файл: «Добавить в глоссарий» и глубокий
  // проход графа. До подписки панель об этом не знала, держала строку,
  // прочитанную при открытии книги, и первым же сохранением возвращала файл к
  // ней — а граф своих строк больше не написал бы никогда (graphrun выходит
  // на шарде, дошедшем до стадии deep). Отложенная запись поля здесь НЕ
  // отменяется: она несёт набранное, и потерять его ради перечитывания —
  // ровно та подмена, от которой land и защищает.
  useEffect(() => {
    let alive = true;
    void loadGlossary(bookPath).then((g) => {
      if (!alive) return;
      land(bookPath, g.text);
      if (g.meta.lang !== UND) setLang(g.meta.lang);
      setConfidence(null);
    });
    return () => {
      alive = false;
    };
  }, [bookPath, rev, land]);

  /** Положить правки на диск немедленно — перед прогоном и по уходу из поля. */
  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    if (textRef.current === savedRef.current) return;
    const merged = commit(bookPath, textRef.current);
    if (merged !== textRef.current) setText(merged);
  }, [bookPath, commit]);

  const edit = useCallback(
    (v: string) => {
      setText(v);
      clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        if (v === savedRef.current) return;
        // Печатать уже перестали — SAVE_DEBOUNCE отсчитывается от последнего
        // нажатия, — поэтому подставить сюда результат свода безопасно: чужие
        // строки допишутся в конец, а не под каретку.
        const merged = commit(bookPath, v);
        if (merged !== v) setText(merged);
      }, SAVE_DEBOUNCE);
    },
    [bookPath, commit],
  );

  /** Принять текст, который только что записал проход: он и есть диск. */
  const adopt = useCallback((book: string): string => land(book, loadGlossaryText(book)), [land]);

  // Язык, на который переводят термины, — язык интерфейса, и другого пути к
  // модели сегодня нет (translate.ts:218 через i18n.targetLanguage). Когда
  // читатель научится выбирать цель, отсюда придёт поле записи, а не
  // getLang(); glossarygen это уже умеет и честно скажет, если цель
  // недостижима (EnrichResult.translationRan === false, gl.noTrTarget).
  const target: BookLang = getLang();
  const translates = needsTranslation(lang, target);
  const busy = run !== null;
  const uiLang = getLang();

  /// Записать результат прохода. Возвращает false, если запись не удалась —
  /// тогда прогон честно об этом скажет, а не сделает вид, что всё сохранено.
  ///
  /// Базы слияния тут больше нет и передать её неоткуда: saveGlossary читает
  /// файл сам, в момент записи. Раньше базой был снимок поля, снятый ДО
  /// прохода, и всё, что появлялось в файле за эти минуты, слияние стирало.
  /// Замыкание держит bookPath и язык той книги, на которой проход начался, —
  /// поэтому даже завершившись после ухода читателя к следующей книге, он
  /// пишет в СВОЙ файл и своим языком; чего он после этого не делает, так это
  /// не трогает экран (gone).
  const persist = useCallback(
    async (
      records: Parameters<typeof saveGlossary>[1],
      remove?: ReadonlySet<string>,
      clearDefs?: ReadonlySet<string>,
    ): Promise<boolean> => {
      try {
        await saveGlossary(bookPath, records, {
          // UND не пишем: сайдкар помнит, что узнал другой проход, и стирать
          // это «неизвестностью» нельзя (saveGlossary: lang ?? prev.lang)
          lang: lang === UND ? undefined : lang,
          target,
          remove,
          clearDefs,
        });
        return true;
      } catch (e) {
        console.error("glossary save failed", e);
        return false;
      }
    },
    [bookPath, lang, target],
  );

  // ---- проход 1: найти термины (без модели) ----------------------------------
  //
  // Читает книгу целиком и всегда пишет. Это и есть честный ответ на «модели
  // нет»: термины, страницы и частоты ложатся на диск сейчас, остальные поля
  // заполнятся, когда модель появится. Модельных ворот тут нет и быть не
  // должно — ни основной, ни вспомогательной модели этот проход не спрашивает.
  //
  // MERGE: каждая существующая строка переживает прогон байт в байт, новые
  // дописываются, пустые поля старых заполняются. Поэтому повторный клик
  // идемпотентен. `fresh` (подтверждённое «Собрать заново») сливает с пустой
  // базы — единственный режим, которому позволено потерять строку.
  const runMine = useCallback(
    async (fresh = false) => {
      if (!doc || ctrlRef.current) return;
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      flush();
      setConfirmRebuild(false);
      setReport(null);
      setRun({ pass: "mine", done: 0, total: doc.numPages });
      try {
        const r = await mineGlossary(doc, bookPath, {
          // Что показывает строка языка — то и берёт разбор. Известный язык
          // передаётся как переопределение и разбор его не переспрашивает:
          // так решает читатель, а не шестнадцать выборочных страниц, и
          // повторный прогон не может молча поменять язык под ногами.
          lang: lang === UND ? undefined : lang,
          fresh,
          signal: ctrl.signal,
          // Счётчик тоже спрашивает, чья это книга: проход, начатый на
          // прежней, ещё несколько тиков жив после отмены, и его числа не
          // должны крутиться в панели, показывающей следующую.
          onProgress: (done, total) => {
            if (!gone()) setRun({ pass: "mine", done, total });
          },
        });
        if (gone()) return;
        setLang(r.lang);
        setConfidence(r.confidence);
        const found = parseGlossaryText(adopt(bookPath)).length;
        setReport(
          found === 0
            ? { pass: "mine", kind: "noTerms" }
            : { pass: "mine", kind: "done", added: r.added, updated: r.updated, found },
        );
      } catch {
        if (gone()) return;
        // Отмена первого прохода не оставляет ничего: он бросает ДО записи, и
        // список остался ровно таким, каким был. Поэтому здесь молчание, а не
        // gl.stopped — «сделанное сохранено» было бы неправдой.
        setReport(ctrl.signal.aborted ? null : { pass: "mine", kind: "failed" });
      } finally {
        // Только своего контролёра: пока проход прежней книги доигрывает,
        // читатель мог открыть следующую и запустить свой — обнулить чужую
        // ячейку значило бы оставить его прогон без «Остановить».
        if (ctrlRef.current === ctrl) ctrlRef.current = null;
        if (!gone()) setRun(null);
      }
    },
    [doc, bookPath, lang, flush, adopt, gone],
  );

  // ---- проход 2: определить термины ------------------------------------------
  //
  // Модель терминов заполняет вид, категорию и определение — по двенадцать
  // терминов на вызов — и, если книга не на языке читателя, переводит. Только
  // ПУСТЫЕ поля: категорию или определение, набранные руками, не перепишет
  // никто. Отмена оставляет сделанное и сохраняет его.
  const runEnrich = useCallback(async () => {
    if (ctrlRef.current) return;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    flush();
    setConfirmRebuild(false);
    setReport(null);
    setRun({ pass: "enrich", done: 0, total: 0 });
    try {
      if (!(await ensureAux(ctrl.signal))) {
        if (!gone()) setReport({ pass: "enrich", kind: "noAux" });
        return;
      }
      const g = await loadGlossary(bookPath);
      if (!g.records.length) {
        if (!gone()) setReport({ pass: "enrich", kind: "noTerms" });
        return;
      }
      if (gone()) return;
      setRun({ pass: "enrich", done: 0, total: g.records.length });
      const e = await enrichTerms(g.records, {
        // Ключ к предложению, в котором проход 1 встретил термин: с диска
        // записи возвращаются без него, и без книги модель спрашивают
        // голым списком (glossarygen: «the sample sentence»).
        bookPath,
        lang,
        target,
        signal: ctrl.signal,
        onProgress: (done, total) => {
          if (!gone()) setRun({ pass: "enrich", done, total });
        },
      });
      const ok = await persist(e.records);
      if (gone()) return;
      adopt(bookPath);
      setReport(
        !ok
          ? { pass: "enrich", kind: "saveFailed" }
          : e.aborted
            ? { pass: "enrich", kind: "stopped" }
            : e.enriched === 0 && e.translated === 0
              ? { pass: "enrich", kind: "silent" }
              : {
                  pass: "enrich",
                  kind: "done",
                  enriched: e.enriched,
                  skipped: e.skipped,
                  translated: e.translated,
                  // Перевод был нужен, а не случился — это не молчание, это
                  // одна строка о том, куда именно переводить не умеем.
                  noTarget: translates && !e.translationRan,
                },
      );
    } catch {
      if (!gone() && !ctrl.signal.aborted) setReport({ pass: "enrich", kind: "failed" });
    } finally {
      if (ctrlRef.current === ctrl) ctrlRef.current = null;
      if (!gone()) setRun(null);
      // VRAM отдаём всегда — и после успеха, и после отмены, и после отказа
      // (вне Tauri и без запущенного сервера это ничего не делает)
      invoke("aux_model_stop").catch(() => {});
    }
  }, [bookPath, lang, target, translates, flush, persist, adopt, gone]);

  // ---- проход 3: проверить термины -------------------------------------------
  //
  // Тот самый, который просили назвать по имени: модель сверяет определения с
  // терминами и сводит разные написания одного понятия. Неверное определение
  // СНИМАЕТСЯ, термин остаётся — потерять предложение прозы читатель переживёт,
  // потерять термин нет. Строку, набранную руками, не удаляет никто: сводится
  // только то, что в файл положила машина, и это видно по самой записи, а не
  // по памяти сеанса. Дубли, которые остались, проход называет вслух — иначе
  // «нашёл и не тронул» на экране неотличимо от «не нашёл».
  const runValidate = useCallback(async () => {
    if (ctrlRef.current) return;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    flush();
    setConfirmRebuild(false);
    setReport(null);
    setRun({ pass: "validate", done: 0, total: 0 });
    try {
      if (!(await ensureAux(ctrl.signal))) {
        if (!gone()) setReport({ pass: "validate", kind: "noAux" });
        return;
      }
      const g = await loadGlossary(bookPath);
      if (!g.records.length) {
        if (!gone()) setReport({ pass: "validate", kind: "noTerms" });
        return;
      }
      // Что свести можно, а что нет, решает происхождение самой записи
      // (glossarygen: FOLDABLE_SOURCE), и передавать сюда нечего. Прежний
      // список «что добавил ЭТОТ сеанс» был пуст для любого глоссария,
      // собранного вчера, — проход строил кластеры, тратил на каждый вызов
      // модели и не сводил ни одного.
      if (gone()) return;
      const v = await validateTerms(g.records, {
        signal: ctrl.signal,
        onProgress: (done, total) => {
          if (!gone()) setRun({ pass: "validate", done, total });
        },
      });
      // foldedKeys и clearedKeys — те самые явные аргументы, которыми строка
      // уходит из файла и определение уходит со строки: слияние умеет только
      // ЗАПОЛНЯТЬ пустое поле, поэтому без них и свод, и снятые определения
      // остались бы на бумаге (glossarygen: SaveOptions.remove/clearDefs).
      const ok = await persist(v.records, v.foldedKeys, v.clearedKeys);
      if (gone()) return;
      adopt(bookPath);
      const folded = v.groups.flatMap((x) => x.folded);
      setReport(
        !ok
          ? { pass: "validate", kind: "saveFailed" }
          : v.aborted
            ? { pass: "validate", kind: "stopped" }
            : v.checked === 0 && v.groups.length === 0
              ? { pass: "validate", kind: "silent" }
              : {
                  pass: "validate",
                  kind: "done",
                  checked: v.checked,
                  cleared: v.cleared,
                  folded: v.folded,
                  groups: v.groups.length,
                  // i18n не умеет списков и не должен: пропускать каждый
                  // синоним через t() значило бы прогнать macKeys() по чужому
                  // тексту. Склейка — дело вызывающего (gl.aliases: {list}).
                  aliases: folded.join(", "),
                  kept: v.kept,
                  keptList: v.groups.flatMap((x) => x.kept).join(", "),
                },
      );
    } catch {
      if (!gone() && !ctrl.signal.aborted) setReport({ pass: "validate", kind: "failed" });
    } finally {
      if (ctrlRef.current === ctrl) ctrlRef.current = null;
      if (!gone()) setRun(null);
      invoke("aux_model_stop").catch(() => {});
    }
  }, [bookPath, flush, persist, adopt, gone]);

  const stop = useCallback(() => ctrlRef.current?.abort(), []);

  // ---- что печатает строка прохода -------------------------------------------

  /** Отчёт прохода одной строкой; каждое число со своим счётным словом. */
  const reportOf = (pass: Pass): string | undefined => {
    if (!report || report.pass !== pass) return undefined;
    switch (report.kind) {
      case "stopped":
        return t("gl.stopped");
      case "silent":
        return t("gl.modelSilent");
      case "noTerms":
        return t("gl.noTerms");
      case "noAux":
        return t("gl.noAux");
      case "failed":
        return t("gl.failed");
      case "saveFailed":
        return t("gl.saveFailed");
    }
    if (report.pass === "mine")
      return report.added === 0 && report.updated === 0
        ? t("gl.mined", { n: report.found })
        : t("gl.added", { n: report.added }) +
            (report.updated ? t("gl.updated", { n: report.updated }) : "");
    if (report.pass === "enrich")
      return (
        t("gl.enriched", { n: report.enriched }) +
        (report.skipped ? t("gl.enrichSkipped", { n: report.skipped }) : "") +
        (report.translated ? t("gl.translated", { n: report.translated }) : "")
      );
    return (
      t("gl.checked", { n: report.checked }) +
      (report.cleared ? t("gl.cleared", { n: report.cleared }) : "") +
      (report.folded ? t("gl.folded", { n: report.folded }) : "")
    );
  };

  /** Вторая, тихая строка под рядом: причина или подробность, не число. */
  const extraOf = (pass: Pass): ReactNode => {
    const r = report && report.pass === pass ? report : null;
    if (r?.kind === "noAux") return <span>{t("gl.noAuxHint")}</span>;
    if (pass === "enrich") {
      if (r?.pass === "enrich" && r.kind === "done" && r.noTarget)
        return <span>{t("gl.noTrTarget")}</span>;
      // Книге на языке читателя про перевод терминов не говорят вовсе —
      // вместо этого одна строка о том, что переводить нечего.
      if (!translates && lang !== UND) return <span>{t("gl.sameLang")}</span>;
      return null;
    }
    if (pass === "validate" && r?.pass === "validate" && r.kind === "done") {
      if (r.folded) return <span>{t("gl.aliases", { list: r.aliases })}</span>;
      // Ни одна строка не тронута, но дубли были: это находка, а не пустой
      // прогон, и молчать о ней — то же самое, что не найти.
      if (r.kept) return <span>{t("gl.dupKept", { list: r.keptList })}</span>;
      if (r.groups === 0) return <span>{t("gl.noDupes")}</span>;
    }
    return null;
  };

  const progressOf = (r: Run): string => {
    if (r.total === 0) return t("gl.loading"); // поднимается модель / читается файл
    if (r.pass === "mine") return t("gl.mining", { done: r.done, total: r.total });
    if (r.pass === "enrich") return t("gl.enriching", { done: r.done, total: r.total });
    return t("gl.validating", { done: r.done, total: r.total });
  };

  // Имя языка приходит из CLDR (Intl.DisplayNames) и потому законно живёт не в
  // i18n: его пишем не мы. «und» печатать нельзя — CLDR зовёт его «root», что
  // на экране выглядит поломкой; у неизвестного языка своё слово.
  //
  // WEAK_CONF = 0,35 — не измерение, а порог, выбранный по числам, которые
  // booklang.ts называет типичными: 0,7 у английского, 0,54 у русского,
  // 0,45–0,53 у испанского/португальского/итальянского, 0,27 у украинского;
  // ответы, которые даёт один только алфавит, идут от 0,6 и выше. Планка
  // отделяет ровно последний случай — русско-украинскую пару, где разбор и
  // правда близок к монетке, — и говорит про него «посмотрите сами», а не
  // печатает читателю величину зазора, с которой ему нечего делать. Ниже
  // 0,35 booklang уже почти всегда отвечает UND, так что ложных тревог тут
  // немного по построению.
  const langLabel =
    lang === UND
      ? t("gl.langUnknown")
      : langName(lang, uiLang) + (confidence !== null && confidence < WEAK_CONF ? t("gl.langWeak") : "");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-3">
      {/* ---- имя и счёт ---- */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-0.5 select-none">
        <span className="text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
          {t("gl.title")}
        </span>
        <span className={`${QUIET} tabular-nums`}>
          {count ? t("gl.terms", { n: count }) : t("gl.empty")}
        </span>
      </div>
      {count === 0 && <div className={`mt-0.5 px-0.5 ${QUIET} select-none`}>{t("gl.emptyHint")}</div>}

      {/* ---- язык книги ----
          Стоит выше прогонов не для красоты: от него зависит, какие слова
          вообще считаются терминами (стоп-листы в terms.ts), поэтому поправить
          его нужно ДО того, как книгу прочитают, а не после. */}
      <div className={`mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5 ${QUIET} select-none`}>
        <span title={t("gl.bookLangTitle")}>{t("gl.bookLang")}</span>
        <span className="min-w-0 text-neutral-700 dark:text-neutral-300">{langLabel}</span>
        <button
          aria-expanded={picking}
          className={QUIET_LINK}
          onClick={() => setPicking((v) => !v)}
          title={t("gl.langPick")}
        >
          {t("gl.langChange")}
        </button>
      </div>
      {picking && (
        // Раскрывается на месте, без экрана и без выпадающего списка: в этом
        // приложении нет ни одного <select>, а всё разрушительное и всё
        // выбираемое разворачивается прямо в строке (TranslatePanel, Settings).
        <div className="mt-1.5 flex flex-wrap gap-0.5 rounded-lg bg-neutral-100 p-1 text-xs dark:bg-neutral-900/50">
          {[UND, ...BOOK_LANGS].map((l) => (
            <button
              className={`${PILL} ${l === lang ? PILL_ON : PILL_OFF}`}
              key={l}
              onClick={() => {
                setLang(l);
                setConfidence(null); // выбор читателя не «угадан», у него нет уверенности
                setPicking(false);
              }}
            >
              {l === UND ? t("gl.langUnknown") : langName(l, uiLang)}
            </button>
          ))}
        </div>
      )}

      {/* ---- сам файл ----
          Читатель правит его руками, поэтому это обычное поле, а не таблица:
          подсказка внутри — единственная документация грамматики строки. */}
      <textarea
        // (WP-N) Поле — не кнопка: акцентного кольца на нём быть не должно.
        // Синий в системе один и означает выбранное; каретка уже говорит, где
        // курсор, а рамка тихо темнеет — так же, как в поиске библиотеки и
        // графа, единственных других коробчатых полях приложения.
        className="mt-2.5 min-h-64 flex-1 w-full rounded-lg border border-neutral-200 bg-neutral-100 p-2.5 font-mono text-[13px] leading-relaxed outline-none transition-colors focus:border-neutral-300 dark:border-transparent dark:bg-neutral-900 dark:focus:border-neutral-600"
        onBlur={flush}
        onChange={(e) => edit(e.target.value)}
        placeholder={t("gl.placeholder")}
        value={text}
      />

      {/* ---- три прохода ---- */}
      <div className="mt-2.5 flex flex-col gap-2">
        {doc &&
          // Взвод живёт ровно столько, сколько живёт возможность его нажать:
          // ссылка «Собрать заново» показывается только при !busy, а вот сам
          // взведённый ряд раньше оставался и во время чужого прохода — и
          // красная «Заменить» в нём молча ничего не делала (runMine выходит
          // на занятом контролёре), пока строка «Найти термины» вообще не
          // показывалась. Второй его срок — книга: см. эффект [bookPath].
          (confirmRebuild && !busy ? (
            // разрушительное называет последствие и ждёт второго клика (#12)
            <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 ${QUIET}`}>
              <span>{t("gl.replaceWarn")}</span>
              <button
                className={RED_BTN}
                onClick={() => {
                  setConfirmRebuild(false);
                  void runMine(true);
                }}
              >
                {t("gl.replace")}
              </button>
              <button className={PLAIN_BTN} onClick={() => setConfirmRebuild(false)}>
                {t("ui.cancel")}
              </button>
            </div>
          ) : (
            <PassRow
              disabled={busy}
              label={t("gl.mine")}
              onRun={() => void runMine()}
              onStop={stop}
              primary
              progress={run ? progressOf(run) : undefined}
              running={run?.pass === "mine"}
              // Первый проход не обещает, что «сделанное останется»: он
              // бросает до записи, и остановка возвращает список как был.
              status={reportOf("mine") ?? t("gl.mineNote")}
              title={t("gl.mineTitle")}
              extra={
                count > 0 && !busy ? (
                  <button
                    className={QUIET_LINK}
                    onClick={() => setConfirmRebuild(true)}
                    title={t("gl.rebuildTitle")}
                  >
                    {t("gl.rebuild")}
                  </button>
                ) : null
              }
            />
          ))}
        <PassRow
          disabled={busy || count === 0}
          extra={extraOf("enrich")}
          label={t("gl.enrich")}
          onRun={() => void runEnrich()}
          onStop={stop}
          progress={run ? progressOf(run) : undefined}
          running={run?.pass === "enrich"}
          status={reportOf("enrich")}
          stopTitle={t("gl.stopTitle")}
          title={t("gl.enrichTitle")}
        />
        <PassRow
          disabled={busy || count === 0}
          extra={extraOf("validate")}
          label={t("gl.validate")}
          onRun={() => void runValidate()}
          onStop={stop}
          progress={run ? progressOf(run) : undefined}
          running={run?.pass === "validate"}
          status={reportOf("validate")}
          stopTitle={t("gl.stopTitle")}
          title={t("gl.validateTitle")}
        />
      </div>

      {/* ---- модель терминов: своя, по желанию, лицензия названа ----
          Без неё второй и третий проходы не делают ничего и говорят об этом
          вслух; первый работает всегда. */}
      {showAuxOffer && (
        <div className={`mt-2.5 flex flex-wrap items-center gap-2 ${QUIET} select-none`}>
          {dlBusy(auxDl) ? (
            <>
              <span className="tabular-nums">{t("gl.auxProgress", { detail: dlProgressLine(auxDl) })}</span>
              <button className={QUIET_LINK} onClick={() => cancelDownload("aux")}>
                {t("ui.cancel")}
              </button>
            </>
          ) : (
            <>
              {/* глагол неудавшейся загрузки живёт на кнопке рядом, поэтому
                  сама строка говорит только о том, что случилось (WP-N) */}
              <span>
                {auxDl.status === "error"
                  ? dlErrorFix(auxDl.error).cause
                  : t("gl.auxPitch", { size: sizeLabel("aux") })}
              </span>
              <button className={QUIET_LINK} onClick={() => startDownload("aux")}>
                {auxDl.received > 0 && (auxDl.status === "cancelled" || auxDl.status === "error")
                  ? t("gl.auxResume", { pct: dlPct(auxDl) })
                  : t("ui.download")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
