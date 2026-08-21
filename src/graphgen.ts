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
// The mining is glossarygen.ts's C-value extractor aimed at a different target.
// It could not simply be imported: extractTerms's ExtractedTerm carries a
// sample sentence but no page numbers, while a concept node is required to
// carry the 1-based pages it was met on. The miner below is therefore modelled
// line for line on it — the same clause-bounded n-grams, the same
// nested-occurrence discounting, the same acronym and capitalised-unigram
// rules — with per-page bookkeeping added and the two-pass form/sample
// machinery dropped, because one pass can afford to track surface forms for
// everything.
//
// It used to read two dozen pages, and that was the single biggest defect this
// feature had: on an 838-page book those pages are 2.9% of the text, and the
// graph it produced held SEVEN concepts. It now reads the book (see
// MINE_PAGES_MAX for the measurement that sets the ceiling), and where the
// reader has already translated the book it merges in the glossary that
// glossarygen mined from all of it — the same extractor, a pass that has
// already been paid for, curated by hand as a side effect of another feature.
//
// The deep pass routes on provenance, and the routing is the feature: a
// licensed book (and anything the classifier could not decide — see below) is
// read ONLY by the local aux model on this machine, while an openly licensed
// article may be handed to Claude Code. Whichever model answers, it never sees
// the book: it sees the title, the authors, the tags and the mined term list,
// and it answers with one line per term. That is what keeps a whole library's
// build affordable, and it is also what keeps the local path honest — a 4B
// model can type a term it is shown, and cannot summarise a book it is not.
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
import { CITE_MARK } from "./glossarygen";
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
import { auxComplete, hydrateGlossary, isAuxUp, parseGlossary, type ChatMessage } from "./translate";

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
export const GRAPH_GEN = 2;

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
// alongside pdf.js's own page cache, all of it released when seedShard
// returns. That is what a linear one-pass count costs; the alternative is
// glossarygen's two-pass form/sample machinery, which would halve the memory
// and double the six seconds.
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
const MAX_PAGES_PER_TERM = 8; // the schema's own cap (graphstore re-applies it)
const MAX_N = 4; // longest n-gram, as in glossarygen
const MAX_TAGS = 12;
const MIN_CAP_FREQ = 4; // capitalised-in-running-text unigrams
const CITE_PAGE_MIN = 8; // ≥8 citation markers on one page ⇒ references/index
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
// A trimmed twin of glossarygen's, and trimmed in one direction on purpose:
// its lists are English-only, which is fine for a glossary whose whole job is
// English-to-Russian, and wrong here — this graph indexes whatever the reader
// owns, and a Russian book mined with an English stoplist yields a concept
// list made of «который» and «может». Both alphabets therefore appear below.
// The lists are shorter than glossarygen's because the deep pass types every
// surviving term through a model, which throws out what statistics let past.

const FUNC_STOP = new Set(
  `a an the and or but nor so yet not no of in on at by for with about against between into through during
  before after above below to from up down out off over under again further then once here there when where
  why how all any both each few many much more most other some such only own same as than too very just ever
  never also always often can could may might must shall should will would do does did done doing is are am
  was were be been being have has had having i you he she it we they me him her us them my your his its our
  their this that these those who whom whose which what if because until while unless since although though
  however therefore thus hence moreover nevertheless otherwise instead indeed rather quite almost already
  still yes etc via per among along across behind beyond despite except toward towards upon onto within
  without whatever anything something nothing everything anyone someone everyone one two three four five six
  seven eight nine ten first second third last next new old let et al vs versus based using given following
  shown seen called known named use used uses see say said like need make made take taken show section
  chapter figure table page pages example equation exercise note doi org www http https com html pp vol eds
  arxiv fig
  и а но или же ли бы не ни да как что чтобы если когда пока хотя потому поэтому итак также тоже уже ещё еще
  очень более менее самый самая самое такой такая такое этот эта это эти тот та те то который которая которое
  которые все весь вся всё каждый любой другой другая другие один одна одно два три в во на за под над при
  без для до от из у к ко с со по о об про через между среди около после перед про есть был была было были
  быть будет будут может можно нужно надо его её ее их им ими них нас вам вас мы вы они она оно он я ты мне
  тебе себя свой своя свои наш ваш там тут здесь тогда затем потом только даже лишь именно скорее почти
  впрочем однако например см рис табл гл стр таблица рисунок глава раздел страница пример уравнение`
    .split(/\s+/)
    .filter(Boolean),
);

