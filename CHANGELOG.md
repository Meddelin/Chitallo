# Changelog

## 0.2.0 — 2026-08-22

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
- **A knowledge graph over the whole library**, living as a second view of the
  library rather than a screen of its own. Every book contributes one shard — a
  JSON file under `<appDataDir>/graph`, named by the book's content key rather
  than by its path, so moving or renaming a file does not orphan what was
  learnt from it. The seed pass runs without any model at all and reads the
  whole book, up to a ceiling of 1 000 pages that exists only so a scanned
  five-thousand-page dictionary cannot hold the queue: 7 ms a page, which is
  about two seconds for an ordinary 300-page book and 6.1 s for the 838-page
  volume this feature was first run against. It used to read 24 pages spread
  evenly across the book, and the spread was a good argument for a bad sample —
  24 pages of that book is 2.9% of the text, and the graph it produced held
  SEVEN concepts, next to the 118 terms this repo's own glossary miner had
  already found in the same file. The same book now yields 118 concepts, each
  carrying the pages it was met on: the miner keeps its top 120, and 114 of
  those 118 glossary terms fall inside that 120 — so a book the reader has
  never translated gets the graph a translated one gets. If the reader HAS
  translated it, the glossary already sitting on disk is merged in for nothing:
  one 6 KB read of a pass another feature has already paid for and a human has
  already curated. On that book the two lists together came to 124 concepts,
  under a ceiling of 180 a single book may contribute — the ceiling bounds the
  deep pass, which is the one that costs minutes. The seed is written before
  the deep pass starts, so a book is in the graph — searchable, drawable,
  joined to its neighbours by the concepts they share — from the first write,
  and a build cancelled halfway leaves a partial graph rather than none.
  - **Singular and plural are one concept.** A concept's id folds the plural off
    its head word, so «IR systems» and «IR system» — which on that book were two
    nodes out of nine, counted 6 and 4 — are one node with one page list. A
    split concept is not merely untidy: each half carries half the frequency, so
    both halves can fall under the mining floor and vanish. The same book's
    118-term glossary yields 118 distinct ids before the fold and 111 after,
    seven merges, every one of them genuine. Cyrillic is deliberately left
    alone, because Russian fuses number with case: every ending-strip is also a
    case-strip, and case-strips collide at a rate English never approaches
    («полка» onto «полк», «банка» onto «банк»). A Russian library therefore
    keeps both forms until this app ships a lemma dictionary.
  - **A licensed book never leaves the machine.** The classifier weighs the
    front matter, the last page, the document metadata and the length, and
    answers «Лицензионная книга», «Открытая статья» or «Происхождение неясно» —
    and «unclear» is treated exactly as «book». Only an open article may be
    deepened through Claude Code, and only while «Разбирать открытые статьи
    через Claude Code» is ticked in Settings — that switch is off out of the
    box, so until the reader asks for it every book is read by the local aux
    model or not at all. The reader can overrule the verdict by hand on the
    node card, and that choice is what every later build honours.
  - **Six kinds of node, and the shape of the label decides which.** A 4B model
    cannot hold a closed six-way vocabulary steady — handed a technical book's
    term list it shelved «recommender systems», «search engine» and «large
    language models» as works, fifteen spurious `work` nodes out of 117, with
    the one-line glosses right every time. So the instruction now states the
    base rate, says plainly that the other four kinds are for NAMES, and hands
    over a test that can be applied to the label alone: could this be written in
    lower case in the middle of a sentence? That wording by itself takes the
    book's proper-noun nodes from 29 to 12, and a guard re-applies the same test
    to whatever comes back — a mined label can no longer be a `work` at all, and
    person, org and place survive only on a name-shaped label.
  - **The extractor carries a generation, so an upgraded extractor re-reads the
    library by itself.** Today's rewrite is generation 2, and the library's
    catch-up scan queues every book whose shard is older than that — otherwise a
    reader who switched the graph on yesterday would keep nine nodes for an
    838-page book for ever, or until they stumbled on «Перестроить весь граф» in
    Settings. It is not the schema version, which answers a different question —
    whether the file can be parsed at all — and whose bump would make every
    shard unreadable and blank the graph until each book had been read again. A
    stale shard is read, drawn, searched and used by «Спросить» exactly like any
    other, right up to the moment the new read finishes and writes over it, so
    the picture never empties for a second; a shard with no generation field at
    all predates the field and counts as generation 1. A provenance verdict the
    reader set by hand survives the re-read, because re-seeding a book must not
    argue back with them.
  - The canvas draws at most **700 concept nodes**, heaviest first. The cap is
    what keeps one force-layout tick inside a frame on a machine with no
    discrete card; past that count the picture has long since turned to fog, so
    the surplus is not drawn badly — it is not drawn. The frame loop stops
    itself the moment the layout settles, and again whenever the panel scrolls
    off screen or the window goes to the background.
  - «Спросить» now looks at the library before it looks anywhere else. The
    lookup is pure memory once the session's shards have been merged — no
    model, no network, and no disk read after that first merge — so it costs
    nothing a reader can feel, and what it finds is pasted in front of the
    question under «Из вашей библиотеки»: the names of the concepts, the books
    they turn up in, and the pages. A concept that lives only in licensed books
    — none of them the book open in front of the reader — gives that list its
    name and its pages and nothing more; its description stays on the machine
    that read it. The system prompt teaches the order rather than the
    citation: library first, own knowledge second, the web only when the answer
    genuinely needs today's facts — and the web stays off entirely until the
    reader ticks the box in Settings themselves.
  - Three frozen keys and no more: «pdfer:lib:view» remembers whether the
    library opens on the card grid or on the graph, «pdfer:graph:auto» is the
    auto-build switch, and «pdfer:graph:claude» decides whether an open article
    may be read through Claude Code — that one is OFF unless the reader turns it
    on, since a settings key nobody has touched is not consent to send anything
    anywhere. Turning the auto-build switch off also stops what is already
    running, because a reader who reaches for it is asking the machine to stop
    working, not to finish the queue quietly.
