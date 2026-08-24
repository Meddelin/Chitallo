// The glossary's GENERATION side: the three passes, the storage glue that puts
// their results on disk, and the compatibility surface the dev console spreads.
//
// What lives where, because this file used to be all of it:
//   • src/terms.ts     — the miner (it was this file's C-value extractor, forked
//                        into graphgen and now unforked; its tokenizer is
//                        script-agnostic, which is the whole reason a Russian
//                        book stops yielding a glossary made of its Latin
//                        islands).
//   • src/glossary.ts  — the record, the grammar of the .txt the reader edits,
//                        the sidecar, and the byte-preserving merge. Pure.
//   • src/booklang.ts  — what language the book is in.
//   • this file        — passes, IO, prompts, compatibility.
//
// The five passes, in the order they are meant to run:
//
//   1.  mineGlossary   model-free. It ALWAYS runs and it always writes. This is
//                      the honest answer to "no aux model installed": the terms,
//                      their pages and their frequencies land on disk now, and
//                      the other fields get filled the day a model exists. The
//                      UI must say that out loud rather than pretend a pass ran.
//   1.5 profileBook    ONE model call that reads the book's title, its outline,
//                      its opening and sixteen prose excerpts and writes a six-
//                      line brief about the book to a sibling .profile.json.
//                      Every later prompt is prefixed with that brief instead of
//                      a bag of the book's most frequent strings.
//   1.7 proposeTerms   the model NAMES the book's terms from sampled pages,
//                      under that brief; TermMiner.lookup then attaches the
//                      counts. The miner stays the recall net; it stops being
//                      the selector — and one batched yes/no pass gives the
//                      model a VETO over the ranked tail the miner still
//                      contributes, so a frequent string reaches the reader's
//                      file only if the model that has read the book agrees it
//                      is a term of it (see vetoMinedTail). The veto needs the
//                      book PROFILE and runs only when there is one: its
//                      brief may not be built from the same frequency ranking
//                      it is judging — see profileBrief.
//   2.  enrichTerms    batched against the aux model, ~12 terms a call, asking
//                      for `term :: kind :: category :: definition`. Translation
//                      is a separate, optional field of this pass — see below.
//   3.  validateTerms  clusters near-duplicates locally, asks the model per
//                      cluster whether they are one concept and which spelling
//                      is canonical, and checks definitions against their terms.
//                      A definition that fails is CLEARED; the term survives.
//
// Why 1.5 and 1.7 exist at all, in one paragraph, because it is the whole point
// of them: frequency cannot tell a term of the book from a running example in
// it. The reader's own second book yielded, by raw C-value rank, «dark of the
// moon» (a sample search query used 56 times as a worked example) beside
// «SDBN :: сокращение от специфического алгоритма или структуры данных» — pure
// I-don't-know filler — and «Information Retrieval = Информационное
// извлечение», the literal word-for-word rendering of a term whose established
// Russian name is «информационный поиск». A model handed nothing but a list of
// frequent strings cannot separate those either; a model told what the book is,
// whom it is for and what it argues can. So the brief comes first and every
// prompt below carries it — and the frequent strings the miner still puts
// forward are shown to that same model for a yes or a no before they are
// allowed into the file, because a selector that was demoted and then left
// writing unchecked is not demoted at all.
//
// Only passes 1, 1.5 and 1.7 touch the disk. The other two are functions over
// records, so a whole run is:
//
//   const m = await mineGlossary(doc, bookPath, { signal, onProgress });
//   await profileBook(doc, bookPath, { lang: m.lang, signal, onProgress });
//   await proposeTerms(doc, bookPath, { lang: m.lang, signal, lookup: m.lookup });
//   const g = await loadGlossary(bookPath);
//   const brief = bookBrief(await loadProfile(bookPath), g.records);
//   const e = await enrichTerms(g.records, { bookPath, lang: m.lang, target, brief, signal });
//   const v = await validateTerms(e.records, { brief, signal });
//   await saveGlossary(bookPath, v.records, {
//     lang: m.lang, target, remove: v.foldedKeys, clearDefs: v.clearedKeys });
//
// `brief` is rendered ONCE by the caller and handed down, rather than read from
// disk by each pass. That keeps passes 2 and 3 what they have always been —
// pure functions over records that open nothing — which is the property their
// own option docs make a point of.
//
// `bookPath` on pass 2 is not an IO argument — the pass reads no file. It is
// the key into this session's sample store, which is the one thing a record
// cannot carry across the disk between the passes; see «the sample sentence».
//
// Each of the three is also meant to be run on its own from the panel, which is
// why none of them assumes the others ran.
//
// Three rules of the house shape every model call below. The first comes from
// graphgen.ts:1691-1760, which learned it the expensive way:
//
//   • Nothing throws for a model fault. A dead server, a missing model, a reply
//     that failed every gate — all of them return what we already have. Only an
//     abort is allowed to change control flow, and even then the model passes
//     resolve with the work that finished (see the note on each pass).
//   • Nothing in here starts the aux server. Passes 2 and 3 assume the caller
//     has brought it up (graphgen's startAux, GlossaryPanel's ensureAux) and
//     will stop it afterwards; if it is not there, they simply hand back the
//     records they were given and the UI says the fields are still empty.
//   • A batched call needs an explicit token budget. auxComplete defaults to
//     512 (translate.ts:334), which is right for one term's rendering and far
//     too little for twelve four-field lines; and translate.ts:355 turns a
//     truncated <think> block into "", which is indistinguishable from a
//     refusal. A batch that silently truncates therefore looks exactly like a
//     model that will not answer, which is the worst diagnostic there is.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readFile, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
import { bookKey } from "./bookid";
import { detectBookLang, needsTranslation, UND, type BookLang } from "./booklang";
import {
  applyMeta,
  buildSidecar,
  formatLine,
  formatSidecar,
  isTermKind,
  mergeRecords,
  parseGlossaryLine,
  parseGlossaryText,
  parseSidecar,
  SIDECAR_EXT,
  termKey,
  type GlossaryMeta,
  type TermKind,
  type TermRecord,
  type TermSource,
} from "./glossary";
import { conceptId } from "./graphstore";
import { joinPath } from "./host";
import { getLang, type Lang } from "./i18n";
import { clusterParagraphs, hash, type Paragraph } from "./paragraphs";
import { createMiner, isCitationPage, type MinedTerm } from "./terms";
import { OUT_MATCH, outDice, outNorm } from "./textsim";
import {
  auxComplete,
  hydrateGlossary,
  isAuxUp,
  saveGlossaryText,
  translate,
  type ChatMessage,
} from "./translate";

/// booktranslate.ts:49 has always imported the citation net from this module.
/// Its implementation moved to terms.ts with the rest of the miner; the name
/// stays here so that import does not have to move with it. (graphgen now takes
/// isCitationPage straight from terms.ts, which is where a new caller should go.)
export { CITE_MARK } from "./terms";

// ---- what a pass hands back -------------------------------------------------

/// A record plus the sentence the miner first met the term in.
///
/// The sample is NOT part of TermRecord and must never become one — see «the
/// sample sentence» below for why, and for where it lives instead. Structurally
/// it is still a TermRecord, so every function in glossary.ts takes one
/// unchanged.
export type SampledRecord = TermRecord & { sample?: string };

/// What the miner counted for an arbitrary phrase — TermMiner.lookup's shape,
/// spelled here so a caller can hold one without importing terms.ts.
///
/// `freq: 0` means UNVERIFIED, never "not a term". terms.ts:105-113 states it
/// plainly: a phrase longer than MAX_N=4 tokens, or one that straddles a clause
/// boundary, was never counted under any key and answers 0. That is exactly the
/// shape of the good multiword term a model names and the miner structurally
/// cannot count, so proposeTerms keeps such a record and simply gives it no
/// freq and no pages rather than dropping it.
export type TermLookup = (term: string) => { key: string; freq: number; pages: number[] };

export type MineResult = {
  /// The COMPLETE record list of the file as it now stands — what was already
  /// there plus what this run added, with the sidecar's bookkeeping applied and
  /// a `sample` attached wherever mining found one. This is what pass 2 wants.
  records: SampledRecord[];
  /// The book's language, and how sure booklang was of it. `confidence` is a
  /// damped margin, not a probability (see booklang.ts); UND is a legitimate
  /// answer and means "I will not guess", not "no language". A language the
  /// caller passed in — the reader's override — comes back at 1: nobody guessed.
  lang: BookLang;
  confidence: number;
  added: number;
  updated: number;
  /// The live miner's counts, for as long as this session keeps them.
  ///
  /// SESSION-ONLY and never persisted: whole-book mining of an 838-page book is
  /// some 82 000 n-grams at roughly 75 MB (graphgen.ts:196), which is a thing to
  /// hand across a click, not a thing to write down. It exists so that the panel
  /// can run «Найти термины» and then «Прочитать книгу» and have the book read
  /// ONCE — proposeTerms wants exactly this function and would otherwise mine
  /// the whole book a second time to get it.
  lookup: TermLookup;
};

export type EnrichResult = {
  records: SampledRecord[];
  /// Records that gained a kind, a category or a definition.
  enriched: number;
  /// Records that were asked about and got nothing usable back.
  skipped: number;
  /// Records that gained a translation.
  translated: number;
  /// Whether the translation ladder ran at all. False is a normal outcome — the
  /// book is already in the target language, or the local translator is not
  /// wired for that target — and the UI is expected to say which.
  translationRan: boolean;
  aborted: boolean;
};

/// One cluster of spellings the model confirmed as a single concept.
///
/// `members` is everything in the cluster, `canonical` the survivor, `folded`
/// the spellings actually removed from the record list, and `kept` the ones
/// deliberately left where they are because the reader owns those lines.
///
/// `folded` and `kept` partition `members` minus `canonical`, and BOTH are
/// reportable outcomes. A group that folded nothing is not a non-event: the
/// model was asked, it answered, and the answer was that two lines in the
/// reader's own file say the same thing. Saying nothing about that is what the
/// panel used to do, and it is why «Проверить термины» looked like it had done
/// nothing at all on every glossary mined before this session.
export type DuplicateGroup = {
  canonical: string;
  members: string[];
  folded: string[];
  kept: string[];
};

export type ValidateResult = {
  records: SampledRecord[];
  groups: DuplicateGroup[];
  folded: number;
  /// Confirmed duplicate spellings that were left in the file — the sum of the
  /// groups' `kept`. A run with `groups` non-empty, `folded` 0 and `kept` n
  /// found n duplicates and removed none of them, which the reader has to be
  /// told in those words: nothing was lost, and nothing was tidied either.
  kept: number;
  /// The termKeys of the folded spellings — what saveGlossary's `remove` wants.
  /// Without it the survivor gains its aliases and the duplicate line stays in
  /// the file, because nothing else in this project may delete a line.
  foldedKeys: Set<string>;
  /// Definitions judged wrong and cleared.
  cleared: number;
  /// The termKeys whose definition was cleared — what saveGlossary's
  /// `clearDefs` wants. Same two-step as `foldedKeys` and for the same reason:
  /// mergeRecords only ever FILLS a field, so a definition already on disk goes
  /// away when the caller says so out loud and never as a side effect.
  clearedKeys: Set<string>;
  /// Definitions actually judged (a batch that got no answer judges nothing).
  checked: number;
  aborted: boolean;
};

// ---- budgets ----------------------------------------------------------------

const DEFAULT_CAP = 120; // terms a run returns, as it has always been
const MIN_FREQ = 5; // whole-book occurrence floor, unchanged from the first version
const DETECT_PAGES = 16; // pages sampled for language detection, see mineGlossary
const CONCURRENCY = 3; // worker count only; the requests share auxPool's ≤3 budget
const ENRICH_CHUNK = 12; // terms per enrichment call — graphgen's TYPE_CHUNK, same reason
const DEF_CHUNK = 12; // term/definition pairs per validation call
const TAIL_CHUNK = 12; // mined terms per veto call — see vetoMinedTail
const MAX_CLUSTER = 8; // spellings of one concept the model is asked about at once
const CLUSTER_TICK = 64; // rows between event-loop yields in the O(n²) clustering
const AUX_TRIES = 3; // attempts per model call — graphgen.ts:181, same arithmetic
const AUX_RETRY_MS = 2000; // pause before a retry, so a loading server can finish

// ---- pass 1.5 and 1.7's own budgets ----------------------------------------

const PROFILE_FRONT = 1500; // characters of opening prose, graphgen's FRONT_CHARS
const PROFILE_TOC = 600; // characters of flattened outline, graphgen's TOC_CHARS
const PROFILE_FRONT_PAGES = 5; // pages the opening is taken from
const PROFILE_PAGES = 16; // spread pages one excerpt each is taken from
// One excerpt is the LONGEST PROSE paragraph of its page, not the head of the
// page. The head of a page is disproportionately the running head, the folio
// and a section heading — furniture, in clusterParagraphs' own vocabulary —
// and a profile built from furniture describes the typesetting rather than the
// book. 350 characters is about two sentences of body prose, which is what
// carries the register and the vocabulary the brief is meant to name.
const PROFILE_EXCERPT = 350;

const PROPOSE_PAGES = 40; // spread pages the model is asked to name terms from
const PROPOSE_CHUNK_PAGES = 3; // pages per call — ~3000 characters of excerpt
const PROPOSE_PAGE_CHARS = 1000; // characters kept per page inside a chunk
const PROPOSE_CAP = 80; // proposals kept in full before the miner fills the rest
const PROPOSE_TERM_CHARS = 64; // a longer line is a sentence, not a term
const PROPOSE_TERM_WORDS = 6; // …and so is a longer one by word count
// How many characters of a proposal's tokens have to occur, in order, in the
// chunk the model was shown. See occursIn: the point is to fold inflection
// before comparing, because the nominative singular the prompt asks for almost
// never occurs verbatim in Russian running text.
const PROPOSE_STEM = 5;

// A definition is one sentence on one row of a panel. graphgen caps its node
// glosses at 160 characters; this is 200, for one stated reason and no measured
// one: a Russian sentence of the fifteen words the prompt asks for runs some
// 20% longer than the English the other number was chosen against, and a gloss
// clipped mid-word is worse than one row of extra text. Neither number has a
// corpus behind it — they are bounds on runaway answers, not style rules.
const DEF_MAX = 200;
// A category is a genus, not a description: «метрика», «структура данных».
// Four words is already generous for one, and anything longer is the model
// answering the definition question twice.
const CAT_MAX = 48;
const CAT_WORDS = 4;
// Characters of the first-occurrence sentence that go into a batch — the
// enrichment's, and now the mined tail's veto too (vetoMinedTail).
//
// The miner clamps a sample to 300; twelve of those would be 3.6 KB of prompt.
// 160 characters is roughly 70 tokens of Russian, so a full batch spends ~850
// tokens on context and leaves the budget to the answer.
//
// The slot this is measured against was re-derived when the servers gained
// `--parallel`: `-c` is the TOTAL arena and llama-server divides it by the
// slot count (measured on this machine — `--parallel 8 -c 24576` prints
// `n_ctx_slot = 3072`), so the aux server's `--parallel 4` over `-c 16384`
// gives 4096 cells a slot, not the flat 8192 this comment used to name. That
// is a whole request's budget, prompt and generation together, and ~850 tokens
// of context against it is the same comfortable fraction the old arithmetic
// claimed. See `AuxState::CTX_PER_SLOT` in src-tauri/src/lib.rs for the
// authoritative pair.
const SAMPLE_IN_PROMPT = 160;
// Terms already settled that the translation ladder shows the model, newest
// last. Twelve pairs is about 300 characters — the same order as one sample
// sentence — and it is enough for the model to see the book's conventions
// without the prompt turning into a second glossary.
const DECIDED_IN_PROMPT = 12;

// Token budgets. One enrichment line is the term (≤64 chars), a kind word, a
// category (≤48) and a definition (≤200) plus the separators: about 290
// characters, and Gemma tokenises Russian at roughly 2.2 characters a token, so
// ~130 tokens. The per-line figure went from 180 to 200 and the ceiling from
// 2600 to 3000 with the profile: a definition that has to say what the concept
// is IN THIS BOOK and what role it plays in it is a longer sentence than one
// that may recite a dictionary, and the slack is what stops a truncation from
// looking exactly like a refusal (translate.ts:355 turns a cut answer into "").
const enrichBudget = (n: number): number => Math.min(3000, 220 + n * 200);
// A verdict line is a term and one word. Two passes ask for that shape — the
// definition check and the mined tail's veto — and both spend this budget,
// because a line of «dark of the moon :: нет» is a line of «recall :: да»
// whatever question produced it. Sharing it is also the point: the veto's reply
// is deliberately defUser's format so that parseVerdicts reads both, and a
// budget of its own would be the first thing to drift away from that.
const defBudget = (n: number): number => Math.min(900, 120 + n * 45);
// One line: «ДА :: <spelling>».
const DUP_BUDGET = 120;
// Six lines of prose, one of them two sentences long, in Russian: ~700
// characters, so ~320 tokens. 700 is double that, because this call happens
// once per book and a truncated brief poisons every prompt that follows it.
const PROFILE_BUDGET = 700;
// Eight to twenty term lines of ≤64 characters: ~600 characters, ~270 tokens.
const PROPOSE_BUDGET = 500;

// ---- prompts ----------------------------------------------------------------
//
// These are NOT in i18n.ts, and that is both the graphgen precedent
// (graphgen.ts:186) and a bug fix. t() runs macKeys() over interpolated values
// (i18n.ts:963), so on macOS a mined term or a sample sentence containing
// "Ctrl+" or "Alt" was rewritten to "⌘"/"⌥" INSIDE the model's input — the old
// auxMessages pushed the term, its sample and the domain list through t() and
// this file's line 523 was where it happened. A prompt is an instruction to a
// model, never a string the reader sees, and it has no business in the
// reader's vocabulary.
//
// They still come in both languages, for the reason graphgen states: the answer
// has to come back in the language the reader reads, and a model asked in
// Russian answers in Russian far more reliably than one asked in English and
// told to switch at the end.
//
// The separator is « :: » and not a pipe: i18n's t() splits plural forms on the
// pipe character, so a field carrying one would be silently cut in half the day
// somebody routed it through t().

const SEP = "::";
const SEP_SPACED = " :: ";

/// The closed-vocabulary half of the typing instruction, quoted from graphgen's
/// NAMES_RULE (graphgen.ts:~230) ON PURPOSE and character for character.
///
/// It cannot be imported: graphgen imports loadGlossary/saveGlossary from this
/// module, and an import back would close a cycle. So it is duplicated, and the duplication is
/// load-bearing — the kinds this pass writes become node kinds in the graph, so
/// the day the two texts drift is the day one library gets typed two ways.
/// Change both together or neither.
///
/// The extra sentences are not padding. Handed a technical book's term list
/// with the short version, a 4B model answered «work» for «recommender
/// systems», «search engine» and «large language models», «place» for
/// «Internet», «person» for «search engine user» — fifteen spurious «work»
/// nodes out of 117, every gloss correct. The model understands the terms and
/// simply cannot hold a six-way closed vocabulary steady, so the rule states
/// the base rate, says plainly that four of the six kinds are for NAMES, and
/// hands over a test it can apply to the label in front of it. On the reader's
/// own 838-page book that moved proper-noun nodes from 29 to 12.
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

