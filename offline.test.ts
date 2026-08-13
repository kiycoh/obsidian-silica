// The four offline algorithms, headless. One file: they share the corpus fixture
// and splitting it would only mean building the same vault four times.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCorpus, cleanBody, detectLang, stem, stemCounts, type Corpus, type CorpusVault } from "./corpus.ts";
import { allEdges, jaccard, relatedTo, topkSet } from "./correlate.ts";
import { buildGraph, communityLabels, layout } from "./graph.ts";
import { bm25, search, titleHits } from "./lexical.ts";
import { communityColor, louvain } from "./louvain.ts";

function makeVault(files: Record<string, string>, mtimes: Record<string, number> = {}): CorpusVault {
  return {
    getMarkdownFiles: () =>
      Object.keys(files).map((path) => ({
        path,
        basename: (path.replace(/\.md$/, "").split("/").pop() ?? path),
        stat: { mtime: mtimes[path] ?? 1 },
      })),
    cachedRead: async (f) => files[f.path],
  };
}

// Two topics that share nothing. Each note repeats its topic's vocabulary, which
// is what the top-k is meant to pick up.
const ROCKS = "granite basalt quartz mineral crystal granite basalt sediment stratum quartz";
const BIRDS = "sparrow finch plumage migration nesting sparrow finch feather beak plumage";
const FIXTURE = {
  "geo/granite.md": `${ROCKS} granite intrusion`,
  "geo/basalt.md": `${ROCKS} basalt flow`,
  "geo/quartz.md": `${ROCKS} quartz vein`,
  "bio/sparrow.md": `${BIRDS} sparrow song`,
  "bio/finch.md": `${BIRDS} finch beak`,
  "bio/plumage.md": `${BIRDS} plumage moult`,
};

// --- corpus ----------------------------------------------------------------

test("stemming collapses inflections without colliding on short words", () => {
  for (const [word, want] of [["links", "link"], ["linking", "link"], ["linked", "link"], ["queries", "query"]]) {
    assert.equal(stem(word, "en"), want, word);
  }
  // The s-stemmer's exception lists exist to stop exactly these being mangled.
  for (const word of ["process", "status", "goes", "its", "speed"]) assert.equal(stem(word, "en"), word, word);
  assert.equal(stem("casa", "it"), stem("case", "it"));
  assert.equal(stem("relazione", "it"), stem("relazioni", "it"));
});

test("detectLang picks the language whose function words hit, english on a tie", () => {
  assert.equal(detectLang("the note that you have with your own time"), "en");
  assert.equal(detectLang("questo che non per una della cosa quando"), "it");
  assert.equal(detectLang(""), "en");
});

test("cleanBody strips what a note is not about, keeps wikilink words", () => {
  const body = [
    "---", "tags: [x]", "---",
    "Prose about entropy.",
    "```py", "import numpy as np", "```",
    "Inline `os.path.join` and math $\\boldsymbol{x}$ and $$\\frac{a}{b}$$.",
    "See [[Kernel trick|the trick]] at https://example.com/frac",
  ].join("\n");
  const cleaned = cleanBody(body);
  for (const gone of ["tags", "numpy", "os.path", "boldsymbol", "frac", "example.com"]) {
    assert.equal(cleaned.includes(gone), false, gone);
  }
  assert.ok(cleaned.includes("entropy"));
  assert.ok(cleaned.includes("Kernel trick") && cleaned.includes("the trick")); // unwrapped, not dropped
  // The regression this exists for: a LaTeX-heavy note used to rank \frac and
  // \boldsymbol among its top stems, and they surfaced as community labels.
  assert.equal(stemCounts(body, "en").has("frac"), false);
});

test("stemCounts drops stopwords and sub-3-char tokens", () => {
  const counts = stemCounts("The cat and the cats ok", "en");
  assert.equal(counts.get("cat"), 2); // "cat" + "cats"
  assert.equal(counts.has("the"), false);
  assert.equal(counts.has("ok"), false); // shorter than MIN_TOKEN_LEN
});

