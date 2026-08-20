// Settings (WP-L): one quiet modal — theme, language, translation type size,
// library folder, models on disk, external dependencies, storage. Nothing more.
// Surface grammar: a solid modal like About/ShortcutsOverlay; the theme segment
// echoes the Orig|Translation pill from the toolbar; destructive actions follow
// the house pattern — consequence, then a red button naming the action, then
// «Cancel». Model download/delete reuses ModelSetup's machinery (shared
// download store, resumable .part; delete_model in Rust only ever kills the
// llama-server WE spawned and never touches an external one).

import { useCallback, useEffect, useState } from "react";
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
import { CLAUDE, LLAMA, baseName, joinPath } from "./host";
import { fmtNum, fmtSize, getLang, setLang, t, type Lang } from "./i18n";

export const TR_FONT_DEFAULT = 15.5;
export const TR_FONT_MIN = 13;
export const TR_FONT_MAX = 19;
const TR_FONT_STEP = 0.5;

// «15,5» / «16» — no trailing ,0
const fmtPx = (v: number) => fmtNum(v).replace(/[.,]0$/, "");

// A quiet inline link (MENU_QUIET's grammar) and the type-size stepper; the red
// variant is a SEPARATE class: two hover:text-* in one list is resolved by CSS
// order, not by the order in className
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

  return (
    <div className="py-1.5">
      <div className="flex items-center gap-3">
        <span className="shrink-0">
          {label} <span className="ml-1 text-xs text-neutral-500 dark:text-neutral-400">{desc}</span>
        </span>
        <span className="flex-1" />
        {busy ? null : ready ? (
          <span className="flex items-center gap-3 text-xs">
            <span className="text-neutral-500 dark:text-neutral-400">
              {t("set.onDisk", { size: sizeLabel(model) })}
            </span>
            {!confirmDel && (
              <button className={QUIET_RED_BTN} onClick={() => setConfirmDel(true)}>
                {t("ui.delete")}
              </button>
            )}
          </span>
        ) : partial ? (
          <span className="flex items-center gap-3 text-xs">
            <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
              {t("set.downloaded", { pct: Math.floor((100 * received) / size) })}
            </span>
            <button className={QUIET_BTN} onClick={() => startDownload(model)}>
              {t("set.resume")}
            </button>
            {!confirmDel && (
              <button className={QUIET_RED_BTN} onClick={() => setConfirmDel(true)}>
                {t("ui.delete")}
              </button>
            )}
          </span>
        ) : snap === null ? (
          <span className="text-xs text-neutral-500 dark:text-neutral-400">—</span>
        ) : (
          <span className="flex items-center gap-3 text-xs">
            <span className="text-neutral-500 dark:text-neutral-400">{t("set.notInstalled")}</span>
            <button className={QUIET_BTN} onClick={() => startDownload(model)}>
              {t("ui.download")} ({sizeLabel(model)})
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
              {t("ui.delete")}
            </button>
            <button className={PLAIN_BTN} onClick={() => setConfirmDel(false)}>
              {t("ui.cancel")}
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
// without parsing a multi-megabyte JSON.
type TrRow = { file: string; path: string; title: string; bytes: number };

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
      try {
        const head = new TextDecoder().decode((await readFile(full)).slice(0, 2048));
        const m = head.match(/"bookPath":"((?:[^"\\]|\\.)*)"/);
        if (m) path = JSON.parse(`"${m[1]}"`) as string;
      } catch {
        // the header is unreadable — the row keeps the file name
      }
      const name = baseName(path).replace(/\.pdf$/i, "") || e.name.replace(/\.json$/i, "");
      rows.push({ file: full, path, title: idx[path]?.title || name, bytes: st.size });
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

/// One external program: present or not, with a link to its install docs. The
/// install command itself lives in the setup wizard — this row is a status
/// line, not a second place to teach the same thing.
function DependencyRow({
  label,
  status,
  ready,
  missing,
  docs,
  onRecheck,
}: {
  label: string;
  name: string;
  status: { installed: boolean; path: string | null; version: string | null } | null;
  ready: string;
  missing: string;
  docs: string;
  onRecheck: () => void;
}) {
  const installed = status?.installed === true;
  return (
    <Row label={label} title={status?.path ?? undefined}>
      <span className="flex items-center gap-3 text-xs">
        <span className="max-w-[12rem] truncate text-neutral-500 dark:text-neutral-400">
          {status === null ? "…" : installed ? (status.version ?? ready) : missing}
        </span>
        {status !== null && !installed && (
          <button className={QUIET_BTN} onClick={() => void open_docs(docs)}>
            {t("set.howToInstall")}
          </button>
        )}
        {status !== null && !installed && (
          <button className={QUIET_BTN} onClick={onRecheck}>
            {t("ob.engineRecheck")}
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
  // вторичный экспорт открытой книги (главный — HTML одной кнопкой из меню);
  // undefined = книга не открыта или переведённых страниц нет — строки нет
  onExportTxt?: () => void;
  // re-open the first-run wizard; undefined only in surfaces that cannot host it
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
              <button className={`mr-2 text-xs ${QUIET_BTN}`} onClick={() => onTrFont(TR_FONT_DEFAULT)}>
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
          <span className="flex items-center gap-3 text-xs">
            <span className="max-w-[11rem] truncate text-neutral-500 dark:text-neutral-400">
              {dirName ?? t("set.noFolder")}
            </span>
            <button className={QUIET_BTN} onClick={() => void pickLibDir()}>
              {t("set.change")}
            </button>
          </span>
        </Row>

        <SectionLabel>{t("set.models")}</SectionLabel>
        <ModelRow
          model="main"
          label={t("set.modelTr")}
          desc={t("set.modelTrDesc")}
          confirmNote={t("set.modelTrConfirm")}
        />
        <ModelRow
          model="aux"
          label={t("set.modelTerms")}
          desc={t("set.modelTermsDesc")}
          confirmNote={t("set.modelTermsConfirm")}
        />
        <DependencyRow
          label={t("set.engine")}
          name={LLAMA.name}
          status={deps.engine}
          ready={t("set.engineReady")}
          missing={t("set.engineMissing")}
          docs={LLAMA.docs}
          onRecheck={deps.refresh}
        />
        <DependencyRow
          label={t("set.claude")}
          name={CLAUDE.name}
          status={deps.claude}
          ready={`${CLAUDE.name}: ${t("set.claudeReady")}`}
          missing={`${CLAUDE.name}: ${t("set.claudeMissing")}`}
          docs={CLAUDE.docs}
          onRecheck={deps.refresh}
        />
        {onRerunSetup && (
          <Row label={t("set.setup")}>
            <button className={`text-xs ${QUIET_BTN}`} onClick={onRerunSetup}>
              {t("ob.rerun")}
            </button>
          </Row>
        )}

        <SectionLabel>{t("set.storage")}</SectionLabel>
        <div className="py-1.5">
          <div className="flex items-center gap-3">
            <span className="shrink-0">{t("set.translations")}</span>
            <span className="flex-1" />
            <span className="flex items-center gap-3 text-xs">
              <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
                {trStat === null
                  ? "…"
                  : trStat.files === 0
                    ? t("ui.none")
                    : `${t("set.books", { n: trStat.files })} · ${fmtSize(trStat.bytes)}`}
              </span>
              {trStat !== null && trStat.files > 0 && (
                <button className={QUIET_BTN} onClick={toggleBooks}>
                  {showBooks ? t("set.collapse") : t("set.byBook")}
                </button>
              )}
              {trStat !== null && trStat.files > 0 && !confirmClear && (
                <button
                  className={`${QUIET_RED_BTN} disabled:pointer-events-none disabled:text-neutral-300 dark:disabled:text-neutral-600`}
                  disabled={runsActive}
                  title={runsActive ? t("set.busyTr") : undefined}
                  onClick={() => setConfirmClear(true)}
                >
                  {t("set.clear")}
                </button>
              )}
            </span>
          </div>
          {confirmClear && (
            <div className="mt-1 text-xs">
              <div className="text-neutral-600 dark:text-neutral-300">{t("set.clearAllWarn")}</div>
              <div className="mt-1 flex items-center gap-3">
                <button className={RED_BTN} onClick={() => void clearTranslations()}>
                  {t("set.clearAll")}
                </button>
                <button className={PLAIN_BTN} onClick={() => setConfirmClear(false)}>
                  {t("ui.cancel")}
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
                          title={running ? t("set.busyTr") : undefined}
                          onClick={() => setConfirmRow(r.file)}
                        >
                          {t("ui.delete")}
                        </button>
                      )}
                    </div>
                    {confirmRow === r.file && (
                      <div className="mt-1">
                        <div className="text-neutral-600 dark:text-neutral-300">{t("set.clearOneWarn")}</div>
                        <div className="mt-1 flex items-center gap-3">
                          <button className={RED_BTN} onClick={() => void deleteRow(r)}>
                            {t("set.clearOne")}
                          </button>
                          <button className={PLAIN_BTN} onClick={() => setConfirmRow(null)}>
                            {t("ui.cancel")}
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
          <Row label={t("set.exportTxtRow")} title={t("set.exportTxtTitle")}>
            <button className={`text-xs ${QUIET_BTN}`} onClick={onExportTxt}>
              {t("set.exportTxt")}
            </button>
          </Row>
        )}
        <Row label={t("set.covers")} title={t("set.coversTitle")}>
          <span className="flex items-center gap-3 text-xs">
            <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
              {coverStat === null ? "…" : coverStat.files === 0 ? t("ui.none") : fmtSize(coverStat.bytes)}
            </span>
            {coverStat !== null && coverStat.files > 0 && (
              <button className={QUIET_BTN} onClick={() => void clearCovers()}>
                {t("set.clear")}
              </button>
            )}
          </span>
        </Row>
      </div>
    </div>
  );
}
