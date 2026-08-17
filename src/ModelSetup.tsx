import { useEffect, useState, useSyncExternalStore } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isServerUp } from "./translate";

// ---- model onboarding + the single status vocabulary (WP-B) -----------------
//
// Every surface that talks about the translation model (menu status row,
// popover, glossary modal, library card) reads the SAME status source and the
// SAME download store from here, so one state never has three names.
//
// Status source: Tauri `translation_status` — "none" | "external" | "starting"
// | "spawned" | "dead". A bare /health probe cannot be the source of truth:
// llama-server answers 503 while the model loads, which must read as
// «запускается», never as «не запущена».

export type ModelStatus = "none" | "external" | "starting" | "spawned" | "dead";

export const statusUp = (s: string | null | undefined): boolean => s === "spawned" || s === "external";

export async function fetchModelStatus(): Promise<ModelStatus> {
  if (import.meta.env.DEV) {
    // browser-pane tests force a status; dead code in production builds
    const forced = localStorage.getItem("pdfer:dev:modelstatus");
    if (forced) return forced as ModelStatus;
  }
  try {
    return (await invoke<string>("translation_status")) as ModelStatus;
  } catch {
    // plain browser (vite dev): an HTTP probe of the same server stands in —
    // it cannot tell none from dead, so a silent server reads as "none"
    return (await isServerUp()) ? "external" : "none";
  }
}

/// «Перезапустить»: respawn the llama-server; no-op while starting or up.
export async function restartModel(): Promise<ModelStatus> {
  try {
    return (await invoke<string>("restart_translation")) as ModelStatus;
  } catch {
    return fetchModelStatus();
  }
}

// ---- download store ---------------------------------------------------------
// One module-level subscription per model: every component reads the same
// snapshot via useDownload(), the Rust side keeps the latest channel. Progress
// survives HMR/app restarts through model_download_status + the .part file.

export type ModelKey = "main" | "aux";

export type Dl = {
  status: "idle" | "running" | "verifying" | "done" | "cancelled" | "error";
  received: number;
  total: number;
  bps: number;
  error?: string | null;
};

export const MODEL_META: Record<ModelKey, { size: number; sizeLabel: string }> = {
  main: { size: 4_624_649_312, sizeLabel: "4,6 ГБ" },
  aux: { size: 2_740_937_888, sizeLabel: "2,7 ГБ" },
};

const dlState: Record<ModelKey, Dl> = {
  main: { status: "idle", received: 0, total: MODEL_META.main.size, bps: 0 },
  aux: { status: "idle", received: 0, total: MODEL_META.aux.size, bps: 0 },
};
const listeners = new Set<() => void>();
const setDl = (m: ModelKey, dl: Dl) => {
  dlState[m] = dl;
  listeners.forEach((l) => l());
};

export const dlBusy = (dl: Dl): boolean => dl.status === "running" || dl.status === "verifying";

// dev-only UI mock for the plain-browser pane (no Tauri): simulated progress
const useMock = () => import.meta.env.DEV && localStorage.getItem("pdfer:dev:dlmock") === "1";
const mockTimers: Partial<Record<ModelKey, number>> = {};
function mockDownload(m: ModelKey) {
  if (mockTimers[m]) return;
  const total = dlState[m].total;
  let received = dlState[m].received;
  mockTimers[m] = window.setInterval(() => {
    received = Math.min(total, received + total / 30);
    if (received >= total) {
      window.clearInterval(mockTimers[m]);
      mockTimers[m] = undefined;
      setDl(m, { status: "done", received: total, total, bps: 0 });
    } else {
      setDl(m, { status: "running", received, total, bps: 11.3e6 });
    }
  }, 400);
}
function mockCancel(m: ModelKey) {
  window.clearInterval(mockTimers[m]);
  mockTimers[m] = undefined;
  setDl(m, { ...dlState[m], status: "cancelled", bps: 0 });
}

const devDestDir = (): string | undefined =>
  (import.meta.env.DEV && localStorage.getItem("pdfer:dev:dldir")) || undefined;