// Consulted only by the capitalised-unigram rule, exactly as glossarygen's
// COMMON_EN is: it stops ordinary words that happen to open a clause («This»,
// «Однако», «Figure») from being read as proper nouns. Multiword candidates
// and acronyms never touch it, so domain terms are unaffected.
const COMMON = new Set(
  `about after also although always american another answer any approach area around author available average
  because before between both case chapter chart common company complete computer concept condition control
  course current data date design detail different difficult early either english error example experiment
  figure final first following form further general given great group human idea important information
  instead introduction issue known large later level little local main major many method model modern more
  most much next note number often only order other over paper part particular people perhaps person point
  possible present previous problem process program purpose question rather reason recent research result
  right same second section several significant similar simple since small some something special specific
  standard state study such system table term test text than that their then there these thing this those
  three through time today total under until upon usually value various very well what when where which while
  whole with within without word work world would year
  автор более большой быть важный ввод вместе внимание вопрос вот время всего второй выше глава год данные
  дело другой если ещё зачем здесь значит идея именно иначе итог каждый какой книга когда конец который
  кроме лишь лучше между менее много может можно например наиболее начало наш никогда новый однако около
  описание опыт основной особенно ответ пример пункт после почему поэтому правило пример проблема просто
  работа раздел разный результат решение рисунок ряд самый свой сейчас сила слово случай смысл собой более
  способ сразу среди статья степень стороны таблица также такой текст тема теперь только точка требует уже
  условие часть человек через число чтобы шаг`
    .split(/\s+/)
    .filter(Boolean),
);

// Common nouns that running text writes with a capital anyway, and which
// therefore look exactly like a name to a test of the label's shape. This book
// produced two of them: «University», mined out of the authors' affiliations,
// and «Internet», which any book about the web capitalises in ordinary prose.
// The 4B typed them «org» and «place», and no test of SHAPE can tell either
// from «Amazon» — the two are typographically identical, so the difference has
// to be written down. The list is deliberately short and deliberately generic:
// a word belongs here only when it names a CATEGORY that happens to be spelled
// with a capital, never when it could name one particular thing.
//
// Kept apart from COMMON rather than folded into it, because COMMON also gates
// what the miner accepts as a term at all: «Internet» in COMMON would stop the
// graph carrying an Internet node, and a term shelved as a term is exactly what
// we want it to be.
const CAP_COMMON = new Set(
  `internet web university college institute department faculty laboratory press journal
  conference workshop proceedings appendix abstract references index glossary preface
  интернет университет институт факультет кафедра лаборатория издательство журнал
  конференция приложение введение заключение оглавление указатель`
    .split(/\s+/)
    .filter(Boolean),
);

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
  return !FUNC_STOP.has(low) && !COMMON.has(low) && !CAP_COMMON.has(low);
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

