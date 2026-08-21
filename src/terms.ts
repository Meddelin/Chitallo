// The term miner. One implementation, two callers.
//
// This module exists because there were two of it. glossarygen.ts mined a book
// for the translation glossary and graphgen.ts mined it for the knowledge
// graph, and the second was written by copying the first — graphgen's own
// header says so («modelled line for line on it»), and its stoplist comment
// goes further and calls glossarygen's English-only lists «wrong here». Two
// hand-copied twins of a C-value extractor drift, and these two had already
// drifted in the way that matters most: glossarygen's tokenizer is
// `[A-Za-z][A-Za-z0-9]*`, so a Russian book does not yield an empty glossary,
// it yields one made of the Latin islands in it — BERT, HTTP, author surnames —
// which looks exactly like a successful run. graphgen's twin is `\p{L}` and its
// capital test already knows about Cyrillic. graphgen's is the good one, so
// graphgen's is the one that survived; what follows is its miner with options
// instead of a fork.
//
// What the two callers ask of it is genuinely different, and that difference is
// the whole of the API:
//
//   • The graph needs the 1-based PAGE NUMBERS a concept was met on — a concept
//     node carries them, and the reader clicks one to get there. It reads the
//     book in one streaming pass and drops each page as it goes (an 838-page
//     book's paragraphs held at once is megabytes kept alive for nothing), so
//     it cannot hand this module an array of pages; it feeds them in one by one
//     between its own progress ticks. It also needs to look a glossary term up
//     in the counts afterwards, because the miner has already counted every
//     n-gram in the book and a term the glossary knows is almost always sitting
//     there under its own key, with its true frequency and pages.
//
//   • The glossary needs a FIRST-OCCURRENCE SENTENCE per term, because the
//     translation model is prompted with the term as the segment and that
//     sentence as its context. It does not care about page numbers on the way
//     in and it reads the whole book, so its floor is an absolute count.
//
// Both are served by one linear pass. The sample sentences cost far less than
// glossarygen's two-pass shortlist machinery suggested: every candidate found
// in one sentence stores a REFERENCE to the same string, so what is retained is
// bounded by the pages read (each retained slice pins at most that page's text,
// a few kilobytes), not by the 80 000-odd distinct n-grams a whole book
// produces. That is why the shortlist pass (glossarygen's PASS2_MULTI) is gone
// rather than parameterised.
//
// Two rules of this house apply to everything below. Nothing here throws and
// nothing here aborts: this module does no IO and no model call, so it takes no
// signal — the caller owns the read loop, checks its own signal between pages
// and simply stops feeding. And every constant that was set by a measurement
// carries the measurement, because the graph's yields are published in
// CHANGELOG.md and a constant nudged «to be safe» would move a number the
// project has told the reader about.

import type { BookLang } from "./booklang";

// ---- what the miner returns -------------------------------------------------

/// One mined term. `pages` and `sample` are present only when the caller asked
/// for them (see MineOptions), so that a caller who does not want them does not
/// pay for them and does not have to think about them.
export type MinedTerm = {
  /// The display label: the dominant surface form (see dominantForm) — «BM25»
  /// rather than «bm25», «Boolean» rather than «boolean».
  term: string;
  /// The counting key this came out of: the lowercased token join. Two labels
  /// that fold onto one key are one term; the graph needs this to tell a
  /// concept counted twice from two concepts that fold onto one node id.
  key: string;
  /// Occurrences in everything that was mined, before nested discounting.
  freq: number;
  /// 1-based, ascending, deduped, capped at MAX_PAGES_PER_TERM.
  pages?: number[];
  /// The sentence the term was first met in, whitespace-flattened and clamped
  /// to a window around it (see clampSample).
  sample?: string;
};

export type MineOptions = {
  /// The book's language, which selects the curated stoplists and decides
  /// whether one is derived from the book itself. "und" is a legitimate value
  /// and is handled — see stopLists.
  lang: BookLang;
  /// How many terms to return, ranked best first.
  cap: number;
  /// How many times a candidate must occur to be a candidate at all. A caller
  /// that mines a SAMPLE of a book rather than all of it must scale this —
  /// sampleFloor does that arithmetic.
  minFreq: number;
  /// On how many distinct pages a candidate must have been met. See rank for
  /// why this is not optional in practice.
  minPages: number;
  /// Emit `pages`. The counts are kept either way (minPages needs them); this
  /// only decides whether they reach the caller.
  withPages?: boolean;
  /// Emit `sample`. This one does cost: sentences are retained while mining.
  withSample?: boolean;
  /// Force the auto-derived stoplist on or off. Left undefined it is derived
  /// exactly when we ship no curated list for `lang`, which is the honest
  /// default — see deriveAutoStop for why it does not stack on top of a
  /// curated list by default.
  autoStop?: boolean;
};