- **A term store of the book's own, in a «Terms» tab.** The glossary used to be
  a step of translation — a modal opened from the translation panel, a shelf in
  the palette called «Translation», and a list whose only purpose was to be
  pasted into a prompt. It is now the book's terminology, and translation is one
  reader of it beside the knowledge graph, «Ask» and export. Translation itself
  is unchanged and ungated: an empty list, a missing term model, a book in a
  language nobody translates — none of them stop a translation run.
  - **The miner works on a book in any script, and there is one of it.** There
    were two, hand-copied from each other and drifted apart in the place it
    mattered most — the glossary's was ASCII-Latin (see Fixed, below). The
    graph's script-agnostic twin is now the only miner (`src/terms.ts`), with
    options where the fork used to be, so both callers read a book the same way
    and there is one place left to fix.
  - **Stoplists are a table keyed by the book's language, plus one the book
    derives itself.** Three hand-written lists lived in three modules and
    disagreed; they are now curated lists for English and Russian in one place,
    and for any other language a token that is short and turns up on more than
    60% of the pages actually read is taken to be a function word of that book —
    which is what lets the miner work for a language the app ships no list for.
    A word is never dropped for that reason while it is holding a multiword term
    together — though a word on more than 85% of the pages has to be holding one
    much more heavily than a word in the 60–85% band before it is spared.
  - **The book's language is a field of the record, not the interface
    language.** `src/booklang.ts` reads a script histogram and then a
    function-word vote over the pages the graph already samples — no second read
    of the book, no new dependency — and separates ru/uk, en/de/fr/es/it/pt/nl/pl
    and the seven languages a script alone names. It answers «und» rather than
    guess, the tab shows what it decided and says so quietly when the margin was
    thin, and the reader can overrule it before the book is read. This matters
    because the language decides which words count as terms at all, and because
    the reader will later choose what to translate INTO.
  - **Three passes, three buttons, and the first needs no model.** «Find the
    terms» mines the book and always writes: the terms, their pages and their
    frequencies land on disk whether or not any weights are installed, and the
    tab says plainly that the remaining fields will be filled in later rather
    than pretending otherwise. «Define the terms» asks the term model for a
    kind, a category and a one-sentence definition — twelve terms a call, the
    graph's batch size and for its reason, with a token budget sized for the
    batch — and translates only when the book is not already in the reader's
    language. «Check the terms» is the pass the store was missing:
    near-duplicates are clustered on this machine first (identical concept id,
    or Sørensen–Dice bigram overlap ≥ 0.75), the model is asked one cluster at a
    time whether they are one concept and which spelling is canonical, and
    definitions are checked in a batch against their terms. A definition that
    fails is cleared and the term survives — losing a line of prose is the
    failure a reader can live with, losing a term is not. Nothing a reader typed
    by hand is ever folded away.
  - **The file stays a hand-editable .txt and its grammar got a name.**
    `term [= translation] [:: category [:: definition]]`, one line per term,
    where the category is a free-form noun phrase in the reader's own language
    and not the graph's closed six-word vocabulary. A bare term with no
    separator at all is now a valid record rather than junk, which is what
    «Add to the glossary» writes — the old `term = ?` placeholder existed only
    because the line had to have a right-hand side, and then had to be kept out
    of prompts again at the other end. Legacy `->`, `→` and `—` separators still
    parse, so the glossary snapshot inside every existing translation store
    keeps reading. Bookkeeping the reader should never have to look at — pages,
    frequency, where a record came from, the graph's node kind, folded aliases —
    moved to a `.meta.json` sidecar beside the file, and a missing or mangled
    sidecar is «no bookkeeping yet», not an error.
  - **One parser, not three.** The grammar was spelled out separately in
    `translate.ts`, in the generator and in App's duplicate check, and the third
    of those split on `/=|->|→|—/`, which cut «std::vector» in the wrong place
    and counted «C++» and «C#» as different terms. Everything now goes through
    `src/glossary.ts`, and the merge keeps its old guarantee: every existing
    line survives byte for byte, only empty fields are filled, and the confirmed
    «Rebuild» is the single mode allowed to lose a line.
  - **The term store and the knowledge graph became one store.** Seeding a shard
    reads the book's terms and takes their kind and their definition with them,
    so a node arrives typed and explained instead of bare, and the deep pass
    skips what the reader's list has already answered — then feeds back what it
    learned, marked as having come from the graph. What reaches Claude is
    unchanged and still only what the README promises: title, authors, tags and
    term LABELS. A definition, a sample sentence and a node's gloss are named in
    the code as prose that may never join that payload.
  - The graph's extractor is generation **3**: a Russian book's shard is
    materially better on a re-read now that the miner can see it, and a term
    store that supplies kinds changes which nodes are people, works and places.
    The library's catch-up scan queues the older shards by itself, and the old
    picture stays on screen until the new read overwrites it.
  - Glossary writes are atomic — tmp plus rename, the shape the translation
    store and the graph already used. This is the file that most deserved it: a
    shard is a re-runnable derivative, a hand-curated term list is not.
  - The panel's minimum width is 412 px, because a fourth tab made the tab row
    the widest thing in it: «Оглавление · Спросить · Термины · Перевод» measures
    361 px bare and 409 px with the «Ask» count and the translation percentage
    beside it. On a window too narrow even for that the row wraps to a second
    line rather than truncating a tab or hiding the close button.