/// One term as the enrichment prompt lists it: the label, and its sentence
/// underneath when mining found one.
type PromptItem = { term: string; sample?: string };

/// A decision this run of the translation ladder has already taken. The ladder
/// shows the last few to the model so the pass has a memory across terms — see
/// translateTerms for what that costs.
type DecidedPair = { term: string; tr: string };

/// The prose fields of BookProfile, in the order profileUser asks for them.
type ProfileField = "subject" | "audience" | "argument" | "topics" | "vocab" | "register";

/// What the profile pass hands its prompt builder. Each field is already
/// clipped and may be empty, in which case the line is left out entirely
/// rather than printed with a placeholder the model would try to fill.
type ProfileInput = {
  title: string;
  authors: string;
  toc: string;
  front: string;
  pages: string;
  excerpts: string;
};

const PROMPTS: Record<
  Lang,
  {
    /// The pre-profile brief: the line every prompt below carried before this
    /// change, and still carries for every glossary that exists today. See
    /// bookBrief for why the fallback is byte-identical to the old text.
    domainLine: (domain: string) => string;
    /// The brief a book that has been READ writes about itself.
    briefLines: (p: BookProfile) => string;
    profileSystem: string;
    profileUser: (a: ProfileInput) => string;
    /// The six labels profileUser asks for, paired with the field each fills,
    /// in the order it asks for them. Matched with ё folded onto е — a model
    /// asked for «О ЧЁМ» answers «О ЧЕМ» often enough that the alternative is
    /// throwing away good briefs over a diacritic.
    profileFields: readonly (readonly [string, ProfileField])[];
    /// Distinctive fragments of profileUser's FORM description, and the reason
    /// they are not in `echo` below: a recited «ОБЛАСТЬ: дисциплина и предмет
    /// книги, одна строка» parses perfectly as a profile, so it has to be
    /// caught by its own prompt's words. replyRejected reads `echo` only.
    profileEcho: readonly string[];
    proposeSystem: string;
    proposeUser: (brief: string, chunk: string) => string;
    /// The veto over the miner's ranked tail — vetoMinedTail's question, and it
    /// asks it in defUser's LINE FORMAT on purpose: «термин :: да|нет», so the
    /// verdict parser both passes read is one parser (parseVerdicts) and one
    /// budget (defBudget). A yes/no question about a term is a yes/no question
    /// about a term; giving this one a second format would double the surface
    /// that has to keep agreeing with itself.
    ///
    /// «Термин» and not «строка», and the placeholder is as load-bearing as the
    /// separator. defUser's template is the one shape of this reply that is
    /// measured to work; this prompt deviated from it by naming its slot after
    /// the thing it was asking about, and a model that echoes a placeholder
    /// literally then answers «строка :: нет» — parseVerdicts looks up
    /// conceptId("строка"), finds nothing asked about under that id, and drops
    /// the line. Twelve of those and the whole batch is silently empty while
    /// hasVerdict still says the reply carried a verdict, so nothing retries.
    /// The list is still introduced as «строки», because calling the candidates
    /// «термины» in the very question of whether they are terms would answer it
    /// in the asking — the same defect as the frequency brief, see profileBrief.
    /// Only the ANSWER TEMPLATE is shared, and it is shared verbatim.
    ///
    /// `items` rather than bare strings: the model is judging whether a string
    /// is a term of the book or an example in it, and the sentence the miner
    /// first met it in is the evidence that settles it. Rendered by listItems,
    /// exactly as enrichUser renders the same shape.
    tailSystem: string;
    tailUser: (brief: string, items: readonly PromptItem[]) => string;
    enrichSystem: string;
    enrichUser: (brief: string, items: readonly PromptItem[]) => string;
    dupSystem: string;
    dupUser: (brief: string, forms: readonly string[]) => string;
    defSystem: string;
    defUser: (brief: string, pairs: readonly { term: string; definition: string }[]) => string;
    trSystem: string;
    trUser: (it: PromptItem, brief: string, decided: readonly DecidedPair[]) => string;
    /// Distinctive fragments of the instructions above. A reply containing one
    /// of them is the model reciting the task back instead of doing it.
    ///
    /// EVERY ENTRY MUST BE A LITERAL SUBSTRING OF THE PROMPT TEXT IN THIS SAME
    /// OBJECT. Nothing checks that at compile time and nothing fails at run
    /// time when it stops being true — the gate simply stops firing and junk
    /// reaches the reader's file. Re-derive them in the same edit that changes
    /// a prompt, or do not change the prompt.
    echo: readonly string[];
  }
> = {
  ru: {
    domainLine: (domain) => `Тематика книги (ключевые термины): ${domain}`,
    briefLines: (p) =>
      `Книга: ${p.subject}\n` +
      `Для кого: ${p.audience}\n` +
      `О чём: ${p.argument}\n` +
      `Темы: ${p.topics.join(", ")}\n` +
      `Лексика: ${p.vocab}\n` +
      `Тон: ${p.register}`,
    profileSystem:
      "Ты — редактор, который готовит справку о книге для других редакторов. Тебе дают название, " +
      "оглавление, начало книги и несколько отрывков с разных её страниц. Ты пишешь короткую " +
      "справку по заданной форме.",
    profileUser: (a) =>
      (a.title ? `Название: ${a.title}\n` : "") +
      (a.authors ? `Авторы: ${a.authors}\n` : "") +
      (a.toc ? `Оглавление: ${a.toc}\n` : "") +
      (a.front ? `Начало книги:\n${a.front}\n` : "") +
      `\nОтрывки со страниц ${a.pages}:\n${a.excerpts}\n\n` +
      "Ответь ровно шестью строками и ничем больше:\n" +
      "ОБЛАСТЬ: дисциплина и предмет книги, одна строка\n" +
      "ЧИТАТЕЛЬ: для кого она написана, одна строка\n" +
      "О ЧЁМ: что книга утверждает и что разбирает, ровно два предложения\n" +
      "ТЕМЫ: от пяти до восьми предметных областей через запятую\n" +
      "ЛЕКСИКА: какого рода лексика в этой книге главная, одна строка\n" +
      "ТОН: регистр изложения и обращение к читателю, одна строка\n" +
      "Пиши по-русски. Ничего, кроме этих шести строк, не пиши.",
    profileFields: [
      ["ОБЛАСТЬ", "subject"],
      ["ЧИТАТЕЛЬ", "audience"],
      ["О ЧЕМ", "argument"],
      ["ТЕМЫ", "topics"],
      ["ЛЕКСИКА", "vocab"],
      ["ТОН", "register"],
    ],
    profileEcho: ["одна строка", "ровно два предложения", "предметных областей через запятую"],
    proposeSystem:
      "Ты — терминолог. Тебе дают справку о книге и несколько страниц её текста. Ты называешь " +
      "понятия, на которых эта книга держится, — так, как их называет она сама.",
    proposeUser: (brief, chunk) =>
      (brief ? `${brief}\n\n` : "") +
      "Ниже — отрывки из книги. Выпиши из них термины этой книги: понятия, методы, объекты " +
      "изучения и имена собственные, без которых текст не читается.\n" +
      "Правила:\n" +
      "— пиши термин ровно в том виде, в каком он стоит в тексте, в именительном падеже " +
      "единственного числа, если такая форма в тексте есть;\n" +
      "— общеупотребительные слова, которые в этой книге ничего особенного не значат, не выписывай;\n" +
      "— не выдумывай терминов, которых в отрывках нет;\n" +
      "— от восьми до двадцати строк, по одному термину в строке, без нумерации и без пояснений.\n\n" +
      `Отрывки:\n${chunk}`,
    tailSystem:
      "Ты редактор словаря терминов. Тебе дают справку о книге и строки, которые машина отобрала " +
      "из неё по частоте. Ты решаешь про каждую, термин ли это самой книги или просто пример, " +
      "который в ней встретился. Отвечай только строками заданной формы.",
    tailUser: (brief, items) =>
      (brief ? `${brief}\n\n` : "") +
      "Ниже — строки, отобранные из книги по числу вхождений, и под каждой — предложение, в " +
      "котором она впервые встретилась. Частота ничего не говорит о том, термин ли это: " +
      "сквозной пример, образец поискового запроса и слово из листинга повторяются в книге " +
      "чаще многих настоящих терминов. Смотри на контекст: он показывает, о чём книга говорит, " +
      "когда она эту строку пишет.\n" +
      "Про каждую строку реши, входит ли она в терминологию этой книги.\n" +
      "Да — понятия, методы, модели, метрики и объекты изучения, а также принятые в этой " +
      "области сокращения и аббревиатуры, даже если ты не знаешь, как они расшифровываются.\n" +
      "Нет — образцы поисковых запросов и примеры, на которых книга что-то показывает; " +
      "названия фильмов, книг и песен, взятые как образец; ключевые слова, литералы и имена " +
      "из листингов; общеупотребительные слова и обрывки фраз.\n" +
      "Если сомневаешься, отвечай да.\n" +
      `Ответь по одной строке на каждую строку списка, в том же порядке:\nтермин ${SEP} да\nили\nтермин ${SEP} нет\n` +
      "Термин переписывай без изменений. Ничего, кроме этих строк, не пиши.\n\n" +
      `Строки:\n${listItems(items, "Контекст")}`,
    enrichSystem:
      "Ты терминолог. Тебе дают справку о книге и термины из неё; ты объясняешь, что каждый из " +
      "них значит В ЭТОЙ книге. Отвечай только строками заданной формы, без нумерации, без " +
      "заголовков и без пояснений.",
    enrichUser: (brief, items) =>
      (brief ? `${brief}\n\n` : "") +
      "Для каждого термина из списка выведи одну строку вида\n" +
      `термин ${SEP} тип ${SEP} категория ${SEP} определение\n` +
      "Тип — ровно одно слово из списка: person, org, place, work, topic, term.\n" +
      NAMES_RULE.ru +
      "Категория — родовое понятие в одно-два слова: «метрика», «структура данных», «алгоритм».\n" +
      "Определение — одно предложение до 15 слов, по-русски, о том, чем это понятие является " +
      "ИМЕННО В ЭТОЙ книге и какую роль в ней играет. Не пересказывай словарное значение слова.\n" +
      "Термин переписывай без изменений. Строк должно быть ровно столько, сколько терминов. " +
      "Ничего, кроме этих строк, не пиши.\n\n" +
      `Термины:\n${listItems(items, "Контекст")}`,
    dupSystem:
      "Ты терминолог. Тебе дают несколько написаний, найденных в одной книге. Ты решаешь, " +
      "обозначают ли они одно и то же понятие. Отвечай ровно одной строкой заданной формы.",
    dupUser: (brief, forms) =>
      (brief ? `${brief}\n\n` : "") +
      "Написания, найденные в одной книге:\n" +
      forms.map((f, i) => `${i + 1}) ${f}`).join("\n") +
      "\n\nОбозначают ли они одно и то же понятие?\n" +
      `Если да, ответь одной строкой:\nДА ${SEP} написание из списка, которое следует считать основным\n` +
      "Если нет, ответь одной строкой:\nНЕТ\n" +
      "Ничего, кроме этой строки, не пиши.",
    defSystem:
      "Ты редактор словаря терминов. Тебе дают термины и их определения; ты решаешь, верно ли " +
      "определение описывает свой термин. Отвечай только строками заданной формы.",
    defUser: (brief, pairs) =>
      (brief ? `${brief}\n\n` : "") +
      "Для каждой пары ниже реши, описывает ли определение именно этот термин.\n" +
      "Определение должно описывать термин так, как он используется в этой книге, а не вообще.\n" +
      `Ответь по одной строке на пару, в том же порядке:\nтермин ${SEP} да\nили\nтермин ${SEP} нет\n` +
      "Термин переписывай без изменений. Ничего, кроме этих строк, не пиши.\n\n" +
      "Пары:\n" +
      pairs.map((p, i) => `${i + 1}) ${p.term} ${SEP} ${p.definition}`).join("\n"),
    trSystem:
      "Ты — терминолог. Тебе дают справку о книге, термин из неё, предложение-контекст и уже " +
      "принятые в этой книге соответствия. Ответь ТОЛЬКО тем русским названием, которым этот " +
      "термин следует называть В ЭТОЙ книге — без пояснений, без кавычек, без точки в конце. " +
      "Если по конвенции этой области термин не переводится (аббревиатура, имя собственное, " +
      "название продукта или компании) — верни его без изменений. Если у термина есть " +
      "устоявшийся русский эквивалент в этой области, бери его; дословный пословный перевод " +
      "не годится.",
    trUser: (it, brief, decided) =>
      (brief ? `${brief}\n` : "") +
      (decided.length
        ? `Уже принято в этой книге:\n${decided.map((d) => `${d.term} → ${d.tr}`).join("\n")}\n`
        : "") +
      (it.sample ? `Контекст: ${it.sample}\n` : "") +
      `Термин: ${it.term}`,
    echo: [
      "Термин переписывай без изменений",
      "Ничего, кроме эт",
      "ровно одно слово из списка",
      "Не пересказывай словарное значение",
      "Обозначают ли они одно и то же понятие",
      "описывает ли определение именно этот термин",
      "как он используется в этой книге",
      "Если сомневаешься, отвечай да",
    ],
  },
  en: {
    domainLine: (domain) => `Subject area of the book (key terms): ${domain}`,
    briefLines: (p) =>
      `Book: ${p.subject}\n` +
      `For whom: ${p.audience}\n` +
      `About: ${p.argument}\n` +
      `Topics: ${p.topics.join(", ")}\n` +
      `Vocabulary: ${p.vocab}\n` +
      `Register: ${p.register}`,
    profileSystem:
      "You are an editor preparing a briefing about a book for other editors. You are given the " +
      "title, the contents, the opening of the book and several excerpts from different pages of " +
      "it. You write a short briefing in the given form.",
    profileUser: (a) =>
      (a.title ? `Title: ${a.title}\n` : "") +
      (a.authors ? `Authors: ${a.authors}\n` : "") +
      (a.toc ? `Contents: ${a.toc}\n` : "") +
      (a.front ? `The opening of the book:\n${a.front}\n` : "") +
      `\nExcerpts from pages ${a.pages}:\n${a.excerpts}\n\n` +
      "Answer with exactly six lines and nothing else:\n" +
      "FIELD: the discipline and the subject of the book, one line\n" +
      "READER: whom it is written for, one line\n" +
      "ABOUT: what the book argues and what it examines, exactly two sentences\n" +
      "TOPICS: five to eight subject areas, comma-separated\n" +
      "VOCABULARY: what kind of vocabulary is the main one in this book, one line\n" +
      "REGISTER: the register of the exposition and how it addresses the reader, one line\n" +
      "Write in English. Write nothing but those six lines.",
    profileFields: [
      ["FIELD", "subject"],
      ["READER", "audience"],
      ["ABOUT", "argument"],
      ["TOPICS", "topics"],
      ["VOCABULARY", "vocab"],
      ["REGISTER", "register"],
    ],
    profileEcho: ["one line", "exactly two sentences", "subject areas, comma-separated"],
    proposeSystem:
      "You are a terminologist. You are given a briefing about a book and several pages of its " +
      "text. You name the concepts this book rests on — the way the book itself names them.",
    proposeUser: (brief, chunk) =>
      (brief ? `${brief}\n\n` : "") +
      "Below are excerpts from the book. Write out the terms of this book from them: the " +
      "concepts, methods, objects of study and proper names without which the text cannot be read.\n" +
      "Rules:\n" +
      "— write the term exactly as it stands in the text, in the nominative singular if that " +
      "form occurs in the text;\n" +
      "— do not write out common words that mean nothing special in this book;\n" +
      "— do not invent terms that are not in the excerpts;\n" +
      "— between eight and twenty lines, one term per line, no numbering and no explanations.\n\n" +
      `Excerpts:\n${chunk}`,
    tailSystem:
      "You are the editor of a term glossary. You are given a briefing about a book and lines a " +
      "machine picked out of it by frequency. You decide, for each of them, whether it is a term " +
      "of the book itself or merely an example that occurs in it. Answer with the given line " +
      "format only.",
    tailUser: (brief, items) =>
      (brief ? `${brief}\n\n` : "") +
      "Below are lines picked out of the book by their number of occurrences, and under each of " +
      "them the sentence it was first met in. Frequency says nothing about whether a line is a " +
      "term: a running example, a sample search query and a word out of a code listing all recur " +
      "more often than many of the book's real terms. Look at the context: it shows what the " +
      "book is talking about when it writes that line.\n" +
      "For each line, decide whether it belongs to this book's terminology.\n" +
      "Yes — concepts, methods, models, metrics and objects of study, and the abbreviations and " +
      "acronyms accepted in this field, even if you do not know what they stand for.\n" +
      "No — sample search queries and the examples the book demonstrates things on; titles of " +
      "films, books and songs taken as samples; keywords, literals and identifiers out of code " +
      "listings; common words and fragments of phrases.\n" +
      "If you are in doubt, answer yes.\n" +
      `Answer with one line per line of the list, in the same order:\nterm ${SEP} yes\nor\nterm ${SEP} no\n` +
      "Rewrite the term unchanged. Write nothing but those lines.\n\n" +
      `Lines:\n${listItems(items, "Context")}`,
    enrichSystem:
      "You are a terminologist. You are given a briefing about a book and terms from it; you " +
      "explain what each of them means IN THIS book. Answer with the given line format only — no " +
      "numbering, no headings, no explanations.",
    enrichUser: (brief, items) =>
      (brief ? `${brief}\n\n` : "") +
      "For each term in the list, output one line of the form\n" +
      `term ${SEP} type ${SEP} category ${SEP} definition\n` +
      "The type is exactly one word from this list: person, org, place, work, topic, term.\n" +
      NAMES_RULE.en +
      "The category is a one- or two-word genus: «metric», «data structure», " +
      "«algorithm».\n" +
      "The definition is one sentence of up to 15 words, in English, about what this concept is " +
      "IN THIS VERY book and what role it plays in it. Do not retell the dictionary meaning of " +
      "the word.\n" +
      "Rewrite the term unchanged. There must be exactly as many lines as there are terms. " +
      "Write nothing but those lines.\n\n" +
      `Terms:\n${listItems(items, "Context")}`,
    dupSystem:
      "You are a terminologist. You are given several spellings found in one book. You decide " +
      "whether they denote one and the same concept. Answer with exactly one line of the given form.",
    dupUser: (brief, forms) =>
      (brief ? `${brief}\n\n` : "") +
      "Spellings found in one book:\n" +
      forms.map((f, i) => `${i + 1}) ${f}`).join("\n") +
      "\n\nDo they denote one and the same concept?\n" +
      `If they do, answer with one line:\nYES ${SEP} the spelling from the list to treat as the main one\n` +
      "If they do not, answer with one line:\nNO\n" +
      "Write nothing but that line.",
    defSystem:
      "You are the editor of a term glossary. You are given terms and their definitions; you " +
      "decide whether each definition describes its own term. Answer with the given line format only.",
    defUser: (brief, pairs) =>
      (brief ? `${brief}\n\n` : "") +
      "For each pair below, decide whether the definition describes that very term.\n" +
      "The definition must describe the term as it is used in this book, not in general.\n" +
      `Answer with one line per pair, in the same order:\nterm ${SEP} yes\nor\nterm ${SEP} no\n` +
      "Rewrite the term unchanged. Write nothing but those lines.\n\n" +
      "Pairs:\n" +
      pairs.map((p, i) => `${i + 1}) ${p.term} ${SEP} ${p.definition}`).join("\n"),
    trSystem:
      "You are a terminologist. You are given a briefing about a book, a term from it, a sentence " +
      "of context and the renderings already accepted in this book. Answer with ONLY the English " +
      "name this term should be called by IN THIS book — no explanation, no quotes, no full stop. " +
      "If convention in this field leaves the term untranslated (an acronym, a proper name, a " +
      "product or company name), return it unchanged. If the term has an established English " +
      "equivalent in this field, take it; a literal word-by-word translation will not do.",
    trUser: (it, brief, decided) =>
      (brief ? `${brief}\n` : "") +
      (decided.length
        ? `Already accepted in this book:\n${decided.map((d) => `${d.term} → ${d.tr}`).join("\n")}\n`
        : "") +
      (it.sample ? `Context: ${it.sample}\n` : "") +
      `Term: ${it.term}`,
    echo: [
      "Rewrite the term unchanged",
      "Write nothing but",
      "exactly one word from this list",
      "Do not retell the dictionary meaning",
      "Do they denote one and the same concept",
      "whether the definition describes that very term",
      "as it is used in this book",
      "If you are in doubt, answer yes",
    ],
  },
};

