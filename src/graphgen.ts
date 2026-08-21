// Knowledge-graph extraction for one PDF: the instant seed pass and the slow
// deep pass. graphstore.ts owns the shards; this module owns what goes in one.
//
// The split into two passes is the whole design, and it exists because of a
// single UX fact: a library that only shows a book once a model has read it
// shows nothing at all for the first quarter of an hour. So seedShard is
// deterministic, model-free and finishes in seconds — metadata, a provenance
// verdict, a title, the authors, and a statistically mined concept list. The
// book therefore appears in the graph the moment the library notices it, wired
// to its authors and its subject matter, and the deep pass only ever improves
// what is already on screen. Neither function persists anything: the caller
// writes the seed shard before starting the deep pass, or the book stays
// invisible for as long as the model runs.
//
// The mining is not here any more: it is terms.ts, and this module is one of
// its two callers. It used to be a hand-copied twin of glossarygen's C-value
// extractor — the same clause-bounded n-grams, the same nested-occurrence
// discounting, the same acronym and capitalised-unigram rules, with per-page
// bookkeeping added — and two hand-copied twins drift. They had already
// drifted in the way that matters most, so the good one (this one) was the one
// that survived the merge; what changed for this caller is that the miner is
// now told which LANGUAGE it is reading, and picks its stoplists accordingly
// instead of applying one merged English+Russian set to every book on earth.
//
// It used to read two dozen pages, and that was the single biggest defect this
// feature had: on an 838-page book those pages are 2.9% of the text, and the
// graph it produced held SEVEN concepts. It now reads the book (see
// MINE_PAGES_MAX for the measurement that sets the ceiling), and it merges in
// the reader's own term store for the book — the file the glossary feature
// mines, translates and lets them edit by hand. That store is a record and not
// a word list: a term arrives with a KIND and a DEFINITION, so a node the seed
// pass could only leave as a bare «term» is typed and glossed before any model
// has run, and the deep pass skips what is already known. What the deep pass
// learns goes back the other way, stamped source «graph», which is what makes
// the terminology and the graph one store rather than two.
//
// The deep pass routes on provenance, and the routing is the feature: a
// licensed book (and anything the classifier could not decide — see below) is
// read ONLY by the local aux model on this machine, while an openly licensed
// article may be handed to Claude Code. Neither model reads the book: both are
// shown the title, the authors, the tags and the mined term list, and both
// answer with one line per term. That is what keeps a whole library's build
// affordable, and it is also what keeps the local path honest — a 4B model can
// type a term it is shown, and cannot summarise a book it is not.
//
// The two payloads are NOT the same, and the difference is a promise this
// project has published (README.md:60, i18n «gr.claudeHint»): the local model
// is additionally shown the book's opening pages, because that text never
// leaves this machine, and the Claude payload is the four fields above and
// nothing else. Every piece of book-derived prose this module now handles — a
// mined sample sentence, a glossary definition, a node's gloss — is on the
// wrong side of that line and must stay off it. See deepenViaClaude, which is
// where the boundary is actually drawn.
//
// Two rules are load-bearing and easy to "fix" by accident. First, the aux
// model is started for the deep pass and stopped in a `finally`, always:
// two resident llama-servers plus page rasters do not fit comfortably in 16 GB,
// and a background graph build must never sit on the GPU while the reader is
// translating a book. Second, nothing here throws for a model problem — a
// missing model, a dead server, a reply that failed every gate all return the
// shard we already have, so the seed survives and a later run can try again.
// Only an abort propagates, untouched, because a cancelled build must stop
// rather than quietly write a half-shard.

import { invoke } from "@tauri-apps/api/core";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { bookKey } from "./bookid";
import { detectBookLang, UND, type BookLang } from "./booklang";
import { isTermKind, type TermRecord } from "./glossary";
import { loadGlossary, saveGlossary } from "./glossarygen";
import {
  conceptId,
  loadShard,
  normId,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type Provenance,
  type Shard,
} from "./graphstore";
// The Claude-pass switch is read from the queue module that owns it. The
// import is a cycle — graphrun imports seedShard/deepen/canDeepen from here —
// and it is safe because neither side calls across it while the modules are
// evaluating: claudeDeepen is a hoisted function declaration, and nothing in
// either module body invokes the other's exports at load time. Reading the
// switch from its owner rather than copying the frozen localStorage key into a
// second module is what stops the two copies drifting apart.
import { claudeDeepen } from "./graphrun";
import { baseName, claudeStatus, engineStatus } from "./host";
import { getLang } from "./i18n";
import { clusterParagraphs, type Paragraph } from "./paragraphs";
import { classify, type Meta } from "./provenance";
import {
  createMiner,
  isCitationPage,
  sampleFloor,
  stopLists,
  MAX_N,
  MAX_PAGES_PER_TERM,
  type TermMiner,
} from "./terms";
import { auxComplete, isAuxUp, type ChatMessage } from "./translate";

/// Which stretch of work a build is in. «seed» is the model-free pass, the
/// other three belong to the deep one.
export type GenPhase = "seed" | "topics" | "types" | "done";
export type GenProgress = { phase: GenPhase; done: number; total: number };

// ---- extractor generation ---------------------------------------------------

/// Which extractor wrote a shard. Bump this whenever a change here would make
/// an existing shard's CONTENTS materially worse than a fresh read of the same
/// book, and do not bump it for a change that only affects books nobody has
/// read yet.
///
/// It is deliberately not graphstore's `version`, which answers a different
/// question — «can this file still be parsed» — and whose bump would make every
/// shard in the library unreadable and blank the reader's graph until each book
/// had been read again. This answers «was this written by the extractor we now
/// ship»: a shard from an older generation stays fully readable, drawable and
/// searchable, it is merely queued to be read again, and it is replaced only
/// when that read finishes and writes. A shard with no generation field at all
/// was written before this existed and counts as generation 1.
///
/// Generation 2 is today's rewrite, and what it changed is the yardstick for
/// judging whether the next change deserves a bump — every item below makes an
/// already-written shard worse than a re-read, none of them merely adds
/// something for new books:
///   • the miner reads the WHOLE book (MINE_PAGES_MAX) instead of a fixed
///     24-page sample, which on an 838-page book is the difference between 7
///     concepts and 118;
///   • the reader's own translation glossary is merged into the mined list, so
///     terms curated by hand for another feature reach the graph;
///   • concept ids fold plurals (graphstore.conceptId), so «IR systems» and
///     «IR system» stopped being two half-weighted nodes;
///   • the deep pass stamps stage «deep» only when a term actually came back
///     typed, instead of stamping it over an aux server that answered 503 to
///     everything and freezing the book at nine bare nodes for ever;
///   • an author's bare surname in the running text merges onto the author node
///     the metadata gave, instead of standing beside it as a heavier second
///     person wired to no book.
///
/// Generation 3 is the one term store, and it is a bump for the same reason:
/// every item below leaves an already-written shard worse than a re-read of the
/// same file, and a generation-2 shard for a book in any language but English
/// is materially wrong rather than merely thinner.
///   • the miner is told the book's LANGUAGE (detected once at seed time, from
///     pages this pass reads anyway) and mines it with that language's
///     stoplists. A Russian book was mined with one merged English+Russian set
///     that had neither «книга» nor «всей», so its concepts ended on pronouns
///     and document furniture; a book in a language we ship no list for was
///     mined with no grammar at all, and a German one yielded «der Regel wird
///     die». Generation 3 derives that language's function words from the book
///     itself (terms.ts) instead;
///   • the glossary merged into the shard was, in generation 2, mined by an
///     ASCII-only tokenizer. For a non-English book that file is not a term
///     list — it is the LATIN ISLANDS inside the book, its BERTs and HTTPs and
///     transliterated author surnames — and every one of them went into the
///     shard as a concept node wired to the book. Those nodes do not go away
///     until the book is read again;
///   • a glossary term now arrives with a KIND and a DEFINITION, so nodes that
///     stood as bare «term» with no gloss are typed and glossed before any
///     model runs. That changes what colour a node is drawn in and what the
///     reader sees when they click it, not merely how many there are.
export const GRAPH_GEN = 3;

// ---- budgets ----------------------------------------------------------------
// Every number here was chosen against the two costs this module trades off:
// seconds of the reader's attention, and VRAM held while a build runs.

// Pages read for term mining: the whole book, up to this ceiling. It used to
// be 24 — a fixed sample chosen when nobody had measured what it bought — and
// on the 838-page book this feature was first run against, 24 pages is 2.9% of
// the text and yielded SEVEN concepts. Measured on that book (the real miner,
// the real PDF, scored against the reader's own 118-term glossary for the same
// book, which glossarygen mined from ALL of it):
//
//   pages read   floor   mined   in the glossary, top 60 / top 120   wall clock
//         24       3        7                    5  /   5              0.2 s
//        200       2      734                   44  /  65              1.7 s
//        400       2    1 891                   53  /  79              2.9 s
//        500       3    1 334                   56  /  90              3.8 s
//    838 (all)     5    1 222                   59  / 114              6.1 s
//
// The jump between 500 pages and the whole book is not the floor and not the
// cap: it is that only a complete read gives the C-value ranking true
// frequencies, so the terms that deserve the top of the list actually reach it
// (114 of 118 against 90). Six seconds for a book of that size — 7 ms a page,
// so about two seconds for an ordinary 300-page one — is the price, and it is
// paid once per book, in the background, behind a progress bar that counts
// pages, before a deep pass that costs minutes. The ceiling exists so that a
// pathological file (a scanned 5 000-page dictionary) cannot turn that into
// half a minute; above it the even spread below stands in for the rest.
//
// The other cost is memory, and it is bounded rather than negligible: mining
// all 838 pages holds 82 731 distinct n-grams, measured at about 75 MB of heap
// alongside pdf.js's own page cache, all of it released when the miner goes out
// of scope at the end of seedShard. That is what a linear one-pass count costs,
// and it is the shape terms.ts settled on for both its callers — the
// shortlist-plus-second-sweep alternative would halve the memory and double the
// six seconds. This caller asks for `withPages` and not for `withSample`, which
// is what keeps that 75 MB from also pinning a page of text per term.
const MINE_PAGES_MAX = 1000;
// Concept nodes one book contributes from mining. 60 was chosen when the miner
// could only find 7; over a whole book the cap, not the floor, became the
// binding constraint — the measurement above reads 59 of the glossary's 118
// terms inside the miner's top 60 and 114 inside its top 120, and top 160 adds
// exactly one more. So 120, which is also glossarygen's own cap, and the point
// where this book's ranking stops paying.
const SEED_TERMS = 120;
// The ceiling on concept nodes after the glossary merge below. Measured: the
// union of the miner's top 120 and this book's 118-term glossary is 124 — the
// two sources agree almost completely once both have read the whole book — so
// this is headroom rather than a limit that normally binds. It bounds the deep
// pass, which is what actually costs minutes: 180 terms is 15 typing chunks.
const MAX_CONCEPTS = 180;
const MAX_TAGS = 12;
// Pages pooled for language detection, and the same number glossarygen uses so
// that the two features cannot decide a book is in two different languages.
// They are a spread of the mining sample rather than its head: a book's first
// pages are a title page, a copyright block and a contents list, and booklang
// answers «und» to all three by design — pooling pages from the whole book is
// the defence against that. They cost nothing extra to read, because every one
// of them is a page this pass was going to read anyway; see seedShard.
const LANG_PAGES = 16;
// Minable pages above which a concept must have been met on more than one of
// them. Below it, «more than one page» would mean «almost all of them», which a
// four-page article cannot satisfy without going empty. It is a threshold on
// pages that SURVIVED the citation filter, so it is not known until the read
// ends — see seedShard for what that costs.
const MIN_SPREAD_PAGES = 4;
const TYPE_CHUNK = 12; // terms per typing call
const CONCURRENCY = 3; // worker count; the actual requests share auxPool's budget
const CO_PAIRS = 200; // co-occurrence edges kept for one book
const CO_PER_PAGE = 24; // heaviest concepts per page that may form pairs (n² guard)
const GLOSS_MAX = 160; // characters; a longer answer is an essay, not a gloss
const AUX_START_MS = 90_000; // model load takes 10-30s; never hang a build on it
const AUX_PROBE_MS = 400; // canDeepen must answer in well under a second
const AUX_HEALTH_MS = 1500; // one /health probe while waiting for the model to load
const AUX_POLL_MS = 500; // between those probes
const AUX_TRIES = 3; // attempts per model call, see auxAttempts
const AUX_RETRY_MS = 2000; // pause before a retry, so a busy server can finish

// ---- prompts ----------------------------------------------------------------
//
// These strings are not in i18n.ts and deliberately so. They are instructions
// to a model, never shown to anybody, and t() is the reader's vocabulary — a
// prompt drifting because somebody reworded a UI line is a defect nobody would
// see until the glosses came back malformed. They still come in both
// languages, for the same reason glossarygen's terminologist does: the answer
// has to come back in the language the reader reads, and a model asked in
// Russian answers in Russian far more reliably than one asked in English and
// told to switch at the end.
//
// The separator is « :: » and not the pipe character on purpose. This project
// reserves the pipe: i18n's t() splits plural forms on it, so a gloss carrying
// one would be silently cut in half the day somebody routes it through t().
// A colon pair never occurs inside a mined term and survives a model that
// decides to be helpful with punctuation.

const SEP = "::";
const SEP_SPACED = " :: ";

type Lang = "ru" | "en";

/// What the model is told about the book itself. Every field is already
/// flattened to one line except `front`, which is trimmed page text.
type Brief = { title: string; authors: string; tags: string; toc: string; front: string };

