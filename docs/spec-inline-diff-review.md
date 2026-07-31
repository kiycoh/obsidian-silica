# Inline diff review

Silica writes land on disk immediately. The reader needs to see what changed in
the note itself and keep or drop each block, the way a code review works.

## Model

The source of truth is the pair (`before`, current document). `before` is the
baseline snapshot the bridge already records in `Change`. Hunks are recomputed
from that pair, never tracked.

* **accept hunk**: move the baseline (`before` takes the hunk's added lines).
  The document is untouched, the hunk drops out of the recomputed diff.
* **reject hunk**: rewrite that range of the document with the removed lines.
  The baseline is untouched, the hunk drops out too.
* diff empty, the file leaves the changes panel.

Manual edits by the reader are free: the next recompute simply diffs against
whatever the document now holds.

## Units

**`diff.ts`** gains three pure functions, testable under `node --test`:

* `hunkRanges(before, after): Hunk[]`, where a `Hunk` carries the line range in
  both sides plus the removed and added lines.
* `acceptInBaseline(before, h): string`
* `rejectEdit(after, h): {from, to, insert}`, a character range in the document
  and its replacement. Pure over a string, so the newline bookkeeping at the
  start and end of file is covered by asserts instead of by CodeMirror.

**`editorDiff.ts`** is a CodeMirror `StateField`, not a `ViewPlugin`:
CodeMirror refuses block decorations from a plugin, and an editor that tries
throws `Block decorations may not be specified via plugins` and never finishes
opening. Per hunk the field emits a `Decoration.line` on each added line and one
block widget above, holding the removed lines and the accept/reject toolbar.
Pure additions still get the widget, with no removed lines in it. It recomputes
on file switch (Obsidian recycles editor views), on a `silicaRefresh` effect,
and 300 ms after the last keystroke; between keystrokes the decorations are
mapped through the changes so they stay aligned. A tiny companion `ViewPlugin`
owns only that timer and the registry that lets the plugin reach open editors.

**`main.ts`** registers the extension and owns the operations. In an open editor
a reject is a CodeMirror transaction, so Ctrl+Z restores it. From the panel the
file may be closed, so it goes through `vault.process`.

Non-modify changes revert for real: a created file goes to the trash, a deleted
one is recreated from the baseline, a renamed one goes back to its old path.

**Panel** header gets `Accept all` and `Reject all`. `Reject all` asks once and
reverts to its idle label after 5 s. `Clear` is removed, `Accept all` is the
same action under an honest name.

## Limit

The blocks render in Live Preview and Source mode. Reading view has no
CodeMirror editor, so a note read there shows the final text with no markers.
The panel stays the fallback for that case.
