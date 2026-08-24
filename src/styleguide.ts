// The STYLE EDITOR's half of the second pass: the per-language style guide, the
// prompt that carries it, and the guardrails that decide whether a reply is an
// edit or a rewrite.
//
// The pass this file serves reads one already-translated paragraph and returns
// the same paragraph with its form repaired — agreement, cases, typos, spacing,
// register. It never sees the source text. That is the whole shape of the
// design (see «The unit of style editing» in the design notes): the draft
// model translates, this one proofreads, and a proofreader who cannot check a
// claim against the original must not be allowed to change one.
//
// WHY THIS IS NOT IN i18n.ts. Every string below is an instruction to a model
// and never a string the reader sees. t() interpolates and then runs macKeys()
// over the WHOLE result (i18n.ts:1300), so on macOS a paragraph containing
// «Ctrl+» or «Alt» would be rewritten to ⌘/⌥ on its way INTO the model —
// glossarygen.ts:239 records that exact bug, found after the old auxMessages
// pushed mined terms and their samples through t(). A prompt has no business in
// the reader's vocabulary, and the reader's vocabulary has no business in a
// prompt.
//
// WHY PER TARGET LANGUAGE AND NOT PER BOOK. What is in here is one language's
// grammar and register, and those do not vary from book to book. What does vary
// is terminology, and terminology already has a file the reader can edit, a
// documented grammar, a merge that never loses a line and a sidecar
// (glossary.ts). A second hand-edited artefact would need all of that again for
// a text that would be identical in every book.
//
// The module is pure: no IO, no fetch, no React, no i18n, no tauri, and nothing
// from translate.ts or booktranslate.ts. Its only import is textsim.ts, which is
// itself pure and already shared by App.tsx and the glossary clusterer. Several
// helpers below are DELIBERATE COPIES of code in modules this file must not
// depend on — estTokens and styleMargin from translate.ts, flatNum from
// booktranslate.ts; each says which twin it copies and what must change with it.
// The purity is also why the aux slot arrives as an ARGUMENT and is never read
// here: translate.ts owns the number, this module only spends it.

import { OUT_MATCH, outDice, outNorm } from "./textsim";

export type StyleLang = "ru" | "en";

/// One glossary line as the style pass needs it: the source term and the
/// rendering the book has settled on. Structurally the same pair translate.ts's
/// GlossaryEntry carries; it is redeclared rather than imported so this module
/// stays free of the translation engine.
export type StyleTerm = { src: string; dst: string };

/// The most terms a prompt will ever list. The caller sorts the book's glossary
/// by frequency and slices to this before calling, so the cut falls at the tail
/// of the list rather than at the end of the reader's editing order.
///
/// It is a bound on work, not on the prompt: the block that actually reaches
/// the model holds only the terms this paragraph uses (see buildStylePrompt),
/// which is 0–3 lines. 200 is where the scan stops costing a frame: with the
/// stem prefilter in `occurs`, a full 200-term list against a 1200-character
/// paragraph measures 5.2 ms on this machine — a third of a 60 Hz frame, and it
/// runs once per paragraph against a model spending tens of seconds on the same
/// one. (An earlier revision of this comment said 0.6 ms. That figure is not
/// reproducible here and is corrected to what was actually measured; the
/// measurement and its conditions are written out at `occurs` below.)
export const STYLE_TERM_CAP = 200;

// ---- the guides -------------------------------------------------------------
//
// Three rules of the eleven the plan started with are not here, and each
// deletion is load-bearing rather than an edit for length:
//
//   • «нечитаемые символы и мусор распознавания: лигатуры (ﬁ, ﬂ), одиночные
//     суррогаты, дефис от переноса строки». Those are an EXTRACTION defect and
//     they are fixed where they enter, at the single chokepoint in
//     paragraphs.ts:808, by a regex that costs microseconds — not by a 26B MoE
//     re-emitting the whole paragraph to do it. (This comment used to price that
//     MoE at 5 tok/s. The figure is refuted: with the draft model unloaded the
//     style model's experts all fit on this card, and the bandwidth-implied rate
//     is about 175 t/s. The argument never rested on the rate — a regex is
//     microseconds and a re-emitted paragraph is a whole generation pass — but a
//     wrong number is not left standing.) Worse, the guide
//     ordering the repair and rule «латиницу оставь букву в букву» ordering the
//     opposite were both true at once, and the Latin-token guardrail below
//     enforces the second: «deﬁnition» → «definition» loses the drafted token
//     and would be rejected as StyleReject "latin". The pass would have been
//     instructed to perform a repair it is structurally forbidden to perform.
//
//   • «кальки английского порядка слов и буквальные обороты». This is the one
//     instruction that licenses rewriting a sentence, and it sits beside «ты
//     правишь ФОРМУ, а не содержание». An editor with no original cannot tell a
//     calque from a faithful rendering of an unusual English construction; it
//     can only guess, and a guess here means substituting what it thinks the
//     author probably meant. A calque is a defect of the DRAFT, so it belongs to
//     the model that can see the source. The «drift» guardrail below is the
//     other half of that decision — the guide no longer asks for a paraphrase
//     and the gate no longer accepts one.
//
// One rule was ADDED that the plan did not have, and it is the one the reader
// actually complained about. HY-MT1.5 — a Chinese-centric model driven by
// Chinese-worded templates — leaks its native script mid-sentence in 10 of the
// 2961 translated paragraphs measured in the reader's store: «использует модель
// большого语言 моделя», «отсутствие任何 смысла», «можно構築омооморфизм», and a
// fullwidth comma in «Банксом и его коллегами [1999]， а также». The extraction
// sanitiser cannot reach those: they are not in the source, they are in the
// Russian already on disk, and the model swap only stops NEW ones. This pass is
// the only thing in the app that can repair the ones already written, so the
// guide names them and every guardrail below is checked against that repair
// rather than tripping over it.
//
// The four block headers are separate fields, not inlined into the guide,
// because buildStylePrompt has to assemble them in a fixed order and any drift
// between the two languages' shapes should be visible side by side here.

type Guide = {
  guide: string;
  termsHead: string;
  prevHead: string;
  draftHead: string;
};

