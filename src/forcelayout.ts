// ---- A force-directed layout, hand-rolled -----------------------------------
//
// The obvious answer is d3-force, and this project will not take it. Two
// reasons, and the second is the one that decides it. First, nothing here is
// bundled that the app does not need twice over, and the house rule is that no
// dependency is added to package.json for a feature — the whole simulation is
// two ideas (push neighbours apart, pull along edges) and fits in one screen,
// so writing it is the smaller debt. Second, d3-force IS already in the tree,
// transitively, underneath mermaid, at whatever version mermaid happens to pin
// this month. Importing it from there would be worse than either honest
// option: the library view would break the day mermaid moved a caret, and
// nothing in package.json would say why.
//
// The contract is deliberately narrow: two functions, both mutating arrays the
// caller owns, no classes, no ticker, no events. GraphView owns the frame loop
// and the alpha schedule, because it is the only thing that knows whether
// anybody is looking at the canvas — a simulation running its own timer would
// keep a core warm behind a closed panel, which is the bug this split exists to
// prevent.
//
// Coordinates are world pixels: one unit here is one CSS pixel at zoom 1. The
// view transform (pan, zoom, devicePixelRatio) lives entirely in GraphView, so
// nothing in this file has to know how big the canvas is or how far in the
// reader has zoomed.

export type LayoutNode = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /// A pinned node contributes forces but never moves. That is how dragging
  /// works: the pointer writes x/y straight into the node and the simulation
  /// arranges everything else around it.
  pinned: boolean;
};

/// `a` and `b` are INDICES into the node array the caller passes to `step`,
/// not ids. Resolving a string id per edge per frame was measurably the most
/// expensive thing in an early version of this loop; the caller builds the
/// index once, when the graph changes, and the tick stays arithmetic.
export type LayoutEdge = { a: number; b: number; w: number };

// ---- seeding ----------------------------------------------------------------

// The angle between consecutive seeds. The golden angle is the one value at
// which no two arms of the spiral ever line up — which is why sunflowers use
// it, and why a cloud seeded with it shows no spokes for the reader to mistake
// for structure the graph does not have.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// How much of the shorter viewport side the seeded cloud fills. Deliberately
// under half: repulsion outruns the springs in the first second, so the cloud
// EXPANDS before it settles, and a seed that already filled the frame would
// push half the library off-screen before the reader could grab any of it.
const SEED_FILL = 0.42;

// Floor on the spacing between consecutive seeds, in world px. Twelve books in
// a narrow panel would otherwise be seeded inside a 40 px disc and spend their
// first frames untangling a knot that never had to exist.
const SEED_STEP_MIN = 26;

/// Lay nodes out on a phyllotaxis spiral centred in a `width` × `height` box.
///
/// Random seeding is the usual choice and it is a bad one here: the first frame
/// is what the reader sees while the simulation is still running, and a random
/// cloud reads as noise for the whole second it takes to relax. A spiral is
/// already legible — even, centred, no clumps — so the simulation only has to
/// refine a picture rather than rescue one.
///
/// Order matters: the caller should pass the nodes it wants near the middle
/// FIRST (GraphView passes books before concepts, heaviest first), because the
/// spiral's radius grows with the index.
export function seedPositions(nodes: LayoutNode[], width: number, height: number): void {
  if (!nodes.length) return;
  const cx = width / 2;
  const cy = height / 2;
  // sqrt(i) spacing is what makes the spiral EVEN in area rather than in
  // radius; the step is solved so the outermost node lands on SEED_FILL.
  const span = (Math.min(width, height) / 2) * SEED_FILL;
  const step = Math.max(SEED_STEP_MIN, nodes.length > 1 ? span / Math.sqrt(nodes.length - 1) : span);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const angle = i * GOLDEN_ANGLE;
    const d = step * Math.sqrt(i);
    n.x = cx + Math.cos(angle) * d;
    n.y = cy + Math.sin(angle) * d;
    n.vx = 0;
    n.vy = 0;
  }
}

// ---- one tick ---------------------------------------------------------------

