// Настройки (WP-L): одна тихая модалка — тема, кегль перевода, папка
// библиотеки, модели на диске, хранилище. Ничего больше (план §2).
// Грамматика поверхности — solid-модалка как About/ShortcutsOverlay; сегмент
// темы повторяет пилюлю Ориг|Перевод из тулбара; деструктивные действия — по
// паттерну #11: следствие + красная кнопка, называющая действие, + «Отмена».
// Скачивание/удаление моделей — та же машинерия, что в ModelSetup (общий
// download-store, resumable .part, delete_model в Rust глушит только НАШ
// спавн llama-server и никогда не трогает внешний).

import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readFile, remove, stat } from "@tauri-apps/plugin-fs";
import { appDataDir } from "@tauri-apps/api/path";
import { IconClose } from "./icons";
import {
  MODEL_META,
  Progress,
  cancelDownload,
  deleteModel,
  dlBusy,
  fetchDlSnapshot,
  startDownload,
  useDownload,
} from "./ModelSetup";
import type { ModelKey } from "./ModelSetup";
import { listRuns, onRunsChange } from "./booktranslate";

export const TR_FONT_DEFAULT = 15.5;
export const TR_FONT_MIN = 13;
export const TR_FONT_MAX = 19;
const TR_FONT_STEP = 0.5;

// «15,5» / «16» — десятичная запятая, без хвоста ,0
const fmtPx = (v: number) => v.toFixed(1).replace(".", ",").replace(/,0$/, "");

const fmtSize = (b: number) =>
  b >= 1e9
    ? `${(b / 1e9).toFixed(1).replace(".", ",")} ГБ`
    : b >= 1e6
      ? `${Math.round(b / 1e6)} МБ`
      : `${Math.max(1, Math.round(b / 1e3))} КБ`;

const ruPlural = (n: number, one: string, few: string, many: string) => {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return one;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return few;
  return many;
};

// тихая инлайн-ссылка (грамматика MENU_QUIET) и шаг кегля; красный вариант —
// ОТДЕЛЬНЫЙ класс: два hover:text-* в одном списке разрешает порядок CSS,
// а не порядок в className
const QUIET_BTN =
  "text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-700 dark:hover:text-neutral-200";
const QUIET_RED_BTN = "text-neutral-500 dark:text-neutral-400 transition-colors hover:text-red-600 dark:hover:text-red-400";
const STEP_BTN =
  "rounded-md px-1.5 transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10 disabled:pointer-events-none disabled:text-neutral-300 dark:disabled:text-neutral-600";
const RED_BTN =
  "-mx-1 px-1 rounded text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/10";
const PLAIN_BTN = "-mx-1 px-1 rounded transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700/70";

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

// ---- model row --------------------------------------------------------------

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

  const size = MODEL_META[model].size;
  const ready = snap?.ready === true;
  const received = Math.max(snap?.received ?? 0, dl.status === "cancelled" || dl.status === "error" ? dl.received : 0);
  const partial = !ready && received > 0;

  const doDelete = async () => {
    setConfirmDel(false);
    try {
      await deleteModel(model);
      setErr(null);
    } catch (e) {
      setErr(String(e).includes("busy") ? "Идёт скачивание — сначала отмените его" : "Не удалось удалить — файл занят другим процессом");
    }
    refresh();
  };

  return (
    <div className="py-1.5">
      <div className="flex items-center gap-3">
        <span className="shrink-0">
          {label} <span className="ml-1 text-xs text-neutral-500 dark:text-neutral-400">{desc}</span>
        </span>
        <span className="flex-1" />
        {busy ? null : ready ? (
          <span className="flex items-center gap-3 text-xs">
            <span className="text-neutral-500 dark:text-neutral-400">{MODEL_META[model].sizeLabel} на диске</span>
            {!confirmDel && (
              <button className={QUIET_RED_BTN} onClick={() => setConfirmDel(true)}>
                Удалить
              </button>
            )}
          </span>
        ) : partial ? (
          <span className="flex items-center gap-3 text-xs">
            <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
              скачано {Math.floor((100 * received) / size)}%
            </span>
            <button className={QUIET_BTN} onClick={() => startDownload(model)}>
              Продолжить
            </button>
            {!confirmDel && (
              <button className={QUIET_RED_BTN} onClick={() => setConfirmDel(true)}>
                Удалить
              </button>
            )}
          </span>
        ) : snap === null ? (
          <span className="text-xs text-neutral-500 dark:text-neutral-400">—</span>
        ) : (
          <span className="flex items-center gap-3 text-xs">
            <span className="text-neutral-500 dark:text-neutral-400">не установлена</span>
            <button className={QUIET_BTN} onClick={() => startDownload(model)}>
              Скачать ({MODEL_META[model].sizeLabel})
            </button>
          </span>
        )}
      </div>
      {busy && (
        <div className="mt-1.5">
          <Progress dl={dl} onCancel={() => cancelDownload(model)} />
        </div>
      )}
      {confirmDel && (
        <div className="mt-1 text-xs">
          <div className="text-neutral-600 dark:text-neutral-300">{confirmNote}</div>
          <div className="mt-1 flex items-center gap-3">
            <button className={RED_BTN} onClick={() => void doDelete()}>
              Удалить
            </button>
            <button className={PLAIN_BTN} onClick={() => setConfirmDel(false)}>
              Отмена
            </button>
          </div>
        </div>
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
      if (e.isDirectory || e.name.endsWith(".tmp")) continue; // .tmp — незавершённая атомарная запись, не книга
      const st = await stat(`${path}\\${e.name}`).catch(() => null);
      if (st && st.size > 0) {
        files++;
        bytes += st.size;
      }
    }
  } catch {
    // папки ещё нет (или plain browser) — нули
  }
  return { files, bytes };
}