- **A style pass over the finished translation, and a draft that can see what it
  already wrote.** Whole-book translation is two stages now.
  TranslateGemma-12B-it writes the draft paragraph by paragraph, carrying the
  paragraph before it in both languages; Gemma 4 26B-A4B-it then reads the
  result back — with the original deliberately out of view — and edits the
  Russian as Russian. Stage two is a button of its own, «Edit the style», on a
  book that is already translated, and every promise the term-store entry above
  makes still holds word for word: translation is unchanged and ungated, an
  empty term list and a missing editing model stop nothing, and the draft alone
  produces a whole translated book. What the second stage adds is the class of
  defect the first cannot see: the draft is written a paragraph at a time and
  never re-read. From the 838-page book this repo tests against:
  «большого语言 моделя» for *large language models*, «значительным
  предвзятостям» for *selection biases*, «SPARQL-мотор» where the settled word
  is «движок», «иногда однажды они хотят смотреть комедии», and ё and е spelled
  differently in adjacent paragraphs.
  - **The draft prompt carries the paragraph before it, in both languages.**
    The previous SOURCE paragraph and the target text already produced for this
    book now stand ahead of the paragraph being translated. Without them the
    model re-decides, every paragraph, things that were settled two paragraphs
    ago: what a pronoun points back at, which tense the passage is in, and
    whether the reader is addressed as ты or вы — which on the test book
    changes inside a single chapter. The window is indexed off the page's
    reading order, never off the post-`carryOver` wire list, because the wire
    list holds whatever still needed translating and «the previous paragraph»
    there means something else entirely.
  - **Contiguous runs, chained inside each run, and never more of them than the
    page can chain.** A shared cursor would hand every worker a neighbour it had
    not translated itself. Each worker now takes a contiguous slice of the
    page's prose and walks it in order, so the trailing context is the true
    predecessor everywhere except the head of a slice, which falls back to the
    last translation of the previous page. The slice count is
    `min(pool, ceil(paragraphs / 3))` against a pool of seven: a dense page
    fills the server's slots, and a six-paragraph page deliberately runs two
    requests where it had room for six. That is the trade, stated rather than
    hidden — `llama-batched-bench` on this card puts eight concurrent sequences
    at 5.40× the throughput of one and sixteen at 9.11×, so the batching a short
    page gives up is real. It is given up because the batching comes back on the
    next page and the context does not come back at all.
  - **The editor is not shown the original, and that is the point.** Handed both
    texts a 26B model re-translates; handed the Russian alone it does what it
    was asked, which is to make the Russian right as Russian. Its inputs are the
    draft, the book's LIVE term file — re-read from disk when the pass starts,
    not the snapshot frozen into the translation store when the draft ran, which
    on an 838-page book can be hundreds of pages stale — and a style guide
    shipped as a constant per target language. That last one is a constant and
    not a per-book file because it is about Russian grammar and register, which
    do not vary by book, while the half that does vary already has a file, a
    grammar and a merge that never loses a line.
  - **The unreadable characters were the model, not the PDF.** Ten of the 2961
    translated paragraphs in the test store break into Chinese mid-sentence —
    «использует модель большого语言 моделя», «отсутствие任何 смысла», «Банксом и
    его коллегами [1999]， а также» with a fullwidth comma. The extraction is
    clean and was measured to be: across all 9603 source paragraphs of that book
    there are 0 replacement characters, 0 private-use glyphs, 0 unexpanded
    ligatures and 0 control characters. So this is repaired where it was
    introduced — the style guide orders CJK and fullwidth punctuation repaired,
    and every guardrail below was checked against that repair rather than left
    to trip over it.
  - **Eight guardrails, because a 26B model asked to improve prose will rewrite
    it.** empty, echo, length, alphabet, drift, terms, digits, latin — and a
    failure of any of them keeps the draft. The one doing the real work is
    drift: Sørensen–Dice over normalised words between draft and edit, floored
    at 0.80 above 120 characters and 0.60 below. Measured, case-and-agreement
    fixes score 0.905, 0.951 and 0.875 and pass; the same paragraph paraphrased
    at the same length scores 0.606 and replaced by its own one-sentence summary
    0.535, and both are refused. The short floor exists because a genuine repair
    of a Chinese-infected sentence scores 0.627 and a ты→вы fix 0.723 — a single
    0.80 floor threw away both. Terms are checked by the same similarity at 0.75
    over word windows rather than by literal match, because the guide tells the
    editor to inflect them: «инвертированный индекс» → «инвертированному
    индексу» measures 0.818 and is accepted, «движок» → «мотор» measures 0.000
    and is not. Nothing in the pass ever writes an empty string — for an
    already-translated paragraph that would mean deleting a good translation,
    and export would fall back to an image crop of the original page.
  - **ё and е are decided once for the whole book, not once per paragraph.** The
    opening of this entry names them among the defects stage two repairs, and a
    26B model asked to normalise them paragraph by paragraph would produce
    exactly the defect being repaired: the complaint is not a wrong spelling, it
    is two spellings. So it is not prompted, it is applied — `applyYoPolicy` in
    `styleguide.ts`, pure and idempotent, folds ё to е everywhere except six
    words where ё is the only thing separating two different Russian words:
    всё/все, всём/всем, and the -знавать present tense, where узнаём (узнавать)
    collides with узнаем (узнать), and the same for признавать, сознавать and
    осознавать. It runs on the paragraph that is about to be stored, after the
    guardrails have ruled — on a refused edit as well as on an accepted one,
    since a book half-folded is the same inconsistency in a smaller font — and
    it does nothing at all for a book being translated into English. A fold that
    actually changed a spelling is recorded like any other edit, so «Restore the
    draft translation» gives the reader their ё back.
  - **The edit is additive and reversible.** The draft is kept in a new optional
    field beside the edited text, so «Restore the draft translation» is exact,
    a second run edits the draft rather than the edit, and «Update the
    translation» seeds the next draft from draft text instead of from prose the
    editor has already reflowed. The store stays version 2 —
    `loadBookTranslation` returns null for any other number, and the reader's
    838-page book would read as «not translated» after a downgrade. The pass
    owns a third watermark of its own and touches neither of the two that exist.
  - **The book's terms are named by a model that has read the book.** «Read the
    book» is a new pass, and it runs before the model is asked for anything
    else: about 61 pages of the 838 — five from the front and sixteen spread
    through the rest for a profile of what the book is and what it argues, then
    forty more from which the model names the terms it actually saw. The
    previous pipeline selected them by raw frequency and then asked for
    definitions with no frame to write them in, which is how the second test
    book's list came to hold `dark of the moon = период между полуночью и
    рассветом` — a sample search query used as a running example, 56
    occurrences — beside `star wars`, `cat in the hat`, `False = False`,
    `SELECT`, `SDBN :: сокращение от специфического алгоритма или структуры
    данных`, `CLIR :: концептуальный поиск` where it is Cross-Language
    Information Retrieval, and `Information Retrieval = Информационное
    извлечение` where the settled Russian term is «информационный поиск».
    Frequency cannot tell a term from a running example, and a model handed
    nothing but a bag of frequent strings cannot either.
  - **The C-value miner is demoted, not removed.** It still runs first, it still
    writes, and it still needs no model at all — a machine with no editing model
    installed gets the terms, their pages and their frequencies exactly as
    before, which is a stated property of this design and not an accident. What
    changed is the ranking: the model's proposals are kept in full up to 80 and
    the miner fills the remainder, and a proposal the miner cannot count keeps
    its place. Frequency 0 means «unverified», never «rejected» — the miner
    answers 0 for any phrase over four tokens or straddling a clause boundary,
    which is exactly the shape of the good multiword term a model names.
  - **TranslateGemma is driven through `/completion` with a prompt this app
    formats itself.** Its chat template reads `source_lang_code` and
    `target_lang_code` off the first content part of the message, and
    llama.cpp's OAI bridge (`common_chat_msgs_to_json_oaicompat`) keeps only
    `{type, text}` and discards the rest — ggml-org/llama.cpp#19295, open. Sent
    through `/v1/chat/completions` the template therefore renders «English
    (en-GB) to English (en-GB)» or raises `UndefinedError`. So the frontend
    writes the Gemma turn markers out by hand, never emits `<bos>` (llama-server
    tokenizes `/completion` with `add_special=true`), and reads the SSE shape
    `/completion` actually emits. The alternative — shipping a corrected jinja
    and spawning the server with `--chat-template-file` — was rejected because
    it would put a file belonging to a third party's model into this installer,
    and «Chitallo ships nothing but Chitallo» in README.md is meant literally.
    That paragraph is unchanged by this release, and staying able to leave it
    unchanged is one of the reasons this route was chosen.
  - **One model on the card at a time, and eight slots instead of three.** The
    two servers used to be designed to co-exist, which is why the style-and-terms
    model was spawned with `--cpu-moe` and its 22.8 B of expert weights parked in
    system RAM. Co-residency bought nothing: the style edit reads what the draft
    wrote, so the two stages could never have run together. Starting either
    server now stops the other one's child — never a `llama-server` the reader
    started themselves, and the intermediate state is reported as its own status,
    `swapping`, so the UI says «handing the GPU over» rather than «dead» — and
    the layer budget is measured against the card with the other model already
    gone. On 16 GB that is the whole difference for the editor: all thirty expert
    layers fit, `--cpu-moe` is not passed, and `-ncmoe N` survives only for the
    card that genuinely cannot hold them. Both spawns also gained `--parallel`
    and `-fa on`: eight slots and `-c 24576` for the draft, four and `-c 16384`
    for the editor, `-c` being the whole arena that all slots share. Neither gets
    `--swa-full`, and that is a decision — both models attend through a
    1024-token window and llama.cpp's default already sizes the local layers by
    it. The model that cannot fall back is the editor: its experts need somewhere
    to go on a small card, so below about 20 GB of system RAM the spawn is
    refused outright, with its own status, rather than left to thrash.
  - **What it costs, since it is the largest thing this release changes.** The
    test book's store holds 1.67 million characters of Russian across 2961 of
    the book's 9603 paragraphs, so the whole book is about 5.4 million — call it
    2.7 million tokens of output per stage at the two-characters-a-token figure
    this repo already budgets with (`styleBudget`, which errs long).
    `llama-batched-bench` on this card gives 769.35 tokens a second across eight
    concurrent sequences for a 7B Q4; decode is weight-bandwidth-bound, so the
    12B draft — 7.3 GB of weights against 4.6 — runs near 0.63 of that, about
    490 a second in aggregate. An hour and a half of decode, plus prefill that no
    prefix cache can absorb, since the source, the previous source and the
    trailing target all change every paragraph: call the draft two hours. The
    style pass then traverses the same text again on the 26B MoE, which with the
    draft server stopped holds its experts on the card — 782 MB of expert traffic
    per generated token implies about 175 a second on one stream, so four and a
    quarter hours is a ceiling and the pass runs two streams under it. Six hours
    or so for the 838-page book, and about three quarters of an hour per hundred
    pages for both stages together.
  - **The throughput this was designed against was wrong, and it is measured
    now.** The paragraph above used to say fifty hours, and it rested on «about
    5 tokens a second per slot» for a 7B Q4 on this card. The same model on the
    same card measures **142.57** on a single sequence and **769.35** across
    eight — the figure was low by a factor near thirty on its own, and the app
    compounded it by holding three requests in flight against llama-server's
    default four slots while passing no `--parallel` at all. The backend was not
    the cause and this entry will not imply that it was: the CUDA build measures
    147.64 tokens a second against the Vulkan build's 138.33 on the same weights,
    which is 7%, and Vulkan was already reporting `NV_coopmat2` — it was on the
    tensor cores all along. What is still true is that these are arithmetic over
    measured throughput and the store's own character counts rather than a
    stopwatch over a whole book, which is why the panel prints an ETA the moment
    the first page finishes, before the second one starts, and why the style edit
    is a separate button a reader chooses rather than a second half of «Translate
    the book» that they discover afterwards.

### Changed

- **Both models were replaced, and the licence with them.** Book translation
  moves from HY-MT1.5-7B (Tencent, 4.6 GB) to TranslateGemma-12B-it (Google,
  7.3 GB) — a model trained for translation across 55 languages, prompted in
  English rather than through the Chinese-worded templates its predecessor
  wanted, which is where the Chinese in the output was coming from. The term
  model moves from Qwen3.5-4B (Alibaba, 2.7 GB) to Gemma 4 26B-A4B-it
  (14.2 GB), which is also the style editor and the model behind the knowledge
  graph: one file of weights on one port serving all three, rather than a third
  server. A machine that wants everything therefore downloads 21.5 GB where it
  used to download 7.3 GB, and the licence covering both is now the Gemma Terms
  of Use rather than the Hunyuan Community License plus Apache-2.0. That drops
  the carve-out the Hunyuan licence carried — its grant did not reach the EU,
  the UK or South Korea — and puts a prohibited-use policy and a notice
  requirement in its place; both READMEs, RELEASING.md and the in-app About
  screen say so.
  - **First run still asks for 7.3 GB, not 21.5.** The draft model alone
    produces a translated book, which is the promise the setup screen makes, so
    the wizard asks for that one and says in its quiet line that the editing and
    terms model is a further 14.2 GB offered later. Settings → Models lists both
    rows and their total.
  - **The old weights are offered for deletion and never deleted.** After the
    swap nothing names `HY-MT1.5-7B-Q4_K_M.gguf` or `Qwen3.5-4B-Q4_K_M.gguf`
    again, so 7.4 GB would sit unreachable in roaming app data while the reader
    is asked for 21.5 GB more against a free-space check with a 300 MiB margin.
    Settings grows a row that names them and offers the delete behind the same
    two-click confirmation every other destructive row uses, and the offer also
    appears inline when a download fails for want of space. Nothing is removed
    for the reader: those bytes cost hours of bandwidth, and a build rolled back
    would want them again.
  - **Both weights now come from community re-uploads on Hugging Face** rather
    than from the publisher, whose repositories are gated behind manual approval
    that a tokenless download cannot pass. The URL, the byte size and the
    SHA-256 are pinned in `src-tauri/src/lib.rs`, and re-verifying them against
    the mirror is now a step in RELEASING.md — a mirror can re-upload under the
    same path, and the first sign would otherwise be a hash failure on every
    fresh install.

### Fixed

- **Both READMEs prescribed the Vulkan build to NVIDIA owners.** `winget install
  llama.cpp` is the one command they gave for Windows, and the winget manifest
  for `ggml.llamacpp` points its `InstallerUrl` at
  `llama-b<NNNNN>-bin-win-vulkan-x64.zip`. That is a defensible default for an
  AMD or an Intel GPU and the wrong build for an NVIDIA card. The install
  section is now a prescription per GPU vendor rather than per platform — still
  one command with no fallbacks, but the command depends on the card — and the
  NVIDIA path is written out: the `cpu-x64` archive for the executables, the
  `cuda-13.3-x64` one for `ggml-cuda.dll`, and `cudart-llama-bin-win-cuda-13.3-x64`
  for the runtime, all three from a single release tag, unpacked into
  `<app data>/llama`, with any `ggml-vulkan.dll` left over from an earlier
  install deleted so the same card is not offered twice. The 12.4 assets are
  called out as the trap they are: they predate compute capability 12.0, so a
  50-series card loads the model, starts generating and dies with `no kernel
  image is available for execution on the device`. The search order in that
  section was wrong too — `<app data>/llama` is searched first and the PATH
  last, which is exactly what makes the hand-unpacked CUDA build win over
  whatever winget left behind.
- **A Russian book got a glossary that looked right and was made of the Latin
  islands inside it.** The glossary miner's tokenizer was
  `(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*` — ASCII-Latin in the class and in the
  lookbehind both — so on a Russian book it matched none of the book. It counted
  the BERTs, the HTTPs and the transliterated surnames, ranked them by the same
  C-value machinery it uses on English, capped them at 120 and returned them as
  that book's terms. Nothing about the run looked like a failure: no error, no
  empty list, no zero count, and a term list a reader could believe. That is why
  it survived a release. The tell was two lines below it in the same file — the
  sentence splitter's `[A-ZА-ЯЁ0-9«"“([]` already knew about Cyrillic, so the
  miner was splitting Russian sentences correctly and then reading each one as
  if it were blank. The graph's copy of that miner carried none of the defect:
  `\p{L}` for a tokenizer, a capital test that handles Cyrillic, and a comment
  calling the glossary's English-only word lists «wrong here» — one half of the
  twin's problem diagnosed in writing while the other half went unseen on the
  far side of the copy. The blast radius reached past the glossary, because the
  graph's seed merges the term file in: every Latin island also entered that
  book's shard as a concept node wired to the book, and those nodes do not leave
  by themselves — which is one of the reasons the extractor's generation was
  bumped above.
  - **The fold that is still monolingual, now that the miner is not.** A Russian
    book reaching the graph as Russian makes the limitation stated above visible
    rather than theoretical: graphstore's plural fold (`graphstore.ts:191`, rule
    C1) is Latin-only by design, so a Russian library keeps «нейронная сеть» and
    «нейронные сети» as two nodes, bridged only by the shares-edge similarity,
    until this app ships a lemma dictionary. The term store's own near-duplicate
    fold does not close that gap either — it is character-bigram overlap, and
    that pair measures 0.69 against a threshold of 0.75, while «инвертированный
    индекс» / «инвертированные индексы» measures 0.88 and is clustered. What the
    fold catches in Russian is the long term, not the short one.
- **Model input was being rewritten for macOS.** `t()` runs the Mac key-glyph
  substitution over every value interpolated into a string, and the glossary
  pushed the mined term, its sample sentence and the book's domain list through
  `t()` to build its prompts. On a Mac a term or a context sentence containing
  "Ctrl+" or "Alt" therefore reached the model as ⌘/⌥ — invisibly, and with no
  care at the call site able to prevent it. Prompts now live in a module-local
  table beside the code that sends them, in both languages, as the graph's have
  always done.
- **A batched answer that ran out of tokens looked like a refusal.** The aux
  helper defaults to 512 tokens and turns an unclosed `<think>` block into an
  empty string, so a truncated multi-field reply was indistinguishable from a
  model that would not answer. Every batched call now passes a budget sized for
  its batch.
- **The translated page claimed to be Russian whatever it was.** The reflowed
  page hard-coded `lang="ru"`, which is what CSS hyphenation reads: with the
  interface in English, English text was being hyphenated by Russian rules. It
  now carries the language the book was actually translated into.
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
