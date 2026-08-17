// CORRELATE — port of silica/kernel/link/correlate.py (ADR-0013). Note-to-note
// edges with no LLM, no embedder and no network: Jaccard over each note's top-30
// stems by RAW count, edge kept at >= tau.
//
// IDF was rejected by the data on the Python side: it made a note's top-k a
// function of the whole corpus, where raw count keeps a note's row a pure
// function of that note alone. Same choice here.

import { discriminatingSets, type Corpus } from "./corpus.ts";

export const TOP_K = 30;
/** The edge threshold, gated on the Python side. An edge is a structural claim:
 * it changes which community Louvain puts a note in. */
export const TAU = 0.25;
/** The list threshold. A row is a suggestion carrying its own score, not a claim,
 * so it answers to a lower bar — measured on a 759-note vault, 0.25 leaves the
 * pane empty on 73% of notes and 0.12 leaves it empty on 23%. */
export const LIST_TAU = 0.12;
/** The template gate. Two notes written from one template share their whole
 * top-30 — the template IS their top-30 — while sharing next to nothing once the
 * vault's ubiquitous stems are gone. One Jaccard over the discriminating sets
 * drops that whole class, at every layer that stands on a pair.
 *
 * The value is measured, and the measurement is that the class sits at zero
 * rather than near any threshold: on a vault of daily notes, 103 of the 105
 * journal pairs that clear the list bar share EXACTLY nothing once the culling
 * is done, and the two survivors share a real word. So the bar only has to be
 * above zero, and it is drawn where "almost no vocabulary in common" already is
 * for a written link (attention.ts STALE_TAU). Putting it higher costs real
 * pairs on a single-subject vault, where the subject's own words cross the DF
 * ceiling and get culled: on a 1199-note one, 0.08 dropped 102 of the 841
 * structural pairs and emptied 38 related panes, where 0.02 drops 4 and empties
 * one.
 *
 * Its ceiling: a templated class smaller than DF_MAX of the vault leaves its own
 * stems under the share ceiling, so nothing is culled and this gate saves
 * nothing. That case is what excluded folders are for. */
export const TEMPLATE_TAU = 0.02;

const EMPTY: Set<string> = new Set();

/** The k highest-count stems of one note. Tie-break lexicographic, so two runs
 * over the same vault produce the same edges. */
export function topkSet(counts: Map<string, number>, k = TOP_K): Set<string> {
  return new Set(
    [...counts]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, k)
      .map(([s]) => s),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0; // two empty top-k sets share nothing
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) shared++;
  return shared / (a.size + b.size - shared);
}

interface TopIndex {
  tops: Map<string, Set<string>>;
  /** top-stem -> paths carrying it in their top-k. Finds edge candidates without
   * an O(N) sweep per note. */
  inv: Map<string, string[]>;
}

// Memoised per Corpus object. buildCorpus returns a fresh object on every
// refresh, which is exactly the invalidation — same trick as the panel's diff cache.
const indexCache = new WeakMap<Corpus, TopIndex>();

function topIndex(corpus: Corpus): TopIndex {
  let idx = indexCache.get(corpus);
  if (idx) return idx;
  const tops = new Map<string, Set<string>>();
  const inv = new Map<string, string[]>();
  for (const [path, counts] of corpus.counts) {
    const set = topkSet(counts);
    tops.set(path, set);
    // An excluded note keeps its own top-k row but stays out of the inverted
    // index, which makes the exclusion one-way: it can probe the vault and can
    // never be probed. A journal is a dashboard — it reads the vault, the vault
    // does not read it — so the panel of a daily note still answers "what here
    // is about what I wrote today", while no other note ever has to hear about
    // the day. Two excluded notes cannot reach each other either, which was the
    // whole complaint.
    if (corpus.excluded.has(path)) continue;
    for (const s of set) {
      const bucket = inv.get(s);
      if (bucket) bucket.push(path);
      else inv.set(s, [path]);
    }
  }
  indexCache.set(corpus, (idx = { tops, inv }));
  return idx;
}

export interface Related {
  path: string;
  score: number;
}

/** Notes sharing at least one top-k stem with `path`. Every pairwise metric in
 * the plugin starts here: two notes that overlap enough to be worth a claim
 * cannot miss each other's top-k, and the inverted index is already built. */
export function candidatesFor(corpus: Corpus, path: string): Set<string> {
  const { tops, inv } = topIndex(corpus);
  const out = new Set<string>();
  const mine = tops.get(path);
  if (!mine) return out;
  for (const s of mine) for (const other of inv.get(s) ?? []) out.add(other);
  out.delete(path);
  return out;
}

/** The top-k set of one note, as the sweeps see it. */
export function topSetOf(corpus: Corpus, path: string): Set<string> {
  return topIndex(corpus).tops.get(path) ?? new Set();
}

/** Notes whose top-k overlaps `path`'s at >= tau, best first. */
export function relatedTo(corpus: Corpus, path: string, limit = 20, tau = LIST_TAU): Related[] {
  const mine = topSetOf(corpus, path);
  if (!mine.size) return [];
  const sets = discriminatingSets(corpus);
  const disc = sets.get(path) ?? EMPTY;
  const out: Related[] = [];
  for (const other of candidatesFor(corpus, path)) {
    const score = jaccard(mine, topSetOf(corpus, other));
    // The template gate second: it runs over whole stem sets, so it costs more
    // than the top-k one and only pairs that already cleared tau are worth it.
    if (score >= tau && jaccard(disc, sets.get(other) ?? EMPTY) >= TEMPLATE_TAU) out.push({ path: other, score });
  }
  return out.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1)).slice(0, limit);
}

/** Every candidate pair in the vault, exactly once, with its top-k overlap. The
 * one sweep the graph and the maintenance signals share: visiting a pair twice is
 * the expensive mistake here, so the dedup lives in a single place. */
export function eachPair(corpus: Corpus, fn: (a: string, b: string, score: number) => void): void {
  const seen = new Set<string>();
  for (const path of corpus.counts.keys()) {
    // The sweeps are the vault's business, so the exclusion is two-way here: an
    // excluded note is not a candidate for anyone (it is out of the inverted
    // index) and does not open a pair of its own either. No edge, so no node on
    // the community graph and no row in the queue.
    if (corpus.excluded.has(path)) continue;
    const mine = topSetOf(corpus, path);
    if (!mine.size) continue;
    for (const other of candidatesFor(corpus, path)) {
      // \0, not a space: a path may contain spaces, so "a b" + "c" and "a" +
      // "b c" would share a key. An escape rather than the raw byte, which
      // makes git read this whole file as binary and stop diffing it.
      const key = path < other ? `${path}\0${other}` : `${other}\0${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fn(path, other, jaccard(mine, topSetOf(corpus, other)));
    }
  }
}

/** Every edge in the vault, each pair once (a < b). Feeds the community graph. */
export function allEdges(corpus: Corpus, tau = TAU): Array<[string, string, number]> {
  const sets = discriminatingSets(corpus);
  const edges: Array<[string, string, number]> = [];
  eachPair(corpus, (a, b, score) => {
    if (score < tau) return;
    if (jaccard(sets.get(a) ?? EMPTY, sets.get(b) ?? EMPTY) < TEMPLATE_TAU) return;
    edges.push(a < b ? [a, b, score] : [b, a, score]);
  });
  return edges;
}
