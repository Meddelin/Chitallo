# Changelog

## Unreleased

### Added

- **Formulas in «Ask» answers.** Claude writes maths in LaTeX and the panel sets
  it with KaTeX — `$inline$` and `$$display$$`, the stylesheet and fonts
  vendored so a reader with no network still gets them. A line that is nothing
  but `$$…$$` is opened out into a proper display block, since that is how
  models actually write a centred formula.
- **Charts in «Ask» answers.** Claude draws a chart by writing a ```chart fence
  holding a small JSON spec (`type` line/area/bar/pie, `x`, `series`, `data`,
  plus optional title, unit, note, stacked, curve); the panel renders it through
  shadcn's chart primitives on Recharts, in place, as the answer streams. The
  system prompt carries the schema and the rules — numbers from the book only,
  one measure per chart, at most five series.
  - A five-slot categorical ramp (`--chart-1..5`) stepped separately for paper
    and ink; every adjacent pair clears the colour-vision gate on both of the
    panel's surfaces. A sixth series does not get an invented hue: cartesian
    charts say how many did not fit, pie folds its tail into one neutral slice.
  - Every chart has a **table view** one click away with the same numbers, so a
    value is never carried by hue alone.
  - A spec that will not parse shows what Claude actually wrote, rather than an
    empty box.
- **Diagrams in «Ask» answers.** A ```mermaid fence, rendered by MermaidBlock in
  the same card a chart gets. Three types only — `flowchart TD`,
  `stateDiagram-v2`, `sequenceDiagram` — because nothing else stays legible in a
  320 px column, and because a mindmap is the most tempting wrong answer to
  "what is X", where a nested list is better. Mermaid is loaded lazily: the main
  bundle grows by 11 kB, and the 658 kB engine is fetched the first time a
  diagram is actually shown.
  - The palette is the app's own paper-and-ink, in two selected sets rather than
    one flipped: mermaid bakes its colours into the SVG, so a diagram is
    re-rendered on the theme switch through a subscription to the `dark` class.
  - `securityLevel: "strict"` and an explicit `secure` list: the diagram source
    is model output, so mermaid's own sanitiser stays on, `click` directives are
    refused, and an `init` header inside the source cannot repaint the diagram.
    `htmlLabels: false` keeps every label a plain SVG `<text>`.
- **A rubric for choosing the shape of an answer**, replacing the two syntax
  notes the system prompt used to carry. It leads with the default — prose,
  nine times in ten — and one rule: draw only what you cannot say out loud.
  Then thresholds that make it checkable: five numbers before a chart, four to
  seven nodes before a diagram, one picture per answer and never instead of the
  prose, and never a number the book does not contain.
- **«Показать наглядно»** among the «Ask» quick commands (`/`), replacing
  «Показать графиком»: it asks for the fitting shape — chart, diagram or table —
  and explicitly licenses "none of them", so it cannot be read as an order to
  draw something.
- **A dev-time guard on the string catalogue.** `t()` splits any value on `|`
  into plural forms, so a pipe typed into ordinary prose silently truncates that
  string — which for a multi-paragraph system prompt would be invisible. An
  entry with a pipe and no `{n}` now throws at import time in dev.

### Fixed

- A chart whose spec was still streaming showed "could not be read" on every
  token instead of a quiet placeholder. Streamdown's `isIncomplete` cannot carry
  that signal — `parseIncompleteMarkdown` closes an unterminated fence before the
  renderer sees it, so the flag is false for the whole stream — so both figure
  blocks now treat a failure as an error only once the text has stopped arriving.
- **Fifteen page-parsing defects that shredded the translation.** The reader was
  showing fragments — half-sentences, capitalised mid-phrase, invented endings —
  and none of it came from the model: HY-MT never returned an empty translation
  and never hit the context limit. Over the 838-page test book the defects left
  12.0% of translated paragraphs as non-sentences; that is now 0.85%.
  - `medianLineH` took the median fragment height over the WHOLE page, including
    the 7–8pt labels inside diagrams. `growParagraph` merges lines only while
    their gap stays under 1.6× lineH, and a body set at 9.96pt with 13.9pt
    leading needs lineH ≥ 8.69 — 13% of headroom. On thirteen pages the labels
    outvoted the body and every body line became its own one-line "paragraph",
    each translated standalone; a line ending «quality fac-» came back as
    «Торсы». The median is now weighted by fragment width: lineH moves on 19 of
    820 pages, always up and always to the true body height, and furniture
    detection over the whole book is bit-identical.
  - The merge gap scales with the lines' own type size, so a chapter title set
    at 29pt is no longer split in half.
  - `itemWords` builds the rect from the transform's advance and ascent vectors
    instead of assuming +x/−y, so 90° text stops being modelled as a short wide
    box. A page that is mostly rotated — a landscape table — renders as the
    original, since it has no reflowable measure at all.
  - The back-of-book index and the contents join the bibliography as pages shown
    untranslated. Both gates key on measured binding density: index pages run
    15.9–41.6 «term, page» bindings per 1000 characters against 1.7 for the
    densest other page in the book, contents 23.7–34.0 against 13.7.
  - A welded table row no longer counts as body prose when bounding figure
    material — the bound is the page's own measure, which a row never sits on.
    Tables that used to leak their cells into the flow are cropped whole.
  - `detectCellGrid` claims grids with no caption to hang a region on — SPARQL
    result tables, piecewise braces, appendix formula tables — by row, by
    column, by adjacency to display math, and by isolated notation.
  - Query and code listings, catalogue identifier blocks (ISBN/ISSN/DOI) and
    brace-piece maths classify as figure material rather than prose.
  - The caption envelope is clamped below running headers: 55 pages had an
    English running head and a foreign page number baked into a figure crop.
  - The figure-containment invariant is two-sided, so a paragraph that stays in
    the flow can no longer also be sliced into the crop above it.
  - Footnote markers glued to «(ACRONYM)» or to a closing quote stop flowing
    into the body as bare digits.
  - `stitchModel` retries its column measure instead of silently leaving a page
    out of cross-page stitching, and a full-page figure no longer blocks a
    stitch across it.
  - The furniture vote pool is warmed over the first 32 pages of a fresh run, so
    translating a book from scratch is no longer strictly worse than updating it.
- **A glossary term that rewrote 48% of the book's prompts.** The generator
  mined the author surname «Li» as a term, and `matched()` tested for a raw
  substring — «li» inside *applications*, *quality*, *online*, *click* — so
  `Li 翻译成 инвертированные списки` was prepended to 1989 of 4129 prompts as an
  authoritative instruction, and the model wrote it over «BOW encodings»,
  «embeddings» and a variable name. Terms now match on word boundaries, which
  leaves 37, and the generator no longer accepts two-letter surnames at all.

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
