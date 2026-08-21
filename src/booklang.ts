// The language a BOOK is written in — detected from its own text, never
// configured and never inherited from the interface.
//
// Until now the app had no notion of it at all: `Lang` in i18n.ts is the
// INTERFACE language, a closed "ru" | "en" union that doubles as the language
// books are translated INTO (see TARGET_LANGUAGE there), and nothing in src or
// src-tauri ever read a PDF's dc:language or its Info Lang. That absence is
// what let the glossary miner ship an ASCII-Latin token regex and still look
// successful on a Russian book: with no idea what the book was written in,
// there was nothing in the program able to contradict it.
//
// `BookLang` is therefore a SEPARATE and deliberately OPEN type — a BCP-47
// primary subtag, or "und" when we decline to guess. It must not reuse i18n's
// `Lang`: a reader running the Russian interface will perfectly well open a
// German book, and the moment the two ideas share a type someone collapses one
// into the other and the bug above comes back. i18n's union stays closed and
// untouched; this one is a string because the set of languages a book may be
// written in is not ours to close.
//
// ---- why a stopword vote and not a call to the aux model --------------------
//
// Detection belongs to graphgen's SEED pass, and the seed pass has one promise
// it may not break (graphgen.ts's own header states it): deterministic,
// model-free, finished in seconds, so that a book shows up in the library the
// moment the library notices it. Three consequences, each on its own decisive:
//
//   * the miner needs the language BEFORE it mines, to choose a stoplist. A
//     model call would sit on the critical path of every book in a library, and
//     the whole point of the seed pass is that it does not wait for a model.
//   * the aux model is a 4B sharing one 16 GB GPU with the translation engine.
//     graphgen starts it for the deep pass and stops it in a `finally` for
//     exactly this reason; waking it to answer «what language is this» would
//     put a background library scan on the GPU while the reader is translating.
//   * a model's answer is not reproducible, and the language is written into
//     the seed shard and the glossary sidecar, where two runs over the same
//     book disagreeing is a data bug rather than a bad guess.
//
// A function-word vote costs a few milliseconds of string scanning over page
// text the caller has already extracted for other reasons. For the ten
// languages we ship lists for it is not the cheaper-but-weaker method — on
// running prose it is the stronger one.
//
// ---- what `confidence` means ------------------------------------------------
//
// The margin between the best candidate and the runner-up, 0..1, damped by a
// prior so that thin evidence cannot produce a confident answer (see PRIOR).
// It is NOT a probability and nothing should treat it as one. It exists so the
// UI can say «немецкий, скорее всего» rather than «немецкий», and so a caller
// can decide for itself whether to ask the reader. When we will not answer at
// all the language is "und" and the confidence is 0 — an undecided book has no
// confidence in anything, and reporting 0.07 next to "und" would only invite
// someone to threshold it a second time.
//
// Nothing here is async, nothing here does IO, and nothing here throws. The
// caller hands over page text it already has; see `detectBookLang`.

/// A BCP-47 primary subtag ("en", "ru", "de", "zh", …) or `UND`.
export type BookLang = string;

/// The interface language, structurally i18n's `Lang`. Written out rather than
/// imported so this module has no imports at all: it is pure, synchronous and
/// checkable by eye, and it is consulted by graphgen's seed pass, which is the
/// one place in the app that must not acquire new load-time dependencies.
type UiLang = "ru" | "en";

/// «I will not guess.» The ISO 639-2 subtag for an undetermined language, so it
/// is a legal value everywhere a language tag is legal — including
/// `Intl.DisplayNames`, which names it.
export const UND: BookLang = "und";

export type Detection = { lang: BookLang; confidence: number };

const undecided = (): Detection => ({ lang: UND, confidence: 0 });

// ---- what we can recognise --------------------------------------------------

// The languages the vote can separate: a compact function-word list each, below.
const LATIN_LANGS = ["en", "de", "fr", "es", "it", "pt", "nl", "pl"] as const;
const CYRILLIC_LANGS = ["ru", "uk"] as const;

// The languages a script alone names, with no vote at all.
const SCRIPT_ONLY_LANGS = ["zh", "ja", "ko", "el", "he", "ar", "hi"] as const;

/// Everything `detectBookLang` can return besides `UND` — the list a language
/// override in the UI should offer first. `BookLang` stays open on purpose:
/// a reader may type a subtag we cannot detect, and that is a legal record.
export const BOOK_LANGS: readonly BookLang[] = [
  ...CYRILLIC_LANGS,
  ...LATIN_LANGS,
  ...SCRIPT_ONLY_LANGS,
];

