import assert from "node:assert/strict";
import { test } from "node:test";

import { acceptInBaseline, diffLines, dropHunk, hunkRanges, hunks, rejectEdit, revertHunks, silicaHunks, tally, type DiffLine, type Hunk } from "./diff.ts";

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

// Review is over (baseline, Silica's version). The document is a third text the
// reader keeps typing into, and only blocks that are still exactly Silica's are
// offered for review — the reader's own writing is taken as it is.
test("the reader's own lines are not reviewable blocks", () => {
  const before = "a\nb\nc";
  const after = "a\nSILICA\nc"; // what Silica wrote
  const doc = "a\nSILICA\nc\nMINE"; // the reader then added a line of their own
  const hs = silicaHunks(before, after, doc);
  assert.equal(hs.length, 1);
  assert.deepEqual(hs[0].added, ["SILICA"]);
  // Located in the document, not in `after`: the buttons splice against the doc.
  assert.equal(splice(doc, rejectEdit(doc, hs[0])), "a\nb\nc\nMINE"); // their line survives
});

test("a block the reader typed over stops being Silica's", () => {
  assert.deepEqual(silicaHunks("a\nb\nc", "a\nSILICA\nc", "a\nSILICA, edited\nc"), []);
  // …and a note Silica never touched around the reader's work offers nothing.
  assert.deepEqual(silicaHunks("a\nb", "a\nb", "a\nb\nMINE"), []);
});

test("taking back every block leaves the reader's own lines standing", () => {
  // What "Reject all" is made of: revert Silica's blocks, located in the file as
  // it stands rather than in the version Silica left behind.
  const [before, after, now] = ["a\nb\nc", "a\nSILICA\nc", "a\nSILICA\nc\nMINE"];
  assert.equal(revertHunks(now, silicaHunks(before, after, now)), "a\nb\nc\nMINE");
  // A file Silica created and left alone comes back empty, which is the caller's
  // cue to trash it.
  assert.equal(revertHunks("SILICA", silicaHunks("", "SILICA", "SILICA")), "");
  // But once the reader has written in that file there is no block to take back:
  // an empty baseline makes the whole file one block, and a block they typed in
  // is theirs. The file stays as it is rather than being trashed under them.
  assert.deepEqual(silicaHunks("", "SILICA", "SILICA\nMINE"), []);
});

test("reverting every block puts the document back to the baseline", () => {
  for (const [before, after] of PAIRS) {
    assert.equal(revertHunks(after, hunkRanges(before, after)), before, `revert-all ${JSON.stringify(after)}`);
  }
});

test("dropping every block from Silica's version leaves it agreeing with the baseline", () => {
  for (const [before, after] of PAIRS) {
    let version = after;
    // One at a time, resolved by content against the shrinking version — which is
    // exactly how the Reject button feeds them in, one click after another.
    for (const h of hunkRanges(before, after)) version = dropHunk(before, version, h);
    assert.equal(version, before, `drop-all ${JSON.stringify(after)}`);
  }
});

test("past the LCS cap the changed middle degrades to remove-then-add, never wrong", () => {
  const big = (mark: string) => Array.from({ length: 600 }, (_, i) => `${mark}${i}`).join("\n");
  const lines = diffLines("keep\n" + big("a"), "keep\n" + big("b"));
  assert.deepEqual(lines[0], { op: " ", text: "keep" });
  assert.deepEqual(tally(lines), { added: 600, removed: 600 });
  assert.equal(lines[1].op, "-"); // all removals, then all additions
  assert.equal(lines[601].op, "+");
});
