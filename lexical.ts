// Ranked vault search — port of silica/kernel/recall/lexical.py's BM25 leg.
// Obsidian's own search is a boolean substring filter: every hit is equally
// good and the order is by path. This ranks.
//
// Two legs fused by RANK (reciprocal rank fusion), not by score, so BM25's
// unbounded numbers never have to be comparable to the title leg's.

import { TOKEN_RE, stemCounts, type Corpus } from "./corpus.ts";

const K1 = 1.5; // kernel/recall/lexical.py _BM25_K1
const B = 0.75; // kernel/recall/lexical.py _BM25_B
const RRF_K = 60; // the usual constant; only the ranks it damps matter here

export interface Hit {
  path: string;
  title: string;
  score: number;
}

/** A folder restriction: a lowercased path prefix, empty meaning the whole vault. */
export type Scope = string;

/** Peel a `path:` token off the query. A prefix rather than a fuzzy folder match,
 * because a prefix is what a folder IS, and it needs no explaining. */
export function splitScope(raw: string): { query: string; scope: Scope } {
  let scope = "";
  const query = raw
    .replace(/(?:^|\s)path:(\S+)/giu, (_m, prefix: string) => {
      scope = prefix.toLowerCase().replace(/^\/+/, "");
      return " ";
    })
    .replace(/\s+/gu, " ") // the token left a hole in the middle of the query
    .trim();
  return { query, scope };
}

export const inScope = (path: string, scope: Scope): boolean =>
  !scope || path.toLowerCase().startsWith(scope);

/** BM25 over the stem postings. Candidates are the union of the query stems'
 * postings, so a one-term query never costs an all-notes scan. */
export function bm25(corpus: Corpus, query: string, limit = 50, scope: Scope = ""): Hit[] {
  const terms = [...stemCounts(query, corpus.lang).keys()];
  const n = corpus.counts.size;
  if (!terms.length || !n) return [];

  const scores = new Map<string, number>();
  for (const term of terms) {
    const postings = corpus.postings.get(term);
    if (!postings) continue;
    const df = postings.size;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const [path, f] of postings) {
      const dl = corpus.lengths.get(path) ?? 0;
      const denom = f + K1 * (1 - B + (B * dl) / (corpus.avgLen || 1));
      scores.set(path, (scores.get(path) ?? 0) + (idf * f * (K1 + 1)) / denom);
    }
  }
  return rank(corpus, scores, limit, scope);
}

/** Title leg: a note whose name carries the query outranks one that merely
 * mentions it a lot. Scored by how much of the title the query covers, so an
 * exact title beats a long name the query is a fragment of.
 * ponytail: substring, where Python uses SequenceMatcher — no JS equivalent in
 * stdlib and a typo-tolerant match is not worth a dependency. Swap in a bigram
 * Dice coefficient if misspelled queries turn out to matter. */
export function titleHits(corpus: Corpus, query: string, limit = 50, scope: Scope = ""): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scores = new Map<string, number>();
  for (const [path, title] of corpus.titles) {
    const t = title.toLowerCase();
    if (t.includes(q)) scores.set(path, q.length / t.length);
  }
  return rank(corpus, scores, limit, scope);
}

/** Reciprocal rank fusion of the two legs. A note both legs like wins; a note
 * only one leg found still places. */
export function search(corpus: Corpus, query: string, limit = 50, scope: Scope = ""): Hit[] {
  const fused = new Map<string, number>();
  for (const leg of [bm25(corpus, query, limit * 2, scope), titleHits(corpus, query, limit * 2, scope)]) {
    leg.forEach((hit, i) => fused.set(hit.path, (fused.get(hit.path) ?? 0) + 1 / (RRF_K + i + 1)));
  }
  return rank(corpus, fused, limit, scope);
}

function rank(corpus: Corpus, scores: Map<string, number>, limit: number, scope: Scope = ""): Hit[] {
  return [...scores]
    .filter(([path, s]) => s > 0 && inScope(path, scope))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) // lexicographic tie-break: stable across runs
    .slice(0, limit)
    .map(([path, score]) => ({ path, title: corpus.titles.get(path) ?? path, score }));
}

// --- Snippets --------------------------------------------------------------

/** One run of snippet text, marked or not. Pieces rather than HTML: the renderer
 * builds elements from these, so vault prose can never become markup. */
export interface Piece {
  text: string;
  hit: boolean;
}

const SNIPPET_WIDTH = 170;
const LEAD = 50; // chars of run-up before the first match, so it is not flush left

/** A line of context around the query's first match, with every occurrence in
 * the window marked. Frontmatter is dropped and whitespace collapsed; the rest
 * is the note's own prose, code fences and all, because a snippet that hides
 * what matched is worse than none.
 * ponytail: surface-form matching, where the ranking is on stems, so a hit
 * ranked via "linking" is not marked under "link". Stem-to-offset mapping is the
 * upgrade if that gap shows. */
export function snippet(body: string, query: string, width = SNIPPET_WIDTH): Piece[] {
  const text = body
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return [];
  const terms = [...new Set((query.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length >= 2))];
  const lower = text.toLowerCase();

  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, at - LEAD);
  const cut = text.slice(start, start + width);
  const lowerCut = cut.toLowerCase();

  const marks: Array<[number, number]> = [];
  for (const term of terms) {
    for (let i = lowerCut.indexOf(term); i >= 0; i = lowerCut.indexOf(term, i + term.length)) {
      marks.push([i, i + term.length]);
    }
  }
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  const pieces: Piece[] = [];
  if (start > 0) pieces.push({ text: "…", hit: false });
  let cursor = 0;
  for (const [from, to] of marks) {
    if (from < cursor) continue; // overlapping terms: the first mark wins
    if (from > cursor) pieces.push({ text: cut.slice(cursor, from), hit: false });
    pieces.push({ text: cut.slice(from, to), hit: true });
    cursor = to;
  }
  if (cursor < cut.length) pieces.push({ text: cut.slice(cursor), hit: false });
  if (start + width < text.length) pieces.push({ text: "…", hit: false });
  return pieces;
}
