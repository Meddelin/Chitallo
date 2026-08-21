// Settings (WP-L): one quiet modal — theme, language, translation type size,
// library folder, models on disk, external dependencies, the knowledge graph,
// storage. Nothing more.
//
// У графа здесь три галочки и одна команда. Галочки — единственные строки окна,
// под которыми осталась объясняющая фраза: у выключателя нет числа, которым он
// рассказал бы о себе сам. Вторая из них, «Разрешить поиск в интернете», решает,
// уходит ли вопрос с машины, и потому набрана ровно тем же, чем и первая: это
// часть «Спросить», а не отдельная опасность, и пугать ею читателя нечестно.
// Третья, «Разбирать открытые статьи через Claude Code», тоже решает, что уходит
// наружу, и набрана тем же самым: выделить цветом одну из двух строк об одном и
// том же — значит соврать, будто вторая безобиднее.
// Перестройка всего графа — это часы работы, поэтому она спрашивает один раз,
// красным, прямо под строкой, тем же <Confirm>, что и удаление переводов.
//
// (WP-N) Every row is built by one rule: name on the left, state as a number or
// a word in the middle, the verb last. There are no explanatory sentences left —
// the state took their place, and a row that has nothing to report shows nothing.
// Destructive actions still name their volume («Delete the model: 4.1 GB») and
// still ask once, in red, right under the row. Model download/delete reuses
// ModelSetup's machinery (shared download store, resumable .part; delete_model
// in Rust only ever kills the llama-server WE spawned, never an external one).

import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readFile, remove, stat } from "@tauri-apps/plugin-fs";
import { appDataDir } from "@tauri-apps/api/path";
import { IconClose } from "./icons";
import {
  MODEL_SIZE,
  Progress,
  cancelDownload,
  deleteModel,
  dlBusy,
  fetchDlSnapshot,
  sizeLabel,
  startDownload,
  useDownload,
} from "./ModelSetup";
import type { ModelKey } from "./ModelSetup";
import { listRuns, onRunsChange } from "./booktranslate";
import { useDependencies } from "./Depends";
import {
  autoBuild,
  claudeDeepen,
  listGraphRuns,
  onGraphRunsChange,
  queueLength,
  rebuild,
  setAutoBuild,
  setClaudeDeepen,
  stopAll,
} from "./graphrun";
import { clearGraph, graphStats, onGraphChange } from "./graphstore";
import { CLAUDE, LLAMA, baseName, joinPath } from "./host";
import { fmtNum, fmtSize, getLang, setLang, t, type Lang } from "./i18n";

export const TR_FONT_DEFAULT = 15.5;
export const TR_FONT_MIN = 13;
export const TR_FONT_MAX = 19;
const TR_FONT_STEP = 0.5;

// «15,5» / «16» — no trailing ,0
const fmtPx = (v: number) => fmtNum(v).replace(/[.,]0$/, "");

// The verb that closes a row: the ink of the row, one house hover, no border.
// The red variant is a SEPARATE class — two hover:* in one list are resolved by
// CSS order, not by the order in className.
const ACT_BTN =
  "shrink-0 -mx-1 rounded-md px-1 text-xs transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10 disabled:pointer-events-none disabled:text-neutral-300 dark:disabled:text-neutral-600";
const ACT_RED =
  "shrink-0 -mx-1 rounded-md px-1 text-xs text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/10 disabled:pointer-events-none disabled:text-neutral-300 dark:disabled:text-neutral-600";
// the state itself, when it doubles as the disclosure for a breakdown
const STATE = "shrink-0 tabular-nums text-xs text-neutral-500 dark:text-neutral-400";
const STATE_BTN = `${STATE} rounded-md transition-colors hover:text-neutral-700 dark:hover:text-neutral-200`;
const STEP_BTN =
  "rounded-md px-1.5 transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10 disabled:pointer-events-none disabled:text-neutral-300 dark:disabled:text-neutral-600";
const RED_BTN = "-mx-1 px-1 rounded-md text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/10";
const PLAIN_BTN = "-mx-1 px-1 rounded-md transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10";

function Row({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5" title={title}>
      <span className="shrink-0">{label}</span>
      <span className="flex-1" />
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 border-t border-neutral-200 pt-2 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
      {children}
    </div>
  );
}

/// The confirmation of a destructive row: the volume, then the red verb.
function Confirm({ note, verb, onYes, onNo }: { note: string; verb: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="mt-1 text-xs">
      <div className="text-neutral-600 dark:text-neutral-300">{note}</div>
      <div className="mt-1 flex items-center gap-3">
        <button className={RED_BTN} onClick={onYes}>
          {verb}
        </button>
        <button className={PLAIN_BTN} onClick={onNo}>
          {t("ui.cancel")}
        </button>
      </div>
    </div>
  );
}

