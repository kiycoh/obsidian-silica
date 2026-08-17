// The maintenance signals: what is going wrong in the vault, computed from the
// corpus the related pane already builds plus Obsidian's own two link tables.
// Ports the embedder-free half of Silica's graph_report (AutolinkCandidate,
// StaleLink, orphans, dangling) and replaces its cosine DuplicatePair with a
// Jaccard over whole stem sets.
//
// No Obsidian import, so `node --test` drives all of it.

import { discriminatingSets, type Corpus } from "./corpus.ts";
import { TAU, TEMPLATE_TAU, eachPair, jaccard, relatedTo, type Related } from "./correlate.ts";

/** Obsidian's link tables: source -> target -> count. `unresolved` keys targets
 * by their raw link text, since by definition there is no file to name. */
export interface LinkTables {
  resolved: Record<string, Record<string, number>>;
  unresolved: Record<string, Record<string, number>>;
}

// --- Calibration knobs -----------------------------------------------------
// Starting points measured on nothing. Each says what moving it costs, because
// the honest part of an untuned threshold is naming which way it fails.

/** Orphan rescue answers to a lower bar than the related list (LIST_TAU 0.12):
 * a false positive costs one glance, a false negative leaves the note orphaned
 * for good. Asymmetric error, asymmetric threshold. */
export const ORPHAN_TAU = 0.08;
/** Near-duplicate, over whole discriminating stem sets — NOT the top-30 sets the
 * related list uses, which two notes on one subject share by construction. Raise
 * it if same-topic notes show up as duplicates; lower it if real copies hide. */
export const NEAR_DUP_TAU = 0.5;
/** A written link whose two notes have almost no vocabulary in common. Low on
 * purpose: an empty section beats a section nobody trusts. */
export const STALE_TAU = 0.02;
/** Past this many outgoing links a note is an index, and its links are its job,
 * not a mistake. */
export const INDEX_OUT_DEGREE = 12;
/** Fusion constant, same role as lexical.ts: it damps ranks, nothing else. */
const RRF_K = 60;

const EMPTY: Set<string> = new Set();
const byScore = (a: Related, b: Related) => b.score - a.score || (a.path < b.path ? -1 : 1);

// --- Link-table derivations ------------------------------------------------

/** How many notes point at each note. The orphan test, and the only reason the
 * whole resolved table is walked. */
export function inDegrees(links: LinkTables): Map<string, number> {
  const deg = new Map<string, number>();
  for (const targets of Object.values(links.resolved)) {
    for (const [target, n] of Object.entries(targets)) deg.set(target, (deg.get(target) ?? 0) + n);
  }
  return deg;
}

const isWritten = (links: LinkTables, a: string, b: string): boolean =>
  Boolean(links.resolved[a]?.[b] || links.resolved[b]?.[a]);

// --- Per-note signals ------------------------------------------------------
//
// Every proposal here starts from relatedTo, which carries correlate's template
// gate: the top-30 of a note written from a template IS the template, and on a
// vault of daily notes raw CORRELATE relates every note to every other at 0.7.
// Nothing below has to re-check that — it cannot reach a pair the gate dropped.

/** Near-duplicates of one note. Whole discriminating sets, high bar; candidates
 * still come from the top-k inverted index, because two notes near enough to be
 * copies cannot fail to share top stems. */
export function nearDuplicates(corpus: Corpus, path: string, limit = 10, tau = NEAR_DUP_TAU): Related[] {
  const sets = discriminatingSets(corpus);
  const mine = sets.get(path);
  if (!mine || !mine.size) return [];
  const out: Related[] = [];
  for (const { path: other } of relatedTo(corpus, path, Infinity, ORPHAN_TAU)) {
    const score = jaccard(mine, sets.get(other) ?? EMPTY);
    if (score >= tau) out.push({ path: other, score });
  }
  return out.sort(byScore).slice(0, limit);
}

/** Orphans this note could adopt: notes nobody points at, overlapping this one.
 * An orphan is invisible from itself, so this is the only surface that can show
 * one — you reach it from a note you actually opened. */
export function adoptableOrphans(
  corpus: Corpus,
  links: LinkTables,
  path: string,
  limit = 10,
  tau = ORPHAN_TAU,
): Related[] {
  const deg = inDegrees(links);
  // A note this one already links has in-degree >= 1, so the link check is the
  // orphan check: no second filter needed.
  return relatedTo(corpus, path, Infinity, tau)
    .filter((r) => !deg.get(r.path))
    .slice(0, limit);
}

/** Notes that overlap this one above the structural bar with no wikilink either
 * way. Uses TAU, not LIST_TAU: proposing a link is a claim, not a suggestion. */
export function unlinkedNeighbours(corpus: Corpus, links: LinkTables, path: string, limit = 10): Related[] {
  return relatedTo(corpus, path, Infinity, TAU)
    .filter((r) => !isWritten(links, path, r.path))
    .slice(0, limit);
}

/** Links written out of this note whose target shares almost no vocabulary with
 * it, usually the residue of a note that changed underneath the link. Index
 * notes are exempt: pointing at things they have nothing in common with is what
 * an index is for. */