// The half of the typing instruction that explains the closed vocabulary. It
// is a named constant because all four typing prompts — two languages × local
// and Claude — have to say the SAME thing about the same six words, and the
// day they drift is the day the two engines type one library two ways.
//
// It says more than the six glosses it replaced, and the extra sentences are
// there because of what a 4B model actually did with the short version. Handed
// a technical book's term list it answered «work» for «recommender systems»,
// «document», «search engine», «IR systems» and «large language models»,
// «place» for «Internet» and «eCommerce sites», and «person» for «search engine
// user» — fifteen spurious «work» nodes out of 117. The glosses were right
// every time; the model understands the terms and simply cannot hold a six-way
// closed vocabulary steady. So the rule now states the base rate («almost all
// of them are term or topic»), says plainly that the other four kinds are for
// NAMES, and hands over a test the model can apply to the label in front of it
// — could this be written in lower case mid-sentence? Measured on the reader's
// own 838-page book, this alone moves the count of proper-noun nodes from 29 to
// 12 (see guardKind, which is what closes the rest).
const NAMES_RULE = {
  ru:
    "person — имя человека, org — название организации, place — название места, " +
    "work — заглавие книги, статьи или иного произведения, " +
    "topic — область или направление, term — понятие, метод или объект изучения.\n" +
    "Почти все термины технической книги — это term или topic. Остальные четыре типа только " +
    "для имён собственных. Проверь себя так: если термин можно написать со строчной буквы " +
    "в середине предложения, это term или topic, а не имя.\n",
  en:
    "person is a person's name, org an organisation's name, place a place's name, " +
    "work the title of a book, paper or other named work, " +
    "topic a field or direction, term a concept, method or object of study.\n" +
    "Almost every term in a technical book is a term or a topic. The other four types are for " +
    "proper names only. Check yourself like this: if the term can be written in lower case in " +
    "the middle of a sentence, it is a term or a topic, not a name.\n",
} as const;

const PROMPTS: Record<
  Lang,
  {
    topicsSystem: string;
    topicsUser: (b: Brief) => string;
    typeSystem: string;
    typeUser: (b: Brief, terms: readonly string[]) => string;
    claudeSystem: string;
    claudeUser: (b: Brief, terms: readonly string[]) => string;
    // Distinctive fragments of the instructions above. A reply containing one
    // of them is the model reciting the task back instead of doing it.
    echo: readonly string[];
  }
> = {
  ru: {
    topicsSystem:
      "Ты библиотекарь. Ты читаешь начало книги и называешь её предметные области. " +
      "Отвечай только по заданной форме, без пояснений, без списков и без разметки.",
    topicsUser: (b) =>
      `Название: ${b.title}\n` +
      `Авторы: ${b.authors}\n` +
      `Оглавление: ${b.toc}\n` +
      `Начало книги:\n${b.front}\n\n` +
      "Назови от 5 до 8 предметных областей этой книги и опиши её ровно двумя предложениями.\n" +
      "Ответь ровно двумя строками и ничем больше:\n" +
      "ТЕМЫ: область, область, область\n" +
      "СВОДКА: два предложения\n" +
      "Пиши по-русски.",
    typeSystem:
      "Ты терминолог. Тебе дают термины из одной книги; ты определяешь, что каждый из них обозначает, " +
      "и объясняешь его одной строкой. Отвечай только строками заданной формы, без нумерации, " +
      "без заголовков и без пояснений.",
    typeUser: (b, terms) =>
      `Книга: ${b.title}\n` +
      `Темы книги: ${b.tags}\n\n` +
      "Для каждого термина из списка выведи одну строку вида\n" +
      `термин ${SEP} тип ${SEP} объяснение одной строкой\n` +
      "Тип — ровно одно слово из списка: person, org, place, work, topic, term.\n" +
      NAMES_RULE.ru +
      "Термин переписывай без изменений. Объяснение — одно предложение до 15 слов, по-русски.\n" +
      "Строк должно быть ровно столько, сколько терминов. Ничего, кроме этих строк, не пиши.\n\n" +
      `Термины:\n${terms.join("\n")}`,
    claudeSystem:
      "Ты извлекаешь структуру знаний из одного документа. " +
      "Ты отвечаешь простыми строками: без markdown, без блоков кода, без вступлений и без итогов.",
    claudeUser: (b, terms) =>
      `Название: ${b.title}\n` +
      `Авторы: ${b.authors}\n` +
      `Ключевые слова: ${b.tags}\n\n` +
      "Ниже — термины, добытые из текста этого документа статистически. " +
      "Определи, что каждый из них обозначает в этом документе, и опиши сам документ.\n\n" +
      "Ответь так и только так. Сначала две строки:\n" +
      "ТЕМЫ: от 5 до 8 предметных областей через запятую\n" +
      "СВОДКА: два предложения о документе\n" +
      "Затем по одной строке на каждый термин, в том же порядке:\n" +
      `термин ${SEP} тип ${SEP} объяснение одной строкой\n` +
      "Тип — ровно одно слово из списка: person, org, place, work, topic, term.\n" +
      NAMES_RULE.ru +
      "Термин переписывай без изменений. Объяснение — одно предложение до 15 слов.\n" +
      "Пиши по-русски. Ничего, кроме этих строк, не пиши.\n\n" +
      `Термины:\n${terms.join("\n")}`,
    echo: ["ТЕМЫ: область", "СВОДКА: два предложения", `термин ${SEP} тип ${SEP}`, "Тип — ровно одно слово"],
  },
  en: {
    topicsSystem:
      "You are a librarian. You read the opening of a book and name its subject areas. " +
      "Answer in the given form only, with no explanations, no lists and no markup.",
    topicsUser: (b) =>
      `Title: ${b.title}\n` +
      `Authors: ${b.authors}\n` +
      `Contents: ${b.toc}\n` +
      `Opening pages:\n${b.front}\n\n` +
      "Name 5 to 8 subject areas of this book and describe it in exactly two sentences.\n" +
      "Answer with exactly two lines and nothing else:\n" +
      "TOPICS: area, area, area\n" +
      "SUMMARY: two sentences\n" +
      "Write in English.",
    typeSystem:
      "You are a terminologist. You are given terms from one book; you decide what each of them denotes " +
      "and explain it in one line. Answer with lines of the given form only, with no numbering, " +
      "no headings and no explanations.",
    typeUser: (b, terms) =>
      `Book: ${b.title}\n` +
      `Subjects: ${b.tags}\n\n` +
      "For every term in the list output one line of the form\n" +
      `term ${SEP} type ${SEP} one-line explanation\n` +
      "The type is exactly one word from this list: person, org, place, work, topic, term.\n" +
      NAMES_RULE.en +
      "Copy the term unchanged. The explanation is one sentence of at most 15 words, in English.\n" +
      "Output exactly as many lines as there are terms. Write nothing but those lines.\n\n" +
      `Terms:\n${terms.join("\n")}`,
    claudeSystem:
      "You extract the knowledge structure of one document. " +
      "You answer in plain lines: no markdown, no code fences, no preamble and no closing remarks.",
    claudeUser: (b, terms) =>
      `Title: ${b.title}\n` +
      `Authors: ${b.authors}\n` +
      `Keywords: ${b.tags}\n\n` +
      "Below are terms mined statistically from the text of this document. " +
      "Decide what each of them denotes in this document, and describe the document itself.\n\n" +
      "Answer in this form and no other. First two lines:\n" +
      "TOPICS: 5 to 8 subject areas, comma separated\n" +
      "SUMMARY: two sentences about the document\n" +
      "Then one line per term, in the same order:\n" +
      `term ${SEP} type ${SEP} one-line explanation\n` +
      "The type is exactly one word from this list: person, org, place, work, topic, term.\n" +
      NAMES_RULE.en +
      "Copy the term unchanged. The explanation is one sentence of at most 15 words.\n" +
      "Write in English. Write nothing but those lines.\n\n" +
      `Terms:\n${terms.join("\n")}`,
    echo: ["TOPICS: area", "SUMMARY: two sentences", `term ${SEP} type ${SEP}`, "The type is exactly one word"],
  },
};

const prompts = (): (typeof PROMPTS)["ru"] => PROMPTS[getLang()];

// The closed type vocabulary. Anything outside it — and any line whose gloss
// is empty — falls back to «term» with no gloss rather than being dropped: a
// term that resisted typing is still a real term in the book, and losing it
// would silently shrink the graph every time the model got creative.
const TYPES = new Map<string, NodeKind>([
  ["person", "person"],
  ["org", "org"],
  ["place", "place"],
  ["work", "work"],
  ["topic", "topic"],
  ["term", "term"],
]);

// ---- stoplists --------------------------------------------------------------
//
// The three lists — function words, ordinary words, capitalised category nouns
// — live in terms.ts now, keyed by language, and the miner is handed the set
// for the language this book turned out to be written in. What is left here is
// the vocabulary the three helpers below need, and those do NOT take the book's
// language: they take the union of everything curated, deliberately.
//
// The reason is that they answer a different question. The miner asks «is this
// a function word of the language I am reading», which is exactly a per-language
// question. The proper-noun guard asks «is this label an ordinary word rather
// than somebody's name», tagOk asks «is this piece a subject heading or a scrap
// of the sentence around one», and neither has a language to speak of: a tag
// arrives from a PDF's /Keywords field in whatever language the typesetter
// used and from the model's TOPICS line in the INTERFACE language, which are
// routinely two different languages and neither of them the book's. An answer
// of «yes, that is an ordinary word in some language I know» is the right
// answer to both, whichever language that turns out to be.
//
// So this is the union, and it is what the module has always used. Measured
// against the sets it replaces: `common` and `capCommon` are the same words to
// the letter, and `func` is those words plus the 89 Russian closed-class forms
// and pieces of document furniture that terms.ts brought in from
// graphstore.ts:875 (книга, странице, всей, которого, каждой…). That is the
// safe direction for all three callers — one more word on the list is one more
// label that cannot be mistaken for a name and one more scrap that cannot be
// mistaken for a subject heading.
const STOP = stopLists(UND);

// ---- the proper-noun guard --------------------------------------------------
//
// `person`, `org`, `place` and `work` are PROPER-NOUN kinds: each of them says
// the label names one particular individual. That is a claim about the label
// itself, and — unlike the difference between a topic and a term — it leaves a
// mark on the page. A thing with a name gets a capital letter; a category does
// not. So the claim can be checked here, deterministically, without asking
// anybody, and the label we get to check is the miner's own dominant surface
// form (see dominantForm), which is the spelling the book used in the middle of
// its sentences rather than at the start of them. «Meryl Streep» carries the
// mark. «recommender systems» does not, whatever a 4B model says about it.
//
// The guard therefore OVERRULES the model on the four naming kinds and leaves
// `topic` and `term` entirely to it — that distinction is a judgement about
// meaning, the model is good at it, and neither answer can put a wrongly
// coloured node in the picture.
//
// Two limits are stated rather than papered over.
//
// An ALL-CAPS token is not evidence of a name. «IR», «QAC», «CLIR» and «BERT»
// are set exactly like «ACM» and «NLM», so no rule can keep the organisations
// and drop the acronyms; the acronyms are far commoner in a technical book, so
// all-caps labels are terms. The cost is real and named: ACM and NLM lose their
// org colour and show as terms.
//
// And a mined label can no longer be a `work` at all. Telling a book title from
// a title-cased concept is the case this guard genuinely cannot decide —
// «Retrieval Systems» and «Bias in Retrieval Systems» are shaped precisely like
// «Modern Information Retrieval», and this book's own glossary lists the first
// two as concepts. What settles it is not the shape but the miner: its
// candidates are clause-bounded n-grams of at most MAX_N tokens, taken from
// pages that survived the citation filter, so a title with a colon or a
// subtitle cannot survive as one label and a reference list never contributes
// one. A `work` answer is therefore nearly always a title-cased concept, and it
// is demoted — to `topic` when the label is name-shaped, to `term` when it is
// not. A concept shelved as a topic is invisible; a concept shelved as a work
// is a wrong-coloured node in a picture the reader is looking at.

const NAMING_KINDS = new Set<NodeKind>(["person", "org", "place", "work"]);

/// Is this ONE word of a label the sort of word a proper name is made of?
function isNameWord(word: string): boolean {
  const w = word.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
  if (!w || !/\p{L}/u.test(w)) return false;
  if (!/^\p{Lu}/u.test(w)) return false; // «recommender», «eCommerce»: no capital, no name
  if (w === w.toUpperCase()) return false; // an acronym, see above
  const low = w.toLowerCase();
  return !STOP.func.has(low) && !STOP.common.has(low) && !STOP.capCommon.has(low);
}

/// Could this label be the name of an individual — a person, an organisation,
/// a place, a work? One name word anywhere in it is enough: «Association for
/// Computing Machinery» spends a function word in the middle, and «Northeastern
/// University» spends a category noun at the end.
const nameShaped = (label: string): boolean => flat(label).split(/\s+/).some(isNameWord);

/// The kind this label is ALLOWED to have, given what the model answered.
function guardKind(kind: NodeKind, label: string): NodeKind {
  if (!NAMING_KINDS.has(kind)) return kind; // topic vs term stays the model's call
  const named = nameShaped(label);
  if (kind === "work") return named ? "topic" : "term";
  return named ? kind : "term";
}

// ---- text plumbing ----------------------------------------------------------

// Yield to the event loop without setTimeout — a hidden tab's timer throttling
// would otherwise clamp every yield to ~1s and make a background build crawl.
//
// glossarygen has the same four lines, and terms.ts — which both of them now
// mine through — deliberately does not export one: the miner does no IO, takes
// no signal and never yields, because the caller owns the read loop, the
// progress bar and the abort. Deciding when to breathe is this module's job and
// nobody else's, so the helper lives with the loop that uses it.
function tick(): Promise<void> {
  return new Promise((res) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => res();
    ch.port2.postMessage(0);
  });
}

function abortErr(): never {
  throw new DOMException("graph generation aborted", "AbortError");
}

