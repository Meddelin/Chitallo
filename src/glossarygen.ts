// Automatic glossary generation for a whole book.
//   extractTerms: pure-statistical term mining — word n-grams (n=1..4) inside
//     sentence/clause bounds over ALL pages (statistics have no context limit),
//     C-value scoring for multiword terms (freq × log2(n) with nested-occurrence
//     discounting à la Frantzi), acronym/proper-noun rules for unigrams.
//   translateTerms: the local HY-MT model translates only the mined list —
//     each term as the segment, its first-occurrence sentence as the context
//     for the model-card contextual template (translate.ts buildPrompt).
//   mergeGlossary: appends only genuinely new terms; every existing user line
//     survives byte-for-byte (idempotent re-runs).

import type { PDFDocumentProxy } from "pdfjs-dist";
import { clusterParagraphs } from "./paragraphs";
import { translate } from "./translate";

export type ExtractedTerm = { term: string; freq: number; sample: string };
export type TermPair = { term: string; tr: string };

const MIN_FREQ = 5; // global minimum for multiword candidates (and acronyms)
const MIN_CAP_FREQ = 8; // capitalized-in-running-text unigrams
const MAX_N = 4;
const DEFAULT_CAP = 120;
const PASS2_MULTI = 500; // multiword candidates carried into the form/sample pass
const CONCURRENCY = 3; // llama-server n_slots=4 — keep one slot interactive

// ---- stoplists --------------------------------------------------------------

// Function/junk words: multiword candidates must not START or END with these,
// and they are never unigram terms. Interior stopwords are allowed ("bag of
// words"). Includes doc-structure words (figure/section/…) that only ever
// produce junk candidates.
const FUNC_STOP = new Set(
  `a an the and or but nor so yet not no of in on at by for with about against between into through during
  before after above below to from up down out off over under again further then once here there when where
  why how all any both each few many much more most other others some such only own same as than too very
  just ever never also always often can cannot could may might must shall should will would ought do does did
  done doing is are am was were be been being have has had having i you he she it we they me him her us them
  my your his its our their mine yours ours theirs this that these those who whom whose which what if because
  until while unless since although though whereas whether however therefore thus hence moreover furthermore
  nevertheless meanwhile otherwise instead indeed rather quite almost already still yes etc via per among
  amongst along across behind beyond despite except toward towards upon onto within without whenever wherever
  whatever whichever anything something nothing everything anyone someone everyone nobody none one two three
  four five six seven eight nine ten zero first second third fourth fifth last next new old let et al vs
  versus based using given giving following followed shown seen called known named use used uses see sees say
  says said like well need needs make makes made take takes taken show shows want wants section sections
  chapter chapters figure figures table tables page pages example examples equation equations exercise
  exercises note notes doi org www http https com html htm pp vol eds arxiv`
    .split(/\s+/)
    .filter(Boolean),
);