const GUIDES: Record<StyleLang, Guide> = {
  ru: {
    guide:
      "Ты — редактор русского перевода книги. Тебе дают один абзац уже переведённого текста. " +
      "Оригинала перед тобой нет и не будет: ты правишь ФОРМУ, а не содержание.\n\n" +
      "Правь:\n" +
      "1. согласование, падежи, род и число; управление глаголов и предлогов;\n" +
      "2. опечатки, удвоенные и пропущенные буквы, слипшиеся и разорванные слова;\n" +
      "3. иероглифы и любые другие чужие письмена, «широкие» знаки препинания (，、：), " +
      "оставшиеся в русском тексте от прежнего переводчика: поставь на их место русское слово " +
      "или знак, которого требует фраза;\n" +
      "4. лишние и недостающие пробелы, двойные пробелы, пробел перед запятой и точкой;\n" +
      "5. регистр изложения: книга обращается к читателю на «вы» со строчной буквы, ровным и " +
      "неторопливым тоном, без разговорных частиц и без канцелярита.\n\n" +
      "Не трогай:\n" +
      "6. смысл, факты, выводы и порядок мыслей; не пересказывай фразу заново, даже если она " +
      "кажется тебе неуклюжей;\n" +
      "7. числа, формулы, единицы измерения, ссылки на страницы, главы и рисунки;\n" +
      "8. латиницу: имена, названия, обозначения, сокращения — оставь букву в букву;\n" +
      "9. термины из списка ниже — оставь их ровно в том написании, в каком они там стоят; " +
      "падеж и число менять можно, состав слова нельзя;\n" +
      "10. длину: абзац должен остаться примерно того же объёма. Ничего не сокращай, ничего не " +
      "дописывай, не добавляй пояснений и примеров.\n\n" +
      "Если абзац уже хорош, верни его без изменений.\n" +
      "Ответь ТОЛЬКО исправленным абзацем. Без заголовков, без кавычек, без комментариев.",
    termsHead: "\n\nТермины книги и их принятые в ней написания:\n",
    prevHead:
      "\n\nПредыдущий абзац (уже выправленный) — только для согласования, править и повторять " +
      "его не нужно:\n",
    draftHead: "\n\nАбзац:\n",
  },
  en: {
    guide:
      "You are the editor of an English translation of a book. You are given one paragraph of " +
      "already translated text. The original is not in front of you and never will be: you " +
      "correct FORM, not content.\n\n" +
      "Correct:\n" +
      "1. agreement and inflection; verb and preposition government;\n" +
      "2. typos, doubled and missing letters, words run together or broken apart;\n" +
      "3. Chinese characters and any other foreign script, fullwidth punctuation (，、：) left " +
      "in the English text by the previous translator: put in their place the English word or " +
      "mark the sentence calls for;\n" +
      "4. extra and missing spaces, double spaces, a space before a comma or a full stop;\n" +
      "5. register: the book addresses the reader directly, evenly and unhurriedly, with no " +
      "colloquial fillers and no officialese.\n\n" +
      "Leave alone:\n" +
      "6. meaning, facts, conclusions and the order of thought; do not retell a sentence from " +
      "scratch, however clumsy it looks to you;\n" +
      "7. numbers, formulas, units, references to pages, chapters and figures;\n" +
      "8. names, titles, symbols, abbreviations and identifiers — letter for letter;\n" +
      "9. the terms in the list below — keep them exactly as they are spelled there; " +
      "inflection may change, the make-up of the word may not;\n" +
      "10. the length: the paragraph must stay roughly the same size. Shorten nothing, add " +
      "nothing, supply no explanations and no examples.\n\n" +
      "If the paragraph is already good, return it unchanged.\n" +
      "Answer with the corrected paragraph ONLY. No headings, no quotation marks, no commentary.",
    termsHead: "\n\nThe book's terms and the renderings it uses:\n",
    prevHead:
      "\n\nThe previous paragraph (already edited) — for consistency only, it needs no " +
      "correction and must not be repeated:\n",
    draftHead: "\n\nParagraph:\n",
  },
};

/// Distinctive fragments of the guides above. A reply containing one of them is
/// the model reciting the instruction back instead of doing the work.
///
/// These are LITERAL SUBSTRINGS of the text above, and nothing checks that they
/// still are: change a guide and re-derive its markers in the same edit, or the
/// gate silently stops firing. glossarygen's `echo` arrays (glossarygen.ts:349,
/// :395) carry exactly this trap and the same warning.
///
/// Each one is also picked to be a phrase a translated technical paragraph will
/// not contain by accident — «Не трогай» and «Leave alone» are imperatives to a
/// second person that a monograph's prose does not use.
export const STYLE_ECHO: Record<StyleLang, readonly string[]> = {
  ru: ["ты правишь ФОРМУ", "Ответь ТОЛЬКО исправленным абзацем", "Не трогай:"],
  en: ["you correct FORM", "Answer with the corrected paragraph ONLY", "Leave alone:"],
};

// ---- term presence ----------------------------------------------------------
//
// Both the term block and the term guardrail have to answer one question: does
// this piece of Russian contain that term? The obvious answer — the literal
// word-boundary match translate.ts:344's termMatcher builds — is WRONG here, and
// wrong in the direction that destroys the feature.
//
// Rule 9 of the guide says «падеж и число менять можно», and fixing a case
// ending ON a glossary term is the single most likely good edit this pass will
// ever produce. A literal matcher rejects precisely that: «поиск по
// инвертированный индекс» → «поиск по инвертированному индексу» no longer
// contains the string «инвертированный индекс», so the guardrail would return
// "terms" for the best answer the model can give. With up to STYLE_TERM_CAP
// terms in play and Russian inflecting everything, that guardrail would reject
// the reader's number-one complaint by construction.
//
// So presence is measured the way the rest of the app measures «is this the same
// thing»: outNorm + outDice (textsim.ts:48, :55), character bigrams over a
// case-folded, punctuation-stripped string. It is script-agnostic by design and
// was calibrated on exactly this shape of question («нейронная сеть» /
// «нейронные сети», textsim.ts:19-22), which is why OUT_MATCH is reused rather
// than a private threshold invented here.
//
// THAT WAS ONLY HALF RIGHT, AND THE OTHER HALF REJECTED THE FEATURE. OUT_MATCH
// is a threshold for HEADINGS — strings of a dozen characters and up, where one
// changed ending moves a handful of bigrams out of thirty (textsim.ts:33-45 is
// that measurement, on 548 outline rows). On a four-letter term the ending is
// most of the word. Computed here with textsim's own outNorm/outDice:
//
//     узел / узла      0.333     узел / узлами     0.250
//     сеть / сети      0.667     движок / движка   0.600
//     вес  / весом     0.667     свёртка / свертка 0.667
//
// Every pair there is one term — correctly inflected, or in the last case spelled
// with and without ё — and every one of them sat below 0.75. Worse, none of them
// ever reached the coefficient at all: the stem prefilter took `t.slice(0, 4)`,
// and for a four-letter term the stem IS the whole word, so «узла» failed a
// substring test before Dice was consulted. The gate fired on precisely the
// repair the paragraph above says it exists to protect.
//
// The correction has three parts, and they only work together:
//
//   1. the prefilter stem shortens with the term — min(4, max(2, head - 2)) — so
//      a four-letter needle prefilters on two characters while anything from six
//      up still prefilters on four, exactly as before;
//   2. a short single-word needle gets its own floor, STYLE_TERM_SIM_SHORT. It
//      is 0.25 because «узлами» measures 0.250; the floor is the measurement,
//      not a round number picked for looks;
//   3. and because a floor that low would otherwise match half the paragraph, a
//      short needle additionally requires the candidate window to START with its
//      stem. Russian declension never touches the beginning of a word, so this
//      costs nothing real, and it is the whole reason the rejects below still
//      reject: «сеть»/«есть» is 0.333 and «вес»/«лес» is 0.500, both of which
//      clear 0.25 on the coefficient alone and are killed by the prefix.
//
// Re-derived table. `best` is the highest outDice any window of the text scores
// against the needle; `old` is this file before the fix, `new` is after it:
//
//   needle          text                              best   old  new
//   -- repairs that MUST survive ---------------------------------------
//   узел            у каждого узла есть вес          0.333    no  YES
//   узел            между узлами графа               0.250    no  YES
//   сеть            в сети признаков                 0.667    no  YES
//   движок          движка SPARQL                    0.600    no  YES
//   вес             с весом 0.5                      0.667    no  YES
//   поиск           поисковый индекс                 0.667    no  YES  derived
//   объём           объем выборки                    1.000    no  YES  ё-fold
//   свёртка         слой свертки                     0.833    no  YES  ё-fold
//   граф            вершины графа                    0.857   YES  YES
//   запрос          текст запроса                    0.909   YES  YES
//   полнота         оценка полноты                   0.833   YES  YES
//   инверт. индекс  …инвертированному индексу        0.818   YES  YES
//   BM25            оценка bm25 выше                 1.000   YES  YES
//   -- rewrites that MUST still be rejected -----------------------------
//   движок          SPARQL-мотор быстрее             0.000    no   no
//   узел            каждая вершина графа             0.000    no   no
//   поиск           информационное извлечение        0.000    no   no
//   нейронная сеть  нейросеть обучается              0.452    no   no
//   сеть            есть основания полагать          0.333    no   no
//   вес             лес решений                      0.500    no   no
//   узел            железо дороже                    0.250    no   no
//   полнота         точность и полезность            0.400    no   no
//   корпус          корень дерева                    0.400    no   no
//   индекс          индуктивный вывод                0.267    no   no
//   запрос          запоминание примеров             0.333    no   no
//   узел            узаконить порядок                0.182    no   no
//   Li              applications and quality lists   0.400    no   no
//   -- false accepts the fix buys, stated rather than hidden ------------
//   узел            узор из точек                    0.333    no  YES
//   узел            узнать заранее                   0.250    no  YES
//   вес             весна наступила                  0.667    no  YES
//   граф            график зависимости               0.750   YES  YES
//
// The last block is the price and it is worth naming exactly. «узел»/«узор» is
// not recoverable by any prefix rule: the fleeting vowel means «узел» and «узла»
// agree on two letters, and so do «узел» and «узор». What the prefix rule DOES
// guarantee is that every false accept is stem-adjacent — a word that starts the
// same way — and never an unrelated concept. That distinction is what makes the
// price payable in both places `occurs` is used:
//
//   • in acceptStyleEdit a false accept is a gate that did not fire, and length,
//     drift, digits and the Latin bag are all still standing behind it. A false
//     REJECT, which is what this section fixes, throws away a correct repair.
//   • in buildStylePrompt a false accept lists one extra `dst — src` line. That
//     is NOT the failure :445-457 documents at length: there the model was handed
//     200 renderings unconditionally and wrote «инвертированные списки» over «BOW
//     encodings» — a term with nothing in common with the text it displaced. A
//     stem-adjacent extra line cannot produce that, because the term and the word
//     that matched it already share their opening.
//
// Both ends of the length range are deliberately left OUT of the relaxation, and
// the ceiling is the interesting one.
//
// One and two characters keep the strict floor and no prefix rule, because there
// the stem is the word and a 0.25 floor would match anything: «Li» against
// «lists» is 0.400, and «Li» leaking into ordinary words is the exact defect
// translate.ts:344 and the note above were written against.
//
// The ceiling is at six, and it does NOT mean seven-character terms are all
// fine. Measured: «отрезок»/«отрезка» is 0.667 and «уровень»/«уровня» is 0.545,
// both correct inflections of a fleeting-vowel term, and both still rejected.
// What stops the ceiling from simply rising is that the prefix rule stops being
// a rule at that length: a four-character stem no longer pins down a seven-letter
// word, and «полнота» against «полнотекстовый» measures 0.526 — two unrelated IR
// terms that would start matching each other. Buying the seven-letter fleeting
// vowels needs a third condition the relaxation does not have, a bound on how
// much LONGER than the needle the window may be, and that is a bigger change
// than this defect asked for. It is written down here so the next person can
// weigh it instead of rediscovering it. Ordinary seven-character terms are
// unaffected: «полнота»/«полноты» 0.833, «полнота»/«полнотой» 0.769,
// «признак»/«признака» 0.923 all clear OUT_MATCH untouched.
const STYLE_TERM_SIM = OUT_MATCH;

