// What machine are we on, and what does the reader have to install on it.
//
// Two things live here because they answer the same question:
//   * platform facts — path separator, ⌘ vs Ctrl, whether PDF export exists;
//   * the one prescribed install command per external dependency.
//
// Chitallo bundles nothing. Each feature that needs an external program names
// exactly one way to get it, per platform, with no fallbacks: either you run
// that command, or the feature honestly says it is unavailable.

import { invoke } from "@tauri-apps/api/core";
import { sep } from "@tauri-apps/api/path";

export type OS = "windows" | "macos" | "linux";

export type HostInfo = {
  os: OS;
  /** silent HTML→PDF printing is implemented for this platform */
  pdfExport: boolean;
  /** app version, from Cargo.toml */
  version: string;
};

/// Best guess available synchronously, from the webview's own user agent. Good
/// enough for keyboard labels and path joins on the very first paint; the Tauri
/// answer replaces it a tick later.
function guess(): HostInfo {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const os: OS = /Mac|iPhone|iPad/.test(ua) ? "macos" : /Windows/.test(ua) ? "windows" : "linux";
  return { os, pdfExport: os !== "linux", version: "" };
}

let info: HostInfo = guess();

export function host(): HostInfo {
  return info;
}

export const isMac = (): boolean => info.os === "macos";

/// Resolve the real values once, at startup. Falls back to the guess outside
/// Tauri (the plain-browser dev pane), where no command exists to ask.
export async function loadHost(): Promise<HostInfo> {
  try {
    const h = await invoke<{ os: string; pdf_export: boolean; version: string }>("host_info");
    info = { os: h.os as OS, pdfExport: h.pdf_export, version: h.version };
  } catch {
    // plain browser — keep the user-agent guess
  }
  return info;
}

// ---- paths ------------------------------------------------------------------

let SEP: string | null = null;

/// The platform's path separator. Tauri answers synchronously; a plain browser
/// gets the one implied by the user-agent guess.
export function pathSep(): string {
  if (SEP === null) {
    try {
      SEP = sep();
    } catch {
      SEP = info.os === "windows" ? "\\" : "/";
    }
  }
  return SEP;
}

/// Join path segments with the platform separator, tolerating a base that
/// already ends in one (Tauri's directory getters are not consistent about it).
export function joinPath(...parts: string[]): string {
  const s = pathSep();
  return parts
    .filter((p) => p !== "")
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(s);
}

/// Last segment of a path, whichever separator it uses. Paths can arrive from
/// a store written on another machine, so both are always accepted.
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

// ---- keyboard labels --------------------------------------------------------

/// Rewrite Windows/Linux modifier names into the macOS glyphs a Mac reader
/// expects. Applied centrally in i18n's `t()`, so no call site spells both.
export function macKeys(s: string): string {
  return s
    .replace(/\bCtrl\+/g, "⌘")
    .replace(/\bCtrl\b/g, "⌘")
    .replace(/\bAlt\+/g, "⌥")
    .replace(/\bAlt\b/g, "⌥")
    .replace(/\bShift\+/g, "⇧");
}

// ---- external dependencies --------------------------------------------------

export type Dependency = {
  /** what it is called in prose */
  name: string;
  /** the one command that installs it on this platform, null where there is
   *  no single command to give and only the docs will do */
  command: Record<OS, string | null>;
  /** what the reader needs installed first, if anything */
  prereq?: Record<OS, string | null>;
  docs: string;
};

/// llama.cpp — the inference engine that runs the translation model.
/// Commands from the project's own install docs.
export const LLAMA: Dependency = {
  name: "llama.cpp",
  command: {
    windows: "winget install llama.cpp",
    macos: "brew install llama.cpp",
    linux: null, // no single official package — the docs cover the distros
  },
  prereq: {
    windows: null,
    macos: "Homebrew (brew.sh)",
    linux: null,
  },
  docs: "https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md",
};

/// Claude Code — powers the optional «Ask» sidebar.
export const CLAUDE: Dependency = {
  name: "Claude Code",
  command: {
    windows: "irm https://claude.ai/install.ps1 | iex",
    macos: "curl -fsSL https://claude.ai/install.sh | bash",
    linux: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  docs: "https://code.claude.com/docs/en/setup",
};

/// The command to show for this machine.
export function installCommand(dep: Dependency): string | null {
  return dep.command[info.os];
}

export function installPrereq(dep: Dependency): string | null {
  return dep.prereq?.[info.os] ?? null;
}

// ---- probes -----------------------------------------------------------------

export type ToolStatus = { installed: boolean; path: string | null; version: string | null };

const OFFLINE: ToolStatus = { installed: false, path: null, version: null };

/// Is llama.cpp on this machine, and where. Outside Tauri nothing can be
/// probed, so the honest answer is "not installed".
export async function engineStatus(): Promise<ToolStatus> {
  try {
    return await invoke<ToolStatus>("engine_status");
  } catch {
    return OFFLINE;
  }
}

/// Is the Claude Code CLI on this machine, and which version.
export async function claudeStatus(): Promise<ToolStatus> {
  try {
    return await invoke<ToolStatus>("claude_status");
  } catch {
    return OFFLINE;
  }
}
