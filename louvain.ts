// Louvain modularity maximisation, the partition Silica colours its graph by
// (silica/kernel/recall/graph_export.py:detect_communities, which delegates to
// networkx.algorithms.community.louvain_communities).
//
// Deterministic: nodes are visited in index order and ties resolve to the lowest
// community id, so the same vault always yields the same colours. networkx
// shuffles by default; here a partition that moves on every redraw would be
// worse than a slightly worse partition that holds still.

/** Weighted undirected level graph. `w[i]` may contain `i` (a self-loop from a
 * previous aggregation), which counts twice toward the degree. */
interface Level {
  w: Array<Map<number, number>>;
  k: number[]; // weighted degree, self-loop counted twice
  twoM: number;
}

function levelFrom(size: number, pairs: Array<[number, number, number]>): Level {
  const w: Array<Map<number, number>> = Array.from({ length: size }, () => new Map());
  for (const [a, b, weight] of pairs) {
    w[a].set(b, (w[a].get(b) ?? 0) + weight);
    if (a !== b) w[b].set(a, (w[b].get(a) ?? 0) + weight);
  }
  const k = w.map((row, i) => {
    let sum = 0;
    for (const v of row.values()) sum += v;
    return sum + (row.get(i) ?? 0); // the self-loop again: it is an edge to itself
  });
  return { w, k, twoM: k.reduce((a, b) => a + b, 0) };
}

/** One level of local moving. Returns the community of each node, or null when
 * nothing moved (the level has converged and aggregating would be a no-op). */
function localMoving(level: Level): number[] | null {
  const n = level.w.length;
  const com = Array.from({ length: n }, (_, i) => i);
  const sigmaTot = level.k.slice();
  let movedAny = false;

  // ponytail: 20 passes, not "until stable". Louvain's local phase settles in a
  // handful; the cap is only there so a pathological graph cannot hang the view.
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const own = com[i];
      sigmaTot[own] -= level.k[i];

      // Weight from i into each neighbouring community, self-loop excluded.
      const into = new Map<number, number>();
      for (const [j, weight] of level.w[i]) {
        if (j === i) continue;
        into.set(com[j], (into.get(com[j]) ?? 0) + weight);
      }
      let best = own;
      let bestGain = (into.get(own) ?? 0) - (sigmaTot[own] * level.k[i]) / level.twoM;
      for (const c of [...into.keys()].sort((a, b) => a - b)) {
        const gain = (into.get(c) ?? 0) - (sigmaTot[c] * level.k[i]) / level.twoM;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          best = c;
        }
      }
      sigmaTot[best] += level.k[i];
      if (best !== own) {
        com[i] = best;
        moved = movedAny = true;
      }
    }
    if (!moved) break;
  }
  return movedAny ? com : null;
}

/** Renumber sparse community labels to 0..c-1, preserving first-seen order. */
function compact(com: number[]): { com: number[]; count: number } {
  const seen = new Map<number, number>();
  const out = com.map((c) => {
    let id = seen.get(c);
    if (id === undefined) seen.set(c, (id = seen.size));
    return id;
  });
  return { com: out, count: seen.size };
}

/** Community id per node. Ids are ordered by community size, biggest first, so
 * colour 0 is always the largest cluster. Nodes with no edge get a singleton. */
export function louvain(nodes: string[], edges: Array<[string, string, number]>): Map<string, number> {
  const index = new Map(nodes.map((n, i) => [n, i]));
  const pairs: Array<[number, number, number]> = [];
  for (const [a, b, weight] of edges) {
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia !== undefined && ib !== undefined && weight > 0) pairs.push([ia, ib, weight]);
  }

  let level = levelFrom(nodes.length, pairs);
  let membership = nodes.map((_, i) => i); // original node -> current level node
  if (level.twoM === 0) return new Map(nodes.map((n, i) => [n, i])); // no edges at all

  for (let depth = 0; depth < 10; depth++) {
    const moved = localMoving(level);
    if (!moved) break;
    const { com, count } = compact(moved);
    membership = membership.map((c) => com[c]);
    if (count === level.w.length) break; // nothing merged — further levels cannot help

    // Aggregate: each community becomes one node. An unordered pair is folded
    // once, so an internal edge lands on the super-node's self-loop exactly once
    // and contributes twice to its degree, as it must.
    const agg: Array<[number, number, number]> = [];
    for (let i = 0; i < level.w.length; i++) {
      for (const [j, weight] of level.w[i]) {
        if (j < i) continue;
        agg.push([com[i], com[j], weight]);
      }
    }
    level = levelFrom(count, agg);
  }

  const sizes = new Map<number, number>();
  for (const c of membership) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  const bySize = [...sizes.keys()].sort((a, b) => (sizes.get(b) ?? 0) - (sizes.get(a) ?? 0) || a - b);
  const rankOf = new Map(bySize.map((c, i) => [c, i]));
  return new Map(nodes.map((n, i) => [n, rankOf.get(membership[i]) ?? 0]));
}

/** One vivid hue per community, on the arc Silica paints its own graph with
 * (graph_export.py:_community_color — the mascot's blue pole through its warm
 * magenta one). Golden-ratio walk keeps consecutive ids far apart; lightness
 * alternates between two bands to buy back what the short arc costs.
 * Past roughly ten communities the hues stop being tellable apart — read the
 * labels, not the colours. */
export function communityColor(i: number, onPaper: boolean): string {
  const hue = 212 + (((i * 0.6180339887) % 1) * (306 - 212));
  const light = (onPaper ? [42, 30] : [70, 54])[i % 2];
  return `hsl(${hue.toFixed(1)}, 66%, ${light}%)`;
}