test("a rebuild re-reads only the files whose mtime moved", async () => {
  const files = { "a.md": "alpha alpha beta", "b.md": "gamma delta" };
  const reads: string[] = [];
  const spy = (mtimes: Record<string, number>): CorpusVault => {
    const base = makeVault(files, mtimes);
    return {
      getMarkdownFiles: () => base.getMarkdownFiles(),
      cachedRead: async (f) => {
        reads.push(f.path);
        return base.cachedRead(f);
      },
    };
  };
  const first = await buildCorpus(spy({ "a.md": 1, "b.md": 1 }));
  reads.length = 0;
  files["a.md"] = "epsilon";
  const second = await buildCorpus(spy({ "a.md": 2, "b.md": 1 }), first);
  assert.deepEqual(reads, ["a.md"]);
  assert.equal(second.counts.get("a.md")?.has("epsilon"), true);
  assert.equal(second.counts.get("b.md"), first.counts.get("b.md")); // row reused, not rebuilt
});

// --- CORRELATE -------------------------------------------------------------

test("topkSet takes the highest counts, breaking ties lexicographically", () => {
  const counts = new Map([["rare", 1], ["common", 9], ["alpha", 1]]);
  assert.deepEqual([...topkSet(counts, 2)], ["common", "alpha"]);
});

test("jaccard is the overlap of the two sets, 0 on two empties", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
  assert.equal(jaccard(new Set(), new Set()), 0);
  assert.equal(jaccard(new Set(["a"]), new Set(["a"])), 1);
});

test("relatedTo finds the same-topic notes and no others", async () => {
  const corpus = await buildCorpus(makeVault(FIXTURE));
  const related = relatedTo(corpus, "geo/granite.md").map((r) => r.path);
  assert.deepEqual(related.sort(), ["geo/basalt.md", "geo/quartz.md"]);
  assert.equal(relatedTo(corpus, "bio/finch.md").every((r) => r.path.startsWith("bio/")), true);
});

test("allEdges reports each pair once, both directions folded", async () => {
  const corpus = await buildCorpus(makeVault(FIXTURE));
  const edges = allEdges(corpus);
  assert.equal(edges.length, 6); // two triangles
  assert.equal(new Set(edges.map(([a, b]) => `${a} ${b}`)).size, 6);
  assert.equal(edges.every(([a, b]) => a < b), true);
});

// --- BM25 ------------------------------------------------------------------

test("bm25 ranks the note the term is densest in first", async () => {
  const corpus = await buildCorpus(
    makeVault({
      "hit.md": "mitochondria mitochondria mitochondria cell",
      "mention.md": `mitochondria ${"filler ".repeat(200)}`,
      "miss.md": "sparrow finch plumage",
    }),
  );
  const hits = bm25(corpus, "mitochondria");
  assert.deepEqual(hits.map((h) => h.path), ["hit.md", "mention.md"]);
});

test("the title leg finds a note whose body never says the word", async () => {
  const corpus = await buildCorpus(makeVault({ "Kubernetes.md": "orchestration of containers" }));
  assert.equal(bm25(corpus, "kubernetes").length, 0);
  assert.equal(titleHits(corpus, "kubernetes")[0].path, "Kubernetes.md");
  assert.equal(search(corpus, "kubernetes")[0].path, "Kubernetes.md"); // fusion keeps it
});

// --- Louvain ---------------------------------------------------------------

test("louvain separates two cliques joined by one bridge", () => {
  const nodes = ["a", "b", "c", "x", "y", "z"];
  const edges: Array<[string, string, number]> = [
    ["a", "b", 1], ["b", "c", 1], ["a", "c", 1],
    ["x", "y", 1], ["y", "z", 1], ["x", "z", 1],
    ["c", "x", 1], // the single bridge must not merge them
  ];
  const com = louvain(nodes, edges);
  assert.equal(com.get("a"), com.get("b"));
  assert.equal(com.get("b"), com.get("c"));
  assert.equal(com.get("x"), com.get("y"));
  assert.equal(com.get("y"), com.get("z"));
  assert.notEqual(com.get("a"), com.get("x"));
});

test("louvain is deterministic and gives isolated nodes their own community", () => {
  const nodes = ["a", "b", "lonely"];
  const edges: Array<[string, string, number]> = [["a", "b", 1]];
  const first = louvain(nodes, edges);
  assert.deepEqual([...louvain(nodes, edges)], [...first]);
  assert.notEqual(first.get("lonely"), first.get("a"));
});

