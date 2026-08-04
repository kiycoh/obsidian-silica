// The maintenance signals and the two search additions, headless.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adoptableOrphans,
  attentionQueue,
  danglingLinks,
  discriminatingSets,
  inDegrees,
  nearDuplicates,
  noteSignals,
  staleLinks,
  unlinkedNeighbours,
  type LinkTables,
} from "./attention.ts";
import { buildCorpus, type CorpusFile, type CorpusVault } from "./corpus.ts";
import { inScope, snippet, splitScope } from "./lexical.ts";

function makeVault(files: Record<string, string>): CorpusVault {
  return {
    getMarkdownFiles: (): CorpusFile[] =>
      Object.keys(files).map((path) => ({
        path,
        basename: path.replace(/\.md$/, "").split("/").pop() ?? path,
        stat: { mtime: 1 },
      })),
    cachedRead: async (f) => files[f.path],
  };
}

const NO_LINKS: LinkTables = { resolved: {}, unresolved: {} };

// A vault written from a template: every note carries the same six scaffolding
// words. Past DF_MIN_NOTES that scaffolding is what the DF filter exists to
// remove, and 20 filler notes are what push the corpus over that line.
const BOILER = "agenda attendee action item recap followup";
const ROCKS = "granite basalt quartz mineral crystal sediment stratum feldspar olivine gabbro dolerite marble";
const ROCKS_COPY = "granite basalt quartz mineral crystal sediment stratum feldspar olivine gabbro dolerite gneiss";
// Half of ROCKS and half of its own: related well past the orphan bar, nowhere
// near the duplicate bar.
const ROCKS_NEAR = "granite basalt quartz mineral crystal sediment shale chert breccia arkose chalk flint";
const BIRDS = "granite basalt quartz mineral sparrow finch plumage nesting beak feather talon crest";

const TEMPLATED: Record<string, string> = {
  "copy-a.md": `${BOILER} ${ROCKS}`,
  "copy-b.md": `${BOILER} ${ROCKS_COPY}`,
  "orphan.md": `${BOILER} ${ROCKS_NEAR}`,
  "topic.md": `${BOILER} ${BIRDS}`,
};
for (let i = 0; i < 20; i++) TEMPLATED[`filler-${i}.md`] = `${BOILER} unique${"x".repeat(i + 1)}`;

/** Everything pointed at except orphan.md, so exactly one note is an orphan and
 * the tests below can say which note the signal is filed against. */
const ONE_ORPHAN: LinkTables = {
  resolved: {
    "topic.md": { "copy-a.md": 1 },
    "copy-a.md": { "copy-b.md": 1 },
    "copy-b.md": { "topic.md": 1 },
  },
  unresolved: {},
};

const corpusOf = (files: Record<string, string>) => buildCorpus(makeVault(files));

// --- the DF filter ---------------------------------------------------------

test("the template's own words are dropped from every note's set", async () => {
  const sets = discriminatingSets(await corpusOf(TEMPLATED));
  for (const word of BOILER.split(" ")) {
    assert.equal(sets.get("copy-a.md")?.has(word), false, word);
  }
  assert.equal(sets.get("copy-a.md")?.has("granite"), true);
  // Two filler notes are left sharing nothing at all, which is the point: the
  // template was the only thing they had in common.
  assert.equal(sets.get("filler-0.md")?.size, 1);
});

test("a small vault keeps every stem: a share means nothing at that size", async () => {
  const sets = discriminatingSets(await corpusOf({ "a.md": BOILER, "b.md": BOILER, "c.md": BOILER }));
  assert.equal(sets.get("a.md")?.has("agenda"), true);
});

// --- near-duplicates -------------------------------------------------------

test("near-duplicates catch the copy and not the same-subject note", async () => {
  const corpus = await corpusOf(TEMPLATED);
  const dups = nearDuplicates(corpus, "copy-a.md");
  assert.deepEqual(dups.map((d) => d.path), ["copy-b.md"]);
  assert.ok(dups[0].score > 0.8, `${dups[0].score}`);
  // topic.md shares four rock words with copy-a and the whole template, which is
  // exactly the pair a raw top-30 Jaccard would have called a duplicate.
  assert.equal(nearDuplicates(corpus, "topic.md").length, 0);
});

test("notes that share only the template are not duplicates of each other", async () => {
  const corpus = await corpusOf(TEMPLATED);
  assert.equal(nearDuplicates(corpus, "filler-3.md").length, 0);
});

// --- orphans and missing links --------------------------------------------

test("an orphan surfaces from the note that could adopt it, and stops when linked", async () => {
  const corpus = await corpusOf(TEMPLATED);
  assert.deepEqual(
    adoptableOrphans(corpus, ONE_ORPHAN, "copy-a.md").map((r) => r.path),
    ["orphan.md"],
  );
  const adopted: LinkTables = {
    resolved: { ...ONE_ORPHAN.resolved, "copy-a.md": { "copy-b.md": 1, "orphan.md": 1 } },
    unresolved: {},
  };
  assert.deepEqual(adoptableOrphans(corpus, adopted, "copy-a.md"), []);
});

test("the template gate keeps filler notes out of the link proposals", async () => {
  const corpus = await corpusOf(TEMPLATED);
  // Raw CORRELATE relates every filler to every other well above TAU, because
  // the template IS their top-30. Nothing may be proposed between them.
  assert.equal(unlinkedNeighbours(corpus, NO_LINKS, "filler-3.md").length, 0);
  assert.equal(adoptableOrphans(corpus, NO_LINKS, "filler-3.md").length, 0);
});