/// A needle is «short» when it is a single word of TERM_SHORT_MIN…TERM_SHORT_MAX
/// characters — three to six. Six is the last length at which a four-character
/// stem still identifies the word, which is what makes the low floor safe there:
/// «движок»/«движка» is 0.600 and «движок»/«движками» 0.500, both admitted, while
/// «корпус» cannot reach «корень» because the stems differ at the fourth letter.
const TERM_SHORT_MIN = 3;
const TERM_SHORT_MAX = 6;
const STYLE_TERM_SIM_SHORT = 0.25;

/// ё → е, on both sides of every comparison in this section. outNorm has already
/// lower-cased, so only the lower-case letter can arrive here.
///
/// This is NOT the ё/е policy — that is YO_POLICY at the foot of this file, and
/// it is a decision about what the reader sees. This fold is a decision about what
/// the matcher may notice, and the two must not be confused. The matcher folds
/// because the policy exists: once a run has normalised «объём» to «объем» on
/// disk, a second style pass over the same book would compare a glossary term
/// still spelled «объём» against a draft spelled «объем» — 0.500 on the raw
/// coefficient, a rejection manufactured by our own normalisation. It also covers
/// the same thing happening inside a single pass, when the editor model
/// normalises ё on its own initiative: «свёртка»/«свертка» is 0.667 and would
/// have been a "terms" rejection of a paragraph that lost nothing at all.
function yoFold(s: string): string {
  return s.replace(/ё/g, "е");
}

/// A haystack prepared once per acceptStyleEdit/buildStylePrompt call: the
/// normalised text as one space-joined string, and the same text as words.
type Hay = { padded: string; words: string[] };

function hay(text: string): Hay {
  const words = yoFold(outNorm(text)).split(" ").filter(Boolean);
  // Padded with spaces at both ends so a ` word ` test is a word-boundary test.
  return { padded: ` ${words.join(" ")} `, words };
}

/// Does `h` contain `needle`, as a word and allowing for inflection?
///
/// The fast path is a literal whole-word test on the normalised strings. It is
/// the same boundary intent as translate.ts:344's termMatcher — the two-letter
/// term «Li» must not match inside «applications» or «quality», the defect that
/// once put «инвертированные списки» into 48% of the book's prompts — but it is
/// reached with padded spaces instead of a regex, because outNorm has already
/// reduced everything between words to a single space. It is a copy in spirit,
/// not in code, and translate.ts stays unimported.
///
/// The slow path slides a window of the term's word count, and of one word more,
/// and asks outDice. One word more, never one less: a case ending lengthens a
/// term, it does not merge two words into one.
///
/// For a short needle the floor drops and the window must additionally begin
/// with the needle's stem — the three-part correction the section header above
/// derives and tabulates. Everything from seven characters up behaves exactly as
/// it did before that correction.
function occurs(h: Hay, needle: string): boolean {
  const t = yoFold(outNorm(needle));
  if (!t) return false;
  if (h.padded.includes(` ${t} `)) return true;
  // Stem prefilter before the window scan. Russian inflects the END of a word,
  // so a term that is present in any form has its first few characters present
  // verbatim; a term that does not is not worth O(words) coefficients. Measured
  // here on a 1200-character paragraph against a full STYLE_TERM_CAP list of
  // real IR terms: 61.0 ms with the prefilter removed, 5.2 ms with it. That
  // matters not for the model's sake — it is spending tens of seconds on the
  // same paragraph — but because this runs on the UI thread between awaits, and
  // 61 ms of it is four dropped frames.
  //
  // The stem now SHRINKS for a short term: at four characters `t.slice(0, 4)` is
  // the whole word, which is what made «узла» unfindable. head - 2 leaves the two
  // characters no Russian ending can reach. Terms of six characters and up are
  // unaffected — min(4, …) still gives them the same four-character stem, so the
  // measurement above is the measurement of the code as it now stands.
  const space = t.indexOf(" ");
  const head = space === -1 ? t.length : space;
  const stem = t.slice(0, Math.min(4, Math.max(2, head - 2)));
  if (!h.padded.includes(stem)) return false;
  const short = space === -1 && head >= TERM_SHORT_MIN && head <= TERM_SHORT_MAX;
  const floor = short ? STYLE_TERM_SIM_SHORT : STYLE_TERM_SIM;
  const n = space === -1 ? 1 : t.split(" ").length;
  for (const span of [n, n + 1]) {
    for (let i = 0; i + span <= h.words.length; i++) {
      const w = h.words.slice(i, i + span).join(" ");
      // The prefix rule is what makes STYLE_TERM_SIM_SHORT safe; it is not an
      // optimisation and must not be moved into the prefilter, which only asks
      // whether the stem is SOMEWHERE in the paragraph.
      if (short && !w.startsWith(stem)) continue;
      if (outDice(t, w) >= floor) return true;
    }
  }
  return false;
}

