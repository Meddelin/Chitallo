# Chitallo

A minimalist PDF reader that translates whole books on your own machine.
Windows and macOS, built with Tauri 2.

[Русская версия](README.ru.md)

Select a sentence and the translation appears next to it. Alt+click translates a
whole paragraph. One button translates the entire book: finished pages are saved
to disk, `T` flips between the original and the translation, and the run can be
paused and resumed at any point. Two local models do the work — one drafts the
translation, the other reads it back and fixes the language — no internet, no
subscription, nothing leaves your computer.

The interface, and the language books are translated **into**, is Russian or
English — you pick it on first launch and can change it in Settings.

## What it does

- **Reading** — continuous scroll, 1/2/auto columns, cursor-anchored zoom, dark
  theme, outline and internal links, jump history (Alt+←/→), a remembered
  position per book
- **Selection and paragraph translation** (Alt+click) — the local
  TranslateGemma-12B-it model through llama.cpp, with the surrounding paragraph
  as context. One stage, because it answers while you wait
- **Whole-book translation, stage one — the draft** — a background run you can
  pause and resume; finished pages are stored and open offline, paragraph layout
  is rebuilt, and figures, tables and formulas are carried over as
  high-resolution crops of the original. TranslateGemma goes paragraph by
  paragraph carrying the previous source paragraph **and** the translation
  already produced for this book into every prompt: without that window pronouns
  lose what they point at, tense drifts between neighbouring paragraphs, and the
  form of address wanders between ты and вы inside one chapter
- **Whole-book translation, stage two — the style edit** — Gemma 4 26B-A4B-it
  reads the finished translation back with the original deliberately out of
  view, and fixes agreement, case, typos, unreadable characters and register,
  guided by the book's own terms and a style guide. A separate run you start
  yourself, and an optional one: the draft alone produces a whole translated
  book
- **Book terms** — a term list per book, kept in a plain text file, one line per
  term, that you can edit by hand. The local model reads the book first — the
  opening pages and a spread through the rest — works out what it is about and
  in which tradition, and only then names the terms and writes the definitions
  inside that frame; that is what keeps the book's own running examples out of
  the list, and what stops a settled term being translated word by word. A
  model-free mining pass still runs and still writes, so a machine with no term
  model installed gets the terms, their pages and their frequencies anyway. The
  list is not a step of translation: translation is prompted with it, the
  knowledge graph takes its concepts already typed and explained, and «Ask»
  reads them from there
- **Search** (Ctrl+F) — over the original and over the finished translation
- **Command palette** (Ctrl+K) — commands, «page N», book switching, search;
  the shortcut overlay is `?`
- **Library** with covers, reading progress and a live folder watch
- **Knowledge graph** — a second view of the library: every book gives up its
  concepts, books that share one are joined, and «Ask» looks there before it
  looks anywhere else
- **Export** — the finished translation to PDF (with the original's
  illustrations) or HTML, one click, straight to Downloads
- **«Ask»** (Ctrl+J) — questions about the book you are reading, through Claude
  Code. An answer is prose unless a picture earns its place: it may carry typeset
  LaTeX, a chart drawn from the book's own numbers (with a table view), or a
  diagram. Optional, and one of the only two things that use the network — see
  Privacy.

## Privacy

Books, translations and glossaries stay on your computer: the models are
downloaded once and run locally. Three things go out, all through Claude Code
and all on an explicit action.

«Ask» sends your question, a fragment of the open book, and a short pointer list
from the knowledge graph — names of concepts, titles of the books they appear in,
the page numbers and a few neighbouring titles — so the answer starts from your
own library. The one-line description of a concept goes only when the concept
also stands in an open article, or in the book already in front of you.

«Read open articles through Claude Code» asks what the terms of an openly
published article denote. It sends the title, the authors, the keywords and
subject from the file's metadata, and the terms from that file's own term list —
what the local model mined, plus anything you typed there yourself. Never a
definition, never the pages, and never the file. It is off by default, and a
licensed book, or one the classifier could not place, is read here by the local
model instead.

