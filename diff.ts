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
    if (a[i] === b[j]) out.push({ op: " ", text: a[i++] }), j++;
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

export function tally(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "+") added++;
    else if (l.op === "-") removed++;
  }
  return { added, removed };
}
