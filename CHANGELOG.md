# Changelog

## 0.1.0 — 2026-08-20

First public release, and the first under the name **Chitallo** — the project was
called `pdfer` while it was a private experiment.

The rename is skin-deep on purpose. The Tauri identifier stays `com.stas.pdfer`
and the `pdfer:` localStorage prefix stays as it is, because Tauri derives the
app-data directory from the identifier: changing either would orphan every
downloaded model, saved translation, glossary and reading position on an
existing install. A handful of internal runtime identifiers keep the old name
for the same reason — they are invisible, and each is a literal matched across
two files where a one-sided rename would break silently.

### Added

- **macOS support.** Binary discovery, disk-space checks and paths are
  platform-neutral; PDF export runs through `NSPrintOperation` over WKWebView
  there, the way it runs through WebView2's `PrintToPdf` on Windows. Shortcut
  hints render as ⌘/⌥ on macOS. Bundles: `.dmg` for Apple silicon and Intel
  alongside the Windows NSIS installer.
- **English interface.** Every user-visible string now lives in `src/i18n.ts`
  in both Russian and English, with plural forms and locale-aware number
  formatting. The chosen language is also the language books are translated
  **into**, and it can be changed at any time in Settings.
- **First-run setup.** A four-step wizard: language, translation engine
  (detect llama.cpp, print the one install command for this platform, re-check
  on demand), model weights, and Claude Code for the optional «Ask» sidebar.
  Every step is skippable, and Settings can re-open the wizard.
- **Honest engine state.** A new `noengine` status distinguishes "llama.cpp is
  not installed" from "the weights are not downloaded" — two different problems
  with two different fixes, which every model surface now keeps apart.
- **Dependency status in Settings** for llama.cpp and Claude Code, with the
  resolved path and version.
- A merged `src-tauri/Info.plist` carrying a narrow App Transport Security
  exception for the loopback address, so the macOS webview may reach the
  llama-server this app started on 127.0.0.1.

### Changed

- **Nothing is bundled any more.** The installer no longer carries
  `llama-server` and its runtime libraries; the app finds a llama.cpp you
  installed yourself (PATH, `~/.local/bin`, Homebrew, WinGet, or
  `<app data>/llama`), and `CHITALLO_LLAMA_SERVER` overrides the search. This
  drops tens of megabytes from the installer and puts engine updates back in
  your hands.
- The llama-server startup order now probes the port first: an instance you
  started yourself makes both local prerequisites irrelevant, and the app must
  not claim a missing engine while a perfectly good server answers.
- Wording that used to hard-code "EN→RU" now names the reader's language.
- PDF export is hidden, rather than failing, on platforms with no silent print
  pipeline.
- GPU offload is decided per platform. `--list-devices` is still parsed where a
  machine may hold several GPUs and picking the wrong one costs dearly; macOS
  has exactly one, so it asks for full offload without naming a device rather
  than parsing a device id for a choice with no alternatives.

### Fixed

- Every filesystem path in the frontend went through hard-coded backslashes.
  They now go through one `joinPath()`/`baseName()` pair that respects the
  platform separator.
- The Rust side no longer composes user-facing sentences: a failed «Ask» run
  returns the raw process detail and the frontend words it, in the interface
  language.
- Copying went straight through `navigator.clipboard`, which needs a secure
  context — something the macOS `tauri://` scheme is not. Two of the four call
  sites would have thrown there and two would have failed silently. All four now
  go through one helper that falls back to `execCommand`, restores the reader's
  own selection afterwards, and reports honestly when nothing was copied.