test("a written link either way retires the proposal", async () => {
  const corpus = await corpusOf(TEMPLATED);
  const has = (links: LinkTables) =>
    unlinkedNeighbours(corpus, links, "copy-a.md").some((r) => r.path === "copy-b.md");
  assert.equal(has(NO_LINKS), true);
  assert.equal(has({ resolved: { "copy-a.md": { "copy-b.md": 1 } }, unresolved: {} }), false);
  assert.equal(has({ resolved: { "copy-b.md": { "copy-a.md": 1 } }, unresolved: {} }), false);
});

// --- stale and dangling ----------------------------------------------------

test("a link between notes with nothing in common is stale; an index is exempt", async () => {
  const corpus = await corpusOf(TEMPLATED);
  const links: LinkTables = { resolved: { "copy-a.md": { "filler-1.md": 1, "copy-b.md": 1 } }, unresolved: {} };
  assert.deepEqual(staleLinks(corpus, links, "copy-a.md").map((r) => r.path), ["filler-1.md"]);

  const index: LinkTables = { resolved: { "copy-a.md": {} }, unresolved: {} };
  for (let i = 0; i < 20; i++) index.resolved["copy-a.md"][`filler-${i}.md`] = 1;
  assert.deepEqual(staleLinks(corpus, index, "copy-a.md"), []);
});

test("dangling links are the unresolved table, sorted", () => {
  const links: LinkTables = { resolved: {}, unresolved: { "a.md": { Zeta: 1, Alpha: 2 } } };
  assert.deepEqual(danglingLinks(links, "a.md"), ["Alpha", "Zeta"]);
  assert.deepEqual(danglingLinks(links, "b.md"), []);
});

test("in-degree counts who points at a note, not who it points at", () => {
  const deg = inDegrees({ resolved: { "a.md": { "b.md": 1 }, "c.md": { "b.md": 2 } }, unresolved: {} });
  assert.equal(deg.get("b.md"), 3);
  assert.equal(deg.get("a.md"), undefined);
});

// --- the queue -------------------------------------------------------------

test("the queue files an orphan against its rescuer, never against the orphan", async () => {
  const queue = attentionQueue(await corpusOf(TEMPLATED), ONE_ORPHAN);
  const rescuer = queue.find((r) => r.path === "copy-a.md");
  assert.ok(rescuer, "copy-a should be in the queue");
  assert.match(rescuer.reason, /orphan to adopt/);
  // The orphan is in the queue for its own reasons, but landing a reader on it
  // to adopt something would be landing them on a panel with nothing to offer.
  const orphan = queue.find((r) => r.path === "orphan.md");
  assert.ok(orphan);
  assert.equal(orphan.reason.includes("orphan to adopt"), false);
});

test("a near-duplicate pair says the bigger thing, not also 'unlinked'", async () => {
  const queue = attentionQueue(await corpusOf(TEMPLATED), ONE_ORPHAN);
  const row = queue.find((r) => r.path === "copy-b.md");
  assert.ok(row);
  assert.match(row.reason, /1 near-duplicate/);
});

test("the queue counts broken links and says so in words", async () => {
  const corpus = await corpusOf(TEMPLATED);
  const links: LinkTables = { resolved: {}, unresolved: { "topic.md": { Ghost: 1, Missing: 1 } } };
  const row = attentionQueue(corpus, links).find((r) => r.path === "topic.md");
  assert.ok(row);
  assert.match(row.reason, /2 broken links/);
});

test("a template-only vault produces an empty queue", async () => {
  const filler: Record<string, string> = {};
  for (let i = 0; i < 24; i++) filler[`filler-${i}.md`] = `${BOILER} unique${"x".repeat(i + 1)}`;
  assert.deepEqual(attentionQueue(await corpusOf(filler), NO_LINKS), []);
});

test("noteSignals marks the unlinked rows of the related list", async () => {
  const corpus = await corpusOf(TEMPLATED);
  const signals = noteSignals(corpus, NO_LINKS, "copy-a.md");
  assert.ok(signals.related.some((r) => r.path === "copy-b.md"));
  assert.equal(signals.unlinked.has("copy-b.md"), true);
  assert.equal(signals.duplicates[0].path, "copy-b.md");
});

// --- search additions ------------------------------------------------------

test("path: is peeled off the query and scopes by prefix", () => {
  assert.deepEqual(splitScope("kernel path:notes/geo/ trick"), { query: "kernel trick", scope: "notes/geo/" });
  assert.deepEqual(splitScope("plain query"), { query: "plain query", scope: "" });
  assert.equal(inScope("Notes/Geo/granite.md", "notes/geo/"), true);
  assert.equal(inScope("bio/finch.md", "notes/geo/"), false);
  assert.equal(inScope("anything.md", ""), true);
});

test("the snippet centres on the first match and marks every occurrence", () => {
  const body = `---\ntags: [x]\n---\nThe quartz vein runs east. Later the quartz reappears.`;
  const pieces = snippet(body, "quartz");
  assert.equal(pieces.some((p) => p.text.includes("tags")), false); // frontmatter gone
  assert.deepEqual(pieces.filter((p) => p.hit).map((p) => p.text), ["quartz", "quartz"]);
  assert.match(pieces.map((p) => p.text).join(""), /vein runs east/);
});

test("a snippet from deep in a long note is elided on both sides", () => {
  const body = `${"filler ".repeat(200)}needle${" filler".repeat(200)}`;
  const pieces = snippet(body, "needle");
  assert.equal(pieces[0].text, "…");
  assert.equal(pieces[pieces.length - 1].text, "…");
  assert.ok(pieces.some((p) => p.hit && p.text === "needle"));
});

test("a query that matches no text still returns the note's opening", () => {
  const pieces = snippet("Opening words of the note.", "absent");
  assert.equal(pieces.every((p) => !p.hit), true);
  assert.match(pieces.map((p) => p.text).join(""), /^Opening words/);
});
