// First run: pick a language, then look at one checklist.
//
// (WP-N) The five-step wizard is gone. A queue of screens decided the order for
// the reader and only showed the price of setup on the last one; the checklist
// shows every item at once — what is already here, what is missing, what each
// one buys — and the library opens from any line of it.
//
// The shape still follows the distribution policy: Chitallo bundles nothing, so
// each row states what the thing is for, prints exactly one command for this
// platform and re-checks on demand — no silent probing loops, no fallbacks, no
// pretending a missing dependency is fine.

import { useCallback, useEffect, useState } from "react";

import { ACT, Check, CommandBlock, PRIMARY, QUIET } from "./Depends";
import { CLAUDE, LLAMA, claudeStatus, engineStatus, type ToolStatus } from "./host";
import { getLang, setLang, t, type Lang } from "./i18n";
import {
  Progress,
  cancelDownload,
  dlBusy,
  dlErrorLine,
  modelFileReady,
  sizeLabel,
  startDownload,
  useDownload,
} from "./ModelSetup";

const ONBOARDED_KEY = "pdfer:onboarded";

/// Has the reader been through setup? A fresh profile has neither a language
/// nor this flag; either one missing means the tour has not run.
export function needsOnboarding(): boolean {
  return localStorage.getItem(ONBOARDED_KEY) !== "1";
}

export function markOnboarded(): void {
  localStorage.setItem(ONBOARDED_KEY, "1");
}

/// Re-run setup from Settings: clear the flag so the checklist opens again, but
/// keep the language — the reader is not asked to pick it a second time unless
/// they open the language screen from the checklist.
export function resetOnboarding(): void {
  localStorage.removeItem(ONBOARDED_KEY);
}

// ---- one row of the checklist -----------------------------------------------

/// Name on the left, state next to it, verb last. The dot appears only when the
/// item is in place; otherwise the 7 px gutter keeps every label on one edge.
function SetupRow({
  ok,
  first,
  label,
  value,
  warn,
  action,
  children,
}: {
  ok?: boolean;
  first?: boolean;
  label: string;
  value?: string;
  warn?: boolean;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className={first ? "py-3" : "border-t border-neutral-200 py-3 dark:border-neutral-700"}>
      <div className="flex items-center gap-2.5">
        {ok ? <Check ok /> : <span aria-hidden className="w-[7px] shrink-0" />}
        <span className="min-w-0 flex-1 text-sm">{label}</span>
        {value && (
          <span
            className={`shrink-0 text-[13px] tabular-nums ${
              warn ? "text-amber-700 dark:text-amber-500" : "text-neutral-500 dark:text-neutral-400"
            }`}
          >
            {value}
          </span>
        )}
        {action}
      </div>
      {children && <div className="mt-2 pl-[17px]">{children}</div>}
    </div>
  );
}

// ---- the two screens --------------------------------------------------------