/// A miner fed one page at a time. Created by createMiner; `mineTerms` is the
/// same thing for a caller that already has every page's text in hand.
export type TermMiner = {
  /// Count one page. `page` is 1-based and pages must arrive in ascending
  /// order — one comparison is then the whole of the page dedup. Text is the
  /// page's paragraphs joined by newlines.
  addPage(page: number, text: string): void;
  /// How many pages have been counted. The denominator of the auto-derived
  /// stoplist's page-spread rule.
  readonly pagesMined: number;
  /// What the miner counted for an arbitrary phrase — the same tokens the
  /// miner would have keyed it under. A phrase it never met (longer than
  /// MAX_N tokens, or straddling a clause boundary) answers with freq 0 and no
  /// pages, and the key is still returned so the caller can name the thing
  /// consistently with everything else.
  lookup(term: string): { key: string; freq: number; pages: number[] };
  /// Rank what was counted and return the top `cap`. Pure over the counts, so
  /// calling it twice answers twice with the same list.
  finish(): MinedTerm[];
};

// ---- budgets ----------------------------------------------------------------

/// Longest n-gram considered. Four is glossarygen's and graphgen's alike;
/// longer runs are clauses, not terms.
export const MAX_N = 4;
/// The graph schema's own cap on pages per node (graphstore re-applies it).
export const MAX_PAGES_PER_TERM = 8;
const MAX_KEY_CHARS = 64; // a longer key is a sentence fragment, not a term
const MIN_CAP_FREQ = 4; // capitalised-in-running-text unigrams, see rank
const SAMPLE_WINDOW = 300; // characters of context the translation model gets
const CITE_PAGE_MIN = 8; // ≥8 citation markers on one page ⇒ references/index

/// Reference lists and back-of-book indexes are dense with years, DOIs and
/// URLs, and mining them floods a term list with venue names and author
/// surnames. Exported because booktranslate.ts reuses the same net for its
/// refPage flag, and glossarygen.ts re-exports it for the importers that have
/// always taken it from there.
///
/// It carries /g and is shared, which is safe for `String.match` (that resets
/// lastIndex and returns every match) and would NOT be safe for `.test` on
/// this same object. Every caller counts matches.
export const CITE_MARK = /\b(?:19|20)\d\d[a-z]?\b|\bdoi\b|https?:|\barxiv\b|\bwww\b/gi;

/// Does this page read as a bibliography or an index — i.e. should it be
/// skipped whole rather than filtered term by term? Takes anything with a
/// `text` field so that a caller can pass paragraphs.ts's Paragraph without
/// this module having to know that type.
export const isCitationPage = (paras: readonly { text: string }[]): boolean =>
  paras.reduce((acc, p) => acc + (p.text.match(CITE_MARK)?.length ?? 0), 0) >= CITE_PAGE_MIN;

/// How many times a candidate must occur when only PART of a book was read.
///
/// The whole-book floor is 5 occurrences. A caller that reads `sampled` pages
/// out of `total` is entitled to the same rate, 5·sampled/total, because a
/// count is not comparable across sample sizes: the graph shipped an absolute
/// floor of 3 over a 24-page sample once, which is why every surviving weight
/// in the reader's first graph sat between 3 and 6 — on 2.9% of a book almost
/// nothing occurs three times, whatever it is.
///
/// Clamped below at 2 because a floor of 1 is incoherent next to a page-spread
/// rule that already demands two distinct pages, and above at 5 because
/// reading MORE of a book must never make the miner stricter than a whole-book
/// read would be.
export const sampleFloor = (sampled: number, total: number): number =>
  Math.min(5, Math.max(2, Math.round((5 * Math.min(sampled, total)) / Math.max(1, total))));

// ---- stoplists --------------------------------------------------------------
//
// Three lists per language, and they do three different jobs:
//
//   func      — a multiword candidate may never START or END on one of these,
//               and none of them is ever a unigram term. Interior stopwords are
//               fine: «bag of words» is a term, «of» is not.
//   common    — consulted ONLY by the capitalised-unigram rule, to stop an
//               ordinary word that happens to open a clause («This», «Однако»,
//               «Figure») from being read as a proper noun. Multiword
//               candidates and acronyms never touch it, so domain terms are
//               unaffected.
//   capCommon — nouns that running text writes with a capital anyway
//               («University», «Internet»). Kept apart from `common` because
//               `common` also gates what may be a term at all, and a term
//               shelved as a term is exactly what we want «Internet» to be.
//               Only the proper-noun guard in graphgen consults this one.
//
// The English lists are graphgen's, unchanged, to the word. That is not
// laziness: the graph's yields on an 838-page book are published (CHANGELOG,
// and the pages/floor/mined table in graphgen.ts), and every one of those
// numbers was measured with exactly these words. glossarygen's English lists
// were larger — some sixty more function words, and a 1 500-word common-English
// list — and none of that is carried over, because adding a stopword changes
// which terms are accepted and would quietly falsify a published table. The
// English glossary is therefore very slightly more permissive than it was; the
// model passes that now stand behind it are what pays for that.
//
// Russian is the union: the Russian blocks below PLUS the whole English one.
// This is what graphgen has always done — it applied one merged en+ru set to
// every book — and it is right rather than merely compatible: a Russian
// technical book is full of English islands (quoted terminology, URLs, «state
// of the art»), and an English function word is never a Russian term. The
// reverse case, Cyrillic quoted inside an English book, is rare enough that the
// English list stays English.