«Allow web search» is the one switch that reaches past Anthropic. With it on,
Claude Code may run a search or open a page while answering, so your question —
and whatever it takes to look it up — reaches a search engine and the sites it
returns. Off by default; with it off «Ask» is given no tools at all, and the
graph is read either way before anything else is.

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
| Translation engine | one command, and which one depends on your GPU — see below | everything that translates |
| Draft model | downloaded from the setup screen (7.3 GB, once) | everything that translates |
| Style editor and term model | downloaded from Settings → Models (14.2 GB, once; wants 16 GB of VRAM and 32 GB of system RAM) | the style pass, the term store, the knowledge graph |
| «Ask» | [Claude Code](https://code.claude.com/docs/en/setup) + a Claude Pro or Max plan | the «Ask» sidebar only |

### Which llama.cpp build is yours

Still one command per machine and no fallbacks — but which command it is
depends on the card, because `winget install llama.cpp` installs the **Vulkan**
build: the winget manifest for `ggml.llamacpp` points its `InstallerUrl` at
`llama-b<NNNNN>-bin-win-vulkan-x64.zip`. For an AMD or an Intel GPU that is the
right answer. For an NVIDIA card it is the wrong one.

- **macOS** — `brew install llama.cpp`. Metal, and nothing to choose.
- **Windows, AMD or Intel GPU** — `winget install llama.cpp`.
- **Windows, NVIDIA GPU** — the CUDA build, which is not a package: it is
  three archives from the
  [llama.cpp releases page](https://github.com/ggml-org/llama.cpp/releases).

Take all three from the **same build number** and unpack them into
`%APPDATA%\com.stas.pdfer\llama`, the directory Chitallo looks in before it
looks anywhere else:

| Archive | What is in it |
| --- | --- |
| `llama-b<NNNNN>-bin-win-cpu-x64.zip` | `llama-server.exe` and the rest of the executables |
| `llama-b<NNNNN>-bin-win-cuda-13.3-x64.zip` | `ggml-cuda.dll` — the CUDA backend, and nothing else |
| `cudart-llama-bin-win-cuda-13.3-x64.zip` | the CUDA runtime libraries |

The CUDA archive holds one backend library, so it is not an install on its own:
without the first there is no `llama-server.exe` to run, and without the third
the one you have will not start. If that directory already holds an older
Vulkan build, delete `ggml-vulkan.dll` from it — llama.cpp registers every
backend library it finds beside the binary, and with both registered the same
card is offered to the app twice.

**Take the 13.3 archives, not the 12.4 ones.** CUDA 12.4 predates compute
capability 12.0, so on a 50-series card llama-server loads the model, starts
generating and then dies with `no kernel image is available for execution on
the device`.

`llama-server --list-devices` is the check: one line naming your card, reading
`CUDA0` where you took the NVIDIA path and `Vulkan0` where you did not.

### What it needs, and what it costs

The machine this was built against is a discrete GPU with about 16 GB of VRAM
and 32 GB of system RAM. Both numbers matter, and the second is not there out of
generosity: the style-and-terms model is 14.2 GB of weights, and on a card that
cannot hold all of them Chitallo moves as many of its expert layers into system
RAM as it must, where every generated token has to read them again. Below about
20 GB of RAM the app refuses to start that model rather than let the machine
thrash — it says so plainly, and everything that does not need it keeps
working.

The two models take turns on the card rather than sharing it. Starting the
style-and-terms server stops the draft server, and the last feature to let go of
it starts the draft server again. That costs a model load, under a minute, and
it buys the whole card for whichever model is running — which for the style
editor is the difference between its experts sitting in VRAM and sitting in
system RAM. Nothing is given up for it: the style edit reads what the draft
wrote, so the two could never have run at the same time anyway. A `llama-server`
you started yourself is never stopped, for this or for any other reason.

The honest cost, on the 838-page book this was developed against: the draft is
on the order of two hours and the style edit up to four or five more, they do
not overlap, and there is no version of this that runs while you wait. Roughly
three quarters of an hour per hundred pages for both stages together. A chapter
is a coffee; a book is an evening. It is still why the style edit is its own
button in the translation panel rather than a second half of «Translate the
book»: it is the slower stage, and it is the optional one.

Those figures are arithmetic over throughput measured on this card, not a
stopwatch held over a whole book. The panel prints an ETA computed from your own
book as soon as its first page is finished.

Chitallo finds `llama-server` in `<app data>/llama` first, then in
`~/.local/bin`, in Homebrew's and WinGet's directories, and last on your PATH —
so a build you placed there yourself always wins over one a package manager
installed. `CHITALLO_LLAMA_SERVER` overrides the search with an explicit path;
`CHITALLO_CLAUDE_BIN` does the same for the Claude Code CLI.

Two ports are used. 11544 carries the draft model, 11545 the style editor and
term model, and they hand the card back and forth as described above. If a
`llama-server` is already listening on either port, Chitallo uses that one
exactly as it finds it and never touches it: it starts no second instance,
changes no setting on yours, does not stop it when it is finished, and does not
stop it to make room for the other model either. Your own tuned instance stays
yours.

## Models

| Model | Role | Size | Licence |
| --- | --- | --- | --- |
| [TranslateGemma-12B-it](https://huggingface.co/bullerwins/translategemma-12b-it-GGUF) (Google) | book translation, stage one — the draft | 7.3 GB | Gemma Terms of Use |
| [Gemma 4 26B-A4B-it](https://huggingface.co/unsloth/gemma-4-26B-A4B-it-qat-GGUF) (Google) | stage two — the style edit; and the term model: categories, definitions and checking for a book's terms, and translating them when the book is not in your language (optional) | 14.2 GB | Gemma Terms of Use |

Both links point at community re-uploads rather than at Google's own
repositories, which are gated behind a manual approval: Chitallo downloads
without a Hugging Face token and cannot reach them.

Downloads only ever happen on an explicit action, with the licence in plain
sight. An interrupted download resumes from where it stopped and survives an app
restart; the finished file is checked before it is used against the SHA-256 of
the mirror's file, pinned in `src-tauri/src/lib.rs`.

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
