// The terminology record: its type, the grammar of the file the reader edits,
// and the sidecar that carries everything the reader should not have to look at.
//
// This module is deliberately PURE. It reads no file, calls no model, imports
// neither translate.ts nor terms.ts. The passes and the storage glue live in
// glossarygen.ts, which imports this module and those; keeping the record and
// its grammar down here is what stops the cycle, and it also means the parser
// the reader's textarea depends on carries none of the miner's stoplists into
// the main bundle.
//
// ---- what the file is -------------------------------------------------------
//
// <appDataDir>/glossaries/<contentKey>.txt — the same path and the same name it
// has always had, one line per term, hand-editable, and exactly what the reader
// sees in the panel. The grammar, in the user's own example:
//
//   inverted index = инвертированный индекс :: структура данных :: отображение термина в список документов
//   BM25 = BM25 :: метрика ранжирования
//   полнота :: метрика :: доля найденных релевантных документов
//
// i.e. `term [= translation] [:: category [:: definition]]`. `category` is a
// FREE-FORM noun phrase in the reader's language — «структура данных»,
// «метрика». It is NOT the graph's closed six-word vocabulary; that one is
// `kind`, and `kind` lives in the sidecar with the page numbers, the frequency,
// the folded aliases and the provenance, because none of them is something a
// reader wants to maintain by hand.
//
// There is no metadata header inside the .txt and there never will be. The file
// stays exactly what they see.
//
// ---- three things constrain the parser, and all three are load-bearing ------
//
// 1. booktranslate.ts:87 snapshots this file's ENTIRE TEXT verbatim into every
//    translation store JSON, and those stores outlive builds. Everything
//    translate.ts:162 accepted today — `=`, and the legacy `->`, `→`, `—` — is
//    still accepted here, splitting at the same place, so an old snapshot means
//    what it always meant. That is also why the legacy set is not GROWN: adding
//    the en dash «–» would silently re-read old files.
// 2. `term = ?` was the old generator's "needs manual entry" placeholder and
//    `term = —` was one of its broken artefacts. Both now read as a bare term
//    with no translation, which is the same thing they always meant and lets a
//    later pass fill the field in instead of dropping the line
//    (glossarygen.ts:629 used to drop them; see mergeRecords).
// 3. A line with NO separator at all is a valid record — a bare term. That is
//    what the context-menu "add to glossary" should write instead of
//    `${term} = ?`, and it is the whole point of a glossary that is no longer a
//    translation side-effect: a term can be worth recording before anyone knows
//    what to call it in the other language.
//
// The reader edits this file by hand, in a textarea, so leniency has a
// direction: a parser that EATS a line is worse than one that keeps a line it
// cannot understand. Anything unparseable — a blank line, a comment, a line
// whose term is empty — is not a record and survives every merge byte for byte.
//
// ---- the round trip, decided ------------------------------------------------
//
// * A field separator is « :: » with whitespace on at least one side. That
//   single rule is what keeps `std::vector`, `Foo::Bar` and `Enum::Value` — the
//   terms a programming book is made of — from being torn in half. The doubled
//   colon is already the separator graphgen reserves (graphgen.ts:186 explains
//   why it, and not the pipe character, is safe), and prose does not contain it.
//   A SINGLE colon is not a separator: it is ordinary punctuation inside terms,
//   translations and URLs, and «Глава 1: обзор» must not become two fields.
// * The LAST field absorbs everything after it, so a definition may contain
//   « :: » and still round-trip. A translation or a category may not — they
//   would be read as the field to their right. There is no escape character,
//   deliberately: an escape the reader has to learn is worse than a rule they
//   can see, and the one real case (`Foo::Bar`) already works because it is
//   written without spaces.
// * A term containing « = » splits at the first `=`, so a selection like
//   «P = NP» added by hand records the term «P» with the translation «NP». This
//   is inherited, not chosen — changing where the split lands would change what
//   every stored snapshot means. It is visible in the panel and the reader can
//   fix it; nothing is lost.
// * A definition containing a NEWLINE cannot exist: the file is line-based.
//   formatLine flattens every field before writing, because one record silently
//   becoming two lines — the second of them a bogus term — is the worst failure
//   this format has.
// * A whitespace-only line is the reader's paragraphing. Kept, never a record.
// * A `#` line is a comment: kept verbatim, never a record. The marker must be
//   followed by a space, another `#` or the end of the line, so `#include` and
//   `#define` stay terms — a C++ book's glossary is full of them. Nothing on the
//   writing side may narrow that: formatLine escapes a term ONLY when the line
//   it produces would read back as a comment, which is the same predicate, so
//   parse(format(x)) returns x's term for every term the parser can hand out.
//   A comment whose body parses as a term also SUPPRESSES that term: crossing a
//   line out is an edit, and a merge that re-adds it every run has undone the
//   reader's work.
//
//   What the suppression is, exactly: it stops the term from being APPENDED as a
//   new line, and nothing else. If the same term is also on a live, uncommented
//   line, that line still gets its empty fields filled on every pass. The two
//   have to be separable because the body of a note parses far more readily than
//   it looks: «—» is one of the legacy translation separators (see TR_SEP), and
//   it is also ordinary Russian punctuation, so «# BM25 — уточнить у автора» —
//   the natural shape of a note — parses to the term «BM25». Reading that as
//   "and never let the live BM25 line gain a category or a definition, on any
//   future pass" is not an edit the reader made; it is a note being mistaken for
//   a tombstone. Deleting the line is how a term is removed; commenting it out
//   is how it is kept out once removed.
// * CRLF: lines are split on /\r?\n/ so a carriage return never reaches a field,
//   and mergeRecords rejoins with whatever ending the file already uses. A
//   reader who opens the .txt in Notepad does not get a mixed file back.
// * A field the reader DELETED by hand is simply empty, and an empty field is
//   what a later pass is allowed to fill. There are no tombstones: this format
//   cannot tell "never had a definition" from "had one and did not want it", and
//   inventing a hidden per-field deletion flag would make the sidecar authoritative
//   over the text file, which is exactly backwards. Deleting a whole line has the
//   same shape — a later mining run may re-add it.
//
// The intended call for the context menu is `mergeRecords(text, [{ term,
// source: "user" }])`: it appends the bare term if the file does not already
// have it, under the same identity every other caller uses, and returns the file
// unchanged if it does.