const EN_FUNC = `a an the and or but nor so yet not no of in on at by for with about against between into
  through during before after above below to from up down out off over under again further then once here
  there when where why how all any both each few many much more most other some such only own same as than
  too very just ever never also always often can could may might must shall should will would do does did
  done doing is are am was were be been being have has had having i you he she it we they me him her us them
  my your his its our their this that these those who whom whose which what if because until while unless
  since although though however therefore thus hence moreover nevertheless otherwise instead indeed rather
  quite almost already still yes etc via per among along across behind beyond despite except toward towards
  upon onto within without whatever anything something nothing everything anyone someone everyone one two
  three four five six seven eight nine ten first second third last next new old let et al vs versus based
  using given following shown seen called known named use used uses see say said like need make made take
  taken show section chapter figure table page pages example equation exercise note doi org www http https
  com html pp vol eds arxiv fig`;

const RU_FUNC = `и а но или же ли бы не ни да как что чтобы если когда пока хотя потому поэтому итак также
  тоже уже ещё еще очень более менее самый самая самое такой такая такое этот эта это эти тот та те то
  который которая которое которые все весь вся всё каждый любой другой другая другие один одна одно два три
  в во на за под над при без для до от из у к ко с со по о об про через между среди около после перед про
  есть был была было были быть будет будут может можно нужно надо его её ее их им ими них нас вам вас мы вы
  они она оно он я ты мне тебе себя свой своя свои наш ваш там тут здесь тогда затем потом только даже лишь
  именно скорее почти впрочем однако например см рис табл гл стр таблица рисунок глава раздел страница
  пример уравнение`;

// The Russian document furniture and grammar that graphstore.ts:875 already
// spells out for the in-book assistant's question stoplist — the same
// vocabulary problem, solved once in this repo and never reused. Neither miner
// had «книга», «странице», «будто», «ведь», «разве» or «чуть». The five
// imperatives that list also carries («объясни», «расскажи», …) are question
// furniture rather than book furniture and are deliberately left there.
const RU_FUNC_STORE = `больше будто ведь весь во вот все всего всех вы где даже ей ему если есть же за здесь
  и из или им их к как какой когда кто ли либо мне много может мои мой мы на надо наш не него нее нет ни них
  но ну о об однако он она они оно от очень по под после при про раз разве с сам свое свою себе себя сейчас
  со так такой там те тем то тогда того тоже только том тот ты у уже чего чем через что чтобы чуть эта эти
  это этой этом этот я значит такое книга книги книге книгу книг страницы странице страниц`;

// Inflected forms of the closed-class words above that BOTH source lists
// happen to lack, which matters far more in Russian than the count of entries
// suggests: a stoplist that has «весь» and «все» but not «всей» does not stop
// «перевод всей книги» from ending on a pronoun. Measured on this repo's own
// README.ru.md — that exact phrase is what turned up. Closed-class only:
// nothing here can be the edge of a term in any book.
const RU_FUNC_FORMS = `всей всем всеми всю этого этому этих этим этими эту той тем теми тех ним ними нему
  неё нею ею которого которому которым которых которую которой одного одному одном одной одних каждого
  каждому каждом каждой любого любому другого другому другом другую другими своей своим своём своих`;

const EN_COMMON = `about after also although always american another answer any approach area around author
  available average because before between both case chapter chart common company complete computer concept
  condition control course current data date design detail different difficult early either english error
  example experiment figure final first following form further general given great group human idea important
  information instead introduction issue known large later level little local main major many method model
  modern more most much next note number often only order other over paper part particular people perhaps
  person point possible present previous problem process program purpose question rather reason recent
  research result right same second section several significant similar simple since small some something
  special specific standard state study such system table term test text than that their then there these
  thing this those three through time today total under until upon usually value various very well what when
  where which while whole with within without word work world would year`;

const RU_COMMON = `автор более большой быть важный ввод вместе внимание вопрос вот время всего второй выше
  глава год данные дело другой если ещё зачем здесь значит идея именно иначе итог каждый какой книга когда
  конец который кроме лишь лучше между менее много может можно например наиболее начало наш никогда новый
  однако около описание опыт основной особенно ответ пример пункт после почему поэтому правило пример
  проблема просто работа раздел разный результат решение рисунок ряд самый свой сейчас сила слово случай
  смысл собой более способ сразу среди статья степень стороны таблица также такой текст тема теперь только
  точка требует уже условие часть человек через число чтобы шаг`;

const EN_CAP_COMMON = `internet web university college institute department faculty laboratory press journal
  conference workshop proceedings appendix abstract references index glossary preface`;

const RU_CAP_COMMON = `интернет университет институт факультет кафедра лаборатория издательство журнал
  конференция приложение введение заключение оглавление указатель`;

const words = (block: string): string[] => block.split(/\s+/).filter(Boolean);
const setOf = (...blocks: string[]): ReadonlySet<string> => new Set(blocks.flatMap(words));