// ---- constants --------------------------------------------------------------
//
// None of these came off a corpus: there is no test runner in this repo and no
// labelled book collection to measure against, so each one is a CHOSEN bound
// with a concrete scenario it exists to reject, stated beside it. If a book is
// ever misdetected in the wild, that scenario is the thing to re-argue.

/// Characters read per sample, and in total. A page of text is a couple of
/// thousand characters and graphgen hands us a few dozen pages of a book it
/// may have read in full; the vote saturates long before that, and the whole
/// point of this module is that it costs nothing next to the mining pass.
const PER_SAMPLE = 4_000;
const MAX_SCAN = 120_000;

/// Below this many letters there is no book here to identify — a title page on
/// its own (~68), a page of formulas (~30), or a scan whose text layer came
/// back empty.
///
/// Deliberately low, because this floor is the only one the script branch has
/// and a letter is not a constant amount of text: one Han character or one
/// Hangul syllable carries about what five Latin letters carry. At 200 this
/// rejected a full paragraph of Chinese and one of Korean while passing far
/// less English — the same number meaning five times as much text. The
/// alphabetic path does not lean on this at all; MIN_TOKENS below is its real
/// floor, and a hundred ideographs is already an unambiguous histogram.
const MIN_LETTERS = 80;

/// …and below this many word tokens the vote has nothing to count. This is the
/// floor that matters for Latin and Cyrillic: roughly one short paragraph.
const MIN_TOKENS = 60;

/// A script decides the language only when it holds a clear majority of the
/// letters. A plurality is not enough: an English maths book carries Greek
/// letters on every other line, and a Russian book about software carries
/// Latin identifiers everywhere.
const SCRIPT_LEAD = 0.5;

/// A second script this prominent puts its languages into the vote too. A
/// bilingual or heavily code-quoting book gets both candidate sets and the
/// function words settle it, which they do far better than a letter count.
const MIX_SHARE = 0.15;

/// Kana as a share of the CJK letters. Japanese prose is roughly half kana;
/// Chinese prose has none. Anything above a rounding error means Japanese.
const KANA_MIN = 0.05;

/// Phantom hits given to every candidate before counting. This is the guard
/// against the failure mode this module has to survive — a page of formulas, a
/// bibliography, a title page, a table of contents, all of which are nearly
/// free of function words. Four phantom hits are worth more than the two
/// stray "the"s such a page yields, so its margin collapses and the answer is
/// "und" rather than a confident wrong language. On real prose (hundreds of
/// hits per page) the prior is invisible.
const PRIOR = 4;

/// The winner must clear an absolute floor of weighted hits. Eight, not twelve:
/// one 60-token paragraph of Ukrainian scores 10.0 and one of Russian 16.0, and
/// a floor that rejects a whole paragraph of correct prose is guarding the
/// wrong thing. The cases this floor is for score far below it — a page of
/// back-of-book index entries scores 0.0, a table of numbers 6.0.
const MIN_HITS = 8;

/// …and the winner must EXPLAIN the text: its unweighted score divided by the
/// tokens written in its own alphabet. This is the floor that catches the one
/// misdetection that would really hurt — a language we ship no list for scoring
/// on its neighbours' shared words. Measured over one paragraph each:
///
///   de .40  fr .35  en .33  es .27  nl .27  pt .24  pl .23  it .20  ru .19  uk .16
///   ← every language we ship, worst case .16 (Ukrainian) ──────────────────────
///   MIN_LANG_DENSITY = .11
///   ── nothing we can name ────────────────────────────────────────────────────
///   Swedish .07   an English bibliography .04   an index page .00
///
/// Swedish is the case that set it. It shares «de», «en», «i», «som» and «det»
/// with Dutch and the Romance lists, and before this floor existed four
/// paragraphs of it came back "en" with confidence 0.35 — a CONFIDENT wrong
/// answer, which is the worst thing this module can produce: it picks the wrong
/// curated stoplist for the miner and writes a wrong `lang` into the glossary
/// sidecar, both of which persist. "und" costs an auto-derived stoplist and an
/// honest «язык не определён»; this costs a silently wrong book.
///
/// Per own-alphabet tokens, not per token, so that a Russian book quoting
/// English is judged on its Russian: the mixed page below scores ru 16.0 over
/// its 84 Cyrillic tokens (.19, the same as pure Russian prose) rather than
/// over all 131 (.12, close enough to the floor to be luck.)
const MIN_LANG_DENSITY = 0.11;