import { UND, type BookLang } from "./booklang";
import { normId, type NodeKind } from "./graphstore";

// ---- the record -------------------------------------------------------------

// The graph's node kinds minus "book" — a book is a node, never a term. Derived
// rather than re-spelled so the two cannot drift: a term typed by the model has
// to be a kind graphstore can actually store, and seedShard hands these straight
// to addConcept.
export type TermKind = Exclude<NodeKind, "book">;

// Where the record came from. "user" is the strongest claim there is: the reader
// typed it, and no pass may overwrite it (see mergeSidecarEntry).
export type TermSource = "mined" | "user" | "model" | "graph";

export type TermRecord = {
  term: string; // surface form, in the BOOK's language
  translation?: string; // into the sidecar's `target`; absent when none applies
  category?: string; // free-form noun phrase, reader's language
  definition?: string; // one sentence, reader's language
  kind?: TermKind; // closed vocabulary, for the graph — sidecar only
  aliases?: string[]; // folded duplicates — sidecar only
  pages?: number[]; // 1-based, ascending — sidecar only
  freq?: number; // occurrences in the book — sidecar only
  source?: TermSource; // sidecar only
};

// Exhaustive by construction: adding a kind to graphstore's NodeKind breaks this
// object until somebody decides whether a term can be one. A plain array would
// have compiled and silently rejected the new kind at runtime.
const KIND_SET: Record<TermKind, true> = {
  person: true,
  org: true,
  place: true,
  work: true,
  topic: true,
  term: true,
};

export const TERM_KINDS = Object.keys(KIND_SET) as readonly TermKind[];
// The membership test reads the table rather than asking `in`: «toString» is in
// every object literal ever written, and a kind coming out of a JSON file the
// user can edit is exactly the input that finds that hole.
export const isTermKind = (s: string): s is TermKind =>
  KIND_SET[s as TermKind] === true;