// Compact common-English stoplist (content words): blocks ordinary words from
// slipping in as capitalized "proper-noun" unigrams (This, However, Figure…).
// Only consulted for the capitalized-unigram rule — multiword candidates and
// acronyms are unaffected, so domain terms like "inverted index" or BM25 pass.
const COMMON_EN = new Set(
  `about above absolute abstract academic accept access accord account accuracy accurate achieve across act
  action active actual actually add addition additional address adopt advance advantage affect age agent ago
  agree ahead aim air algorithm all allow almost alone along already also although always american among
  amount analysis analyze annual another answer any anyone anything appear appendix application apply
  approach appropriate approximate area argue argument around arrive art article ask aspect assess associate
  assume assumption attempt attention author available average avoid aware away
  back background bad balance base basic basis bear beautiful become begin beginning behavior behind believe
  below benefit best better big bit black block blue board body book both bottom box boy break brief briefly
  bring british broad brother build burn business buy
  calculate call capital car card care careful carry case catch category cause cell center central century
  certain certainly chain challenge chance change chapter character characteristic charge cheap check chief
  child choice choose citizen city claim class classic clear clearly clock close code cold college color
  column combination combine come comment commercial common community company compare comparison complete
  complex component compute computer concept concern conclusion condition conduct conference confirm connect
  connection consequence consider consist constant construct contain contemporary content context continue
  contrast contribute contribution control conventional copy core corner correct correspond cost could count
  country couple course cover create criterion critical cross cultural culture current currently curve
  customer cut
  daily damage danger dark data date daughter day deal debate decade decide decision deep define definition
  degree deliver demand demonstrate department depend derive describe description design desire despite
  detail detailed determine develop development device devote difference different difficult difficulty
  dimension direct direction directly discover discuss discussion display distance distinguish distribute
  distribution divide document dog dollar domain door double doubt down draft draw drive drop dry due dust
  duty
  each early earth easily easy eat economic economy edge edition editor education effect effective
  effectively effort eight either element eleven else elsewhere emerge emphasis employ enable encourage end
  energy english enjoy enough ensure enter entire entirely entry environment equal equally equation
  equivalent error especially essential establish estimate evaluate evaluation even evening event eventually
  ever every everybody everyone everything evidence exact exactly examine example excellent except exception
  exercise exhibit exist existence expect experience experiment experimental expert explain explanation
  explore express expression extend extension extensive extent external extra extreme extremely eye
  face facility fact factor fail failure fair fairly fall familiar family famous far fast father favor
  feature federal feed feel fellow female few field fifth fifty figure file fill final finally financial
  find finding fine finger finish fire firm first fish fit five fix flat floor flow fly focus follow food
  foot force foreign forget form formal format former formula forward found foundation four fourth frame
  framework free frequent frequently fresh friend front full fully function fundamental further future
  gain game gap garden gas gather general generally generate gentle get girl give glass global go goal good
  govern government grade gradually grand great green ground group grow growth guarantee guess guide
  half hand handle hang happen happy hard hardly have head health hear heart heat heavy height hence high
  highly hill historical history hit hold hole home hope horse hospital hot hotel hour house huge human
  hundred husband hypothesis
  idea ideal identify illustrate image imagine immediate immediately impact implement implementation
  implication imply importance important impose impossible improve improvement include increase increasingly
  indeed independent index indicate individual industrial industry influence inform information initial
  initially input inside instance instead institute institution intend interest interesting internal
  international internet interpret interpretation introduce introduction investigate involve issue item
  job join joint journal judge just keep key kind king knowledge lab label lack land language large largely
  late later latter law lay lead leader learn learning least leave lecture left leg legal length less lesson
  let letter level library lie life light like likely limit limitation limited line link list literature
  little live local locate location logic long look lose loss lot loud love low lower
  machine main mainly maintain major majority make male man manage management manner many map mark market
  mass master match material mathematical matter maximum may maybe mean meaning means measure mechanism
  media medium meet meeting member memory mention mere merely message method middle might mile milk million
  mind mine minimum minor minute miss mission mistake mix mode model modern moment money month more moreover
  morning most mostly mother motion mountain mouth move movement much multiple music must
  name narrow nation national natural naturally nature near nearly necessarily necessary need negative
  neighborhood network never nevertheless new news next nice night nine node noise normal normally north
  notation note nothing notice notion novel now nowhere number numerous
  object objective observation observe obtain obvious obviously occasion occur ocean offer office official
  often oil okay old once one online only onto open operate operation opinion opportunity option order
  ordinary organization organize origin original originally other otherwise ought outcome output outside
  over overall overview own
  page pain paint pair paper paragraph parallel parent park part partial particular particularly partly
  partner party pass past path pattern pay peace people per percent percentage perfect perform performance
  perhaps period person personal perspective phase phenomenon philosophy phrase physical pick picture piece
  place plan plane plant play please plot point policy political poor popular population position positive
  possibility possible possibly potential power powerful practical practice precise precisely predict
  prefer preparation prepare presence present press pressure pretty prevent previous previously price
  primarily primary principle print prior private probably problem procedure proceed process produce product
  production professional professor program progress project promise proof proper properly property
  proportion propose protect prove provide public publication publish pull purpose push put
  quality quantity quarter quick quickly quiet quite
  radio raise random range rapid rapidly rare rarely rate rather ratio raw reach reaction read reader
  reading ready real reality realize really reason reasonable recall receive recent recently recognize
  record red reduce reduction refer reference reflect regard region regular regularly relate relation
  relationship relative relatively release relevant remain remark remember remove repeat replace reply
  report represent representation request require requirement research resource respect respond response
  rest restrict result return reveal reverse review revise rich right rise risk road role roll room rough
  roughly round row rule run
  safe same sample satisfy save scale scenario schedule scheme school science scientific screen sea season
  seat second secondary section see seek seem select selection sell send sense sentence separate sequence
  series serious seriously serve service session set setting settle seven several shape share sharp shift
  ship short shot should show side sign signal significant significantly similar similarly simple simply
  since single sister site situation six size skill sleep slight slightly slow slowly small smooth social
  society soft software solution solve some somebody somehow someone something sometimes somewhat somewhere
  son soon sort sound source south space speak special specific specifically specify speech speed spend
  spirit split sport spread spring square stage stand standard star start state statement station
  statistical status stay step still stock stop store story straight strange strategy street strength
  stress strong strongly structure student study stuff style subject substantial succeed success successful
  such sudden suffer sufficient suggest suggestion suitable sum summary summer sun supply support suppose
  sure surface surprise survey symbol system
  table take talk target task teach teacher team technical technique technology tell temperature tend term
  test text than thank theme then theoretical theory there thereby thing think third thirty thousand threat
  three through throughout throw thus time tiny title today together tomorrow tone tool top topic total
  totally touch tough toward town track trade tradition traditional train training transfer transform
  translate travel treat treatment tree trend trial trip trouble true truly trust truth try turn twelve
  twenty twice two type typical typically
  ultimately under understand understanding unfortunately uniform union unique unit universal university
  unknown unless unlike unlikely until upper upon usage use useful user usual usually
  valid value variable variation variety various vary vast vehicle version vertical very view visit visual
  vital voice volume
  wait walk wall want war warm watch water wave way weak wear weather web week weekend weight welcome west
  western what whatever when whenever where wherever whole whose wide widely width wife wild will win window
  winter wish woman wonder word work worker working world worry worth would write writer writing wrong
  yeah year yellow yes yesterday yet young`
    .split(/\s+/)
    .filter(Boolean),
);