const prompts = (): (typeof PROMPTS)["ru"] => PROMPTS[getLang()];

function listItems(items: readonly PromptItem[], contextLabel: string): string {
  return items
    .map((it, i) => {
      const head = `${i + 1}. ${it.term}`;
      const s = it.sample ? flat(it.sample).slice(0, SAMPLE_IN_PROMPT) : "";
      return s ? `${head}\n   ${contextLabel}: ${s}` : head;
    })
    .join("\n");
}

// ---- small shared helpers ---------------------------------------------------

const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
const isAbortErr = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";

function abortErr(): never {
  throw new DOMException("glossary generation aborted", "AbortError");
}

// Yield to the event loop without setTimeout — hidden-tab timer throttling
// would otherwise clamp every yield to ~1s.
function tick(): Promise<void> {
  return new Promise((res) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => res();
    ch.port2.postMessage(0);
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const onAbort = (): void => {
      clearTimeout(id);
      rej(new DOMException("glossary generation aborted", "AbortError"));
    };
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      res();
    }, ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const paraText = (paras: readonly Paragraph[]): string => paras.map((p) => p.text).join("\n");

/// A PDF Info field, or "". graphgen.ts:566 has the same three words.
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/// Body prose only — the paragraphs clusterParagraphs typed "prose", dropping
/// running heads and folios ("furniture"), figure captions and maths and table
/// cells ("other"). The profile pass wants what the AUTHOR wrote, because the
/// register and the vocabulary it is asked to name show up nowhere else.
const prose = (paras: readonly Paragraph[]): Paragraph[] => paras.filter((p) => p.kind === "prose");

/// The longest prose paragraph of a page, flattened and clipped. Empty when the
/// page has no body prose at all — a plate, a full-page table, a part title.
function longestProse(paras: readonly Paragraph[], clip: number): string {
  let best = "";
  for (const p of prose(paras)) if (p.text.length > best.length) best = p.text;
  return best ? flat(best).slice(0, clip) : "";
}

async function pageParagraphs(doc: PDFDocumentProxy, n: number): Promise<Paragraph[]> {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  return clusterParagraphs(content.items, page.getViewport({ scale: 1 }));
}

/// Evenly spread page numbers, 1-based. graphgen has the same four lines and
/// keeps them (its sampler feeds its own mining budget); this one exists so
/// that detecting a language does not drag the graph builder into the bundle.
function spreadPages(total: number, want: number): number[] {
  if (total <= want) return Array.from({ length: total }, (_, i) => i + 1);
  const out: number[] = [];
  for (let i = 0; i < want; i++) out.push(1 + Math.round((i * (total - 1)) / (want - 1)));
  return [...new Set(out)];
}

/// The domain signal the aux model got before there was a book profile: the
/// book's own heaviest terms. No embedded dictionaries anywhere, so it works for
/// any book — it is the mechanism the first terminologist prompt used and the
/// one thing it got right.
///
/// It is now the FALLBACK half of bookBrief and nothing calls it directly any
/// more. It stays private and it stays correct: a bag of frequent strings is a
/// weak brief, but it is the brief every glossary in existence was built with,
/// and it is what a book that has not been read still has to offer.
function domainOf(records: readonly TermRecord[]): string {
  return [...records]
    .sort((a, b) => (b.freq ?? 0) - (a.freq ?? 0))
    .slice(0, 10)
    .map((r) => r.term)
    .join(", ");
}

// ---- the sample sentence ----------------------------------------------------
//
// The sentence the miner first met a term in is the single strongest signal the
// terminologist has. It is what tells the model that «recall» in this book is
// the retrieval metric and not the act of remembering, and it is what the whole
// translation ladder's retry framing is built around (retryPrompt, lastQuoted).
// Without it the enrichment prompt asks about a bare word list and attempt 1 of
// the ladder re-issues attempt 0's identical call.
//
// It is produced by pass 1 and wanted by pass 2, and between them the record
// goes to disk and comes back — the panel writes the file, then re-reads it to
// run the next pass. So the sample has to survive that gap somewhere, and there
// are only three somewheres:
//
//   • the .txt — no. It is the reader's file, one line per term, and they never
//     asked to read the book back inside their own glossary.
//   • the sidecar — no, and this is the one that matters. It would be the only
//     field there big enough to notice, and it would put page text on
//     TermRecord, which is the shape that LEAVES this machine. README's privacy
//     section promises that «Read open articles through Claude Code» sends the
//     metadata and the term list and «never a definition, never the pages, and
//     never the file» — and a sentence of the file is the file, in part. The
//     payload is built from records that pass through graphgen.ts:645
//     (`out.push({ ...rec, term })`), a spread that carries every field a record
//     happens to have. One new field on TermRecord and one existing spread is
//     the whole distance between that promise and breaking it.
//   • this session's memory — yes. The sample is worth a prompt, not a file.
//
// So it lives here, keyed by book and by termKey, for as long as the app is
// running. A reader who mined yesterday and enriches today gets the pass they
// always got before this feature existed: a term list with no context lines. It
// is honestly weaker and it is not a failure — the fields still fill.
//
// The consequence for callers is one argument: pass 2 takes the bookPath it is
// working on, and it is REQUIRED rather than optional on purpose. The defect
// this replaces was not a wrong sample, it was a caller that had no way to know
// a sample existed; an optional argument would have been forgotten exactly the
// same way. Now the compiler asks.

/// Books whose samples are held at once. The reader opens one book at a time
/// and passes 1→2→3 run on that one; the rest of the window is for a reader
/// who moves between two or three books in a sitting. Each entry is at most a
/// run's `cap` sentences of ≤300 characters (terms.ts clampSample), so 120
/// terms is some 36 KB and the whole store a fraction of a rendered page.
const SAMPLE_BOOKS = 4;
/// A hard ceiling per book, in case a caller mines the same book repeatedly
/// with a raised cap: the merge below is cumulative, and a bound that is never
/// reached in practice is still cheaper than one that does not exist.
const SAMPLE_MAX = 600;

const samplesByBook = new Map<string, Map<string, string>>();

/// Keep what a mining run found, oldest book evicted first.
///
/// Merged rather than replaced: a term that fell below this run's cap keeps the
/// sentence an earlier run of the same session found for it, and the file still
/// holds its line, so pass 2 will still be asked about it. The new run wins
/// every collision — it read the book more recently than the old one did.
function rememberSamples(bookPath: string, found: ReadonlyMap<string, string>): void {
  const prev = samplesByBook.get(bookPath);
  const merged = prev ? new Map([...prev, ...found]) : new Map(found);
  samplesByBook.delete(bookPath); // re-insert, so this book is the newest
  samplesByBook.set(bookPath, merged.size > SAMPLE_MAX ? new Map(found) : merged);
  for (const old of samplesByBook.keys()) {
    if (samplesByBook.size <= SAMPLE_BOOKS) break;
    samplesByBook.delete(old);
  }
}

/// Attach this session's samples to records that do not already carry one.
/// A record that came straight out of mineGlossary has its sentence already;
/// one that came back off disk gets it here or not at all.
function withSamples(bookPath: string, records: readonly SampledRecord[]): SampledRecord[] {
  const found = samplesByBook.get(bookPath);
  if (!found?.size) return records.map((r) => ({ ...r }));
  return records.map((r) => {
    if (r.sample) return { ...r };
    const s = found.get(termKey(r.term));
    return s ? { ...r, sample: s } : { ...r };
  });
}

// ---- storage glue -----------------------------------------------------------
//
// The .txt belongs to translate.ts: it owns the durable content key, the
// session cache every synchronous call site reads through, the localStorage
// migration and the plain-browser flavour. This module never writes it by hand;
// it goes through hydrateGlossary/saveGlossaryText so all of that keeps working.
//
// The sidecar is ours. It is named after the .txt beside it —
// <appDataDir>/glossaries/<contentKey>.meta.json — which means the naming rule
// is spelled twice, here and in translate.ts:78, because that helper is private
// there. If the .txt's naming ever changes, this has to change with it; the
// symptom of forgetting is a glossary that keeps its text and quietly loses its
// page numbers.

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const metaLsKey = (bookPath: string): string => `pdfer:glossmeta:${bookPath}`;
const metaDir = (): Promise<string> => appDataDir().then((d) => joinPath(d, "glossaries"));
const metaFile = async (bookPath: string, key = bookKey(bookPath) ?? hash(bookPath)): Promise<string> =>
  joinPath(await metaDir(), `${key}${SIDECAR_EXT}`);

/// Torn-write-proof, the same shape booktranslate.ts:169 uses: the JSON lands in
/// a sibling .tmp and replaces the sidecar in one rename. A crash mid-write
/// leaves the previous complete sidecar rather than a truncated one — which
/// parseSidecar would answer for with an empty meta, i.e. by forgetting every
/// page number in the book.
async function atomicWrite(file: string, data: Uint8Array): Promise<void> {
  const tmp = `${file}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch {
    await remove(tmp).catch(() => {});
    await writeFile(file, data); // non-atomic beats not persisting
  }
}

async function readSidecar(bookPath: string): Promise<string | null> {
  if (!IS_TAURI) return localStorage.getItem(metaLsKey(bookPath));
  try {
    return new TextDecoder().decode(await readFile(await metaFile(bookPath)));
  } catch {
    // A session that ran before the book was content-bound wrote under the path
    // hash; translate.ts adopts the .txt in that case, so the sidecar can be
    // sitting under the old name while its text is already under the new one.
    const key = bookKey(bookPath);
    if (key === null || key === hash(bookPath)) return null;
    try {
      return new TextDecoder().decode(await readFile(await metaFile(bookPath, hash(bookPath))));
    } catch {
      return null;
    }
  }
}

async function writeSidecar(bookPath: string, json: string): Promise<void> {
  if (!IS_TAURI) {
    try {
      localStorage.setItem(metaLsKey(bookPath), json);
    } catch {
      // quota — the bookkeeping is the one thing here that may be lost
    }
    return;
  }
  try {
    await mkdir(await metaDir(), { recursive: true }).catch(() => {});
    await atomicWrite(await metaFile(bookPath), new TextEncoder().encode(json));
    const key = bookKey(bookPath);
    // The pre-binding sidecar readSidecar may have just answered from is now
    // stale; leaving it behind would resurrect old page numbers after a rebuild.
    if (key !== null && key !== hash(bookPath))
      await remove(await metaFile(bookPath, hash(bookPath))).catch(() => {});
  } catch (e) {
    console.error("glossary sidecar save failed", e);
  }
}

// ---- the book profile -------------------------------------------------------
//
// What pass 1.5 writes and every prompt after it reads: six lines about what
// this book is. It is a NEW FILE beside the .txt and the sidecar, and each of
// the three places it could otherwise have gone is closed, permanently:
//
//   • a field of the sidecar — no. parseSidecar is an exact-match version gate
//     (glossary.ts:645): it discards the WHOLE sidecar for any `v` it does not
//     equal, so bumping SIDECAR_VERSION to make room would destroy every book's
//     pages, freq, aliases, source, lang and target on the reader's disk. The
//     profile is worth exactly none of that.
//   • a header in the .txt — no, and not "not yet": glossary.ts:28 forecloses a
//     metadata header in that file for ever, and the parser keeps a line it
//     cannot understand verbatim, so a stray header would sit in the reader's
//     own glossary until they deleted it by hand.
//   • a field of TermRecord — no, for the reason «the sample sentence» gives
//     above: graphgen.ts:645 spreads records wholesale into the Claude payload
//     (`out.push({ ...rec, term })`), and README's privacy section promises that
//     what leaves this machine is the metadata and the term list. Page-derived
//     prose on a TermRecord is one spread away from breaking that.
//
// So: <appDataDir>/glossaries/<contentKey>.profile.json, through the same
// metaDir/atomicWrite pair the sidecar uses, with the same pre-binding path-hash
// fallback and the same localStorage flavour outside Tauri.

export const PROFILE_VERSION = 1;
export const PROFILE_EXT = ".profile.json";

/// What one book says about itself, in the reader's language.
///
/// `ui` is the interface language the brief was WRITTEN in, and it is a field
/// rather than an assumption because a reader who switches the interface to
/// English must not be handed a Russian brief to prompt an English model with.
/// bookBrief falls back to the old domain line in that case; the panel says so.
export type BookProfile = {
  v: 1;
  /// The book's own language, as pass 1.5 was told or detected it.
  lang: BookLang;
  ui: Lang;
  title?: string;
  authors?: string;
  /// The six answers. `subject` and `argument` are the two the pass refuses to
  /// write a file without; the rest may legitimately come back empty.
  subject: string;
  audience: string;
  argument: string;
  register: string;
  vocab: string;
  topics: string[];
  /// Date.now() at the write, so a later pass can say how old the brief is.
  written: number;
};

const profileLsKey = (bookPath: string): string => `pdfer:glossprofile:${bookPath}`;
const profileFile = async (bookPath: string, key = bookKey(bookPath) ?? hash(bookPath)): Promise<string> =>
  joinPath(await metaDir(), `${key}${PROFILE_EXT}`);

/// The sidecar's reader, one file over. Same two-step: the content key first,
/// then the pre-binding path hash, because a session that ran before the book
/// was content-bound wrote under the old name.
async function readProfileText(bookPath: string): Promise<string | null> {
  if (!IS_TAURI) return localStorage.getItem(profileLsKey(bookPath));
  try {
    return new TextDecoder().decode(await readFile(await profileFile(bookPath)));
  } catch {
    const key = bookKey(bookPath);
    if (key === null || key === hash(bookPath)) return null;
    try {
      return new TextDecoder().decode(await readFile(await profileFile(bookPath, hash(bookPath))));
    } catch {
      return null;
    }
  }
}

async function writeProfileText(bookPath: string, json: string): Promise<void> {
  if (!IS_TAURI) {
    try {
      localStorage.setItem(profileLsKey(bookPath), json);
    } catch {
      // quota — a brief is a nicety, and losing it costs one prompt line
    }
    return;
  }
  try {
    await mkdir(await metaDir(), { recursive: true }).catch(() => {});
    await atomicWrite(await profileFile(bookPath), new TextEncoder().encode(json));
    const key = bookKey(bookPath);
    if (key !== null && key !== hash(bookPath))
      await remove(await profileFile(bookPath, hash(bookPath))).catch(() => {});
  } catch (e) {
    console.error("book profile save failed", e);
  }
}

/// Read a book's profile, or null.
///
/// Null for a missing file, a truncated one, a JSON object of the wrong shape
/// and a `v` that is not PROFILE_VERSION — and null is the ordinary case, not a
/// failure: every book in the library has no profile until it has been read.
/// Nothing here throws, so a caller may call it unguarded.
///
/// The version test is exact rather than "≥", the same way parseSidecar's is,
/// and for the opposite reason: there is nothing here worth salvaging from a
/// shape we do not know, and a wrong brief is worse than no brief because every
/// prompt of every later pass would carry it.
export async function loadProfile(bookPath: string): Promise<BookProfile | null> {
  let raw: string | null;
  try {
    raw = await readProfileText(bookPath);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<BookProfile>;
    if (!o || typeof o !== "object" || o.v !== PROFILE_VERSION) return null;
    const s = (v: unknown): string => (typeof v === "string" ? v : "");
    if (!s(o.subject) || !s(o.argument)) return null; // the two the writer refuses to omit
    return {
      v: PROFILE_VERSION,
      lang: (typeof o.lang === "string" ? o.lang : UND) as BookLang,
      ui: o.ui === "en" ? "en" : "ru",
      ...(s(o.title) ? { title: s(o.title) } : {}),
      ...(s(o.authors) ? { authors: s(o.authors) } : {}),
      subject: s(o.subject),
      audience: s(o.audience),
      argument: s(o.argument),
      register: s(o.register),
      vocab: s(o.vocab),
      topics: Array.isArray(o.topics) ? o.topics.filter((t): t is string => typeof t === "string") : [],
      written: typeof o.written === "number" ? o.written : 0,
    };
  } catch {
    return null;
  }
}

async function saveProfile(bookPath: string, profile: BookProfile): Promise<void> {
  await writeProfileText(bookPath, JSON.stringify(profile));
}

/// The block every model prompt in this file starts with.
///
/// With a profile written under the interface language now in force, it is the
/// six lines the book wrote about itself. Without one — or with one written
/// while the interface was in the other language, which would put Russian
/// context in front of an English question — it falls back to EXACTLY the line
/// this file has always used: «Тематика книги (ключевые термины): …», built
/// from the book's own heaviest terms.
///
/// That fallback is not a courtesy. It is what keeps passes 2 and 3 working
/// unchanged on every glossary that exists today, which is all of them: nobody
/// has a profile until they click «Прочитать книгу» once.
export function bookBrief(profile: BookProfile | null, records: readonly TermRecord[]): string {
  const lines = profileBrief(profile);
  if (lines) return lines;
  const p = prompts();
  const domain = domainOf(records);
  return domain ? p.domainLine(domain) : "";
}

/// The profile half of bookBrief on its own: the six lines the book wrote about
/// itself, or "" when there is no usable profile. NEVER the frequency line.
///
/// This exists for exactly one caller and it is a fix, not a tidy-up. The veto
/// (vetoMinedTail) asks the model whether a mined string is a term of this book
/// or an example in it, and it used to be handed bookBrief — whose fallback is
/// domainOf, the top TEN records BY FREQUENCY. On the reader's own second book
/// that list is LED by «dark of the moon» at 56 occurrences, so with no profile
/// on disk the veto prompt opened with «Тематика книги (ключевые термины): dark
/// of the moon, star wars, …» and then asked, two paragraphs later, whether
/// «dark of the moon» is a term of this book. The prompt answered its own
/// question before the model read it, and the one string the whole pass exists
/// to remove was the one it was told to keep.
///
/// The rule this enforces is structural rather than careful: a question about a
/// list may not be prefaced by a brief BUILT FROM that list. domainOf is the
/// only such brief in this file, so keeping it out is the whole of it — and the
/// veto's caller additionally declines to run at all when this answers "",
/// rather than asking blind (see proposeTerms, `vetoBrief`).
///
/// bookBrief keeps the fallback and keeps its meaning: passes 2 and 3 ask about
/// terms they are simultaneously DESCRIBING, not selecting, so a bag of the
/// book's heaviest strings is a weak brief there and not a circular one.
function profileBrief(profile: BookProfile | null): string {
  return profile && profile.ui === getLang() ? prompts().briefLines(profile) : "";
}

export type LoadedGlossary = {
  /// The file exactly as it is on disk — what the reader's textarea shows.
  text: string;
  /// Its lines as records, in file order, with the sidecar applied.
  records: TermRecord[];
  meta: GlossaryMeta;
};

/// Read a book's glossary: the text, its records and its bookkeeping.
/// Nothing here throws — a missing file is an empty glossary and a mangled
/// sidecar is "no bookkeeping yet" (parseSidecar's contract).
export async function loadGlossary(bookPath: string): Promise<LoadedGlossary> {
  const text = await hydrateGlossary(bookPath);
  const meta = parseSidecar(await readSidecar(bookPath));
  return { text, records: applyMeta(parseGlossaryText(text), meta), meta };
}

export type SaveOptions = {
  /// The book's language and the language translations are IN. Left out, both
  /// keep whatever the sidecar already said — so a pass that learned neither
  /// cannot erase what another pass learned.
  lang?: BookLang;
  target?: BookLang;
  /// The confirmed rebuild: merge onto an empty base. The ONLY mode allowed to
  /// lose a line, and the only one that forgets the previous bookkeeping.
  fresh?: boolean;
  /// termKeys whose LINES are to be dropped before the merge.
  ///
  /// This is the only way a line leaves the file outside a rebuild, and it is a
  /// parameter rather than a side effect on purpose: mergeRecords guarantees
  /// every existing line survives byte for byte, so a pass that has to remove
  /// one has to say so out loud, at the call site, in a set the reader's
  /// features can be audited against.
  ///
  /// TWO passes are allowed to fill it, and no others. validateTerms' fold
  /// (`foldedKeys`) was the first. proposeTerms' veto over the mined tail is
  /// the second, and it was added when the veto was: the junk the miner ranks
  /// — `dark of the moon`, `star wars`, `False` — is written by pass 1 before
  /// any model exists to judge it, so pass 1.7 cannot merely decline to add
  /// those lines, it has to take them back out. Both sets are built the same
  /// careful way: only lines mayFold() allows, i.e. never a line the reader
  /// typed.
  remove?: ReadonlySet<string>;
  /// termKeys whose DEFINITION is to be dropped from their line before the
  /// merge, the line otherwise left where it is.
  ///
  /// The second explicit argument, for the same reason as `remove`: the merge
  /// fills empty fields and cannot empty a full one, so the check pass's
  /// verdict on a definition reaches the file here or nowhere. The term, its
  /// translation and its category are untouched — the pass judged one sentence
  /// and takes back one sentence. Pass exactly `validateTerms`'s `clearedKeys`.
  clearDefs?: ReadonlySet<string>;
};

export type SaveResult = {
  text: string;
  added: number;
  updated: number;
  meta: GlossaryMeta;
};

/// Drop the lines whose term is in `remove`, and nothing else. A comment, a
/// blank line and a line that parses as no term are all left where they are —
/// they are the reader's paragraphing and their notes, and a fold has no
/// opinion about them. The file's line ending and its trailing-newline-ness
/// survive, the same way mergeRecords keeps them.
function stripLines(text: string, remove?: ReadonlySet<string>): string {
  if (!remove?.size || !text) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const last = lines.length - 1;
  const kept = lines.filter((line, i) => {
    if (i === last && line === "") return true; // the empty field a trailing newline leaves
    const r = parseGlossaryLine(line);
    return !r || !remove.has(termKey(r.term));
  });
  return kept.join(eol);
}

/// Drop the definition from the lines whose term is in `clear`, keeping the
/// term, its translation and its category. The line is reprinted rather than
/// truncated by hand, because the definition is the last slot only when the
/// line is well-formed and a hand-edited file need not be; reprinting is the
/// same fallback mergeRecords takes when it cannot append (see firstNewSlot).
/// A comment, a blank line and a line that parses as no term are left alone.
function stripDefinitions(text: string, clear?: ReadonlySet<string>): string {
  if (!clear?.size || !text) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const last = lines.length - 1;
  const out = lines.map((line, i) => {
    if (i === last && line === "") return line;
    const r = parseGlossaryLine(line);
    if (!r || !r.definition || !clear.has(termKey(r.term))) return line;
    const { definition: _gone, ...rest } = r;
    return formatLine(rest);
  });
  return out.join(eol);
}

/// Fold records into the book's glossary and persist both halves.
///
/// The order is the one glossary.ts prescribes and it is not interchangeable:
/// merge first (every existing line survives byte for byte), re-parse what the
/// merge produced, and build the sidecar from THAT — buildSidecar drops every
/// term it is not shown, so it has to be shown the whole file.
///
/// It always writes, even when the merge changed nothing: the reader may have
/// deleted a line by hand, and the sidecar has to stop describing it.
///
/// THE MERGE BASE IS READ HERE, AND THERE IS NO WAY FOR A CALLER TO SUPPLY ONE.
/// That is the whole of the fix for a defect this change shipped into review:
/// the panel used to hand over its textarea as the base, and pass 1 evaluated
/// that argument at the click — before a whole-book read that runs for minutes
/// on an 838-page book. Everything that reached the file in between (the
/// context menu's «Добавить в глоссарий», the reader typing into the very
/// textarea the snapshot came from, a background graph pass feeding back what
/// it learned) was merged out of existence when the read finished, silently,
/// on disk and on screen at once.
///
/// The base is knowable at exactly one moment — the one just before the write —
/// and only one party is in a position to read it then, which is this function.
/// An option that let a caller pass one could not be made safe by documenting
/// it: every caller of a long pass would have to remember to re-read at the
/// tail, and the one that forgot would fail exactly this way again.
///
/// What a caller loses is the unsaved keystroke. hydrateGlossary answers from
/// translate.ts's session cache, which saveGlossaryText updates synchronously,
/// so «the file» here means «everything anybody has flushed», not «everything
/// that has reached the disk». The panel flushes its textarea before every run
/// and again on blur and on a 600 ms debounce, so the exposure is the text of
/// the last 600 ms of typing — against which the merge previously lost the
/// entire run. A panel that wants that window closed too can flush on every
/// keystroke while a pass is running; nothing here has to change for it.
export async function saveGlossary(
  bookPath: string,
  incoming: readonly TermRecord[],
  opts: SaveOptions = {},
): Promise<SaveResult> {
  const fresh = opts.fresh === true;
  const prev = parseSidecar(await readSidecar(bookPath));
  const base = stripDefinitions(stripLines(await hydrateGlossary(bookPath), opts.remove), opts.clearDefs);
  const merged = mergeRecords(base, incoming, { fresh });

  // The merge speaks the .txt's three text fields; the bookkeeping rides along
  // on `incoming` and has to be re-attached to the parsed lines before the
  // sidecar is built. First spelling of a term owns it, as in mergeRecords.
  const extra = new Map<string, TermRecord>();
  for (const r of incoming) {
    const k = termKey(r.term ?? "");
    if (k && !extra.has(k)) extra.set(k, r);
  }
  const whole = parseGlossaryText(merged.text).map((r) => {
    const inc = extra.get(termKey(r.term));
    if (!inc) return r;
    const out: TermRecord = { ...r };
    if (inc.kind) out.kind = inc.kind;
    if (inc.aliases?.length) out.aliases = inc.aliases;
    if (inc.pages?.length) out.pages = inc.pages;
    if (inc.freq !== undefined) out.freq = inc.freq;
    if (inc.source) out.source = inc.source;
    return out;
  });

  const meta = buildSidecar(whole, {
    lang: opts.lang ?? prev.lang,
    target: opts.target ?? prev.target,
    prev: fresh ? null : prev,
  });

  // saveGlossaryText is deliberately not awaitable (translate.ts:146): it
  // updates the session cache synchronously — which is what every synchronous
  // reader in the app sees — and persists in the background with its own
  // fallback. So the two halves are written independently; a machine that
  // cannot write the .txt keeps the text in localStorage and gets a sidecar
  // describing it, which is the same state as any interrupted run.
  saveGlossaryText(bookPath, merged.text);
  await writeSidecar(bookPath, formatSidecar(meta));
  return {
    text: merged.text,
    added: merged.added,
    updated: merged.updated,
    meta,
  };
}

// ---- pass 1: mining ---------------------------------------------------------

export type MineOptions = {
  /// The book's language. Given, it is believed — this is the reader's override
  /// and it beats detection. Absent, it is detected from the book itself.
  lang?: BookLang;
  /// How many terms the run keeps, best first. Default DEFAULT_CAP.
  cap?: number;
  signal?: AbortSignal;
  /// Counted in PAGES READ, so the bar is the book and not the term list.
  onProgress?: (done: number, total: number) => void;
  /// The confirmed rebuild. It means to saveGlossary exactly what it means
  /// there; mining itself ignores it. There is deliberately no companion
  /// `base` — see saveGlossary for why nobody may hand this pass one.
  fresh?: boolean;
};

type RawMine = { terms: MinedTerm[]; lang: BookLang; confidence: number; lookup: TermLookup };

/// Read the whole book and count. Statistics have no context limit, so unlike
/// the graph — which samples — the glossary reads every page.
///
/// Detection first, over a spread of DETECT_PAGES pages: the stoplists depend
/// on the language, so the miner cannot be built before it is known, and a
/// spread is the primary defence against answering "und" off a title page or a
/// formula page (booklang's own note). Those pages are read twice, which on an
/// 838-page book is 2% more work and buys the difference between mining a
/// Russian book and mining the Latin islands inside it.
///
/// An abort THROWS here rather than returning a prefix. A term list mined from
/// the first thirty pages of a book is not "partial work", it is a different
/// and much worse list, and mineGlossary writes what it mines.
async function runMine(doc: PDFDocumentProxy, opts: MineOptions): Promise<RawMine> {
  const { signal, onProgress } = opts;
  const total = doc.numPages;
  const cap = opts.cap ?? DEFAULT_CAP;

  let lang = opts.lang ?? UND;
  let confidence = opts.lang ? 1 : 0;
  if (!opts.lang) {
    const samples: string[] = [];
    for (const n of spreadPages(total, DETECT_PAGES)) {
      if (signal?.aborted) abortErr();
      const ps = await pageParagraphs(doc, n);
      if (ps.length && !isCitationPage(ps)) samples.push(paraText(ps));
    }
    const det = detectBookLang(samples);
    lang = det.lang;
    confidence = det.confidence;
  }

  // minPages is the graph miner's rule and it applies here for the same reason:
  // a candidate met many times on ONE page is a local coinage, a running head or
  // a table column, not a term of the book. Keyed on the page count rather than
  // on pages mined so the miner can be built before the read loop, as graphgen
  // builds its own floors.
  const miner = createMiner({
    lang,
    cap,
    minFreq: MIN_FREQ,
    minPages: total >= 4 ? 2 : 1,
    withPages: true,
    withSample: true,
  });

  for (let n = 1; n <= total; n++) {
    if (signal?.aborted) abortErr();
    const ps = await pageParagraphs(doc, n);
    if (ps.length && !isCitationPage(ps)) miner.addPage(n, paraText(ps));
    onProgress?.(n, total);
    if (n % 20 === 0) await tick();
  }
  // The live miner leaves with the result. finish() is pure over the counts —
  // terms.ts says so — so handing `lookup` out does not disturb the ranked list
  // this call already produced, and it saves proposeTerms a second whole-book
  // read. What it costs is the counts staying alive; rememberMiner bounds that.
  return { terms: miner.finish(), lang, confidence, lookup: (t) => miner.lookup(t) };
}

// ---- the live miner ---------------------------------------------------------
//
// The counts a whole-book mining run built, kept for the length of a click or
// two so that «Найти термины» followed by «Прочитать книгу» reads the book once
// instead of twice. On the reader's 838-page book that is a minute saved and
// 82 000 n-grams at roughly 75 MB held (graphgen.ts:196) — which is why the map
// holds ONE book and drops the previous one the moment another book's miner is
// built. The sample store above can afford four books because a sentence is
// bytes; a miner cannot, because a miner is the book.
//
// It is deliberately not a cache in the sense of "answer from it later": the
// counts describe the file as it stood when the read finished, and nothing
// invalidates them. proposeTerms is the only reader, it runs in the same
// sitting, and it treats the answer as evidence rather than as truth (freq 0
// means unverified — see TermLookup).

const MINER_BOOKS = 1;
type HeldMiner = { lookup: TermLookup; terms: MinedTerm[] };
const minersByBook = new Map<string, HeldMiner>();

function rememberMiner(bookPath: string, held: HeldMiner): void {
  minersByBook.delete(bookPath); // re-insert, so this book is the newest
  minersByBook.set(bookPath, held);
  for (const old of minersByBook.keys()) {
    if (minersByBook.size <= MINER_BOOKS) break;
    minersByBook.delete(old);
  }
}

/// Pass 1. Model-free, always available, and it writes.
///
/// This is the pass that makes "no aux model installed" an honest state rather
/// than a failure: after it, the .txt holds the book's terms and the sidecar
/// holds their pages and frequencies. Everything else is a field that is still
/// empty, and the UI is expected to say so in those words.
export async function mineGlossary(
  doc: PDFDocumentProxy,
  bookPath: string,
  opts: MineOptions = {},
): Promise<MineResult> {
  const fresh = opts.fresh === true;
  const { terms, lang, confidence, lookup } = await runMine(doc, opts);
  rememberMiner(bookPath, { lookup, terms });

  const prev = fresh ? null : await loadGlossary(bookPath);
  // What counts as "already there", read as late as it can be read: this is the
  // line before the write, and hydrateGlossary answers both this and
  // saveGlossary's own read out of the same session cache.
  //
  // It decides ONE thing — whether this run claims the line as its own (see the
  // provenance stamp below) — and it is not a merge base: saveGlossary reads
  // that itself, at the write, and nothing here may pin it.
  const have = new Set(parseGlossaryText(fresh ? "" : (prev?.text ?? "")).map((r) => termKey(r.term)));
  // Spellings a validation run folded away must not come back. Without this the
  // two passes fight for ever: pass 3 folds «inverted indexes» into «inverted
  // index», the miner still counts it, and the next run re-adds the line the
  // reader just watched disappear.
  const aliased = new Set<string>();
  for (const m of Object.values(prev?.meta.terms ?? {}))
    for (const a of m.aliases ?? []) aliased.add(termKey(a));

  const samples = new Map<string, string>();
  const incoming: TermRecord[] = [];
  for (const m of terms) {
    const k = termKey(m.term);
    if (!k || aliased.has(k)) continue;
    if (m.sample) samples.set(k, m.sample);
    // The provenance stamp goes on the lines this run PUTS IN THE FILE, and on
    // no others. It is the durable form of "this line is the machine's, not the
    // reader's", and pass 3 folds duplicates by exactly that (see mayFold).
    //
    // Stamping every mined term instead would rewrite the provenance of a line
    // the reader typed into the .txt by hand the moment the miner happened to
    // count that term too — and a hand-typed line has no sidecar entry at all,
    // so there is nothing else about it left to tell it apart. (A line added
    // through «Добавить в глоссарий» is safe either way: glossary.ts's
    // mergeSidecarEntry never lets a source leave "user".) The pages and the
    // frequency still go on, because those are counts and they are this run's
    // to update whoever wrote the line.
    const fromHere = !have.has(k);
    incoming.push(
      fromHere
        ? { term: m.term, pages: m.pages, freq: m.freq, source: "mined" }
        : { term: m.term, pages: m.pages, freq: m.freq },
    );
  }
  rememberSamples(bookPath, samples);

  const saved = await saveGlossary(bookPath, incoming, { lang, fresh });
  const meta = saved.meta;
  const records = withSamples(bookPath, applyMeta(parseGlossaryText(saved.text), meta));
  return {
    records,
    lang,
    confidence,
    added: saved.added,
    updated: saved.updated,
    lookup,
  };
}

// ---- reply gates ------------------------------------------------------------
//
// Lifted from graphgen.ts:1691-1760, which is itself this file's old
// plausible()/junky() pair aimed at a line format instead of a single term. A
// gate that rejects the WHOLE reply is cheaper than one that rejects lines: a
// model which lost the format lost it for every line, and half a malformed
// reply is worse than a retry.

// Kana and Han ideographs. graphgen spells the same net as a codepoint range;
// this one asks Unicode for the scripts by name, which is how booklang.ts
// writes every script test in this project and needs no escape to survive an
// editor, a diff or a copy-paste.
const CJK_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/gu;

/// Did the answer come back in the alphabet the reader reads at all? Qwen
/// answers in Chinese often enough that this is a real gate and not a
/// formality.
const hasAlphabet = (text: string, lang: Lang): boolean =>
  lang === "ru" ? /[А-Яа-яЁё]/.test(text) : /[A-Za-z]/.test(text);

/// The stricter form, for a field that is known to be reader-language PROSE.
///
/// graphgen applies the CJK-density half to whole replies; here it may only be
/// applied field by field, because a reply about a Chinese book's terms is
/// CJK-dense by construction and a rule meant to catch "the model answered in
/// Chinese" must not fire on "the book is in Chinese".
function alphabetOk(text: string, lang: Lang): boolean {
  if (!text) return false;
  if ((text.match(CJK_RE)?.length ?? 0) > text.length * 0.05) return false;
  return hasAlphabet(text, lang);
}

/// Whole-reply rejection: empty, a runaway far longer than the answer could
/// legitimately be, the instructions recited back, the separator gone, or — for
/// a reply that is supposed to be PROSE in the reader's language — the wrong
/// alphabet. `perItem` is the character budget one answer line may take.
///
/// `needAlphabet` is false for the two validation prompts, and that is not
/// laziness: their replies are «да»/«нет» beside terms in the BOOK's language,
/// so a Russian reader validating an English book gets a reply that is mostly
/// Latin by design. The verdict words are that gate instead.
function replyRejected(
  raw: string,
  items: number,
  perItem: number,
  needSep: boolean,
  needAlphabet: boolean,
): boolean {
  const text = raw.trim();
  if (!text) return true;
  if (text.length > 400 + items * perItem) return true;
  for (const marker of prompts().echo) if (text.includes(marker)) return true;
  if (needSep && !text.includes(SEP)) return true;
  return needAlphabet && !hasAlphabet(text, getLang());
}

/// Strip the numbering and bullet prefixes every model adds eventually.
const unbullet = (line: string): string => line.replace(/^\s*(?:[-*•]\s+|\d{1,2}[.)]\s+)/, "").trim();

/// Index the terms a call asked about by their folded id, so that a model which
/// answers about «IR systems» when asked about «IR system» is understood. Same
/// fold the graph uses, so the two features agree on what "the same term" is.
function askedIndex(asked: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const term of asked) {
    const k = conceptId(term);
    if (k && !out.has(k)) out.set(k, term);
  }
  return out;
}

// Both languages are accepted whichever one was asked in: a model asked in
// Russian sometimes answers «yes» and then goes on in Russian, and refusing
// that would throw away a good answer over a word (graphgen's TAGS_LINE takes
// the same view). \b is ASCII-only in JS, so the boundary is a negated
// letter-property lookahead instead — «нет» must not match inside «нетривиально».
const YES_RE = /^(да|yes|верно|true)(?!\p{L})/iu;
const NO_RE = /^(нет|no|неверно|false)(?!\p{L})/iu;

/// Does any line of the reply carry a verdict at all? Used as the accept test,
/// so a model that writes a preamble before answering still gets read — the
/// parser scans lines too.
///
/// Both places a verdict can sit are checked, and that is not belt and braces:
/// the duplicate prompt asks for «ДА :: написание», where the word opens the
/// line, and the definition prompt asks for «термин :: да», where it closes it.
/// Testing only the head made the definition pass reject every correct answer
/// three times over and then report that the model had said nothing.
const hasVerdict = (raw: string): boolean =>
  raw.split(/\r?\n/).some((l) => {
    const c = unbullet(l);
    const tail = c.includes(SEP)
      ? c
          .split(/\s*::\s*/)
          .slice(1)
          .join(" ")
          .trim()
      : "";
    return YES_RE.test(c) || NO_RE.test(c) || (!!tail && (YES_RE.test(tail) || NO_RE.test(tail)));
  });

/// One definition, tidied and then judged. Rejection returns "" — the term
/// keeps its line and loses only a sentence of prose, which is the failure a
/// reader can live with (graphgen.ts:1737 says so first).
function cleanDefinition(raw: string, term: string, lang: Lang, sample?: string): string {
  let g = flat(raw);
  const quoted = g.match(/^[«"“'‘]+(.+?)[»"”'’]+$/);
  if (quoted) g = quoted[1].trim();
  g = g.replace(/^[-–—:•*\s]+/, "").trim();
  // One sentence: the format asked for one, and a model that wrote three has
  // written a paragraph into a field the panel renders on a single row.
  const stop = g.search(/[.!?](?:\s|$)/);
  if (stop > 20) g = g.slice(0, stop + 1);
  g = flat(g);
  if (!g || g.length > DEF_MAX) return "";
  if (g.includes(SEP)) return ""; // the line's own format leaked into the field
  if (!/[\p{L}\p{N}]/u.test(g)) return "";
  if (conceptId(g) === conceptId(term)) return ""; // the term echoed back is not a definition
  if (!alphabetOk(g, lang)) return "";
  // The model quoting its context instead of defining the term — this file's
  // own junky() rule, which caught exactly this against a real model.
  //
  // NARROWED, and this reverses half of the original decision on purpose. The
  // rule was `sample.includes(g)`: any definition that occurred anywhere inside
  // the sample sentence was thrown away. That is exactly wrong for the pass
  // this change builds — enrichUser now asks for a definition of what the term
  // is IN THIS BOOK, and a definition grounded in the book will often reuse the
  // author's own phrase for it. Rejecting those rejects the outcome we are
  // after.
  //
  // What the rule was written to catch is a model copying its context wholesale
  // instead of defining anything, so that is now what it tests: a VERBATIM RUN
  // of ECHO_WORDS words, folded, against the clipped sample the model actually
  // saw. Clipped, because only listItems' SAMPLE_IN_PROMPT characters ever
  // reached the prompt (line ~411) while `sample` here is the miner's full
  // 300-character sentence — comparing against the untruncated one would test
  // for copying of text the model was never shown.
  if (sample && copiesSample(g, sample)) return "";
  return g;
}

/// The length of a verbatim run that means "copied", in words.
///
/// Eight is chosen against the shape of the two texts rather than measured: a
/// definition is capped at DEF_MAX=200 characters and runs 60-100 in practice,
/// which is ten to fifteen Russian words, so eight consecutive words lifted out
/// of a 160-character window is most of the answer. Below that the overlap is a
/// term and its neighbours, which is what a book-grounded definition looks like.
const ECHO_WORDS = 8;

function copiesSample(definition: string, sample: string): boolean {
  const seen = outNorm(flat(sample).slice(0, SAMPLE_IN_PROMPT));
  if (!seen) return false;
  const w = outNorm(definition).split(" ").filter(Boolean);
  if (w.length < ECHO_WORDS) return false;
  for (let i = 0; i + ECHO_WORDS <= w.length; i++)
    if (seen.includes(w.slice(i, i + ECHO_WORDS).join(" "))) return true;
  return false;
}

const CAT_JUNK = /[.!?;]$/;

/// A category is a short noun phrase, free-form and in the reader's language.
/// Anything that reads as a sentence is the model answering the definition
/// question in the wrong slot, and a category that repeats the term says
/// nothing.
function cleanCategory(raw: string, term: string, lang: Lang): string {
  let c = flat(raw).replace(/^[-–—:•*\s]+/, "");
  c = c.replace(CAT_JUNK, "").trim();
  if (!c || c.length > CAT_MAX) return "";
  if (c.split(/\s+/).length > CAT_WORDS) return "";
  if (c.includes(SEP)) return "";
  if (!/[\p{L}\p{N}]/u.test(c)) return "";
  if (conceptId(c) === conceptId(term)) return "";
  if (isTermKind(c.toLowerCase())) return ""; // the kind word in the category slot
  return alphabetOk(c, lang) ? c : "";
}

/// Could this field be the kind rather than the category? The six words are a
/// closed list, so the test is exact.
const kindOf = (s: string): TermKind | null => {
  const k = flat(s).toLowerCase();
  return isTermKind(k) ? k : null;
};

/// Is this field short enough to be a category rather than a definition? Used
/// only when the model gave one field where two were asked for.
const looksLikeCategory = (s: string): boolean => {
  const c = flat(s);
  return c.length <= CAT_MAX && c.split(/\s+/).length <= CAT_WORDS && !CAT_JUNK.test(c);
};

// ---- the aux call -----------------------------------------------------------

/// Several attempts, warming up: 0.2 is near-deterministic, so an identical
/// retry would fail identically. Straight from graphgen.ts:1834, including the
/// reasoning about 503 — llama-server answers it while the model is still
/// loading, which is precisely the case where waiting and asking again works.
/// Only a server that then fails its own /health probe is treated as gone.
///
/// Returns null for every model fault there is. Nothing here throws except an
/// abort, which the caller turns into "stop with what we have".
async function auxAttempts(
  messages: ChatMessage[],
  maxTokens: number,
  signal: AbortSignal | undefined,
  accept: (raw: string) => boolean,
): Promise<string | null> {
  for (let attempt = 0; attempt < AUX_TRIES; attempt++) {
    if (signal?.aborted) abortErr();
    try {
      const raw = await auxComplete(messages, signal, {
        temperature: attempt === 0 ? 0.2 : 0.7,
        maxTokens,
      });
      if (accept(raw)) return raw;
    } catch (e) {
      if (isAbortErr(e) || signal?.aborted) throw e;
      if (attempt === AUX_TRIES - 1) return null;
      await sleep(AUX_RETRY_MS, signal);
      if (!(await isAuxUp())) return null; // genuinely gone: stop, do not grind
    }
  }
  return null;
}

/// Run `jobs` through CONCURRENCY workers over a shared cursor, each writing
/// into its own slot so the output order is the input order however the replies
/// interleave. An abort stops the workers and resolves with what finished —
/// the model passes are expensive per item and throwing away eleven good
/// answers because the twelfth was cancelled helps nobody.
async function pooled<T>(count: number, run: (k: number) => Promise<T>): Promise<(T | null)[]> {
  const out: (T | null)[] = Array.from({ length: count }, () => null);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const k = next++;
      if (k >= count) return;
      try {
        out[k] = await run(k);
      } catch (e) {
        if (isAbortErr(e)) return;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, count)) }, worker));
  return out;
}

// ---- pass 1.5: the book profile ---------------------------------------------

/// Outline headings, flattened to one line. Only the top two levels: a deep
/// outline is mostly numbered subsections and says less about the subject
/// matter than the chapter names it buries.
///
/// A TWIN of graphgen.ts:1138, copied character for character and NOT imported,
/// for the reason NAMES_RULE above gives about itself: graphgen imports
/// loadGlossary/saveGlossary from this module, and an import back would close a
/// cycle. The duplication is load-bearing — both texts end up in front of the
/// same model describing the same book — so change both together or neither.
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
  return line.length > PROFILE_TOC ? `${line.slice(0, PROFILE_TOC - 1)}…` : line;
}

/// The six answers, before they become a BookProfile.
type ParsedProfile = {
  subject: string;
  audience: string;
  argument: string;
  register: string;
  vocab: string;
  topics: string[];
};

/// How much of each answer is kept. `argument` is asked for as two sentences
/// and gets room for two; the rest are one line each and one line is what the
/// brief prints, so a model that writes a paragraph into the ТОН slot loses the
/// paragraph rather than the brief.
const PROFILE_FIELD_MAX: Record<ProfileField, number> = {
  subject: 160,
  audience: 160,
  argument: 400,
  topics: 200,
  vocab: 160,
  register: 160,
};
const PROFILE_TOPIC_MAX = 48;
const PROFILE_TOPICS = 10;

/// Read the six labelled lines back, or null.
///
/// Null is the model fault, and it is never a throw: the caller writes no file
/// and the book stays unprofiled, which is the state every book is in until it
/// has been read once.
///
/// Two things make a reply unusable. The FORM recited back — «ОБЛАСТЬ:
/// дисциплина и предмет книги, одна строка» parses beautifully and says
/// nothing, which is why profileEcho exists separately from `echo`. And an
/// empty ОБЛАСТЬ or О ЧЁМ: those two are what every later prompt leans on, and
/// a brief without them is worse than the frequency line it would replace.
function parseProfile(raw: string): ParsedProfile | null {
  const p = prompts();
  for (const marker of p.profileEcho) if (raw.includes(marker)) return null;

  // ё folds onto е for the LABEL only. A model asked for «О ЧЁМ» answers «О
  // ЧЕМ» often enough that the alternative is discarding good briefs over a
  // diacritic — and the reader's own book has adjacent paragraphs that spell it
  // both ways. The VALUE is never folded: that is the reader's prose.
  const fold = (s: string): string => s.replace(/ё/g, "е").replace(/Ё/g, "Е");
  const got = new Map<ProfileField, string>();
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = unbullet(line);
    const colon = cleaned.indexOf(":");
    if (colon <= 0) continue;
    // Markdown bold and hashes come off the label; letters and spaces are all a
    // label may be, and the six of them are a closed list.
    const head = fold(cleaned.slice(0, colon))
      .toUpperCase()
      .replace(/[^\p{L} ]/gu, "")
      .trim();
    const hit = p.profileFields.find(([label]) => label === head);
    if (!hit || got.has(hit[1])) continue;
    // The other half of a markdown-bold label — «**ОБЛАСТЬ:** …» leaves its
    // closing asterisks on the front of the value. Same leading-junk strip
    // cleanDefinition uses, for the same reason.
    const value = flat(cleaned.slice(colon + 1))
      .replace(/^[-–—:•*_\s]+/, "")
      .slice(0, PROFILE_FIELD_MAX[hit[1]]);
    if (value) got.set(hit[1], value);
  }

  const subject = got.get("subject") ?? "";
  const argument = got.get("argument") ?? "";
  if (!subject || !argument) return null;
  // The reader's alphabet, field by field. The measured defect this whole
  // change answers is a model breaking into Chinese mid-sentence, and a brief
  // that does it would carry the leak into every prompt after it.
  const lang = getLang();
  if (!alphabetOk(subject, lang) || !alphabetOk(argument, lang)) return null;

  return {
    subject,
    audience: got.get("audience") ?? "",
    argument,
    register: got.get("register") ?? "",
    vocab: got.get("vocab") ?? "",
    topics: (got.get("topics") ?? "")
      .split(/[,;]/)
      .map((t) => flat(t).slice(0, PROFILE_TOPIC_MAX))
      .filter(Boolean)
      .slice(0, PROFILE_TOPICS),
  };
}

export type ProfileOptions = {
  /// The book's language. Given, it is believed; absent, it is detected from
  /// the very pages this pass reads anyway, so the profile costs no extra read.
  lang?: BookLang;
  signal?: AbortSignal;
  /// Counted in PAGES READ — at most PROFILE_FRONT_PAGES + PROFILE_PAGES of
  /// them, so the bar finishes long before the model answers. The model call is
  /// one call and has no progress to report; the panel's row goes on saying
  /// «читаю» until it lands.
  onProgress?: (done: number, total: number) => void;
};

/// Pass 1.5. One model call, one small file, and every prompt after it changes.
///
/// It reads its OWN sample and assumes no other pass has run: the PDF Info
/// title and authors, the outline's top two levels, the opening prose of the
/// first pages, and one excerpt from each of sixteen pages spread through the
/// book. The excerpt is the LONGEST PROSE paragraph of its page rather than the
/// first 350 characters, and that is not fussiness: the head of a page is the
/// running head, the folio and a section heading far more often than it is a
/// sentence, and a profile built from those describes the typesetting. What the
/// brief is asked to name — the register, the vocabulary, whom the book is
/// addressing — is visible in body prose and nowhere else.
///
/// It writes the file on success and NOTHING on failure. A dead aux server, a
/// reply that failed its gate, a book with no prose in it at all: each resolves
/// with `{ profile: null }`, and the book simply stays unprofiled, which is
/// what bookBrief's fallback exists for.
export async function profileBook(
  doc: PDFDocumentProxy,
  bookPath: string,
  opts: ProfileOptions = {},
): Promise<{ profile: BookProfile | null; aborted: boolean }> {
  const { signal, onProgress } = opts;
  try {
    const total = doc.numPages;
    const frontPages = Array.from({ length: Math.min(PROFILE_FRONT_PAGES, total) }, (_, i) => i + 1);
    const excerptPages = spreadPages(total, PROFILE_PAGES);
    const wantFront = new Set(frontPages);
    const wantExcerpt = new Set(excerptPages);
    const wanted = [...new Set([...frontPages, ...excerptPages])].sort((a, b) => a - b);

    const frontParts: string[] = [];
    const excerpts: string[] = [];
    const excerptAt: number[] = [];
    const detect: string[] = [];
    let read = 0;
    onProgress?.(0, wanted.length);
    for (const n of wanted) {
      if (signal?.aborted) abortErr();
      const ps = await pageParagraphs(doc, n);
      if (wantFront.has(n)) frontParts.push(paraText(prose(ps)));
      if (wantExcerpt.has(n)) {
        const ex = longestProse(ps, PROFILE_EXCERPT);
        if (ex) {
          excerpts.push(`[${n}] ${ex}`);
          excerptAt.push(n);
        }
      }
      // Detection rides along on pages that are being read regardless — the
      // spread is exactly what booklang asks for and a title page alone is what
      // it warns against.
      if (ps.length && !isCitationPage(ps)) detect.push(paraText(ps));
      onProgress?.(++read, wanted.length);
      if (read % 8 === 0) await tick();
    }

    const info = (await doc
      .getMetadata()
      .then((m) => (m?.info ?? {}) as unknown as Record<string, unknown>)
      .catch(() => ({}) as Record<string, unknown>)) as Record<string, unknown>;

    const input: ProfileInput = {
      title: flat(str(info.Title)).slice(0, 200),
      authors: flat(str(info.Author)).slice(0, 200),
      toc: await outlineHeadings(doc),
      front: flat(frontParts.join(" ")).slice(0, PROFILE_FRONT),
      pages: excerptAt.join(", "),
      excerpts: excerpts.join("\n"),
    };
    // Nothing to describe. A book of scanned plates with no text layer reaches
    // here, and asking a model about an empty prompt would earn an invented
    // brief — the exact failure this pass exists to end.
    if (!input.front && !input.excerpts) return { profile: null, aborted: false };

    const p = prompts();
    const raw = await auxAttempts(
      [
        { role: "system", content: p.profileSystem },
        { role: "user", content: p.profileUser(input) },
      ],
      PROFILE_BUDGET,
      signal,
      (r) => !replyRejected(r, 6, 220, false, true) && parseProfile(r) !== null,
    );
    // Parsed twice on purpose: auxAttempts' `accept` answers a boolean and
    // nothing else, and threading the parse out through a captured variable
    // would trade one cheap re-parse for a nullability the compiler cannot
    // follow into a callback.
    const fields = raw === null ? null : parseProfile(raw);
    if (!fields) return { profile: null, aborted: false };

    const profile: BookProfile = {
      v: PROFILE_VERSION,
      lang: opts.lang ?? detectBookLang(detect).lang,
      ui: getLang(),
      ...(input.title ? { title: input.title } : {}),
      ...(input.authors ? { authors: input.authors } : {}),
      subject: fields.subject,
      audience: fields.audience,
      argument: fields.argument,
      register: fields.register,
      vocab: fields.vocab,
      topics: fields.topics,
      written: Date.now(),
    };
    await saveProfile(bookPath, profile);
    return { profile, aborted: false };
  } catch (e) {
    // Only an abort changes control flow, and even that becomes a return here
    // rather than a throw: the caller asked for a profile and gets the honest
    // answer that there is none, with `aborted` saying whose decision that was.
    if (isAbortErr(e) || signal?.aborted) return { profile: null, aborted: true };
    console.error("book profile failed", e);
    return { profile: null, aborted: false };
  }
}

// ---- pass 1.7: terms the model names ----------------------------------------

/// Does this proposal actually occur in the text the model was shown?
///
/// The «do not invent» gate. It cannot be a plain substring test, and the
/// reason is the prompt's own next rule: it asks for the term «в именительном
/// падеже единственного числа», and for a Russian book that form almost never
/// occurs verbatim in running text. The page says «инвертированного индекса»,
/// the model correctly answers «инвертированный индекс», and a literal test
/// deletes it — while keeping every proposal the model failed to normalise.
/// The same holds in English for any term the book uses in the plural.
///
/// So it folds first, with the project's own primitive (outNorm, as textsim
/// prescribes for every comparison in this codebase), and then accepts either a
/// folded substring or every token's first PROPOSE_STEM characters occurring in
/// order and at word starts. Five characters is a stem in both languages this
/// app reads; requiring them IN ORDER is what keeps the test from degenerating
/// into "these letters appear somewhere on the page".
function occursIn(chunkNorm: string, term: string): boolean {
  const t = outNorm(term);
  if (!t || !chunkNorm) return false;
  if (chunkNorm.includes(t)) return true;
  let from = 0;
  for (const token of t.split(" ")) {
    if (!token) continue;
    const stem = token.slice(0, PROPOSE_STEM);
    let at = chunkNorm.indexOf(stem, from);
    // Word starts only. outNorm leaves exactly one space between tokens, so a
    // stem matched mid-word belongs to some other word.
    while (at > 0 && chunkNorm[at - 1] !== " ") at = chunkNorm.indexOf(stem, at + 1);
    if (at < 0) return false;
    from = at + stem.length;
  }
  return true;
}

/// One proposal per line, unbulleted, gated. Returns the surviving surface
/// forms in reply order.
function parseProposals(raw: string, chunkNorm: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    // unbullet knows "-", "*", "•" and "1."; the dash run is here because the
    // prompt's OWN rules are written with «—» and a model mirrors the bullet it
    // was shown. Left on, the dash would reach the reader's .txt as part of the
    // term, and outNorm would hide it from every gate below.
    const term = unbullet(line)
      .replace(/^[-–—•*\s]+/, "")
      .replace(/^[«"“'‘]+|[»"”'’]+$/g, "")
      .replace(/[.;,:]+$/, "")
      .trim();
    if (!term || term.length > PROPOSE_TERM_CHARS) continue;
    if (term.split(/\s+/).filter(Boolean).length > PROPOSE_TERM_WORDS) continue;
    if (term.includes(SEP)) continue; // another prompt's line format leaking in
    if (!/\p{L}/u.test(term)) continue;
    if (!occursIn(chunkNorm, term)) continue;
    const k = termKey(term);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(term);
  }
  return out;
}

// ---- the veto over the mined tail -------------------------------------------
//
// The one gate between the C-value miner and the reader's file, and the reason
// it exists is the list at the top of this module: `dark of the moon` (a sample
// search query, 56 occurrences, used as a running example), `star wars`, `cat
// in the hat`, the Python literal `False` and the SQL keyword `SELECT` all
// clear the miner's floors — MIN_FREQ 5 and minPages 2 — because they honestly
// are frequent and honestly are spread through the book. Frequency has no
// opinion about the difference between a term OF a book and an example IN it.
// Nothing local can have one either: no dictionary ships with this app, and a
// stoplist that knew those five strings would know nothing about the next
// book's five. The only thing on this machine that can answer is the model
// that has just been told what the book is, so it is asked — and "told what
// the book is" is a precondition, not a figure of speech: the caller runs this
// only against the book profile's own six lines, never against the frequency
// line bookBrief falls back to, because that line is a summary of the very
// list being judged. profileBrief holds the argument and proposeTerms holds
// the guard.
//
// WHY THIS IS A REMOVAL AND NOT A DECISION NOT TO ADD. Pass 1 always runs and
// always writes (see mineGlossary), and it writes the raw ranked list because
// that is the honest answer to "no aux model installed". So by the time a model
// exists to judge those strings they are already lines in the reader's .txt,
// and declining to re-add them would leave every one of them exactly where it
// is. The verdict therefore travels to saveGlossary's `remove`, the path
// validateTerms' fold opened, under the same rule: only a line some pass wrote
// may go, never one the reader typed. mayFold() answers that, from `source`,
// and a line with no source at all is the reader's by definition — see
// FOLDABLE_SOURCE.
//
// It is asked about the miner's list and NOT about what the model proposed in
// this same pass. A proposal has already been judged, by this model, from the
// page it stood on, under the same brief; asking twice would spend calls to
// let a second sample of the same distribution overturn the first.
//
// IT IS ASKED WITH THE FIRST-OCCURRENCE SENTENCE, not about a bare string, and
// on the reader's own list that is the difference between a veto and a coin
// toss in BOTH directions. `False` and `SELECT` are indefensible as words and
// obvious the moment their sentence shows a code listing around them; `SDBN`
// and `ANN` are indefensible as words too — the model does not know what they
// stand for, the prompt says so and tells it to answer «да» anyway — and their
// sentence is what turns a guess into a reading. The sample is already in hand
// at the call site (proposeTerms reads `m.sample` for rememberSamples two
// statements after asking for the veto), so it costs a prompt and no work, and
// it is rendered by listItems, exactly the way enrichUser renders it.
//
// The prompt this buys is still small against the aux slot. Twelve items of a
// ≤64-character term plus SAMPLE_IN_PROMPT=160 characters of sentence is ~2.7
// KB, the brief is ~700 characters and the instructions ~1.1 KB: some 4.5 KB,
// which at Gemma's ~2.2 characters a token for Russian is ~2050 tokens, plus
// defBudget(12) = 660 for the answer. The aux server is spawned `--parallel 4`
// over `-c 16384`, and `-c` is the TOTAL that llama-server divides by the slot
// count (measured: `--parallel 8 -c 24576` prints `n_ctx_slot = 3072`), so a
// slot holds 4096 cells — `AuxState::CTX_PER_SLOT` in src-tauri/src/lib.rs —
// and a full batch sits at roughly two thirds of one. That is the arithmetic
// SAMPLE_IN_PROMPT was chosen against for enrichment and it holds here with a
// shorter answer; if either number moves, redo it rather than assume it.
//
// A model fault costs nothing: auxAttempts answers null, parseVerdicts is not
// reached, no key enters the set, and the tail lands exactly as it did before
// this function existed. Same for a term the model simply skipped — an absent
// verdict is absent, not a "no", which is the same rule the definition check
// states in parseVerdicts and matters more here, because the thing at stake is
// a whole line rather than a sentence of prose.
//
// WHAT IT DELIBERATELY DOES NOT DO: it does not remember. A «нет» removes the
// line and nothing writes the refusal down, so a reader who runs pass 1 again
// gets `dark of the moon` back — the miner still counts it — until pass 1.7
// runs again and takes it out again. The two durable places a memory could go
// are both closed: the sidecar is an exact-match version gate (glossary.ts:645,
// see the note above loadProfile) and a bumped version would destroy every
// book's bookkeeping on disk, and the .txt may not grow a metadata header
// (glossary.ts:28). A refused term is also not an alias of anything, so pass
// 3's `aliases` channel — which is how a FOLD is remembered — says the wrong
// thing about it. Re-running one pass of a three-pass flow and getting that
// pass's output is a cost the reader can see and understand; a fourth file
// beside the .txt to spare them it is not.

/// The termKeys the model refused, for the terms it was asked about. Empty for
/// every kind of model fault, and never a throw except on abort — which pooled
/// turns into "resolve with the verdicts that landed", so an interrupted veto
/// removes what it managed to judge and keeps the rest.
///
/// `items` carry the miner's first-occurrence sentence where it has one; a term
/// without a sample is still asked about, as a bare label, exactly as it was
/// before. See the note above on why the sentence is the evidence here.
///
/// `brief` must be the PROFILE's brief and never bookBrief's fallback — the
/// caller is required to have checked, and profileBrief says why at length.
async function vetoMinedTail(
  items: readonly PromptItem[],
  brief: string,
  signal: AbortSignal | undefined,
  onChunk: () => void,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!items.length) return out;
  const p = prompts();
  const chunks: PromptItem[][] = [];
  for (let i = 0; i < items.length; i += TAIL_CHUNK) chunks.push(items.slice(i, i + TAIL_CHUNK));

  const judged = await pooled(chunks.length, async (k) => {
    const chunk = chunks[k];
    const asked = chunk.map((it) => it.term);
    const raw = await auxAttempts(
      [
        { role: "system", content: p.tailSystem },
        { role: "user", content: p.tailUser(brief, chunk) },
      ],
      // The reply is defUser's, so the budget is defUser's — see defBudget.
      defBudget(chunk.length),
      signal,
      // The definition check's whole-reply gate (see validateTerms): 120
      // characters a line, the separator required, and NO alphabet requirement
      // — the terms are in the BOOK's language, so a Russian reader vetoing an
      // English book's tail gets a reply that is mostly Latin by design.
      //
      // 120 a line SURVIVES the context lines going into the prompt, and that
      // was checked rather than assumed: the sentences went into the QUESTION,
      // not the answer, and the answer is still «термин :: нет» — a mined term
      // is counted under a key of at most MAX_KEY_CHARS=64 characters
      // (terms.ts) and its label is that key's surface form, so a verdict line
      // is ~72 and 120 is half again as much. Raising it would not help the one
      // reply the samples make likelier, either: a model that answers «1. dark
      // of the moon — Контекст: … :: нет» loses on parts[0] in parseVerdicts
      // whatever length it is allowed, so rejecting it and letting auxAttempts
      // ask a warmer one is strictly better than parsing it into nothing.
      //
      // And that is why the accept test is parseVerdicts and no longer
      // hasVerdict. hasVerdict answers "some line of this reply carries a
      // yes-or-no", which a reply of twelve «строка :: нет» lines satisfies
      // while resolving against nothing — the batch then came back empty with
      // all three attempts spent on a reply that was accepted on the first.
      // The gate now asks the question the caller actually has: did any verdict
      // land on a term we asked about? A no is a retry, and after three of them
      // auxAttempts answers null and the tail survives, which is this pass's
      // fail-open contract unchanged. (validateTerms keeps hasVerdict: its
      // batch is pairs the reader already has definitions for, and re-asking
      // costs a call to clear a sentence, not to delete a line.)
      (r) => !replyRejected(r, chunk.length, 120, true, false) && parseVerdicts(r, asked).size > 0,
    );
    onChunk();
    return raw === null ? new Map<string, boolean>() : parseVerdicts(raw, asked);
  });

  for (const part of judged)
    if (part) for (const [term, keep] of part) if (!keep) out.add(termKey(term));
  return out;
}

export type ProposeOptions = {
  /// The book's language, for the miner this pass may have to build itself.
  lang?: BookLang;
  /// How many terms the file may end up holding after this run. Default
  /// DEFAULT_CAP, as pass 1's.
  cap?: number;
  signal?: AbortSignal;
  /// Counted in STEPS: a page read is one, a chunk answered is one, a veto call
  /// is one. The unit is mixed on purpose — reading is what takes the wall
  /// clock on an 838-page book, and a bar that stood still through forty pages
  /// and then jumped would be a worse lie than a bar whose last dozen steps are
  /// slower than its first eight hundred.
  ///
  /// The veto's share of `total` is RESERVED at its upper bound and the counter
  /// is fast-forwarded when the veto ends, so a run whose tail was short
  /// finishes with one jump. The alternative — announcing the veto's calls once
  /// they are known — grows `total` mid-run, and a bar that walks backwards is
  /// the one thing a progress report may never do. The share is zero on a book
  /// with no profile, where the veto is known in advance not to run at all.
  onProgress?: (done: number, total: number) => void;
  /// The counts, from a mining run that already read this book. Absent, this
  /// pass looks for one this session remembered, and failing that mines the
  /// whole book itself.
  lookup?: TermLookup;
};

/// Pass 1.7. The model names the book's terms; the miner counts them.
///
/// This is the half of the answer to «глоссарий получается мусорный» that the
/// profile alone cannot give. Frequency ranked `dark of the moon` (a sample
/// search query used 56 times as a running example) above half the real
/// terminology of that book, and no prompt can repair a list that was chosen
/// that way — so the model is asked to NAME the terms from the pages
/// themselves, under the brief, and the miner is demoted to what it is good at:
/// counting, and filling the tail.
///
/// Three rules hold the pass honest:
///
///   • A proposal that does not occur in its OWN chunk's page text is dropped.
///     Folded, not literal — see occursIn — because the nominative singular the
///     prompt asks for is usually not the form on the page.
///   • A proposal the miner cannot count is KEPT, with no freq and no pages.
///     terms.ts:105-113: lookup answers 0 for any phrase over MAX_N=4 tokens or
///     straddling a clause boundary, which is precisely the good multiword term
///     the model names and the miner structurally never saw. Rejecting on freq
///     0 would throw away the class of term this pass exists to find.
///   • Nothing is written when the model proposed nothing. The miner's own
///     ranked list is pass 1's to write and it already did; a second writer for
///     it would make «no aux model» look like a successful run. The veto rides
///     on the same rule and therefore does not run either: a pass that could
///     not get one proposal out of the model has no business deleting the
///     reader's lines on that model's say-so.
///   • The miner's ranked tail is VETOED before any of it is kept — the model
///     is shown each candidate with the sentence the miner first met it in and
///     asked whether it is a term of this book or an example in it. See
///     vetoMinedTail for why that has to remove lines rather than merely
///     decline to add them, and `vetoed` below for what the caller gets to say
///     about it. It runs only when the book has a PROFILE, because the veto's
///     brief may not be domainOf's frequency line — that line is built from
///     the very ranking the veto is judging, and it would name `dark of the
///     moon` as a key term of the book in the prompt that asks whether `dark
///     of the moon` is one. profileBrief carries the full argument.
export async function proposeTerms(
  doc: PDFDocumentProxy,
  bookPath: string,
  opts: ProposeOptions = {},
): Promise<{
  added: number;
  proposed: number;
  /// Lines the model REFUSED off the miner's ranked tail, and this is a number
  /// a panel should say out loud rather than fold into `added`: a run that
  /// added eleven terms and threw four of pass 1's out did two different things
  /// to the reader's file, and only one of them is visible by scrolling it.
  ///
  /// 0 also means «the veto did not run», which it does not on a book with no
  /// profile and on a model fault alike. Both are fail-open by design and the
  /// panel is right to report the same thing about them: nothing was removed.
  vetoed: number;
  records: SampledRecord[];
  aborted: boolean;
}> {
  const { signal, onProgress } = opts;
  const cap = opts.cap ?? DEFAULT_CAP;
  const p = prompts();
  const nothing = { added: 0, proposed: 0, vetoed: 0, records: [] as SampledRecord[] };
  try {
    const profile = await loadProfile(bookPath);
    const prev = await loadGlossary(bookPath);
    // No profile is not a failure — it is the ordinary state of a book nobody
    // has read yet, and bookBrief answers it with the frequency line every
    // prompt in this file carried before pass 1.5 existed.
    const brief = bookBrief(profile, prev.records);
    // …but the VETO may not have that fallback, and this is the one place in
    // the file where the difference decides the outcome. bookBrief's fallback
    // is domainOf: the ten heaviest records BY FREQUENCY. The veto's question
    // is «is this frequent string a term of the book or an example in it», and
    // its candidates are the same frequency ranking — so on the reader's own
    // book the fallback would open the prompt with «Тематика книги (ключевые
    // термины): dark of the moon, star wars, …» and then ask, below it,
    // whether «dark of the moon» is a term. The evidence and the defendant
    // would be the same list.
    //
    // So the veto takes profileBrief, which is the six lines or nothing, and
    // when it is nothing the veto DOES NOT RUN. Asking blind was the other
    // option and it is worse than it looks: this prompt's fail-open is «если
    // сомневаешься, отвечай да», which only helps a model that knows enough to
    // doubt, and a model told nothing about the book has no way to keep `SDBN`
    // and `CLIR` — the acronyms it cannot expand — for the right reason. Not
    // running is this pass's own contract for «the model could not answer»:
    // the tail lands exactly as it does today, no worse than before the veto
    // existed, and «Прочитать книгу» once is what turns it on.
    const vetoBrief = profileBrief(profile);

    const total = doc.numPages;
    const pages = spreadPages(total, PROPOSE_PAGES);
    const chunks: number[][] = [];
    for (let i = 0; i < pages.length; i += PROPOSE_CHUNK_PAGES)
      chunks.push(pages.slice(i, i + PROPOSE_CHUNK_PAGES));

    const held = minersByBook.get(bookPath);
    let lookup = opts.lookup ?? held?.lookup;
    // The miner's ranked list is only available when THIS session mined; a
    // caller that handed over a bare `lookup` gives us counts and no ranking.
    // In the panel's flow that list has already been written to the file by
    // pass 1, so there is nothing left for the tail to ADD — but there is now
    // something left for it to take away, and without the ranking this pass
    // cannot: the veto below judges the miner's own list, and an empty one is
    // an empty veto. A caller that wants pass 1's junk re-examined has to hand
    // over the miner that produced it (the panel does; `lookup` alone is the
    // console's shortcut and keeps the console's old behaviour).
    let ranked: MinedTerm[] = held?.terms ?? [];
    let lang = opts.lang ?? (profile && profile.lang !== UND ? profile.lang : undefined);

    const mineSteps = lookup ? 0 : total;
    // The veto's calls are RESERVED rather than counted, because their number is
    // not known until the model has answered about the pages — and a total that
    // grows mid-run is a bar that walks backwards, which is a worse lie than a
    // bar that jumps forward once at the end (see ProposeOptions.onProgress on
    // the mixed unit). The bound is the whole ranked list, which the miner caps
    // at `cap`; `done` is fast-forwarded to `steps` when the veto is through.
    //
    // Zero when there is no profile, because then the veto does not run at all
    // (see `vetoBrief`): reserving calls that are already known not to happen
    // would end every profile-less run with the bar jumping the last tenth,
    // which is the same lie in the other direction.
    const tailSteps = vetoBrief ? Math.ceil(cap / TAIL_CHUNK) : 0;
    const steps = mineSteps + pages.length + chunks.length + tailSteps;
    let done = 0;
    onProgress?.(0, steps);

    if (!lookup) {
      const mined = await runMine(doc, {
        lang,
        cap,
        signal,
        onProgress: (n) => onProgress?.(n, steps),
      });
      lookup = mined.lookup;
      ranked = mined.terms;
      lang = mined.lang;
      rememberMiner(bookPath, { lookup, terms: ranked });
      done = mineSteps;
    }
    const counts = lookup;

    // The excerpts, three pages a call. Furniture is dropped — a running head
    // repeated on forty pages is the one string a model asked for «terms» will
    // reliably name, and it is never one.
    const chunkText: string[] = [];
    const chunkNorm: string[] = [];
    for (const group of chunks) {
      const parts: string[] = [];
      for (const n of group) {
        if (signal?.aborted) abortErr();
        const ps = await pageParagraphs(doc, n);
        const body = ps.filter((q) => q.kind !== "furniture");
        const text = flat(paraText(body)).slice(0, PROPOSE_PAGE_CHARS);
        if (text) parts.push(`[${n}] ${text}`);
        onProgress?.(++done, steps);
      }
      const joined = parts.join("\n");
      chunkText.push(joined);
      chunkNorm.push(outNorm(joined));
      await tick();
    }

    const replies = await pooled(chunks.length, async (k) => {
      if (!chunkText[k]) {
        onProgress?.(++done, steps);
        return [] as string[];
      }
      const raw = await auxAttempts(
        [
          { role: "system", content: p.proposeSystem },
          { role: "user", content: p.proposeUser(brief, chunkText[k]) },
        ],
        PROPOSE_BUDGET,
        signal,
        // The «do not invent» gate is also the accept test: a reply from which
        // not one line survives it is a reply about some other book, and a
        // warmer retry is worth more than parsing it.
        (r) => !replyRejected(r, 20, 70, false, false) && parseProposals(r, chunkNorm[k]).length > 0,
      );
      onProgress?.(++done, steps);
      return raw === null ? [] : parseProposals(raw, chunkNorm[k]);
    });

    // Spellings a validation run folded away must not come back — mineGlossary's
    // guard (see «aliased» there), for exactly its reason: without it pass 3
    // folds a spelling and this pass proposes it again next run.
    const aliased = new Set<string>();
    for (const m of Object.values(prev.meta.terms ?? {}))
      for (const a of m.aliases ?? []) aliased.add(termKey(a));
    const have = new Set(parseGlossaryText(prev.text).map((r) => termKey(r.term)));

    const seen = new Set<string>();
    const proposals: string[] = [];
    for (const part of replies)
      if (part)
        for (const term of part) {
          const k = termKey(term);
          if (!k || seen.has(k) || aliased.has(k)) continue;
          seen.add(k);
          proposals.push(term);
        }
    const kept = proposals.slice(0, PROPOSE_CAP);
    if (!kept.length) return { ...nothing, records: prev.records, aborted: signal?.aborted === true };

    const samples = new Map<string, string>();
    const incoming: TermRecord[] = [];
    for (const term of kept) {
      const k = termKey(term);
      const c = counts(term);
      const rec: TermRecord = { term };
      // freq 0 is «unverified», so the record simply carries neither number.
      // Writing freq: 0 would be a claim the miner never made and would rank the
      // term last in every panel that sorts by frequency.
      if (c.freq > 0) {
        rec.freq = c.freq;
        if (c.pages.length) rec.pages = c.pages;
      }
      // The provenance stamp goes on the lines THIS RUN PUTS IN THE FILE and on
      // no others, exactly as mineGlossary stamps "mined" and for its reason: a
      // line the reader typed by hand must not have its provenance rewritten
      // because the model happened to name the same term.
      //
      // The stamp is "model" and not a new TermSource. "model" is already what
      // enrichTerms writes, FOLDABLE_SOURCE already answers for it, and adding
      // a source would break two exhaustive Record<TermSource, …> tables for a
      // decision — may a fold delete a proposed line? — that has the same answer
      // as the one already there.
      if (!have.has(k)) rec.source = "model";
      incoming.push(rec);
    }

    // --- the miner's tail, and the model's veto over it
    //
    // The tail is the ranked list minus what the model already named. It is
    // built in full BEFORE the cap is applied, and that is the difference
    // between a veto and a decoration: the file already holds pass 1's whole
    // ranked list, so a veto that only looked at the forty terms this run has
    // room to add would leave the other eighty — `dark of the moon` among them
    // if it happens to rank 41st — sitting in the reader's glossary with an
    // invented definition, which is the defect this exists to end. Judging the
    // list costs at most `tailSteps` calls of TAIL_CHUNK terms; keeping is
    // still capped, so nothing about what the file may hold has changed.
    const tail: MinedTerm[] = [];
    for (const m of ranked) {
      const k = termKey(m.term);
      if (!k || seen.has(k) || aliased.has(k)) continue;
      seen.add(k);
      tail.push(m);
    }
    // Only lines a fold would be allowed to delete are ASKED about, and the
    // question is settled by the same mayFold() that governs pass 3's fold:
    // «нет» about a line the reader typed is an answer nothing may act on, so
    // spending a model call to get it would be spending it to do nothing. A
    // term with no line in the file yet is askable — this run is what would put
    // it there. A line with no `source` at all is the reader's by FOLDABLE_
    // SOURCE's rule and is left completely alone, which is also what protects
    // a glossary whose sidecar was lost: no bookkeeping, no removals.
    const owned = new Map(prev.records.map((r) => [termKey(r.term), r]));
    const askable = tail.filter((m) => {
      const own = owned.get(termKey(m.term));
      return own === undefined || mayFold(own);
    });
    // The sentence the miner first met each candidate in travels with it. It
    // is already here — the loop below reads `m.sample` for rememberSamples —
    // and it is what lets the model see that `False` sits in a code listing
    // and that `SDBN` sits in a sentence about click models. Absent for a term
    // the miner found no clean sentence for, which listItems renders as the
    // bare label the veto has always asked about.
    //
    // No `vetoBrief`, no call: see `vetoBrief` above for why asking blind is
    // not the fallback, and vetoMinedTail's own header for what an empty set
    // costs — nothing. The tail below then fills exactly as it did before the
    // veto existed.
    const vetoed = vetoBrief
      ? await vetoMinedTail(
          askable.map((m) => ({ term: m.term, sample: m.sample })),
          vetoBrief,
          signal,
          // Clamped: `ranked` comes from a miner some other call may have built
          // with a larger cap than this run's, and a bar that reads 13/10 is
          // worse than one that pauses at 10/10 for a call or two.
          () => onProgress?.(Math.min(++done, steps), steps),
        )
      : new Set<string>();
    done = steps;
    onProgress?.(done, steps);

    // What survived the veto fills the tail, ranked, up to the run's cap.
    for (const m of tail) {
      if (incoming.length >= cap) break;
      const k = termKey(m.term);
      if (vetoed.has(k)) continue;
      if (m.sample) samples.set(k, m.sample);
      incoming.push(
        have.has(k)
          ? { term: m.term, pages: m.pages, freq: m.freq }
          : { term: m.term, pages: m.pages, freq: m.freq, source: "mined" },
      );
    }
    if (samples.size) rememberSamples(bookPath, samples);

    // `lang` is passed only when it is a real answer. saveGlossary reads an
    // absent one as «keep whatever the sidecar said», and writing UND over a
    // language pass 1 detected would cost the miner its stoplists next run.
    //
    // `remove` carries the veto's «нет»s, and it is the second call site in
    // this project allowed to fill it — see SaveOptions.remove. The keys that
    // name no line in the file cost nothing there: stripLines removes the lines
    // it finds and is silent about the rest.
    const saved = await saveGlossary(bookPath, incoming, {
      lang: lang && lang !== UND ? lang : undefined,
      remove: vetoed,
    });
    return {
      added: saved.added,
      proposed: kept.length,
      vetoed: vetoed.size,
      records: withSamples(bookPath, applyMeta(parseGlossaryText(saved.text), saved.meta)),
      aborted: signal?.aborted === true,
    };
  } catch (e) {
    if (isAbortErr(e) || signal?.aborted) return { ...nothing, aborted: true };
    console.error("term proposal failed", e);
    return { ...nothing, aborted: false };
  }
}

// ---- pass 2: enrichment -----------------------------------------------------

type Enriched = { kind?: TermKind; category?: string; definition?: string };

/// Parse «term :: kind :: category :: definition» against the terms actually
/// asked about. A term the model invented is dropped — it names nothing in the
/// book — and a term it skipped simply keeps its empty fields.
///
/// Short lines are tolerated, because a 4B model drops a field it has nothing
/// to say about. The router is uniform: peel a leading kind word if there is
/// one, then read what is left as [category, definition], and when only one
/// field is left decide by shape.
function parseEnriched(raw: string, asked: readonly PromptItem[], lang: Lang): Map<string, Enriched> {
  const byNorm = askedIndex(asked.map((a) => a.term));
  const sampleOf = new Map<string, string | undefined>(asked.map((a) => [a.term, a.sample]));
  const out = new Map<string, Enriched>();
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = unbullet(line);
    if (!cleaned.includes(SEP)) continue;
    const parts = cleaned.split(/\s*::\s*/);
    if (parts.length < 2) continue;
    const term = byNorm.get(conceptId(parts[0]));
    if (term === undefined || out.has(term)) continue;
    let rest = parts.slice(1);
    const e: Enriched = {};
    const kind = kindOf(rest[0]);
    if (kind) {
      e.kind = kind;
      rest = rest.slice(1);
    }
    if (rest.length >= 2) {
      const category = cleanCategory(rest[0], term, lang);
      if (category) e.category = category;
      const definition = cleanDefinition(rest.slice(1).join(SEP_SPACED), term, lang, sampleOf.get(term));
      if (definition) e.definition = definition;
    } else if (rest.length === 1) {
      if (looksLikeCategory(rest[0])) {
        const category = cleanCategory(rest[0], term, lang);
        if (category) e.category = category;
      } else {
        const definition = cleanDefinition(rest[0], term, lang, sampleOf.get(term));
        if (definition) e.definition = definition;
      }
    }
    out.set(term, e);
  }
  return out;
}