const isAbortErr = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const onAbort = () => {
      clearTimeout(timer);
      rej(new DOMException("graph generation aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      res();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

async function pageParagraphs(doc: PDFDocumentProxy, n: number): Promise<Paragraph[]> {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  return clusterParagraphs(content.items, page.getViewport({ scale: 1 }));
}

const paraText = (paras: readonly Paragraph[]): string => paras.map((p) => p.text).join("\n");

// ---- the page sample --------------------------------------------------------
//
// This stays here rather than moving to terms.ts with the miner: the miner is
// handed pages, it does not choose them, and this pass chooses them for three
// different consumers at once — the provenance classifier, the language
// detector and the miner — from one read of each page.

/// At most `want` page numbers spread evenly across a book of `total` pages,
/// first and last included. Even spacing rather than a contiguous slice: a
/// book's subject matter moves as it goes, and mining the first two dozen
/// pages would describe its introduction rather than the book.
function samplePages(total: number, want: number): number[] {
  if (total <= want) return Array.from({ length: total }, (_, i) => i + 1);
  const out: number[] = [];
  for (let i = 0; i < want; i++) out.push(1 + Math.round((i * (total - 1)) / (want - 1)));
  return [...new Set(out)];
}

/// A capital in the two alphabets an author line can be set in. The miner has
/// its own copy of this (terms.ts) because it runs the test once per counted
/// occurrence and cannot afford to import anything; this one is consulted by
/// looksLikeAuthors, a few dozen times per book, and is kept because a byline is
/// the one place in this module where «starts with a capital» is the whole test.
const isCapital = (ch: number): boolean =>
  (ch >= 65 && ch <= 90) || (ch >= 0x410 && ch <= 0x42f) || ch === 0x401;

// ---- the reader's term store ------------------------------------------------

/// The reader's own term store for this book, if there is one — and it is not a
/// word list any more, it is a RECORD each: a surface form in the book's own
/// language, plus whatever the glossary's passes or the reader's own hand have
/// attached to it since. Two of those fields are exactly what a bare concept
/// node lacks — a KIND out of the same six-word vocabulary the graph draws in,
/// and a one-sentence DEFINITION — so seedShard can colour and gloss a node
/// with no model running at all, and the deep pass can skip what is already
/// known instead of paying a minute a chunk to learn it twice.
///
/// loadGlossary is glossarygen's own reader, and none of what it does may be
/// re-implemented here: it owns the appdata path, the session cache, the
/// fallback to a pre-binding file name and the sidecar that carries the
/// bookkeeping. Two spellings of «where the glossary lives» would drift apart
/// the first time either side changed.
///
/// It is keyed by bookPath rather than by the content key this shard is named
/// with, and resolves the one to the other through bookid's session map. That
/// map is filled by whoever read the file's bytes — graphrun's openGraphDoc
/// calls setBookKey before seedShard for exactly this reason, and its
/// deepen-only branch, which never opens the file at all, binds the shard's own
/// name before calling deepen for the same one — so the lookup
/// lands on <appDataDir>/glossaries/<contentKey>.txt, the same file the
/// translation side writes. Nothing breaks on the READ side if it has not been
/// filled: the fallback finds a legacy path-named glossary or nothing at all.
/// The write side is stricter, and says why at feedTermStore.
///
/// Never throws. A book with no glossary, a profile with no glossaries folder
/// and a plain-browser run all mean the same thing to a seed pass — no free
/// terms this time — and none of them is a failed build.
async function glossaryRecords(bookPath: string): Promise<TermRecord[]> {
  const loaded = await loadGlossary(bookPath).catch(() => null);
  const out: TermRecord[] = [];
  const seen = new Set<string>();
  for (const rec of loaded?.records ?? []) {
    const term = flat(rec.term);
    // The same shape tests the miner applies to its own labels: a line that is
    // a sentence, or has no letters in it, is a broken glossary line.
    if (term.length < 2 || term.length > 64 || !/\p{L}/u.test(term)) continue;
    if (term.split(/\s+/).length > MAX_N + 2) continue;
    const k = normId(term);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ ...rec, term });
  }
  return out;
}

/// Which concepts the reader's term store has already TYPED — keyed the way a
/// node is keyed, so the deep pass can ask about a node rather than about a
/// spelling.
///
/// It exists because a node cannot answer the question by itself. «term» is
/// both what the store says about most entries in a technical book AND the
/// seed's default for a concept nobody has typed, so `n.kind === "term"` is two
/// different states wearing one word. The store can tell them apart — a record
/// either carries a kind or it does not — and it is one cached read away
/// (loadGlossary's text comes out of translate.ts's session cache; only the
/// sidecar is read from disk).
///
/// conceptId on both sides rather than the node's id, because that is what
/// welded the store's term onto the node in the first place (addConcept keys by
/// conceptId, which folds the head token, so «inverted indexes» in the file and
/// «inverted index» in the running text are one concept). A person node keyed
/// by normId — an author whose surname the miner also found — therefore never
/// matches here and is asked about again. That is the harmless direction: it
/// costs one slot in a typing batch, and applyDeep pins an author's kind
/// anyway, whereas a false match would pin a node to a kind nobody chose.
async function typedConcepts(bookPath: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const rec of await glossaryRecords(bookPath)) {
    if (!rec.kind) continue;
    const id = conceptId(rec.term);
    if (id) out.add(id);
  }
  return out;
}

/// A glossary definition as a node's gloss, or "" when it cannot be one.
///
/// The model gates further down this file (cleanGloss and its neighbours)
/// deliberately do NOT apply here. They judge a reply that has just come back
/// from a model in this process; this line came off the reader's own file, which
/// glossarygen's passes have already gated and which the reader may then have
/// rewritten by hand. Re-judging it here would throw away the better of the two
/// texts, and the alphabet test in particular would reject a definition written
/// while the interface was set to the other language. What is left worth
/// checking is the shape of the field the panel draws on one line: a definition
/// longer than a gloss is dropped whole rather than cut, because half a sentence
/// under a node is worse than no sentence at all.
const glossOf = (definition: string | undefined): string => {
  const g = flat(definition ?? "");
  return g && g.length <= GLOSS_MAX ? g : "";
};

// ---- metadata reading -------------------------------------------------------

// A Title that is really a file name, a LaTeX artefact or a word processor's
// idea of a placeholder. Every one of these has been seen in the wild in the
// Info dictionary of a perfectly ordinary book, and every one of them would
// otherwise become a node label the reader has to look at for ever.
const TITLE_FILE = /\.(?:pdf|docx?|rtf|tex|dvi|ps|epub|indd|qxd|pages)\s*$/i;
const TITLE_ARTEFACT =
  /^(?:untitled|no title|без\s*названи|microsoft\s+word\s*[-–]|документ\s*\d*$|document\s*\d*$|\\document|main$|paper$|draft$|output$|print$|final$|book1$)/i;

function usableTitle(raw: string): string {
  const s = flat(raw);
  if (s.length < 3 || s.length > 200) return "";
  if (!/\p{L}/u.test(s)) return "";
  if (TITLE_FILE.test(s) || TITLE_ARTEFACT.test(s)) return "";
  if (/[\\/]/.test(s) && /\.\w{2,4}\b/.test(s)) return ""; // a path with an extension in it
  if (/\\document(?:class|style)/i.test(s)) return "";
  return s;
}

/// The largest-type line on the page, which on a title page is the title. Font
/// height rather than position: a cover often puts the publisher's logo above
/// the title, and «topmost» would pick the logo's caption every time.
function biggestParagraph(paras: readonly Paragraph[]): Paragraph | null {
  let best: Paragraph | null = null;
  for (const p of paras) {
    // «other» is what classifyMetrics calls an ISBN/DOI catalogue block, a
    // formula or glyph soup — a title page carries all three, sometimes in
    // bigger type than the title. («furniture» is set by detectFurniture,
    // which this module does not run; it is listed so the guard stays right
    // if a caller ever hands us classified paragraphs.)
    if (p.kind === "other" || p.kind === "furniture") continue;
    const s = flat(p.text);
    if (s.length < 3 || s.length > 200 || !/\p{L}/u.test(s)) continue;
    if (!best || p.fh > best.fh) best = p;
  }
  return best;
}

// ---- author names -----------------------------------------------------------
//
// An /Author field almost never holds only names. The reader's own book prints
//
//   Omar Alonso – Amazon, US; Ricardo Baeza-Yates – Northeastern University, US
//
// and the old ladder here — which stripped footnote markers and nothing else —
// turned that into two people called «Omar Alonso – Amazon» and «Ricardo
// Baeza-Yates – Northeastern University», then fed both, verbatim, into the
// model prompt as the book's authors. Without the semicolon it was worse: the
// AND branch split on the affiliation's own commas and MANUFACTURED PERSON
// NODES for institutions — «Jane Roe, Department of Computer Science, MIT»
// became three people, and «… – Amazon, US and …» produced a person named «US».
//
// So the affiliation comes off each part BEFORE anything decides whether a
// comma splits people. That ordering is the fix: once the affiliations are
// gone, a comma still standing belongs to a name.

const SUPER = /[\u00AA\u00B2\u00B3\u00B9\u2070-\u207F\u2080-\u209C]/gu;
// A footnote marker only where a marker can be: welded to the END of a word.
// This keeps «3M» and «Иван III» while killing «Petrov1» and «Xu*».
const MARK = /(?<=\p{L})[\d*†‡§¶‖#]+(?![\p{L}])/gu;
const TITLE_PREFIX = /^(?:(?:prof(?:essor)?|dr|mr|mrs|ms|проф|д-р|акад|доц)\.?\s+)+/iu;
const NAME_SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv", "младший", "мл"]);
// Vocabulary that marks the tail after a dash as an institution rather than
// half a double-barrelled surname. It is needed ONLY for the unspaced-dash
// case below: a spaced dash cuts without asking, which is why no company list
// is required to deal with «Omar Alonso – Amazon».
const AFFIL =
  /(?:^|[\s.,])(?:univ(?:\.|ersit(?:y|é|ät|at|à|e|ies))|college|institut[eo]?|school|department|dept|faculty|laborator(?:y|ies)|labs?|research|academy|academia|centre|center|hospital|clinic|foundation|society|association|corporation|corp|inc|ltd|llc|gmbh|group|division|университет|институт|академи[ияй]|факультет|кафедр[аы]|лаборатори[яи]|НИИ|РАН|центр|общество)(?:$|[\s.,])/iu;

// Name particles, which are lower case in the middle of a real name and must
// not be read as evidence that a comma-separated segment is not a person.
const PARTICLE = new Set([
  "de", "van", "von", "der", "den", "del", "della", "di", "da", "dos", "du", "la", "le", "bin", "ibn", "оглы",
]);

/// Does this comma-separated segment START A NEW PERSON, as opposed to
/// continuing the name before it («Jr.», «И. И.») or naming where that person
/// works? This is the only thing that can tell «Jane Doe, John Roe» — two
/// people with no conjunction between them — from «Chen Xu, Tsinghua» and
/// «Anna Lee, PhD», and it is why a bare comma no longer splits by itself.
///
/// Two words at least: an institution, a country and a degree are written as
/// one word far more often than a person's name is, and «Tsinghua» becoming a
/// person node is the failure this whole ladder exists to stop. Four at most:
/// longer is a sentence or an address. The known limit, stated rather than
/// pretended away: a two-word company with no vocabulary word in it («Google
/// Brain») reads as a person here, and only a company list could tell it apart.
function segmentIsPerson(seg: string): boolean {
  const ws = seg.split(/\s+/).filter(Boolean);
  if (ws.length < 2 || ws.length > 4) return false;
  if (AFFIL.test(seg)) return false;
  let capped = 0;
  for (const w of ws) {
    const c = w.replace(/^[^\p{L}]+/u, "");
    if (!c) return false;
    if (/^\p{Lu}/u.test(c)) capped++;
    else if (!PARTICLE.has(c.toLowerCase())) return false;
  }
  return capped >= 2;
}

/// One part cut at the commas that separate PEOPLE, leaving every other comma
/// where it is for cutAffiliation to deal with.
function splitPeople(part: string): string[] {
  const segs = part
    .split(/\s*,\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (segs.length < 2) return [part];
  const words = (x: string): number => x.split(/\s+/).filter(Boolean).length;
  // «Фамилия, Имя [Отчество]» — one person written backwards. The surname half
  // is exactly ONE word, which is what the form is for, so «Graves, Clare» and
  // «Грейвз, Клер Уильям» stay whole while «Jane Doe, John Roe» does not.
  if (segs.length === 2 && words(segs[0]) === 1 && words(segs[1]) <= 3) return [part];
  const out = [segs[0]];
  for (let i = 1; i < segs.length; i++) {
    // Judged on the segment with its own affiliation already taken off, or a
    // byline like «A. B. Chen, D. E. Fu (Tsinghua University)» loses its
    // second author to a word count that included the university. The RAW
    // segment is what gets pushed: cutAffiliation runs on it again in
    // splitAuthors, and running it twice is free and idempotent.
    if (segmentIsPerson(cutAffiliation(segs[i]))) {
      out.push(segs[i]);
      continue;
    }
    // Not a person: everything from here on belongs to the name before it —
    // as a suffix, as initials, or as the place it works — and cutAffiliation
    // is the one that knows which.
    out[out.length - 1] = [out[out.length - 1], ...segs.slice(i)].join(", ");
    break;
  }
  return out;
}

/// One author part with everything that is not the person's name taken off.
function cutAffiliation(part: string): string {
  let s = flat(part);
  s = s.replace(/\S+@\S+/g, " ").replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ");
  s = s.replace(SUPER, " ").replace(MARK, " ");
  s = s.replace(/[([{][^)\]}]*[)\]}]/g, " "); // (University of X), [1], (ред.)
  s = flat(s).replace(TITLE_PREFIX, "");

  // A dash with a space on at least ONE side cuts unconditionally. The space
  // is load-bearing: «Baeza-Yates», «Jean-Paul» and «Смирнов-Сокольский» use
  // an UNSPACED hyphen and must survive whole.
  let m = s.match(/\s[-–—―‒]\s|\s[–—―‒]|[–—―‒]\s/u);
  if (m && m.index !== undefined) s = s.slice(0, m.index);

  // An unspaced en/em dash cuts only when the tail is affiliation vocabulary —
  // a typographer who writes «Baeza–Yates» must not lose half a surname.
  m = s.match(/[–—―‒]/u);
  if (m && m.index !== undefined && AFFIL.test(s.slice(m.index + 1))) s = s.slice(0, m.index);

  const parts = s
    .split(/\s*,\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    const words = (x: string): number => x.split(/\s+/).filter(Boolean).length;
    // «Фамилия, Имя [Отчество]» — the inverted form, where both halves are the
    // name. The surname half is exactly ONE word, which is what the form is
    // for, so «Graves, Clare» and «Грейвз, Клер Уильям» stay whole.
    if (parts.length === 2 && words(parts[0]) === 1 && words(parts[1]) <= 3) s = `${parts[0]}, ${parts[1]}`;
    else {
      // Not inverted ⇒ a comma introduces an affiliation, a degree or a
      // country. Only two kinds of tail are still part of the name.
      const kept = [parts[0]];
      for (let i = 1; i < parts.length; i++) {
        const tail = parts[i];
        if (NAME_SUFFIX.has(tail.toLowerCase().replace(/\.$/, ""))) {
          kept.push(tail);
          continue;
        }
        if (/^(?:\p{Lu}\.?\s*){1,3}$/u.test(tail)) {
          kept.push(tail); // initials
          continue;
        }
        break;
      }
      s = kept.join(", ");
    }
  }
  // A trailing full stop belongs to «Jr.» and to «И. И.», so only «,;» are
  // trimmed off the end.
  return flat(s)
    .replace(/^[.,;\s]+/, "")
    .replace(/[,;\s]+$/, "");
}