const SOURCE_SET: Record<TermSource, true> = {
  mined: true,
  user: true,
  model: true,
  graph: true,
};
const isTermSource = (s: string): s is TermSource =>
  SOURCE_SET[s as TermSource] === true;

// ---- the grammar ------------------------------------------------------------

// Collapse every whitespace run — newlines, tabs, NBSP — to one space. Every
// field passes through this on the way in and on the way out: the file is
// line-based, so a newline inside a field is not a formatting nuisance, it is a
// second line that parses as a term nobody wrote.
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

// A field with no letter and no digit in it is empty, whatever characters it
// holds: «?» (the old generator's placeholder), «—», «-», «…». glossarygen.ts:621
// already called those junk; the test here is script-agnostic (\p{L}\p{N}) where
// that one was Latin+Cyrillic only, so a Chinese or Greek translation counts as
// the text it obviously is.
const HAS_TEXT = /[\p{L}\p{N}]/u;
const field = (s: string | undefined): string => {
  const v = flat(s ?? "");
  return HAS_TEXT.test(v) ? v : "";
};

// « :: » with whitespace on at least one side. Both halves of the alternation
// are needed: the first catches «a :: b» and «a ::b», the second «a:: b», and
// neither can match «std::vector», which is the point.
const FIELD_SEP = /[ \t]+::[ \t]*|[ \t]*::[ \t]+/;

// The translation separator, first occurrence wins (the left side is non-greedy).
// `=` is ours; `->`, `→` and `—` are translate.ts:165's legacy set, kept exactly
// as wide as it was and no wider. The right side may be empty — «term =» is a
// bare term, not a broken line.
const TR_SEP = /^(.*?)[ \t]*(?:=|->|→|—)[ \t]*(.*)$/;

// A comment only when the marker is followed by whitespace, another `#`, or the
// end of the line — «#include», «#define» and «#1» are terms in a real book.
// The leading class is \s and not [ \t] on purpose: a file saved by Notepad
// opens with a BOM, and JS counts U+FEFF as whitespace, so the first line of the
// reader's file behaves like every other one.
const COMMENT = /^\s*#(?:[\s#]|$)/;

/// The identity of a term: normId, the same fold the graph gives every name
/// (graphstore.ts:110). Case, NFKC compatibility forms, ё/е and punctuation runs
/// fold; morphology does not. One identity for the sidecar key, for the merge's
/// duplicate test and for anything else that has to ask "is this term already in
/// the file", so those three can never disagree the way App.tsx:2157's private
/// spelling of the grammar disagreed with everybody.
///
/// The known cost is punctuation-only distinctions: «C++», «C#» and «C» all fold
/// to «c», so a book that wants two of them gets one line and one sidecar entry.
/// It is the same collision graphstore accepts for node ids, it costs one line
/// rather than a wrong answer, and a term that folds to nothing at all (pure
/// punctuation) falls back to its own flattened spelling instead of vanishing.
export function termKey(term: string): string {
  const flattened = flat(term);
  return normId(flattened) || flattened.toLowerCase();
}

/// One line → one record, or null when the line is not a record: blank, a
/// comment, or a line whose term is empty («= перевод» names nothing). Null is
/// never a complaint about the line — the caller keeps it.
export function parseGlossaryLine(line: string): TermRecord | null {
  if (!line || !line.trim() || COMMENT.test(line)) return null;
  const parts = line.split(FIELD_SEP);
  const head = parts[0] ?? "";
  const m = head.match(TR_SEP);
  const term = field(m ? m[1] : head);
  if (!term) return null;
  const rec: TermRecord = { term };
  const tr = m ? field(m[2]) : "";
  if (tr) rec.translation = tr;
  const category = field(parts[1]);
  if (category) rec.category = category;
  // Everything past the third field belongs to the definition, rejoined with the
  // separator it was split on. That is what makes « :: » legal inside the last
  // field and nowhere else, and it matches how graphgen reads its own model
  // replies (graphgen.ts:1775).
  const definition = parts.length > 2 ? field(parts.slice(2).join(" :: ")) : "";
  if (definition) rec.definition = definition;
  return rec;
}