export type EnrichOptions = {
  /// The book whose records these are. Not an IO argument — this pass opens
  /// nothing and writes nothing — but the key into this session's sample store,
  /// which is where the sentence the miner met each term in has been waiting
  /// since pass 1. Required, and see «the sample sentence» for why: the records
  /// this pass is handed have usually been to disk and back, and the .txt and
  /// the sidecar deliberately carry no sample, so a caller that does not name
  /// the book is a caller whose model never sees a line of context.
  bookPath: string;
  /// The book's language, for the translation decision. UND is fine and means
  /// "undecided", which needsTranslation deliberately reads as "translate".
  lang?: BookLang;
  /// The language translations should be IN. Absent, the translation ladder
  /// does not run at all and no `translation` field is touched.
  target?: BookLang;
  /// The book brief, ALREADY RENDERED — bookBrief(await loadProfile(path), recs).
  ///
  /// A string rather than a BookProfile, and rendered by the caller rather than
  /// read here, because this pass opens nothing and is meant to go on opening
  /// nothing (see `bookPath` above). One profile read per panel run serves the
  /// enrichment, the translation ladder and pass 3 alike.
  ///
  /// Absent, the prompts fall back to domainOf over these very records, which
  /// is byte for byte what they said before the profile existed — so a caller
  /// that has not been taught about briefs still gets today's behaviour.
  brief?: string;
  signal?: AbortSignal;
  /// Counted in TERMS covered, across both halves of the pass — a batch of
  /// twelve moves the bar by twelve when its reply lands.
  onProgress?: (done: number, total: number) => void;
};

