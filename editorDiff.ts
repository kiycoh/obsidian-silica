// Inline review of Silica's writes, inside the note itself. Each hunk gets its
// added lines tinted and a block above holding the lines it replaced plus an
// accept/reject pair, so the reader keeps or drops one block at a time.
//
// Only Live Preview and Source mode carry a CodeMirror editor, so Reading view
// shows the final text with no markers. The changes panel covers that case.

import type { EditorState, Extension, Range, Text } from "@codemirror/state";
import { StateEffect, StateField } from "@codemirror/state";
import type { DecorationSet, PluginValue, ViewUpdate } from "@codemirror/view";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";

import { type Hunk } from "./diff.ts";

/** Recompute now. Dispatched by the plugin after a write, and by the debounce. */
export const silicaRefresh = StateEffect.define<null>();

/** What the extension needs from the plugin. An interface rather than the class
 * so main.ts can import this module without the import cycle going both ways. */
export interface DiffHost {
  hunksFor(path: string, doc: string): Hunk[];
  acceptHunk(path: string, hunk: Hunk): void;
  rejectHunk(path: string, hunk: Hunk, view: EditorView): void;
}

/** Which note an editor is showing. Passed in rather than read from Obsidian
 * here, which keeps this module to CodeMirror and testable under `node --test`. */
export type PathOf = (state: EditorState) => string | null;

const RECOMPUTE_DELAY = 300; // ms after the last keystroke

// ponytail: a module-level registry, so the plugin can reach every live editor
// without casting through Obsidian's private `editor.cm`. destroy() empties it.
const live = new Set<{ refresh(): void }>();

/** Repaint every open editor. Called after each write Silica reports. */
export function refreshEditors(): void {
  for (const v of live) v.refresh();
}

// Live Preview replaces a whole callout, blockquote or table with one rendered
// widget, and a decoration anchored INSIDE a replaced range never reaches the
// DOM. A hunk landing in one used to lose both its block and its line tint, so
// a write into a callout was reviewable only from the changes panel. Hoisting
// the block to the line the construct starts on puts it outside that range.
// ponytail: `>` and `|` cover callouts, quotes and tables. Math blocks and
// embeds replace too; add their markers here if a write ever lands in one.
const BLOCK_LINE = /^\s{0,3}(>|\|)/;

export interface Placement {
  pos: number;
  /** True when the block had to move above a replaced construct. The caller
   * shows the added lines inside the block then: the tint cannot land either. */
  hoisted: boolean;
}

/** Where a hunk's block sits: the start of its first added line, hoisted above
 * any replaced construct that line belongs to, or end of file for a hunk that
 * only removed lines from the tail. Shared by the builder and the click
 * resolver, which is what lets a click match a freshly computed hunk. */
export function placeWidget(doc: Text, h: Hunk): Placement {
  if (h.afterStart >= doc.lines) return { pos: doc.length, hoisted: false };
  let line = h.afterStart + 1; // 1-based, as CodeMirror counts them
  if (!BLOCK_LINE.test(doc.line(line).text)) return { pos: doc.line(line).from, hoisted: false };
  while (line > 1 && BLOCK_LINE.test(doc.line(line - 1).text)) line--;
  return { pos: doc.line(line).from, hoisted: true };
}

export function widgetPos(doc: Text, h: Hunk): number {
  return placeWidget(doc, h).pos;
}

/** One block above each hunk, plus a tint on every line it added. Split out so
 * the end-of-file cases are checked by asserts against a real document. */
export function hunkDecorations(
  doc: Text,
  hunks: Hunk[],
  widget: (h: Hunk, hoisted: boolean) => WidgetType,
): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = [];
  for (const h of hunks) {
    // A hunk that only deleted the tail has no line of its own to sit above.
    const atEof = h.afterStart >= doc.lines;
    const { pos, hoisted } = placeWidget(doc, h);
    ranges.push(Decoration.widget({ widget: widget(h, hoisted), block: true, side: atEof ? 1 : -1 }).range(pos));
    if (hoisted) continue; // the tinted lines are inside the replaced range too
    for (let i = h.afterStart; i < h.afterEnd && i < doc.lines; i++) {
      ranges.push(Decoration.line({ class: "silica-cm-added" }).range(doc.line(i + 1).from));
    }
  }
  return ranges;
}

type Act = (dom: HTMLElement, view: EditorView, accept: boolean) => void;

// Plain fields rather than constructor parameter properties: `node --test`
// strips types without transforming, and that sugar is not JavaScript on its own.
class HunkWidget extends WidgetType {
  key: string;
  removed: string[];
  added: string[];
  /** Hoisted above a replaced construct, so the added lines have no tint of
   * their own and the block has to carry both sides. */
  hoisted: boolean;
  act: Act;

  constructor(key: string, removed: string[], added: string[], hoisted: boolean, act: Act) {
    super();
    this.key = key;
    this.removed = removed;
    this.added = added;
    this.hoisted = hoisted;
    this.act = act;
  }