/// The whole file → records, in file order, one per parseable line. Lenient and
/// NOT deduplicating: two lines naming the same term are two records, because
/// deciding which one to drop is a merge's job, not a parser's.
export function parseGlossaryText(text: string): TermRecord[] {
  const out: TermRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const rec = parseGlossaryLine(line);
    if (rec) out.push(rec);
  }
  return out;
}

// The file's four slots, left to right. Named because both the writer and the
// merge have to reason about "which slots are already on this line". Plain
// constants and not a const enum: `isolatedModules` is on, and a const enum
// cannot survive per-file transpilation.
const SLOT_TERM = 0;
const SLOT_TR = 1;
const SLOT_CAT = 2;
const SLOT_DEF = 3;

// The part of a line from `from` rightwards. Split out of formatLine because
// mergeRecords appends a tail to a line the reader wrote rather than reprinting
// it (see there for why that matters).
//
// The empty middle: a record with a definition and no category is written
// «термин ::  :: определение». It reads back exactly as it went in, and the
// alternative — putting the definition in the category's slot — would come back
// as a category, which is a lie the reader cannot see. It happens whenever the
// graph's deep pass supplies a gloss and nobody has named a category yet.
function tailFrom(rec: TermRecord, from: number): string {
  const category = field(rec.category);
  const definition = field(rec.definition);
  let s = "";
  if (from <= SLOT_TR) {
    const tr = field(rec.translation);
    if (tr) s += ` = ${tr}`;
  }
  if (from <= SLOT_CAT) {
    if (definition) s += ` :: ${category} :: ${definition}`;
    else if (category) s += ` :: ${category}`;
  } else if (definition) {
    s += ` :: ${definition}`;
  }
  return s;
}