// The ladder, in the order that matters: an explicit «;» always splits;
// « and » / « & » / « и » always split; then a comma splits only where both
// sides read as people (splitPeople); and only then does the affiliation come
// off what is left (cutAffiliation). Getting the comma step wrong makes
// «Smith, John» into two people and two graph nodes, which is worse than
// leaving a pair of names in one.
function splitAuthors(raw: string): string[] {
  const s = flat(raw).replace(/^\s*(?:by|автор(?:ы)?)\s*[:.]?\s*/i, "");
  if (!s) return [];
  const AND = /\s+(?:and|&|und|et|и)\s+/i;
  let parts: string[];
  if (s.includes(";")) parts = s.split(/\s*;\s*/);
  else if (AND.test(s)) parts = s.split(AND);
  else parts = [s];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts)
    for (const person of splitPeople(part)) {
      const name = cutAffiliation(person);
      if (name.length < 2 || name.length > 80 || !/\p{L}/u.test(name)) continue;
      if (name.split(/\s+/).length > 6) continue; // a sentence, not a name
      const k = normId(name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(name);
    }
  return out.slice(0, 12);
}

// The author line of an article sits under the title, in smaller type, and
// reads as a list of names rather than as prose. «Reads as names» is the only
// test available without a name dictionary: every comma-separated part is one
// to five words, and most of those words are capitalised.
function looksLikeAuthors(s: string): boolean {
  const t = flat(s);
  if (t.length < 4 || t.length > 200 || /@|\bhttp/i.test(t)) return false;
  const parts = splitAuthors(t);
  if (!parts.length) return false;
  let capped = 0;
  let words = 0;
  for (const p of parts) {
    const ws = p.split(/\s+/);
    if (ws.length > 5) return false;
    for (const w of ws) {
      words++;
      if (isCapital(w.charCodeAt(0))) capped++;
    }
  }
  return words > 0 && capped / words >= 0.6;
}

// ---- an author and the surname the miner finds ------------------------------
//
// A book names its own authors twice: once in the metadata, as «Ricardo
// Baeza-Yates», and then all through the running text as «Baeza-Yates». The
// seed pass turned that into two nodes. The author node carried the `by` edge
// to the book and a weight of one; the surname was mined off 33 pages, weighed
// 33, and the deep pass promoted it to a second `person` with a gloss of its
// own. The graph therefore showed the man twice, and the heavy node — the one
// the layout puts in the middle and the reader clicks — was the one NOT wired
// to his book.
//
// The «authors first» rule in seedShard could not catch it: it keys on the
// whole name, so a bare surname in prose never matches. These three helpers
// build the missing key, and every one of them is written to REFUSE rather than
// guess, because a wrong merge welds two people together and nothing on screen
// would show it.

/// The surname of one author name, or "" when there is no surname this can be
/// sure of.
function surnameOf(name: string): string {
  const s = flat(name);
  const comma = s.indexOf(",");
  if (comma > 0) {
    // «Фамилия, Имя» / «Baeza-Yates, R.» — the inverted form cutAffiliation
    // keeps whole. Its surname is the ONE word before the comma; a longer head
    // is some other construction and gets no key.
    const head = s.slice(0, comma).trim().split(/\s+/).filter(Boolean);
    return head.length === 1 ? head[0] : "";
  }
  const ws = s.split(/\s+/).filter(Boolean);
  while (ws.length > 1 && NAME_SUFFIX.has(ws[ws.length - 1].toLowerCase().replace(/\.$/, ""))) ws.pop();
  // A one-word author is its own whole name. addConcept already finds that
  // under normId, and calling it a surname would let the same word anywhere in
  // the book claim the node.
  return ws.length >= 2 ? ws[ws.length - 1] : "";
}

/// Is this surname distinctive enough to be allowed to swallow a mined term?
/// «Page», «Bell», «Young» and «Bias» are surnames AND ordinary words, and a
/// term list cannot tell which one the book meant — so they merge nothing, and
/// the author keeps a thin node rather than the wrong one.
function usableSurname(sn: string): boolean {
  if (!/^\p{Lu}/u.test(sn)) return false;
  if ((sn.match(/\p{L}/gu) ?? []).length < 3) return false; // «Li», «Ma», «Ng», «Xu»
  const id = normId(sn);
  if (!id) return false;
  // normId splits a double-barrelled surname on its hyphen, so every part is
  // tested: «Baeza-Yates» passes, a hypothetical «Data-Smith» would not.
  return !id.split(" ").some((w) => STOP.func.has(w) || STOP.common.has(w) || STOP.capCommon.has(w));
}

/// The bare surname this mined label is a mention of, or "" when the label is
/// not a bare surname at all. Initials come off, so «Baeza-Yates, R.» and
/// «R. Baeza-Yates» reduce to the same word; anything with a second real word
/// in it («Baeza-Yates ranking») is a phrase, not a mention of a person.
function bareSurname(label: string): string {
  const ws = flat(label)
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !/^\p{L}\.?$/u.test(w));
  if (ws.length !== 1) return "";
  // Running text capitalises a name. A lower-case match is the ordinary word,
  // not the person.
  return /^\p{Lu}/u.test(ws[0]) ? ws[0] : "";
}

const YEAR_NOW = new Date().getFullYear() + 1;
const plausibleYear = (n: number): boolean => n >= 1450 && n <= YEAR_NOW;

// The copyright line first: it names the edition. Metadata second. The file's
// own CreationDate is the last resort and deliberately so — it is when the PDF
// was produced, which for a scan is decades after the book was written.
function findYear(front: string, back: string, info: Record<string, unknown>): number | null {
  const copy = `${front}\n${back}`.match(
    /(?:©|\(c\)|copyright|издательств[оа]|подписано в печать)[^\n]{0,80}?((?:1[5-9]|20)\d\d)/i,
  );
  if (copy && plausibleYear(Number(copy[1]))) return Number(copy[1]);
  const bib = `${str(info.Title)} ${str(info.Subject)} ${str(info.Keywords)}`.match(/(?:1[5-9]|20)\d\d/);
  if (bib && plausibleYear(Number(bib[0]))) return Number(bib[0]);
  const made = str(info.CreationDate).match(/^D?:?((?:1[5-9]|20)\d\d)/);
  return made && plausibleYear(Number(made[1])) ? Number(made[1]) : null;
}

// ---- tags -------------------------------------------------------------------
//
// A tag is a SUBJECT TERM: what would stand in a library subject heading or a
// keyword list. Not a metadata line, not an organisation, not an identifier,
// not a sentence. The old rule was three shape tests — two characters, no more
// than forty-eight, at least one letter — and it let the reader's own book
// into the graph tagged «Publisher: Association for Computing Machinery»,
// straight out of the /Keywords field, as the ONLY thing the graph claimed to
// know about the book's subject. That string then also went into the model
// prompt as «Темы книги», spending prompt budget to mislead.
//
// The same predicate covers all three places a tag can arrive from — the Info
// dictionary, the model's TOPICS line and the deep pass's merge — so a model
// that answers «Publisher: ACM» is filtered exactly like the file that says it.

// A metadata label at the head of a piece: STRIPPED rather than rejected,
// because a Russian Keywords field reads «Ключевые слова: поиск, ранжирование»
// and rejecting the piece outright would lose «поиск».
const LABEL =
  /^(?:keywords?|key words|subject|subjects|topics?|publisher|publication|author|title|doi|isbn|issn|series|source|category|categories|rights|copyright|ключевые слова|предмет|тема|темы|издательство|автор|заглавие|рубрика|удк|ббк)\s*[:=]\s*/i;
const PUBLISHER =
  /(?:^|[\s.,])(?:press|publishers?|publishing|publications?|verlag|editions?|imprint|gmbh|llc|ltd|inc|corp(?:oration)?|издательств[оа])(?:[\s.,]|$)|\buniversity press\b/iu;
// Case-SENSITIVE on purpose: «Association for Computing Machinery» is a proper
// noun, «association rule mining» is a subject term, and the capital letters
// are the whole of the difference. Adding /i here would throw away the
// distinction and take a real subject term with it.
const ORG_PHRASE =
  /\b(?:Association|Society|Institute|Academy|Federation|Council|Committee|Foundation|Consortium)\s+(?:for|of)\s+\p{Lu}/u;
const IDENTIFIER =
  /https?:\/\/|www\.|\b10\.\d{4,9}\/|\b(?:doi|isbn|issn|arxiv|orcid)\b|@|\.(?:pdf|docx?|tex|indd|epub|dotm?)\b|[\\/]\w+[\\/]/i;
const TOOLJUNK = /^(?:untitled|microsoft\s+word|adobe|latex|pdftex|normal|document\s*\d*|без\s*названи\w*)/i;
const TAG_MAX_CHARS = 40;
const TAG_MAX_WORDS = 5; // more than five words is a sentence, not a heading
const TAG_MIN_LETTERS = 0.6; // share of non-space characters that must be letters