test("community colours stay on the brand arc", () => {
  for (let i = 0; i < 12; i++) {
    const hue = Number(/hsl\(([\d.]+)/.exec(communityColor(i, false))?.[1]);
    assert.ok(hue >= 212 && hue <= 306, `${i} -> ${hue}`);
  }
  assert.notEqual(communityColor(0, true), communityColor(0, false)); // paper has its own bands
});

// --- graph -----------------------------------------------------------------

test("buildGraph keeps the written layer when a pair is also inferred", async () => {
  const corpus = await buildCorpus(makeVault(FIXTURE));
  const graph = buildGraph(corpus, { "geo/granite.md": { "geo/basalt.md": 1 } });
  const written = graph.edges.filter((e) => !e.inferred);
  assert.equal(written.length, 1);
  const pair = [graph.nodes[written[0].a].path, graph.nodes[written[0].b].path].sort();
  assert.deepEqual(pair, ["geo/basalt.md", "geo/granite.md"]);
  assert.equal(graph.communities, 2); // geo and bio, from the same two triangles
});

test("the node cap truncates by degree and says how much it dropped", async () => {
  const corpus = await buildCorpus(makeVault(FIXTURE));
  const graph = buildGraph(corpus, {}, 4);
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.truncated, 2);
  assert.equal(graph.edges.every((e) => e.a < graph.nodes.length && e.b < graph.nodes.length), true);
});

test("layout spreads the bulk instead of packing it behind a few runaways", () => {
  // Four cliques of 30 plus 12 unconnected nodes. The loose ones are the test:
  // with nothing pulling them back they drift off, the min/max normalisation
  // rescales to fit them, and everything else lands in one corner. Measured on
  // the real vault first, reproduced here.
  const size = 30;
  const nodes = Array.from({ length: 4 * size + 12 }, (_, i) => ({
    path: `n${i}`, title: `n${i}`, deg: 1, community: Math.min(3, Math.floor(i / size)), x: 0, y: 0,
  }));
  const edges = [];
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < size; i++) {
      for (let j = i + 1; j < size; j++) edges.push({ a: c * size + i, b: c * size + j, w: 1, inferred: false });
    }
  }
  const graph = { nodes, edges, communities: 4, truncated: 0 };
  layout(graph, 120);
  // The middle 80% of the nodes, not the extremes, must cover most of the box:
  // that is what a runaway cannot fake. Collapsed this reads 0.19, healthy 0.78.
  const spread = (get: (n: (typeof nodes)[number]) => number) => {
    const v = nodes.map(get).sort((a, b) => a - b);
    return v[Math.floor(v.length * 0.9)] - v[Math.floor(v.length * 0.1)];
  };
  assert.ok(spread((n) => n.x) > 0.5, `x spread ${spread((n) => n.x).toFixed(3)}`);
  assert.ok(spread((n) => n.y) > 0.5, `y spread ${spread((n) => n.y).toFixed(3)}`);
});

test("layout lands every node in the unit box, same picture twice", async () => {
  const corpus = await buildCorpus(makeVault(FIXTURE));
  const a = buildGraph(corpus, {});
  const b = buildGraph(corpus, {});
  layout(a, 30);
  layout(b, 30);
  for (const node of a.nodes) {
    assert.ok(node.x >= 0 && node.x <= 1 && node.y >= 0 && node.y <= 1, `${node.path} ${node.x},${node.y}`);
  }
  assert.deepEqual(a.nodes.map((n) => [n.x, n.y]), b.nodes.map((n) => [n.x, n.y]));
});

test("community labels name what a community has and its neighbour does not", async () => {
  const corpus: Corpus = await buildCorpus(makeVault(FIXTURE));
  const graph = buildGraph(corpus, {});
  const labels = communityLabels(graph, corpus);
  assert.equal(labels.length, graph.communities);
  const joined = labels.join(" | ");
  assert.ok(/granit|basalt|quartz/.test(joined), joined);
  assert.ok(/sparrow|finch|plumag/.test(joined), joined);
});
