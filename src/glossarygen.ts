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
// The three passes, in the order they are meant to run:
//
//   1. mineGlossary   model-free. It ALWAYS runs and it always writes. This is
//                     the honest answer to "no aux model installed": the terms,
//                     their pages and their frequencies land on disk now, and
//                     the other fields get filled the day a model exists. The
//                     UI must say that out loud rather than pretend a pass ran.
//   2. enrichTerms    batched against the aux model, ~12 terms a call, asking
//                     for `term :: kind :: category :: definition`. Translation
//                     is a separate, optional field of this pass — see below.
//   3. validateTerms  clusters near-duplicates locally, asks the model per
//                     cluster whether they are one concept and which spelling
//                     is canonical, and checks definitions against their terms.
//                     A definition that fails is CLEARED; the term survives.
//
// Only pass 1 touches the disk. The other two are functions over records, so a
// whole run is:
//
//   const m = await mineGlossary(doc, bookPath, { signal, onProgress });
//   const e = await enrichTerms(m.records, { bookPath, lang: m.lang, target, signal });
//   const v = await validateTerms(e.records, { signal });
//   await saveGlossary(bookPath, v.records, {
//     lang: m.lang, target, remove: v.foldedKeys, clearDefs: v.clearedKeys });
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
import { getLang, targetLanguage, type Lang } from "./i18n";
import { clusterParagraphs, hash, type Paragraph } from "./paragraphs";
import { createMiner, isCitationPage, type MinedTerm } from "./terms";
import { OUT_MATCH, outDice, outNorm } from "./textsim";
import {
  auxComplete,
  completeRaw,
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
const MAX_CLUSTER = 8; // spellings of one concept the model is asked about at once
const CLUSTER_TICK = 64; // rows between event-loop yields in the O(n²) clustering
const AUX_TRIES = 3; // attempts per model call — graphgen.ts:181, same arithmetic
const AUX_RETRY_MS = 2000; // pause before a retry, so a loading server can finish

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
// Characters of the first-occurrence sentence that go into an enrichment batch.
// The miner clamps a sample to 300; twelve of those would be 3.6 KB of prompt
// against an 8192-token slot shared by three workers (the aux server is
// spawned with -c 8192, src-tauri/src/lib.rs:85). 160 characters is roughly 70
// tokens of Russian, so a full batch spends ~850 tokens on context and leaves
// the budget to the answer.
const SAMPLE_IN_PROMPT = 160;

// Token budgets. One enrichment line is the term (≤64 chars), a kind word, a
// category (≤48) and a definition (≤200) plus the separators: about 290
// characters, and Qwen3.5 tokenises Russian at roughly 2.2 characters a token,
// so ~130 tokens. 180 leaves the slack that stops a truncation from looking
// like a refusal; the ceiling is what a whole batch can legitimately need.
const enrichBudget = (n: number): number => Math.min(2600, 220 + n * 180);
// A verdict line is a term and one word.
const defBudget = (n: number): number => Math.min(900, 120 + n * 45);
// One line: «ДА :: <spelling>».
const DUP_BUDGET = 120;

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

const PROMPTS: Record<
  Lang,
  {
    enrichSystem: string;
    enrichUser: (domain: string, items: readonly PromptItem[]) => string;
    dupSystem: string;
    dupUser: (domain: string, forms: readonly string[]) => string;
    defSystem: string;
    defUser: (domain: string, pairs: readonly { term: string; definition: string }[]) => string;
    /// Distinctive fragments of the instructions above. A reply containing one
    /// of them is the model reciting the task back instead of doing it.
    echo: readonly string[];
  }
> = {
  ru: {
    enrichSystem:
      "Ты терминолог. Тебе дают термины из одной книги; ты определяешь, что каждый из них " +
      "обозначает, и описываешь его одной строкой. Отвечай только строками заданной формы, " +
      "без нумерации, без заголовков и без пояснений.",
    enrichUser: (domain, items) =>
      (domain ? `Тематика книги (ключевые термины): ${domain}\n\n` : "") +
      "Для каждого термина из списка выведи одну строку вида\n" +
      `термин ${SEP} тип ${SEP} категория ${SEP} определение\n` +
      "Тип — ровно одно слово из списка: person, org, place, work, topic, term.\n" +
      NAMES_RULE.ru +
      "Категория — родовое понятие в одно-два слова: «метрика», «структура данных», «алгоритм».\n" +
      "Определение — одно предложение до 15 слов, по-русски.\n" +
      "Термин переписывай без изменений. Строк должно быть ровно столько, сколько терминов. " +
      "Ничего, кроме этих строк, не пиши.\n\n" +
      `Термины:\n${listItems(items, "Контекст")}`,
    dupSystem:
      "Ты терминолог. Тебе дают несколько написаний, найденных в одной книге. Ты решаешь, " +
      "обозначают ли они одно и то же понятие. Отвечай ровно одной строкой заданной формы.",
    dupUser: (domain, forms) =>
      (domain ? `Тематика книги (ключевые термины): ${domain}\n\n` : "") +
      "Написания, найденные в одной книге:\n" +
      forms.map((f, i) => `${i + 1}) ${f}`).join("\n") +
      "\n\nОбозначают ли они одно и то же понятие?\n" +
      `Если да, ответь одной строкой:\nДА ${SEP} написание из списка, которое следует считать основным\n` +
      "Если нет, ответь одной строкой:\nНЕТ\n" +
      "Ничего, кроме этой строки, не пиши.",
    defSystem:
      "Ты редактор словаря терминов. Тебе дают термины и их определения; ты решаешь, верно ли " +
      "определение описывает свой термин. Отвечай только строками заданной формы.",
    defUser: (domain, pairs) =>
      (domain ? `Тематика книги (ключевые термины): ${domain}\n\n` : "") +
      "Для каждой пары ниже реши, описывает ли определение именно этот термин.\n" +
      `Ответь по одной строке на пару, в том же порядке:\nтермин ${SEP} да\nили\nтермин ${SEP} нет\n` +
      "Термин переписывай без изменений. Ничего, кроме этих строк, не пиши.\n\n" +
      "Пары:\n" +
      pairs.map((p, i) => `${i + 1}) ${p.term} ${SEP} ${p.definition}`).join("\n"),
    echo: [
      "Термин переписывай без изменений",
      "Ничего, кроме эт",
      "ровно одно слово из списка",
      "Обозначают ли они одно и то же понятие",
      "описывает ли определение именно этот термин",
    ],
  },
  en: {
    enrichSystem:
      "You are a terminologist. You are given terms from one book; you decide what each of them " +
      "denotes and describe it in one line. Answer with the given line format only — no " +
      "numbering, no headings, no explanations.",
    enrichUser: (domain, items) =>
      (domain ? `Subject area of the book (key terms): ${domain}\n\n` : "") +
      "For each term in the list, output one line of the form\n" +
      `term ${SEP} type ${SEP} category ${SEP} definition\n` +
      "The type is exactly one word from this list: person, org, place, work, topic, term.\n" +
      NAMES_RULE.en +
      "The category is a one- or two-word genus: «metric», «data structure», " +
      "«algorithm».\n" +
      "The definition is one sentence of up to 15 words, in English.\n" +
      "Rewrite the term unchanged. There must be exactly as many lines as there are terms. " +
      "Write nothing but those lines.\n\n" +
      `Terms:\n${listItems(items, "Context")}`,
    dupSystem:
      "You are a terminologist. You are given several spellings found in one book. You decide " +
      "whether they denote one and the same concept. Answer with exactly one line of the given form.",
    dupUser: (domain, forms) =>
      (domain ? `Subject area of the book (key terms): ${domain}\n\n` : "") +
      "Spellings found in one book:\n" +
      forms.map((f, i) => `${i + 1}) ${f}`).join("\n") +
      "\n\nDo they denote one and the same concept?\n" +
      `If they do, answer with one line:\nYES ${SEP} the spelling from the list to treat as the main one\n` +
      "If they do not, answer with one line:\nNO\n" +
      "Write nothing but that line.",
    defSystem:
      "You are the editor of a term glossary. You are given terms and their definitions; you " +
      "decide whether each definition describes its own term. Answer with the given line format only.",
    defUser: (domain, pairs) =>
      (domain ? `Subject area of the book (key terms): ${domain}\n\n` : "") +
      "For each pair below, decide whether the definition describes that very term.\n" +
      `Answer with one line per pair, in the same order:\nterm ${SEP} yes\nor\nterm ${SEP} no\n` +
      "Rewrite the term unchanged. Write nothing but those lines.\n\n" +
      "Pairs:\n" +
      pairs.map((p, i) => `${i + 1}) ${p.term} ${SEP} ${p.definition}`).join("\n"),
    echo: [
      "Rewrite the term unchanged",
      "Write nothing but",
      "exactly one word from this list",
      "Do they denote one and the same concept",
      "whether the definition describes that very term",
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

/// The only domain signal the aux model needs: the book's own heaviest terms.
/// No embedded dictionaries anywhere, so this works for any book — it is the
/// mechanism the first terminologist prompt used and the one thing it got right.
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
  /// every existing line survives byte for byte, so a fold that has to remove
  /// one has to say so out loud, at the call site, in a set the reader's
  /// features can be audited against. Pass exactly what validateTerms folded
  /// (`foldedKeys`) and nothing else — it already refused to fold anything the
  /// reader typed.
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

type RawMine = { terms: MinedTerm[]; lang: BookLang; confidence: number };

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
  return { terms: miner.finish(), lang, confidence };
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
  const { terms, lang, confidence } = await runMine(doc, opts);

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
  if (sample && sample.toLowerCase().includes(g.toLowerCase())) return "";
  return g;
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
  const domain = domainOf(records);

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
        { role: "user", content: p.enrichUser(domain, items) },
      ],
      enrichBudget(chunk.length),
      signal,
      (r) => !replyRejected(r, chunk.length, 320, true, true),
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
  const domain = domainOf(records);

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
        { role: "user", content: p.dupUser(domain, forms) },
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
        { role: "user", content: p.defUser(domain, pairs) },
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

// Retry framing for terms the contextual template fails to isolate: when the
// segment is a short word contained in its own context (recall, IR, QAC…) the
// model translates the whole sample instead of the term. An explicit English
// instruction makes it NAME the term's translation; the model usually answers
// with a restated sentence, so the actual translation is its LAST quoted span.
//
// The target language used to be the literal word "Russian" here while the rest
// of the pipeline asked for the interface language — a live defect for an
// English reader, and the one change this file makes to a measured path. For a
// Russian interface targetLanguage().en IS "Russian", so the measured wording is
// unchanged; for an English one it stops asking a Russian question.
const retryPrompt = (term: string, sample: string): string =>
  `In the sentence "${sample}", translate the term "${term}" into ${targetLanguage().en}. ` +
  `Output only the ${targetLanguage().en} translation of "${term}", nothing else.`;

function lastQuoted(raw: string): string {
  let last = "";
  for (const m of raw.matchAll(/[«"“]([^«»"“”]+)[»"”]/g)) last = m[1];
  return last.trim() || raw; // no quotes → the model obeyed → answer as-is
}

/// The aux terminologist's own prompt, which used to live in i18n as
/// term.system/term.domain/term.context/term.term. It says what it always said,
/// in both languages; what changed is that a term or a sample containing
/// "Ctrl+" is no longer rewritten on macOS on its way into the model.
const TR_PROMPTS: Record<Lang, { system: string; user: (t: PromptItem, domain: string) => string }> = {
  ru: {
    system:
      "Ты — терминолог. Тебе дают термин из книги, тематику книги и предложение-контекст. " +
      "Ответь ТОЛЬКО устоявшимся русским эквивалентом этого термина — без пояснений, без кавычек, " +
      "без точки в конце. Если термин по общепринятой конвенции не переводится (аббревиатура, " +
      "имя собственное, название продукта или компании) — верни его без изменений.",
    user: (it, domain) =>
      (domain ? `Тематика книги (ключевые термины): ${domain}\n` : "") +
      (it.sample ? `Контекст: ${it.sample}\n` : "") +
      `Термин: ${it.term}`,
  },
  en: {
    system:
      "You are a terminologist. You are given a term from a book, the book's subject area, and a " +
      "sentence of context. Answer with ONLY the established English equivalent of that term — no " +
      "explanation, no quotes, no full stop. If convention leaves the term untranslated (an " +
      "acronym, a proper name, a product or company name), return it unchanged.",
    user: (it, domain) =>
      (domain ? `Subject area of the book (key terms): ${domain}\n` : "") +
      (it.sample ? `Context: ${it.sample}\n` : "") +
      `Term: ${it.term}`,
  },
};

const auxMessages = (term: string, sample: string | undefined, domain: string): ChatMessage[] => {
  const p = TR_PROMPTS[getLang()];
  return [
    { role: "system", content: p.system },
    { role: "user", content: p.user({ term, sample }, domain) },
  ];
};

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
///   terminologist (useAux): one aux chat call per term (system role + domain
///     line from the top mined terms + sample sentence). Attempt 1 retries
///     warmer, because 0.2 is near-deterministic. The HY-MT ladder remains the
///     last resort per term.
///   fallback (no aux): the HY-MT ladder — attempt 0 the model-card contextual
///     template, attempt 1 the instruction framing via retryPrompt.
/// Every answer passes the same gates. Failed after everything → DROPPED and
/// counted in `skipped`, never written as a "term = ?" line. On abort it
/// resolves with whatever finished — callers merge the partial result.
///
/// This is per-term on purpose and is the one pass that was NOT batched: a
/// translation is one short answer whose quality depends on its own context
/// sentence, and the ladder's fallbacks are per-term decisions.
export async function translateTerms(
  terms: readonly { term: string; sample?: string }[],
  opts: {
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
    // aux terminologist server confirmed up — use it as the primary path
    useAux?: boolean;
  } = {},
): Promise<{ pairs: TermPair[]; skipped: number }> {
  const { onProgress, signal, useAux } = opts;
  const domain = terms
    .slice(0, 10)
    .map((it) => it.term)
    .join(", ");
  const out: (TermPair | null)[] = terms.map(() => null);
  let next = 0;
  let done = 0;

  const hymtLadder = async (term: string, sample?: string): Promise<TermPair | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw =
          attempt === 1 && sample
            ? lastQuoted(await completeRaw(retryPrompt(term, sample), signal))
            : await translate(term, [], {
                context: sample || undefined,
                signal,
              });
        const tr = cleanTr(raw, term);
        if (passesGates(tr, term, sample)) return { term, tr };
      } catch {
        if (signal?.aborted) return null;
      }
    }
    return null;
  };

  const auxPath = async (term: string, sample?: string): Promise<TermPair | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await auxComplete(auxMessages(term, sample, domain), signal, {
          temperature: attempt === 0 ? 0.2 : 0.7,
        });
        const tr = cleanTr(raw, term);
        if (passesGates(tr, term, sample)) return { term, tr };
      } catch {
        if (signal?.aborted) return null;
        break; // aux server unreachable mid-run — no point in attempt 2
      }
    }
    return hymtLadder(term, sample); // last resort for this term
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const k = next++;
      if (k >= terms.length) return;
      const { term, sample } = terms[k];
      out[k] = keepAsIs(term)
        ? { term, tr: term }
        : useAux
          ? await auxPath(term, sample)
          : await hymtLadder(term, sample);
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