// ---- one aux slot, and what one style edit may spend of it -------------------
//
// THIS SECTION IS NEW, AND IT CLOSES A HOLE THIS FILE DID NOT KNOW IT HAD.
// buildStylePrompt used to assemble whatever the paragraph brought with it and
// styleBudget used to be a pure function of the draft's character count. Neither
// had ever heard of a slot. The only clamp in the whole path was `auxBudget` in
// translate.ts, applied at the wire — and a clamp at the wire can only lower the
// REPLY, never the prompt, so the two of them together could ask a 4096-cell
// slot for considerably more than it has.
//
// llama-server does not hand a request the whole `-c`. The aux server is spawned
// `--parallel 4 -c 16384` and `-c` is the TOTAL arena divided across the slots —
// measured on this machine, where `--parallel 8 -c 24576` prints
// `n_slots = 8, n_ctx_slot = 3072, kv_unified = 'false'` — so one aux slot holds
// 4096 cells (`AuxState::CTX_PER_SLOT` in src-tauri/src/lib.rs is the
// authoritative copy; glossarygen.ts states the same pair for its own batches).
// THE WHOLE REQUEST lives in that: the guide, the term block, the previous
// paragraph, the paragraph itself AND every token of the reply.
//
// THE ARITHMETIC, worked for the ru guide at 4096 cells, which is the worst case
// because the Russian guide is the longer of the two and Russian tokenises at
// ~2.2 characters a token against English's ~4. Every figure below was measured
// with the estTokens copy in this file, over the guide strings as they stand:
//
//     one slot                                              4096 cells
//     − styleMargin(4096) = round(4096/10) + 64              474
//     = usable                                              3622
//
//     guide (1412 characters of Russian)                     582
//     draftHead                                                4
//     ── the parts that are NEVER cut, before the paragraph   586
//     termsHead + three term lines                            65
//     prevHead + 400 characters of Russian (PREV_MAX)        223
//     ── the optional parts, at their largest                 288
//
// A Russian draft of n characters costs about n/2.2 cells in the prompt, and the
// reply it wants is styleBudget's round(n/2) + 200. So the request is
// 874 + 0.955·n + 200 cells against 3622, and:
//
//   • up to n = 2668 everything fits with the full want. Nothing to do.
//   • past n = 2668 something has to give, and until this change NOTHING DID on
//     this side: the prompt kept growing and auxBudget quietly took the
//     difference out of the reply. At n = 3722 — the longest SOURCE paragraph
//     counted in the reader's 838-page store, whose Russian draft is longer
//     again — the prompt cost 2566 cells and auxBudget granted 1056 for a
//     paragraph that costs 1692 to echo back unchanged. The model was asked to
//     return the paragraph and given room for 62% of it.
//   • past n = 3339 the paragraph cannot be edited in a 4096-cell slot AT ALL:
//     the guide plus the paragraph plus a reply the same size as the paragraph
//     is already more than 3622, with the term block and the previous paragraph
//     both dropped.
//
// WHY THE TRUNCATION WAS INVISIBLE, which is the part that made this worth
// fixing rather than noting. A reply cut off mid-sentence is SHORTER than the
// draft, so it lands on acceptStyleEdit's length gate and is counted as
// "length" — a verdict that says the model rewrote the paragraph when what
// actually happened is that we never gave it room to copy one. The paragraph
// keeps its draft, the counter blames the model, and nothing anywhere says «this
// book has paragraphs the style pass cannot reach».
//
// HOW MUCH OF A BOOK THAT IS, stated rather than implied, because 2668 is a long
// way out: the reader's store has a mean paragraph of 565 characters and a p90
// of 1242, so the band this touches begins at roughly twice the p90 and it is a
// TAIL. It is worth the code anyway, and for two reasons that are not about the
// count. The paragraphs in that tail are the longest in the book, which is to
// say the multi-sentence ones carrying the most agreement and case errors — the
// defect this whole pass exists to repair. And the failure is the worst shape
// available: not an error, not a slow path, but a correct answer truncated and
// then blamed on the model, on exactly the paragraphs nobody would think to
// check.
//
// So the fix is in two halves and both are needed:
//
//   1. buildStylePrompt now spends the OPTIONAL blocks — the terms, then the
//      previous paragraph — out of what is left after the guide, the paragraph
//      and the reply the paragraph wants are paid for. It buys the band from
//      2668 to 2972 characters honestly, and below 2668 it changes nothing at
//      all, which matters for the prefix-cache argument on buildStylePrompt.
//   2. planStyleEdit prices the whole request and REFUSES the paragraph it
//      cannot serve, with a reason of its own — "budget" — so the caller counts
//      it beside the other refusals instead of the pass pretending it edited a
//      paragraph it truncated.
//
// The slot arrives as an argument and is never read here; see the module header.

/// One aux slot, in cells, for a caller that has no better number — the shipped
/// `--parallel 4 -c 16384`, i.e. `AuxState::CTX_PER_SLOT` in
/// src-tauri/src/lib.rs, which translate.ts also copies into its own FALLBACK
/// record for the milliseconds before `llama_slots` answers.
///
/// It is a DEFAULT and not the source of truth. A caller inside the app should
/// pass what the Rust side actually spawned, the way the draft path does; this
/// value is what stands in the `?test=` vite pane, where there is no Tauri IPC
/// at all, and in any caller that has not been given the accessor yet. Change it
/// in the same commit as `AuxState::CTX_PER_SLOT` and translate.ts's FALLBACK —
/// nothing will fail loudly if you do not, because a slot that is too large
/// overruns and a slot that is too small only clips.
export const STYLE_SLOT_FALLBACK = 4096;

/// Estimated tokens in a string. Budgeting only — never quote it as a count.
///
/// A DELIBERATE COPY of translate.ts's estTokens, divisors included: ~4
/// characters a token for ASCII through a Gemma vocabulary, ~2.2 for everything
/// wider. It is copied and not imported for the reason at the head of this file
/// — this module owns nothing and depends on neither engine module — and it must
/// change WITH its twin, because the two now price requests against the same
/// server. There is no tokenizer in the frontend and llama-server's /tokenize
/// would cost an aux slot and a round trip per paragraph on the very path this
/// budget exists to keep off the model's back.
const CHARS_PER_TOKEN_ASCII = 4;
const CHARS_PER_TOKEN_WIDE = 2.2;

function estTokens(s: string): number {
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / CHARS_PER_TOKEN_ASCII + (s.length - ascii) / CHARS_PER_TOKEN_WIDE);
}

/// The safety margin held back from every slot: a tenth of it, plus 64 cells.
/// The second DELIBERATE COPY, of translate.ts's ctxMargin, and it must be the
/// same formula rather than merely a similar one — auxBudget applies the twin to
/// this module's prompts at the wire, so a margin that disagreed would either
/// double-count (a reply cut twice) or leave a gap (a request sized against a
/// slot larger than the one auxBudget believes in).
///
/// What it pays for: estTokens is an average over prose and a paragraph of
/// formulas, surnames or URLs tokenises far worse; and the request also carries
/// what neither module sees — the turn markers llama-server's template adds and
/// whatever it rounds up for its own bookkeeping. At 4096 it reserves 474 cells.
const styleMargin = (slot: number) => Math.round(slot / 10) + 64;

/// The reply floor, and the same 256 translate.ts's REPLY_MIN carries, for the
/// same hard reason: `max_tokens` must stay positive, because llama-server reads
/// 0 as «generate nothing» and a negative as «unbounded». Below this the answer
/// is not «a short reply», it is a different request.
const REPLY_FLOOR = 256;