/// Can the local translator actually produce `target`?
///
/// HY-MT is prompted with the target language named by i18n's targetLanguage(),
/// which follows the INTERFACE language — that is the whole of the wiring today
/// (translate.ts:218). So a target that is not the interface language has no
/// path to a model, and the honest thing is to say so rather than to run the
/// ladder and label whatever comes back as that language. When the reader can
/// pick targets, this is the function that has to grow, together with
/// translate.ts's prompt builder.
const canTranslateInto = (target: BookLang): boolean =>
  target.split("-")[0].toLowerCase() === getLang();

/// Pass 2. Fill kind, category and definition from the aux model, in batches.
///
/// BATCHED — twelve terms a call, graphgen's TYPE_CHUNK and for its reason.
/// The version this replaced made one call per term: 120 calls where 10 do, on
/// a 4B model that loads for twenty seconds and answers in two.
///
/// Only EMPTY fields are filled. A category or a definition the reader typed is
/// never overwritten, whatever the model says about it.
///
/// Translation is a separate, optional field and runs only when a target is
/// given and differs from the book's language — a Russian book being read in
/// Russian needs no term translations at all, which is precisely the case the
/// old pipeline could not express. When it does run, it runs the measured
/// per-term ladder unchanged (see translateTerms).
export async function enrichTerms(
  input: readonly SampledRecord[],
  opts: EnrichOptions,
): Promise<EnrichResult> {
  const { signal, onProgress } = opts;
  const lang = getLang();
  const p = prompts();
  // Records that have been to disk and back carry no sample; this is where the
  // sentence pass 1 found comes back to them. A caller that never mined in this
  // session simply gets its records unchanged, and the prompts lose a line.
  const records = withSamples(opts.bookPath, input);
  const brief = opts.brief ?? bookBrief(null, records);

  const asked = records.filter((r) => !r.kind || !r.category || !r.definition);
  const chunks: SampledRecord[][] = [];
  for (let i = 0; i < asked.length; i += ENRICH_CHUNK) chunks.push(asked.slice(i, i + ENRICH_CHUNK));

  let covered = 0;
  const target = opts.target;
  const willTranslate = !!target && needsTranslation(opts.lang ?? UND, target) && canTranslateInto(target);
  const trTotal = willTranslate ? records.filter((r) => !r.translation).length : 0;
  const total = asked.length + trTotal;
  onProgress?.(0, total);

  const parts = await pooled(chunks.length, async (k) => {
    const chunk = chunks[k];
    const items: PromptItem[] = chunk.map((r) => ({
      term: r.term,
      sample: r.sample,
    }));
    const raw = await auxAttempts(
      [
        { role: "system", content: p.enrichSystem },
        { role: "user", content: p.enrichUser(brief, items) },
      ],
      enrichBudget(chunk.length),
      signal,
      // 320 → 360 characters a line: a definition that has to say what the term
      // is IN THIS book and what role it plays there is longer prose than one
      // that may recite a dictionary, and this ceiling is a runaway gate, not a
      // style rule. Truncating a good batch here reads as a refusal.
      (r) => !replyRejected(r, chunk.length, 360, true, true),
    );
    covered += chunk.length;
    onProgress?.(covered, total);
    return raw === null ? new Map<string, Enriched>() : parseEnriched(raw, items, lang);
  });

  const answers = new Map<string, Enriched>();
  for (const part of parts) if (part) for (const [term, e] of part) answers.set(term, e);

  let enriched = 0;
  let skipped = 0;
  const askedKeys = new Set(asked.map((r) => termKey(r.term)));
  let out: SampledRecord[] = records.map((r) => {
    const e = answers.get(r.term);
    if (!e) {
      if (askedKeys.has(termKey(r.term))) skipped++;
      return r;
    }
    const next: SampledRecord = { ...r };
    let gained = false;
    if (!next.kind && e.kind) ((next.kind = e.kind), (gained = true));
    if (!next.category && e.category) ((next.category = e.category), (gained = true));
    if (!next.definition && e.definition) ((next.definition = e.definition), (gained = true));
    if (gained) (enriched++, (next.source = next.source ?? "model"));
    else skipped++;
    return next;
  });

  let translated = 0;
  if (willTranslate && !signal?.aborted) {
    const need = out.filter((r) => !r.translation);
    const { pairs } = await translateTerms(need, {
      signal,
      brief,
      useAux: await isAuxUp(),
      onProgress: (done) => onProgress?.(covered + done, total),
    });
    const byTerm = new Map(pairs.map((pair) => [termKey(pair.term), pair.tr]));
    out = out.map((r) => {
      if (r.translation) return r;
      const tr = byTerm.get(termKey(r.term));
      if (!tr) return r;
      translated++;
      return { ...r, translation: tr, source: r.source ?? "model" };
    });
  }

  return {
    records: out,
    enriched,
    skipped,
    translated,
    translationRan: willTranslate,
    aborted: signal?.aborted === true,
  };
}