/// Выключатель «да/нет». Своей формы для него у окна не было: тема и язык — это
/// выбор из двух ИМЁН, и таблетка с подписями там на месте, а «включено» и
/// «выключено» пришлось бы выдумывать словами и заводить под них ключи. Поэтому
/// дорожка взята у той же таблетки (`rounded-full`, та же нейтральная подложка),
/// а вместо второй подписи по ней ездит белый бегунок. Включённое состояние
/// красится единственным активным цветом программы, а не зелёным и не красным:
/// «включено» — это состояние, а не тревога.
function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
        on ? "bg-accent" : "bg-neutral-200 dark:bg-neutral-700"
      }`}
      onClick={() => onChange(!on)}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-[left] ${
          on ? "left-3.5" : "left-0.5"
        }`}
      />
    </button>
  );
}

/// Фраза под строкой-выключателем — единственное исключение из правила «состояние
/// вместо объяснения» (WP-N). У числа состояние есть, у галочки его нет, а
/// сказать под ней есть что: одна решает, когда машина начинает работать, вторая
/// — что уходит с машины наружу.
function Hint({ children }: { children: React.ReactNode }) {
  return <div className="-mt-1 pb-1.5 text-xs leading-snug text-neutral-500 dark:text-neutral-400">{children}</div>;
}

// ---- model row --------------------------------------------------------------

/// «Translation model · HY-MT1.5 · 4.1 GB · Delete» — the model's name and what
/// it costs on disk are one state, the verb is what to do about it.
function ModelRow({ model, label, desc, confirmNote }: { model: ModelKey; label: string; desc: string; confirmNote: string }) {
  const dl = useDownload(model);
  // undefined = ещё не читали диск; null = plain browser (нет Tauri)
  const [snap, setSnap] = useState<{ ready: boolean; received: number; running: boolean } | null | undefined>(undefined);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void fetchDlSnapshot(model).then(setSnap);
  }, [model]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  // терминальные переходы скачивания (done/cancelled/error) обновляют снимок
  const busy = dlBusy(dl);
  useEffect(() => {
    if (!busy) refresh();
  }, [busy, refresh]);

  const size = MODEL_SIZE[model];
  const ready = snap?.ready === true;
  const received = Math.max(snap?.received ?? 0, dl.status === "cancelled" || dl.status === "error" ? dl.received : 0);
  const partial = !ready && received > 0;

  const doDelete = async () => {
    setConfirmDel(false);
    try {
      await deleteModel(model);
      setErr(null);
    } catch (e) {
      setErr(String(e).includes("busy") ? t("set.deleteBusy") : t("set.deleteFail"));
    }
    refresh();
  };

  const state = ready
    ? `${desc} · ${t("set.onDisk", { size: sizeLabel(model) })}`
    : partial
      ? `${desc} · ${t("set.downloaded", { pct: Math.floor((100 * received) / size) })}`
      : snap === undefined || snap === null
        ? desc
        : `${desc} · ${t("set.notInstalled")}`;

  return (
    <div className="py-1.5">
      <div className="flex items-center gap-3">
        <span className="shrink-0">{label}</span>
        <span className="flex-1" />
        {!busy && (
          <span className="flex items-center gap-3">
            <span className={STATE}>{state}</span>
            {partial && (
              <button className={ACT_BTN} onClick={() => startDownload(model)}>
                {t("set.resume")}
              </button>
            )}
            {(ready || partial) && !confirmDel && (
              <button className={ACT_RED} onClick={() => setConfirmDel(true)}>
                {t("ui.delete")}
              </button>
            )}
            {!ready && !partial && snap != null && (
              <button className={ACT_BTN} onClick={() => startDownload(model)}>
                {t("ui.download")} {sizeLabel(model)}
              </button>
            )}
          </span>
        )}
      </div>
      {busy && (
        <div className="mt-1.5">
          <Progress dl={dl} onCancel={() => cancelDownload(model)} />
        </div>
      )}
      {confirmDel && (
        <Confirm
          note={confirmNote}
          verb={t("ui.delete")}
          onYes={() => void doDelete()}
          onNo={() => setConfirmDel(false)}
        />
      )}
      {err && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{err}</div>}
    </div>
  );
}

// ---- storage ----------------------------------------------------------------

type DirStat = { files: number; bytes: number };

async function dirStat(path: string): Promise<DirStat> {
  let files = 0;
  let bytes = 0;
  try {
    for (const e of await readDir(path)) {
      if (e.isDirectory || e.name.endsWith(".tmp")) continue; // .tmp — a half-finished atomic write, not a book
      const st = await stat(joinPath(path, e.name)).catch(() => null);
      if (st && st.size > 0) {
        files++;
        bytes += st.size;
      }
    }
  } catch {
    // the folder does not exist yet (or plain browser) — zeroes
  }
  return { files, bytes };
}

