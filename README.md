# Chitallo

A minimalist PDF reader that translates whole books on your own machine.
Windows and macOS, built with Tauri 2.

[Русская версия](README.ru.md)

Select a sentence and the translation appears next to it. Alt+click translates a
whole paragraph. One button translates the entire book: finished pages are saved
to disk, `T` flips between the original and the translation, and the run can be
paused and resumed at any point. A local model does the work — no internet, no
subscription, nothing leaves your computer.

The interface, and the language books are translated **into**, is Russian or
English — you pick it on first launch and can change it in Settings.

## What it does

- **Reading** — continuous scroll, 1/2/auto columns, cursor-anchored zoom, dark
  theme, outline and internal links, jump history (Alt+←/→), a remembered
  position per book
- **Selection and paragraph translation** (Alt+click) — the local HY-MT1.5-7B
  model through llama.cpp, with the surrounding paragraph as context
- **Whole-book translation** — a background run you can pause and resume;
  finished pages are stored and open offline, paragraph layout is rebuilt, and
  figures, tables and formulas are carried over as high-resolution crops of the
  original
- **Book glossary** — characteristic terms are mined from the text
  statistically, translated by the model, and applied while translating; you can
  edit the list by hand
- **Search** (Ctrl+F) — over the original and over the finished translation
- **Command palette** (Ctrl+K) — commands, «page N», book switching, search;
  the shortcut overlay is `?`
- **Library** with covers, reading progress and a live folder watch
- **Export** — the finished translation to PDF (with the original's
  illustrations) or HTML, one click, straight to Downloads
- **«Ask»** (Ctrl+J) — questions about the book you are reading, through Claude
  Code. Optional, and the only feature that uses the network.

## Privacy

Books, translations and glossaries stay on your computer: the model is
downloaded once and runs locally. The single exception is the optional «Ask»
feature — your question and a fragment of the open book are sent to Claude, on
an explicit action.

## Install

Download the installer for your platform from
[Releases](https://github.com/Meddelin/Chitallo/releases):

| Platform | File |
| --- | --- |
| Windows 10/11 | `Chitallo_<version>_x64-setup.exe` |
| macOS 11+ (Apple silicon) | `Chitallo_<version>_aarch64.dmg` |
| macOS 11+ (Intel) | `Chitallo_<version>_x64.dmg` |

The builds are not code-signed yet, so the first launch shows a warning:
SmartScreen on Windows ("More info" → "Run anyway"), Gatekeeper on macOS
(right-click the app → "Open").

## Dependencies

**Chitallo ships nothing but Chitallo.** No model weights, no inference engine, no
runtime. Each feature names exactly one program to install, per platform, and
says so plainly when it is missing — the first-run setup walks you through all
of it.

| For | Install | Needed by |
| --- | --- | --- |
| Translation engine | `winget install llama.cpp` / `brew install llama.cpp` | everything that translates |
| Translation model | downloaded from the setup screen (4.6 GB, once) | everything that translates |
| «Ask» | [Claude Code](https://code.claude.com/docs/en/setup) + a Claude Pro or Max plan | the «Ask» sidebar only |

Chitallo finds `llama-server` on your PATH, in `~/.local/bin`, in Homebrew's or
WinGet's directories, or in `<app data>/llama` if you put a build there
yourself. `CHITALLO_LLAMA_SERVER` overrides the search with an explicit path;
`CHITALLO_CLAUDE_BIN` does the same for the Claude Code CLI.

If a `llama-server` is already listening on port 11544, Chitallo uses that one and
never touches it — your own tuned instance stays yours.

## Models

| Model | Role | Size | Licence |
| --- | --- | --- | --- |
| [HY-MT1.5-7B](https://huggingface.co/tencent/HY-MT1.5-7B-GGUF) (Tencent) | book translation | 4.6 GB | Hunyuan Community License — free, commercial use included; **not available in the EU, the UK or South Korea** |
| [Qwen3.5-4B](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF) (Alibaba) | glossary term translation (optional) | 2.7 GB | Apache-2.0 |

Downloads only ever happen on an explicit action, with the licence in plain
sight. An interrupted download resumes from where it stopped and survives an app
restart; the finished file is checked against the publisher's SHA-256 before it
is used.

Weights live in `<app data>/models` —
`%APPDATA%\com.stas.pdfer\models` on Windows,
`~/Library/Application Support/com.stas.pdfer/models` on macOS.

## Build from source

Requires Node.js 20+, Rust (stable), and the platform toolchain: MSVC build
tools on Windows, Xcode command line tools on macOS.

```sh
npm install
npm run tauri dev     # development (Vite + HMR)
npm run tauri build   # release build and installer
```

`npm run typecheck` runs TypeScript over the frontend without emitting.

The app icon is generated from `src-tauri/icons/icon.svg`:

```sh
npx tauri icon src-tauri/icons/icon.svg
```

## How it fits together

Tauri 2 · React 19 · TypeScript · Tailwind CSS 4 · PDF.js · llama.cpp

- `src/` — the reader. `App.tsx` owns the reading surface and the toolbar;
  `booktranslate.ts` runs whole-book translation; `paragraphs.ts` and `crops.ts`
  rebuild page structure; `export.ts` assembles the PDF/HTML/TXT output;
  `i18n.ts` holds every user-visible string in both languages.
- `src-tauri/src/` — the native half. `lib.rs` supervises the llama-server
  processes, downloads weights, and drives the Claude Code CLI; `platform.rs`
  finds the external binaries and measures free disk space; `print.rs` prints
  HTML to PDF through WebView2 on Windows and NSPrintOperation on macOS.

Versions and licences of third-party components are listed in the app under
«Translation ▾» → «About Chitallo».

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). Releasing: see
[RELEASING.md](RELEASING.md).

## Licence

MIT — see [LICENSE](LICENSE). The models are licensed separately, by their
publishers; see the table above.
