import assert from "node:assert/strict";
import { test } from "node:test";

import { acceptInBaseline, diffLines, hunkRanges, hunks, rejectEdit, tally, type DiffLine, type Hunk } from "./diff.ts";

const render = (lines: DiffLine[]) => lines.map((l) => l.op + l.text);

const splice = (s: string, e: { from: number; to: number; insert: string }) =>
  s.slice(0, e.from) + e.insert + s.slice(e.to);

/** Every (before, after) shape the panel can hand the editor. */
const PAIRS: Array<[string, string]> = [
  ["a\nb\nc", "a\nB\nc"], // replace in the middle
  ["a\nb\nc", "X\nb\nc"], // replace the first line
  ["a\nb\nc", "a\nb\nZ"], // replace the last line
  ["a\nb", "a\nb\nc"], // append at end of file
  ["a\nb\nc", "a\nb"], // truncate at end of file
  ["b\nc", "a\nb\nc"], // insert at start
  ["a\nb\nc", "b\nc"], // delete at start
  ["a\nb\nc\nd\ne", "A\nb\nc\nd\nE"], // two hunks, far apart
  ["one", "two"], // whole file replaced
  ["", "a\nb"], // created
  ["a\nb", ""], // deleted
  ["a\nb", "a\nb"], // untouched
];

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

test("hunkRanges reports the line span each block covers on both sides", () => {
  // "b" becomes "B\nB2": one line out at 1, two lines in at 1.
  assert.deepEqual(hunkRanges("a\nb\nc", "a\nB\nB2\nc"), [
    { beforeStart: 1, beforeEnd: 2, afterStart: 1, afterEnd: 3, removed: ["b"], added: ["B", "B2"] },
  ]);
});

test("a pure insertion has an empty baseline span, a pure deletion an empty document span", () => {
  const [ins] = hunkRanges("a\nc", "a\nb\nc");
  assert.equal(ins.beforeStart, ins.beforeEnd);
  assert.deepEqual([ins.afterStart, ins.afterEnd, ins.added], [1, 2, ["b"]]);
  const [del] = hunkRanges("a\nb\nc", "a\nc");
  assert.equal(del.afterStart, del.afterEnd);
  assert.deepEqual([del.beforeStart, del.beforeEnd, del.removed], [1, 2, ["b"]]);
});

// The two operations the review buttons are made of. Applied last hunk first,
// so the ranges of the earlier ones stay valid against the untouched string.
test("accepting every hunk moves the baseline onto the document", () => {
  for (const [before, after] of PAIRS) {
    const got = hunkRanges(before, after).reduceRight((b: string, h: Hunk) => acceptInBaseline(b, h), before);
    assert.equal(got, after, `accept-all ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
});

test("rejecting every hunk puts the document back to the baseline", () => {
  for (const [before, after] of PAIRS) {
    const got = hunkRanges(before, after).reduceRight((d: string, h: Hunk) => splice(d, rejectEdit(after, h)), after);
    assert.equal(got, before, `reject-all ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
});

test("rejecting one hunk of many leaves the others standing", () => {
  const before = "a\nb\nc\nd\ne";
  const after = "A\nb\nc\nd\nE";
  const hs = hunkRanges(before, after);
  assert.equal(hs.length, 2);
  assert.equal(splice(after, rejectEdit(after, hs[1])), "A\nb\nc\nd\ne"); // last line back, first still changed
  assert.equal(splice(after, rejectEdit(after, hs[0])), "a\nb\nc\nd\nE");
});

test("past the LCS cap the changed middle degrades to remove-then-add, never wrong", () => {
  const big = (mark: string) => Array.from({ length: 600 }, (_, i) => `${mark}${i}`).join("\n");
  const lines = diffLines("keep\n" + big("a"), "keep\n" + big("b"));
  assert.deepEqual(lines[0], { op: " ", text: "keep" });
  assert.deepEqual(tally(lines), { added: 600, removed: 600 });
  assert.equal(lines[1].op, "-"); // all removals, then all additions
  assert.equal(lines[601].op, "+");
});