// Every constant below is a trade, and every one of them will eventually be
// tuned by somebody looking at a real library, so each says what it buys.
//
// CELL — the spatial grid's cell size in world px, and simultaneously the
//   repulsion cutoff: a node only ever meets the nodes in its own cell and the
//   eight around it, so the sweep is O(n) in practice instead of O(n²). Past
//   roughly 800 nodes an all-pairs loop stops fitting in a 16 ms frame and the
//   whole app stutters, canvas or not. Bigger cells mean smoother long-range
//   spacing and more pairs per node; 96 px is about two concept diameters plus
//   a label, which is the distance at which crowding actually looks like
//   crowding.
// REPULSION — strength at the cutoff. Read it as: two nodes exactly CELL apart
//   drift apart by REPULSION / CELL² px this tick (~0.15 px at these numbers).
//   Raise it for an airier graph, lower it for a denser one.
// NEAR_MIN — the distance the inverse-square is clamped at. Without it two
//   nodes that land on the same pixel produce an infinite force and the graph
//   detonates; with it the worst case is one capped step.
// PAD / OVERLAP — discs that actually intersect get a second, linear push on
//   top of the inverse-square one. Inverse-square alone is too gentle at close
//   range to separate a big book node from a concept sitting on its rim, and
//   overlapping discs are the single ugliest thing this view can show.
// SPRING / REST_LONG / REST_SHORT / W_HALF — Hooke along each edge. The rest
//   length shortens with the edge weight so that a concept a book mentions
//   forty times sits visibly closer than one it mentions twice, but only
//   logarithmically: weights here span book→concept mention counts (1…hundreds)
//   and book→book Jaccard similarity (0…1) in the SAME array, and a linear
//   reading of that would collapse every similarity edge to zero length.
//   W_HALF is the weight at which the shortening is half done — 6 mentions.
// CENTRE_PULL — a weak pull toward the cloud's own centroid, which is what
//   keeps disconnected islands (a book with no neighbours yet) from being
//   evicted to infinity by repulsion alone.
// DAMPING — velocity kept between ticks. Under ~0.6 the graph looks glued;
//   over ~0.85 it oscillates for ages and the alpha floor cuts it off
//   mid-wobble.
// MAX_STEP — hard cap on how far one node may move in one tick. It is the
//   safety net for every clamp above: whatever the arithmetic does, the picture
//   never teleports.
const CELL = 96;
const REPULSION = 1400;
const NEAR_MIN = 6;
const PAD = 6;
const OVERLAP = 0.5;
const SPRING = 0.05;
const REST_LONG = 120;
const REST_SHORT = 34;
const W_HALF = Math.log1p(6);
const CENTRE_PULL = 0.006;
const DAMPING = 0.72;
const MAX_STEP = 22;

// The grid key packs two cell coordinates into one number so the buckets can
// live in a Map<number, …> — string keys would allocate one string per node per
// frame and hand the GC 42 000 objects a second. The clamp bounds the world at
// ±32 768 cells ≈ ±3.1 million px, which no reachable graph comes near; a node
// that somehow escaped that far is folded into the edge cell rather than
// aliasing onto somebody else's.
const CELL_LIMIT = 32768;
const cellOf = (v: number): number => {
  const c = Math.floor(v / CELL);
  return c < -CELL_LIMIT ? -CELL_LIMIT : c > CELL_LIMIT ? CELL_LIMIT : c;
};
const cellKey = (cx: number, cy: number): number => (cx + CELL_LIMIT) * 65536 + (cy + CELL_LIMIT);