// Per-book разбивка хранилища (WP-M): каждая строка — один store-файл.
// bookPath — второе поле в JSON.stringify-выводе движка, так что префикса
// файла хватает, чтобы узнать книгу без парсинга многомегабайтного JSON.
type TrRow = { file: string; path: string; title: string; bytes: number };

async function listTranslations(): Promise<TrRow[]> {
  const idx = JSON.parse(localStorage.getItem("pdfer:books") ?? "{}") as Record<string, { title?: string }>;
  const rows: TrRow[] = [];
  try {
    const dir = `${await appDataDir()}\\translations`;
    for (const e of await readDir(dir)) {
      if (e.isDirectory || !/\.json$/i.test(e.name)) continue;
      const full = `${dir}\\${e.name}`;
      const st = await stat(full).catch(() => null);
      if (!st || st.size === 0) continue;
      let path = "";
      try {
        const head = new TextDecoder().decode((await readFile(full)).slice(0, 2048));
        const m = head.match(/"bookPath":"((?:[^"\\]|\\.)*)"/);
        if (m) path = JSON.parse(`"${m[1]}"`) as string;
      } catch {
        // заголовок нечитаем — строка останется с именем файла
      }
      const name = path.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || e.name.replace(/\.json$/i, "");
      rows.push({ file: full, path, title: idx[path]?.title || name, bytes: st.size });
    }
  } catch {
    // папки ещё нет (или plain browser)
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

async function clearDir(path: string): Promise<void> {
  try {
    for (const e of await readDir(path)) {
      if (e.isDirectory) continue;
      await remove(`${path}\\${e.name}`).catch(() => {});
    }
  } catch {
    // nothing to clear
  }
}

// ---- modal ------------------------------------------------------------------

export function SettingsModal({
  dark,
  onTheme,
  trFont,
  onTrFont,
  onTranslationsCleared,
  onExportTxt,
  onClose,
}: {
  dark: boolean;
  onTheme: (dark: boolean) => void;
  trFont: number;
  onTrFont: (px: number) => void;
  onTranslationsCleared: (path?: string) => void;
  // вторичный экспорт открытой книги (главный — HTML одной кнопкой из меню);
  // undefined = книга не открыта или переведённых страниц нет — строки нет
  onExportTxt?: () => void;
  onClose: () => void;
}) {
  const [libDir, setLibDir] = useState<string | null>(() => localStorage.getItem("pdfer:libdir"));
  const [trStat, setTrStat] = useState<DirStat | null>(null);
  const [coverStat, setCoverStat] = useState<DirStat | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
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
        setTrStat(await dirStat(`${d}\\translations`));
        setCoverStat(await dirStat(`${d}\\covers`));
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
    if (d) await clearDir(`${d}\\translations`);
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
    if (d) await clearDir(`${d}\\covers`);
    // индекс указывает на удалённые файлы — сброс, чтобы обложки пересоздались
    localStorage.removeItem("pdfer:books");
    refreshStorage();
  }, [refreshStorage]);

  const dirName = libDir ? (libDir.split(/[\\/]/).filter(Boolean).pop() ?? libDir) : null;

  return (
    <div
      className="modal-backdrop fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel w-[min(26rem,90vw)] rounded-xl bg-white p-4 text-sm text-neutral-800 shadow-2xl dark:bg-neutral-800 dark:text-neutral-100 select-none">
        <div className="mb-2 flex items-center text-xs text-neutral-500 dark:text-neutral-400">
          <span>Настройки</span>
          <span className="flex-1" />
          <button
            className="px-0.5 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
            onClick={onClose}
            title="Закрыть (Esc)"
          >
            <IconClose />
          </button>
        </div>

        <Row label="Тема">
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
                {d ? "Тёмная" : "Светлая"}
              </button>
            ))}
          </div>
        </Row>

        <Row label="Размер текста перевода" title="Кегль текста в режиме «Перевод» при масштабе 100%">
          <span className="flex items-center gap-1">
            {trFont !== TR_FONT_DEFAULT && (
              <button className={`mr-2 text-xs ${QUIET_BTN}`} onClick={() => onTrFont(TR_FONT_DEFAULT)}>
                Сбросить
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

        <Row label="Папка библиотеки" title={libDir ?? undefined}>
          <span className="flex items-center gap-3 text-xs">
            <span className="max-w-[11rem] truncate text-neutral-500 dark:text-neutral-400">
              {dirName ?? "не выбрана"}
            </span>
            <button className={QUIET_BTN} onClick={() => void pickLibDir()}>
              Сменить
            </button>
          </span>
        </Row>

        <SectionLabel>Модели</SectionLabel>
        <ModelRow
          model="main"
          label="Перевод"
          desc="HY-MT1.5 · EN→RU"
          confirmNote="Файл модели будет удалён с диска — перевод перестанет работать до повторного скачивания"
        />
        <ModelRow model="aux" label="Термины" desc="Qwen3.5 · глоссарий" confirmNote="Файл модели будет удалён с диска" />

        <SectionLabel>Хранилище</SectionLabel>
        <div className="py-1.5">
          <div className="flex items-center gap-3">
            <span className="shrink-0">Переводы книг</span>
            <span className="flex-1" />
            <span className="flex items-center gap-3 text-xs">
              <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
                {trStat === null
                  ? "…"
                  : trStat.files === 0
                    ? "нет"
                    : `${trStat.files} ${ruPlural(trStat.files, "книга", "книги", "книг")} · ${fmtSize(trStat.bytes)}`}
              </span>
              {trStat !== null && trStat.files > 0 && (
                <button className={QUIET_BTN} onClick={toggleBooks}>
                  {showBooks ? "Свернуть" : "По книгам"}
                </button>
              )}
              {trStat !== null && trStat.files > 0 && !confirmClear && (
                <button
                  className={`${QUIET_RED_BTN} disabled:pointer-events-none disabled:text-neutral-300 dark:disabled:text-neutral-600`}
                  disabled={runsActive}
                  title={runsActive ? "Идёт перевод книги — сначала приостановите его" : undefined}
                  onClick={() => setConfirmClear(true)}
                >
                  Очистить
                </button>
              )}
            </span>
          </div>
          {confirmClear && (
            <div className="mt-1 text-xs">
              <div className="text-neutral-600 dark:text-neutral-300">Все сохранённые переводы будут удалены</div>
              <div className="mt-1 flex items-center gap-3">
                <button className={RED_BTN} onClick={() => void clearTranslations()}>
                  Удалить переводы
                </button>
                <button className={PLAIN_BTN} onClick={() => setConfirmClear(false)}>
                  Отмена
                </button>
              </div>
            </div>
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
                          className={`${QUIET_RED_BTN} disabled:pointer-events-none disabled:text-neutral-300 dark:disabled:text-neutral-600`}
                          disabled={running}
                          title={running ? "Идёт перевод книги — сначала приостановите его" : undefined}
                          onClick={() => setConfirmRow(r.file)}
                        >
                          Удалить
                        </button>
                      )}
                    </div>
                    {confirmRow === r.file && (
                      <div className="mt-1">
                        <div className="text-neutral-600 dark:text-neutral-300">Перевод книги будет удалён</div>
                        <div className="mt-1 flex items-center gap-3">
                          <button className={RED_BTN} onClick={() => void deleteRow(r)}>
                            Удалить перевод
                          </button>
                          <button className={PLAIN_BTN} onClick={() => setConfirmRow(null)}>
                            Отмена
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            ))}
        </div>
        {onExportTxt && (
          <Row
            label="Перевод открытой книги"
            title="Сохранить перевод простым текстом — без картинок и вёрстки; папку и имя спросит диалог"
          >
            <button className={`text-xs ${QUIET_BTN}`} onClick={onExportTxt}>
              Экспорт в TXT…
            </button>
          </Row>
        )}
        <Row label="Обложки библиотеки" title="Создаются заново при открытии библиотеки">
          <span className="flex items-center gap-3 text-xs">
            <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
              {coverStat === null ? "…" : coverStat.files === 0 ? "нет" : fmtSize(coverStat.bytes)}
            </span>
            {coverStat !== null && coverStat.files > 0 && (
              <button className={QUIET_BTN} onClick={() => void clearCovers()}>
                Очистить
              </button>
            )}
          </span>
        </Row>
      </div>
    </div>
  );
}