/// The single canonical writer. Returns "" for a record with no usable term —
/// the caller writes nothing rather than a line that parses as nothing.
///
/// The property this function owes the rest of the module is that the round trip
/// is an identity: `parseGlossaryLine(formatLine(rec))?.term === rec.term` for
/// every term parseGlossaryLine itself can produce. mergeRecords leans on it in
/// three places (it re-parses the line it just appended, it reprints a line when
/// it cannot append to it, and glossarygen.ts:623 reprints a whole line to drop
/// a definition), so a writer that renames a term does not rename it once — it
/// renames it on every pass that touches the file, for the rest of the file's
/// life.
///
/// Exactly one thing can break that trip, and it is the comment marker: a line
/// the parser reads back as a comment is a record that silently stopped being
/// one. So the guard is the parser's OWN predicate and nothing wider. It used to
/// be a blanket `replace(/^#+[ \t]*/, "")`, which is far wider than the hazard:
/// COMMENT deliberately demands a space, another `#` or the end of the line
/// after the marker precisely so that «#include», «#define» and «#1» stay terms,
/// and the blanket strip renamed those three to «include», «define» and «1» on
/// every write — including an ordinary enrich pass over a hand-written C++
/// glossary, which reprints the line whenever the new field lands left of one
/// already printed. Nothing downstream could even notice: termKey folds «#include»
/// and «include» together (the punctuation collision documented there, the same
/// one that gives «C++» and «C» one line), so the duplicate check reported the
/// renamed term as already present and the reader could not add theirs back.
///
/// A term that genuinely would read back as a comment — «# заметка», «## TODO» —
/// cannot be written as it stands. This format has no escape character, by the
/// decision recorded at the top of this file, so there is no spelling of it that
/// comes back whole. The parser never hands out such a term (it reads those
/// lines as comments), so the case only arises from a caller that built the
/// record itself: the context menu with a Markdown heading selected, or a model
/// reply. Of the two lossy options, dropping the marker is the one the reader
/// can SEE in the panel and fix; keeping it writes a line that is no longer a
/// record and tells nobody. So the marker is dropped — one marker run at a time,
/// only while the term still reads as a comment, so «## #1» loses the heading
/// and keeps the preprocessor term. Each pass removes at least the leading `#`,
/// so the loop strictly shortens the string and cannot spin.
export function formatLine(rec: TermRecord): string {
  let term = field(rec.term);
  while (COMMENT.test(term)) term = field(term.replace(/^#+[ \t]*/, ""));
  if (!term) return "";
  return term + tailFrom(rec, SLOT_TR);
}

/// Records → file text, one line each, trailing newline. The counterpart of
/// parseGlossaryText; mergeRecords is what you want when a file already exists.
export function formatGlossaryText(records: readonly TermRecord[]): string {
  const lines = records.map(formatLine).filter(Boolean);
  return lines.length ? lines.join("\n") + "\n" : "";
}

// ---- merge ------------------------------------------------------------------

export type MergeResult = {
  text: string;
  added: number; // lines appended
  updated: number; // existing lines that gained a field
};

// Which fields a text line can carry. kind/aliases/pages/freq/source are the
// sidecar's and never appear here.
const TEXT_FIELDS = ["translation", "category", "definition"] as const;

// Fill only the EMPTY fields of `cur` from `inc`; null when there is nothing to
// fill. A field the incoming record does not have, or has as junk, never clears
// one that is already there.
function fillEmpty(cur: TermRecord, inc: TermRecord): TermRecord | null {
  let next: TermRecord | null = null;
  for (const f of TEXT_FIELDS) {
    if (cur[f]) continue;
    const v = field(inc[f]);
    if (!v) continue;
    next ??= { ...cur };
    next[f] = v;
  }
  return next;
}

// The leftmost slot `next` fills that `cur` did not have.
function firstNewSlot(cur: TermRecord, next: TermRecord): number {
  if (!cur.translation && next.translation) return SLOT_TR;
  if (!cur.category && next.category) return SLOT_CAT;
  return SLOT_DEF;
}

// The rightmost slot the RAW line occupies, which is not the same question as
// which fields survived the parse. «BM25 = ?» carries no translation and yet the
// slot is spoken for: appending « = BM25» to it would print «BM25 = ? = BM25».
// Every junk field is like that — the text is still on the line, the reader can
// still see it, and only a reformat can replace it.
function rawLastSlot(line: string): number {
  const parts = line.split(FIELD_SEP);
  if (parts.length > 2) return SLOT_DEF;
  if (parts.length === 2) return SLOT_CAT;
  return TR_SEP.test(parts[0] ?? "") ? SLOT_TR : SLOT_TERM;
}

/// Fold `incoming` into the text of an existing glossary file.
///
/// The guarantee this function exists for, inherited from glossarygen.ts:629 and
/// widened: EVERY existing line survives byte for byte. A line that gains a
/// field is the one exception, and even then only its tail is touched — the part
/// the reader typed keeps their spacing and their legacy separator, because the
/// new fields are appended to the raw line rather than the whole line being
/// reprinted. Only when a field has to be inserted BEFORE something already
/// printed on that line — a translation arriving for a line that carries a
/// category, or for one carrying the old `= ?` placeholder — is the line
/// reformatted, and that is the one case where appending is impossible.
///
/// Nothing is ever dropped. The old merge deleted `term = ?` artefacts so the
/// term could be retried; it no longer has to, because such a line now parses as
/// a term whose translation field is empty and an empty field is exactly what
/// this function fills. Re-runs are idempotent: the second run finds every field
/// already filled, changes nothing, and returns the caller's own string back.
///
/// A term the reader commented out is not appended again — that is what
/// crossing a line out means. It is a rule about APPENDING: if the term also has
/// a live line, that line is filled in exactly as any other would be.
///
/// `fresh` — the confirmed rebuild, and the ONLY mode allowed to lose a line —
/// starts from an empty base and writes `incoming` alone. It still keeps the
/// file's line ending: a rebuild is not a reason to hand a Notepad user a file
/// with mixed endings.
export function mergeRecords(
  existing: string,
  incoming: readonly TermRecord[],
  opts: { fresh?: boolean } = {},
): MergeResult {
  const fresh = opts.fresh === true;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const endsNl = !fresh && /\r?\n$/.test(existing);
  const base = fresh ? "" : existing;
  const out = base === "" ? [] : base.split(/\r?\n/);
  // A file ending in a newline splits to a trailing "" — that is the end of the
  // last line, not a blank line, and the join below re-adds it.
  if (out.length && out[out.length - 1] === "") out.pop();

  const at = new Map<string, number>(); // term key → index of its line in `out`
  const rec = new Map<number, TermRecord>(); // that line, parsed
  // Terms the reader crossed out. This gates the APPEND branch below and only
  // that branch — see the loop for why the fill branch must stay out of reach.
  const blocked = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    const line = out[i];
    if (COMMENT.test(line)) {
      const body = parseGlossaryLine(line.replace(/^\s*#+\s*/, ""));
      if (body) blocked.add(termKey(body.term));
      continue;
    }
    const r = parseGlossaryLine(line);
    if (!r) continue;
    const k = termKey(r.term);
    if (!k || at.has(k)) continue; // the first spelling of a term owns it
    at.set(k, i);
    rec.set(i, r);
  }

  const wasAppended = new Set<number>();
  let added = 0;
  let updated = 0;
  let appended = false;
  let changed = fresh; // a rebuild that adds nothing still rewrites the file
  for (const inc of incoming) {
    const k = termKey(inc.term ?? "");
    if (!k) continue;
    const idx = at.get(k);
    if (idx === undefined) {
      // The `blocked` test belongs HERE, inside the append branch, and not one
      // level up where it also short-circuited the fill below. A commented-out
      // line means "I removed this term, stop putting it back" — it is about
      // adding a line, and it says nothing about a line that is live. Testing it
      // first made a note permanently poison the term it names: «—» is a legacy
      // translation separator as well as ordinary Russian punctuation, so
      // «# BM25 — уточнить у автора» parses to the term «BM25», and with the
      // test up top the live, uncommented «BM25» line could never gain a
      // category or a definition again — measured as
      // mergeRecords("# BM25 — уточнить у автора\nBM25\nполнота\n", […]) leaving
      // BM25 bare while «полнота» beside it was filled, on that pass and on
      // every future one. Worse, the panel reports the enrich as a success:
      // glossarygen counts a record as enriched when it gains a field in memory,
      // before the merge ever runs.
      if (blocked.has(k)) continue;
      const line = formatLine(inc);
      if (!line) continue;
      // Trailing blank lines are dropped once, and only when something is
      // actually appended — the same tidy-up the old merge did, so a run that
      // adds nothing cannot touch the file at all.
      if (!appended) {
        while (out.length && !out[out.length - 1].trim()) out.pop();
        appended = true;
      }
      out.push(line);
      const i = out.length - 1;
      at.set(k, i);
      rec.set(i, parseGlossaryLine(line) ?? { term: inc.term });
      wasAppended.add(i);
      added++;
      changed = true;
      continue;
    }
    const cur = rec.get(idx);
    if (!cur) continue; // a comment or an unparseable line never claims a key
    const next = fillEmpty(cur, inc);
    if (!next) continue;
    const printed = rawLastSlot(out[idx]);
    out[idx] =
      firstNewSlot(cur, next) > printed
        ? out[idx].replace(/\s+$/, "") + tailFrom(next, printed + 1)
        : formatLine(next);
    rec.set(idx, next);
    changed = true;
    // A line this very run appended is not an update to anything.
    if (!wasAppended.has(idx)) updated++;
  }

  if (!changed) return { text: existing, added: 0, updated: 0 };
  if (!out.length) return { text: "", added, updated };
  return {
    text: out.join(eol) + (appended || endsNl ? eol : ""),
    added,
    updated,
  };
}

// ---- the sidecar ------------------------------------------------------------
//
// <appDataDir>/glossaries/<contentKey>.meta.json, beside the .txt and named
// after it. Everything in here is bookkeeping: it can be lost, rebuilt or thrown
// away without the reader losing a word they wrote, which is why a missing or
// malformed sidecar is not an error but "no bookkeeping yet".
//
// The .txt is the truth. The sidecar only ever describes terms that are in it.

export const SIDECAR_VERSION = 2;
export const SIDECAR_EXT = ".meta.json";

export type TermMeta = {
  kind?: TermKind;
  aliases?: string[];
  pages?: number[];
  freq?: number;
  source?: TermSource;
};

export type GlossaryMeta = {
  v: typeof SIDECAR_VERSION;
  lang: BookLang; // the book's language, UND when nobody has decided
  target: BookLang; // what translations in the .txt are IN, UND when there are none
  terms: Record<string, TermMeta>; // keyed by termKey(term)
};

// Page lists are capped the same as the graph's (terms.ts MAX_PAGES_PER_TERM,
// graphstore's per-book cap): eight is enough for "where do I read about this"
// and the sidecar is not an index. The number is repeated rather than imported
// so that reading a glossary does not drag the miner's stoplists in; if one
// moves, the other has to.
const MAX_PAGES = 8;
// A cluster the validation pass folded into one record. Twelve spellings of one
// concept is already a runaway, and an unbounded list would be a model fault
// written to disk for ever.
const MAX_ALIASES = 12;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// A BCP-47-ish tag and nothing else. booklang keeps BookLang open on purpose, so
// this is the only place that can refuse a sidecar field holding an object, a
// sentence, or a tag Intl would throw on.
const TAG_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*$/;
const tag = (v: unknown): BookLang =>
  typeof v === "string" && TAG_RE.test(v.trim()) ? v.trim().toLowerCase() : UND;

const emptyMeta = (): GlossaryMeta => ({
  v: SIDECAR_VERSION,
  lang: UND,
  target: UND,
  terms: {},
});

const intList = (v: unknown, max: number): number[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<number>();
  for (const n of v) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 1) continue;
    seen.add(Math.floor(n));
  }
  if (!seen.size) return undefined;
  return [...seen].sort((a, b) => a - b).slice(0, max);
};

const strList = (v: unknown, drop: string): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== "string") continue;
    const a = field(s);
    const k = termKey(a);
    if (!a || !k || k === drop || seen.has(k)) continue; // an alias of itself is not an alias
    seen.add(k);
    out.push(a);
    if (out.length >= MAX_ALIASES) break;
  }
  return out.length ? out : undefined;
};