// Per-book storage breakdown: one row per store file. bookPath is the second
// field the engine writes, so the file's prefix is enough to name the book
// without parsing a multi-megabyte JSON; donePages is written AFTER the pages,
// so the count that a destructive line has to name comes from the tail. (WP-N)
type TrRow = { file: string; path: string; title: string; bytes: number; pages: number };

const TAIL = 262_144;

function tailPages(bytes: Uint8Array): number {
  try {
    const tail = new TextDecoder().decode(bytes.slice(Math.max(0, bytes.length - TAIL)));
    const m = tail.match(/"donePages":\[([^\]]*)\]/);
    if (!m) return 0;
    return m[1].trim() === "" ? 0 : m[1].split(",").length;
  } catch {
    return 0; // unreadable tail — the row simply names no page count
  }
}

async function listTranslations(): Promise<TrRow[]> {
  const idx = JSON.parse(localStorage.getItem("pdfer:books") ?? "{}") as Record<string, { title?: string }>;
  const rows: TrRow[] = [];
  try {
    const dir = joinPath(await appDataDir(), "translations");
    for (const e of await readDir(dir)) {
      if (e.isDirectory || !/\.json$/i.test(e.name)) continue;
      const full = joinPath(dir, e.name);
      const st = await stat(full).catch(() => null);
      if (!st || st.size === 0) continue;
      let path = "";
      let pages = 0;
      try {
        const raw = await readFile(full);
        const head = new TextDecoder().decode(raw.slice(0, 2048));
        const m = head.match(/"bookPath":"((?:[^"\\]|\\.)*)"/);
        if (m) path = JSON.parse(`"${m[1]}"`) as string;
        pages = tailPages(raw);
      } catch {
        // the header is unreadable — the row keeps the file name
      }
      const name = baseName(path).replace(/\.pdf$/i, "") || e.name.replace(/\.json$/i, "");
      rows.push({ file: full, path, title: idx[path]?.title || name, bytes: st.size, pages });
    }
  } catch {
    // the folder does not exist yet (or plain browser)
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

async function clearDir(path: string): Promise<void> {
  try {
    for (const e of await readDir(path)) {
      if (e.isDirectory) continue;
      await remove(joinPath(path, e.name)).catch(() => {});
    }
  } catch {
    // nothing to clear
  }
}

// ---- граф знаний ------------------------------------------------------------

// Ключ заморожен навсегда, как и всё «pdfer:*». Значение — слова «1» / «0», как
// у соседнего «pdfer:graph:auto», а не булев JSON. Отсутствие ключа читается как
// ВЫКЛЮЧЕНО: вопрос уходит в сеть только после того, как читатель сам об этом
// попросил, и молчание настройками за согласие мы не считаем.
const WEB_KEY = "pdfer:ask:web";

/// Книга, которую разбирают прямо сейчас. Упавший ран висит в списке ещё двадцать
/// секунд с текстом ошибки — он ничего не строит, и останавливать в нём нечего,
/// поэтому такие раны не в счёт.
const liveRun = (): { done: number; total: number } | null =>
  listGraphRuns().find((r) => r.error === null) ?? null;

/// Идёт ли сборка прямо сейчас: очередь непуста или какую-то книгу уже разбирают.
const graphBusy = (): boolean => queueLength() > 0 || liveRun() !== null;

/// Пути всех книг, которые библиотека когда-либо видела. Индекс «pdfer:books» —
/// единственный список путей, переживающий перезапуск; обходить ради этого папку
/// заново нельзя — окно настроек не место для сканирования диска.
function bookPaths(): string[] {
  try {
    return Object.keys(JSON.parse(localStorage.getItem("pdfer:books") ?? "{}") as Record<string, unknown>);
  } catch {
    return []; // испорченный индекс — не повод уронить настройки
  }
}

/// Секция графа: три галочки и одна команда над всей библиотекой. «Остановить
/// сборку» показывается только тогда, когда есть что останавливать, — кнопка,
/// которой нечего делать, врала бы о состоянии очереди.
function GraphSection() {
  const [auto, setAuto] = useState(autoBuild);
  // Разбор статей через Claude Code читается из graphrun, а не из localStorage
  // напрямую: ключ и его значение по умолчанию (ВЫКЛЮЧЕНО) принадлежат движку,
  // и второе место, где они записаны словами, рано или поздно разойдётся с ним.
  const [claude, setClaude] = useState(claudeDeepen);
  const [web, setWeb] = useState(() => localStorage.getItem(WEB_KEY) === "1");
  const [run, setRun] = useState(liveRun);
  const [queued, setQueued] = useState(queueLength);
  // список путей читаем один раз на открытие окна: пока читатель сидит в
  // настройках, библиотека не меняется, а разбирать индекс на каждый кадр
  // ради одного числа — работа, за которую никто не платит
  const [books] = useState(bookPaths);
  const [confirmRebuild, setConfirmRebuild] = useState(false);

  // setAutoBuild будит этих же слушателей (выключение зовёт stopAll, включение —
  // emit), поэтому одной подписки хватает и на очередь, и на галочку,
  // переключённую из библиотеки: второго источника правды для неё не заводим.
  useEffect(
    () =>
      onGraphRunsChange(() => {
        setRun(liveRun());
        setQueued(queueLength());
        setAuto(autoBuild());
        // setClaudeDeepen будит тех же слушателей, что и setAutoBuild, поэтому
        // третья галочка держится на той же подписке: заводить ей отдельный
        // источник правды — значит однажды показать не то, что записано.
        setClaude(claudeDeepen());
      }),
    [],
  );
  const busy = run !== null || queued > 0;

  const flipAuto = (on: boolean) => {
    setAuto(on);
    setAutoBuild(on);
  };

  const flipClaude = (on: boolean) => {
    setClaude(on);
    setClaudeDeepen(on);
  };

  const flipWeb = (on: boolean) => {
    setWeb(on);
    localStorage.setItem(WEB_KEY, on ? "1" : "0");
  };

  // Ни одна кнопка этой программы не имеет права молча отменить происхождение,
  // которое читатель проставил рукой, и перестройка всей библиотеки — не
  // исключение. Поэтому общего clearGraph() здесь нет: он сносит шарды с диска
  // ДО того, как сборщик успеет их прочитать, и спасать становится нечего —
  // каждая исправленная книга вернулась бы с вердиктом классификатора, а
  // конференционный доклад, помеченный читателем как «Лицензионная книга»,
  // при включённом разборе через Claude Code уехал бы с машины. Вместо этого
  // каждая книга идёт через ту же rebuild(), что стоит на карточке узла: она
  // выбрасывает старый шард внутри сборки, но перед этим спасает вердикт
  // читателя и переносит его на свежий шард. Инвариант живёт в одном месте —
  // в сборщике, — а не повторяется здесь второй раз и слабее. Прежний порядок
  // «сперва очистить, потом поставить в очередь» больше не нужен: удаление
  // шарда книги происходит внутри её же сборки и с чужой не пересекается.
  //
  // Шард книги, которой в библиотеке уже нет, эта кнопка не трогает: она
  // обещает перестройку, а не освобождение диска, и переименованная книга
  // выглядит отсюда ровно как удалённая — снести её шард значило бы потерять
  // тот самый вердикт по ошибке. Диск освобождает «Очистить» в «Хранилище»:
  // та кнопка прямо называет, что именно выбрасывает.
  const rebuildAll = () => {
    setConfirmRebuild(false);
    for (const p of books) rebuild(p);
  };

  return (
    <>
      <Row label={t("gr.auto")}>
        <Switch on={auto} label={t("gr.auto")} onChange={flipAuto} />
      </Row>
      <Hint>{t("gr.autoHint")}</Hint>

      {/* Строка стоит сразу под «строить автоматически», потому что отвечает на
          следующий вопрос читателя — кто именно разбирает, — и набрана тем же,
          чем и «Разрешить поиск в интернете»: обе про то, что уходит наружу. */}
      <Row label={t("gr.claude")}>
        <Switch on={claude} label={t("gr.claude")} onChange={flipClaude} />
      </Row>
      <Hint>{t("gr.claudeHint")}</Hint>

      <Row label={t("set.web")}>
        <Switch on={web} label={t("set.web")} onChange={flipWeb} />
      </Row>
      <Hint>{t("set.webHint")}</Hint>

      <div className="py-1.5">
        <div className="flex items-center gap-3">
          <span className="shrink-0">{t("lib.title")}</span>
          <span className="flex-1" />
          <span className="flex items-center gap-3">
            {/* Пока идёт сборка, состояние строки — сама сборка, а не размер
                библиотеки. Счётчик страниц показываем только когда он двинулся:
                у только что взятой книги total ещё ноль, и «0 из 0» сказало бы
                неправду там, где очередь говорит правду. */}
            <span className={STATE}>
              {run !== null && run.total > 0
                ? t("gr.building", { done: run.done, n: run.total })
                : busy
                  ? t("gr.queued", { n: queued + (run === null ? 0 : 1) })
                  : books.length > 0
                    ? t("set.books", { n: books.length })
                    : t("ui.none")}
            </span>
            {/* «Перестроить» под работающим сборщиком не показываем вовсе:
                отключённая кнопка рядом с «Остановить сборку» — это лишний шум,
                а не подсказка, и место в строке ей дороже */}
            {busy ? (
              <button
                className={ACT_BTN}
                onClick={() => {
                  setConfirmRebuild(false);
                  stopAll();
                }}
              >
                {t("gr.stopAll")}
              </button>
            ) : (
              !confirmRebuild && (
                <button className={ACT_BTN} disabled={books.length === 0} onClick={() => setConfirmRebuild(true)}>
                  {t("gr.rebuild")}
                </button>
              )
            )}
          </span>
        </div>
        {/* часы работы — спрашиваем один раз и называем объём, тем же <Confirm>,
            что и удаление переводов; новых диалогов окно не заводит */}
        {confirmRebuild && (
          <Confirm
            note={t("gr.queued", { n: books.length })}
            verb={t("gr.rebuildAll")}
            onYes={rebuildAll}
            onNo={() => setConfirmRebuild(false)}
          />
        )}
      </div>
    </>
  );
}

/// Граф в «Хранилище»: сколько книг разобрано и во что это обошлось на диске —
/// теми же двумя величинами и тем же форматом, что и строка переводов. Пока идёт
/// сборка, «Очистить» заперт: очищенный из-под работающего сборщика граф через
/// секунду обзавёлся бы одной свежей книгой и перестал бы быть пустым.
// Окно склейки для замера графа. Сборка библиотеки в 200 книг даёт около
// четырёхсот событий (каждая книга пишется дважды), а один graphStats() — это
// stat() на каждый шард подряд плюс слияние: без склейки замеры наезжают друг на
// друга, настройки перестают отвечать, а сборка теряет главный поток. Секунда —
// это медленнее, чем читатель успевает заметить, и в четыреста раз дешевле.
const GRAPH_STAT_MS = 1000;

function GraphStorageRow() {
  const [stats, setStats] = useState<{ shards: number; bytes: number; concepts: number } | null>(null);
  const [busy, setBusy] = useState(graphBusy);
  const [confirmClear, setConfirmClear] = useState(false);
  // Таймер склейки и «замер уже идёт» живут в ref, а не в состоянии: они ничего
  // не рисуют, а лишняя перерисовка — ровно то, от чего эта строка защищается.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    // Второй обход поверх незакончившегося не даст новой цифры, зато удвоит
    // число IPC-вызовов — а их и так по одному на шард.
    if (inFlight.current) return;
    inFlight.current = true;
    void graphStats()
      .then(setStats)
      .catch(() => setStats({ shards: 0, bytes: 0, concepts: 0 }))
      .finally(() => {
        inFlight.current = false;
      });
  }, []);
  useEffect(refresh, [refresh]);

  const schedule = useCallback(function arm(): void {
    if (timer.current !== null) return; // окно уже открыто — событие в него и попадёт
    timer.current = setTimeout(() => {
      timer.current = null;
      // Предыдущий замер может всё ещё идти: обход шардов не мгновенный. Тогда
      // ждём ещё окно, а не бросаем событие, — иначе число застыло бы на
      // предпоследней книге и врало до самого закрытия окна.
      if (inFlight.current) arm();
      else refresh();
    }, GRAPH_STAT_MS);
  }, [refresh]);

  // сборка дописывает шарды, пока окно открыто, — цифра не должна врать
  useEffect(() => {
    const off = onGraphChange(schedule);
    return () => {
      off();
      // Таймер, переживший размонтирование, дёрнул бы setStats у снятой строки
      // и запустил бы обход шардов уже после того, как окно закрыли.
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [schedule]);
  useEffect(() => onGraphRunsChange(() => setBusy(graphBusy())), []);

  const doClear = async () => {
    setConfirmClear(false);
    await clearGraph();
  };

  return (
    <div className="py-1.5">
      <div className="flex items-center gap-3">
        <span className="shrink-0">{t("gr.title")}</span>
        <span className="flex-1" />
        <span className="flex items-center gap-3">
          <span className={STATE}>
            {stats === null
              ? "…"
              : stats.shards === 0
                ? t("ui.none")
                : `${t("set.books", { n: stats.shards })} · ${fmtSize(stats.bytes)}`}
          </span>
          {stats !== null && stats.shards > 0 && !confirmClear && (
            <button
              className={ACT_RED}
              disabled={busy}
              title={busy ? t("gr.stopAll") : undefined}
              onClick={() => setConfirmClear(true)}
            >
              {t("set.clear")}
            </button>
          )}
        </span>
      </div>
      {confirmClear && stats !== null && (
        <Confirm
          note={t("gr.stats", { n: stats.shards, m: stats.concepts })}
          verb={t("gr.clear")}
          onYes={() => void doClear()}
          onNo={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}

// ---- language + dependency rows ---------------------------------------------

/// The interface language, which is also the language books get translated
/// into. Switching it re-renders every surface through i18n's store.
function LanguageRow() {
  const lang = getLang();
  return (
    <Row label={t("set.language")}>
      <div className="flex gap-0.5 rounded-full bg-neutral-100 p-0.5 text-xs dark:bg-neutral-900/50">
        {(["ru", "en"] as const).map((l: Lang) => (
          <button
            key={l}
            className={`rounded-full px-2 py-0.5 transition-colors ${
              lang === l
                ? "bg-white shadow-sm dark:bg-neutral-700"
                : "text-neutral-500 hover:bg-neutral-900/5 dark:text-neutral-400 dark:hover:bg-neutral-100/10"
            }`}
            onClick={() => setLang(l)}
          >
            {l === "ru" ? "Русский" : "English"}
          </button>
        ))}
      </div>
    </Row>
  );
}

/// One external program: found or not, and — when not — the one verb that leads
/// to the install page. The command itself lives in the first-run checklist;
/// this row is a state line, not a second place to teach the same thing.
function DependencyRow({
  label,
  status,
  ready,
  missing,
  docs,
}: {
  label: string;
  status: { installed: boolean; path: string | null; version: string | null } | null;
  ready: string;
  missing: string;
  docs: string;
}) {
  const installed = status?.installed === true;
  return (
    <Row label={label} title={status?.path ?? undefined}>
      <span className="flex items-center gap-3">
        <span
          className={`max-w-[12rem] truncate text-xs ${
            status !== null && !installed
              ? "text-amber-700 dark:text-amber-500"
              : "text-neutral-500 dark:text-neutral-400"
          }`}
        >
          {status === null ? "…" : installed ? ready : missing}
        </span>
        {status !== null && !installed && (
          <button className={ACT_BTN} onClick={() => void open_docs(docs)}>
            {t("ui.install")}
          </button>
        )}
      </span>
    </Row>
  );
}

const open_docs = (url: string) =>
  import("@tauri-apps/plugin-opener")
    .then((m) => m.openUrl(url))
    .catch(() => window.open(url, "_blank", "noopener"));

// ---- modal ------------------------------------------------------------------

export function SettingsModal({
  dark,
  onTheme,
  trFont,
  onTrFont,
  onTranslationsCleared,
  onExportTxt,
  onRerunSetup,
  onClose,
}: {
  dark: boolean;
  onTheme: (dark: boolean) => void;
  trFont: number;
  onTrFont: (px: number) => void;
  onTranslationsCleared: (path?: string) => void;
  // вторичный экспорт открытой книги (главный — HTML одной кнопкой из панели);
  // undefined = книга не открыта или переведённых страниц нет — строки нет
  onExportTxt?: () => void;
  // re-open the first-run checklist; undefined only in surfaces that cannot host it
  onRerunSetup?: () => void;
  onClose: () => void;
}) {
  const [libDir, setLibDir] = useState<string | null>(() => localStorage.getItem("pdfer:libdir"));
  const [trStat, setTrStat] = useState<DirStat | null>(null);
  const [coverStat, setCoverStat] = useState<DirStat | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const deps = useDependencies();
  // пути книг с активным раном: блокируют и общую очистку, и строку своей книги
  const [runPaths, setRunPaths] = useState<string[]>(() => listRuns().map((r) => r.bookPath));
  useEffect(() => onRunsChange(() => setRunPaths(listRuns().map((r) => r.bookPath))), []);
  const runsActive = runPaths.length > 0;
  // per-book разбивка «Переводов книг»: null = свёрнута/не загружена
  const [showBooks, setShowBooks] = useState(false);
  const [trRows, setTrRows] = useState<TrRow[] | null>(null);
  const [confirmRow, setConfirmRow] = useState<string | null>(null);

  const refreshStorage = useCallback(() => {
    appDataDir()
      .then(async (d) => {
        setTrStat(await dirStat(joinPath(d, "translations")));
        setCoverStat(await dirStat(joinPath(d, "covers")));
      })
      .catch(() => {
        setTrStat({ files: 0, bytes: 0 });
        setCoverStat({ files: 0, bytes: 0 });
      });
  }, []);
  useEffect(refreshStorage, [refreshStorage]);

  const pickLibDir = useCallback(async () => {
    const d = await open({ directory: true });
    if (typeof d === "string") {
      localStorage.setItem("pdfer:libdir", d);
      setLibDir(d);
      // примонтированная библиотека подхватывает смену без ремаунта App
      window.dispatchEvent(new CustomEvent("pdfer:libdir", { detail: d }));
    }
  }, []);

  const clearTranslations = useCallback(async () => {
    setConfirmClear(false);
    setConfirmRow(null);
    const d = await appDataDir().catch(() => null);
    if (d) await clearDir(joinPath(d, "translations"));
    onTranslationsCleared();
    setTrRows((rs) => (rs === null ? rs : []));
    refreshStorage();
  }, [onTranslationsCleared, refreshStorage]);

  const toggleBooks = useCallback(() => {
    setConfirmRow(null);
    setShowBooks((s) => {
      if (!s) void listTranslations().then(setTrRows);
      return !s;
    });
  }, []);

  const deleteRow = useCallback(
    async (r: TrRow) => {
      setConfirmRow(null);
      await remove(r.file).catch(() => {});
      // зеркало открытой книги сбрасывается только если удалили именно её;
      // строка без пути — заведомо нечитаемый store, открытым он не бывает
      if (r.path) onTranslationsCleared(r.path);
      setTrRows((rs) => rs?.filter((x) => x.file !== r.file) ?? rs);
      refreshStorage();
    },
    [onTranslationsCleared, refreshStorage],
  );

  const clearCovers = useCallback(async () => {
    const d = await appDataDir().catch(() => null);
    if (d) await clearDir(joinPath(d, "covers"));
    // индекс указывает на удалённые файлы — сброс, чтобы обложки пересоздались
    localStorage.removeItem("pdfer:books");
    refreshStorage();
  }, [refreshStorage]);

  const dirName = libDir ? (baseName(libDir.replace(/[\\/]+$/, "")) || libDir) : null;

  return (
    <div
      className="modal-backdrop fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel w-[min(26rem,90vw)] rounded-xl bg-white p-4 text-sm text-neutral-800 shadow-2xl dark:bg-neutral-800 dark:text-neutral-100 select-none">
        <div className="mb-2 flex items-center text-xs text-neutral-500 dark:text-neutral-400">
          <span>{t("set.title")}</span>
          <span className="flex-1" />
          <button
            className="px-0.5 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
            onClick={onClose}
            title={t("ui.close")}
          >
            <IconClose />
          </button>
        </div>

        <SectionLabel>{t("keys.view")}</SectionLabel>

        <Row label={t("set.theme")}>
          <div className="flex gap-0.5 rounded-full bg-neutral-100 p-0.5 text-xs dark:bg-neutral-900/50">
            {([false, true] as const).map((d) => (
              <button
                key={String(d)}
                className={`rounded-full px-2 py-0.5 transition-colors ${
                  dark === d
                    ? "bg-white shadow-sm dark:bg-neutral-700"
                    : "text-neutral-500 hover:bg-neutral-900/5 dark:text-neutral-400 dark:hover:bg-neutral-100/10"
                }`}
                onClick={() => onTheme(d)}
              >
                {d ? t("set.dark") : t("set.light")}
              </button>
            ))}
          </div>
        </Row>

        <LanguageRow />

        <Row label={t("set.trFont")} title={t("set.trFontTitle")}>
          <span className="flex items-center gap-1">
            {trFont !== TR_FONT_DEFAULT && (
              <button className={`mr-2 ${ACT_BTN}`} onClick={() => onTrFont(TR_FONT_DEFAULT)}>
                {t("set.reset")}
              </button>
            )}
            <button className={STEP_BTN} disabled={trFont <= TR_FONT_MIN} onClick={() => onTrFont(trFont - TR_FONT_STEP)}>
              −
            </button>
            <span className="w-9 text-center tabular-nums">{fmtPx(trFont)}</span>
            <button className={STEP_BTN} disabled={trFont >= TR_FONT_MAX} onClick={() => onTrFont(trFont + TR_FONT_STEP)}>
              +
            </button>
          </span>
        </Row>

        <Row label={t("set.libFolder")} title={libDir ?? undefined}>
          <span className="flex items-center gap-3">
            <span className="max-w-[11rem] truncate text-xs text-neutral-500 dark:text-neutral-400">
              {dirName ?? t("set.noFolder")}
            </span>
            <button className={ACT_BTN} onClick={() => void pickLibDir()}>
              {t("set.change")}
            </button>
          </span>
        </Row>

        <SectionLabel>{t("set.models")}</SectionLabel>
        <ModelRow
          model="main"
          label={t("set.modelTr")}
          desc={t("set.modelTrDesc")}
          confirmNote={t("set.modelTrConfirm", { size: sizeLabel("main") })}
        />
        <ModelRow
          model="aux"
          label={t("set.modelTerms")}
          desc={t("set.modelTermsDesc")}
          confirmNote={t("set.modelTermsConfirm", { size: sizeLabel("aux") })}
        />
        <DependencyRow
          label={t("set.engine")}
          status={deps.engine}
          ready={t("set.engineReady")}
          missing={t("set.engineMissing")}
          docs={LLAMA.docs}
        />
        <DependencyRow
          label={t("set.claude")}
          status={deps.claude}
          ready={t("set.claudeReady")}
          missing={t("set.claudeMissing")}
          docs={CLAUDE.docs}
        />

        {/* (WP-N) одно имя на одну вещь: заголовок раздела, строка в
            «Хранилище», палитра и лист клавиш зовут граф ключом gr.title */}
        <SectionLabel>{t("gr.title")}</SectionLabel>
        <GraphSection />

        <SectionLabel>{t("set.storage")}</SectionLabel>
        <div className="py-1.5">
          <div className="flex items-center gap-3">
            <span className="shrink-0">{t("set.translations")}</span>
            <span className="flex-1" />
            <span className="flex items-center gap-3">
              {/* the number IS the disclosure: one verb per row, and the
                  breakdown opens from the thing it breaks down */}
              {trStat !== null && trStat.files > 0 ? (
                <button
                  className={STATE_BTN}
                  title={showBooks ? t("set.collapse") : t("set.byBook")}
                  onClick={toggleBooks}
                >
                  {`${t("set.books", { n: trStat.files })} · ${fmtSize(trStat.bytes)}`}
                </button>
              ) : (
                <span className={STATE}>{trStat === null ? "…" : t("ui.none")}</span>
              )}
              {trStat !== null && trStat.files > 0 && !confirmClear && (
                <button
                  className={ACT_RED}
                  disabled={runsActive}
                  title={runsActive ? t("set.busyTr") : undefined}
                  onClick={() => setConfirmClear(true)}
                >
                  {t("set.clear")}
                </button>
              )}
            </span>
          </div>
          {confirmClear && trStat !== null && (
            <Confirm
              note={t("set.clearAllWarn", { n: trStat.files, size: fmtSize(trStat.bytes) })}
              verb={t("set.clearAll")}
              onYes={() => void clearTranslations()}
              onNo={() => setConfirmClear(false)}
            />
          )}
          {showBooks &&
            (trRows === null ? (
              <div className="mt-1 pl-3 text-xs text-neutral-500 dark:text-neutral-400">…</div>
            ) : (
              trRows.map((r) => {
                const running = r.path !== "" && runPaths.includes(r.path);
                return (
                  <div key={r.file} className="mt-1 pl-3 text-xs">
                    <div className="flex items-center gap-3">
                      <span
                        className="max-w-[13rem] truncate text-neutral-600 dark:text-neutral-300"
                        title={r.path || undefined}
                      >
                        {r.title}
                      </span>
                      <span className="flex-1" />
                      <span className="tabular-nums text-neutral-500 dark:text-neutral-400">{fmtSize(r.bytes)}</span>
                      {confirmRow !== r.file && (
                        <button
                          className={ACT_RED}
                          disabled={running}
                          title={running ? t("set.busyTr") : undefined}
                          onClick={() => setConfirmRow(r.file)}
                        >
                          {t("ui.delete")}
                        </button>
                      )}
                    </div>
                    {confirmRow === r.file && (
                      <Confirm
                        note={r.pages > 0 ? t("set.clearOneWarn", { n: r.pages }) : t("set.clearOne")}
                        verb={t("set.clearOne")}
                        onYes={() => void deleteRow(r)}
                        onNo={() => setConfirmRow(null)}
                      />
                    )}
                  </div>
                );
              })
            ))}
        </div>
        {onExportTxt && (
          <Row label={t("set.exportTxtRow")} title={t("set.exportTxtTitle")}>
            <button className={ACT_BTN} onClick={onExportTxt}>
              {t("set.exportTxt")}
            </button>
          </Row>
        )}
        <Row
          label={t("set.covers")}
          title={coverStat !== null ? t("set.coversTitle", { n: coverStat.files }) : undefined}
        >
          <span className="flex items-center gap-3">
            <span className={STATE}>
              {coverStat === null ? "…" : coverStat.files === 0 ? t("ui.none") : fmtSize(coverStat.bytes)}
            </span>
            {coverStat !== null && coverStat.files > 0 && (
              <button className={ACT_BTN} onClick={() => void clearCovers()}>
                {t("set.clear")}
              </button>
            )}
          </span>
        </Row>
        <GraphStorageRow />
        {onRerunSetup && (
          <Row label={t("set.setup")}>
            <button className={ACT_BTN} onClick={onRerunSetup}>
              {t("ob.rerun")}
            </button>
          </Row>
        )}
      </div>
    </div>
  );
}