/// The three lists a language is mined with.
export type StopLists = {
  func: ReadonlySet<string>;
  common: ReadonlySet<string>;
  capCommon: ReadonlySet<string>;
};

const CURATED: Record<string, StopLists | undefined> = {
  en: { func: setOf(EN_FUNC), common: setOf(EN_COMMON), capCommon: setOf(EN_CAP_COMMON) },
  ru: {
    func: setOf(RU_FUNC, RU_FUNC_STORE, RU_FUNC_FORMS, EN_FUNC),
    common: setOf(RU_COMMON, EN_COMMON),
    capCommon: setOf(RU_CAP_COMMON, EN_CAP_COMMON),
  },
};

// Every curated word there is, which is what an unrecognised language gets.
// The bet is deliberate and it is the safe direction: a word on this list is a
// function word or a piece of document furniture in SOME language and is worth
// nothing as the edge of a term in any of them, while the terms it costs a
// language we have never seen are the handful that happen to be spelled like
// one — Italian «e», French «or». The auto-derived list below is what actually
// handles that language's own grammar.
const ALL: StopLists = {
  func: setOf(EN_FUNC, RU_FUNC, RU_FUNC_STORE, RU_FUNC_FORMS),
  common: setOf(EN_COMMON, RU_COMMON),
  capCommon: setOf(EN_CAP_COMMON, RU_CAP_COMMON),
};

/// Do we ship a curated stoplist for this language?
export const hasCuratedStop = (lang: BookLang): boolean => CURATED[lang] !== undefined;

/// The stoplists a book in this language is mined with. An unrecognised
/// language — including "und", which is what detection answers when it could
/// not decide — gets every curated word we have.
export const stopLists = (lang: BookLang): StopLists => CURATED[lang] ?? ALL;

// ---- the auto-derived stoplist ----------------------------------------------
//
// This is the part that makes the miner work for a language we ship no list
// for. Without it a German book's concept list is «der Anzahl», «in der Regel»
// and «und die», because nothing here knows that «der» is a function word.
//
// The signal is distribution, not vocabulary: a function word is short and it
// is on nearly every page, and no content word behaves like that. So a token
// that is short and was met on more than AUTO_PAGE_RATIO of the pages actually
// mined IS a function word of this book's language, and joins the curated set
// for the boundary rule. Three guards keep a content word out of it:
//
//   • Length. Function words are short in every language this could see: der,
//     die, und, nicht, une, dans, para, jest, przez. The limit costs us Russian
//     «который» and English «however» — which is exactly why curated lists
//     still exist for the languages we do ship.
//
//   • Case. A token the book writes with a capital IN THE MIDDLE of a sentence
//     is a name or (in German, where every noun is capitalised) a noun. Function
//     words are lower case. This one guard is what makes German safe.
//
//   • Collocation, and this is the one the rule would be dangerous without. A
//     token is left alone when it begins or ends a repeated multiword candidate
//     that accounts for at least AUTO_BOUND_RATIO of its own occurrences AND
//     whose other tokens are not themselves provisional stops. That is the
//     difference between a content word that lives inside terms — «query» in
//     «query expansion», where the collocation is a real term — and a function
//     word, whose commonest neighbour is another function word («de la») and
//     accounts for a fraction of a per cent of it. Removing a token that only
//     ever appears inside multiword candidates would destroy those candidates
//     while the token itself was never a problem: the boundary rule kills the
//     term, not just the word.
//
// The collocation guard has one hole, and a second ratio prices it rather than
// closing it. In a book ABOUT something, the article in front of that something
// is frequent enough to protect itself — «der Suchmaschine» can easily be 2 %
// of every «der» in a book about search engines, and a protected «der» means
// the whole German list is grammar again. A token met on more than
// AUTO_ALWAYS_RATIO of the pages is therefore held to a much higher standard of
// evidence: no content word is on 85 % of a book's pages and every article and
// conjunction is on ~100 % of them, so the prior is heavily against that token
// and an ordinary collocation is not enough to overturn it.
//
// What that tier may NOT be is beyond rescue, which is what it was when it
// first shipped: it added a token to the stoplist and never entered it in the
// set round two was able to take back out, so nothing above 85 % could be
// released whatever it collocated with. A monograph names its subject on every
// page — that is what a monograph IS — so the tier fired first and hardest on
// exactly the books this whole derivation exists to serve. Measured over 60
// synthetic French pages on which «web» heads the real term «web semantique»,
// varying only its page share and counting the terms that START or END on
// «web», which is what the boundary rule decides: 6 of them at a share of 0.70,
// and 0 at 0.86 and 0 at 1.00. Not «fewer» — none. The book's own subject and
// every term it holds together left the list, the unigram with them, at exactly
// the page share that says the book is about it.
//
// So the two tiers now differ in price, not in kind: in the 60–85 % band a
// token is released when its heaviest real collocation accounts for
// AUTO_BOUND_RATIO of its own occurrences, and above 85 % that same collocation
// must account for AUTO_ALWAYS_BOUND_RATIO of them. The two populations are an
// order of magnitude apart and the constant sits in the gap between them, on
// three corpora of 60 pages each: «web» in a French monograph on the semantic
// web has 1.000 of its occurrences inside «web semantique» (0.750 on the
// sparser corpus above), while «der» in a German book that says «der
// Suchmaschine» twice a page and spreads the rest of its «der» over a
// sixty-noun vocabulary has 0.060. The same figure over 34 pages of REAL
// prose — this repo's own comments and docs, with the closed-class words
// rot13'd so the curated lists cannot see them while every distribution stays
// the one real writing produced — runs from 0.000 to 0.125 across all 25 tokens
// the derivation looked at, and no higher than 0.060 among the ones the 85 %
// tier actually holds. Both A/B runs then come out where they should: the
// French subject and its terms come back at every page share, «der» stays
// stopped so the German list stays terminology, and on the real-prose corpus
// the derived stoplist and the returned terms are unchanged word for word.
//
// The cost of a false positive is bounded and worth stating: a stopped token
// can no longer be a unigram term (which it could only have been as an acronym
// or a capitalised-in-running-text word, and the case guard already excludes
// both) and can no longer open or close a multiword one (which the collocation
// guard has just established none of the frequent ones do). What is left is a
// long tail of rare collocations.
//
// WHEN it runs is a separate decision from how, and the default is NOT «always,
// on top of the curated list». The graph's numbers on an English book are
// published, and an English content word of five letters or fewer that clears
// 60 % of 838 pages — «query», «data», «time» — would change them. Where we
// ship a curated list it was measured against real books and it wins; where we
// do not, this stands in for it. A caller that wants both says so with
// `autoStop: true`.