/// The tag this piece really is, or null when it is not a tag at all.
function tagOk(raw: string): string | null {
  const s = flat(raw).replace(/^[-•*\s]+/, "").replace(LABEL, "").trim();
  if (s.length < 2 || s.length > TAG_MAX_CHARS) return null;
  const words = s.split(/\s+/);
  if (words.length > TAG_MAX_WORDS) return null;
  if (/[:=]/.test(s)) return null; // a Key: Value whose key was not a known label
  if (IDENTIFIER.test(s)) return null; // URL, DOI, ISBN, e-mail, path, file name
  if (TOOLJUNK.test(s)) return null; // toolchain and placeholder junk
  if (PUBLISHER.test(s) || ORG_PHRASE.test(s)) return null; // an imprint or an organisation
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  const solid = s.replace(/\s/g, "").length;
  if (!letters || letters / solid < TAG_MIN_LETTERS) return null; // a bare number or a code
  // Function words only — a fragment of the sentence around the real keywords.
  if (words.every((w) => STOP.func.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")))) return null;
  return s;
}

function splitTags(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(/[;,\n\r\t]|\s{3,}/)) {
    const tag = tagOk(piece);
    if (tag === null) continue;
    // Folded, so «knowledge graph» and «knowledge graphs» cannot both become
    // tags of the same book — a tag is a subject, and those are one subject.
    const k = conceptId(tag);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// ---- the deep pass's memory of the seed -------------------------------------
//
// deepen() is handed a Shard and nothing else — the frozen contract gives it
// no PDFDocumentProxy — but the topics call wants the book's opening pages and
// its contents list, which only the seed pass ever read. Rather than widen the
// shard schema with two fields nobody else needs (and which would then be
// written to disk for every book in the library), the seed leaves them in a
// small session cache here. A cold cache — deepen() run against a shard built
// before the app restarted — is not an error: topicsFor() falls back to what
// the shard itself carries, and the model gets a thinner but honest brief.
//
// The book's detected LANGUAGE rides along for the same reason, and this time
// the reason is not a preference. A Shard cannot carry it at all: graphstore's
// parseShard rebuilds every shard it reads field by field from a fixed list, so
// a `lang` written here would be silently dropped the next time the file was
// read — a field that is true in memory and absent on disk is worse than no
// field. Teaching parseShard about it is graphstore's change to make, not this
// module's, and it is emphatically NOT worth bumping graphstore's `version`
// for: that bump blanks every shard in the reader's library until each book has
// been read again. So the seed remembers it, and the one consumer — the write
// back into the term store, which stamps the language on the glossary's sidecar
// — simply says nothing about the language when the cache is cold, which
// glossarygen already reads as «keep whatever the sidecar said».

type SeedContext = { front: string; toc: string; lang: BookLang };
const CONTEXT_CACHE = 32;
const contexts = new Map<string, SeedContext>();

function rememberContext(key: string, ctx: SeedContext): void {
  contexts.delete(key); // re-insert so the eviction below is least-recently-written
  contexts.set(key, ctx);
  while (contexts.size > CONTEXT_CACHE) {
    const oldest = contexts.keys().next().value;
    if (oldest === undefined) break;
    contexts.delete(oldest);
  }
}

const FRONT_CHARS = 1500; // roughly a page and a half of prose
const TOC_CHARS = 600;

/// Outline headings, flattened to one line. Only the top two levels: a deep
/// outline is mostly numbered subsections and says less about the subject
/// matter than the chapter names it buries.
async function outlineHeadings(doc: PDFDocumentProxy): Promise<string> {
  type Item = { title?: unknown; items?: Item[] };
  const items = ((await doc.getOutline().catch(() => null)) ?? []) as Item[];
  const out: string[] = [];
  const walk = (list: Item[], depth: number): void => {
    for (const it of list) {
      const title = flat(str(it.title));
      if (title && title.length <= 80) out.push(title);
      if (out.length >= 40) return;
      if (depth < 1 && it.items?.length) walk(it.items, depth + 1);
    }
  };
  walk(items, 0);
  const line = out.join(" · ");
  return line.length > TOC_CHARS ? `${line.slice(0, TOC_CHARS - 1)}…` : line;
}

// ---- the seed pass ----------------------------------------------------------

/// Everything one book contributes to the graph without any model at all:
/// provenance, title, authors, year, the tags its own metadata declares, the
/// terms of the reader's own glossary if there is one, and a mined concept
/// list with the pages each concept was met on.
///
/// Deterministic, and quick in the sense that matters: no model, no network,
/// one linear read of the pages behind a progress bar that counts them —
/// measured at about 7 ms a page, so two seconds for an ordinary book and six
/// for the largest one this was tested on. It does NOT write the shard:
/// graphstore is the writer, and a build that seeds and then deepens must
/// write the seed first, or the book stays invisible for as long as the model
/// runs.
///
/// `onProgress` reports the «seed» phase only. It never reports «done»,
/// because the caller owns the end of the job and a seed is normally followed
/// by a deep pass — a momentary «готово» between the two would be a lie.
export async function seedShard(
  doc: any /* PDFDocumentProxy */,
  bookPath: string,
  key: string,
  onProgress: (p: GenProgress) => void,
  signal: AbortSignal,
): Promise<Shard> {
  const pdf = doc as PDFDocumentProxy;
  const total = Math.max(1, pdf.numPages);

  // The classifier reads the first three pages and the last one; the miner
  // reads the book. Overlapping pages are read once.
  const front = [1, 2, 3].filter((n) => n <= total);
  const back = total > 3 ? total : 0;
  const sample = samplePages(total, MINE_PAGES_MAX);
  const sampleSet = new Set(sample);
  const wanted = [...new Set([...front, ...(back ? [back] : []), ...sample])].sort((a, b) => a - b);
  const floor = sampleFloor(sample.length, total);

  // ---- what language is this book in ----------------------------------------
  //
  // It has to be answered BEFORE the first page is counted, because the answer
  // picks the stoplists the miner counts with, and it has to be answered from a
  // SPREAD of the book rather than from its opening: a title page, a copyright
  // block and a contents list are what pages 1 to 3 are, and booklang answers
  // «und» to all three by design.
  //
  // Both of those are satisfied without reading a single page twice. The
  // detection pages are chosen out of the mining sample — indices into it, so
  // they are pages this pass was always going to read — and their paragraphs
  // are carried forward into the loop below instead of being dropped and
  // extracted again. glossarygen re-reads its own detection pages, and can
  // afford to: it has no page-ordering constraint and reads every page anyway.
  // Here the pages must reach the miner in ascending order, so the carrier is
  // both the cheaper answer and the only one that keeps the order.
  //
  // What is held is bounded by LANG_PAGES, not by the book: sixteen pages of
  // paragraphs, a few tens of kilobytes, each dropped the moment the loop
  // reaches it. Weigh that against the 75 MB of n-grams the miner itself holds.
  //
  // The bar is raised before this loop, at zero of the whole read, rather than
  // after it: for a short book these sixteen pages ARE most of the read, and a
  // pass that shows nothing until it is nearly done looks like a pass that has
  // hung.
  onProgress({ phase: "seed", done: 0, total: wanted.length });
  const carried = new Map<number, Paragraph[]>();
  const detectSamples: string[] = [];
  const detectPages = samplePages(sample.length, LANG_PAGES);
  for (let i = 0; i < detectPages.length; i++) {
    if (signal.aborted) abortErr();
    const n = sample[detectPages[i] - 1];
    const ps = await pageParagraphs(pdf, n).catch(() => []);
    carried.set(n, ps);
    // Detection is fed the same pages the miner will be fed — a bibliography is
    // thin in the book's own language and would only dilute the vote.
    if (ps.length && !isCitationPage(ps)) detectSamples.push(paraText(ps));
    if (i % 8 === 7) await tick(); // same breathing room the main loop takes
  }
  // UND — «I will not guess» — is a normal answer and not a failure. Almost
  // always it means a language booklang does not vote on (Swedish, Turkish,
  // Czech), because a book in one it does vote on answers off sixteen pooled
  // pages; the rest is a scan with a broken text layer or a book of formulas,
  // neither of which the miner can do anything with anyway. terms.ts reads UND
  // as «use every curated word there is, AND derive this book's own function
  // words from the book», which is the only thing a miner can do for a grammar
  // it was never taught.
  //
  // The confidence figure is deliberately not kept. Nothing here would do
  // anything different with it: a miner cannot half-apply a stoplist, and a
  // second-guessing threshold on top of booklang's own floors would only be a
  // worse copy of them.
  //
  // The cost of that derived list, measured over 60 pages of this project's own
  // English prose (472 KB, floor 5, cap 120): with the language known it is the
  // old miner term for term, in the same order, and so is UND with the
  // derivation off; with the derivation on, 13 of the 120 move — «book»,
  // «model» and «shard» are each on more than 60 % of these pages, so the rule
  // reads them as grammar and «whole book» and «local model» drop out. That is
  // the trade, and it is the right way round: it is paid only by a book we
  // could not name, and it buys every book in a language we ship no list for.
  const lang = detectBookLang(detectSamples).lang;

  // ---- the miner ------------------------------------------------------------
  //
  // Everything the miner needs is known except one number: the page-spread rule
  // counts pages that SURVIVED the citation filter, which is only settled when
  // the read ends, and MineOptions is fixed when the miner is built. So the
  // first MIN_SPREAD_PAGES minable pages are held as text — four pages, a few
  // kilobytes — and the miner is built the instant the fourth arrives, which is
  // the instant the answer stops being able to change. A book that never gets
  // there is built with the relaxed rule after the loop. Held pages are replayed
  // in the order they were read, so the miner still sees ascending page numbers,
  // which is the whole of its page dedup.
  //
  // The alternative — deciding the rule from the page COUNT, as glossarygen
  // does — is wrong here for the same reason the rule exists: this pass reads a
  // sample and drops citation pages out of it, so a hundred-page document can
  // easily have three minable pages, and that is exactly the document the
  // relaxed rule is for.
  let miner: TermMiner | null = null;
  const held: { page: number; text: string }[] = [];
  const buildMiner = (minPages: number): TermMiner => {
    const m = createMiner({ lang, cap: SEED_TERMS, minFreq: floor, minPages, withPages: true });
    for (const p of held) m.addPage(p.page, p.text);
    held.length = 0;
    return m;
  };

  // Only the classifier's own pages are RETAINED. The miner consumes each page
  // as it is read and drops it: a whole 838-page book's paragraphs held at once
  // is megabytes of strings kept alive for the sake of a second loop that reads
  // each page exactly once, and this pass now runs over books of that size.
  const paras = new Map<number, Paragraph[]>();
  const keep = new Set([...front, ...(back ? [back] : [])]);
  let mined = 0;
  let read = 0;
  for (const n of wanted) {
    if (signal.aborted) abortErr();
    // A page whose text layer is broken is one page missing from the sample,
    // never a failed build: the reader would rather have most of a book in the
    // graph than an error where the book should be. `has`, not `??`: a carried
    // page whose text layer was broken is an empty array, and `??` would send
    // us back to pdf.js to be told so a second time.
    const ps = carried.has(n) ? carried.get(n)! : await pageParagraphs(pdf, n).catch(() => []);
    carried.delete(n);
    if (keep.has(n)) paras.set(n, ps);
    // A page that reads as a reference list or a back-of-book index is skipped
    // whole rather than filtered term by term. `wanted` is ascending, which is
    // the whole of the miner's page dedup.
    if (sampleSet.has(n) && ps.length && !isCitationPage(ps)) {
      const text = paraText(ps);
      mined++;
      if (miner) miner.addPage(n, text);
      else {
        held.push({ page: n, text });
        if (mined >= MIN_SPREAD_PAGES) miner = buildMiner(2);
      }
    }
    onProgress({ phase: "seed", done: ++read, total: wanted.length });
    if (read % 8 === 0) await tick();
  }
  // A concept has to turn up on more than one of the pages actually read —
  // unless so few of them survived the citation filter that «more than one
  // page» would mean «almost all of them», which a four-page article cannot
  // satisfy without going empty.
  const counts = miner ?? buildMiner(1);
  const terms = counts.finish();

  const info = (await pdf
    .getMetadata()
    .then((m) => (m?.info ?? {}) as unknown as Record<string, unknown>)
    .catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;

  const frontText = front.map((n) => paraText(paras.get(n) ?? [])).join("\n");
  const backText = back ? paraText(paras.get(back) ?? []) : "";

  const meta: Meta = {
    title: str(info.Title),
    author: str(info.Author),
    subject: str(info.Subject),
    keywords: str(info.Keywords),
    producer: str(info.Producer),
    creator: str(info.Creator),
  };
  const verdict = classify({ pages: total, meta, front: frontText, back: backText });

  // Title: what the file says about itself, when that is not a file name or a
  // typesetter's artefact; otherwise the biggest type on page one; otherwise
  // the file name, which at least the reader recognises.
  const page1 = paras.get(1) ?? [];
  const titlePara = biggestParagraph(page1);
  const title =
    usableTitle(meta.title ?? "") ||
    (titlePara ? flat(titlePara.text).slice(0, 200) : "") ||
    baseName(bookPath).replace(/\.[^.]+$/, "");

  // Authors: the metadata field, plus — for an article, where the byline is
  // printed under the title and the Info dictionary is usually empty — the
  // first name-shaped line below the title.
  const authors = splitAuthors(meta.author ?? "");
  if (verdict.prov === "article" && titlePara) {
    const below = page1
      .filter((p) => p.y > titlePara.y && p.fh <= titlePara.fh)
      .sort((a, b) => a.y - b.y)
      .slice(0, 3);
    const line = below.find((p) => looksLikeAuthors(p.text));
    if (line) for (const a of splitAuthors(line.text)) if (!authors.some((x) => normId(x) === normId(a))) authors.push(a);
  }

  const bookId = `b:${key}`;
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  // Authors first, so a mined term that happens to spell an author's name
  // lands on the person node instead of shadowing it with a «term».
  //
  // Their ids are kept, because whom a book is BY is the metadata's claim and
  // the strongest evidence in this pass. Nothing weaker may re-type one — not
  // the glossary's kind below, and not the model's answer in applyDeep, which
  // pins the same set for the same reason.
  const authorIds = new Set<string>();
  for (const name of authors) {
    const id = `n:${normId(name)}`;
    if (!normId(name) || nodes.has(id)) continue;
    nodes.set(id, { id, kind: "person", label: name, books: [key], weight: 1 });
    authorIds.add(id);
    edges.push({ a: bookId, b: id, rel: "by", weight: 1 });
  }

  // The authors again, indexed by the key a bare mention of their surname in
  // the running text would fold to — see surnameOf above for why this index
  // exists at all. Two keys per author, because a mined label reaches
  // addConcept through conceptId, which folds a trailing -s: «Baeza-Yates»
  // arrives as «baeza yate», while a surname the fold leaves alone arrives as
  // its own normId. Storing both is cheaper than guessing which.
  //
  // A key two different authors would claim maps to null instead of an id: two
  // people who share a surname cannot be told apart BY that surname, so the
  // mention stays a node of its own rather than being welded onto whichever
  // author happened to be listed first.
  const bySurname = new Map<string, string | null>();
  for (const name of authors) {
    const sn = surnameOf(name);
    const authorNodeId = `n:${normId(name)}`;
    if (!sn || !usableSurname(sn) || !nodes.has(authorNodeId)) continue;
    for (const k of new Set([conceptId(sn), normId(sn)])) {
      if (!k) continue;
      const prior = bySurname.get(k);
      bySurname.set(k, prior === undefined || prior === authorNodeId ? authorNodeId : null);
    }
  }

  // One concept node, or the frequencies and page lists of an id we already
  // have. Two surface forms folded onto one id, a mined term that spells an
  // author's name, and a glossary term the miner also found are all the same
  // case: one concept, so the frequencies add and the page lists merge —
  // assigning would silently drop whichever half was seen first.
  //
  // `kind` and `gloss` are what the reader's term store knows and the miner
  // does not, and they are OPTIONAL because the miner's own terms arrive
  // without them. What they are allowed to do is written down in `known` below.
  let concepts = 0;
  const counted = new Set<string>();

  /// Apply what the term store said about a term to the node that carries it.
  ///
  /// The kind goes through guardKind exactly like a model's answer, and for the
  /// same reason: it CAME from a model — glossarygen's enrichment pass types
  /// terms with the same 4B model and the same six-word vocabulary — and a 4B
  /// model cannot hold that vocabulary steady. A glossary line that says
  /// «recommender systems :: work» would otherwise put a wrongly coloured node
  /// in a picture the reader is looking at, which is the whole reason the guard
  /// exists.
  ///
  /// An author is untouchable. The metadata said this is a person and a
  /// glossary line does not outrank it; applyDeep pins the same nodes against
  /// the model for the same reason.
  ///
  /// A gloss already on the node is never overwritten, so the first term store
  /// line to reach an id owns it — which matters only when two spellings fold
  /// onto one node, and is the same rule mergeRecords uses at the other end.
  const known = (n: GraphNode, kind: NodeKind | undefined, gloss: string): void => {
    if (authorIds.has(n.id)) return;
    if (kind) n.kind = guardKind(kind, n.label);
    if (gloss && !n.gloss) n.gloss = gloss;
  };

  const addConcept = (
    label: string,
    freq: number,
    pages: number[],
    statKey: string,
    kind?: NodeKind,
    gloss = "",
  ): void => {
    // conceptId, not normId: graphstore's contract is that a term's node id is
    // the FOLDED key, so «IR systems» and «IR system» — both of which a
    // whole-book mine finds, and both of which this book's glossary lists —
    // are one node here rather than two that graphstore has to heal on the way
    // back in.
    const nid = conceptId(label);
    if (!nid) return;
    // The SAME underlying count arriving twice — a glossary term the miner
    // also found, which once both read the whole book is most of them — is one
    // concept met once, not two concepts met once each. Counting it twice
    // doubled the node's weight and hung a second «mentions» edge on the book,
    // and weight is what the drawing, the ordering and the co-occurrence cap
    // all read. Two DIFFERENT counts folding onto one id (two surface forms,
    // or a term that spells an author's name) do still add: that is a concept
    // genuinely met that often.
    const fresh = !statKey || !counted.has(statKey);
    if (statKey) counted.add(statKey);
    const id = `n:${nid}`;
    // A person's id is normId(label), never the fold — «John Williams» and
    // «John William» are two people. So a mined term that spells an author's
    // name has to be looked for under BOTH keys, or the «authors first» rule
    // above stops working and the author gets a second, «term» node beside the
    // person node. (A found person node keeps its own id; only its weight and
    // pages grow.)
    // A mined mention of an author's own surname is that author. It has to be
    // looked for FIRST, and under its own key: the surname's folded id
    // («baeza yate») has nothing in common with the author's («ricardo baeza
    // yates»), so neither of the two lookups below can ever find it, and the
    // node it would otherwise create is a second person for one human being.
    // A null here is the ambiguous case built above — two authors, one surname
    // — and it deliberately falls through to the ordinary path.
    const sn = bareSurname(label);
    let authorId: string | null | undefined;
    // `has`, not `??`: an ambiguous key is stored as null, and `??` would step
    // straight past it to the other spelling and merge anyway.
    if (sn) {
      const folded = conceptId(sn);
      authorId = bySurname.has(folded) ? bySurname.get(folded) : bySurname.get(normId(sn));
    }
    const author = typeof authorId === "string" ? nodes.get(authorId) : undefined;
    const existing = author ?? nodes.get(id) ?? nodes.get(`n:${normId(label)}`);
    if (existing) {
      const seen = [...new Set([...(existing.pages?.[key] ?? []), ...pages])].sort((a, b) => a - b);
      existing.pages = { [key]: seen.slice(0, MAX_PAGES_PER_TERM) };
      // BEFORE the early return below, and that ordering is the point. A
      // glossary term the miner also found is the common case — once both have
      // read the whole book it is most of them — and that is precisely the term
      // whose count arrives twice, so a `known` call after the return would
      // silently never type the terms it exists for.
      known(existing, kind, gloss);
      if (!fresh) return;
      existing.weight += freq;
    } else {
      if (concepts >= MAX_CONCEPTS) return;
      concepts++;
      const node: GraphNode = {
        id,
        // The deep pass types it; until then everything the miner found is a
        // term. A term store line that says otherwise is applied on the next
        // line — see `known` for what it is and is not allowed to change.
        kind: "term",
        label,
        books: [key],
        weight: freq,
        pages: { [key]: pages },
      };
      known(node, kind, gloss);
      nodes.set(id, node);
    }
    // `existing.id`, not `id`: the node found may be an author's person node,
    // whose id is the unfolded one. An edge to `id` would then point at a node
    // that is not in this shard, and graphstore drops dangling edges — the
    // book would silently lose the mention.
    edges.push({ a: bookId, b: existing?.id ?? id, rel: "mentions", weight: freq });
  };

  // What the book itself said, ranked. `pages` is present because the miner was
  // asked for it; the `?? []` is the type saying so rather than a real case.
  for (const m of terms) addConcept(m.term, m.freq, m.pages ?? [], m.key);

  // The reader's own term store for this book, if there is one — free quality.
  // The expensive pass has ALREADY RUN for another feature: the glossary read
  // every page of this book with the very miner used above, at its own
  // thresholds, and the reader then curated the result by hand while
  // translating. Reading that file is one 6 KB read and it hands this graph a
  // term list nothing here could afford to compute twice.
  //
  // Three things make the merge cheap as well as free. The term side is the
  // book's own language, exactly like a mined label, so the two lists fold
  // together on normId with no translation involved. A glossary term's weight
  // and pages do not need a second scan of the book: the miner counted every
  // n-gram it met, so a glossary term is almost always already in the counts —
  // it simply lost to the cap or the floor — and its true frequency and page
  // numbers are waiting there under its own key. Only a term longer than MAX_N
  // tokens, or one that straddles a clause boundary, misses; that node joins the
  // graph wired to the book alone, which is still a node the reader can search
  // for and a term the deep pass will gloss.
  //
  // And the third is new, and it is what makes this one store rather than two
  // features that happen to read the same file: the record carries a KIND and a
  // DEFINITION. A node the seed could previously only leave as an untyped,
  // unglossed «term» arrives coloured and explained, before any model has run
  // — which is also the state the reader is left in when they have no aux model
  // at all, and it is the honest one to leave them in.
  for (const rec of await glossaryRecords(bookPath)) {
    const { key: statKey, freq, pages } = counts.lookup(rec.term);
    addConcept(rec.term, freq || 1, pages, statKey, rec.kind, glossOf(rec.definition));
  }

  // The book node itself is synthesised by graphstore's merge from these very
  // fields, so writing one here would only shadow it with a stale copy.

  const tags = splitTags(`${meta.keywords ?? ""}\n${meta.subject ?? ""}`);

  rememberContext(key, {
    front: frontText.length > FRONT_CHARS ? `${frontText.slice(0, FRONT_CHARS)}…` : frontText,
    toc: await outlineHeadings(pdf).catch(() => ""),
    lang,
  });

  // A verdict the reader corrected by hand outranks the classifier for ever.
  // Re-seeding a book must not argue back with them; only an explicit rebuild,
  // which deletes the shard first, starts the classification over.
  const prior = await loadShard(key).catch(() => null);
  const fixed = prior?.provFixed === true;

  return {
    version: 1,
    gen: GRAPH_GEN,
    key,
    bookPath,
    title,
    authors,
    year: findYear(frontText, backText, info),
    prov: fixed ? prior!.prov : verdict.prov,
    provFixed: fixed,
    evidence: fixed ? prior!.evidence : verdict.evidence,
    stage: "seed",
    engine: "none",
    tags,
    summary: "",
    pages: total,
    nodes: [...nodes.values()],
    edges,
    updated: Date.now(),
  };
}

// ---- model availability -----------------------------------------------------

/// Are the aux model's weights on disk? null outside Tauri, where nothing can
/// be probed. Invoked directly rather than through ModelSetup.modelFileReady:
/// that module is the download UI, and an engine module that imports it drags
/// React and a subscription store into every background build.
async function auxWeightsReady(): Promise<boolean | null> {
  try {
    const st = await invoke<{ file_ready: boolean }>("model_download_status", {
      model: "aux",
      destDir: undefined,
    });
    return st.file_ready;
  } catch {
    return null;
  }
}

/// Could the aux terminologist be brought up at all — weights present and
/// llama.cpp installed? Starts nothing.
async function auxStartable(): Promise<boolean> {
  const [weights, engine] = await Promise.all([auxWeightsReady(), engineStatus()]);
  if (weights === true && engine.installed) return true;
  // Outside Tauri neither probe can answer, and a reader running their own
  // llama-server on the aux port is invisible to both. One short health probe
  // settles both cases without starting anything.
  return isAuxUp(AUX_PROBE_MS);
}

/// Is a deep pass possible for a document with this provenance? Answers in
/// well under a second and starts nothing — the build queue asks it before
/// every book, and a queue that spun up a model to find out whether it could
/// spin up a model would be unusable.
export async function canDeepen(prov: Provenance): Promise<boolean> {
  // An article can be deepened by EITHER model, so this must ask about both.
  // Demanding Claude Code alone made graphrun.build refuse the book before
  // deepen() was ever called, and deepen()'s own fallback — Claude first, the
  // local model when Claude returns nothing — could therefore never run: a
  // reader with llama.cpp and the aux weights but no Claude Code got a full
  // graph for every licensed book and «без модели» for every arXiv or
  // Creative-Commons PDF, permanently stuck at stage «seed», with a model
  // installed the whole time.
  //
  // And when the reader has not turned the Claude pass on, an article is a
  // local job outright, so Claude's presence must not count here either — this
  // gate has to report exactly what deepen() will actually attempt, or a book
  // is either refused work it could do or re-extracted on every scan for work
  // it cannot.
  if (prov === "article") {
    if (!claudeDeepen()) return auxStartable();
    return (await claudeStatus()).installed || auxStartable();
  }
  return auxStartable();
}

/// Wait until the aux server can actually ANSWER, not merely until something
/// is listening on its port. This function is the whole of the fix for an
/// empty deep pass, and the distinction it draws is the defect:
///
/// llama-server binds the port BEFORE the model finishes loading, and answers
/// every request in that window with 503 «Loading model». The Rust side's
/// port_open() is a bare TcpStream::connect, so it reports the server as «up»
/// the instant the socket exists. Measured on the reader's own machine, with
/// this app's exact spawn arguments and the 2.5 GB GGUF already in the page
/// cache: the port opened at 0.33 s and /health first answered 200 at 3.08 s —
/// a 2.75-second window, and on a cold read it is the 10-30 s the constant
/// above is sized for. Trusting the status word inside that window sent the
/// topics call straight into a 503, which auxComplete turns into a throw; the
/// pass gave up, the type pass never ran, and applyDeep stamped stage «deep»
/// on a shard that had learnt nothing — after which graphrun's «already deep»
/// check skipped the book on every future scan, for ever.
///
/// So the status word is only ever taken as permission to start probing.
async function waitHealthy(deadline: number, signal: AbortSignal): Promise<boolean> {
  for (;;) {
    if (signal.aborted) abortErr();
    if (await isAuxUp(AUX_HEALTH_MS)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(AUX_POLL_MS, signal);
  }
}

// Bring the on-demand aux server (Qwen3.5-4B on 11545) up. Resolves false when
// it cannot come up; the caller then keeps the seed shard. Modelled on
// GlossaryPanel's ensureAux, which is private to that component — the same
// status vocabulary, the same 90s ceiling so a build never hangs on a load.
async function startAux(signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + AUX_START_MS;
  let s: string;
  try {
    s = await invoke<string>("aux_model_start");
  } catch {
    return waitHealthy(deadline, signal); // plain browser: only the HTTP probe can answer
  }
  for (;;) {
    if (signal.aborted) abortErr();
    // «up» and «external» mean the port is open, which is not the same as the
    // model being loaded — see waitHealthy. Both therefore end in a health
    // probe, and «external» especially so: a server the reader started by hand
    // one second ago is reported «external» while it is still reading weights.
    if (s === "up" || s === "external") return waitHealthy(deadline, signal);
    if (s === "dead" || s === "none") return false;
    if (Date.now() >= deadline) return false;
    await sleep(1500, signal); // "starting"
    try {
      s = await invoke<string>("aux_model_status");
    } catch {
      return waitHealthy(deadline, signal);
    }
  }
}

// ---- reply gates ------------------------------------------------------------
//
// Same idea as glossarygen's plausible()/junky() pair, aimed at a line format
// instead of a single term. A gate that rejects the WHOLE reply is cheaper
// than one that rejects lines: a model which lost the format lost it for every
// line, and half a malformed reply is worse than a retry.

// Kana and CJK ideographs, spelled as escapes rather than as the characters
// themselves so the range survives every editor and diff this file passes
// through.
const CJK_RE = /[\u3040-\u30ff\u4e00-\u9fff]/g;

// Did the reply come back in the alphabet the reader reads? Qwen answers in
// Chinese often enough that this is a real gate and not a formality, and a
// Russian reader asking for Russian glosses and getting English ones has been
// failed just as squarely.
function alphabetOk(text: string, lang: Lang): boolean {
  if (!text) return false;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  if (cjk > text.length * 0.05) return false;
  return lang === "ru" ? /[А-Яа-яЁё]/.test(text) : /[A-Za-z]/.test(text);
}

// Whole-reply rejection: empty, a runaway far longer than the answer could
// legitimately be, the instructions recited back, the separator gone, or the
// wrong alphabet. `perItem` is the character budget one answer line may take.
function replyRejected(raw: string, items: number, perItem: number, needSep: boolean): boolean {
  const text = raw.trim();
  if (!text) return true;
  if (text.length > 400 + items * perItem) return true;
  for (const marker of prompts().echo) if (text.includes(marker)) return true;
  if (needSep && !text.includes(SEP)) return true;
  return !alphabetOk(text, getLang());
}

// One gloss, tidied and then judged. Rejection returns "" — the node keeps its
// label and loses only the one line of prose, which is the failure a reader
// can live with.
function cleanGloss(raw: string, term: string, lang: Lang): string {
  let g = flat(raw.split(/\n/)[0] ?? "");
  const quoted = g.match(/^[«"“'‘]+(.+?)[»"”'’]+$/);
  if (quoted) g = quoted[1].trim();
  g = g.replace(/^[-–—:•*\s]+/, "").trim();
  // one sentence: the format asked for one, and a model that wrote three has
  // written a paragraph into a field the panel renders on a single line
  const stop = g.search(/[.!?](?:\s|$)/);
  if (stop > 20) g = g.slice(0, stop + 1);
  g = flat(g);
  if (!g || g.length > GLOSS_MAX) return "";
  if (g.includes(SEP)) return ""; // the line's own format leaked into the field
  if (!/[\p{L}\p{N}]/u.test(g)) return "";
  if (conceptId(g) === conceptId(term)) return ""; // the term echoed back is not a gloss
  if (!alphabetOk(g, lang)) return "";
  return g;
}

type Typed = { kind: NodeKind; gloss: string };

// Parse «term :: type :: gloss» lines against the terms actually asked about.
// A term the model invented is dropped (it names nothing in the book); a term
// it skipped keeps the caller's fallback. Numbering and bullet prefixes are
// tolerated because every model adds them eventually.
function parseTyped(raw: string, asked: readonly string[]): Map<string, Typed> {
  const lang = getLang();
  // Indexed by the FOLDED key. A model handed «IR systems» answers about «IR
  // system» often enough that matching on normId alone silently dropped its own
  // answer — the term was asked about, the reply was correct, and the line went
  // in the bin for a plural.
  const byNorm = new Map<string, string>();
  for (const term of asked) {
    const k = conceptId(term);
    if (k) byNorm.set(k, term);
  }
  const out = new Map<string, Typed>();
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*(?:[-*•]\s+|\d{1,2}[.)]\s+)/, "").trim();
    if (!cleaned.includes(SEP)) continue;
    const parts = cleaned.split(/\s*::\s*/);
    if (parts.length < 2) continue;
    const term = byNorm.get(conceptId(parts[0]));
    if (term === undefined || out.has(term)) continue;
    // Guarded against the label the model was actually asked about, not the
    // one it echoed back: a model that "helpfully" recapitalises a term must
    // not be able to talk itself into a proper-noun kind.
    const kind = guardKind(TYPES.get(flat(parts[1]).toLowerCase()) ?? "term", term);
    const gloss = parts.length > 2 ? cleanGloss(parts.slice(2).join(SEP_SPACED), term, lang) : "";
    out.set(term, { kind, gloss });
  }
  return out;
}

type Head = { tags: string[]; summary: string };

// The two-line head of a topics reply. Both labels are accepted in either
// language: a model asked in Russian sometimes answers with the English label
// and the Russian text, and refusing that would throw away a good answer over
// a word.
const TAGS_LINE = /^[ \t]*(?:ТЕМЫ|ТЕМА|TOPICS|TAGS)[ \t]*[:：][ \t]*(.+)$/im;
const SUMMARY_LINE = /^[ \t]*(?:СВОДКА|ИТОГ|SUMMARY)[ \t]*[:：][ \t]*([\s\S]+?)(?:\n\s*\n|$)/im;
const SUMMARY_MAX = 400;

function parseHead(raw: string): Head {
  const lang = getLang();
  const tagsM = raw.match(TAGS_LINE);
  const sumM = raw.match(SUMMARY_LINE);
  const tags = tagsM ? splitTags(tagsM[1]).slice(0, 8) : [];
  let summary = sumM ? flat(sumM[1]) : "";
  // A summary that lost the alphabet, said nothing, or ran on past a paragraph
  // is no summary; the seed's empty one is more honest than a bad one.
  if (summary.length > SUMMARY_MAX) summary = "";
  if (summary.split(/\s+/).length < 4 || !alphabetOk(summary, lang)) summary = "";
  return { tags, summary };
}

// ---- the local pass ---------------------------------------------------------

const briefOf = (shard: Shard, ctx: SeedContext | undefined, terms: readonly string[]): Brief => ({
  title: shard.title || baseName(shard.bookPath),
  authors: shard.authors.join(", ") || "—",
  tags: shard.tags.join(", ") || "—",
  toc: ctx?.toc || "—",
  // Cold cache (a shard from before the app restarted): the mined terms are
  // the only description of the book still available, and they describe it
  // better than nothing does.
  front: ctx?.front || terms.slice(0, 30).join(", "),
});

const topicsBudget = 420;
const typeBudget = (n: number): number => Math.min(1800, 180 + n * 110);

// Several attempts, as glossarygen does: 0.2 is near-deterministic, so an
// identical retry would fail identically — every attempt after the first is
// warmer.
//
// An HTTP failure used to end the call outright, on the reasoning that «the
// server went away mid-run and a second attempt cannot help». That reasoning
// is wrong about the commonest failure there is: llama-server answers 503
// while it is still loading the model, and that is precisely the case where
// waiting and asking again DOES help — it is the same server, it is coming up,
// and it will answer in seconds. So a failure now costs a pause and another
// try, and only a server that fails its own /health probe afterwards is
// treated as gone. (auxComplete raises a plain Error for every non-ok status,
// so there is nothing here to tell 503 from 500; the health probe is what
// distinguishes them, and it costs one request.)
async function auxAttempts(
  messages: ChatMessage[],
  maxTokens: number,
  signal: AbortSignal,
  accept: (raw: string) => boolean,
): Promise<string | null> {
  for (let attempt = 0; attempt < AUX_TRIES; attempt++) {
    if (signal.aborted) abortErr();
    try {
      const raw = await auxComplete(messages, signal, { temperature: attempt === 0 ? 0.2 : 0.7, maxTokens });
      if (accept(raw)) return raw;
    } catch (e) {
      if (isAbortErr(e) || signal.aborted) throw e;
      if (attempt === AUX_TRIES - 1) return null;
      await sleep(AUX_RETRY_MS, signal);
      if (!(await isAuxUp())) return null; // genuinely gone: stop, do not grind
    }
  }
  return null;
}

async function topicsPass(shard: Shard, terms: readonly string[], signal: AbortSignal): Promise<Head> {
  const p = prompts();
  const brief = briefOf(shard, contexts.get(shard.key), terms);
  const raw = await auxAttempts(
    [
      { role: "system", content: p.topicsSystem },
      { role: "user", content: p.topicsUser(brief) },
    ],
    topicsBudget,
    signal,
    (r) => !replyRejected(r, 1, 900, false) && (TAGS_LINE.test(r) || SUMMARY_LINE.test(r)),
  );
  return raw === null ? { tags: [], summary: "" } : parseHead(raw);
}

// Terms in chunks of TYPE_CHUNK through a pool of three workers over a shared
// cursor, each writing into a pre-sized slot, so the output order is the input
// order however the replies interleave.
async function typePass(
  shard: Shard,
  terms: readonly string[],
  onProgress: (p: GenProgress) => void,
  signal: AbortSignal,
): Promise<Map<string, Typed>> {
  const p = prompts();
  const brief = briefOf(shard, contexts.get(shard.key), terms);
  const chunks: string[][] = [];
  for (let i = 0; i < terms.length; i += TYPE_CHUNK) chunks.push(terms.slice(i, i + TYPE_CHUNK));

  const out: (Map<string, Typed> | null)[] = chunks.map(() => null);
  let next = 0;
  let done = 0;
  onProgress({ phase: "types", done: 0, total: chunks.length });

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted) abortErr();
      const k = next++;
      if (k >= chunks.length) return;
      const chunk = chunks[k];
      const raw = await auxAttempts(
        [
          { role: "system", content: p.typeSystem },
          { role: "user", content: p.typeUser(brief, chunk) },
        ],
        typeBudget(chunk.length),
        signal,
        (r) => !replyRejected(r, chunk.length, 260, true),
      );
      out[k] = raw === null ? new Map() : parseTyped(raw, chunk);
      onProgress({ phase: "types", done: ++done, total: chunks.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, chunks.length)) }, worker));

  const merged = new Map<string, Typed>();
  for (const part of out) if (part) for (const [term, typed] of part) merged.set(term, typed);
  return merged;
}