/// Advance the simulation by one tick, in place. `alpha` scales every force at
/// once: the caller starts near 1 and decays it, so the graph moves boldly
/// while it is being read into shape and imperceptibly by the time it stops.
///
/// Nothing here allocates per node except the bucket arrays, and nothing here
/// reads the DOM. It is safe to call from inside a requestAnimationFrame
/// callback, which is exactly where GraphView calls it.
export function step(nodes: LayoutNode[], edges: LayoutEdge[], alpha: number): void {
  const n = nodes.length;
  if (!n) return;

  // ---- repulsion, through a uniform spatial grid ----
  const buckets = new Map<number, number[]>();
  const cxs = new Int32Array(n);
  const cys = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const p = nodes[i];
    const cx = cellOf(p.x);
    const cy = cellOf(p.y);
    cxs[i] = cx;
    cys[i] = cy;
    const key = cellKey(cx, cy);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  }

  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    const cx = cxs[i];
    const cy = cys[i];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = buckets.get(cellKey(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const j of bucket) {
          // Each pair sits in the other's neighbourhood, so it comes up twice;
          // taking only j > i visits it once and applies both halves of the
          // force here, which also keeps the result independent of iteration
          // order.
          if (j <= i) continue;
          const b = nodes[j];
          let vx = b.x - a.x;
          let vy = b.y - a.y;
          let d2 = vx * vx + vy * vy;
          if (d2 > CELL * CELL) continue; // circular cutoff inside the square grid
          if (d2 < 1e-6) {
            // Two nodes on the same pixel have no direction to be pushed
            // along. The offset is derived from the indices rather than from
            // Math.random so a reload of the same library produces the same
            // picture — a graph that rearranged itself every session would be
            // unrecognisable from one day to the next.
            vx = ((i * 7 + j * 13) % 19) / 19 - 0.5;
            vy = ((i * 11 + j * 5) % 23) / 23 - 0.5;
            d2 = vx * vx + vy * vy;
          }
          const d = Math.sqrt(d2);
          const eff = d < NEAR_MIN ? NEAR_MIN : d;
          let mag = (REPULSION * alpha) / (eff * eff);
          const want = a.r + b.r + PAD;
          if (d < want) mag += OVERLAP * (want - d) * alpha;
          const ux = vx / d;
          const uy = vy / d;
          a.vx -= ux * mag;
          a.vy -= uy * mag;
          b.vx += ux * mag;
          b.vy += uy * mag;
        }
      }
    }
  }

  // ---- springs along the edges ----
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    // A stale index cannot crash a frame: an edge into nothing is skipped.
    // graphstore already drops dangling edges on merge, so this is belt to
    // those braces, not the primary defence.
    if (!a || !b || a === b) continue;
    let vx = b.x - a.x;
    let vy = b.y - a.y;
    let d = Math.sqrt(vx * vx + vy * vy);
    if (d < 1e-6) {
      vx = 1;
      vy = 0;
      d = 1;
    }
    // 0 at weight 0, → 1 as the weight grows, half at W_HALF.
    const lw = Math.log1p(Math.max(0, e.w));
    const pull = lw / (lw + W_HALF);
    const rest = a.r + b.r + REST_LONG - (REST_LONG - REST_SHORT) * pull;
    // A heavy edge is not only shorter but stiffer, so the strongest relations
    // in the library are the ones that survive the crowd around them.
    const k = SPRING * (0.6 + 0.8 * pull);
    const mag = (d - rest) * k * alpha;
    const ux = vx / d;
    const uy = vy / d;
    a.vx += ux * mag;
    a.vy += uy * mag;
    b.vx -= ux * mag;
    b.vy -= uy * mag;
  }

  // ---- a weak pull to the centre ----
  // The centre is the cloud's OWN centroid, not the origin, because step() is
  // never told where the viewport is. A fixed origin would drag a graph seeded
  // at (width/2, height/2) off toward the corner over the first second, and the
  // reader's first pan would feel like the picture had run away from them.
  let mx = 0;
  let my = 0;
  for (const p of nodes) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  for (const p of nodes) {
    p.vx += (mx - p.x) * CENTRE_PULL * alpha;
    p.vy += (my - p.y) * CENTRE_PULL * alpha;
  }

  // ---- damping and integration ----
  for (const p of nodes) {
    if (p.pinned) {
      // Forces still accumulated on it above (a pinned node pushes its
      // neighbours around, which is the whole point of dragging one), but it
      // keeps its position and carries no momentum into the moment it is let go.
      p.vx = 0;
      p.vy = 0;
      continue;
    }
    p.vx *= DAMPING;
    p.vy *= DAMPING;
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (speed > MAX_STEP) {
      const s = MAX_STEP / speed;
      p.vx *= s;
      p.vy *= s;
    }
    p.x += p.vx;
    p.y += p.vy;
  }
}