const AUTO_MAX_LEN = 5; // characters
const AUTO_PAGE_RATIO = 0.6; // of the pages actually mined
const AUTO_ALWAYS_RATIO = 0.85; // …above which a collocation has to be much heavier
const AUTO_BOUND_RATIO = 0.02; // collocation weight that protects a token
const AUTO_ALWAYS_BOUND_RATIO = 0.25; // …the weight it takes above AUTO_ALWAYS_RATIO
// Below this many pages the page-spread rule degenerates: 60 % of a ten-page
// article is six pages, and a paper about BERT says «bert» on eight of them.
const AUTO_MIN_PAGES = 32;

function deriveAutoStop(
  stats: Map<string, Stat>,
  pagesMined: number,
  floor: number,
  minPages: number,
): ReadonlySet<string> {
  const stop = new Set<string>();
  if (pagesMined < AUTO_MIN_PAGES) return stop;
  const need = pagesMined * AUTO_PAGE_RATIO;
  const always = pagesMined * AUTO_ALWAYS_RATIO;

  // Round one: short, everywhere, and lower case in running text. The page
  // share does not decide WHETHER a token can be released in round two, only
  // what release costs it — every token stopped here is priced and every one
  // of them is arguable. A tier with no way back out is what took the subject
  // of a monograph off the list along with every term it holds together.
  const price = new Map<string, number>();
  for (const [key, st] of stats) {
    if (key.length > AUTO_MAX_LEN || key.includes(" ")) continue;
    if (st.pages.length <= need) continue;
    if (st.capNonInit * 2 > st.nonInit) continue;
    stop.add(key);
    price.set(key, st.pages.length > always ? AUTO_ALWAYS_BOUND_RATIO : AUTO_BOUND_RATIO);
  }
  if (!stop.size) return stop;

  // Round two: the heaviest real collocation each of them heads or ends.
  // «Real» means the candidate itself clears the miner's own floor and spread,
  // and that its other tokens are not provisional stops — a pair of function
  // words vouching for each other is not evidence of a term.
  const bound = new Map<string, number>();
  for (const [key, st] of stats) {
    if (st.freq < floor || st.pages.length < minPages) continue;
    const toks = key.split(" ");
    if (toks.length < 2) continue;
    for (const at of [0, toks.length - 1]) {
      const w = toks[at];
      if (!stop.has(w)) continue;
      if (toks.some((o, i) => i !== at && stop.has(o))) continue;
      if ((bound.get(w) ?? 0) < st.freq) bound.set(w, st.freq);
    }
  }
  // Every deletion is decided against the FULL round-one set — `stop` is only
  // mutated after `bound` is complete — so releasing one token can never turn
  // its neighbour's evidence into the pair of function words vouching for each
  // other that the guard above exists to refuse.
  for (const [w, ratio] of price)
    if ((bound.get(w) ?? 0) >= (stats.get(w)?.freq ?? 0) * ratio) stop.delete(w);
  return stop;
}

// ---- text plumbing ----------------------------------------------------------

