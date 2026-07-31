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
  acceptHunk(path: string, hunk: Hunk, doc: string): void;
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

/** Where a hunk's block sits: the start of its first added line, or end of file
 * for a hunk that only removed lines from the tail. Shared by the builder and
 * the click resolver, which is what lets a click match a freshly computed hunk. */
export function widgetPos(doc: Text, h: Hunk): number {
  return h.afterStart >= doc.lines ? doc.length : doc.line(h.afterStart + 1).from;
}

/** One block above each hunk, plus a tint on every line it added. Split out so
 * the end-of-file cases are checked by asserts against a real document. */
export function hunkDecorations(doc: Text, hunks: Hunk[], widget: (h: Hunk) => WidgetType): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = [];
  for (const h of hunks) {
    // A hunk that only deleted the tail has no line of its own to sit above.
    const atEof = h.afterStart >= doc.lines;
    ranges.push(Decoration.widget({ widget: widget(h), block: true, side: atEof ? 1 : -1 }).range(widgetPos(doc, h)));
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
  act: Act;

  constructor(key: string, removed: string[], act: Act) {
    super();
    this.key = key;
    this.removed = removed;
    this.act = act;
  }

  eq(other: HunkWidget): boolean {
    return other.key === this.key;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("div");
    box.addClass("silica-cm-hunk");
    const bar = box.createDiv({ cls: "silica-cm-bar" });
    bar.createSpan({ cls: "silica-cm-tag", text: "Silica" });
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
    return box;
  }
}

export function silicaDiff(host: DiffHost, filePath: PathOf): Extension {
  /** Resolve the clicked block against the document as it stands. A click can
   * land inside the debounce window, and a stale range would splice the wrong
   * lines; an edit that dissolved the hunk simply finds nothing and no-ops. */
  const act: Act = (dom, view, accept) => {
    const path = filePath(view.state);
    if (!path) return;
    const { doc } = view.state;
    const text = doc.toString();
    const pos = view.posAtDOM(dom);
    const hunk = host.hunksFor(path, text).find((h) => widgetPos(doc, h) === pos);
    if (!hunk) return;
    if (accept) host.acceptHunk(path, hunk, text);
    else host.rejectHunk(path, hunk, view);
  };

  const build = (state: EditorState): DecorationSet => {
    const { doc } = state;
    const path = filePath(state);
    const hunks = path ? host.hunksFor(path, doc.toString()) : [];
    // The key carries the block's content, so CodeMirror redraws a widget whose
    // lines changed and leaves an untouched one alone.
    const ranges = hunkDecorations(doc, hunks, (h) => new HunkWidget(
      [path, h.afterStart, h.removed.join("\n"), h.added.join("\n")].join("|"),
      h.removed,
      act,
    ));
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
