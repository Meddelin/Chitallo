// «About Chitallo» (WP-F): identity and legalese on one quiet screen — the glyph,
// the version from package.json, the privacy line, and scrollable third-party
// notices. Surface grammar: a solid modal, like ModelSetupModal/ShortcutsOverlay.

import { openUrl } from "@tauri-apps/plugin-opener";
import pkg from "../package.json";
import { IconClose } from "./icons";
import { t } from "./i18n";

// Inline copy of the app glyph (src-tauri/icons/icon.svg) — the same shapes
// and colours as in the taskbar: a page caught mid-translation.
export function AppGlyph({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true" className="shrink-0">
      <defs>
        <linearGradient id="pdfer-glyph-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2B2723" />
          <stop offset="1" stopColor="#1B1815" />
        </linearGradient>
      </defs>
      <rect x="32" y="32" width="960" height="960" rx="212" fill="url(#pdfer-glyph-bg)" />
      <rect x="252" y="172" width="520" height="680" rx="44" fill="#F6F1E7" />
      <rect x="328" y="288" width="368" height="42" rx="21" fill="#6E675F" />
      <rect x="328" y="376" width="368" height="42" rx="21" fill="#6E675F" />
      <rect x="328" y="464" width="236" height="42" rx="21" fill="#6E675F" />
      <rect x="328" y="596" width="368" height="42" rx="21" fill="#3B82F6" />
      <rect x="328" y="684" width="296" height="42" rx="21" fill="#3B82F6" />
    </svg>
  );
}

type Notice = { name: string; license: string; url: string; note?: string };

// A curated list: runtime, engines and models. Full licence texts live behind
// the links (a distribution collects them with cargo-about/license-checker).
function notices(): Notice[] {
  return [
    { name: "pdf.js", license: "Apache-2.0", url: "https://github.com/mozilla/pdf.js" },
    { name: "Tauri", license: "MIT / Apache-2.0", url: "https://github.com/tauri-apps/tauri" },
    { name: "llama.cpp", license: "MIT", url: "https://github.com/ggml-org/llama.cpp" },
    { name: "Claude Code", license: "Anthropic Commercial Terms", url: "https://code.claude.com/docs/en/setup" },
    { name: "React", license: "MIT", url: "https://github.com/facebook/react" },
    { name: "Tailwind CSS", license: "MIT", url: "https://github.com/tailwindlabs/tailwindcss" },
    { name: "KaTeX", license: "MIT", url: "https://github.com/KaTeX/KaTeX" },
    // (WP-N) both faces ship inside the app now (src/fonts), so both belong here
    { name: "Golos Text", license: "SIL OFL 1.1", url: "https://github.com/ParaType/Golos-Text" },
    { name: "Literata", license: "SIL OFL 1.1", url: "https://github.com/googlefonts/literata" },
    {
      name: t("about.modelHy"),
      license: "Hunyuan Community License",
      url: "https://huggingface.co/tencent/HY-MT1.5-7B-GGUF/blob/main/License.txt",
      note: t("about.hyLicense"),
    },
    {
      name: t("about.modelQwen"),
      license: "Apache-2.0",
      url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF",
    },
  ];
}

const link = (url: string) => openUrl(url).catch(() => window.open(url, "_blank", "noopener"));

export function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="modal-backdrop fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel w-[min(26rem,90vw)] rounded-xl bg-white p-4 text-sm text-neutral-800 shadow-2xl dark:bg-neutral-800 dark:text-neutral-100 select-none">
        <div className="mb-3 flex items-center text-xs text-neutral-500 dark:text-neutral-400">
          <span>{t("about.title")}</span>
          <span className="flex-1" />
          <button
            className="px-0.5 transition-colors hover:text-neutral-800 dark:hover:text-neutral-100"
            onClick={onClose}
            title={t("ui.close")}
          >
            <IconClose />
          </button>
        </div>

        {/* lockup: glyph + «Chitallo» + the version from package.json */}
        <div className="flex items-center gap-3">
          <AppGlyph size={40} />
          <div className="min-w-0">
            <div className="text-lg font-medium leading-tight">
              Chitallo <span className="ml-1 text-xs font-normal tabular-nums text-neutral-500 dark:text-neutral-400">{pkg.version}</span>
            </div>
            <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t("app.tagline")}</div>
          </div>
        </div>

        {/* (WP-N) one line of privacy, one line of its exception — no full stops:
            a state line ends where it ends */}
        <p className="mt-3.5 text-[13px] leading-relaxed">{t("app.privacy")}</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          {t("app.privacyAsk")}
        </p>

        <div className="mt-3 border-t border-neutral-200 pt-2 dark:border-neutral-700">
          <div className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">{t("about.thirdParty")}</div>
          <div className="-mx-1 max-h-[38vh] overflow-y-auto overscroll-contain px-1">
            {notices().map((n) => (
              <div key={n.name} className="py-1">
                <div className="flex items-baseline gap-3">
                  <button
                    className="min-w-0 truncate rounded-md px-1 -mx-1 text-left text-[13px] transition-colors hover:bg-neutral-900/5 dark:hover:bg-neutral-100/10"
                    onClick={() => void link(n.url)}
                    title={n.url}
                  >
                    {n.name}
                  </button>
                  <span className="ml-auto shrink-0 text-xs text-neutral-500 dark:text-neutral-400">{n.license}</span>
                </div>
                {n.note && (
                  <div className="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{n.note}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