// ---- the Claude pass --------------------------------------------------------

// graph_claude has no per-call handle on this side, so an abort cancels
// «whatever graph call is in flight» — which is this one, because the build
// queue never runs two graph builds at once. The listener is removed in the
// `finally`, so a finished call leaves nothing attached to the signal.
async function claudeCall(prompt: string, system: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) abortErr();
  let stop = (): void => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        invoke("graph_claude_cancel").catch(() => {});
        reject(new DOMException("graph generation aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      stop = () => signal.removeEventListener("abort", onAbort);
      invoke<string>("graph_claude", { prompt, systemPrompt: system }).then(resolve, reject);
    });
  } finally {
    stop();
  }
}

// One call for the whole document. Note what is NOT in the prompt: the pages.
// The provenance verdict licences sending this document's text away, and we
// still send only the title, the authors, the tags and the mined term list —
// the model has to name what the terms denote, not read the paper, and a
// build that shipped page text would cost a hundred times as much for an
// answer of the same shape.
//
// That is not merely an economy, it is the promise this project published:
// README.md:60 and i18n's «gr.claudeHint» tell the reader in both languages
// that what reaches Claude is the title, the authors, the keywords and the
// mined term LABELS, «never the text of its pages». Four things now in this
// module are book-derived prose and are therefore on the far side of that line:
// a Brief's `front` (trimmed page text — which is why claudeUser reads four of
// the Brief's five fields and topicsUser, which runs on this machine, reads
// all five), a mined term's sample sentence, a glossary DEFINITION, and a
// node's `gloss`. None of them may be added to `terms` or to the payload
// below. `terms` is `conceptsOf(shard).map(n => n.label)` and must stay a list
// of labels; if a future change wants to send the model more context, the
// context it may send is metadata, not text out of the file.
async function deepenViaClaude(
  shard: Shard,
  terms: readonly string[],
  onProgress: (p: GenProgress) => void,
  signal: AbortSignal,
): Promise<Shard | null> {
  const p = prompts();
  const brief = briefOf(shard, contexts.get(shard.key), terms);
  onProgress({ phase: "topics", done: 0, total: 1 });
  let raw: string;
  try {
    raw = await claudeCall(p.claudeUser(brief, terms), p.claudeSystem, signal);
  } catch (e) {
    if (isAbortErr(e) || signal.aborted) throw e;
    // "busy", "timeout", "claude_not_found: <path>" — raw machine detail from
    // the Rust side, of no use to anybody here. The local path gets its turn.
    console.warn("graph: Claude pass failed, falling back to the local model", e);
    return null;
  }
  onProgress({ phase: "types", done: 0, total: 1 });
  // The separator is demanded only when terms were asked about. With an empty
  // ask — every concept already typed by the reader's term store — the whole
  // legitimate answer is the two head lines, and «no :: in the reply» would
  // reject it for having done exactly what it was asked.
  if (replyRejected(raw, terms.length, 260, terms.length > 0)) return null;
  const typed = parseTyped(raw, terms);
  // Nothing usable came back — let the local model try. Guarded on `terms`
  // because an empty ask has an empty answer by construction: when the term
  // store had already typed every concept, this call was only ever for the
  // head, and it succeeded.
  if (!typed.size && terms.length) return null;
  onProgress({ phase: "types", done: 1, total: 1 });
  return applyDeep(shard, parseHead(raw), typed, "claude", terms.length);
}