type Screen = "lang" | "setup";

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [screen, setScreen] = useState<Screen>("lang");
  const [lang, setLangState] = useState<Lang>(getLang());
  const [engine, setEngine] = useState<ToolStatus | null>(null);
  const [claude, setClaude] = useState<ToolStatus | null>(null);
  const [probing, setProbing] = useState(false);
  const [weightsReady, setWeightsReady] = useState<boolean | null>(null);
  // which install command is unrolled — the reader asked for it by name
  const [howTo, setHowTo] = useState<"engine" | "claude" | null>(null);
  // the summary opened back into the full list
  const [full, setFull] = useState(false);
  const dl = useDownload("main");
  const libDir = localStorage.getItem("pdfer:libdir");

  // One probe for the whole screen: two PATH lookups and a disk check. The
  // weights are asked of the DISK, not of the server, so the row stays honest
  // while llama.cpp is still missing.
  const probe = useCallback(async () => {
    setProbing(true);
    const [e, c, w] = await Promise.all([engineStatus(), claudeStatus(), modelFileReady("main")]);
    setEngine(e);
    setClaude(c);
    setWeightsReady(w === true);
    setProbing(false);
  }, []);

  // Probe when the checklist is entered, not on a timer: a probe spawns a process.
  useEffect(() => {
    if (screen === "setup") void probe();
  }, [screen, probe]);

  // a finished download answers the model row without a second disk trip
  useEffect(() => {
    if (dl.status === "done") setWeightsReady(true);
  }, [dl.status]);

  const finish = () => {
    setLang(lang);
    markOnboarded();
    onDone();
  };

  const engineOk = engine?.installed === true;
  const claudeOk = claude?.installed === true;
  const busy = dlBusy(dl);
  // everything the reading and translating needs is here — the list has nothing
  // left to ask, so it says so in three lines instead of four rows
  const settled = engineOk && weightsReady === true && !busy;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-100 dark:bg-neutral-900">
      <div className="w-[min(30rem,92vw)] rounded-2xl bg-white p-6 text-neutral-800 shadow-2xl dark:bg-neutral-800 dark:text-neutral-100">
        {screen === "lang" ? (
          <>
            <h2 className="text-lg font-medium">{t("ob.langTitle")}</h2>
            <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{t("ob.langBody")}</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              {(["ru", "en"] as const).map((l) => (
                <button
                  key={l}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                    lang === l
                      ? "border-accent bg-accent/5"
                      : "border-neutral-300 hover:bg-neutral-900/5 dark:border-neutral-700 dark:hover:bg-neutral-100/10"
                  }`}
                  onClick={() => {
                    setLangState(l);
                    // apply at once: the very next line is in the new language,
                    // which is the whole point of the choice
                    setLang(l);
                  }}
                >
                  <div className="text-sm font-medium">{l === "ru" ? "Русский" : "English"}</div>
                  <div className="mt-0.5 text-xs leading-snug text-neutral-500 dark:text-neutral-400">
                    {l === "ru" ? "Перевод книг на русский" : "Books translated into English"}
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-6 flex justify-end">
              <button className={PRIMARY} onClick={() => setScreen("setup")}>
                {t("ui.next")}
              </button>
            </div>
          </>
        ) : settled && !full ? (
          <>
            <h2 className="text-lg font-medium">{t("ob.readyTitle")}</h2>
            <div className="mt-3.5 flex flex-col gap-2.5">
              {libDir && (
                <div className="flex items-center gap-2.5 text-sm">
                  <Check ok />
                  <span className="min-w-0 truncate" title={libDir}>
                    {t("ob.readyLib", { path: libDir })}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2.5 text-sm">
                <Check ok />
                <span>{t("ob.readyTr", { model: t("set.modelTrDesc") })}</span>
              </div>
              <div className="flex items-center gap-2.5 text-sm">
                <Check ok />
                <span>{claudeOk ? t("ob.readyAskOn") : t("ob.readyAskOff")}</span>
              </div>
            </div>
            <div className="mt-6 flex items-center justify-between">
              <button className={QUIET} onClick={() => setFull(true)}>
                {t("ob.setupTitle")}
              </button>
              <button className={PRIMARY} onClick={finish}>
                {t("ob.start")}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-lg font-medium">{t("ob.setupTitle")}</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-300">
              {t("ob.setupBody")}
            </p>

            <div className="mt-3">
              <SetupRow
                first
                label={t("ob.rowLang")}
                value={lang === "ru" ? "Русский" : "English"}
                action={
                  <button className={ACT} onClick={() => setScreen("lang")}>
                    {t("set.change")}
                  </button>
                }
              />

              <SetupRow
                ok={engineOk}
                label={t("set.engine")}
                value={engine === null ? "…" : engineOk ? t("set.engineReady") : t("set.engineMissing")}
                warn={engine !== null && !engineOk}
                action={
                  engine !== null &&
                  !engineOk && (
                    <button className={ACT} onClick={() => setHowTo((h) => (h === "engine" ? null : "engine"))}>
                      {t("ui.install")}
                    </button>
                  )
                }
              >
                {howTo === "engine" && !engineOk && (
                  <>
                    <div className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                      {t("model.noEngineBody")}
                    </div>
                    <CommandBlock dep={LLAMA} onRecheck={() => void probe()} busy={probing} />
                  </>
                )}
              </SetupRow>

              <SetupRow
                ok={weightsReady === true}
                label={t("ob.weightsTitle")}
                value={busy ? undefined : sizeLabel("main")}
                action={
                  weightsReady === false &&
                  !busy && (
                    <button className={ACT} onClick={() => startDownload("main")}>
                      {dl.received > 0 ? t("set.resume") : t("ui.download")}
                    </button>
                  )
                }
              >
                {busy ? (
                  <Progress dl={dl} onCancel={() => cancelDownload("main")} />
                ) : (
                  weightsReady === false && (
                    <>
                      {dl.status === "error" && (
                        <div className="text-xs text-red-600 dark:text-red-400">{dlErrorLine(dl.error)}</div>
                      )}
                      <div className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                        {t("model.licenseShort")}
                      </div>
                    </>
                  )
                )}
              </SetupRow>

              <SetupRow
                ok={claudeOk}
                label={CLAUDE.name}
                value={claude === null ? "…" : claudeOk ? t("set.claudeReady") : t("set.claudeMissing")}
                warn={claude !== null && !claudeOk}
                action={
                  claude !== null &&
                  !claudeOk && (
                    <button className={ACT} onClick={() => setHowTo((h) => (h === "claude" ? null : "claude"))}>
                      {t("ui.install")}
                    </button>
                  )
                }
              >
                {!claudeOk && (
                  <>
                    <div className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                      {t("ob.claudeWhy")}
                    </div>
                    {howTo === "claude" && <CommandBlock dep={CLAUDE} onRecheck={() => void probe()} busy={probing} />}
                  </>
                )}
              </SetupRow>
            </div>

            <div className="mt-5 flex justify-end">
              <button className={PRIMARY} onClick={finish}>
                {t("ob.start")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