// ---- text preparation -------------------------------------------------------

// lookbehind: never start a token mid-word — "38th" must not yield "th"
const TOKEN_RE = /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:['’-][A-Za-z0-9]+)*/g;
const CHUNK_SEP = /[,;:()[\]{}<>"“”«»|/\\]+/;
const SENT_SPLIT = /(?<=[.!?…][")\]»”’]*)\s+(?=[A-ZА-ЯЁ0-9«"“([])/;

type Sent = { raw: string; chunks: string[][] };

// citation-density page filter: reference lists (years, DOIs, URLs on nearly
// every line) would otherwise flood the statistics with venue names and author
// surnames. Pages with many such markers are bibliographies — skipped whole.
const CITE_MARK = /\b(?:19|20)\d\d[a-z]?\b|\bdoi\b|https?:|\barxiv\b|\bwww\b/gi;
const CITE_PAGE_MIN = 8; // running prose rarely has ≥8 markers on one page

// yield to the event loop without setTimeout — hidden-tab timer throttling
// would otherwise clamp every yield to ~1s
function tick(): Promise<void> {
  return new Promise((res) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => res();
    ch.port2.postMessage(0);
  });
}

function abortErr(): never {
  throw new DOMException("glossary generation aborted", "AbortError");
}

function sentencesOf(paraText: string): Sent[] {
  const out: Sent[] = [];
  for (const piece of paraText.split(SENT_SPLIT)) {
    const raw = piece.trim();
    if (!raw) continue;
    const chunks = raw
      .split(CHUNK_SEP)
      .map((c) => c.match(TOKEN_RE) ?? [])
      .filter((t) => t.length);
    if (chunks.length) out.push({ raw, chunks });
  }
  return out;
}

// ---- extraction -------------------------------------------------------------

type Stat = {
  nonInit: number; // occurrences NOT at a sentence start (case is trustworthy there)
  capNonInit: number; // …of those, surface starts with a capital
  forms: Map<string, number>; // non-lowercase surface forms at non-initial positions
  first: string; // first surface seen anywhere (fallback display)
  sample: string; // first-occurrence sentence (upgraded once to the first prose one)
  prose: boolean; // sample already looks like prose (not ToC/heading/number soup)
};

// translation context must be prose — ToC lines and digit-heavy fragments
// ("3.3.4 Learning to Rank 61") would only mislead the model
const isProse = (s: string) => s.length >= 40 && (s.match(/\d/g)?.length ?? 0) < s.length * 0.08;

// dominant surface form: the lowercased key unless some cased form outnumbers
// plain lowercase in running text (BM25 not bm25, Boolean not boolean)
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

function clampSample(raw: string, key: string): string {
  if (raw.length <= 300) return raw;
  const i = Math.max(0, raw.toLowerCase().indexOf(key.split(" ")[0]));
  const start = Math.max(0, i - 100);
  const end = Math.min(raw.length, i + 200);
  return (start > 0 ? "…" : "") + raw.slice(start, end).trim() + (end < raw.length ? "…" : "");
}

// Mine candidate terms from the whole document. Statistics only — reads every
// page's text via getTextContent (paragraphs via the shared clusterParagraphs),
// yields to the event loop every ~20 pages to keep the UI responsive.
export async function extractTerms(
  doc: PDFDocumentProxy,
  opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal; cap?: number } = {},
): Promise<ExtractedTerm[]> {
  const { onProgress, signal, cap = DEFAULT_CAP } = opts;
  const total = doc.numPages;

  // 1) read all pages into sentence/clause token streams
  const sents: Sent[] = [];
  for (let n = 1; n <= total; n++) {
    if (signal?.aborted) abortErr();
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const paras = clusterParagraphs(content.items, page.getViewport({ scale: 1 }));
    const marks = paras.reduce((acc, p) => acc + (p.text.match(CITE_MARK)?.length ?? 0), 0);
    if (marks < CITE_PAGE_MIN)
      for (const p of paras) sents.push(...sentencesOf(p.text));
    onProgress?.(n, total);
    if (n % 20 === 0) await tick();
  }

  // 2) count case-normalized n-grams (n=1..4, clause-bounded, boundary-filtered)
  const counts = new Map<string, number>();
  let iSent = 0;
  for (const s of sents) {
    if (++iSent % 5000 === 0) {
      if (signal?.aborted) abortErr();
      await tick();
    }
    for (const toks of s.chunks) {
      const low = toks.map((t) => t.toLowerCase());
      for (let a = 0; a < low.length; a++) {
        const w = low[a];
        if (w.length < 2 || FUNC_STOP.has(w)) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
        for (let n = 2; n <= MAX_N && a + n <= low.length; n++) {
          // a 1-char token may never sit inside a term (math-notation runs like "iP P R iP")
          if (n > 2 && low[a + n - 2].length < 2) break;
          const e = low[a + n - 1];
          if (e.length < 2 || FUNC_STOP.has(e)) continue; // no break: a longer gram may end cleanly
          const key = low.slice(a, a + n).join(" ");
          if (key.length <= 64) counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }

  // 3) candidates + C-value nested discounting (longest first; each accepted
  // longer term's own-use frequency is subtracted from its subgrams)
  type Cand = { key: string; n: number; freq: number };
  const cands: Cand[] = [];
  for (const [key, freq] of counts) {
    if (freq < MIN_FREQ) continue;
    const n = key.split(" ").length;
    cands.push({ key, n, freq });
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

  type Scored = Cand & { adj: number; score: number };
  const multi: Scored[] = [];
  const unis: Scored[] = [];
  for (const c of cands) {
    const adj = c.freq - (nested.get(c.key) ?? 0);
    if (c.n >= 2) {
      if (adj >= MIN_FREQ) multi.push({ ...c, adj, score: adj * Math.log2(c.n) });
    } else {
      unis.push({ ...c, adj, score: adj }); // acceptance decided after the form pass
    }
  }
  multi.sort((a, b) => b.score - a.score);
  const multiTop = multi.slice(0, PASS2_MULTI);

  // 4) second pass over the in-memory stream: surface forms + first-occurrence
  // samples for the shortlist only
  const stats = new Map<string, Stat>();
  for (const c of multiTop) stats.set(c.key, { nonInit: 0, capNonInit: 0, forms: new Map(), first: "", sample: "", prose: false });
  for (const c of unis) stats.set(c.key, { nonInit: 0, capNonInit: 0, forms: new Map(), first: "", sample: "", prose: false });

  iSent = 0;
  for (const s of sents) {
    if (++iSent % 5000 === 0) {
      if (signal?.aborted) abortErr();
      await tick();
    }
    let sentPos = 0; // token index within the sentence — 0 ⇒ sentence-initial
    for (const toks of s.chunks) {
      const low = toks.map((t) => t.toLowerCase());
      for (let a = 0; a < low.length; a++) {
        for (let n = 1; n <= MAX_N && a + n <= low.length; n++) {
          const key = low.slice(a, a + n).join(" ");
          const st = stats.get(key);
          if (!st) continue;
          const surface = toks.slice(a, a + n).join(" ");
          if (!st.first) st.first = surface;
          if (!st.sample) ((st.sample = s.raw), (st.prose = isProse(s.raw)));
          else if (!st.prose && isProse(s.raw)) ((st.sample = s.raw), (st.prose = true));
          if (sentPos + a > 0) {
            st.nonInit++;
            if (surface !== key) st.forms.set(surface, (st.forms.get(surface) ?? 0) + 1);
            const ch = surface.charCodeAt(0);
            if (ch >= 65 && ch <= 90) st.capNonInit++;
          }
        }
      }
      sentPos += toks.length;
    }
  }

  // 5) unigram acceptance: acronyms/all-caps, or capitalized-in-running-text
  // (non-sentence-initial, frequent, not a common English word)
  const accepted: (Scored & { disp: string })[] = [];
  for (const c of multiTop) {
    const st = stats.get(c.key)!;
    accepted.push({ ...c, disp: dominantForm(c.key, st) });
  }
  for (const c of unis) {
    const st = stats.get(c.key)!;
    const disp = dominantForm(c.key, st);
    const isAcr =
      disp.length >= 2 && disp === disp.toUpperCase() && /[A-Z]/.test(disp) && !/^[IVXLCDM]+$/.test(disp);
    if (isAcr && c.adj >= MIN_FREQ) accepted.push({ ...c, disp });
    else if (
      /^[A-Z][^A-Z]/.test(disp) &&
      st.capNonInit >= MIN_CAP_FREQ &&
      st.capNonInit > st.nonInit - st.capNonInit &&
      !COMMON_EN.has(c.key)
    )
      accepted.push({ ...c, disp });
  }

  accepted.sort((a, b) => b.score - a.score);
  return accepted.slice(0, cap).map((c) => ({
    term: c.disp,
    freq: c.freq,
    sample: clampSample(stats.get(c.key)!.sample, c.key),
  }));
}

// ---- translation ------------------------------------------------------------

// tidy a model answer for a 1-4 word segment: first line, unwrap quotes,
// drop a trailing period the source didn't have
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

// Translate the mined terms on the shared llama-server, ≤3 in flight. Each
// term goes through the contextual template (segment = term, context = its
// sample sentence, glossary empty). Failed/garbage → one retry → skipped.
// On abort resolves with whatever finished — callers merge the partial result.
export async function translateTerms(
  terms: readonly { term: string; sample?: string }[],
  opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<TermPair[]> {
  const { onProgress, signal } = opts;
  const out: (TermPair | null)[] = terms.map(() => null);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const k = next++;
      if (k >= terms.length) return;
      const { term, sample } = terms[k];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const tr = cleanTr(await translate(term, [], { context: sample || undefined, signal }), term);
          // sanity: a term's translation can't be a paragraph
          if (tr && tr.length <= Math.max(60, term.length * 8)) {
            out[k] = { term, tr };
            break;
          }
        } catch {
          if (signal?.aborted) return;
        }
      }
      done++;
      onProgress?.(done, terms.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, terms.length)) }, worker));
  return out.filter((p): p is TermPair => p !== null);
}

// ---- merge ------------------------------------------------------------------

// same lenient separators as translate.ts parseGlossary
const LINE_RE = /^\s*(.+?)\s*(?:=|->|→|—)\s*(.+?)\s*$/;

// Append pairs whose source term is not already present (case-insensitive on
// the source side). Existing lines — including junk that parses as nothing —
// are preserved untouched, so re-runs are idempotent.
export function mergeGlossary(existing: string, pairs: readonly TermPair[]): { text: string; added: number } {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const have = new Set<string>();
  for (const line of existing.split(/\r?\n/)) {
    const m = line.match(LINE_RE);
    if (m) have.add(norm(m[1]));
  }
  const lines: string[] = [];
  for (const p of pairs) {
    const k = norm(p.term);
    if (!p.tr || !k || have.has(k)) continue;
    have.add(k);
    lines.push(`${p.term} = ${p.tr}`);
  }
  if (!lines.length) return { text: existing, added: 0 };
  const base = existing.replace(/\n+\s*$/, "");
  return { text: (base ? base + "\n" : "") + lines.join("\n") + "\n", added: lines.length };
}