/// Below this margin we would be guessing, and a wrong language is worse than
/// no language: it picks the wrong stoplist for the miner and mislabels the
/// glossary sidecar, both of which persist to disk.
const MIN_CONF = 0.12;

// ---- script histogram -------------------------------------------------------

type Script =
  | "Latin"
  | "Cyrillic"
  | "Greek"
  | "Han"
  | "Hiragana"
  | "Katakana"
  | "Hangul"
  | "Arabic"
  | "Hebrew"
  | "Devanagari";

// Matched in RUNS rather than single characters: a run is a word, so a 120 KB
// scan costs ~20k regex steps per script instead of 120k. The regexes are
// module-level and `g`-flagged, which is safe because everything here is pure
// and synchronous — no two counts are ever interleaved — and `lastIndex` is
// reset before each use anyway.
const SCRIPT_RE: Record<Script, RegExp> = {
  Latin: /\p{Script=Latin}+/gu,
  Cyrillic: /\p{Script=Cyrillic}+/gu,
  Greek: /\p{Script=Greek}+/gu,
  Han: /\p{Script=Han}+/gu,
  Hiragana: /\p{Script=Hiragana}+/gu,
  Katakana: /\p{Script=Katakana}+/gu,
  Hangul: /\p{Script=Hangul}+/gu,
  Arabic: /\p{Script=Arabic}+/gu,
  Hebrew: /\p{Script=Hebrew}+/gu,
  Devanagari: /\p{Script=Devanagari}+/gu,
};

const SCRIPTS = Object.keys(SCRIPT_RE) as Script[];

/// What each script says on its own, once it holds the page. Cyrillic and Latin
/// are absent: those two go to the vote, which is the whole reason this module
/// is more than a histogram.
const SCRIPT_LANG: Partial<Record<Script, BookLang>> = {
  Greek: "el",
  Hangul: "ko",
  Arabic: "ar",
  Hebrew: "he",
  Devanagari: "hi",
};

/// How much a script can be trusted to name its language, as a ceiling on the
/// confidence. Hangul is written by Korean and nothing else. The Arabic script
/// is shared by Arabic, Persian and Urdu, and Devanagari by Hindi, Marathi and
/// Nepali; we ship function words for none of them, so we return the commonest
/// member and say out loud, through the number, that it is a script-level
/// guess. Greek is capped because ancient Greek is a different subtag ("grc")
/// that we make no attempt to tell apart; Hebrew because Yiddish shares it.
const SCRIPT_CONF: Partial<Record<BookLang, number>> = {
  ko: 1,
  ja: 0.95,
  zh: 0.9,
  el: 0.9,
  he: 0.85,
  ar: 0.6,
  hi: 0.6,
};

type Histogram = { total: number; counts: Record<Script, number> };

function countRuns(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) n += m[0].length;
  return n;
}

function scriptHistogram(text: string): Histogram {
  const counts = {} as Record<Script, number>;
  let total = 0;
  for (const s of SCRIPTS) {
    const n = countRuns(text, SCRIPT_RE[s]);
    counts[s] = n;
    total += n;
  }
  return { total, counts };
}

function topScript(hist: Histogram): Script | null {
  let best: Script | null = null;
  for (const s of SCRIPTS) if (!best || hist.counts[s] > hist.counts[best]) best = s;
  return best && hist.counts[best] > 0 ? best : null;
}

// ---- function words ---------------------------------------------------------
//
// A dozen or two of the commonest words each, and no more. This is not a
// linguistics project: the lists exist to SEPARATE the languages we ship, not
// to model them, and every word added past the point of separation only adds
// another chance of colliding with a neighbour.
//
// Words that several languages share are still worth keeping — «de» is
// evidence, just weak evidence, and dropping it would throw away the fact that
// the book is Romance at all. They are counted at 1/(number of lists that
// contain them), so «the» is a whole vote and «de» a quarter of one, and the
// languages that overlap most (es/pt, ru/uk) are decided by the words that do
// NOT overlap. See WORD_LANGS.
//
// Known and accepted noise: single-letter entries («и», «o», «w») also match
// the initials in a bibliography and the variable names in a formula. They earn
// their place in Russian, Polish and Portuguese, where dropping them would cost
// more than the noise does, and pooling many pages plus MIN_LANG_DENSITY keeps
// a stretch of initials from carrying a vote — a page of nothing but «Manning
// C. D., Raghavan P.» scores 0.04 and is refused.