/// What the optional blocks may spend, as SHARES of one slot rather than as
/// character counts, so a spawn with a different CTX_PER_SLOT re-prices both at
/// once instead of overrunning a smaller slot or wasting a larger one. Each is
/// set to reproduce at the shipped 4096 exactly what it replaces — a
/// re-derivation of numbers already reviewed, not a re-tuning of them:
///
///   TERM_SHARE  0.05 → 205 cells. termsHead is 20 and a term line runs ~15, so
///               this is about twelve lines. The block the matcher normally
///               produces is 0–3 lines (see `occurs`), and the cap is here for
///               the pathological case that section names — a paragraph that
///               stem-matches a dozen short terms at once — not for the normal
///               one, which never comes near it.
///   PREV_SHARE  0.06 → 246 cells. prevHead is 41 and PREV_MAX = 400 characters
///               of Russian is 182, so 223: the whole previous-paragraph block
///               at its largest still fits inside its share at 4096, and the
///               share only bites when the paragraph itself has eaten the slot.
const TERM_SHARE = 0.05;
const PREV_SHARE = 0.06;

// ---- the prompt -------------------------------------------------------------

/// Clip the previous paragraph to its tail. What the current paragraph has to
/// agree with — the last sentence's tense, the form of address, the term just
/// used — is at the END of its predecessor, so the head is what goes. A clip
/// can land mid-word, which is noise in a context block, so the partial first
/// word goes with it.
///
/// TWO ceilings now, and PREV_MAX is the one that has not changed: 400
/// characters is what this block is WORTH, whatever room there happens to be,
/// because a paragraph agrees with the end of its predecessor and not with the
/// whole of it. `maxTok` is what there IS, and it only ever cuts further. The
/// character count to keep is estTokens run backwards over the string's own
/// measured density, so a Cyrillic tail is clipped harder than a Latin one of
/// the same length without either being told about the other — the same shape as
/// translate.ts's clipTail, and still deliberately not shared with it, for the
/// reason that function's own comment gives.
const PREV_MAX = 400;

function clipPrev(prev: string | undefined, maxTok: number): string {
  let t = (prev ?? "").trim();
  if (t.length > PREV_MAX) t = t.slice(-PREV_MAX).replace(/^\S*\s+/, "");
  if (maxTok <= 0) return "";
  const tok = estTokens(t);
  if (tok <= maxTok) return t;
  const keep = Math.max(1, Math.floor((t.length * maxTok) / tok));
  return t.slice(t.length - keep).replace(/^\S*\s+/, "");
}

/// The style prompt: [guide][terms][previous paragraph][draft], in that order,
/// with nothing before the guide.
///
/// The order is for llama-server's per-slot prefix cache. The guide is 1412
/// characters of Russian (1457 of English) — 582 estimated tokens at the ~2.2
/// characters a token this model gives Russian, 366 for the English guide at
/// ~4 — and it is byte-identical for every paragraph of a run, so with
/// cache_prompt on the server re-prefills only what follows it. That saving is
/// why the guide goes first and why nothing — not a page number, not a term
/// count — is ever prepended to it. The design note that planned this block said
/// ~450 tokens; the guide as written is longer, which makes the ordering matter
/// more rather than less. (This comment said «1471 of English» and «about 600
/// tokens»; both are replaced by what estTokens actually returns for the strings
/// above, because the slot arithmetic in the section before this one is built on
/// them and a rounded figure there is a rounded figure in a budget.)
///
/// THE TERM BLOCK IS DELIBERATELY NOT INVARIANT, and this reverses the plan's
/// «put the whole 200-term list first, byte-identical». It lists only the terms
/// this paragraph actually uses, which is translate.ts:329-341's matched()
/// semantics and its reasoning verbatim: prepending unmatched glossary entries
/// as authoritative instructions made the model write the prepended rendering
/// over unrelated text — «инвертированные списки» over «BOW encodings», over
/// «embeddings», over a variable name, and once in a loop until the paragraph
/// dissolved. Handing a 26B model 200 Russian renderings and telling it to keep
/// them, for a paragraph that mentions two, invites the same failure, and NONE
/// of the guardrails below can see it: a term substituted over a synonym leaves
/// the length, the digits, the Latin tokens and the alphabet share untouched.
/// A cache miss on the ~30 tokens of a two-line term block is not worth
/// re-opening a defect this codebase has a paragraph-long comment about.
///
/// A term is listed when either side of it occurs in the draft — the rendering,
/// so the model is told the form to keep, or the source term, because a Latin
/// term often survives verbatim into the Russian and the accepted rendering is
/// exactly what the editor should be looking at when it does.
///
/// THE ORDER OF SACRIFICE, which the slot section above derives. The guide, the
/// paragraph and the reply the paragraph wants are priced first and are never
/// cut; what is left is `extra`, and the optional blocks are spent out of it —
/// the terms first, the previous paragraph out of what the terms leave. Terms
/// first because the term block is the smaller of the two (0–3 lines, ~65 cells
/// against the previous paragraph's 223) and because it is about THIS paragraph,
/// while the previous paragraph is a consistency nicety that a long paragraph
/// needs least: a paragraph with 2500 characters of its own establishes its own
/// tense and its own form of address. The paragraph itself is never on the
/// table; when it alone will not fit, that is planStyleEdit's answer to give and
/// not a clip to make here.
///
/// `slot` defaults to STYLE_SLOT_FALLBACK so that a caller with no accessor
/// still gets the shipped arithmetic rather than none. Below n = 2668 characters
/// of Russian the budget never bites and the assembled prompt is byte-identical
/// to what this function produced before the slot existed — which is the point,
/// because a prompt that varied would cost the prefix cache the paragraph above
/// spends its whole argument on.
export function buildStylePrompt(
  draft: string,
  terms: readonly StyleTerm[],
  prevEdited: string | undefined,
  lang: StyleLang,
  slot: number = STYLE_SLOT_FALLBACK,
): string {
  const g = GUIDES[lang];
  // What is left of one slot once everything that is never cut is paid for.
  // styleBudget(draft) and not the granted budget: the prompt is being sized so
  // that the WANT survives intact, exactly as buildDraftPrompt sizes against
  // replyWant, and planStyleEdit is where the want answers back to the prompt
  // that actually came out.
  let extra =
    slot -
    styleMargin(slot) -
    styleBudget(draft) -
    estTokens(g.guide) -
    estTokens(g.draftHead) -
    estTokens(draft);

  // The scan is skipped outright when there is nothing to spend — it is the 5.2
  // ms `occurs` measurement, and paying it to build a block that cannot be
  // afforded is the one case where the cost is pure waste.
  let termBlock = "";
  if (extra > 0) {
    const h = hay(draft);
    // Sliced defensively as well as by the caller: the scan below is linear in
    // the list, and a caller that forgets the cap should get a slow prompt, not
    // a slow one that is also 200 lines long.
    const here = terms
      .slice(0, STYLE_TERM_CAP)
      .filter((t) => t.dst && (occurs(h, t.dst) || (!!t.src && occurs(h, t.src))));
    if (here.length) {
      const allow = Math.min(Math.round(slot * TERM_SHARE), extra);
      // GLOSSARY ORDER, not heaviest-first the way buildDraftPrompt cuts its
      // own term block. There the list is up to 40 lines and the cut is real, so
      // it is worth ordering by what a translator is likeliest to get wrong;
      // here it is 0–3 lines that always fit, the cut exists for a pathological
      // matcher only, and re-ordering would make the block — and therefore the
      // cached prefix — depend on the glossary's contents.
      const kept: StyleTerm[] = [];
      let cost = estTokens(g.termsHead);
      for (const t of here) {
        const c = estTokens(`${t.dst} — ${t.src}\n`);
        if (cost + c > allow) continue;
        cost += c;
        kept.push(t);
      }
      if (kept.length) {
        termBlock = g.termsHead + kept.map((t) => `${t.dst} — ${t.src}`).join("\n");
        extra -= estTokens(termBlock);
      }
    }
  }

  // The previous paragraph, out of whatever the terms left. Its header is paid
  // for before the text is clipped, so a budget that covers the header and two
  // words emits neither rather than a heading introducing nothing.
  let prevBlock = "";
  const prevAllow = Math.min(Math.round(slot * PREV_SHARE), extra) - estTokens(g.prevHead);
  if (prevAllow > 0) {
    const prev = clipPrev(prevEdited, prevAllow);
    if (prev) prevBlock = g.prevHead + prev;
  }

  return g.guide + termBlock + prevBlock + g.draftHead + draft;
}