/// Start (or resume — the Rust side continues from the .part file) the
/// download. Idempotent while running: the live channel keeps feeding.
export function startDownload(model: ModelKey): void {
  if (useMock()) return mockDownload(model);
  if (dlBusy(dlState[model])) return;
  const ch = new Channel<Dl>();
  ch.onmessage = (ev) => {
    setDl(model, ev);
    // the just-downloaded translator starts right away — no extra click
    if (ev.status === "done" && model === "main") invoke("restart_translation").catch(() => {});
  };
  // optimistic: the first real event replaces this within ~300 ms
  setDl(model, { ...dlState[model], status: "running", bps: 0 });
  invoke("download_model", { model, destDir: devDestDir(), onEvent: ch }).catch((e) => {
    setDl(model, { ...dlState[model], status: "error", bps: 0, error: String(e) });
  });
}

export function cancelDownload(model: ModelKey): void {
  if (useMock()) return mockCancel(model);
  invoke("cancel_model_download", { model }).catch(() => {});
}

// after a webview reload: if Rust still runs a download, re-subscribe; if a
// .part is on disk, surface the resumable state instead of a blank «Скачать»
const attachTried: Partial<Record<ModelKey, boolean>> = {};
async function attachIfRunning(model: ModelKey) {
  if (attachTried[model] || useMock()) return;
  attachTried[model] = true;
  try {
    const st = await invoke<{ running: boolean; file_ready: boolean; received: number; total: number }>(
      "model_download_status",
      { model, destDir: devDestDir() },
    );
    if (st.running) startDownload(model);
    else if (st.received > 0 && !st.file_ready)
      setDl(model, { ...dlState[model], status: "cancelled", received: st.received });
  } catch {
    // plain browser — no Tauri
  }
}

export function useDownload(model: ModelKey): Dl {
  useEffect(() => {
    void attachIfRunning(model);
  }, [model]);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => dlState[model],
  );
}

/// Is the final .gguf on disk? null = unknown (plain browser).
export async function modelFileReady(model: ModelKey): Promise<boolean | null> {
  if (import.meta.env.DEV) {
    const forced = localStorage.getItem(`pdfer:dev:file:${model}`);
    if (forced) return forced === "1";
  }
  try {
    const st = await invoke<{ file_ready: boolean }>("model_download_status", { model, destDir: devDestDir() });
    return st.file_ready;
  } catch {
    return null;
  }
}

// ---- formatting (voice rules: decimal comma, «осталось …») ------------------