// ---- assembling the deep shard ----------------------------------------------

/// Concept nodes this shard contributed, heaviest first. The book node is
/// never among them (graphstore synthesises it), and author nodes are excluded
/// from the typing pass because they are already typed.
function conceptsOf(shard: Shard): GraphNode[] {
  return shard.nodes
    .filter((n) => n.kind !== "book" && !n.id.startsWith("b:"))
    .sort((a, b) => b.weight - a.weight);
}

// Concepts that share a page are related in the way a reader means it, and the
// only page numbers available here are the ones the seed stored — at most
// MAX_PAGES_PER_TERM per concept. That is a sample of the co-occurrence, not
// the whole of it, and it is enough: an edge kept by this function is one two
// concepts earned on a page the reader can actually turn to.
//
// The contract's EdgeRel offers «mentions», «by» and «shares», and nothing
// else. Concept-to-concept relatedness is therefore emitted as «shares», the
// same relation graphstore uses for book-to-book similarity. Reading «shares»
// between two ideas is a stretch; the contract is frozen and other modules
// depend on it, so the stretch stays.
function coOccurrence(key: string, ordered: readonly GraphNode[]): GraphEdge[] {
  const byPage = new Map<number, string[]>();
  for (const n of ordered) {
    for (const page of n.pages?.[key] ?? []) {
      const list = byPage.get(page);
      if (list) list.push(n.id);
      else byPage.set(page, [n.id]);
    }
  }
  const pairs = new Map<string, number>();
  for (const ids of byPage.values()) {
    // `ordered` is heaviest-first, so the cap keeps a page's strongest
    // concepts rather than whichever ones happened to come first.
    const use = ids.slice(0, CO_PER_PAGE);
    for (let i = 0; i < use.length; i++)
      for (let j = i + 1; j < use.length; j++) {
        if (use[i] === use[j]) continue;
        // NUL, not a printable joiner: a concept id is "n:" + conceptId(label),
        // which keeps the spaces inside a multiword label, so anything
        // that can occur in a label would split back into the wrong two ids.
        // graphstore's own edgeKey packs its pairs exactly this way.
        const k = use[i] < use[j] ? `${use[i]}\u0000${use[j]}` : `${use[j]}\u0000${use[i]}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
  }
  return [...pairs]
    .sort((x, y) => y[1] - x[1])
    .slice(0, CO_PAIRS)
    .map(([k, weight]) => {
      const [a, b] = k.split("\u0000");
      return { a, b, rel: "shares" as const, weight };
    });
}

/// Fold a model's answers into the shard — AND decide, from what actually came
/// back, what the shard is now allowed to say about itself.
///
/// Two words on a shard are claims, and both used to be stamped unconditionally
/// here. `stage: "deep"` says «a model has read this book, do not do it again»,
/// and graphrun believes it literally: `if (existing.stage === "deep") return`.
/// `engine: "local"` says «the local model produced this». When the aux server
/// answered 503 to every call, applyDeep was still handed an empty head and an
/// empty typed map, and still wrote both words — so the reader's book ended up
/// with nine bare nodes, no glosses, no summary, and a stamp that made every
/// future scan skip it. Nothing short of an explicit rebuild could ever fix it.
///
/// So «deep» now means what it claims: at least one term came back typed. That
/// is the pass's actual product — a head alone leaves every node a bare «term»
/// with no gloss, which is a seed by any reading. A pass that brought back a
/// head and nothing else still KEEPS the head (tags and a summary are real
/// improvements and are written) and still names the engine that produced it,
/// but leaves the stage at «seed» so a later scan tries again. That pair —
/// engine «local», stage «seed» — is exactly the honest sentence: the local
/// model answered, and this book has not been deepened yet.
///
/// `asked` is how many terms this pass actually put to the model, and it exists
/// because deepen() now skips the terms the reader's own term store had already
/// typed and glossed. When it skipped ALL of them, `typed` comes back empty for
/// a reason that has nothing to do with failure — there was nothing left to ask
/// — and «at least one term came back typed» would be the wrong test: it would
/// leave a fully explained book at stage «seed» for ever, re-read on every scan
/// and never given the tags and summary the topics call just produced. So the
/// rule is «nothing was left to ask, or something came back», which distinguishes
/// the two cases the empty map covers. It cannot be relaxed to «the store had
/// typed some of them»: a type pass that asked about fifty terms and lost the
/// server must still leave the stage at «seed», which is the defect above.
function applyDeep(
  shard: Shard,
  head: Head,
  typed: Map<string, Typed>,
  engine: "local" | "claude",
  asked: number,
): Shard {
  // Whom this book is BY. Those nodes are people on the metadata's authority,
  // which is better evidence than a 4B model reading a term list, so the model
  // may add a gloss to one but never re-type it. Without the pin, the author
  // whose surname the deep pass now asks about (see deepen) could come back a
  // «work» and change colour in the picture.
  const authored = new Set(shard.edges.filter((e) => e.rel === "by").map((e) => e.b));
  const nodes = shard.nodes.map((n) => {
    const hit = typed.get(n.label);
    if (!hit) return n;
    const next: GraphNode = { ...n, kind: authored.has(n.id) ? n.kind : hit.kind };
    // A gloss already on the node is the reader's own sentence and outranks the
    // model's — the same rule seedShard's `known` states at the other end of the
    // merge, and the same one glossOf gives its reason for. At stage «seed» a
    // gloss can have come from nowhere else, and deepen now asks about nodes
    // that HAVE one (a store record with a definition and no kind still needs
    // typing), so without this line the pass would answer the question it was
    // asked — what kind is this — by also overwriting the answer it already had.
    // The known cost is the mirror of the one feedTermStore states below: the
    // node keeps the reader's sentence, so its gloss is unchanged, so nothing is
    // written back and the sidecar does not learn the kind either. The graph is
    // right, the store stays as the reader left it, and «Определить термины»
    // remains the pass that fills a missing kind in.
    if (hit.gloss && !n.gloss) next.gloss = hit.gloss;
    return next;
  });
  const ordered = nodes
    .filter((n) => n.kind !== "book" && !n.id.startsWith("b:"))
    .sort((a, b) => b.weight - a.weight);

  // The book's own «shares» edges are rebuilt, not appended to: a second deep
  // pass over the same shard must replace its co-occurrence, never double it.
  const kept = shard.edges.filter((e) => e.rel !== "shares");

  const tags = splitTags([...shard.tags, ...head.tags].join("\n"));
  const deepened = typed.size > 0 || asked === 0;
  return {
    ...shard,
    // Both passes belong to the same extractor, so the deep write stamps the
    // generation too rather than inheriting whatever the seed carried. That is
    // only honest because graphrun refuses to deepen a shard below the current
    // generation — it re-reads the book from the file instead — so the shard
    // spread here was always seeded by this generation. Deepening an older seed
    // in place would stamp it with mining it never had.
    gen: GRAPH_GEN,
    tags,
    summary: head.summary || shard.summary,
    stage: deepened ? "deep" : "seed",
    engine: deepened || head.tags.length > 0 || head.summary !== "" ? engine : "none",
    nodes,
    edges: [...kept, ...coOccurrence(shard.key, ordered)],
    updated: Date.now(),
  };
}

// ---- back into the term store -----------------------------------------------

/// Write what the deep pass just learned into the reader's glossary for this
/// book, stamped source «graph».
///
/// This is the return leg of the merge seedShard does, and having both is what
/// makes the terminology and the graph ONE store rather than two features that
/// read the same file. The graph is where a model is asked what a term denotes;
/// there is no reason for the glossary panel to ask a second time, and every
/// reason for the two to agree about the same word.
///
/// Three rules, and each of them is about not writing junk into a file the
/// reader edits by hand.
///
///   • A record needs a GLOSS. A kind on its own would append a bare line to
///     the .txt for every term in the book — a hundred and eighty lines of
///     nothing — and the reader would have to delete them. The known cost: a
///     term already in the file, whose kind the model just corrected but which
///     it did not gloss, keeps the old kind in the sidecar.
///   • An author is never written. Those nodes are people on the metadata's
///     authority and they are not terminology.
///   • A gloss the shard already had is not written back, because that gloss
///     came OUT of this file (seedShard's merge) and handing it back would be
///     the two features talking to themselves.
///
/// Two more rules are about writing into the RIGHT file and not overwriting
/// what the reader decided; both are stated where they are enforced, below.
/// The short of it: a write whose book is not identified by content key does
/// not happen at all, and the book's language is filled in only when nobody —
/// no pass, and above all not the reader — has said anything about it yet.
///
/// `pages` rides along; `freq` deliberately does not. A node's weight is a sum
/// over every surface form that folded onto it, and for a node that absorbed an
/// author's surname it also includes the metadata's own count — it is not the
/// frequency of a term, and the sidecar's `freq` field is.
///
/// Never throws and never blocks the build's result: a glossary that could not
/// be written is one feature not improving another, not a failed graph.
async function feedTermStore(next: Shard, seed: Shard): Promise<void> {
  const before = new Map(seed.nodes.map((n) => [n.id, n.gloss ?? ""]));
  const authored = new Set(next.edges.filter((e) => e.rel === "by").map((e) => e.b));
  const out: TermRecord[] = [];
  for (const n of next.nodes) {
    if (authored.has(n.id) || !n.gloss || before.get(n.id) === n.gloss) continue;
    const rec: TermRecord = { term: n.label, definition: n.gloss, source: "graph" };
    // isTermKind rather than a cast: NodeKind carries «book», TermKind does
    // not, and the day somebody adds a kind to graphstore this stays honest.
    if (isTermKind(n.kind)) rec.kind = n.kind;
    const pages = n.pages?.[next.key];
    if (pages?.length) rec.pages = pages;
    out.push(rec);
  }
  if (!out.length) return;

  // WHOSE glossary is this — checked here, at the write, rather than assumed.
  //
  // Every per-book file in this app is named by the book's CONTENT key, and the
  // only thing that knows the content key of a path is bookid's session map,
  // filled by whoever read the bytes. A shard is named by that same key, so
  // `bookKey(bookPath) === next.key` is the one available proof that the file
  // this write is about to open belongs to the book this shard describes.
  //
  // Unproven means write NOTHING, and the alternative is what makes that worth
  // a guard rather than a shrug. With the map empty — a book the reader never
  // opened this session, which is every book a background rescan deepens —
  // translate.ts falls back to a hash of the PATH, so the write lands on a file
  // no book will ever read again, and on its way it fills the glossary session
  // cache (keyed by bookPath, never invalidated) with that stray list. The
  // reader then opens the book, the Terms tab shows the cache instead of their
  // file, and the first blur writes it back under the RIGHT name — over the
  // hand-curated list that translate.ts calls «work no pass can give back».
  // Losing a machine-written gloss is a pass that did not help; losing that file
  // is the reader's evening.
  //
  // graphrun binds the key before both roads into this pass, so the guard is
  // expected to hold; it is here because the cost of it not holding is not
  // proportionate to the cost of checking.
  if (bookKey(next.bookPath) !== next.key) {
    console.warn("graph: not writing the deep pass back — this book's glossary is unidentified", next.bookPath);
    return;
  }

  // The language, and the precedence rule this write obeys:
  //
  //   the reader's own choice  >  a pass the reader ran  >  this pass  >  UND
  //
  // A DETECTOR NEVER OUTRANKS A PERSON. The Terms tab lets the reader correct
  // the detected language by hand and its passes then store that correction, so
  // whatever the sidecar already says was either chosen by the reader or shown
  // to them and left standing. This pass runs in the background on a book they
  // may not even have open; it has no standing to argue with either.
  //
  // So the seed's detection is written in exactly one case — the sidecar has no
  // language at all — and never as UND. The bug this replaces passed the
  // detection straight through: `lang: contexts.get(key)?.lang`, which after a
  // full build in this session is always a real string and often the literal
  // "und" (seedShard's detector answers UND by design for a book booklang does
  // not vote on). glossarygen resolves `opts.lang ?? prev.lang`, and `??` does
  // not fall through on a string, so "und" won — a background graph build
  // erased the language the reader had picked by hand, the Terms tab fell back
  // to «unknown» on the next open, and the next mine ran with the derived
  // stoplist instead of the curated one they had asked for. GlossaryPanel
  // refuses to write UND for precisely this reason and says so; the graph now
  // refuses for the same one, and refuses to overwrite as well.
  //
  // The extra read is the sidecar's, and it is the price of the rule: saveGlossary
  // resolves `opts.lang ?? prev.lang` internally and there is no way to say
  // «fill it only if it is empty» from out here without first knowing what is in
  // it. It costs one small JSON read at the end of a pass that just spent
  // minutes in a model.
  const detected = contexts.get(next.key)?.lang ?? UND;
  const stored = await loadGlossary(next.bookPath).then(
    (g) => g.meta.lang,
    () => UND,
  );
  const lang = detected !== UND && stored === UND ? detected : undefined;
  await saveGlossary(next.bookPath, out, { lang }).catch((e) => {
    console.warn("graph: could not write the deep pass back to the glossary", e);
  });
}

// ---- the deep pass ----------------------------------------------------------

/// Ask a model what the mined terms actually are, what the book is about, and
/// which of its concepts belong together. Returns the improved shard, or the
/// one it was given when no model could answer — a missing model is a graph
/// that stays at stage «seed» and can be deepened later, never a failed build.
/// Only an abort throws.
///
/// It does NOT write the shard — graphstore is the writer and graphrun the
/// caller that decides — but it does write ONE file of its own: the reader's
/// glossary for this book, with what it just learned (see feedTermStore). That
/// is deliberate and it is the only IO here. The shard is the caller's to
/// commit or discard; the term store is a store in its own right, and a term
/// this pass explained is explained whatever the caller then does with the
/// graph.
export async function deepen(
  shard: Shard,
  onProgress: (p: GenProgress) => void,
  signal: AbortSignal,
): Promise<Shard> {
  if (signal.aborted) abortErr();
  // Only the mined terms are sent for typing: authors already carry «person»,
  // and asking a model to re-type them invites it to demote one to a topic.
  //
  // One author is sent anyway — the one whose surname the miner also found in
  // the running text, and whose node therefore absorbed that surname's weight
  // and pages in the seed pass (see bySurname). Carrying pages for this book is
  // exactly what distinguishes such a node from a plain metadata author, and
  // once it does, it is one of the heaviest things in the graph: the reader who
  // clicks it deserves the same one-line gloss every other heavy node has. Its
  // KIND is not at risk — applyDeep pins the kind of anything the book is `by`.
  //
  // A node that already carries a gloss is skipped, and this is where the term
  // store pays for itself in minutes rather than in quality. A gloss on a shard
  // at stage «seed» can only have come from one place — the reader's own
  // glossary, through seedShard's merge — so the node is already typed and
  // already explained, and asking about it again buys a second opinion nobody
  // wants at TYPE_CHUNK terms a call. On the reader's 838-page book the seed
  // holds 124 concepts and their glossary explains 118 of them: eleven typing
  // calls become one.
  //
  // It is bought by the pass that FILLED the glossary's fields in, not by the
  // file existing. A glossary that has only been mined carries terms and pages
  // and no definitions, so no node gets a gloss, nothing is skipped, and this
  // pass costs exactly what it costs today. That is the right way round — the
  // work is done once, wherever the reader chose to do it.
  //
  // «Already explained» is NOT the same question as «already typed», and the
  // filter asks the second one, because the first one silently threw away the
  // reader's work. A glossary line carries a definition and a kind in two
  // different places — the definition is the third field of the .txt the reader
  // edits by hand, the kind lives only in the sidecar — and the two doors into
  // the file fill exactly one of them: «Добавить в глоссарий» writes
  // `{ term, source: "user" }` and no kind at all (App.tsx), and the reader then
  // types the definition in the Terms tab. Filtering on `!n.gloss` skipped every
  // one of those nodes, and since the seed's default kind is also «term» and
  // graphrun never revisits a shard at stage «deep», a term the reader had
  // defined by hand was pinned to «term» for ever — a person drawn in `muted`
  // instead of `--chart-2` and missing from the «Люди» filter chip
  // (GraphView.tsx), which is the one part of this the reader can actually see.
  // Nothing here could tell the two states apart from the node alone; the store
  // can, so the store is asked (typedConcepts above).
  //
  // The saving above survives intact, because it never came from the gloss: a
  // store that explained 118 of 124 concepts has typed those same 118 records —
  // enrichTerms fills kind and definition in one reply and glossarygen writes
  // both — so the same eleven typing calls still become one. What is bought back
  // is the handful of records that carry a definition and no kind, which is
  // precisely the population that came from the reader's own hand rather than
  // from a pass.
  //
  // The two lists are kept apart, and the early return below is on the FIRST
  // of them. «Nothing to ask» and «nothing to deepen» are different states: a
  // book whose term store already explained every concept still wants its tags
  // and its summary, and still has to reach stage «deep» or graphrun will queue
  // it again on every scan for ever. Only a shard with no concepts at all — a
  // PDF whose text layer yielded nothing — has nothing for a model to do.
  const concepts = conceptsOf(shard).filter(
    (n) => n.kind === "term" || (n.kind === "person" && (n.pages?.[shard.key]?.length ?? 0) > 0),
  );
  if (!concepts.length) return shard;
  // Read after the early return, never before it: a PDF whose text layer
  // yielded nothing must not pay for a glossary read to be told there is
  // nothing to ask about.
  const typedByStore = await typedConcepts(shard.bookPath);
  const terms = concepts
    .filter((n) => !n.gloss || !typedByStore.has(conceptId(n.label)))
    .map((n) => n.label);

  // The switch is read HERE, at the moment of use, and never cached in a
  // module constant: a reader who turns the Claude pass on in Settings must
  // get it on the next book, not after restarting the app.
  //
  // Default OFF, and that is a default rather than a limitation — the feature
  // below is finished, and one click in Settings turns it on. Off is the right
  // default because build() seeds a shard and deepens it in the same breath:
  // pointing the library at a folder of fifty PDFs would otherwise hand every
  // file the classifier called «article» to Claude Code during the first scan,
  // before the reader had seen a single verdict, let alone corrected one. This
  // app reaches the network on an explicit action and on nothing else.
  if (shard.prov === "article" && claudeDeepen()) {
    const viaClaude = await deepenViaClaude(shard, terms, onProgress, signal);
    if (viaClaude) {
      await feedTermStore(viaClaude, shard);
      onProgress({ phase: "done", done: 1, total: 1 });
      return viaClaude;
    }
    // Claude was unavailable or answered with nothing usable. The local model
    // gets its turn below; if it is unavailable too, the seed shard stands.
  }

  // «book» and «unknown» both come here, and «unknown» is deliberately NOT
  // treated as «probably an article». An undecided verdict means the
  // classifier could not prove the file is openly licensed, and a file we
  // cannot prove is open is read on this machine only — sending someone's
  // copyrighted book to a cloud service cannot be taken back, while a slower,
  // dumber graph for one file costs nothing anybody can lose. Do not "fix"
  // this branch into routing unknown files to Claude: it is the whole point of
  // the provenance classifier that sits in front of it.
  const local = await deepenLocally(shard, terms, onProgress, signal);
  if (!local) return shard;
  await feedTermStore(local, shard);
  onProgress({ phase: "done", done: 1, total: 1 });
  return local;
}

async function deepenLocally(
  shard: Shard,
  terms: readonly string[],
  onProgress: (p: GenProgress) => void,
  signal: AbortSignal,
): Promise<Shard | null> {
  // Gate BEFORE the minutes-long work. A reader without the aux model must
  // find that out in a second, not after a queue of forty books has each
  // waited ninety seconds for a server that was never going to come up.
  if (!(await auxStartable())) return null;
  if (signal.aborted) abortErr();
  try {
    // Inside the try, not before it: aux_model_start returns as soon as the
    // spawn is under way, so a build cancelled during the 10-30s load would
    // otherwise leave a freshly resident model on the GPU with nobody left to
    // stop it.
    if (!(await startAux(signal))) return null;
    const head = await topicsPass(shard, terms, signal);
    // Gate again after the long pause. The topics call can take a minute on a
    // cold model, and a llama-server that died meanwhile should fail here
    // rather than once per chunk, twenty chunks in a row.
    // `terms.length` first, so a book whose term store had already typed every
    // concept does not spend a health probe and a zero-chunk pass to be told
    // there is nothing to ask. Its deep pass is the topics call and nothing
    // else, which is exactly right.
    const typed =
      terms.length && (await isAuxUp())
        ? await typePass(shard, terms, onProgress, signal)
        : new Map<string, Typed>();
    // A pass that learnt NOTHING must not be written at all: returning the
    // shard here — even correctly stamped «seed» — would still cost a second
    // write and a repaint to say exactly what the seed already said. Returning
    // null leaves the seed shard on disk untouched, engine «none», retryable
    // on the next scan. applyDeep decides the stage for everything else.
    if (!typed.size && !head.tags.length && !head.summary) return null;
    return applyDeep(shard, head, typed, "local", terms.length);
  } finally {
    // Always give the VRAM back — finished, cancelled or failed alike. Two
    // resident models plus page rasters do not fit comfortably in 16 GB, and a
    // background build must never sit on the GPU while the reader translates.
    // (No-op outside Tauri, or when nothing was started; an externally run
    // server is left alone by the Rust side.)
    invoke("aux_model_stop").catch(() => {});
  }
}