// lookbehind: never start a token mid-word — "38th" must not yield "th"
const TOKEN_RE = /(?<![\p{L}\p{N}])[\p{L}][\p{L}\p{N}]*(?:['’-][\p{L}\p{N}]+)*/gu;
const CHUNK_SEP = /[,;:()[\]{}<>"“”«»|/\\]+/;
// The lookahead is `\p{Lu}` rather than the two alphabets both twins spelled
// out by hand ([A-ZА-ЯЁ]). It is a strict superset for English and Russian, so
// nothing measured moves, and it is the difference between splitting a Polish
// or Czech book into sentences and not splitting it at all — «Śledzenie…» and
// «Životní…» open sentences the ASCII class walks straight past, and a page
// that never splits has exactly one sentence-initial token, which is what the
// case evidence below is built on. Scripts without case (Arabic, Hebrew,
// Devanagari) still cannot be split this way; that limit is real and unfixed.
const SENT_SPLIT = /(?<=[.!?…][")\]»”’]*)\s+(?=[\p{Lu}\p{Nd}«"“([])/u;

const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/// Does this surface form open on a capital, in any of the alphabets a book
/// might be written in? A Unicode uppercase test, and it has to be one.
///
/// What stood here was `(ch >= 65 && ch <= 90) || (ch >= 0x410 && ch <= 0x42f)
/// || ch === 0x401` — A–Z, А–Я, Ё, and nothing else — inherited from graphgen,
/// where it only ever had to guess whether a line looked like a heading. Here
/// it is the only thing that increments `capNonInit`, and `capNonInit` is
/// load-bearing twice: it gates the capitalised-unigram acceptance rule in
/// rank(), and it is the case guard that deriveAutoStop's comment calls «the
/// one guard that makes German safe». For a word opening on Ü, Ł, É, Ś or Á,
/// capNonInit stayed 0 and both of those silently answered as if the book had
/// written the word in lower case — so the guard named after German could not
/// fire for the German nouns that need it most.
///
/// Measured on 60 synthetic German pages carrying two capitalised nouns made
/// identical in length, sentence position, page spread and neighbours, and
/// differing only in their first codepoint — «Übung» (U+00DC) and «Zeile»
/// (ASCII Z). With the codepoint list: 3 «Übung» candidates against 5 «Zeile»
/// ones, and the bare unigram «Zeile» accepted while «Übung» was not — and
/// with the auto-stoplist switched off entirely, still 8 against 9, that one
/// missing entry being the unigram again, which is the rank() half of the same
/// blindness showing on its own. With this test: 9 and 9 either way. The whole
/// asymmetry was the first codepoint. It was never a decision either — the
/// acceptance rule's own surface gate in rank() already reads
/// `/^\p{Lu}[^\p{Lu}]/u`, and SENT_SPLIT was widened to `\p{Lu}` for the same
/// reason, so this pair of hand-written alphabets was the last place in the
/// module still assuming a book is English or Russian.
///
/// Still not a regex per call: this runs once per counted occurrence, millions
/// of times over a book, which is why the old test was a codepoint comparison
/// in the first place. ASCII — every English book and the Latin islands in a
/// Russian one — still answers from one comparison and never touches the regex.
/// Everything else answers from a memo keyed by codepoint, so the regex runs
/// once per distinct letter that can open a word rather than once per
/// occurrence: a few dozen entries for an alphabet, a few thousand at the very
/// worst for a book in a script that has that many characters, against the
/// tens of thousands of n-grams the counts hold either way.
const CAP_RE = /^[\p{Lu}\p{Lt}]/u;
const capMemo = new Map<number, boolean>();
const isCapital = (surface: string): boolean => {
  const cp = surface.codePointAt(0);
  if (cp === undefined) return false;
  if (cp < 0x80) return cp >= 65 && cp <= 90;
  let cap = capMemo.get(cp);
  if (cap === undefined) capMemo.set(cp, (cap = CAP_RE.test(surface)));
  return cap;
};

/// Translation context has to be prose: a table-of-contents line or a
/// digit-heavy fragment («3.3.4 Learning to Rank 61») would only mislead the
/// model it is handed to.
const isProse = (s: string): boolean => s.length >= 40 && (s.match(/\d/g)?.length ?? 0) < s.length * 0.08;

/// A sentence, and the clause-bounded token runs inside it. The raw text is
/// carried only when somebody asked for samples — it is what pins a page's
/// text in memory for as long as the miner lives.
type Sent = { raw: string; chunks: string[][] };

function sentences(text: string, keepRaw: boolean): Sent[] {
  const out: Sent[] = [];
  for (const piece of text.split(SENT_SPLIT)) {
    const raw = piece.trim();
    if (!raw) continue;
    const chunks = raw
      .split(CHUNK_SEP)
      .map((c) => c.match(TOKEN_RE) ?? [])
      .filter((toks) => toks.length);
    if (chunks.length) out.push({ raw: keepRaw ? raw : "", chunks });
  }
  return out;
}

/// A window of context around the term rather than a whole page-long
/// «sentence»: what this feeds is a prompt, and a model handed 4 000 characters
/// of context for a two-word segment translates the context.
function clampSample(raw: string, key: string): string {
  const s = flat(raw);
  if (s.length <= SAMPLE_WINDOW) return s;
  const i = Math.max(0, s.toLowerCase().indexOf(key.split(" ")[0]));
  const start = Math.max(0, i - 100);
  const end = Math.min(s.length, i + 200);
  return (start > 0 ? "…" : "") + s.slice(start, end).trim() + (end < s.length ? "…" : "");
}

/// The key an arbitrary phrase would have been counted under: the same tokens,
/// lowercased and joined. This is what lets a phrase from somewhere else — a
/// line of the reader's glossary, say — be looked up in the counts instead of
/// the book being scanned a second time. (TOKEN_RE carries /g; String.match
/// resets lastIndex, so the shared object stays reusable.)
export function mineKey(term: string): string {
  const toks = term.match(TOKEN_RE);
  return toks ? toks.map((w) => w.toLowerCase()).join(" ") : "";
}

// ---- counting ---------------------------------------------------------------

type Stat = {
  freq: number;
  pages: number[]; // 1-based, ascending, deduped
  nonInit: number; // occurrences NOT at a sentence start (case is trustworthy there)
  capNonInit: number; // …of those, the surface starts with a capital
  forms: Map<string, number>; // non-lowercase surface forms at non-initial positions
  first: string; // first surface seen anywhere (fallback display)
  sample: string; // first-occurrence sentence, upgraded once to the first prose one
  prose: boolean; // the sample already looks like prose
};

function bump(
  stats: Map<string, Stat>,
  key: string,
  page: number,
  surface: string,
  nonInitial: boolean,
  raw: string,
): void {
  let st = stats.get(key);
  if (!st) {
    st = {
      freq: 0,
      pages: [],
      nonInit: 0,
      capNonInit: 0,
      forms: new Map(),
      first: surface,
      sample: "",
      prose: false,
    };
    stats.set(key, st);
  }
  st.freq++;
  // pages arrive in ascending order, so one comparison is the whole dedup
  if (st.pages[st.pages.length - 1] !== page) st.pages.push(page);
  if (raw) {
    // First occurrence wins, but a first occurrence that was a heading or a
    // contents line is replaced once by the first one that reads as prose.
    if (!st.sample) ((st.sample = raw), (st.prose = isProse(raw)));
    else if (!st.prose && isProse(raw)) ((st.sample = raw), (st.prose = true));
  }
  if (nonInitial) {
    st.nonInit++;
    if (surface !== key) st.forms.set(surface, (st.forms.get(surface) ?? 0) + 1);
    if (isCapital(surface)) st.capNonInit++;
  }
}

/// One page's contribution to the counts: n-grams of 1..MAX_N inside clause
/// bounds, with the boundary rules — a term never starts or ends on a function
/// word, and a one-character token may never sit inside one (math-notation runs
/// like «iP P R iP» would otherwise mine themselves into the term list).
function minePage(
  stats: Map<string, Stat>,
  page: number,
  text: string,
  func: ReadonlySet<string>,
  withSample: boolean,
): void {
  for (const sent of sentences(text, withSample)) {
    let sentPos = 0; // token index within the sentence — 0 ⇒ sentence-initial
    for (const toks of sent.chunks) {
      const low = toks.map((w) => w.toLowerCase());
      for (let a = 0; a < low.length; a++) {
        const w0 = low[a];
        // the opening word does not depend on n, so a bad one ends the run
        if (w0.length < 2 || func.has(w0)) continue;
        for (let n = 1; n <= MAX_N && a + n <= low.length; n++) {
          if (n > 2 && low[a + n - 2].length < 2) break;
          const end = low[a + n - 1];
          if (end.length < 2 || func.has(end)) continue; // a longer gram may still end cleanly
          const key = low.slice(a, a + n).join(" ");
          if (key.length > MAX_KEY_CHARS) break;
          bump(stats, key, page, toks.slice(a, a + n).join(" "), sentPos + a > 0, sent.raw);
        }
      }
      sentPos += toks.length;
    }
  }
}

/// Dominant surface form: the lowercased key, unless some cased form outnumbers
/// plain lower case in running text (BM25 not bm25, Boolean not boolean).
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

// ---- ranking ----------------------------------------------------------------

/// Rank the counted n-grams and keep the top `cap`. C-value nested discounting
/// (longest first; an accepted longer term's own-use frequency is subtracted
/// from its subgrams) for multiword candidates, acronym and
/// capitalised-in-running-text rules for unigrams.
///
/// `minPages` is the rule that belongs to the sampler rather than to C-value,
/// and it is here because a floor alone stops being enough as soon as the floor
/// is low. A count of 5 over a whole book is what keeps a phrase that happens to
/// repeat inside one table or one worked example from being read as a concept;
/// where the floor drops (see sampleFloor) exactly that junk comes back — a page
/// that says «value systems change» three times hands the list a four-word term
/// spanning a verb. A term the book is actually about turns up in more than one
/// place. The caller relaxes this for a document too short to have a spread
/// worth measuring.
function rank(
  stats: Map<string, Stat>,
  cap: number,
  minPages: number,
  floor: number,
  lists: StopLists,
  auto: ReadonlySet<string>,
  withPages: boolean,
  withSample: boolean,
): MinedTerm[] {
  // The auto-derived list arrives too late to have been a boundary rule while
  // counting — it is derived FROM the counts — so it is applied here instead,
  // to exactly the same effect: a candidate that opens or closes on one of its
  // words is not a candidate, and neither is the word itself.
  const stopped = (key: string): boolean => {
    if (!auto.size) return false;
    const toks = key.split(" ");
    return auto.has(toks[0]) || auto.has(toks[toks.length - 1]);
  };

  type Cand = { key: string; n: number; freq: number };
  const cands: Cand[] = [];
  for (const [key, st] of stats) {
    if (st.freq < floor || st.pages.length < minPages) continue;
    if (stopped(key)) continue;
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

  type Scored = { key: string; disp: string; freq: number; score: number; sample: string };
  const accepted: Scored[] = [];
  for (const c of cands) {
    const st = stats.get(c.key)!;
    const adj = c.freq - (nested.get(c.key) ?? 0);
    const disp = dominantForm(c.key, st);
    const base = { key: c.key, disp, freq: c.freq, sample: st.sample };
    if (c.n >= 2) {
      if (adj >= floor) accepted.push({ ...base, score: adj * Math.log2(c.n) });
      continue;
    }
    const isAcr =
      disp.length >= 2 && disp === disp.toUpperCase() && /\p{Lu}/u.test(disp) && !/^[IVXLCDM]+$/.test(disp);
    if (isAcr && adj >= floor) {
      accepted.push({ ...base, score: adj });
      continue;
    }
    // A two-letter capitalised token in running text is an author surname (Li,
    // Yu, Xu, Ma), never a domain term: the citation-heavy prose of a survey
    // makes them frequent and non-sentence-initial, so they clear every test
    // above. One such entry («Li = инвертированные списки», mined from an
    // inverted-list formula) reached a shipped glossary and poisoned the book.
    // Genuine two-letter terms are acronyms and were accepted just above.
    if (
      disp.length >= 3 &&
      /^\p{Lu}[^\p{Lu}]/u.test(disp) &&
      st.capNonInit >= MIN_CAP_FREQ &&
      st.capNonInit > st.nonInit - st.capNonInit &&
      !lists.common.has(c.key)
    )
      accepted.push({ ...base, score: adj });
  }

  // Conjunction split: «precision and recall» is two terms joined by prose, not
  // one — but only when both halves stand on their own in the text. Purely
  // structural, no domain knowledge involved. A half with no sample of its own
  // inherits the pair's, which is a sentence it demonstrably occurs in.
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
      return !!st && st.freq >= floor && st.pages.length >= minPages && !stopped(h);
    };
    if (!halves.length || !halves.every(standsAlone)) {
      split.push(c);
      continue;
    }
    for (const h of halves) {
      if (have.has(h)) continue; // the half is already a term in its own right
      have.add(h);
      const st = stats.get(h)!;
      const sample = st.sample || c.sample;
      split.push({ key: h, disp: dominantForm(h, st), freq: st.freq, score: c.score, sample });
    }
  }

  split.sort((a, b) => b.score - a.score);
  return split.slice(0, cap).map((c) => {
    const out: MinedTerm = { term: c.disp, key: c.key, freq: c.freq };
    if (withPages) out.pages = (stats.get(c.key)?.pages ?? []).slice(0, MAX_PAGES_PER_TERM);
    if (withSample) out.sample = clampSample(c.sample, c.key);
    return out;
  });
}

// ---- the miner --------------------------------------------------------------

/// A miner fed one page at a time, for a caller that reads a book page by page
/// and cannot afford to hold it. Nothing here yields to the event loop: the
/// caller owns the read loop, its progress bar and its abort signal, and it is
/// the one that knows when to breathe.
export function createMiner(opts: MineOptions): TermMiner {
  const { lang, cap, minFreq, minPages, withPages = false, withSample = false } = opts;
  const lists = stopLists(lang);
  const auto = opts.autoStop ?? !hasCuratedStop(lang);
  const stats = new Map<string, Stat>();
  let pages = 0;

  return {
    addPage(page: number, text: string): void {
      pages++;
      minePage(stats, page, text, lists.func, withSample);
    },
    get pagesMined(): number {
      return pages;
    },
    lookup(term: string): { key: string; freq: number; pages: number[] } {
      const key = mineKey(term);
      const st = key ? stats.get(key) : undefined;
      return { key, freq: st?.freq ?? 0, pages: st ? st.pages.slice(0, MAX_PAGES_PER_TERM) : [] };
    },
    finish(): MinedTerm[] {
      const derived = auto ? deriveAutoStop(stats, pages, minFreq, minPages) : new Set<string>();
      return rank(stats, cap, minPages, minFreq, lists, derived, withPages, withSample);
    },
  };
}

/// The same miner for a caller that already has the text: pages in, terms out.
/// `page` numbers must ascend, as they must for createMiner.
export function mineTerms(pages: Iterable<{ page: number; text: string }>, opts: MineOptions): MinedTerm[] {
  const miner = createMiner(opts);
  for (const p of pages) miner.addPage(p.page, p.text);
  return miner.finish();
}
