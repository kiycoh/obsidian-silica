// The decoration layout, against a real CodeMirror document. Positions are the
// one thing reading the code cannot check: a block anchored one line off, or a
// tint left on a line the hunk no longer covers, both look fine in source.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Text } from "@codemirror/state";
import { WidgetType } from "@codemirror/view";

import { hunkRanges } from "./diff.ts";
import { hunkDecorations, widgetPos } from "./editorDiff.ts";

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