// One sidecar entry, coerced field by field. Anything unrecognised is left out
// rather than kept as-is: this object is handed to the graph, and a `kind` that
// is not a NodeKind would become a node type nothing renders.
function readMeta(v: unknown, key: string): TermMeta | undefined {
  if (!isObj(v)) return undefined;
  const m: TermMeta = {};
  if (typeof v.kind === "string" && isTermKind(v.kind)) m.kind = v.kind;
  const aliases = strList(v.aliases, key);
  if (aliases) m.aliases = aliases;
  const pages = intList(v.pages, MAX_PAGES);
  if (pages) m.pages = pages;
  if (typeof v.freq === "number" && Number.isFinite(v.freq) && v.freq >= 1)
    m.freq = Math.floor(v.freq);
  if (typeof v.source === "string" && isTermSource(v.source))
    m.source = v.source;
  return Object.keys(m).length ? m : undefined;
}

/// Read the sidecar. Never throws and never reports: a file that is missing,
/// truncated, hand-mangled or written by a version this build does not know
/// yields an empty one, which means "no bookkeeping yet" and is a state the app
/// is required to work in anyway (a glossary mined with no aux model has exactly
/// this sidecar until a later pass fills it).
///
/// Keys are re-folded through termKey on the way in, so a hand-edited or
/// foreign-written key still matches the lookups every caller does.
export function parseSidecar(raw: string | null | undefined): GlossaryMeta {
  const out = emptyMeta();
  if (!raw) return out;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isObj(json) || json.v !== SIDECAR_VERSION) return out;
  out.lang = tag(json.lang);
  out.target = tag(json.target);
  if (!isObj(json.terms)) return out;
  for (const [k, v] of Object.entries(json.terms)) {
    const key = termKey(k);
    if (!key) continue;
    const m = readMeta(v, key);
    if (m) out.terms[key] = m;
  }
  return out;
}

