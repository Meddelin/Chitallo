import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isServerUp } from "./translate";
import { IconClose } from "./icons";
import { EngineInstall } from "./Depends";
import { engineStatus, joinPath, type ToolStatus } from "./host";
import { fmtGb, fmtMbps, fmtNum, fmtSize, t } from "./i18n";

// ---- model onboarding + the single status vocabulary (WP-B) -----------------
//
// Every surface that talks about the translation model (menu status row,
// popover, «Термины» tab, library card) reads the SAME status source and the
// SAME download store from here, so one state never has three names.
//
// Status source: Tauri `translation_status` — "noengine" | "none" |
// "external" | "starting" | "spawned" | "swapping" | "dead". A bare /health
// probe cannot be the source of truth: llama-server answers 503 while the model
// loads, which must read as «starting», never as «not running».
//
// "noengine" and "none" are two different problems with two different fixes:
// llama.cpp is not installed (install it), versus the weights are not
// downloaded (download them). Every surface keeps them apart.
//
// "swapping" IS PART OF THE ENUM, and it was missing here while Rust had
// already been returning it. The two models no longer fit on the card together,
// so whichever server is asked for stops the other's spawned child and parks it
// in "swapping" (src-tauri/src/lib.rs, swap_out); restart_translation writes the
// same word when the reader presses «Перезапустить» while a lease is held, as a
// deferred intent. Leaving it out of the union did not make it go away — it made
// every surface fall through to the final `else`, whose word is «Модель не
// установлена · Скачать 7,3 ГБ» for weights that are on disk and a server that
// is coming back on its own. That is the one thing a status line must never do.
// It also forced `as string` casts on the two call sites in App.tsx that already
// knew about the state; those are gone with this member.
export type ModelStatus = "noengine" | "none" | "external" | "starting" | "spawned" | "swapping" | "dead";

// «Up» means «a request sent right now will be answered». "swapping" is NOT up
// — the child is stopped and /completion would fail — and it is deliberately
// not made up by this predicate either: the surfaces that gate a run on
// statusUp() must keep waiting, not proceed. What changes is only the word they
// print while they wait, which is why every branch below tests for "swapping"
// by name instead of hiding it inside this helper.
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

// ---- the aux lease, dropped once per page load ------------------------------
//
// The second server — the style/terms model — is held by a keyed lease, and
// every owner of that lease is in-page JavaScript ("glossary", "graph",
// "style:<bookPath>"). A webview reload therefore strands an owner that nothing
// can ever remove, because the new page's run managers start empty: the set
// never empties again, every later aux_model_stop becomes a no-op, and 14,2 GB
// of weights stay resident until the app exits. src-tauri/src/lib.rs `aux_lease_reset` sets
// out the whole failure and answers it with a command the frontend calls ONCE
// on load. This is that call. It lives here because this module is already
// where the model servers' startup vocabulary lives, next to the download
// store's own once-per-load bootstrap (attachIfRunning, :207).
//
// Module scope rather than a hook: it must run before any surface can take a
// lease, and it must not fire again when a panel remounts. In `npm run tauri
// dev` an HMR update of this file counts as a load and will stop an aux server
// mid-pass — which is honest, since the JS that held the lease was just
// replaced.
void invoke("aux_lease_reset").catch(() => {
  // plain browser (vite dev), or a build without the command — nothing is held
});

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

// These two numbers must equal `model_spec(key).size` in
// src-tauri/src/lib.rs `model_spec` byte for byte, and they are checked by eye rather
// than by a type: they seed dlState just below and resetDownload (:200), and
// dlPct divides by them before the FIRST channel event lands. A stale number is
// therefore visible as a percentage that jumps the moment Rust reports the real
// total — and on a resumed download it makes Settings' `partial` line
// (Settings.tsx:195) report more than 100%.
export const MODEL_SIZE: Record<ModelKey, number> = {
  main: 7_300_793_664, // translategemma-12b-it-Q4_K_M.gguf
  aux: 14_249_047_104, // gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf
};

/// «7,3 ГБ» / «7.3 GB» — recomputed per call so a language switch is picked up.
export const sizeLabel = (m: ModelKey): string => fmtGb(MODEL_SIZE[m]);

