// First-run setup: language, then the two external programs Chitallo needs, then
// the weights.
//
// The shape follows the distribution policy: Chitallo bundles nothing, so setup
// is a guided tour of what the reader installs themselves. Each step states
// what the thing is for, prints exactly one command for this platform, and
// re-checks on demand — no silent probing loops, no fallbacks, no pretending a
// missing dependency is fine.
//
// Every step is skippable. A reader who only wants to page through PDFs gets
// there in two clicks, and each surface that later needs a missing piece
// (the translate popover, the «Ask» sidebar) offers the same install block.

import { useCallback, useEffect, useState } from "react";

import { Check, ClaudeInstall, EngineInstall, PRIMARY, QUIET } from "./Depends";
import { CLAUDE, LLAMA, claudeStatus, engineStatus, type ToolStatus } from "./host";
import { getLang, setLang, t, type Lang } from "./i18n";
import {
  Progress,
  cancelDownload,
  dlBusy,
  dlErrorLine,
  dlPct,
  fetchModelStatus,
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

/// Re-run setup from Settings: clear the flag so the tour opens again, but
/// keep the language — the reader is not asked to pick it a second time
/// unless they change it right there in the wizard.
export function resetOnboarding(): void {
  localStorage.removeItem(ONBOARDED_KEY);
}

// ---- the wizard -------------------------------------------------------------

type Step = "lang" | "engine" | "claude" | "ready";
const STEPS: Step[] = ["lang", "engine", "claude", "ready"];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("lang");
  const [lang, setLangState] = useState<Lang>(getLang());
  const [engine, setEngine] = useState<ToolStatus | null>(null);
  const [claude, setClaude] = useState<ToolStatus | null>(null);
  const [probing, setProbing] = useState(false);
  const [weightsReady, setWeightsReady] = useState<boolean | null>(null);
  const dl = useDownload("main");

  const idx = STEPS.indexOf(step);

  const probeEngine = useCallback(async () => {
    setProbing(true);
    const [e, s] = await Promise.all([engineStatus(), fetchModelStatus()]);
    setEngine(e);
    // "starting"/"spawned"/"external" all mean the weights are on disk and the
    // server is already dealing with them; only "none" means "not downloaded".
    setWeightsReady(s !== "none" && s !== "noengine");
    setProbing(false);
  }, []);

  const probeClaude = useCallback(async () => {
    setProbing(true);
    setClaude(await claudeStatus());
    setProbing(false);
  }, []);

  // Probe when a step is entered, not on a timer: a probe spawns a process.
  useEffect(() => {
    if (step === "engine") void probeEngine();
    if (step === "claude") void probeClaude();
  }, [step, probeEngine, probeClaude]);

  const finish = () => {
    setLang(lang);
    markOnboarded();
    onDone();
  };

  const advance = () => setStep(STEPS[Math.min(STEPS.length - 1, idx + 1)]);
  const goBack = () => setStep(STEPS[Math.max(0, idx - 1)]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-100 dark:bg-neutral-900">
      <div className="w-[min(30rem,92vw)] rounded-2xl bg-white p-6 text-neutral-800 shadow-2xl dark:bg-neutral-800 dark:text-neutral-100">
        <div className="mb-4 flex items-center gap-2">
          {STEPS.map((s, i) => (
            <span
              key={s}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= idx ? "bg-accent" : "bg-neutral-200 dark:bg-neutral-700"
              }`}
            />
          ))}
        </div>

        {step === "lang" && (
          <>
            <h2 className="text-lg font-medium">{t("ob.langTitle")}</h2>
            <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
              {t("ob.langBody")}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              {(["ru", "en"] as const).map((l) => (
                <button
                  key={l}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                    lang === l
                      ? "border-accent bg-accent/5"
                      : "border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-700/60"
                  }`}
                  onClick={() => {
                    setLangState(l);
                    // apply at once: the very next sentence is in the new
                    // language, which is the whole point of the choice
                    setLang(l);
                  }}
                >
                  <div className="text-base">{l === "ru" ? "Русский" : "English"}</div>
                  <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {l === "ru" ? "Перевод книг на русский" : "Books translated into English"}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {step === "engine" && (
          <>
            <h2 className="text-lg font-medium">{t("ob.engineTitle")}</h2>
            {/* no intro paragraph here: EngineInstall already explains what
                llama.cpp is for and why Chitallo does not ship it, and saying it
                twice on one screen reads as a stutter */}
            <div className="mt-3">
              <EngineInstall status={engine} onRecheck={() => void probeEngine()} busy={probing} />
            </div>
            {engine?.installed && (
              <div className="mt-5 border-t border-neutral-200 pt-4 dark:border-neutral-700">
                <h3 className="text-sm font-medium">{t("ob.weightsTitle")}</h3>
                {weightsReady ? (
                  <div className="mt-2 flex items-center gap-2 text-sm">
                    <Check ok /> <span>{t("ob.weightsReady")}</span>
                  </div>
                ) : dlBusy(dl) ? (
                  <div className="mt-3">
                    <Progress dl={dl} onCancel={() => cancelDownload("main")} />
                  </div>
                ) : (
                  <>
                    <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
                      {t("ob.weightsBody")}
                    </p>
                    {dl.status === "error" && (
                      <p className="mt-2 text-xs text-red-600 dark:text-red-400">{dlErrorLine(dl.error)}</p>
                    )}
                    <button className={`${PRIMARY} mt-3 w-full`} onClick={() => startDownload("main")}>
                      {dl.received > 0
                        ? t("model.resumeCta", { pct: dlPct(dl) })
                        : t("model.downloadCta", { size: sizeLabel("main") })}
                    </button>
                    <p className="mt-3 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                      {t("model.license")}
                    </p>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {step === "claude" && (
          <>
            <h2 className="text-lg font-medium">{t("ob.claudeTitle")}</h2>
            <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
              {t("ob.claudeBody")}
            </p>
            <div className="mt-4">
              <ClaudeInstall status={claude} onRecheck={() => void probeClaude()} busy={probing} />
            </div>
          </>
        )}

        {step === "ready" && (
          <>
            <h2 className="text-lg font-medium">{t("ob.readyTitle")}</h2>
            <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
              {t("ob.readyBody")}
            </p>
            <ul className="mt-4 space-y-1.5 text-sm">
              <li className="flex items-center gap-2">
                <Check ok={engine?.installed === true} /> {LLAMA.name}
              </li>
              <li className="flex items-center gap-2">
                <Check ok={weightsReady === true || dl.status === "done"} /> {t("ob.weightsTitle")}
              </li>
              <li className="flex items-center gap-2">
                <Check ok={claude?.installed === true} /> {CLAUDE.name}
              </li>
            </ul>
          </>
        )}

        <div className="mt-6 flex items-center gap-3">
          {idx > 0 && (
            <button className={QUIET} onClick={goBack}>
              {t("ui.back")}
            </button>
          )}
          <span className="flex-1" />
          {step === "ready" ? (
            <button className={PRIMARY} onClick={finish}>
              {t("ob.start")}
            </button>
          ) : (
            <>
              <button className={QUIET} onClick={finish}>
                {t("ob.skipAll")}
              </button>
              <button className={PRIMARY} onClick={advance}>
                {t("ui.next")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