/// Serialise the sidecar, re-coercing on the way out so a caller cannot write a
/// field this module would refuse to read back. Compact JSON, like the graph
/// shards (graphstore.ts:450) and the translation stores (booktranslate.ts:181).
export function formatSidecar(meta: GlossaryMeta): string {
  const terms: Record<string, TermMeta> = {};
  for (const [k, v] of Object.entries(meta.terms ?? {})) {
    const key = termKey(k);
    if (!key) continue;
    const m = readMeta(v, key);
    if (m) terms[key] = m;
  }
  return JSON.stringify({
    v: SIDECAR_VERSION,
    lang: tag(meta.lang),
    target: tag(meta.target),
    terms,
  });
}

/// Records from the .txt + the sidecar → whole records. Fields already on the
/// record win: a caller that has just enriched a term in memory is holding
/// something newer than the file.
export function applyMeta(
  records: readonly TermRecord[],
  meta: GlossaryMeta,
): TermRecord[] {
  return records.map((r) => {
    const m = meta.terms[termKey(r.term)];
    if (!m) return { ...r };
    const out: TermRecord = { ...r };
    if (!out.kind && m.kind) out.kind = m.kind;
    if (!out.aliases?.length && m.aliases?.length) out.aliases = [...m.aliases];
    if (!out.pages?.length && m.pages?.length) out.pages = [...m.pages];
    if (out.freq === undefined && m.freq !== undefined) out.freq = m.freq;
    if (!out.source && m.source) out.source = m.source;
    return out;
  });
}