  eq(other: HunkWidget): boolean {
    return other.key === this.key && other.hoisted === this.hoisted;
  }

  toDOM(view: EditorView): HTMLElement {
    // `silica-cm-cut` rather than a `:has(.silica-cm-removed)` rule: the widget
    // already knows whether it dropped lines, and `:has` invalidates broadly.
    const box = createDiv({ cls: this.removed.length ? "silica-cm-hunk silica-cm-cut" : "silica-cm-hunk" });
    // The key rides on the node so a click resolves to its own hunk. Two hunks
    // inside one callout hoist to the same position, and a position alone would
    // send both clicks to whichever came first.
    box.dataset.silicaKey = this.key;
    const bar = box.createDiv({ cls: "silica-cm-bar" });
    bar.createSpan({ cls: "silica-cm-tag", text: this.hoisted ? "Silica, in the block below" : "Silica" });
    const add = (label: string, accept: boolean) => {
      const b = bar.createEl("button", { cls: `silica-cm-btn silica-cm-${accept ? "accept" : "reject"}`, text: label });
      b.setAttribute("aria-label", accept ? "Accept this change" : "Reject this change, restoring the previous text");
      b.onclick = () => this.act(box, view, accept);
    };
    add("✓ Accept", true);
    add("✗ Reject", false);
    // Sign and colour both: the removed lines never rely on red alone.
    for (const text of this.removed) {
      box.createDiv({ cls: "silica-cm-removed", text: `-${text}` });
    }
    // Only when hoisted. Everywhere else the added lines are right there in the
    // document under a green tint, and repeating them would double the block.
    if (this.hoisted) {
      for (const text of this.added) {
        box.createDiv({ cls: "silica-cm-inserted", text: `+${text}` });
      }
    }
    return box;
  }
}

/** Identity of a hunk within a note. Content-derived, so a widget whose lines
 * changed is redrawn and an untouched one is left alone. */
const keyOf = (path: string, h: Hunk): string =>
  [path, h.afterStart, h.removed.join("\n"), h.added.join("\n")].join("|");

export function silicaDiff(host: DiffHost, filePath: PathOf): Extension {
  /** Resolve the clicked block against the document as it stands. A click can
   * land inside the debounce window, and a stale range would splice the wrong
   * lines; an edit that dissolved the hunk simply finds nothing and no-ops. */
  const act: Act = (dom, view, accept) => {
    const path = filePath(view.state);
    if (!path) return;
    const { doc } = view.state;
    const text = doc.toString();
    const hunks = host.hunksFor(path, text);
    // Match on the block's own key, falling back to its position for a widget
    // drawn before this rule existed. An edit that dissolved the hunk matches
    // nothing and no-ops, which is the point of re-resolving against live text.
    const key = dom.dataset.silicaKey;
    const hunk = hunks.find((h) => keyOf(path, h) === key) ?? hunks.find((h) => widgetPos(doc, h) === view.posAtDOM(dom));
    if (!hunk) return;
    if (accept) host.acceptHunk(path, hunk);
    else host.rejectHunk(path, hunk, view);
  };

  const build = (state: EditorState): DecorationSet => {
    const { doc } = state;
    const path = filePath(state);
    const hunks = path ? host.hunksFor(path, doc.toString()) : [];
    const ranges = hunkDecorations(doc, hunks, (h, hoisted) =>
      new HunkWidget(keyOf(path as string, h), h.removed, h.added, hoisted, act));
    return Decoration.set(ranges, true);
  };

  // A state field, not a view plugin: CodeMirror refuses block decorations from
  // a plugin, because it needs the block structure before it measures.
  const field = StateField.define<DecorationSet>({
    create: build,
    update(deco, tr) {
      if (tr.effects.some((e) => e.is(silicaRefresh))) return build(tr.state);
      // Obsidian recycles editor views across files, so the path is checked, not assumed.
      if (filePath(tr.startState) !== filePath(tr.state)) return build(tr.state);
      // Map now so the blocks stay put under the cursor; the authoritative pass
      // is O(n*m) and would stutter if it ran at keystroke rate.
      return tr.docChanged ? deco.map(tr.changes) : deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // All this plugin does is own the debounce timer and stay reachable, so the
  // plugin can ask every open editor to re-diff after a write.
  class Ticker implements PluginValue {
    view: EditorView;
    private timer = 0;

    constructor(view: EditorView) {
      this.view = view;
      live.add(this);
    }

    update(u: ViewUpdate): void {
      if (!u.docChanged) return;
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.refresh(), RECOMPUTE_DELAY);
    }

    destroy(): void {
      live.delete(this);
      window.clearTimeout(this.timer);
    }

    refresh(): void {
      this.view.dispatch({ effects: silicaRefresh.of(null) });
    }
  }

  return [field, ViewPlugin.fromClass(Ticker)];
}
