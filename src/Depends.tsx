// The external programs Chitallo depends on, as UI: is it here, and if not, the
// one command that installs it on this machine.
//
// Shared by the first-run checklist (Onboarding), the model-setup modal and
// Settings, so «llama.cpp is missing» is told the same way wherever the reader
// runs into it. Nothing here knows about the checklist's rows, which keeps the
// module free of a cycle with ModelSetup.
//
// (WP-N) Direction B grammar: a missing dependency is a state row — reason on
// the left, verb on the right — and the install command sits under it as one
// line of monospace with «Copy». No paragraphs, no «once installed, press…»:
// the button IS that sentence.

import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
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

// The button vocabulary of direction B (Components.dc.html): ink-on-paper for
// the one primary action, transparent + the single house hover for everything
// else, and ACT — the small bordered verb that closes a state row. Opacity
// moves only on a disabled control, never on hover.
export const BTN =
  "rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10 disabled:pointer-events-none disabled:opacity-50";
export const PRIMARY =
  "rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white transition-colors hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white disabled:opacity-50";
export const ACT =
  "shrink-0 rounded-md border border-neutral-200 px-2.5 py-1 text-xs transition-colors hover:bg-neutral-900/5 dark:border-neutral-700 dark:hover:bg-neutral-100/10 disabled:pointer-events-none disabled:opacity-50";
export const QUIET =
  "text-xs text-neutral-500 dark:text-neutral-400 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100";

/// The 7 px dot of the checklist: the accent means «in place», amber means
/// «needs attention». Green is not in this palette.
export function Check({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${ok ? "bg-accent" : "bg-amber-500"}`}
    />
  );
}

/// A reason with its way out on the same line, on the amber «attention» wash.
export function WarnRow({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-amber-500/10 px-2.5 py-2 text-sm">
      <span className="min-w-0 flex-1">{text}</span>
      {action}
    </div>
  );
}

/// The one command that installs `dep` here, with «Copy» under it — plus the
/// docs, the prerequisite the command has (Homebrew, for `brew install`) and,
/// where the caller can act on it, «Check again».
export function CommandBlock({
  dep,
  onRecheck,
  busy,
}: {
  dep: Dependency;
  onRecheck?: () => void;
  busy?: boolean;
}) {
  const cmd = installCommand(dep);
  const prereq = installPrereq(dep);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!cmd) return;
    // a failed copy simply leaves the button as «Copy» — one label, no toast
    void copyToClipboard(cmd).then(setCopied);
  };
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);

  return (
    <div className="mt-2.5">
      {cmd && (
        <div className="overflow-x-auto rounded-lg bg-neutral-100 px-3 py-2.5 font-mono text-xs whitespace-pre text-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-200">
          {cmd}
        </div>
      )}
      <div className="mt-2 flex items-center gap-3">
        {cmd && (
          <button className={QUIET} onClick={copy} title={t("ob.copyCmd")}>
            {copied ? t("ui.copied") : t("ui.copy")}
          </button>
        )}
        <button className={QUIET} onClick={() => void openUrl(dep.docs).catch(() => {})}>
          {t("ob.claudeDocs")}
        </button>
        {onRecheck && (
          <button className={QUIET} onClick={onRecheck} disabled={busy}>
            {t("ob.engineRecheck")}
          </button>
        )}
        {prereq && <span className="ml-auto text-xs text-neutral-400 dark:text-neutral-500">{prereq}</span>}
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
  if (installed) {
    return (
      <div className="flex items-center gap-2.5 text-sm">
        <Check ok />
        <span className="min-w-0 flex-1">{t("ob.engineFound")}</span>
        {status?.path && (
          <span className="min-w-0 shrink truncate text-xs text-neutral-500 dark:text-neutral-400" title={status.path}>
            {status.version ?? status.path}
          </span>
        )}
      </div>
    );
  }
  return (
    <div>
      <WarnRow
        text={t("ob.engineMissing")}
        action={
          <button className={ACT} onClick={onRecheck} disabled={busy}>
            {t("ob.engineRecheck")}
          </button>
        }
      />
      {/* (WP-N) what the engine is for — one quiet line, worded exactly as the
          checklist words it; the command right below is the rest of the sentence */}
      <div className="mt-2 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
        {t("model.noEngineBody")}
      </div>
      <CommandBlock dep={LLAMA} />
    </div>
  );
}

// (WP-N) `ClaudeInstall` lived here until the first run became a checklist:
// the checklist writes the Claude row itself (state · verb · how-to), so a
// second, taller way of telling the same story is one way too many. Same for
// `EngineSetupModal` — no surface ever opened it; the model modal owns that
// screen and calls `EngineInstall` directly.

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