// One entry against what the sidecar already held. Pages and aliases are unions
// (a run that mined a SAMPLE of the book knows less than the file does, and
// forgetting a page number the reader could have clicked is a loss for nothing),
// freq takes the larger count for the same reason, and `source` never leaves
// "user": the reader typing a term outranks every pass that runs afterwards.
function mergeSidecarEntry(
  prev: TermMeta | undefined,
  r: TermRecord,
): TermMeta | undefined {
  const key = termKey(r.term);
  const m: TermMeta = {};
  const kind = r.kind ?? prev?.kind;
  if (kind && isTermKind(kind)) m.kind = kind;
  const aliases = strList(
    [...(prev?.aliases ?? []), ...(r.aliases ?? [])],
    key,
  );
  if (aliases) m.aliases = aliases;
  const pages = intList(
    [...(prev?.pages ?? []), ...(r.pages ?? [])],
    MAX_PAGES,
  );
  if (pages) m.pages = pages;
  const freq = Math.max(prev?.freq ?? 0, r.freq ?? 0);
  if (freq >= 1) m.freq = Math.floor(freq);
  const source = prev?.source === "user" ? "user" : (r.source ?? prev?.source);
  if (source && isTermSource(source)) m.source = source;
  return Object.keys(m).length ? m : undefined;
}

/// Build the sidecar for a glossary.
///
/// `records` must be the COMPLETE record list of the file — parseGlossaryText of
/// the text that is about to be written, carrying whatever the passes learned.
/// Anything not in it is dropped, because the .txt is the truth and a sidecar
/// entry for a line the reader deleted describes nothing. Pass `prev` (the
/// sidecar as it was) to keep the bookkeeping of terms that survived; omit it
/// for a rebuild, which is the one case where forgetting is the point.
export function buildSidecar(
  records: readonly TermRecord[],
  opts: { lang: BookLang; target: BookLang; prev?: GlossaryMeta | null },
): GlossaryMeta {
  const prev = opts.prev?.terms ?? {};
  const out: GlossaryMeta = {
    v: SIDECAR_VERSION,
    lang: tag(opts.lang),
    target: tag(opts.target),
    terms: {},
  };
  for (const r of records) {
    const key = termKey(r.term);
    if (!key) continue;
    // Two lines whose terms fold to one key share one entry; merging into what
    // is already there keeps the second line's pages instead of losing them.
    const m = mergeSidecarEntry(out.terms[key] ?? prev[key], r);
    if (m) out.terms[key] = m;
  }
  return out;
}