// ---- pass 3: validation -----------------------------------------------------

/// Cluster near-duplicates locally, before any model is asked anything.
///
/// Two spellings join a cluster when the graph's own fold agrees they are one
/// concept (conceptId — «inverted index» and «inverted indexes»), or when their
/// Sørensen–Dice bigram overlap reaches OUT_MATCH. That threshold is calibrated,
/// on 548 outline rows, and textsim.ts says plainly not to retune it here.
///
/// This is a SIMILARITY, not a decision: above the line the model still gets
/// asked. What it buys is that the model is asked about a handful of clusters
/// instead of 7 000 pairs.
async function clusterDuplicates(
  records: readonly SampledRecord[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const n = records.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) ((parent[r] = parent[parent[r]]), (r = parent[r]));
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const byConcept = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const id = conceptId(records[i].term);
    if (!id) continue;
    const first = byConcept.get(id);
    if (first === undefined) byConcept.set(id, i);
    else union(first, i);
  }

  // outDice takes ALREADY-normalised strings and does no normalisation of its
  // own; every call site in this project is outDice(outNorm(a), outNorm(b)).
  const norms = records.map((r) => outNorm(r.term));
  for (let i = 0; i < n; i++) {
    if (i % CLUSTER_TICK === 0) {
      if (signal?.aborted) break;
      await tick(); // a hand-written 2 000-line glossary is 2M comparisons
    }
    for (let j = i + 1; j < n; j++)
      if (find(i) !== find(j) && outDice(norms[i], norms[j]) >= OUT_MATCH) union(i, j);
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/// Parse the one-line duplicate verdict. Returns the canonical spelling the
/// model picked (matched back against the cluster, never taken as free text),
/// or null for "not one concept" and for anything unusable.
function parseDupVerdict(raw: string, forms: readonly string[]): string | null {
  const byNorm = askedIndex(forms);
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = unbullet(line);
    if (!cleaned) continue;
    if (NO_RE.test(cleaned)) return null;
    if (!YES_RE.test(cleaned)) continue;
    const parts = cleaned.split(/\s*::\s*/);
    const pick = parts.length > 1 ? byNorm.get(conceptId(parts.slice(1).join(SEP_SPACED))) : undefined;
    // A «yes» whose spelling was not one of the ones offered is still a «yes»;
    // the caller then keeps its own choice of canonical.
    return pick ?? forms[0];
  }
  return null;
}

