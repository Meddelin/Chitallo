// The external programs Chitallo depends on, as UI: is it here, and if not, the
// one command that installs it on this machine.
//
// Shared by the first-run wizard (Onboarding), the model-setup modal and
// Settings, so «llama.cpp is missing» is told the same way wherever the reader
// runs into it. Nothing here knows about the wizard's steps, which keeps the
// module free of a cycle with ModelSetup.

import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  CLAUDE,
  LLAMA,
  claudeStatus,
  engineStatus,
  installCommand,
  installPrereq,
  type Dependency,
  type ToolStatus,
} from "./host";
import { copyToClipboard } from "./clipboard";
import { t } from "./i18n";

export const BTN =
  "rounded-lg px-3 py-2 text-sm transition-colors border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-700/60";
export const PRIMARY =
  "rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white transition-colors hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white disabled:opacity-40";
export const QUIET =
  "text-xs text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100";

export function Check({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`}
    />
  );
}

/// The one command that installs `dep` here, with a copy button — plus the
/// prerequisite, when the command has one (Homebrew, for `brew install`).
function CommandBlock({ dep }: { dep: Dependency }) {
  const cmd = installCommand(dep);
  const prereq = installPrereq(dep);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!cmd) return;
    void copyToClipboard(cmd).then(setCopied);
  };
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);

  return (
    <div className="mt-3">
      {cmd && (
        <div className="flex items-center gap-2 rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-900/60">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs text-neutral-700 dark:text-neutral-200">
            {cmd}
          </code>
          <button className={`${QUIET} shrink-0`} onClick={copy} title={t("ob.copyCmd")}>
            {copied ? t("ui.copied") : t("ui.copy")}
          </button>
        </div>
      )}
      <div className="mt-2 flex items-center gap-3">
        <button className={QUIET} onClick={() => void openUrl(dep.docs).catch(() => {})}>
          {t("ob.claudeDocs")}
        </button>
        {prereq && <span className="text-xs text-neutral-400 dark:text-neutral-500">{prereq}</span>}
      </div>
    </div>
  );
}

/// llama.cpp's presence, its install command when missing, and a re-check that
/// costs one PATH lookup. Reused verbatim by the model-setup modal, so the
/// «llama.cpp is missing» story is told the same way everywhere.
export function EngineInstall({
  status,
  onRecheck,
  busy,
}: {
  status: ToolStatus | null;
  onRecheck: () => void;
  busy?: boolean;
}) {
  const installed = status?.installed === true;
  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <Check ok={installed} />
        <span>{installed ? t("ob.engineFound") : t("ob.engineMissing")}</span>
      </div>
      {installed ? (
        status?.path && (
          <div className="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400" title={status.path}>
            {status.version ?? status.path}
          </div>
        )
      ) : (
        <>
          <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
            {t("model.noEngineBody")}
          </p>
          <CommandBlock dep={LLAMA} />
          <div className="mt-3 flex items-center gap-3">
            <button className={BTN} onClick={onRecheck} disabled={busy}>
              {t("ob.engineRecheck")}
            </button>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">{t("ob.engineAfter")}</span>
          </div>
        </>
      )}
    </div>
  );
}

/// Claude Code's presence and its install command. Same grammar as
/// EngineInstall, one step down in importance: «Ask» is optional.
export function ClaudeInstall({
  status,
  onRecheck,
  busy,
}: {
  status: ToolStatus | null;
  onRecheck: () => void;
  busy?: boolean;
}) {
  const installed = status?.installed === true;
  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <Check ok={installed} />
        <span>{installed ? t("ob.claudeFound") : t("ob.claudeMissing")}</span>
      </div>
      {installed ? (
        <div className="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400" title={status?.path ?? ""}>
          {status?.version ?? status?.path}
        </div>
      ) : (
        <>
          <CommandBlock dep={CLAUDE} />
          <p className="mt-2 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            {t("ob.claudeAccount")}
          </p>
          <button className={`${BTN} mt-3`} onClick={onRecheck} disabled={busy}>
            {t("ob.engineRecheck")}
          </button>
        </>
      )}
    </div>
  );
}

/// A small screen for the surfaces that hit a missing engine mid-flow (the
/// translate popover, the model modal): the same block, in a modal.
export function EngineSetupModal({ onClose }: { onClose: () => void }) {
  const [engine, setEngine] = useState<ToolStatus | null>(null);
  const [probing, setProbing] = useState(false);
  const probe = useCallback(async () => {
    setProbing(true);
    setEngine(await engineStatus());
    setProbing(false);
  }, []);
  useEffect(() => {
    void probe();
  }, [probe]);

  return (
    <div
      className="modal-backdrop fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel w-[min(26rem,90vw)] rounded-xl bg-white p-4 text-sm text-neutral-800 shadow-2xl dark:bg-neutral-800 dark:text-neutral-100">
        <div className="mb-2 text-xs text-neutral-500 dark:text-neutral-400 select-none">
          {t("model.noEngineTitle")}
        </div>
        <EngineInstall status={engine} onRecheck={() => void probe()} busy={probing} />
      </div>
    </div>
  );
}

/// Read-only helper for Settings: is everything the app depends on present.
export function useDependencies(): { engine: ToolStatus | null; claude: ToolStatus | null; refresh: () => void } {
  const [engine, setEngine] = useState<ToolStatus | null>(null);
  const [claude, setClaude] = useState<ToolStatus | null>(null);
  const refresh = useCallback(() => {
    void engineStatus().then(setEngine);
    void claudeStatus().then(setClaude);
  }, []);
  useEffect(refresh, [refresh]);
  return { engine, claude, refresh };
}
