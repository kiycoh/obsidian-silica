// Line diff for the changes panel — pure, so it runs headless under `node --test`.
// Common prefix/suffix trim, then an LCS walk over what's left: git's hunk shape
// in ~50 lines, which is why there is no bundled diff dependency.

export type Op = " " | "+" | "-";

export interface DiffLine {
  op: Op;
  text: string;
}

// ponytail: O(n*m) LCS table, capped. Past the cap the changed middle degrades to
// one remove-then-add block — coarser, never wrong. 2M cells is an 8 MB scratch
// array and a few ms, and covers ~1400 changed lines on each side; a 900-line note
// with edits every sixth line needed more than 250k to stay line-precise.
const MAX_LCS_CELLS = 2_000_000;

/** Line-level diff. An empty side means the file was created (all `+`) or deleted (all `-`). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const ctx = (text: string): DiffLine => ({ op: " ", text });
  return [
    ...a.slice(0, head).map(ctx),
    ...changed(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map(ctx),
  ];
}

function changed(a: string[], b: string[]): DiffLine[] {
  if (!a.length || !b.length || a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ op: "-", text })),
      ...b.map((text): DiffLine => ({ op: "+", text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w); // suffix LCS lengths; lcs[i*w+j] = |LCS(a[i:], b[j:])|
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i++] });
      j++;
    }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ op: "-", text: a[i++] }); // removals first
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}

/** Drop the unchanged stretches, keeping `context` lines around each edit. */
export function hunks(lines: DiffLine[], context = 2): DiffLine[][] {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].op === " ") continue;
    const lo = Math.max(0, i - context);
    const hi = Math.min(lines.length, i + context + 1);
    const last = spans[spans.length - 1];
    if (last && lo <= last[1]) last[1] = hi;
    else spans.push([lo, hi]);
  }
  return spans.map(([lo, hi]) => lines.slice(lo, hi));
}

/** One reviewable block: the lines it occupies on each side, and their text.
 * Both ranges are end-exclusive line indices, so a pure insertion has an empty
 * `before` range and a pure deletion an empty `after` one. */
export interface Hunk {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
  removed: string[];
  added: string[];
}

const split = (s: string): string[] => (s === "" ? [] : s.split("\n"));

/** The same runs of change `hunks` groups, but carrying line coordinates, which
 * is what accepting into the baseline and rejecting in the document both need. */
export function hunkRanges(before: string, after: string): Hunk[] {
  const out: Hunk[] = [];
  let b = 0;
  let a = 0;
  let cur: Hunk | null = null;
  for (const l of diffLines(before, after)) {
    if (l.op === " ") {
      cur = null;
      b++;
      a++;
      continue;
    }
    if (!cur) {
      cur = { beforeStart: b, beforeEnd: b, afterStart: a, afterEnd: a, removed: [], added: [] };
      out.push(cur);
    }
    // A run may interleave `-` and `+`, but each side still advances
    // contiguously, so one range per side covers the whole run.
    if (l.op === "-") {
      cur.beforeEnd = ++b;
      cur.removed.push(l.text);
    } else {
      cur.afterEnd = ++a;
      cur.added.push(l.text);
    }
  }
  return out;
}

/** Accept: the baseline absorbs the hunk, so the recomputed diff loses it while
 * the document keeps exactly the bytes it already had. */
export function acceptInBaseline(before: string, h: Hunk): string {
  const lines = split(before);
  lines.splice(h.beforeStart, h.beforeEnd - h.beforeStart, ...h.added);
  return lines.join("\n");
}

/** Reject: the character range of the hunk's added lines in `after`, and the
 * text that puts the removed lines back. Pure over a string so the newline
 * bookkeeping at both ends of the file is checked by asserts, not by an editor. */
export function rejectEdit(after: string, h: Hunk): { from: number; to: number; insert: string } {
  const lines = split(after);
  const offset = (i: number): number => {
    let n = 0;
    for (let k = 0; k < i; k++) n += lines[k].length + 1; // line plus its newline
    return n;
  };
  const text = h.removed.join("\n");
  // A hunk that stops short of the last line owns its trailing newlines, so the
  // replacement carries them too.
  if (h.afterEnd < lines.length) {
    return { from: offset(h.afterStart), to: offset(h.afterEnd), insert: h.removed.map((t) => `${t}\n`).join("") };
  }
  // A hunk that runs to end of file has no trailing newline to own. Unless it
  // starts the file, it takes over the newline that closes the line above,
  // which is what keeps a rejected last line from being glued to it.
  if (h.afterStart === 0) return { from: 0, to: after.length, insert: text };
  return { from: offset(h.afterStart) - 1, to: after.length, insert: text ? `\n${text}` : "" };
}

/** A block's identity by content alone, which is how Silica's writing is told
 * apart from the reader's. */
const sig = (h: Hunk): string => JSON.stringify([h.removed, h.added]);

/** Silica's blocks, as they stand in the note right now.
 *
 * `before → after` is what Silica wrote; `before → doc` is everything the note
 * differs by, the reader's own typing included. A block is reviewable only if
 * it is still character-for-character one of Silica's, so a paragraph the
 * reader wrote — or wrote over — is theirs and never comes up for review.
 * That is the whole rule: the reader's text is taken as it is. */
export function silicaHunks(before: string, after: string, doc: string): Hunk[] {
  const mine = new Set(hunkRanges(before, after).map(sig));
  return hunkRanges(before, doc).filter((h) => mine.has(sig(h)));
}

/** `doc` with those blocks put back — the Reject button in bulk. Applied bottom
 * -up, so the offsets of everything above each splice stay valid. */
export function revertHunks(doc: string, list: Hunk[]): string {
  let out = doc;
  for (const h of [...list].reverse()) {
    const { from, to, insert } = rejectEdit(out, h);
    out = out.slice(0, from) + insert + out.slice(to);
  }
  return out;
}

/** Silica's version with one block taken back out, matched by content: a block
 * rejected in the note has to leave `after` too, or `before === after` — the
 * test that says a file is fully reviewed — never comes true.
 * ponytail: two identical blocks in one file drop the first. Same text either
 * way; only which position survives differs. */
export function dropHunk(before: string, after: string, h: Hunk): string {
  const match = hunkRanges(before, after).find((s) => sig(s) === sig(h));
  return match ? revertHunks(after, [match]) : after;
}

export function tally(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "+") added++;
    else if (l.op === "-") removed++;
  }
  return { added, removed };
}
