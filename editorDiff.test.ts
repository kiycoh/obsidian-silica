// The decoration layout, against a real CodeMirror document. Positions are the
// one thing reading the code cannot check: a block anchored one line off, or a
// tint left on a line the hunk no longer covers, both look fine in source.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Text } from "@codemirror/state";
import { WidgetType } from "@codemirror/view";

import { hunkRanges } from "./diff.ts";
import { hunkDecorations, placeWidget, widgetPos } from "./editorDiff.ts";

class Stub extends WidgetType {
  toDOM(): HTMLElement {
    throw new Error("not rendered in this test");
  }
}

/** Every decoration as (line number, what it is), which is what the reader sees. */
function layout(before: string, after: string): Array<[number, string]> {
  const doc = Text.of(after.split("\n"));
  const ranges = hunkDecorations(doc, hunkRanges(before, after), () => new Stub());
  return ranges.map((r) => [
    doc.lineAt(r.from).number,
    r.value.spec.widget ? "block" : "added",
  ]);
}

test("the block sits on the first added line, the tint on every added line", () => {
  // "b" out, "B\nB2" in: block above line 2, tint on lines 2 and 3.
  assert.deepEqual(layout("a\nb\nc", "a\nB\nB2\nc"), [
    [2, "block"], [2, "added"], [3, "added"],
  ]);
});

test("a pure insertion tints only what it inserted", () => {
  assert.deepEqual(layout("a\nc", "a\nb\nc"), [[2, "block"], [2, "added"]]);
});

test("a deletion carries no tint, only the block that shows what went", () => {
  assert.deepEqual(layout("a\nb\nc", "a\nc"), [[2, "block"]]);
});

test("a deletion off the end of the file anchors to the last line, not past it", () => {
  const doc = Text.of("a".split("\n"));
  const [h] = hunkRanges("a\nb", "a");
  assert.equal(h.afterStart, 1); // one line past the document
  assert.equal(widgetPos(doc, h), doc.length); // clamped, so lineAt() cannot throw
  assert.deepEqual(layout("a\nb", "a"), [[1, "block"]]);
});

test("an append at the end of the file tints the new last line", () => {
  assert.deepEqual(layout("a", "a\nb"), [[2, "block"], [2, "added"]]);
});

test("a created file is one block over the whole document", () => {
  assert.deepEqual(layout("", "a\nb"), [[1, "block"], [1, "added"], [2, "added"]]);
});

test("an emptied document still anchors its block at position zero", () => {
  assert.deepEqual(layout("a\nb", ""), [[1, "block"]]);
});

test("two distant edits stay two separate blocks", () => {
  assert.deepEqual(layout("a\nb\nc\nd\ne", "A\nb\nc\nd\nE"), [
    [1, "block"], [1, "added"], [5, "block"], [5, "added"],
  ]);
});

test("nothing changed, nothing decorated", () => {
  assert.deepEqual(layout("a\nb", "a\nb"), []);
});

// Live Preview replaces a callout with one rendered widget. Anything anchored
// inside that range is dropped before it reaches the DOM, which is why a write
// into a callout showed no review block at all until the block was hoisted.

test("a hunk inside a callout hoists its block above the callout", () => {
  const before = "intro\n> [!NOTE]\n> old line\n> tail\nafter";
  const after = "intro\n> [!NOTE]\n> new line\n> tail\nafter";
  // Line 2 is where the callout starts; the changed line is 3.
  assert.deepEqual(layout(before, after), [[2, "block"]]);
  const doc = Text.of(after.split("\n"));
  assert.equal(placeWidget(doc, hunkRanges(before, after)[0]).hoisted, true);
});

test("the hoisted block drops the tint, since the tinted line is replaced too", () => {
  // Same edit outside a callout keeps both, so the missing tint is the hoist,
  // not the diff.
  assert.deepEqual(layout("a\nold\nb", "a\nnew\nb"), [[2, "block"], [2, "added"]]);
  assert.deepEqual(layout("a\n> old\nb", "a\n> new\nb"), [[2, "block"]]);
});

test("a table row hoists to the head of its table", () => {
  const before = "text\n| a | b |\n| - | - |\n| 1 | 2 |\nend";
  const after = "text\n| a | b |\n| - | - |\n| 1 | 9 |\nend";
  assert.deepEqual(layout(before, after), [[2, "block"]]);
});

test("a hunk on a plain line is not hoisted and keeps its own position", () => {
  const doc = Text.of("a\nb\nc".split("\n"));
  const place = placeWidget(doc, hunkRanges("a\nx\nc", "a\nb\nc")[0]);
  assert.deepEqual(place, { pos: doc.line(2).from, hoisted: false });
});

test("two hunks in one callout collapse to one position, so keys must tell them apart", () => {
  const before = "> [!NOTE]\n> one\n> mid\n> two";
  const after = "> [!NOTE]\n> ONE\n> mid\n> TWO";
  const doc = Text.of(after.split("\n"));
  const hunks = hunkRanges(before, after);
  assert.equal(hunks.length, 2);
  const [p1, p2] = hunks.map((h) => placeWidget(doc, h).pos);
  assert.equal(p1, p2); // both blocks land on line 1 — position cannot disambiguate
});