export function staleLinks(corpus: Corpus, links: LinkTables, path: string, tau = STALE_TAU): Related[] {
  const targets = Object.keys(links.resolved[path] ?? {});
  if (targets.length > INDEX_OUT_DEGREE) return [];
  const sets = discriminatingSets(corpus);
  const mine = sets.get(path);
  if (!mine || !mine.size) return [];
  const out: Related[] = [];
  for (const target of targets) {
    const other = sets.get(target);
    if (!other || !other.size) continue; // never indexed: says nothing either way
    const score = jaccard(mine, other);
    if (score < tau) out.push({ path: target, score });
  }
  return out.sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : 1));
}

/** Link text in this note that resolves to no file. */
export function danglingLinks(links: LinkTables, path: string): string[] {
  return Object.keys(links.unresolved[path] ?? {}).sort();
}

export interface NoteSignals {
  related: Related[];
  /** Subset of `related` with no wikilink either way, as a set of paths. */
  unlinked: Set<string>;
  duplicates: Related[];
  orphans: Related[];
  stale: Related[];
  dangling: string[];
}

/** Everything the note panel shows for one note, from one pass over its
 * candidates. */
export function noteSignals(corpus: Corpus, links: LinkTables, path: string, limit = 20): NoteSignals {
  const related = relatedTo(corpus, path, limit);
  return {
    related,
    // The marker means "worth a wikilink", which is the TAU claim, not every
    // unlinked row in a list that starts at LIST_TAU.
    unlinked: new Set(unlinkedNeighbours(corpus, links, path, Infinity).map((r) => r.path)),
    duplicates: nearDuplicates(corpus, path),
    orphans: adoptableOrphans(corpus, links, path),
    stale: staleLinks(corpus, links, path),
    dangling: danglingLinks(links, path),
  };
}

// --- The global queue ------------------------------------------------------

export interface AttentionRow {
  path: string;
  score: number;
  /** Why it is here, in words, because a queue that will not say is ignored. */
  reason: string;
}

type Kind = "duplicates" | "orphans" | "missing" | "dangling";
const KINDS: Kind[] = ["duplicates", "orphans", "missing", "dangling"];

const LABEL: Record<Kind, [string, string]> = {
  duplicates: ["near-duplicate", "near-duplicates"],
  orphans: ["orphan to adopt", "orphans to adopt"],
  missing: ["unlinked neighbour", "unlinked neighbours"],
  dangling: ["broken link", "broken links"],
};

/** The whole vault ranked by how much it needs a look, worst first.
 *
 * One sweep over the candidate pairs feeds three of the four signals; the fourth
 * is a walk of the unresolved table. The four are then fused BY RANK, not by
 * score: a Jaccard over top-30 stems, a Jaccard over whole stem sets and a count
 * of broken links share no scale, and RRF is how lexical.ts already dodges that
 * same problem.
 *
 * An orphan's row is filed against the note that could adopt it, never against
 * the orphan: landing a reader on a note whose panel has nothing to offer is how
 * a queue teaches people to stop pressing the button.
 */
export function attentionQueue(corpus: Corpus, links: LinkTables, limit = 100): AttentionRow[] {
  const deg = inDegrees(links);
  const sets = discriminatingSets(corpus);
  const counts = new Map<string, Record<Kind, number>>();
  const best: Record<Kind, Map<string, number>> = {
    duplicates: new Map(), orphans: new Map(), missing: new Map(), dangling: new Map(),
  };
  const bump = (kind: Kind, path: string, score: number, n = 1) => {
    let row = counts.get(path);
    if (!row) counts.set(path, (row = { duplicates: 0, orphans: 0, missing: 0, dangling: 0 }));
    row[kind] += n;
    if ((best[kind].get(path) ?? -1) < score) best[kind].set(path, score);
  };

  eachPair(corpus, (a, b, score) => {
    if (score < ORPHAN_TAU) return;
    const dup = jaccard(sets.get(a) ?? EMPTY, sets.get(b) ?? EMPTY);
    if (dup >= NEAR_DUP_TAU) {
      bump("duplicates", a, dup);
      bump("duplicates", b, dup);
      return; // a copy is not also a missing link: say the bigger thing once
    }
    // The sweep reads eachPair directly rather than relatedTo, so the template
    // gate is applied here by hand — on `dup`, which is already computed.
    if (isWritten(links, a, b) || dup < TEMPLATE_TAU) return; // linked, or template overlap only
    if (score >= TAU) {
      bump("missing", a, score);
      bump("missing", b, score);
    }
    if (!deg.get(b)) bump("orphans", a, score);
    if (!deg.get(a)) bump("orphans", b, score);
  });

  for (const [path, targets] of Object.entries(links.unresolved)) {
    const n = Object.keys(targets).length;
    if (n && corpus.counts.has(path)) bump("dangling", path, n, n);
  }

  const fused = new Map<string, number>();
  for (const kind of KINDS) {
    [...best[kind]]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .forEach(([path], i) => fused.set(path, (fused.get(path) ?? 0) + 1 / (RRF_K + i + 1)));
  }
  return [...fused]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([path, score]) => ({ path, score, reason: reasonOf(counts.get(path)) }));
}

function reasonOf(row: Record<Kind, number> | undefined): string {
  if (!row) return "";
  const parts: string[] = [];
  for (const kind of KINDS) {
    const n = row[kind];
    if (n) parts.push(`${n} ${LABEL[kind][n === 1 ? 0 : 1]}`);
  }
  return parts.join(", ");
}