/// Parse «term :: да|нет» lines. Absent verdicts are absent, not "no": a
/// definition nobody judged keeps its place.
function parseVerdicts(raw: string, asked: readonly string[]): Map<string, boolean> {
  const byNorm = askedIndex(asked);
  const out = new Map<string, boolean>();
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = unbullet(line);
    if (!cleaned.includes(SEP)) continue;
    const parts = cleaned.split(/\s*::\s*/);
    if (parts.length < 2) continue;
    const term = byNorm.get(conceptId(parts[0]));
    if (term === undefined || out.has(term)) continue;
    const verdict = parts.slice(1).join(" ").trim();
    if (YES_RE.test(verdict)) out.set(term, true);
    else if (NO_RE.test(verdict)) out.set(term, false);
  }
  return out;
}

export type ValidateOptions = {
  /// The book brief, ALREADY RENDERED, exactly as EnrichOptions takes it and
  /// for the same reason: this pass is a pure function over records and stays
  /// one. Absent, both prompts fall back to domainOf over these records, which
  /// is what they have always said.
  ///
  /// It matters more here than it looks: «описывает ли определение именно этот
  /// термин» is a question about THIS book, and a judge that does not know what
  /// the book is will confirm a dictionary definition of a term the book uses
  /// in some other sense — which is how `CLIR :: концептуальный поиск` and
  /// `ANN :: архитектура нейронной сети` survived a validation pass.
  brief?: string;
  signal?: AbortSignal;
  /// Counted in MODEL CALLS — one per duplicate cluster plus one per batch of
  /// definitions. There is no term-shaped number here: most terms are in no
  /// cluster and have no definition to check.
  onProgress?: (done: number, total: number) => void;
};

/// Which provenances a fold may remove a line for.
///
/// This is the rule «a line the READER typed is never deleted», written the way
/// it reads. What it replaced was a caller-supplied set of the termKeys pass 1
/// had added IN THIS PANEL SESSION, and that set is a proxy that is wrong in
/// both directions: it is empty for every glossary mined before the app was
/// last started — so «Проверить термины» on a book reopened tomorrow built the
/// clusters, spent a model call on each of them and folded not one — and it is
/// also empty after a second mining run, which finds every term already present
/// and adds nothing.
///
/// `source` says the same thing durably, it is restored from the sidecar by
/// applyMeta on every load, and it was already being consulted on the very line
/// that asked for the set. mineGlossary stamps "mined" only on the lines it
/// actually puts in the file, glossarygen's own enrichment stamps "model",
/// graphgen's feedback stamps "graph", and the context menu stamps "user" —
/// which glossary.ts's mergeSidecarEntry then refuses to let any later pass
/// overwrite.
///
/// NO SOURCE AT ALL means the reader opened the .txt and typed a line, which is
/// a thing this project invites them to do and the one case with no bookkeeping
/// behind it. It is the reader's, and it stays.
///
/// The map is exhaustive by construction, as glossary.ts's KIND_SET is: adding
/// a TermSource breaks the build until somebody decides whether a fold may
/// delete a line that came from there.
const FOLDABLE_SOURCE: Record<TermSource, boolean> = {
  mined: true,
  model: true,
  graph: true,
  user: false,
};

