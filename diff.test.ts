import assert from "node:assert/strict";
import { test } from "node:test";

import { diffLines, hunks, tally, type DiffLine } from "./diff.ts";

const render = (lines: DiffLine[]) => lines.map((l) => l.op + l.text);

test("unchanged text is all context", () => {
  assert.deepEqual(render(diffLines("a\nb", "a\nb")), [" a", " b"]);
});

test("create and delete are one-sided", () => {
  assert.deepEqual(render(diffLines("", "new")), ["+new"]);
  assert.deepEqual(render(diffLines("old", "")), ["-old"]);
});

test("an edit in the middle keeps the surrounding lines as context", () => {
  assert.deepEqual(render(diffLines("a\nb\nc", "a\nB\nc")), [" a", "-b", "+B", " c"]);
});

test("scattered inserts stay separate instead of collapsing into one block", () => {
  const before = "one\ntwo\nthree\nfour\nfive";
  const after = "one\nINS1\ntwo\nthree\nfour\nINS2\nfive";
  assert.deepEqual(render(diffLines(before, after)), [
    " one", "+INS1", " two", " three", " four", "+INS2", " five",
  ]);
});

test("removals are emitted before additions at a change site", () => {
  const ops = diffLines("x\ny", "X\nY").map((l) => l.op);
  assert.deepEqual(ops, ["-", "-", "+", "+"]);
});

test("hunks elide long unchanged runs, merging edits that share context", () => {
  const lines = diffLines("a\nb\nc\nd\ne\nf\ng\nh", "a\nb\nc\nD\ne\nf\ng\nH");
  const groups = hunks(lines, 1);
  assert.equal(groups.length, 2);
  assert.deepEqual(render(groups[0]), [" c", "-d", "+D", " e"]);
  assert.deepEqual(render(groups[1]), [" g", "-h", "+H"]);
  // Whole-file diff untouched: only the view elides.
  assert.equal(lines.length, 10);
});

test("adjacent edits merge into a single hunk", () => {
  const lines = diffLines("a\nb\nc", "A\nb\nC");
  assert.equal(hunks(lines, 2).length, 1);
});

test("tally counts the gutter, not the context", () => {
  assert.deepEqual(tally(diffLines("a\nb\nc", "a\nX\nY\nc")), { added: 2, removed: 1 });
});

test("past the LCS cap the changed middle degrades to remove-then-add, never wrong", () => {
  const big = (mark: string) => Array.from({ length: 600 }, (_, i) => `${mark}${i}`).join("\n");
  const lines = diffLines("keep\n" + big("a"), "keep\n" + big("b"));
  assert.deepEqual(lines[0], { op: " ", text: "keep" });
  assert.deepEqual(tally(lines), { added: 600, removed: 600 });
  assert.equal(lines[1].op, "-"); // all removals, then all additions
  assert.equal(lines[601].op, "+");
});