/// Tokens the reply WANTS, before the slot has had its say — the same role
/// translate.ts's replyWant plays for the draft pass, and the same thing this
/// function has always returned when called with one argument.
///
/// Russian tokenises at roughly 2.2 characters a token (glossarygen.ts measures
/// the same ratio for the aux model), so half the draft's character count is
/// comfortably more than the draft itself costs, and +200 is the slack that
/// keeps a legitimately expanded sentence from being truncated into what looks
/// like a refusal.
///
/// The floor exists because a one-line heading still needs room for a preamble
/// the model was not asked for; the ceiling because nothing this pass may
/// legitimately produce is longer than the paragraph it was given, and an answer
/// that runs past 1800 tokens is a model that has started writing an essay. It
/// is a bound on a runaway answer, not a measurement.
///
/// THE CEILING IS NOW FLOORED AT THE DRAFT'S OWN COST, and that reverses nothing
/// in the sentence above — it repairs a case the sentence never considered. For
/// a draft costing more than 1800 cells (about 3960 characters of Russian) a
/// ceiling of 1800 does not bound a runaway: it guarantees that the paragraph
/// cannot even be returned unchanged, which the guide explicitly permits («если
/// абзац уже хорош, верни его без изменений»). A ceiling below the correct
/// answer is not a ceiling, so it rises to meet it and 1800 goes on bounding
/// every paragraph it can actually bound.
///
/// WITH `prompt` AND `slot` it is the second half of the budget, and the twin of
/// translate.ts's draftBudget: the want cut down to what the MEASURED prompt
/// leaves inside one slot. Called with one argument it is still only the want,
/// which is what the caller must not use on its own any more — that was the
/// defect the slot section above documents. planStyleEdit is the call that gets
/// both halves right; this signature stays three-way so the want is still
/// nameable, because auxBudget in translate.ts wants the want.
export function styleBudget(draft: string, prompt?: string, slot: number = STYLE_SLOT_FALLBACK): number {
  const want = Math.min(
    Math.max(1800, estTokens(draft)),
    Math.max(REPLY_FLOOR, Math.round(draft.length / 2) + 200),
  );
  if (prompt === undefined) return want;
  return Math.max(REPLY_FLOOR, Math.min(want, slot - styleMargin(slot) - estTokens(prompt)));
}

/// One paragraph priced against one aux slot: the prompt to send and the
/// `max_tokens` to send with it, or a refusal that can be counted.
///
/// THE REFUSAL IS THE POINT. A paragraph too long for its slot used to be sent
/// anyway, truncated by auxBudget, and refused downstream as "length" — a
/// verdict that blames the model for a request we sized wrong, and the only
/// trace it left in the book was a paragraph that quietly kept its draft. Here
/// the arithmetic is done before anything goes on the wire and the answer is
/// "budget", which is a member of StyleReject like any other, so a caller that
/// counts refusals counts this one too and the reader can be told that a book
/// has paragraphs this pass could not reach.
///
/// `need` is the honest minimum, and it is the DRAFT'S OWN cost rather than
/// REPLY_FLOOR: this pass returns the paragraph it was given, so a reply with
/// less room than the paragraph costs is truncated by construction, whatever the
/// model does. That is what makes the refusal a fact about the slot and not a
/// guess. (It is floored at REPLY_FLOOR only so the comparison agrees with the
/// one auxBudget will make at the wire.)
///
/// Nothing here throws and nothing here is a model fault — no request has been
/// made yet. A refusal is the same shape of outcome as a guardrail rejection:
/// the paragraph keeps its draft.
export type StylePlan = { ok: true; prompt: string; maxTokens: number } | { ok: false; why: "budget" };

export function planStyleEdit(
  draft: string,
  terms: readonly StyleTerm[],
  prevEdited: string | undefined,
  lang: StyleLang,
  slot: number = STYLE_SLOT_FALLBACK,
): StylePlan {
  const need = Math.max(REPLY_FLOOR, estTokens(draft));
  // Tested BEFORE the prompt is built, on the parts no budget can cut: if the
  // guide plus the paragraph plus a paragraph-sized reply is already over the
  // slot, no arrangement of the optional blocks rescues it, and the `occurs`
  // scan would be 5.2 ms spent on a paragraph that is not going to be sent.
  const g = GUIDES[lang];
  const bare = estTokens(g.guide) + estTokens(g.draftHead) + estTokens(draft);
  if (bare + need > slot - styleMargin(slot)) return { ok: false, why: "budget" };
  const prompt = buildStylePrompt(draft, terms, prevEdited, lang, slot);
  const maxTokens = styleBudget(draft, prompt, slot);
  // The same test again against what the prompt actually cost. It is not dead
  // code: `bare` assumes the optional blocks away, and this one is what holds if
  // a future block is added here or a share is widened. Belt and braces on the
  // one number that decides whether a paragraph is edited at all.
  if (maxTokens < need) return { ok: false, why: "budget" };
  return { ok: true, prompt, maxTokens };
}

// ---- the guardrails ---------------------------------------------------------

/// Why a paragraph kept its draft, in the order the pass decides them. The
/// caller counts these and shows the total kept; the individual reason is for
/// the dev console and for whoever next has to decide whether a gate is too
/// tight, so the order of the union is kept the order of the code.
///
/// "budget" is the odd one and it is FIRST because it is decided first: it is
/// not a verdict on a reply at all but planStyleEdit's answer that the paragraph
/// does not fit an aux slot, reached before any request is made. It is in this
/// union rather than in one of its own so that a caller keeps ONE counter — the
/// reader's question is «how many paragraphs did the pass leave alone», and a
/// paragraph too long to send is left alone exactly as squarely as one whose
/// reply drifted. acceptStyleEdit never returns it.
export type StyleReject =
  | "budget"
  | "empty"
  | "echo"
  | "length"
  | "alphabet"
  | "drift"
  | "terms"
  | "digits"
  | "latin";

export type StyleVerdict = { ok: true; text: string } | { ok: false; why: StyleReject };

/// A preamble the model was not asked for, on its own line: «Вот исправленный
/// абзац:», «Here is the corrected paragraph:». Stripped rather than rejected —
/// the paragraph underneath is usually a perfectly good edit, and throwing it
/// away costs the reader a repair to save us a `replace`.
///
/// Anchored at the start and required to end the line, so a sentence of real
/// prose that happens to begin with «Вот» and contain a colon is not eaten. The
/// 60-character bound is the same idea: a preamble is short.
const PREAMBLE = /^\s*(?:вот|исправленн|отредактирован|here is|corrected|edited)[^\n]{0,60}:[ \t]*(?:\n|$)/i;

/// Quote pairs a model wraps a whole answer in. Only stripped when the pair
/// covers the entire reply and the closing mark occurs nowhere inside it, so a
/// paragraph that legitimately quotes something keeps its quotation marks.
const WRAPS: readonly (readonly [string, string])[] = [
  ["«", "»"],
  ["“", "”"],
  ['"', '"'],
];

function unwrap(raw: string): string {
  let t = raw.replace(PREAMBLE, "").trim();
  for (const [open, close] of WRAPS) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close) && !t.slice(1, -1).includes(close)) {
      t = t.slice(1, -1).trim();
      break;
    }
  }
  return t;
}