// lookbehind: never start a token mid-word — "38th" must not yield "th"
const TOKEN_RE = /(?<![\p{L}\p{N}])[\p{L}][\p{L}\p{N}]*(?:['’-][\p{L}\p{N}]+)*/gu;
const CHUNK_SEP = /[,;:()[\]{}<>"“”«»|/\\]+/;
const SENT_SPLIT = /(?<=[.!?…][")\]»”’]*)\s+(?=[A-ZА-ЯЁ0-9«"“([])/;

// Yield to the event loop without setTimeout — a hidden tab's timer throttling
// would otherwise clamp every yield to ~1s and make a background build crawl.
// (Copied from glossarygen rather than imported: it is a private helper there,
// and this module may not add exports to a file another agent owns.)
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

/// Clause-bounded token runs, one array per clause, grouped by sentence.
function clauses(text: string): string[][][] {
  const out: string[][][] = [];
  for (const piece of text.split(SENT_SPLIT)) {
    const raw = piece.trim();
    if (!raw) continue;
    const sent = raw
      .split(CHUNK_SEP)
      .map((c) => c.match(TOKEN_RE) ?? [])
      .filter((toks) => toks.length);
    if (sent.length) out.push(sent);
  }
  return out;
}

async function pageParagraphs(doc: PDFDocumentProxy, n: number): Promise<Paragraph[]> {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  return clusterParagraphs(content.items, page.getViewport({ scale: 1 }));
}

const paraText = (paras: readonly Paragraph[]): string => paras.map((p) => p.text).join("\n");

// Reference lists and back-of-book indexes are dense with years, DOIs and
// URLs, and mining them floods the concept list with venue names and author
// surnames. Same net glossarygen uses, same threshold: running prose rarely
// carries eight such markers on one page.
const isCitationPage = (paras: readonly Paragraph[]): boolean =>
  paras.reduce((acc, p) => acc + (p.text.match(CITE_MARK)?.length ?? 0), 0) >= CITE_PAGE_MIN;

// ---- the sampler ------------------------------------------------------------

type Stat = {
  freq: number;
  pages: number[]; // 1-based, ascending, deduped
  nonInit: number; // occurrences NOT at a sentence start (case is trustworthy there)
  capNonInit: number; // …of those, the surface starts with a capital
  forms: Map<string, number>; // non-lowercase surface forms at non-initial positions
  first: string; // first surface seen anywhere (fallback display)
};

// `key` is the entry in `stats` this came out of — the lowercased token join,
// not the display label. seedShard needs it to tell one concept counted twice
// from two concepts that happen to fold onto one id.
type Mined = { key: string; term: string; freq: number; pages: number[] };

/// How many times a candidate must occur before it is a candidate at all.
///
/// glossarygen wants 5 occurrences across a WHOLE book, and this miner reads a
/// sample, so the floor has to be a density rather than a count: a sample of
/// `sampled` pages out of `total` is entitled to the same rate, 5·sampled/total.
/// The shipped constant was an absolute 3 over 24 pages, which is why every
/// surviving weight in the reader's first graph sat between 3 and 6 — on 2.9%
/// of a book almost nothing occurs three times, whatever it is.
///
/// Clamped below at 2 because rank() already demands two distinct pages, so a
/// floor of 1 is incoherent; clamped above at 5 because reading MORE of a book
/// must never make this miner stricter than the tool it copies. Worth ~2 terms
/// on the measurement above — the sample size is worth a hundred — but it is
/// what keeps a short book from going empty and a long one from filling with
/// one worked example's vocabulary.
const minFreq = (sampled: number, total: number): number =>
  Math.min(5, Math.max(2, Math.round((5 * Math.min(sampled, total)) / Math.max(1, total))));

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

const isCapital = (ch: number): boolean =>
  (ch >= 65 && ch <= 90) || (ch >= 0x410 && ch <= 0x42f) || ch === 0x401;

function bump(stats: Map<string, Stat>, key: string, page: number, surface: string, nonInitial: boolean): void {
  let st = stats.get(key);
  if (!st) {
    st = { freq: 0, pages: [], nonInit: 0, capNonInit: 0, forms: new Map(), first: surface };
    stats.set(key, st);
  }
  st.freq++;
  // pages arrive in ascending order, so one comparison is the whole dedup
  if (st.pages[st.pages.length - 1] !== page) st.pages.push(page);
  if (nonInitial) {
    st.nonInit++;
    if (surface !== key) st.forms.set(surface, (st.forms.get(surface) ?? 0) + 1);
    if (isCapital(surface.charCodeAt(0))) st.capNonInit++;
  }
}

// One page's contribution to the counts. n=1..4 inside clause bounds, with
// glossarygen's boundary rules: a term never starts or ends on a function
// word, and a one-character token may never sit inside one (math-notation runs
// like "iP P R iP" would otherwise mine themselves into the graph).
function minePage(stats: Map<string, Stat>, page: number, text: string): void {
  for (const sent of clauses(text)) {
    let sentPos = 0; // token index within the sentence — 0 ⇒ sentence-initial
    for (const toks of sent) {
      const low = toks.map((w) => w.toLowerCase());
      for (let a = 0; a < low.length; a++) {
        const w0 = low[a];
        // the opening word does not depend on n, so a bad one ends the run
        if (w0.length < 2 || FUNC_STOP.has(w0)) continue;
        for (let n = 1; n <= MAX_N && a + n <= low.length; n++) {
          if (n > 2 && low[a + n - 2].length < 2) break;
          const end = low[a + n - 1];
          if (end.length < 2 || FUNC_STOP.has(end)) continue; // a longer gram may still end cleanly
          const key = low.slice(a, a + n).join(" ");
          if (key.length > 64) break;
          bump(stats, key, page, toks.slice(a, a + n).join(" "), sentPos + a > 0);
        }
      }
      sentPos += toks.length;
    }
  }
}

// Dominant surface form: the lowercased key unless some cased form outnumbers
// plain lowercase in running text (BM25 not bm25, Boolean not boolean).
function dominantForm(key: string, st: Stat): string {
  if (!st.nonInit) return st.first || key;
  let bestForm = "";
  let bestCnt = 0;
  let cased = 0;
  for (const [f, c] of st.forms) {
    cased += c;
    if (c > bestCnt) ((bestCnt = c), (bestForm = f));
  }
  return bestCnt > st.nonInit - cased ? bestForm : key;
}

/// Rank the counted n-grams and keep the top `cap`. C-value nested discounting
/// (longest first; an accepted longer term's own-use frequency is subtracted
/// from its subgrams) for multiword candidates, acronym and
/// capitalised-in-running-text rules for unigrams — glossarygen's acceptance,
/// with its two-letter-surname guard kept, because a citation-heavy book makes
/// «Li» and «Ma» clear every other test.
///
/// `minPages` is the one rule that is NOT glossarygen's, and it is here
/// because the sample is. A floor of 5 over a whole book is what stops a
/// phrase that happens to repeat inside one table or one worked example from
/// being read as a concept; on a sample the floor drops (see minFreq), which
/// lets exactly that junk back in — a page that says «value systems change»
/// three times hands the graph a four-word node spanning a verb. A concept the
/// book is actually about turns up in more than one place, so a candidate met
/// on a single page is dropped. The rule is relaxed for a document too short
/// to have a spread worth measuring.
function rank(stats: Map<string, Stat>, cap: number, minPages: number, floor: number): Mined[] {
  type Cand = { key: string; n: number; freq: number };
  const cands: Cand[] = [];
  for (const [key, st] of stats) {
    if (st.freq < floor || st.pages.length < minPages) continue;
    cands.push({ key, n: key.split(" ").length, freq: st.freq });
  }
  cands.sort((a, b) => b.n - a.n);
  const candSet = new Set(cands.map((c) => c.key));
  const nested = new Map<string, number>();
  for (const c of cands) {
    if (c.n === 1) continue;
    const contrib = c.freq - (nested.get(c.key) ?? 0);
    if (contrib <= 0) continue;
    const toks = c.key.split(" ");
    const seen = new Set<string>();
    for (let len = 1; len < c.n; len++)
      for (let a = 0; a + len <= c.n; a++) {
        const sub = toks.slice(a, a + len).join(" ");
        if (seen.has(sub) || !candSet.has(sub)) continue;
        seen.add(sub);
        nested.set(sub, (nested.get(sub) ?? 0) + contrib);
      }
  }

  type Scored = { key: string; disp: string; freq: number; score: number };
  const accepted: Scored[] = [];
  for (const c of cands) {
    const st = stats.get(c.key)!;
    const adj = c.freq - (nested.get(c.key) ?? 0);
    const disp = dominantForm(c.key, st);
    if (c.n >= 2) {
      if (adj >= floor) accepted.push({ key: c.key, disp, freq: c.freq, score: adj * Math.log2(c.n) });
      continue;
    }
    const isAcr =
      disp.length >= 2 && disp === disp.toUpperCase() && /\p{Lu}/u.test(disp) && !/^[IVXLCDM]+$/.test(disp);
    if (isAcr && adj >= floor) {
      accepted.push({ key: c.key, disp, freq: c.freq, score: adj });
      continue;
    }
    // A two-letter capitalised token in running text is an author surname (Li,
    // Yu, Xu, Ma), never a domain term — glossarygen learned that the hard way
    // and the same trap is here. Genuine two-letter terms are acronyms and
    // were accepted just above.
    if (
      disp.length >= 3 &&
      /^\p{Lu}[^\p{Lu}]/u.test(disp) &&
      st.capNonInit >= MIN_CAP_FREQ &&
      st.capNonInit > st.nonInit - st.capNonInit &&
      !COMMON.has(c.key)
    )
      accepted.push({ key: c.key, disp, freq: c.freq, score: adj });
  }

  // Conjunction split, straight from glossarygen: «precision and recall» is
  // two terms joined by prose, not one — but only when both halves stand on
  // their own in the text. Purely structural, no domain knowledge involved.
  const CONJ = new Set(["and", "or", "и", "или"]);
  const have = new Set(accepted.map((c) => c.key));
  const split: Scored[] = [];
  for (const c of accepted) {
    const toks = c.key.split(" ");
    const ci = toks.findIndex((w) => CONJ.has(w));
    const oneConj = ci > 0 && ci < toks.length - 1 && !toks.some((w, i) => i !== ci && CONJ.has(w));
    const halves = oneConj ? [toks.slice(0, ci).join(" "), toks.slice(ci + 1).join(" ")] : [];
    const standsAlone = (h: string): boolean => {
      const st = stats.get(h);
      return !!st && st.freq >= floor && st.pages.length >= minPages;
    };
    if (!halves.length || !halves.every(standsAlone)) {
      split.push(c);
      continue;
    }
    for (const h of halves) {
      if (have.has(h)) continue; // the half is already a term in its own right
      have.add(h);
      const st = stats.get(h)!;
      split.push({ key: h, disp: dominantForm(h, st), freq: st.freq, score: c.score });
    }
  }

  split.sort((a, b) => b.score - a.score);
  return split.slice(0, cap).map((c) => ({
    key: c.key,
    term: c.disp,
    freq: c.freq,
    pages: (stats.get(c.key)?.pages ?? []).slice(0, MAX_PAGES_PER_TERM),
  }));
}

/// The mining key an arbitrary phrase would have had if minePage had counted
/// it: the same tokens, lowercased and joined. This is what lets a glossary
/// term be looked up in `stats` instead of scanned for a second time.
/// (TOKEN_RE carries /g; String.match resets lastIndex, so it stays reusable.)
function mineKey(term: string): string {
  const toks = term.match(TOKEN_RE);
  return toks ? toks.map((w) => w.toLowerCase()).join(" ") : "";
}

/// The source side of the reader's glossary for this book, if the file exists.
/// hydrateGlossary is translate.ts's own reader — it owns the appdata path, the
/// session cache and the fallback to a pre-binding file name, and none of that
/// may be re-implemented here: two spellings of «where the glossary lives»
/// would drift apart the first time either side changed.
///
/// It is keyed by bookPath rather than by the content key this shard is named
/// with, and resolves the one to the other through bookid's session map. That
/// map is filled by whoever read the file's bytes — graphrun's openGraphDoc
/// calls setBookKey before seedShard for exactly this reason — so the lookup
/// lands on <appDataDir>/glossaries/<contentKey>.txt, the same file the
/// translation side writes. Nothing breaks if it has not been filled: the
/// fallback finds a legacy path-named glossary or nothing at all.
///
/// Never throws. A book with no glossary, a profile with no glossaries folder
/// and a plain-browser run all mean the same thing to a seed pass — no free
/// terms this time — and none of them is a failed build.
async function glossaryTerms(bookPath: string): Promise<string[]> {
  const text = await hydrateGlossary(bookPath).catch(() => "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of parseGlossary(text)) {
    const src = flat(e.src);
    // The same shape tests the miner applies to its own labels: a line that is
    // a sentence, or has no letters in it, is a broken glossary line.
    if (src.length < 2 || src.length > 64 || !/\p{L}/u.test(src)) continue;
    if (src.split(/\s+/).length > MAX_N + 2) continue;
    const k = normId(src);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(src);
  }
  return out;
}

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
  return !id.split(" ").some((w) => FUNC_STOP.has(w) || COMMON.has(w) || CAP_COMMON.has(w));
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
  if (words.every((w) => FUNC_STOP.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")))) return null;
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

type SeedContext = { front: string; toc: string };
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
  const floor = minFreq(sample.length, total);

  // Only the classifier's own pages are RETAINED. The miner consumes each page
  // as it is read and drops it: a whole 838-page book's paragraphs held at once
  // is megabytes of strings kept alive for the sake of a second loop that reads
  // each page exactly once, and this pass now runs over books of that size.
  const paras = new Map<number, Paragraph[]>();
  const keep = new Set([...front, ...(back ? [back] : [])]);
  const stats = new Map<string, Stat>();
  let mined = 0;

  onProgress({ phase: "seed", done: 0, total: wanted.length });
  let read = 0;
  for (const n of wanted) {
    if (signal.aborted) abortErr();
    // A page whose text layer is broken is one page missing from the sample,
    // never a failed build: the reader would rather have most of a book in the
    // graph than an error where the book should be.
    const ps = await pageParagraphs(pdf, n).catch(() => []);
    if (keep.has(n)) paras.set(n, ps);
    // A page that reads as a reference list or a back-of-book index is skipped
    // whole rather than filtered term by term. `wanted` is ascending, which is
    // the whole of bump()'s page dedup.
    if (sampleSet.has(n) && ps.length && !isCitationPage(ps)) {
      minePage(stats, n, paraText(ps));
      mined++;
    }
    onProgress({ phase: "seed", done: ++read, total: wanted.length });
    if (read % 8 === 0) await tick();
  }

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
  for (const name of authors) {
    const id = `n:${normId(name)}`;
    if (!normId(name) || nodes.has(id)) continue;
    nodes.set(id, { id, kind: "person", label: name, books: [key], weight: 1 });
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
  let concepts = 0;
  const counted = new Set<string>();
  const addConcept = (label: string, freq: number, pages: number[], statKey: string): void => {
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
      if (!fresh) return;
      existing.weight += freq;
    } else {
      if (concepts >= MAX_CONCEPTS) return;
      concepts++;
      nodes.set(id, {
        id,
        kind: "term", // the deep pass types it; until then everything is a term
        label,
        books: [key],
        weight: freq,
        pages: { [key]: pages },
      });
    }
    // `existing.id`, not `id`: the node found may be an author's person node,
    // whose id is the unfolded one. An edge to `id` would then point at a node
    // that is not in this shard, and graphstore drops dangling edges — the
    // book would silently lose the mention.
    edges.push({ a: bookId, b: existing?.id ?? id, rel: "mentions", weight: freq });
  };

  // A concept has to turn up on more than one of the pages actually read —
  // unless so few of them survived the citation filter that «more than one
  // page» would mean «almost all of them», which a four-page article cannot
  // satisfy without going empty.
  for (const m of rank(stats, SEED_TERMS, mined >= 4 ? 2 : 1, floor)) addConcept(m.term, m.freq, m.pages, m.key);

  // The reader's own glossary for this book, if there is one — free quality.
  // The expensive pass has ALREADY RUN for another feature: glossarygen read
  // every page of this book, mined it with the same C-value extractor at
  // glossarygen's own thresholds, and the reader then curated the result by
  // hand while translating. Reading that file is one 6 KB read and it hands
  // this graph a term list nothing here could afford to compute twice.
  //
  // Two things make the merge cheap as well as free. The source side is the
  // book's own language, exactly like a mined label, so the two lists fold
  // together on normId with no translation involved. And a glossary term's
  // weight and pages do not need a second scan of the book: the miner counted
  // every n-gram it met, so a glossary term is almost always already in
  // `stats` — it simply lost to the cap or the floor — and its true frequency
  // and page numbers are waiting there under its own key. Only a term longer
  // than MAX_N tokens, or one that straddles a clause boundary, misses; that
  // node joins the graph wired to the book alone, which is still a node the
  // reader can search for and a term the deep pass will gloss.
  for (const term of await glossaryTerms(bookPath)) {
    const statKey = mineKey(term);
    const st = stats.get(statKey);
    addConcept(term, st?.freq ?? 1, st ? st.pages.slice(0, MAX_PAGES_PER_TERM) : [], statKey);
  }

  // The book node itself is synthesised by graphstore's merge from these very
  // fields, so writing one here would only shadow it with a stale copy.

  const tags = splitTags(`${meta.keywords ?? ""}\n${meta.subject ?? ""}`);

  rememberContext(key, {
    front: frontText.length > FRONT_CHARS ? `${frontText.slice(0, FRONT_CHARS)}…` : frontText,
    toc: await outlineHeadings(pdf).catch(() => ""),
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
// TranslatePopover's ensureAux, which is private to that component — the same
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
  if (replyRejected(raw, terms.length, 260, true)) return null;
  const typed = parseTyped(raw, terms);
  if (!typed.size) return null; // nothing usable came back — let the local model try
  onProgress({ phase: "types", done: 1, total: 1 });
  return applyDeep(shard, parseHead(raw), typed, "claude");
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
function applyDeep(shard: Shard, head: Head, typed: Map<string, Typed>, engine: "local" | "claude"): Shard {
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
    if (hit.gloss) next.gloss = hit.gloss;
    return next;
  });
  const ordered = nodes
    .filter((n) => n.kind !== "book" && !n.id.startsWith("b:"))
    .sort((a, b) => b.weight - a.weight);

  // The book's own «shares» edges are rebuilt, not appended to: a second deep
  // pass over the same shard must replace its co-occurrence, never double it.
  const kept = shard.edges.filter((e) => e.rel !== "shares");

  const tags = splitTags([...shard.tags, ...head.tags].join("\n"));
  const deepened = typed.size > 0;
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

// ---- the deep pass ----------------------------------------------------------

/// Ask a model what the mined terms actually are, what the book is about, and
/// which of its concepts belong together. Returns the improved shard, or the
/// one it was given when no model could answer — a missing model is a graph
/// that stays at stage «seed» and can be deepened later, never a failed build.
/// Only an abort throws.
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
  const terms = conceptsOf(shard)
    .filter((n) => n.kind === "term" || (n.kind === "person" && (n.pages?.[shard.key]?.length ?? 0) > 0))
    .map((n) => n.label);
  if (!terms.length) return shard;

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
    const typed = (await isAuxUp()) ? await typePass(shard, terms, onProgress, signal) : new Map<string, Typed>();
    // A pass that learnt NOTHING must not be written at all: returning the
    // shard here — even correctly stamped «seed» — would still cost a second
    // write and a repaint to say exactly what the seed already said. Returning
    // null leaves the seed shard on disk untouched, engine «none», retryable
    // on the next scan. applyDeep decides the stage for everything else.
    if (!typed.size && !head.tags.length && !head.summary) return null;
    return applyDeep(shard, head, typed, "local");
  } finally {
    // Always give the VRAM back — finished, cancelled or failed alike. Two
    // resident models plus page rasters do not fit comfortably in 16 GB, and a
    // background build must never sit on the GPU while the reader translates.
    // (No-op outside Tauri, or when nothing was started; an externally run
    // server is left alone by the Rust side.)
    invoke("aux_model_stop").catch(() => {});
  }
}