const words = (s: string): readonly string[] => s.split(/\s+/).filter(Boolean);

// Russian and Ukrainian get a few more entries than the rest, and the reason is
// structural rather than sloppy: neither has articles, so no two or three words
// carry the load that «the», «a» and «of» carry in English. Measured on one
// paragraph each, the English list explains 0.33 of the tokens and the Russian
// one 0.19 — the extra prepositions and conjunctions are what close that gap,
// and without them a quoted English abstract inside a Russian page outscores
// the page it is quoted on (see SCRIPT-WEIGHTING in stopwordVote for the other
// half of that fix). It is also why MIN_LANG_DENSITY sits below Russian's 0.19
// rather than near English's 0.33.
const FUNC_WORDS: Record<BookLang, readonly string[]> = {
  en: words(`the a of and to in is that it for with as was on are be this by from at not but which or`),
  ru: words(`а и в не на что с по как это для но из к если или то при так от за до у о его есть также
    где`),
  uk: words(`а і в на не що з до як це для але або та у від за який при так його ще є також де`),
  de: words(`der die das und ist nicht ein eine zu den von mit sich auf für dem des im es auch wird sind
    aber wie`),
  fr: words(`le la les de des du et est un une dans que qui pour pas sur plus avec au aux ce il en sont`),
  es: words(`el la los las de del y en que un una por con para se no es son como su sus al lo más`),
  it: words(`il lo la gli le di del della che un una per con non sono come nel alla dei delle più si ma e`),
  pt: words(`o a os as de do da dos das e que um uma para com não em no na se por mais como são`),
  nl: words(`de het een en van is dat die te in op met voor niet zijn aan ook als maar om door bij dan
    wordt`),
  pl: words(`i w na nie że do się z jest to o jak przez dla od po ale są tego który przy tylko lub oraz`),
};

/// word → every shipped list that contains it. Built once; the length of the
/// value is the divisor that turns a hit into a weighted vote.
const WORD_LANGS = new Map<string, BookLang[]>();
for (const [lang, list] of Object.entries(FUNC_WORDS)) {
  for (const w of list) {
    const langs = WORD_LANGS.get(w);
    if (langs) langs.push(lang);
    else WORD_LANGS.set(w, [lang]);
  }
}

// Letters only, so an apostrophe splits: French elision would otherwise hide
// «un» inside «d'un» and «il» inside «qu'il», and those are exactly the words
// French is recognised by. Digits are excluded because a year is not evidence
// of anything.
const TOKEN_RE = /\p{L}+/gu;

// ---- detection --------------------------------------------------------------

/// Pool the samples, capped. Per-sample first so that one enormous page cannot
/// spend the whole budget and leave the rest of the book unread.
function pool(samples: readonly string[]): string {
  const parts: string[] = [];
  let budget = MAX_SCAN;
  for (const s of samples) {
    if (budget <= 0) break;
    if (!s) continue;
    const take = Math.min(s.length, PER_SAMPLE, budget);
    parts.push(take === s.length ? s : s.slice(0, take));
    budget -= take;
  }
  return parts.join("\n");
}

