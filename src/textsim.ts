// ---- string similarity ------------------------------------------------------
// One normaliser and one similarity coefficient, shared by the two places that
// have to decide whether two pieces of prose name the same thing:
//
//   * App.tsx's translated outline — an outline row's heading against the
//     paragraphs of the page it resolves to. This is where the code and its
//     calibration came from; the measurement below is that book.
//   * the glossary's near-duplicate clustering — two mined terms that are the
//     same concept written twice («нейронная сеть» / «нейронные сети»), folded
//     into one record with the loser kept as an alias.
//
// The property that makes one primitive serve both is that it is SCRIPT-AGNOSTIC.
// It reads character bigrams of a case-folded, punctuation-stripped string and
// nothing else: no stopword list, no stemmer, no suffix table, so it carries no
// assumption about which language it is looking at. That is exactly the gap
// graphstore.ts:191 names — conceptId's ending-fold is deliberately monolingual
// because a Russian ending-strip is simultaneously a case-strip, so a Cyrillic
// library keeps inflected forms of one concept as separate nodes. Bigram overlap
// does not care: «нейронная сеть» and «нейронные сети» share most of their
// bigrams whatever the case ending is doing, and «полка»/«полк» — the collision
// the fold has to refuse — stays a judgement about a threshold rather than an
// irreversible merge.
//
// It is a similarity, not a lemmatiser. It says how alike two strings look; it
// never says they mean the same thing. Above the threshold the glossary still
// asks the model.

// Matching is a Sørensen–Dice coefficient over character bigrams of the
// normalized strings — robust to the page number the engine sometimes welds
// onto a heading («1.4 Content Organization 5»), to hyphenation, and to
// punctuation the outline and the page disagree about.
//
// Calibrated on the user's book (838 pages, 548 outline rows, 4 514 stored
// translations): 527 rows relabel (96.2%), 21 fall back. The fallbacks are
// honest ones — 18 run-in headings that are not standalone paragraphs at all
// («Distinctness», «Step 4: Ranking» — the bold lead-in of a body paragraph),
// «Bibliography» which lands on a refPage that is deliberately left untranslated,
// and one title the clusterer truncated. The threshold sits in a real gap: the
// best wrong match measured 0.718 («What is a knowledge graph» pulled toward the
// chapter title «Knowledge Graphs» on the same page), the weakest right one 0.800
// («III VERTICALS» → «ВЕРТИКАЛЫ»).
//
// The number is evidence, not taste: retuning it invalidates that measurement,
// so a caller that needs a different cut-off passes its own rather than moving
// this one.
export const OUT_MATCH = 0.75;

export const outNorm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[­‐-―−]/g, "-")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function outDice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = new Map<string, number>();
  for (let i = 0; i + 1 < a.length; i++) A.set(a.slice(i, i + 2), (A.get(a.slice(i, i + 2)) ?? 0) + 1);
  let inter = 0;
  for (let i = 0; i + 1 < b.length; i++) {
    const g = b.slice(i, i + 2);
    const v = A.get(g);
    if (v) {
      inter++;
      A.set(g, v - 1);
    }
  }
  return (2 * inter) / (a.length - 1 + b.length - 1);
}
