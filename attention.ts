// The maintenance signals: what is going wrong in the vault, computed from the
// corpus the related pane already builds plus Obsidian's own two link tables.
// Ports the embedder-free half of Silica's graph_report (AutolinkCandidate,
// StaleLink, orphans, dangling) and replaces its cosine DuplicatePair with a
// Jaccard over whole stem sets.
//
// No Obsidian import, so `node --test` drives all of it.

import { discriminatingSets, type Corpus } from "./corpus.ts";
import { LIST_TAU, TAU, eachPair, jaccard, relatedTo, type Related } from "./correlate.ts";

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
/** The bar a *proposal* answers to on the discriminating stem sets, above and
 * beyond correlate's TEMPLATE_TAU.
 *
 * The two gates do different jobs and only one of them is measurable from the
 * vault. TEMPLATE_TAU (0.02) exists to drop pairs that share literally nothing
 * once the ubiquitous stems are culled — a class that sits at zero, so the bar
 * only has to be above it. Proposing a link is a claim about two notes, and
 * there the question is not "is this pair template noise" but "would a person
 * agree", which needs a label.
 *
 * The label every vault already carries is its own wikilinks: a written pair is
 * two notes a human decided belong together. Over the candidate pairs this layer
 * sees, Youden's J between written and unwritten pairs peaks at 0.102 on a
 * 1199-note vault, 0.085 on a 797-note one and 0.075 on an 882-note one. 0.08 is
 * inside or within two points of all three.
 *
 * Note what the measurement rules OUT, which is the useful half: below 0.05 the
 * gate keeps written and unwritten pairs at the same rate — lift 1.00 on all
 * three vaults — so it is pure volume there and buys nothing. Do not "relax" it
 * to TEMPLATE_TAU again; that is 0.3.3's mistake and it doubled every proposal
 * count without adding one proposal a reader would take.
 *
 * The elbow of the retention curve says nothing here — Kneedle on it moves from
 * 0.08 to 0.26 depending only on where the grid stops. Re-measure with labels,
 * not with volume.
 *
 * It inherits TEMPLATE_TAU's ceiling and cannot be raised out of it. On the
 * journal fixture a daily-note pair sits at 0.111 when the journal is 60% of the
 * vault and at 0.784 when it is 14% — the DF cull only reaches the template once
 * the journal crosses DF_MAX, and under that no bar short of 0.79 touches the
 * class, which would take every real vault with it. Excluded folders are the
 * answer there, not this number. */
export const PROPOSE_TAU = 0.08;
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
// That gate clears the floor; it does not set the bar a proposal answers to,
// which is PROPOSE_TAU and four times higher.

/** Whether a pair overlaps enough, once the vault's ubiquitous stems are gone,
 * to be worth putting in front of a reader as a proposal. */
const worthProposing = (sets: Map<string, Set<string>>, a: string, b: string): boolean =>
  jaccard(sets.get(a) ?? EMPTY, sets.get(b) ?? EMPTY) >= PROPOSE_TAU;

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
  const sets = discriminatingSets(corpus);
  // A note this one already links has in-degree >= 1, so the link check is the
  // orphan check: no second filter needed.
  return relatedTo(corpus, path, Infinity, tau)
    .filter((r) => !deg.get(r.path) && worthProposing(sets, path, r.path))
    .slice(0, limit);
}

/** Notes that overlap this one above the structural bar with no wikilink either
 * way. Uses TAU, not LIST_TAU: proposing a link is a claim, not a suggestion.
 *
 * Out of an excluded note the bar is LIST_TAU instead, because there the claim
 * is not being made: nobody else's pane, graph or queue can ever show these
 * rows, so they are a suggestion to the one reader who opened a dashboard and
 * asked what the vault holds on the day. That reader wants the loose ones — the
 * tight ones are the notes they already linked on their way in. PROPOSE_TAU is
 * dropped there for the same reason it applies here: it is the bar of a claim,
 * and out of an excluded note no claim is being made. */
export function unlinkedNeighbours(corpus: Corpus, links: LinkTables, path: string, limit = 10): Related[] {
  const loose = corpus.excluded.has(path);
  const sets = discriminatingSets(corpus);
  return relatedTo(corpus, path, Infinity, loose ? LIST_TAU : TAU)
    .filter((r) => !isWritten(links, path, r.path) && (loose || worthProposing(sets, path, r.path)))
    .slice(0, limit);
}

/** Links written out of this note whose target shares almost no vocabulary with
 * it, usually the residue of a note that changed underneath the link. Index
 * notes are exempt: pointing at things they have nothing in common with is what
 * an index is for.
 *
 * An excluded note is exempt on the same grounds, by declaration rather than by
 * out-degree. A daily note is a dashboard: its links are to-dos and pointers,
 * about the day and not about the target, so the metric reads every honest one
 * as substanceless once the target is a real note — measured at 0.014 for a
 * 100-word target and 0.005 for a 400-word one, against a 0.02 bar. The
 * out-degree exemption cannot catch it, because a day writes two links, not
 * thirteen. */
export function staleLinks(corpus: Corpus, links: LinkTables, path: string, tau = STALE_TAU): Related[] {
  if (corpus.excluded.has(path)) return [];
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
    // The sweep reads eachPair directly rather than relatedTo, so the gate is
    // applied here by hand — on `dup`, which is already computed. Everything
    // below this line is a proposal, so it is PROPOSE_TAU, not the template
    // floor: a queue row costs a reader more than a list row, not less.
    if (isWritten(links, a, b) || dup < PROPOSE_TAU) return; // linked, or too thin to propose
    if (score >= TAU) {
      bump("missing", a, score);
      bump("missing", b, score);
    }
    if (!deg.get(b)) bump("orphans", a, score);
    if (!deg.get(a)) bump("orphans", b, score);
  });

  for (const [path, targets] of Object.entries(links.unresolved)) {
    const n = Object.keys(targets).length;
    // Excluded here too, and this is the branch that has to say so out loud: it
    // is the one signal that never touches a pair, so eachPair's skip above
    // cannot cover it. A journal is where unresolved link text is deliberate —
    // you type tomorrow's note name today — and it is the commonest thing in the
    // vault, so without this the queue is half diary and Next opens it first.
    if (n && corpus.counts.has(path) && !corpus.excluded.has(path)) bump("dangling", path, n, n);
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