/// Digit-group flattening, copied from booktranslate.ts:607's flatNum. It is a
/// copy and not an import because that module owns the store, the wire and the
/// worker pool, and this one owns nothing; the four passes and the space class
/// must change together with their twin.
///
/// One thing is added that flatNum does not need: fullwidth digits are folded
/// to ASCII. flatNum compares a source against its translation, where fullwidth
/// digits are somebody else's problem; here we compare a draft against an edit
/// that was explicitly ASKED to remove fullwidth characters (guide rule 3), and
/// without the fold that repair would change the digit multiset and be rejected
/// by the very next line.
function flatNum(s: string): string {
  let t = s
    .replace(/[\u00A0\u202F\u2009]/g, " ") // nbsp / narrow nbsp / thin space
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  for (let i = 0; i < 4; i++) t = t.replace(/(\d)[ ,]+(\d{3})(?!\d)/g, "$1$2");
  return t;
}

const digitBag = (s: string): string => (flatNum(s).match(/\d+/g) ?? []).sort().join(" ");

/// Latin runs, for the token gate. The trailing punctuation class is stripped
/// after matching: «BM25.» at the end of a sentence and «BM25» in the middle of
/// one are the same identifier, and a gate written to catch a DROPPED name must
/// not fire because the name moved past a full stop.
const LATIN_TOK = /[A-Za-z][A-Za-z0-9.+#-]*/g;

/// A token that is an IDENTIFIER rather than an ordinary word: it carries a
/// digit, an interior capital, or one of the symbol characters. BM25, SPARQL,
/// PageRank, F1-score, e.g. — yes; «consider», «The» — no.
const LOOKS_ID = /\d|.[A-Z]|[.+#-]/;

/// The Latin bag depends on the TARGET LANGUAGE, and that asymmetry is not a
/// nicety. In a Russian text every Latin run is a name, a symbol or an
/// abbreviation, so all of them are guarded — that is guide rule 8 exactly. In
/// an English text every ordinary word is a Latin run too, and rule 1 asks the
/// editor to fix inflection: «We considers» → «We consider» drops the token
/// «considers» and the unrestricted gate would reject the single most ordinary
/// good edit the English pass can make. This is the same trap the ligature rule
/// was deleted for at the head of this file, and it is closed the same way —
/// the gate is narrowed to what it was actually written to protect.
///
/// The stated cost: an English proper noun with no interior capital and no
/// digit («Banks») is not guarded, because nothing distinguishes it from a
/// sentence-initial ordinary word. Drift and the digit multiset are what stand
/// behind it there.
function latinBag(s: string, lang: StyleLang): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of s.match(LATIN_TOK) ?? []) {
    if (lang === "en" && !LOOKS_ID.test(m)) continue;
    const tok = m.replace(/[.+#-]+$/, "").toLowerCase();
    if (tok.length >= 2) out.set(tok, (out.get(tok) ?? 0) + 1);
  }
  return out;
}

/// Share of the target language's own script among the letters of a string.
/// Text with no letters at all counts as fully in-script — a paragraph of pure
/// formula has nothing for this gate to say anything about.
const SCRIPT: Record<StyleLang, RegExp> = { ru: /[А-Яа-яЁё]/g, en: /[A-Za-z]/g };

function scriptShare(s: string, lang: StyleLang): number {
  const letters = s.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return 1;
  return (s.match(SCRIPT[lang])?.length ?? 0) / letters;
}

// Length. An editor fixing agreement moves a paragraph's length by a few
// percent; a quarter of it gone means the model summarised, a third added means
// it explained. The band is wider for a short block because one repaired word
// is a large fraction of a heading and a small one of a paragraph.
const LEN_LONG = 80; // chars — above this a paragraph is prose, not a heading
const LEN_LONG_LO = 0.75;
const LEN_LONG_HI = 1.3;
const LEN_SHORT_LO = 0.55;
const LEN_SHORT_HI = 1.9;

// Drift — the only gate here that looks at MEANING rather than shape, and the
// reason the guide no longer licenses fixing calques.
//
// Every other check in this file is a surface invariant: a content rewrite that
// keeps the length inside the band, keeps the numbers, keeps the Latin tokens
// and keeps the Cyrillic share passes all of them untouched. That is not a
// hypothetical shape — it is the most probable output of a large instruct model
// handed a paragraph and told to make it read better. Bigram overlap against
// the draft separates the two cleanly, because a spelling repair moves a few
// bigrams and a paraphrase moves most of them. Measured over hand-written pairs
// built from the design evidence:
//
//     case + agreement fixes, 215-char paragraph            0.905   accept
//     two typos fixed, 62-char sentence                     0.951   accept
//     «большого语言 моделя» → «большую языковую модель»      0.627   accept (short)
//     «отсутствие任何 смысла» → «отсутствие всякого смысла»  0.875   accept
//     ты → вы plus one repair, 66-char sentence             0.723   accept (short)
//     same paragraph paraphrased at the same length         0.606   reject
//     paragraph replaced by its one-sentence summary        0.535   reject
//
// The two floors follow from that table and from arithmetic: a repair that
// touches k characters of an n-character paragraph moves the coefficient by
// roughly 2k/n, so the same honest repair reads as drift on a short block. The
// short floor is deliberately permissive — a 60-character block has little to
// lose and the CJK repairs, which are the whole point of this pass on the
// reader's existing store, live there. Above the boundary the floor is strict,
// and the 125-character paraphrase above is on the strict side of it.
//
// These are bounds, not measurements: seven hand-written pairs are evidence
// that the gate separates the two classes at all, not a calibration corpus. The
// trade is stated on purpose — a false positive costs one unimproved paragraph
// (the pass keeps the draft), a false negative costs the reader a sentence the
// model invented. The numbers sit on the safe side of that.
const DRIFT_SHORT = 120; // chars
const DRIFT_MIN = 0.8;
const DRIFT_MIN_SHORT = 0.6;

// A wrong-alphabet answer is the model translating instead of editing. The
// floor is relative, not absolute, because a paragraph that is half formula and
// half English identifiers is legitimately low in Cyrillic; only LOSING script
// share is a defect. The 0.05 slack lets a repair that replaces a Cyrillic word
// with a Latin identifier the draft already contained through.
//
// This is also the gate that must NOT fire on the repair the guide asks for:
// replacing 语言 with «языковой» RAISES the Cyrillic share, and the floor is
// one-sided.
const SCRIPT_SLACK = 0.05;

/// Is this reply an edit of the draft, or something else wearing its clothes?
///
/// The order is cheapest and most conclusive first, so the rejection reason the
/// caller counts names the actual failure rather than a symptom of it. Nothing
/// here throws and nothing here repairs beyond the preamble and the wrapping
/// quotes: a reply is either usable as it stands or the caller keeps the draft.
export function acceptStyleEdit(
  draft: string,
  raw: string,
  terms: readonly StyleTerm[],
  lang: StyleLang,
): StyleVerdict {
  const out = unwrap(raw);
  if (!out) return { ok: false, why: "empty" };
  // An empty draft has no ratio and nothing to preserve; the caller filters
  // these out, and if one arrives anyway there is no edit to accept.
  if (!draft.trim()) return { ok: false, why: "empty" };
  for (const marker of STYLE_ECHO[lang]) if (out.includes(marker)) return { ok: false, why: "echo" };

  const r = out.length / draft.length;
  const long = draft.length >= LEN_LONG;
  if (long && (r < LEN_LONG_LO || r > LEN_LONG_HI)) return { ok: false, why: "length" };
  if (!long && (r < LEN_SHORT_LO || r > LEN_SHORT_HI)) return { ok: false, why: "length" };

  // Alphabet before drift, deliberately: a reply that translated the paragraph
  // instead of editing it fails BOTH, and "alphabet" is the diagnosis while
  // "drift" would only be the symptom. The counter the panel shows is the only
  // thing anybody will ever see of these verdicts, so it should name the cause.
  if (scriptShare(out, lang) < scriptShare(draft, lang) - SCRIPT_SLACK) {
    return { ok: false, why: "alphabet" };
  }

  const floor = draft.length >= DRIFT_SHORT ? DRIFT_MIN : DRIFT_MIN_SHORT;
  if (outDice(outNorm(draft), outNorm(out)) < floor) return { ok: false, why: "drift" };

  // Terms: every rendering the DRAFT uses must still be recognisable in the
  // edit. Inflected, not literal — see the note on `occurs`. Only the terms
  // actually present are checked, which is 0–3 of them, so the fuzzy scan runs
  // over a handful of needles and not the whole cap.
  const hDraft = hay(draft);
  const hOut = hay(out);
  for (const t of terms.slice(0, STYLE_TERM_CAP)) {
    if (!t.dst || !occurs(hDraft, t.dst)) continue;
    if (!occurs(hOut, t.dst)) return { ok: false, why: "terms" };
  }

  // Digits: the multiset, not the order. A model that renumbers a list, invents
  // a year or drops a page reference fails here, and this is the one gate with
  // no tolerance at all — there is no legitimate reason for a form edit to
  // change a number.
  if (digitBag(draft) !== digitBag(out)) return { ok: false, why: "digits" };

  // Latin tokens: losing one is a defect, gaining one is allowed. Gaining
  // covers the legitimate case of a repair that spells out a name the draft
  // mangled; losing covers «BM25» quietly translated, transliterated or
  // dropped. Case-insensitive, because capitalising a term the edit moved to
  // the start of a sentence is a typographic fix and not the failure this gate
  // was written against.
  const lDraft = latinBag(draft, lang);
  const lOut = latinBag(out, lang);
  for (const [tok, n] of lDraft) if ((lOut.get(tok) ?? 0) < n) return { ok: false, why: "latin" };

  return { ok: true, text: out };
}

// ---- ё and е ----------------------------------------------------------------
//
// The reader's own store, scanned 2026-08-22, has ё and е spelled differently in
// adjacent paragraphs of the same 838-page monograph. That is the last of the
// defects the design evidence names, and it is the only one that is not a
// mistake in any single paragraph: «ещё» is right and «еще» is right, and a book
// that uses both is wrong.
//
// WHY THIS IS NOT A GUIDE RULE. Rule 2 («опечатки, удвоенные и пропущенные
// буквы») is not read by a Russian editor as an instruction to normalise ё, and
// adding a rule that says so would not fix it either: a 26B model deciding the
// question per paragraph, with no memory of the previous 9602, would be
// inconsistent between paragraphs — which is the defect, not the cure. A
// house style is a property of the BOOK, so it is applied to the book by code
// that sees every paragraph, deterministically, and identically on a re-run.
//
// THE POLICY, and why this one. Russian technical publishing sets ё selectively:
// е everywhere, ё only where a reader could otherwise take the word for a
// different word. That is what this does — a fold to е with a six-word exception
// list. It is not «unconditional ё»: restoring ё means deciding which е was one,
// which is a judgement about meaning made without the original in view, the
// single thing this whole pass is built not to do, and the reader's book is set
// in е to begin with.
//
// WHY THE EXCEPTION LIST IS SIX WORDS. Every word on it is a word left
// inconsistent between paragraphs, which is the defect being fixed, so the list
// pays for itself only where a reader would actually be misled. Real Russian
// homographs that are NOT on it, and why: «чём»/«чем» — always after a
// preposition, which disambiguates it; «нёбо»/«небо», «осёл»/«осел»,
// «падёж»/«падеж» — cannot occur in this register; «совершённый»/«совершенный»
// — inflects, so the list would have to carry a paradigm rather than a word, and
// «совершенный вид» is written with е anyway. «ещё», «её», «идёт», «приведён»
// and the rest of the frequent ё-words have no homograph at all and are folded.
//
// PROPER NAMES ARE FOLDED TOO, and that decision was taken twice. The first
// version of this section exempted capitalised words, so that «Гёдель» and
// «Шрёдингер» kept their ё. It was removed, because the exemption cannot be made
// whole: at the head of a sentence a capital is compulsory, so «Гёдель» and «Ещё»
// are the same string shape and no rule separates them. Whichever way that tie is
// broken the pass MANUFACTURES an inconsistency — either «Гедель» opening a
// sentence against «Гёделя» inside one, or «Ещё» opening a sentence against «еще»
// inside one. A policy whose entire job is consistency must not contain a branch
// that produces inconsistency, so the branch went.
//
// What that costs is small and worth stating: in ё-less Russian orthography
// transliterated names ARE written without ё — «Гедель», «Шредингер»,
// «Кенигсберг» are ordinary renderings, not errors — so the fold agrees with the
// convention it is implementing. Guide rule 8 is untouched: it protects LATIN
// names letter for letter, and no Latin name contains ё. The one class that reads
// oddly folded is a name whose ё-less form is not current in Russian at all
// («Эрдёш» → «Эрдеш»); that is accepted, and it is a name the reader can see and
// judge, not a meaning silently changed.
export type YoPolicy = "selective" | "none";

/// ru: fold ё to е except where ё is load-bearing. en: nothing to do — the
/// letter does not exist there, and applyYoPolicy is a no-op for it rather than
/// an error, so a caller can call it unconditionally for whatever target
/// language the book is in.
export const YO_POLICY: Record<StyleLang, YoPolicy> = {
  ru: "selective",
  en: "none",
};

/// Words where ё is the only thing separating two different Russian words.
/// «всё»/«все» and «всём»/«всем»; and the -знавать present tense, where the
/// ё-less form is the perfective future of the other verb: узнаём (узнавать) /
/// узнаем (узнать), and the same for признавать, сознавать, осознавать. That
/// collision is specific to -знавать — «отдаём» looks like a twin of it and is
/// not one, because the future of «отдать» is «отдадим» and «отдаем» is no word
/// at all. Keys are lower-case; the lookup folds case, so «Всё» at the head of a
/// sentence keeps its ё too.
const YO_KEEP: ReadonlySet<string> = new Set(["всё", "всём", "узнаём", "признаём", "сознаём", "осознаём"]);

/// A whole word carrying ё, hyphenated compounds included so that «всё-таки» —
/// which has no homograph, and so is not on the list — is judged as itself and
/// folded whole, rather than having a «всё» inside it matched against the list.
const YO_WORD = /[\p{L}-]*[ёЁ][\p{L}-]*/gu;

/// Apply the target language's ё/е policy to one finished paragraph.
///
/// Called by booktranslate.ts's style worker on the ACCEPTED text, immediately
/// before it is stored, so that the whole book comes out of a run in one spelling
/// and a re-run produces byte-identical output. It runs after acceptStyleEdit and
/// never before it: the guardrails compare the model's reply against the draft,
/// and a draft the caller had already rewritten is not the text the model was
/// given. `occurs` folds ё on both sides (see yoFold above), so the term gate
/// cannot be tripped by this pass's own output on a later run.
///
/// FOR THE CALLER, and it is not this module's decision to make: a paragraph
/// whose edit the guardrails REFUSED keeps its draft, and a draft this function
/// never sees keeps whatever spelling the draft model chose. If the whole book is
/// to come out consistent — which is the point — the policy has to be applied to
/// the kept draft as well as to the accepted edit, not only on the ok branch.
///
/// Pure and idempotent — applyYoPolicy(applyYoPolicy(x)) === applyYoPolicy(x) —
/// and it depends on nothing but the word in front of it, so the same word gets
/// the same answer on page 3 and on page 803. That is the whole point: the defect
/// is not a wrong spelling, it is two spellings.
export function applyYoPolicy(text: string, lang: StyleLang): string {
  if (YO_POLICY[lang] !== "selective") return text;
  return text.replace(YO_WORD, (w: string) =>
    YO_KEEP.has(w.toLowerCase()) ? w : w.replace(/ё/g, "е").replace(/Ё/g, "Е"),
  );
}