export function fmtGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1).replace(".", ",")} ГБ`;
}

function fmtLeft(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "осталось <1 мин";
  if (min < 60) return `осталось ~${min} мин`;
  const h = ms / 3600000;
  return `осталось ~${(h < 10 ? h.toFixed(1) : String(Math.round(h))).replace(".", ",")} ч`;
}

export function dlPct(dl: Dl): number {
  return Math.floor((100 * dl.received) / Math.max(1, dl.total));
}

/// «42% · 11 МБ/с · осталось ~6 мин» (speed/ETA only once measured)
export function dlProgressLine(dl: Dl): string {
  if (dl.status === "verifying") return "Проверка файла…";
  const parts = [`${dlPct(dl)}%`];
  if (dl.bps > 500_000) {
    parts.push(`${Math.max(1, Math.round(dl.bps / 1e6))} МБ/с`);
    parts.push(fmtLeft(((dl.total - dl.received) / dl.bps) * 1000));
  }
  return parts.join(" · ");
}

export function dlErrorLine(err?: string | null): string {
  if (err && err.startsWith("no_space:")) {
    const missing = Number(err.slice("no_space:".length));
    return `Недостаточно места на диске — нужно ещё ${fmtGb(Math.max(missing || 0, 1e8))}`;
  }
  if (err === "checksum") return "Файл повреждён при скачивании — попробуйте ещё раз";
  return "Скачивание прервалось — можно продолжить с того же места";
}

// ---- shared primitives ------------------------------------------------------

export function Spinner() {
  return (
    <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-70" />
  );
}

function Progress({ dl, onCancel }: { dl: Dl; onCancel: () => void }) {
  return (
    <div className="select-none">
      <div className="h-0.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
        <div className="h-full bg-blue-500 transition-[width] duration-300" style={{ width: `${dlPct(dl)}%` }} />
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <span className="tabular-nums">{dlProgressLine(dl)}</span>
        <span className="flex-1" />
        {dl.status === "running" && (
          <button className="hover:opacity-60" onClick={onCancel}>
            Отменить
          </button>
        )}
      </div>
    </div>
  );
}

// Р-3: download is user-initiated and the model license is visible next to
// every «Скачать» for the HY-MT weights.
const LICENSE_URL = "https://huggingface.co/tencent/HY-MT1.5-7B-GGUF/blob/main/License.txt";

function LicenseNote() {
  return (
    <p className="text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
      Модель HY-MT1.5 (Tencent) — лицензия Hunyuan Community: бесплатно, в том числе для коммерческого
      использования; не действует в ЕС, Великобритании и Южной Корее.{" "}
      <button
        className="underline underline-offset-2 hover:text-neutral-600 dark:hover:text-neutral-300"
        onClick={() => openUrl(LICENSE_URL).catch(() => window.open(LICENSE_URL, "_blank"))}
      >
        Условия
      </button>
    </p>
  );
}

const PRIMARY_BTN =
  "mt-3 w-full rounded-lg bg-neutral-900 px-3 py-2 text-white transition-opacity hover:opacity-85 dark:bg-neutral-100 dark:text-neutral-900";

/// poll the model status while a surface is visible
function useModelStatus(intervalMs = 2000): ModelStatus | null {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const s = await fetchModelStatus();
      if (!cancelled) setStatus(s);
    };
    poll();
    const t = window.setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [intervalMs]);
  return status;
}

// ---- dev-only: scripted download test via an appdata marker -----------------
// (dormant unless the marker file exists at load)
// The browser pane cannot reach Tauri commands; the REAL webview executes this
// instead (same pattern as the autotranslate.json dev marker). Marker
// %APPDATA%/devdl.json: { id, model, destDir, cancelAtBytes? } — every id runs
// once (remembered in localStorage), progress + terminal events are appended
// to devdl.log next to the marker. Dead code in production builds.
if (import.meta.env.DEV) {
  (async () => {
    let fs: typeof import("@tauri-apps/plugin-fs");
    let dir: string;
    try {
      fs = await import("@tauri-apps/plugin-fs");
      dir = await (await import("@tauri-apps/api/path")).appDataDir();
      await fs.readFile(`${dir}\\devdl.json`); // no marker → stay dormant
    } catch {
      return; // plain browser or no marker
    }
    const tick = async () => {
      let cfg: { id: string; model: ModelKey; destDir: string; cancelAtBytes?: number };
      try {
        cfg = JSON.parse(new TextDecoder().decode(await fs.readFile(`${dir}\\devdl.json`)));
      } catch {
        return;
      }
      if (!cfg.id || localStorage.getItem("pdfer:dev:devdl") === cfg.id) return;
      localStorage.setItem("pdfer:dev:devdl", cfg.id);
      const log: string[] = [];
      const put = (m: string) => log.push(`${new Date().toISOString()} ${m}`);
      const flush = () =>
        fs.writeFile(`${dir}\\devdl.log`, new TextEncoder().encode(log.join("\n") + "\n")).catch(() => {});
      let cancelSent = false;
      let lastBand = -1;
      const ch = new Channel<Dl>();
      ch.onmessage = (ev) => {
        const band = Math.floor(ev.received / 30e6);
        if (ev.status === "running" && band !== lastBand) {
          lastBand = band;
          put(`running received=${ev.received} bps=${ev.bps}`);
          void flush();
        }
        if (ev.status !== "running") {
          put(`event ${ev.status} received=${ev.received} err=${ev.error ?? ""}`);
          void flush();
        }
        if (!cancelSent && cfg.cancelAtBytes && ev.status === "running" && ev.received >= cfg.cancelAtBytes) {
          cancelSent = true;
          put(`cancelling at ${ev.received}`);
          invoke("cancel_model_download", { model: cfg.model }).catch((e) => put(`cancel failed ${e}`));
        }
      };
      put(`invoking download_model model=${cfg.model} dest=${cfg.destDir}`);
      await flush();
      try {
        await invoke("download_model", { model: cfg.model, destDir: cfg.destDir, onEvent: ch });
        put("invoke resolved");
      } catch (e) {
        put(`invoke rejected: ${String(e)}`);
      }
      await flush();
    };
    void tick();
    window.setInterval(() => void tick(), 3000);
  })();
}

// ---- setup modal ------------------------------------------------------------
// The canonical download surface: value line, size, license, disk-space and
// network errors, progress with speed/ETA, resume. Opened from the menu row,
// the popover CTA and the startTr gate (none/dead).

export function ModelSetupModal({ onClose }: { onClose: () => void }) {
  const dl = useDownload("main");
  const status = useModelStatus();
  const busy = dlBusy(dl);
  const resumable = (dl.status === "cancelled" || dl.status === "error") && dl.received > 0;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[min(24rem,90vw)] rounded-xl bg-white p-4 text-sm text-neutral-800 shadow-2xl dark:bg-neutral-800 dark:text-neutral-100">
        <div className="mb-2 flex items-center text-xs text-neutral-400 select-none dark:text-neutral-500">
          <span>Модель перевода</span>
          <span className="flex-1" />
          <button className="px-0.5 hover:opacity-60" onClick={onClose} title="Закрыть (Esc)">
            ×
          </button>
        </div>
        {busy ? (
          <>
            <p className="leading-relaxed">
              Модель скачивается — можно читать, скачивание продолжится в фоне.
            </p>
            <div className="mt-3">
              <Progress dl={dl} onCancel={() => cancelDownload("main")} />
            </div>
          </>
        ) : statusUp(status) ? (
          <p className="leading-relaxed">
            Модель перевода: готова. Выделите текст или Alt+кликните по абзацу — перевод появится рядом.
          </p>
        ) : status === "starting" || dl.status === "done" ? (
          <p className="flex items-center gap-2 leading-relaxed">
            <Spinner /> Модель запускается… ≈20 с
          </p>
        ) : status === "dead" ? (
          <>
            <p className="leading-relaxed">Модель не отвечает.</p>
            <button className={PRIMARY_BTN} onClick={() => void restartModel()}>
              Перезапустить
            </button>
          </>
        ) : (
          <>
            <p className="leading-relaxed">
              pdfer переводит книги локально, без интернета и подписок. Нужна модель перевода — она
              скачивается один раз и остаётся на компьютере.
            </p>
            <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
              HY-MT1.5 · {MODEL_META.main.sizeLabel} · перевод EN→RU офлайн
            </p>
            {dl.status === "error" && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">{dlErrorLine(dl.error)}</p>
            )}
            <button className={PRIMARY_BTN} onClick={() => startDownload("main")}>
              {resumable
                ? `Продолжить скачивание · ${dlPct(dl)}%`
                : `Скачать модель перевода (${MODEL_META.main.sizeLabel})`}
            </button>
            <div className="mt-3">
              <LicenseNote />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---- library empty-state card -----------------------------------------------
// Тихий онбординг (Р-2): the first-launch screen carries the value line and
// the user-initiated download; «Позже — просто читать» dismisses for good
// (the menu status row still offers the download any time).

export function ModelSetupCard() {
  const dl = useDownload("main");
  const status = useModelStatus(3000);
  const [later, setLater] = useState(() => localStorage.getItem("pdfer:modellater") === "1");
  const busy = dlBusy(dl);
  const resumable = (dl.status === "cancelled" || dl.status === "error") && dl.received > 0;

  if (status === null) return null; // not yet known — no flash of the card
  if (later && !busy) return null;
  if (statusUp(status) && !busy) return null;

  return (
    <div className="w-[22rem] max-w-[92vw] rounded-xl border border-neutral-300 bg-white/60 p-4 text-left text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300">
      <div className="leading-relaxed">pdfer переводит книги локально, без интернета и подписок</div>
      {busy ? (
        <div className="mt-3">
          <Progress dl={dl} onCancel={() => cancelDownload("main")} />
        </div>
      ) : status === "starting" || dl.status === "done" ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <Spinner /> Модель перевода: запускается…
        </div>
      ) : status === "dead" ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span>Модель не отвечает</span>
          <button className="underline underline-offset-2 hover:opacity-60" onClick={() => void restartModel()}>
            Перезапустить
          </button>
        </div>
      ) : (
        <>
          {dl.status === "error" && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">{dlErrorLine(dl.error)}</p>
          )}
          <button className={PRIMARY_BTN} onClick={() => startDownload("main")}>
            {resumable
              ? `Продолжить скачивание · ${dlPct(dl)}%`
              : `Скачать модель перевода (${MODEL_META.main.sizeLabel})`}
          </button>
          <div className="mt-2 text-center">
            <button
              className="text-xs text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
              onClick={() => {
                localStorage.setItem("pdfer:modellater", "1");
                setLater(true);
              }}
            >
              Позже — просто читать
            </button>
          </div>
          <div className="mt-3">
            <LicenseNote />
          </div>
        </>
      )}
    </div>
  );
}