const mayFold = (r: TermRecord): boolean => (r.source ? FOLDABLE_SOURCE[r.source] : false);

/// Pass 3. The one the reader asked for by name.
///
/// Two halves, and they fail differently:
///
///   • Duplicates. Clustered locally, then one call per cluster: are these one
///     concept, and which spelling is the main one? Folded spellings become
///     `aliases` on the survivor — sidecar bookkeeping, never a line of the
///     .txt — and their pages and counts move to it.
///
///     A line the reader typed is NEVER deleted. Only a line some pass wrote
///     may be folded away (see FOLDABLE_SOURCE), and a cluster containing one
///     of the reader's keeps that line as the survivor whatever the model
///     nominates. A cluster of two of the reader's lines is reported and left
///     completely alone: a reader who wrote both spellings meant both.
///
///     Reported, and the word is load-bearing. Every group this pass returns is
///     one the model CONFIRMED, so a group whose `folded` is empty is not a
///     failed fold, it is a finding: two lines in the file say the same thing
///     and both are the reader's to remove. `kept` counts those, and a caller
///     that prints only `folded` tells the reader nothing happened when in fact
///     the pass did its work and then, correctly, kept its hands off.
///
///     The fold happens in memory here; the folded LINE goes away only when the
///     caller passes `foldedKeys` to saveGlossary as `remove`. Two steps rather
///     than one, because deleting a line is the single thing this project's
///     merge is built never to do, and it should take an explicit argument.
///
///   • Definitions. Batched, one verdict per term. A definition judged wrong is
///     CLEARED and the term survives — losing a sentence of prose is the
///     failure a reader can live with; losing the term is not.
///
///     Clearing takes two steps, exactly as folding does. This pass works on
///     records in memory, and mergeRecords only ever FILLS an empty field —
///     it cannot blank one, because "every existing line survives byte for
///     byte" is the guarantee the whole merge is built around. So a definition
///     already in the .txt goes away only when the caller hands `clearedKeys`
///     to saveGlossary as `clearDefs`. Without that the report would count a
///     clearing the reader never sees, which is the one outcome worse than
///     leaving the sentence alone.
export async function validateTerms(
  records: readonly SampledRecord[],
  opts: ValidateOptions = {},
): Promise<ValidateResult> {
  const { signal, onProgress } = opts;
  const p = prompts();
  const brief = opts.brief ?? bookBrief(null, records);

  const clusters = (await clusterDuplicates(records, signal)).map((g) =>
    // Heaviest spellings first: they are the ones the model has the best chance
    // of recognising, and the cap keeps a runaway cluster from becoming a prompt.
    [...g].sort((a, b) => (records[b].freq ?? 0) - (records[a].freq ?? 0)).slice(0, MAX_CLUSTER),
  );

  const withDef = records.filter((r) => r.definition);
  const defChunks: SampledRecord[][] = [];
  for (let i = 0; i < withDef.length; i += DEF_CHUNK) defChunks.push(withDef.slice(i, i + DEF_CHUNK));

  const total = clusters.length + defChunks.length;
  let done = 0;
  onProgress?.(0, total);
  const step = (): void => onProgress?.(++done, total);

  // --- duplicates
  const verdicts = await pooled(clusters.length, async (k) => {
    const forms = clusters[k].map((i) => records[i].term);
    const raw = await auxAttempts(
      [
        { role: "system", content: p.dupSystem },
        { role: "user", content: p.dupUser(brief, forms) },
      ],
      DUP_BUDGET,
      signal,
      (r) => !replyRejected(r, 1, 200, false, false) && hasVerdict(r),
    );
    step();
    return raw === null ? null : parseDupVerdict(raw, forms);
  });

  const groups: DuplicateGroup[] = [];
  const dropped = new Set<number>();
  const absorbed = new Map<number, SampledRecord>();
  for (let k = 0; k < clusters.length; k++) {
    const canonical = verdicts[k];
    if (!canonical) continue; // "not one concept", or no answer at all
    const idx = clusters[k];
    const keepers = idx.filter((i) => !mayFold(records[i]));
    // The survivor is the model's pick unless an untouchable line is in the
    // cluster, in which case the reader's spelling wins — the fold exists to
    // tidy what the passes produced, not to re-spell what they wrote.
    const picked = idx.find((i) => records[i].term === canonical);
    const survivor = keepers.length ? (keepers.find((i) => i === picked) ?? keepers[0]) : (picked ?? idx[0]);
    const folded = idx.filter((i) => i !== survivor && mayFold(records[i]));
    groups.push({
      canonical: records[survivor].term,
      members: idx.map((i) => records[i].term),
      folded: folded.map((i) => records[i].term),
      // Everything else the model called a duplicate: confirmed, left alone,
      // and the reader's to decide about. The two lists partition the cluster
      // minus its survivor, so a group is never silent about a member.
      kept: idx.filter((i) => i !== survivor && !mayFold(records[i])).map((i) => records[i].term),
    });
    if (!folded.length) continue;
    const base = absorbed.get(survivor) ?? records[survivor];
    const aliases = [...(base.aliases ?? [])];
    const pages = [...(base.pages ?? [])];
    let freq = base.freq ?? 0;
    for (const i of folded) {
      dropped.add(i);
      aliases.push(records[i].term, ...(records[i].aliases ?? []));
      pages.push(...(records[i].pages ?? []));
      // The occurrences of a folded spelling are occurrences of the concept.
      // buildSidecar takes the LARGER of old and new, so this can only ever
      // grow once per fold, not once per re-run.
      freq += records[i].freq ?? 0;
    }
    absorbed.set(survivor, {
      ...base,
      aliases,
      pages: pages.length ? [...new Set(pages)].sort((a, b) => a - b) : base.pages,
      freq: freq || base.freq,
    });
  }

  // --- definitions
  const judged = await pooled(defChunks.length, async (k) => {
    const chunk = defChunks[k];
    const pairs = chunk.map((r) => ({
      term: r.term,
      definition: r.definition ?? "",
    }));
    const raw = await auxAttempts(
      [
        { role: "system", content: p.defSystem },
        { role: "user", content: p.defUser(brief, pairs) },
      ],
      defBudget(chunk.length),
      signal,
      (r) => !replyRejected(r, chunk.length, 120, true, false) && hasVerdict(r),
    );
    step();
    return raw === null ? new Map<string, boolean>() : parseVerdicts(raw, pairs.map((x) => x.term));
  });

  const verdictByTerm = new Map<string, boolean>();
  for (const part of judged) if (part) for (const [term, ok] of part) verdictByTerm.set(term, ok);

  let cleared = 0;
  const clearedKeys = new Set<string>();
  const out: SampledRecord[] = [];
  for (let i = 0; i < records.length; i++) {
    if (dropped.has(i)) continue;
    let r = absorbed.get(i) ?? records[i];
    const verdict = verdictByTerm.get(r.term);
    if (verdict === false && r.definition) {
      const { definition: _gone, ...rest } = r;
      r = rest;
      cleared++;
      clearedKeys.add(termKey(r.term));
    }
    out.push(r);
  }

  return {
    records: out,
    groups,
    folded: dropped.size,
    kept: groups.reduce((n, g) => n + g.kept.length, 0),
    foldedKeys: new Set([...dropped].map((i) => termKey(records[i].term))),
    cleared,
    clearedKeys,
    checked: verdictByTerm.size,
    aborted: signal?.aborted === true,
  };
}

// ---- the translation ladder -------------------------------------------------
//
// Everything below this line is the per-term translation path as it was
// measured against the real model, kept deliberately intact. It is now ONE
// optional field of the record rather than the point of the whole feature, but
// its gates and its retry framing were tuned against actual HY-MT and Qwen
// answers and there is no measurement behind any change to them.

// Tidy a model answer for a 1-4 word segment: first line, unwrap quotes, drop a
// trailing period the source didn't have.
function cleanTr(raw: string, term: string): string {
  let t = raw.trim();
  const nl = t.indexOf("\n");
  if (nl > 0) t = t.slice(0, nl);
  t = t.replace(/\s+/g, " ").trim();
  const m = t.match(/^[«"“'‘]+(.+?)[»"”'’]+$/);
  if (m) t = m[1].trim();
  if (t.endsWith("。")) t = t.slice(0, -1).trim();
  if (t.endsWith(".") && !term.endsWith(".")) t = t.slice(0, -1).trim();
  return t;
}

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

// Sanity gate: a TERM's translation is a term, not a sentence. The word-count
// ratio catches whole-sample translations that a pure char limit lets through
// for long multiword terms ("knowledge graphs = <целое предложение>"); the char
// cap additionally stops space-free runaways (e.g. Chinese output).
const plausible = (tr: string, term: string): boolean =>
  !!tr && words(tr) <= words(term) * 2 + 2 && tr.length <= Math.max(60, term.length * 4);

// Junk gate on top of plausible(): question marks (refusals / "term = ?"
// artifacts), symbol-only output, or an echoed span of the sample sentence (the
// model quoting its context instead of translating the term). An answer EQUAL
// to the term is fine — that is the keep-untranslated convention.
function junky(tr: string, term: string, sample?: string): boolean {
  if (!tr || tr.includes("?")) return true;
  if (!/[A-Za-zА-Яа-яЁё0-9]/.test(tr)) return true;
  if (
    sample &&
    tr.length > term.length + 4 &&
    tr.toLowerCase() !== term.toLowerCase() &&
    sample.toLowerCase().includes(tr.toLowerCase())
  )
    return true;
  return false;
}

const passesGates = (tr: string, term: string, sample?: string): boolean =>
  plausible(tr, term) && !junky(tr, term, sample);

// Acronym/symbol terms (all-caps, digits: BM25, TF-IDF, DCG) are conventionally
// kept as-is in translation — the glossary pins them without any model call.
//
// The test is ASCII on purpose, not by oversight: it is the shape this path was
// measured with, and the only case a Unicode-aware version would add is an
// all-caps Cyrillic acronym in a book being translated INTO Russian, which
// needsTranslation already spares us.
const keepAsIs = (term: string): boolean => /^[A-Z0-9][A-Z0-9.+/&-]*$/.test(term) && /[A-Z]/.test(term);

// The terminologist's own prompt moved into PROMPTS with the other four — see
// trSystem/trUser there. It used to be TR_PROMPTS, a second Record<Lang, …>
// beside the first, and there was never a reason for two: the reason it says
// what it says is the same reason (a term or a sample containing "Ctrl+" must
// not be rewritten on macOS on its way into the model), and the brief it now
// carries is rendered by the same bookBrief every other prompt reads.
//
// WHAT WENT WITH IT, and this reverses a measured decision, so it is worth
// naming: retryPrompt and lastQuoted are gone, and the fallback ladder is one
// attempt rather than two.
//
// retryPrompt was an ENGLISH INSTRUCTION — «In the sentence "…", translate the
// term "…" into Russian. Output only the …» — sent through completeRaw to the
// draft translation server, and lastQuoted then dug the answer out of whatever
// prose came back. That worked against HY-MT1.5, an instruction-tuned model
// that happened to translate. The draft server now runs TranslateGemma-12B,
// which is a pure translation model: handed an English instruction it does the
// only thing it knows how to do and TRANSLATES the instruction, so attempt 1
// would return a Russian rendering of the sentence «In the sentence …, translate
// the term …», which lastQuoted would then hand to the gates as a term. Two
// attempts where the second is guaranteed junk is worse than one.
//
// What is left is the contextual call — translate(term, [], { context: sample })
// — which is what attempt 0 always was and is exactly what a translation model
// is for.

// ---- the compatibility surface ----------------------------------------------
//
// App.tsx:1130 spreads this whole module namespace onto the DEV window handle
// (`window.__pdferDev`), untyped, and agentic E2E scripts drive the glossary
// through it. Renaming any of the five names below would compile perfectly and
// break those scripts in silence, which is the worst possible way for a rename
// to fail. So they stay, with their current signatures, implemented over the
// new code. Nothing inside src imports them any more — the panel calls the
// three passes directly — so the dev handle is now their only caller, which is
// precisely why nothing in this repo would fail if they were renamed.
//
// They are not deprecated and not shims in the sense of "about to go": until
// something outside this repo stops calling them, they are part of the module.

export type ExtractedTerm = { term: string; freq: number; sample: string };
export type TermPair = { term: string; tr: string };

/// The mining half of pass 1 with the pre-2026 shape: no book language in, no
/// pages out, no writing. What it returns is better than it was — the miner
/// under it is script-agnostic now, so a Russian book yields Russian terms
/// instead of the Latin islands inside it — and the shape is identical.
///
/// It THROWS DOMException("AbortError") on abort, as it always has;
/// TranslatePopover's error handling distinguishes an abort from a failure that
/// way, and mineGlossary keeps the same contract for the same reason.
export async function extractTerms(
  doc: PDFDocumentProxy,
  opts: {
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
    cap?: number;
  } = {},
): Promise<ExtractedTerm[]> {
  const { terms } = await runMine(doc, opts);
  return terms.map((m) => ({
    term: m.term,
    freq: m.freq,
    sample: m.sample ?? "",
  }));
}

/// Translate mined terms, one per call, on the measured ladder. Route per term:
///   keep-as-is: acronym/symbol terms never hit a model — "BM25 = BM25" pins the
///     surface form so the translator leaves it alone.
///   terminologist (useAux): one aux chat call per term (system role + the book
///     brief + the terms already decided in this run + the sample sentence).
///     Attempt 1 retries warmer, because 0.2 is near-deterministic. The draft
///     model's contextual call remains the last resort per term.
///   fallback (no aux): the draft model, contextual, once — see the note above
///     for why the second rung of that ladder is gone.
/// Every answer passes the same gates. Failed after everything → DROPPED and
/// counted in `skipped`, never written as a "term = ?" line. On abort it
/// resolves with whatever finished — callers merge the partial result.
///
/// This is per-term on purpose and is the one pass that was NOT batched: a
/// translation is one short answer whose quality depends on its own context
/// sentence, and the ladder's fallbacks are per-term decisions.
///
/// THE PASS NOW HAS A MEMORY, and it costs something worth stating. `decided`
/// grows as terms resolve and the last twelve pairs go into every later prompt,
/// so a book that has already settled on «информационный поиск» does not render
/// the next occurrence as «информационное извлечение». The cost is that the
/// result depends on the order the three workers happened to finish in: the
/// same list translated twice can differ. That is a real loss of
/// reproducibility and it is accepted deliberately — a term list that
/// contradicts itself is a defect the reader sees on every page, and a term
/// list that differs between two runs is one nobody can see at all.
export async function translateTerms(
  terms: readonly { term: string; sample?: string }[],
  opts: {
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
    /// The book brief, ALREADY RENDERED — see EnrichOptions.brief. Absent, the
    /// prompt falls back to the domain line built from the first ten terms of
    /// this very list, which is what this pass built for itself before there
    /// were profiles.
    brief?: string;
    // aux terminologist server confirmed up — use it as the primary path
    useAux?: boolean;
  } = {},
): Promise<{ pairs: TermPair[]; skipped: number }> {
  const { onProgress, signal, useAux } = opts;
  const p = prompts();
  const domain = terms
    .slice(0, 10)
    .map((it) => it.term)
    .join(", ");
  const brief = opts.brief ?? (domain ? p.domainLine(domain) : "");
  const out: (TermPair | null)[] = terms.map(() => null);
  // What this run has already settled on, oldest first, shown to the model so
  // the pass is internally consistent. Bounded at DECIDED_IN_PROMPT in the
  // prompt; the array itself is bounded by the term list.
  const decided: DecidedPair[] = [];
  let next = 0;
  let done = 0;

  const draftLadder = async (term: string, sample?: string): Promise<TermPair | null> => {
    try {
      const raw = await translate(term, [], { context: sample || undefined, signal });
      const tr = cleanTr(raw, term);
      if (passesGates(tr, term, sample)) return { term, tr };
    } catch {
      // A model fault is not a throw here either; the term simply goes
      // untranslated and is counted in `skipped`.
    }
    return null;
  };

  const auxPath = async (term: string, sample?: string): Promise<TermPair | null> => {
    const seenSoFar = decided.slice(-DECIDED_IN_PROMPT);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await auxComplete(
          [
            { role: "system", content: p.trSystem },
            { role: "user", content: p.trUser({ term, sample }, brief, seenSoFar) },
          ],
          signal,
          { temperature: attempt === 0 ? 0.2 : 0.7 },
        );
        const tr = cleanTr(raw, term);
        if (passesGates(tr, term, sample)) return { term, tr };
      } catch {
        if (signal?.aborted) return null;
        break; // aux server unreachable mid-run — no point in attempt 2
      }
    }
    return draftLadder(term, sample); // last resort for this term
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const k = next++;
      if (k >= terms.length) return;
      const { term, sample } = terms[k];
      const pair = keepAsIs(term)
        ? { term, tr: term }
        : useAux
          ? await auxPath(term, sample)
          : await draftLadder(term, sample);
      out[k] = pair;
      // A keep-as-is pin is not a decision the model made and teaching it
      // «BM25 → BM25» wastes a line of every later prompt on nothing.
      if (pair && pair.tr !== pair.term) decided.push(pair);
      done++;
      onProgress?.(done, terms.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, terms.length)) }, worker));
  const pairs = out.filter((pair): pair is TermPair => pair !== null);
  // skipped counts only ATTEMPTED terms that failed every path (abort leaves
  // untouched nulls behind — those were never tried, not "пропущено")
  const attempted = signal?.aborted ? done : terms.length;
  return { pairs, skipped: Math.max(0, attempted - pairs.length) };
}

/// Append translated pairs to a glossary's text, over mergeRecords.
///
/// The byte-for-byte guarantee is now glossary.ts's and is stronger than the
/// one this function used to give: it also fills the EMPTY field of a line that
/// already exists. Which is why the old "drop broken `term = ?` artifacts so the
/// term becomes retryable" behaviour is gone — such a line no longer has to be
/// destroyed to be repaired, it just gets its translation filled in.
///
/// One consequence for a caller reading the number: `added` still counts lines
/// APPENDED, so a run that repairs twenty `term = ?` lines and appends nothing
/// now reports 0 rather than 20. The repairs are real; they are `updated` in
/// MergeResult, which this signature has no room for.
export function mergeGlossary(existing: string, pairs: readonly TermPair[]): { text: string; added: number } {
  const incoming: TermRecord[] = [];
  for (const p of pairs) if (p.tr) incoming.push({ term: p.term, translation: p.tr, source: "model" });
  const { text, added } = mergeRecords(existing, incoming);
  return { text, added };
}
