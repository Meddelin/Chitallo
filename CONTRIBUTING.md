# Contributing

Thanks for looking. Chitallo is a small app with strong opinions; the notes below
are the ones that save the most time.

## Getting set up

Requires Node.js 20+, Rust (stable), and the platform toolchain: MSVC build
tools on Windows, Xcode command line tools on macOS.

```sh
npm install
npm run tauri dev
```

The app looks for `llama-server` on your PATH. Nothing else about the
translation stack has to be installed to build, run and work on the reader —
the surfaces that need the model say so and stay usable.

Before opening a pull request:

```sh
npm run typecheck
npm run build
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

CI runs exactly this, plus `cargo clippy` on macOS — which is the only thing
that compiles the AppKit half of `src-tauri/src/print.rs`. If you touch that
file from Windows, expect CI to be your compiler.

There is no `cargo fmt` gate. The Rust here is laid out by hand and rustfmt
would rewrite most of it; match the surrounding style instead.

## House rules

**Nothing is bundled.** No model weights, no inference engine, no runtime. Every
feature that needs an external program names exactly one way to install it, per
platform, in `src/host.ts`, and fails honestly when it is missing. No pluggable
providers, no silent fallbacks to a system alternative — "either you install it,
or the feature says it does not work" is the whole contract.

**Every user-visible string lives in `src/i18n.ts`,** in both Russian and
English. Keys are typed, so a missing one is a compile error. Shortcut names are
written the Windows/Linux way (`Ctrl+F`, `Alt+click`) and rewritten to ⌘/⌥ on
macOS inside `t()` — never spell both.

**A model prompt is not a user-visible string.** What is sent to a model lives
in a module-local table beside the code that sends it — `graphgen.ts` and
`glossarygen.ts` both keep one, in Russian and English as the catalogue does —
and not in `i18n.ts`. Two reasons, and the second was a live bug: a prompt that
drifts because somebody reworded a UI line is a defect nobody sees until the
answers come back malformed, and `t()` rewrites `Ctrl`/`Alt` to ⌘/⌥ and splits
on `|` across everything it interpolates, so a term or a sample sentence passed
through it reaches the model altered. «Ask»'s own prompts are the exception, and
the comment beside them in `i18n.ts` says why.

**Paths go through `src/host.ts`.** `joinPath()` and `baseName()`, never a
hand-built `` `${dir}\\${name}` ``. That was a Windows-only assumption and it is
gone.

**Comments explain why, not what.** The existing ones carry measurements and
the reasoning behind non-obvious choices; a comment that just restates the line
below it is noise. If you find a comment that is now wrong, fixing it is a
welcome change on its own.

## Where things are

| Path | What lives there |
| --- | --- |
| `src/App.tsx` | the reading surface, toolbar, keyboard, context menu |
| `src/booktranslate.ts` | whole-book translation runs, the per-book store |
| `src/terms.ts`, `src/glossary.ts`, `src/glossarygen.ts` | the terminology layer: the one term miner, the record and its file grammar, the three passes over it |
| `src/booklang.ts`, `src/textsim.ts` | the book's language, and the one string-similarity coefficient both the outline and the term folding use |
| `src/graphgen.ts`, `src/graphstore.ts`, `src/graphrun.ts` | the knowledge layer: per-book shards, the library-wide merge, the build queue |
| `src/paragraphs.ts`, `src/crops.ts` | page structure and the figure/table crops |
| `src/export.ts` | PDF / HTML / TXT assembly |
| `src/i18n.ts` | every user-visible string, both languages |
| `src/host.ts` | platform facts and the install commands |
| `src/Onboarding.tsx`, `src/Depends.tsx` | first-run setup and the dependency UI |
| `src-tauri/src/lib.rs` | llama-server supervision, weight downloads, the Claude CLI |
| `src-tauri/src/platform.rs` | binary discovery, free disk space |
| `src-tauri/src/print.rs` | silent HTML→PDF (WebView2 / NSPrintOperation) |

## Reporting a bug

Include the platform and version, what you expected, and what happened. If the
translation stack is involved, `llama-server --version` and whether the app
found it (Settings → Engine) narrow most of it down immediately.