/// «21,5 ГБ» — what both models cost together. Until now nothing in the app
/// could state the combined price: every surface quoted one file at a time, and
/// the second one was only met after the first had already landed. That is the
/// number a reader on a 512 GB laptop needs before the first click. It is a
/// statement, never a demand: first run still asks for the draft model alone
/// (7,3 ГБ) and prints this line under the licence note, and Settings prints it
/// under the two rows for the reader who came asking where the disk went.
export const totalSize = (): string => fmtGb(MODEL_SIZE.main + MODEL_SIZE.aux);

const dlState: Record<ModelKey, Dl> = {
  main: { status: "idle", received: 0, total: MODEL_SIZE.main, bps: 0 },
  aux: { status: "idle", received: 0, total: MODEL_SIZE.aux, bps: 0 },
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
    // The just-downloaded translator starts right away — no extra click. Still
    // "main" only, and now for a second reason as well: the style/terms weights
    // are 14,2 GB served on demand under a lease whose owners are all in-page
    // (src-tauri/src/lib.rs `aux_lease_reset`), so a finished download must not raise a
    // server that nobody has taken a lease on.
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

/// After delete_model (Settings): the shared snapshot must go back to a blank
/// «Download», not linger on "done"/"cancelled" from the previous life — a
/// stale "done" would read as «the model is starting…» in the menu row.
export function resetDownload(model: ModelKey): void {
  setDl(model, { status: "idle", received: 0, total: MODEL_SIZE[model], bps: 0 });
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

/// Disk-side snapshot for Settings: is the .gguf installed, how many bytes of
/// a .part are local, is a download running. null = unknown (plain browser).
export async function fetchDlSnapshot(
  model: ModelKey,
): Promise<{ ready: boolean; received: number; running: boolean } | null> {
  try {
    const st = await invoke<{ running: boolean; file_ready: boolean; received: number; total: number }>(
      "model_download_status",
      { model, destDir: devDestDir() },
    );
    return { ready: st.file_ready, received: st.received, running: st.running };
  } catch {
    return null; // plain browser — no Tauri
  }
}

/// Settings «Удалить»: remove the weights (and any .part) from disk. The Rust
/// side first stops the llama-server we spawned for that model.
export async function deleteModel(model: ModelKey): Promise<void> {
  await invoke("delete_model", { model, destDir: devDestDir() });
  resetDownload(model);
}

// ---- obsolete weights -------------------------------------------------------
// The pre-Gemma files — HY-MT1.5-7B and Qwen3.5-4B — that the app used to run
// on. After the model swap no code path names either of them, so they are ~7 GB
// of unreachable bytes in roaming AppData while the reader is being asked for
// 21,5 GB more against a free-space check whose whole margin is 300 MiB
// (src-tauri/src/lib.rs `DL_MARGIN`). The table of what may be deleted lives
// in Rust (lib.rs `LEGACY_MODELS`) and is the only authority: this side sends back names it
// was given, and legacy_models_delete refuses anything that is not in the table
// or is pinned by a live spec.

export type LegacyModel = { file: string; size: number; present: boolean };

/// What obsolete weights are actually on disk. The scan reports every table
/// entry, present or not, so the caller keeps only the present ones — a row that
/// offers to free bytes that are not there would be a lie.
///
/// Outside Tauri this is a no-op and answers «nothing», the same shape
/// fetchDlSnapshot and modelFileReady use: a plain browser has no models
/// directory, and an empty list is the honest answer rather than an error.
export async function legacyModels(): Promise<LegacyModel[]> {
  try {
    return (await invoke<LegacyModel[]>("legacy_models_scan")).filter((m) => m.present);
  } catch {
    return []; // plain browser — no Tauri
  }
}

/// Delete the obsolete weights the reader asked to remove. Unlike the scan this
/// one lets a failure through: it is only ever reached from a row that was
/// rendered because legacyModels() found something, so there is no «no Tauri»
/// case left to swallow, and a file held open by another process has to be able
/// to say so the way deleteModel's caller already does (Settings.tsx:200).
export async function deleteLegacyModels(files: string[]): Promise<void> {
  await invoke("legacy_models_delete", { files });
}

/// The scan as a hook, shared by Settings' permanent row and the no-space branch
/// of a download. `active` exists so the stat() per table entry is only paid by
/// a surface that is going to show the result; the rows go away by themselves
/// when `remove` empties the list.
export function useLegacyModels(active: boolean): {
  bytes: number;
  present: boolean;
  remove: () => Promise<void>;
} {
  const [rows, setRows] = useState<LegacyModel[]>([]);
  useEffect(() => {
    if (!active) {
      setRows([]);
      return;
    }
    let live = true;
    void legacyModels().then((r) => {
      if (live) setRows(r);
    });
    return () => {
      live = false;
    };
  }, [active]);
  // the rescan is in `finally` on purpose: a partial failure (one file gone, one
  // held open) must still redraw the row against what is now on disk
  const remove = useCallback(async () => {
    try {
      await deleteLegacyModels(rows.map((r) => r.file));
    } finally {
      setRows(await legacyModels());
    }
  }, [rows]);
  return { bytes: rows.reduce((s, r) => s + r.size, 0), present: rows.length > 0, remove };
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

// ---- formatting -------------------------------------------------------------

function fmtLeft(ms: number): string {
  const min = Math.round(ms / 60000);
  // the ETA strings carry a leading separator for the run menu; here it is
  // trimmed off, because the progress line supplies its own «·»
  if (min < 1) return t("tr.etaMinSub").trim().replace(/^·\s*/, "");
  if (min < 60) return t("tr.etaMin", { n: min }).trim().replace(/^·\s*/, "");
  const h = ms / 3600000;
  return t("tr.etaHour", { n: h < 10 ? fmtNum(h) : Math.round(h) }).trim().replace(/^·\s*/, "");
}

export function dlPct(dl: Dl): number {
  return Math.floor((100 * dl.received) / Math.max(1, dl.total));
}

/// «42% · 11 MB/s · ~6 min left» (speed/ETA only once measured)
export function dlProgressLine(dl: Dl): string {
  if (dl.status === "verifying") return t("model.verifying");
  const parts = [`${dlPct(dl)}%`];
  if (dl.bps > 500_000) {
    parts.push(fmtMbps(dl.bps));
    parts.push(fmtLeft(((dl.total - dl.received) / dl.bps) * 1000));
  }
  return parts.join(" · ");
}

/// A failed download, split the way direction B writes a refusal: the cause,
/// and the one verb that gets out of it. `act` says what that verb does —
/// «Освободить место» opens the folder the weights land in, the other two
/// start the download over. (WP-N)
export type DlFix = { cause: string; verb: string; act: "space" | "again" | "resume" };

export function dlErrorFix(err?: string | null): DlFix {
  if (err && err.startsWith("no_space:")) {
    const missing = Number(err.slice("no_space:".length));
    return {
      cause: t("model.noSpace", { size: fmtGb(Math.max(missing || 0, 1e8)) }),
      verb: t("model.freeSpace"),
      act: "space",
    };
  }
  if (err === "checksum") return { cause: t("model.checksum"), verb: t("model.redownload"), act: "again" };
  return { cause: t("model.interrupted"), verb: t("set.resume"), act: "resume" };
}

/// The same refusal as one line, for surfaces that have no button of their own
/// to hang the verb on (the onboarding checklist).
export function dlErrorLine(err?: string | null): string {
  const f = dlErrorFix(err);
  return `${f.cause} · ${f.verb}`;
}

/// «Освободить место» — show the reader where the weights go, so the space is
/// freed in the right place. Reveal, not open: the folder may not exist yet.
export function revealModelsDir(): void {
  void (async () => {
    try {
      const { appDataDir } = await import("@tauri-apps/api/path");
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(joinPath(await appDataDir(), "models"));
    } catch {
      // plain browser, or the folder is not there yet — nothing to show
    }
  })();
}

// ---- shared primitives ------------------------------------------------------

export function Spinner() {
  return (
    <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-70" />
  );
}

// quiet inline verbs: muted base, the colour firms up on hover
const QUIET_LINK = "transition-colors hover:text-neutral-700 dark:hover:text-neutral-200";

export function Progress({ dl, onCancel }: { dl: Dl; onCancel: () => void }) {
  return (
    <div className="select-none">
      <div className="h-0.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
        <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${dlPct(dl)}%` }} />
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <span className="tabular-nums">{dlProgressLine(dl)}</span>
        <span className="flex-1" />
        {dl.status === "running" && (
          <button className={QUIET_LINK} onClick={onCancel}>
            {t("ui.cancel")}
          </button>
        )}
      </div>
    </div>
  );
}

// The download is user-initiated and the model licence is visible next to every
// «Download». ONE url for both models now, which is why LicenseNote stays a
// single component instead of growing a per-model argument: the draft translator
// and the style/terms editor are both Google's Gemma weights under the same
// Gemma Terms of Use. The Hunyuan link this replaced carried a territorial
// carve-out — the EU, the UK and South Korea — that has no counterpart here;
// i18n.ts:191-199 records why the clause was dropped rather than reworded.
const LICENSE_URL = "https://ai.google.dev/gemma/terms";

function LicenseNote({ short }: { short?: boolean }) {
  return (
    <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
      {short ? t("model.licenseShort") : t("model.license")}{" "}
      <button
        className={`underline underline-offset-2 ${QUIET_LINK}`}
        onClick={() => openUrl(LICENSE_URL).catch(() => window.open(LICENSE_URL, "_blank"))}
      >
        {t("model.licenseTerms")}
      </button>
    </p>
  );
}

const PRIMARY_BTN =
  "mt-3 w-full rounded-lg bg-neutral-900 px-3 py-2 text-white transition-colors hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white";

// The card's primary sits in a row next to «Читать без перевода», so it is
// sized to its own words rather than to the card. (WP-N)
const CARD_BTN =
  "rounded-lg bg-neutral-900 px-4 py-1.5 text-[13px] text-white transition-colors hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white";

/// The B status row: what is going on, in numbers where there are any, and the
/// verb out of it on the right. Every state of the model card wears it. `bad`
/// is the one difference the mockups draw between «пауза» and «ошибка»: the
/// cause turns red, the verb never does.
function StatusRow({
  cause,
  verb,
  onVerb,
  bad,
}: {
  cause: string;
  verb?: string;
  onVerb?: () => void;
  bad?: boolean;
}) {
  return (
    <div className="mt-3 flex items-baseline gap-3 text-xs text-neutral-500 dark:text-neutral-400">
      <span className={`min-w-0 flex-1 tabular-nums ${bad ? "text-red-600 dark:text-red-400" : ""}`}>{cause}</span>
      {verb && onVerb && (
        <button className={`shrink-0 ${QUIET_LINK}`} onClick={onVerb}>
          {verb}
        </button>
      )}
    </div>
  );
}

/// «Обе модели · 21,5 ГБ», under the licence note of every surface that offers
/// the draft model. It is deliberately a statement and not a demand: the button
/// beside it asks for 7,3 ГБ and the editor is offered later with its own size
/// stated, but the reader learns the sum here rather than discovering it after
/// the first download has already finished.
export function TotalNote() {
  return (
    <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
      {t("set.modelsTotal", { size: totalSize() })}
    </p>
  );
}

/// The obsolete weights, offered exactly where they matter most: a download that
/// stopped because the disk is full. (This is the adversarial review's fix to
/// P1 §6 / P8a §9 — the Settings row alone came too late in the story. After the
/// swap the app reports «none» for the main model and asks for 7,3 ГБ, while
/// ~7 ГБ of files it can no longer read sit in the same directory; a reader
/// whose download just failed for space has no reason to go looking in
/// Settings → Модели for the remedy.)
///
/// Two clicks, like every destructive row in Settings: the first states what is
/// there, the second names the volume in red before it goes. That matters more
/// here than in Settings, not less — those bytes cost hours of bandwidth and a
/// downgraded build would need them back (src-tauri/src/lib.rs `LEGACY_MODELS`).
export function LegacySpaceOffer({ err }: { err?: string | null }) {
  // «out of space» is spelled `no_space:<bytes>` in exactly one place; ask
  // dlErrorFix rather than repeating the prefix here. With no error at all it
  // answers "resume", which is why the presence of `err` is tested first.
  const active = !!err && dlErrorFix(err).act === "space";
  const legacy = useLegacyModels(active);
  const [confirm, setConfirm] = useState(false);
  if (!active || !legacy.present) return null;
  return confirm ? (
    <StatusRow
      bad
      cause={t("set.modelsLegacyConfirm", { size: fmtSize(legacy.bytes) })}
      verb={t("set.modelsLegacyDelete")}
      onVerb={() => void legacy.remove().catch(() => {})}
    />
  ) : (
    <StatusRow
      cause={t("set.modelsLegacyNote", { size: fmtSize(legacy.bytes) })}
      verb={t("ui.delete")}
      onVerb={() => setConfirm(true)}
    />
  );
}

/// llama.cpp's presence, probed only when the status says it is missing —
/// the probe costs a PATH walk plus a `--version` spawn, so it is never a poll.
function useEngineProbe(active: boolean): { status: ToolStatus | null; probe: () => void; busy: boolean } {
  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const probe = useCallback(() => {
    setBusy(true);
    void engineStatus().then((s) => {
      setStatus(s);
      setBusy(false);
      // the engine appeared: let the backend try to start the server again,
      // so the status row stops saying «not installed» on its own
      if (s.installed) void restartModel();
    });
  }, []);
  useEffect(() => {
    if (active) probe();
  }, [active, probe]);
  return { status, probe, busy };
}

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
// <appData>/devdl.json: { id, model, destDir, cancelAtBytes? } — every id runs
// once (remembered in localStorage), progress + terminal events are appended
// to devdl.log next to the marker. Dead code in production builds.
if (import.meta.env.DEV) {
  (async () => {
    let fs: typeof import("@tauri-apps/plugin-fs");
    let dir: string;
    try {
      fs = await import("@tauri-apps/plugin-fs");
      dir = await (await import("@tauri-apps/api/path")).appDataDir();
      await fs.readFile(joinPath(dir, "devdl.json")); // no marker → stay dormant
    } catch {
      return; // plain browser or no marker
    }
    const tick = async () => {
      let cfg: { id: string; model: ModelKey; destDir: string; cancelAtBytes?: number };
      try {
        cfg = JSON.parse(new TextDecoder().decode(await fs.readFile(joinPath(dir, "devdl.json"))));
      } catch {
        return;
      }
      if (!cfg.id || localStorage.getItem("pdfer:dev:devdl") === cfg.id) return;
      localStorage.setItem("pdfer:dev:devdl", cfg.id);
      const log: string[] = [];
      const put = (m: string) => log.push(`${new Date().toISOString()} ${m}`);
      const flush = () =>
        fs.writeFile(joinPath(dir, "devdl.log"), new TextEncoder().encode(log.join("\n") + "\n")).catch(() => {});
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
  const engine = useEngineProbe(status === "noengine");
  const fix = dl.status === "error" ? dlErrorFix(dl.error) : null;

  return (
    <div
      className="modal-backdrop fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel w-[min(24rem,90vw)] rounded-xl bg-white p-4 text-sm text-neutral-800 shadow-2xl dark:bg-neutral-800 dark:text-neutral-100">
        <div className="mb-2 flex items-center text-xs text-neutral-500 select-none dark:text-neutral-400">
          <span>{t("model.title")}</span>
          <span className="flex-1" />
          <button
            className="px-0.5 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
            onClick={onClose}
            title={t("ui.close")}
          >
            <IconClose />
          </button>
        </div>
        {status === "noengine" ? (
          <EngineInstall status={engine.status} onRecheck={engine.probe} busy={engine.busy} />
        ) : busy ? (
          <>
            <p className="leading-relaxed">{t("model.downloadingBg")}</p>
            <div className="mt-3">
              <Progress dl={dl} onCancel={() => cancelDownload("main")} />
            </div>
          </>
        ) : statusUp(status) ? (
          <p className="leading-relaxed">{t("model.readyHint")}</p>
        ) : status === "swapping" ? (
          // The card's own words for the handover, and it stands AHEAD of the
          // «starting» arm rather than beside it: that arm's second disjunct
          // (`dl.status === "done"`) stays true for the rest of the session
          // after a finished download, so a swap on a freshly downloaded model
          // would otherwise print «Модель запускается · ~20 с» — a duration
          // nobody can honour, since the wait is as long as the other pass.
          // Spinner and no verb, because there is nothing to press: the draft
          // server comes back by itself when the lease drops
          // (src-tauri/src/lib.rs, restore_after_handover). «Перезапустить» in
          // particular must not be on screen here — Rust answers that press with
          // "swapping" again, so the button would be a no-op that looks like a
          // fix.
          <>
            <p className="flex items-center gap-2 leading-relaxed">
              <Spinner /> {t("model.swapping")}
            </p>
            <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{t("model.swappingBody")}</p>
          </>
        ) : status === "starting" || dl.status === "done" ? (
          <p className="flex items-center gap-2 leading-relaxed">
            <Spinner /> {t("model.startingShort")}
          </p>
        ) : status === "dead" ? (
          <>
            <p className="leading-relaxed">{t("model.dead")}</p>
            <button className={PRIMARY_BTN} onClick={() => void restartModel()}>
              {t("ui.restart")}
            </button>
          </>
        ) : (
          <>
            <p className="leading-relaxed">{t("model.pitch")}</p>
            <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              {t("model.line", { size: sizeLabel("main") })}
            </p>
            {fix && (
              <StatusRow
                bad
                cause={fix.cause}
                verb={fix.act === "space" ? fix.verb : undefined}
                onVerb={revealModelsDir}
              />
            )}
            {/* «Освободить место» opens the folder; this row IS the place, when
                what is taking the space is weights the app can no longer read */}
            {fix && <LegacySpaceOffer err={dl.error} />}
            <button className={PRIMARY_BTN} onClick={() => startDownload("main")}>
              {fix?.act === "again"
                ? t("model.redownload")
                : resumable
                  ? t("model.resumeCta", { pct: dlPct(dl) })
                  : t("model.downloadCta", { size: sizeLabel("main") })}
            </button>
            <div className="mt-3">
              <LicenseNote />
              <TotalNote />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---- library empty-state card -----------------------------------------------
// Quiet onboarding: the empty-library screen carries the value line and the
// user-initiated download; «Later — just read» dismisses it for good (the menu
// status row still offers the download any time).

export function ModelSetupCard() {
  const dl = useDownload("main");
  const status = useModelStatus(3000);
  const [later, setLater] = useState(() => localStorage.getItem("pdfer:modellater") === "1");
  const busy = dlBusy(dl);
  const resumable = (dl.status === "cancelled" || dl.status === "error") && dl.received > 0;
  const engine = useEngineProbe(status === "noengine");

  if (status === null) return null; // not yet known — no flash of the card
  if (later && !busy) return null;
  if (statusUp(status) && !busy) return null;

  // (WP-N) the card names the thing and its price in two lines — «Модель
  // перевода» / «TranslateGemma-12B · 7,3 ГБ · перевод офлайн» — and then does
  // exactly one thing. The size is already on the second line, so the button is
  // the bare verb.
  const fix = dl.status === "error" ? dlErrorFix(dl.error) : null;

  return (
    <div className="w-[22rem] max-w-[92vw] rounded-xl border border-neutral-300 bg-white/60 p-4 text-left text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300">
      <div className="text-neutral-800 dark:text-neutral-100">{t("model.title")}</div>
      <div className="mt-1 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
        {t("model.line", { size: sizeLabel("main") })}
      </div>
      {status === "noengine" ? (
        <div className="mt-3">
          <EngineInstall status={engine.status} onRecheck={engine.probe} busy={engine.busy} />
        </div>
      ) : busy ? (
        <div className="mt-3">
          <Progress dl={dl} onCancel={() => cancelDownload("main")} />
        </div>
      ) : status === "swapping" ? (
        // Same arm, same place in the chain, same reasoning as the modal's:
        // ahead of «starting», because `dl.status === "done"` outlives the
        // download it describes. A StatusRow with no verb rather than the
        // spinner line — this card is the empty library's onboarding surface
        // and its rows all carry the cause on the left — and the second line is
        // dropped here for room: the card is 22rem of onboarding copy and
        // «нажимать нечего» is already what a row without a verb says.
        <StatusRow cause={t("model.swapping")} />
      ) : status === "starting" || dl.status === "done" ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <Spinner /> {t("model.starting")}
        </div>
      ) : status === "dead" ? (
        <StatusRow cause={t("model.dead")} verb={t("ui.restart")} onVerb={() => void restartModel()} />
      ) : (
        <>
          {/* the cause carries its own verb only when nothing else can do it:
              freeing disk space happens in the file manager, not here */}
          {fix && (
            <StatusRow
              bad
              cause={fix.cause}
              verb={fix.act === "space" ? fix.verb : undefined}
              onVerb={revealModelsDir}
            />
          )}
          {fix && <LegacySpaceOffer err={dl.error} />}
          <div className="mt-3 flex items-center gap-3">
            <button className={CARD_BTN} onClick={() => startDownload("main")}>
              {fix?.act === "again"
                ? t("model.redownload")
                : resumable
                  ? t("model.resumeCta", { pct: dlPct(dl) })
                  : t("ui.download")}
            </button>
            <button
              className={`text-xs text-neutral-500 dark:text-neutral-400 ${QUIET_LINK}`}
              onClick={() => {
                localStorage.setItem("pdfer:modellater", "1");
                setLater(true);
              }}
            >
              {t("model.later")}
            </button>
          </div>
          <div className="mt-3">
            <LicenseNote short />
            <TotalNote />
          </div>
        </>
      )}
    </div>
  );
}