/// Which languages the vote considers. Always the top script's own set, plus
/// the other alphabet's when it is prominent enough to be more than quotation.
function candidates(hist: Histogram, top: Script): BookLang[] {
  const set = new Set<BookLang>(top === "Cyrillic" ? CYRILLIC_LANGS : LATIN_LANGS);
  const other: Script = top === "Cyrillic" ? "Latin" : "Cyrillic";
  if (hist.counts[other] / hist.total >= MIX_SHARE) {
    for (const l of other === "Latin" ? LATIN_LANGS : CYRILLIC_LANGS) set.add(l);
  }
  return [...set];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/// The alphabet each voting language is written in. Only two of them exist, so
/// this is a membership test rather than a table.
const CYRILLIC_SET = new Set<BookLang>(CYRILLIC_LANGS);
const langScript = (l: BookLang): Script => (CYRILLIC_SET.has(l) ? "Cyrillic" : "Latin");

// A token belongs to the alphabet its first letter is written in. First letter
// only: a token mixing alphabets is a typography accident, not a third language.
const CYRILLIC_HEAD = /^\p{Script=Cyrillic}/u;

function stopwordVote(text: string, hist: Histogram, poolLangs: readonly BookLang[]): Detection {
  const score = new Map<BookLang, number>(poolLangs.map((l): [BookLang, number] => [l, 0]));
  let tokens = 0;
  let cyrTokens = 0;

  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
    tokens++;
    if (CYRILLIC_HEAD.test(m[0])) cyrTokens++;
    const langs = WORD_LANGS.get(m[0].toLowerCase());
    if (!langs) continue;
    // The weight is a property of the WORD, not of this book's candidate pool:
    // «de» is a quarter of a vote whether or not Dutch is in the running, so
    // the same page scores the same way however the histogram came out.
    const weight = 1 / langs.length;
    for (const l of langs) {
      const cur = score.get(l);
      if (cur === undefined) continue; // a language the histogram ruled out
      score.set(l, cur + weight);
    }
  }

  if (tokens < MIN_TOKENS) return undecided();

  // SCRIPT-WEIGHTING. Each candidate's vote is scaled by its alphabet's share
  // of the letters, which is how the histogram earns its place as more than a
  // way of picking the pool. Without it the module gets the one case it exists
  // for exactly wrong: a Russian book on software quotes English abstracts and
  // is dense with English identifiers, and on a measured page 300 characters of
  // quoted English scored 15.0 against a whole Russian paragraph's 16.0 — near
  // enough a tie to fall under MIN_CONF and answer "und", on a page that is 68%
  // Cyrillic. Scaled by 0.68 and 0.32 the same page reads ru 10.9 against en
  // 4.7 and answers "ru" at 0.26. A book written in one alphabet is unaffected:
  // its share is ~1.0 and every score is multiplied by the same number.
  //
  // The top two, in one pass — the margin is all we want out of the ranking.
  // `bestRaw` is kept unscaled because MIN_LANG_DENSITY judges the winner
  // against its own alphabet, where the script share has no business.
  let lang: BookLang = UND;
  let best = 0;
  let bestRaw = 0;
  let runnerUp = 0;
  for (const [l, raw] of score) {
    const s = raw * (hist.counts[langScript(l)] / hist.total);
    if (s > best) {
      runnerUp = best;
      best = s;
      bestRaw = raw;
      lang = l;
    } else if (s > runnerUp) {
      runnerUp = s;
    }
  }
  if (best < MIN_HITS) return undecided();

  const ownTokens = langScript(lang) === "Cyrillic" ? cyrTokens : tokens - cyrTokens;
  if (!ownTokens || bestRaw / ownTokens < MIN_LANG_DENSITY) return undecided();

  const confidence = (best - runnerUp) / (best + runnerUp + 2 * PRIOR);
  if (confidence < MIN_CONF) return undecided();
  return { lang, confidence: round2(confidence) };
}

function fromScript(hist: Histogram, top: Script): Detection {
  // Han, Hiragana and Katakana are one family: Japanese prose is written in all
  // three at once, so no single one of them ever holds a majority of a Japanese
  // book, and asking each on its own would answer "und" for every one of them.
  if (top === "Han" || top === "Hiragana" || top === "Katakana") {
    const kana = hist.counts.Hiragana + hist.counts.Katakana;
    const family = hist.counts.Han + kana;
    const share = family / hist.total;
    if (share < SCRIPT_LEAD) return undecided();
    const lang = kana / family >= KANA_MIN ? "ja" : "zh";
    return { lang, confidence: round2(share * (SCRIPT_CONF[lang] ?? 1)) };
  }
  const lang = SCRIPT_LANG[top];
  if (!lang) return undecided();
  const share = hist.counts[top] / hist.total;
  if (share < SCRIPT_LEAD) return undecided();
  return { lang, confidence: round2(share * (SCRIPT_CONF[lang] ?? 1)) };
}

/// The language `samples` are written in, and how sure we are.
///
/// `samples` is ALREADY-EXTRACTED page text — the caller passes the pages it
/// read for another purpose (graphgen's seed pass samples the book with
/// `samplePages` and mines each page as it arrives), so detection costs no
/// second read of the PDF and no second parse. A dozen pages is plenty; one is
/// not, and the function will say so by answering `UND`.
///
/// Pooling every page into one corpus before voting is itself the defence
/// against the pages that carry no function words. A bibliography is thin but
/// not empty, and it is thin in the book's OWN language, so it never votes
/// against the rest of the book; a page of formulas contributes almost no
/// tokens at all. What neither can do, once pooled, is outvote thirty pages of
/// prose. The floors below (MIN_LETTERS, MIN_TOKENS, MIN_HITS, MIN_LANG_DENSITY
/// and the PRIOR) exist for the case where such a page is ALL there is — a book
/// of mathematics with no prose, a scan with a broken text layer, a caller that
/// passed one title page — and every one of them answers `UND` rather than
/// inventing a language. Verified: formulas, a title page, a back-of-book index
/// and a table of numbers all answer `UND`, at any length.
export function detectBookLang(samples: readonly string[]): Detection {
  const text = pool(samples);
  if (!text) return undecided();

  const hist = scriptHistogram(text);
  if (hist.total < MIN_LETTERS) return undecided();

  const top = topScript(hist);
  if (!top) return undecided();
  if (top === "Latin" || top === "Cyrillic") return stopwordVote(text, hist, candidates(hist, top));
  return fromScript(hist, top);
}

// ---- naming -----------------------------------------------------------------

/// The primary subtag of a language tag, lowercased: "pt-BR" and "pt_PT" both
/// give "pt", because nothing in this app treats them differently — a glossary
/// does not need to know which Portuguese. Returns "" for anything that is not
/// a two- or three-letter subtag, which is how a hand-typed override that means
/// nothing gets shown back to the reader verbatim instead of being silently
/// normalised into something else.
function primary(tag: BookLang): BookLang {
  const first = tag.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(first) ? first : "";
}

// Constructing an Intl.DisplayNames is not free and there are only ever two of
// them, one per interface language. `null` is cached too: a runtime that
// refuses once will refuse every time, and retrying per label would be the
// expensive way to learn nothing.
const namers = new Map<UiLang, Intl.DisplayNames | null>();

function namer(ui: UiLang): Intl.DisplayNames | null {
  const cached = namers.get(ui);
  if (cached !== undefined) return cached;
  let dn: Intl.DisplayNames | null = null;
  try {
    dn = new Intl.DisplayNames([ui], { type: "language", fallback: "code" });
  } catch {
    dn = null;
  }
  namers.set(ui, dn);
  return dn;
}

/// The language's name in the interface language — «немецкий» / "German".
///
/// Via `Intl.DisplayNames`, which is why this costs no dependency and no table:
/// the platform already ships CLDR's names for every language in both of our
/// interface locales, and a table of our own would be a translation chore that
/// went stale the first time a reader opened a book in a language we had not
/// thought of. It falls back to the bare subtag when the runtime declines —
/// a missing constructor, or a tag CLDR has no name for.
///
/// `UND` is returned verbatim as "und" and MUST NOT be printed. CLDR does have
/// a name for it and that name is «root» / "root", which is meaningless to a
/// reader and would look like a bug on screen — so this function refuses to
/// answer rather than passing it through. A panel showing an undetected book
/// needs its own wording — «язык не определён», with the offer to choose one —
/// and that is an i18n key, which is where user-visible strings we AUTHOR
/// belong. The only reason the strings this function returns are not in i18n is
/// that we do not author them: CLDR does, in both interface locales, for every
/// language a reader might open.
export function langName(lang: BookLang, ui: UiLang): string {
  const tag = primary(lang);
  if (!tag || tag === UND) return lang;
  const dn = namer(ui);
  if (!dn) return tag;
  try {
    return dn.of(tag) || tag;
  } catch {
    // `of` throws RangeError on a structurally invalid tag. Not our business.
    return tag;
  }
}

// ---- the one decision that matters ------------------------------------------

/// Is a book in `book` worth translating into `target`?
///
/// The interesting case is the undecided one, and it decides which way this
/// whole module fails. An undetected book returns TRUE — offer the
/// translation — and that is deliberate:
///
///   * The user's rule for this feature is that translation is never gated,
///     hidden or disabled for any book. A `false` here would gate it on a
///     guess, which is the one thing it may not do.
///   * The two mistakes are not symmetrical. Answering `true` for a book that
///     was already in the target wastes a run the reader can see happening and
///     stop — the pages come back looking like the pages that went in, and the
///     panel carries a manual language override for exactly this. Answering
///     `false` for a book that needed translating withholds the feature the
///     reader opened the app for, silently, with no error and nothing on screen
///     to argue with. That is the silent fallback the house rules forbid.
///   * "und" means «we would be guessing», not «no translation applies». The
///     only honest way to spend a non-answer is on the side that leaves the
///     reader in control.
///
/// A `target` of `UND` is the opposite case and returns false: there is no
/// language to translate INTO, so there is no work to offer. That is a caller
/// bug — the target is a field of the record and something failed to fill it —
/// and reporting «nothing to do» is better than starting a run with no target.
export function needsTranslation(book: BookLang, target: BookLang): boolean {
  const to = primary(target);
  if (!to || to === UND) return false;
  return primary(book) !== to;
}
