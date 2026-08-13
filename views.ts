// The offline surfaces: the note panel, ranked search, community graph. None of
// them talks to the bridge — they read the vault and the corpus index, so they
// work with the agent switched off.

import { ItemView, Notice, SuggestModal, TFile, setIcon, type App, type WorkspaceLeaf } from "obsidian";

import { attentionQueue, noteSignals, type AttentionRow, type LinkTables } from "./attention.ts";
import type { Corpus } from "./corpus.ts";
import type { Related } from "./correlate.ts";
import { buildGraph, communityLabels, layout, MAX_NODES, type Graph } from "./graph.ts";
import { search, snippet, splitScope, type Hit, type Piece } from "./lexical.ts";
import { communityColor } from "./louvain.ts";

export const RELATED_VIEW = "silica-related-view";
export const GRAPH_VIEW = "silica-graph-view";

/** What both views need from the plugin: the vault and a corpus that is current. */
export interface IndexHost {
  app: App;
  corpus(): Promise<Corpus>;
}

const isPaper = () => document.body.classList.contains("theme-light");
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const tablesOf = (app: App): LinkTables => ({
  resolved: app.metadataCache.resolvedLinks,
  unresolved: app.metadataCache.unresolvedLinks,
});

// --- The note panel --------------------------------------------------------

/** Everything the vault has to say about the note in front of you: what it is
 * about the same thing as, what looks like a copy of it, which orphans it could
 * adopt, which of its links have gone hollow, which point at nothing.
 *
 * Obsidian's backlinks pane answers "who linked here". This answers "who is
 * about the same thing", which nobody had to link, and then what is wrong.
 *
 * The sections are per-note and cost what relatedTo() already costs. The one
 * global computation is the Next button, and it happens on a press.
 */
export class NoteView extends ItemView {
  private host: IndexHost;
  private listEl!: HTMLElement;
  private forPath: string | null = null;
  private folderOnly = false;
  /** The attention queue and how far into it the reader has walked. Recomputed
   * when it runs out, never persisted: the signal is the state, so a note that
   * got fixed simply stops qualifying on the next sweep. */
  private queue: AttentionRow[] = [];
  private cursor = 0;

  constructor(leaf: WorkspaceLeaf, host: IndexHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string { return RELATED_VIEW; }
  getDisplayText(): string { return "Note panel"; }
  getIcon(): string { return "git-compare-arrows"; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("silica-related");
    const bar = this.contentEl.createDiv({ cls: "silica-note-bar" });
    const next = bar.createEl("button", { cls: "silica-quiet silica-note-next" });
    setIcon(next, "arrow-right");
    next.createSpan({ text: "Next" });
    next.setAttribute("aria-label", "Open the next note that needs attention");
    next.onclick = () => void this.next();
    const scope = bar.createEl("label", { cls: "silica-note-scope" });
    const box = scope.createEl("input", { type: "checkbox" });
    scope.createSpan({ text: "This folder only" });
    box.onchange = () => {
      this.folderOnly = box.checked;
      void this.refresh();
    };
    this.listEl = this.contentEl.createDiv();
    await this.refresh();
  }

  /** Walk the vault's attention queue, one note per press. */
  async next(): Promise<void> {
    const corpus = await this.host.corpus();
    if (this.cursor >= this.queue.length) {
      this.queue = attentionQueue(corpus, tablesOf(this.app));
      this.cursor = 0;
    }
    const here = this.app.workspace.getActiveFile()?.path;
    let row = this.queue[this.cursor++];
    if (row && row.path === here) row = this.queue[this.cursor++]; // never "next" onto where you already are
    if (!row) {
      new Notice("Silica: nothing in the vault is asking for attention.");
      return;
    }
    new Notice(`${corpus.titles.get(row.path) ?? row.path}: ${row.reason}`);
    await this.app.workspace.openLinkText(row.path, "", false);
  }

  async refresh(): Promise<void> {
    const path = this.app.workspace.getActiveFile()?.path ?? null;
    this.forPath = path;
    this.listEl.empty();
    if (!path) {
      this.listEl.createEl("p", { cls: "silica-empty", text: "Open a note." });
      return;
    }
    this.listEl.createEl("p", { cls: "silica-empty", text: "Indexing…" });
    const corpus = await this.host.corpus();
    if (this.forPath !== path) return; // the reader moved on while we indexed
    const signals = noteSignals(corpus, tablesOf(this.app), path);
    this.listEl.empty();

    // A vault with two copies of a tree shows two rows with the same name, one of
    // them looking like the note you are already on. Name the folder when the
    // basename alone does not tell them apart.
    const dupTitles = new Map<string, number>();
    for (const title of corpus.titles.values()) dupTitles.set(title, (dupTitles.get(title) ?? 0) + 1);
    const dir = this.folderOnly ? parentOf(path) : null;
    const keep = (rows: Related[]) => (dir === null ? rows : rows.filter((r) => parentOf(r.path) === dir));

    // Each note appears under one heading only, the sharpest thing the panel has
    // to say about it: a copy that is also unlinked and also an orphan is three
    // rows carrying the same number, which reads as a bug. Same precedence the
    // queue uses, so the panel and the Next notice never disagree.
    const claimed = new Set<string>();
    const once = (rows: Related[]) =>
      keep(rows).filter((r) => !claimed.has(r.path) && (claimed.add(r.path), true));

    let drawn = 0;
    const duplicates = once(signals.duplicates);
    const orphans = once(signals.orphans);
    drawn += this.section("Related", once(signals.related), corpus, dupTitles, path, signals.unlinked);
    drawn += this.section("Near-duplicates", duplicates, corpus, dupTitles, path);
    drawn += this.section("Orphans you could adopt", orphans, corpus, dupTitles, path);
    drawn += this.section("Links without substance", keep(signals.stale), corpus, dupTitles, path);
    drawn += this.dangling(signals.dangling);
    if (!drawn) {
      this.listEl.createEl("p", {
        cls: "silica-empty",
        text: dir === null ? "Nothing above the thresholds." : "Nothing in this folder above the thresholds.",
      });
    }
  }

  /** One titled block of rows. Returns how many it drew, so an empty panel can
   * say so once instead of five times. */
  private section(
    title: string,
    rows: Related[],
    corpus: Corpus,
    dupTitles: Map<string, number>,
    from: string,
    unlinked?: Set<string>,
  ): number {
    if (!rows.length) return 0;
    this.listEl.createEl("h3", { cls: "silica-note-section", text: title });
    const top = Math.max(...rows.map((r) => r.score)) || 1;
    for (const { path: other, score } of rows) {
      const name = corpus.titles.get(other) ?? other;
      const parent = parentOf(other);
      const row = this.listEl.createEl("button", { cls: "silica-related-row" });
      // The wash goes in first and everything after it is lifted into the
      // positioned layer by the stylesheet: an absolutely positioned child
      // paints above static content whatever the DOM order, so a bar added last
      // would tint the title it is measuring.
      // It is scaled against the strongest row of THIS section, not against
      // 1.0: overlaps above ~0.5 barely happen, so an absolute scale would be a
      // row of stubs, and a stale row's near-zero score would vanish entirely.
      row.createDiv({ cls: "silica-related-bar" }).style.width = `${Math.round((score / top) * 100)}%`;
      row.createSpan({ cls: "silica-related-name", text: name });
      if ((dupTitles.get(name) ?? 0) > 1 && parent) row.createSpan({ cls: "silica-related-dir", text: parent });
      // A related note nobody linked either way is the one worth a wikilink; the
      // word says it, so a screen reader gets it too.
      if (unlinked?.has(other)) row.createSpan({ cls: "silica-note-flag", text: "unlinked" });
      // The number and the bar say the same thing; the number is the one a
      // screen reader gets, so it is not decoration.
      row.createSpan({ cls: "silica-related-score", text: score.toFixed(2) });
      row.setAttribute("aria-label", `${other}, overlap ${score.toFixed(2)}`);
      row.onclick = () => void this.app.workspace.openLinkText(other, from, false);
    }
    return rows.length;
  }

  /** Broken links are link TEXT, not files: rendering them as buttons would offer
   * to create the missing note, which is a write this panel does not do. */
  private dangling(targets: string[]): number {
    if (!targets.length) return 0;
    this.listEl.createEl("h3", { cls: "silica-note-section", text: "Broken links" });
    for (const target of targets) {
      this.listEl.createDiv({ cls: "silica-note-dead", text: target });
    }
    return targets.length;
  }
}

// --- Ranked search ---------------------------------------------------------

type SearchRow = Hit & { pieces: Piece[] };

/** How many rows carry a snippet. Lower than the old 40 because each row now
 * costs a read; cachedRead is memoised by Obsidian, so typing through a word
 * re-reads nothing. */
const SEARCH_ROWS = 20;

/** BM25 + title, fused by rank. SuggestModal gives the list, the keyboard
 * handling and the empty state for free — none of that is worth rebuilding. */
export class SearchModal extends SuggestModal<SearchRow> {
  private corpus: Corpus;

  constructor(app: App, corpus: Corpus) {
    super(app);
    this.corpus = corpus;
    this.setPlaceholder("Search by relevance — add path:folder/ to scope it");
  }

  async getSuggestions(raw: string): Promise<SearchRow[]> {
    const { query, scope } = splitScope(raw);
    if (!query) return [];
    const hits = search(this.corpus, query, SEARCH_ROWS, scope);
    return Promise.all(hits.map(async (hit) => ({ ...hit, pieces: await this.snippetFor(hit.path, query) })));
  }

  private async snippetFor(path: string, query: string): Promise<Piece[]> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return [];
    try {
      return snippet(await this.app.vault.cachedRead(file), query);
    } catch {
      return []; // an unreadable file still ranks; it just shows no context
    }
  }

  renderSuggestion(hit: SearchRow, el: HTMLElement): void {
    el.createDiv({ text: hit.title });
    if (hit.pieces.length) {
      const line = el.createDiv({ cls: "silica-hit-snippet" });
      // Element per piece rather than innerHTML: vault prose never becomes markup.
      for (const piece of hit.pieces) {
        if (piece.hit) line.createEl("mark", { text: piece.text });
        else line.createSpan({ text: piece.text });
      }
    }
    el.createEl("small", { cls: "silica-hit-path", text: hit.path });
  }

  onChooseSuggestion(hit: SearchRow): void {
    void this.app.workspace.openLinkText(hit.path, "", false);
  }
}

// --- Community graph -------------------------------------------------------

const DRAG_SLOP = 4; // px of movement that turns a click into a pan

export class GraphView extends ItemView {
  private host: IndexHost;
  private canvas!: HTMLCanvasElement;
  private legendEl!: HTMLElement;
  private graph: Graph | null = null;
  private labels: string[] = [];
  private scale = 1;
  private offX = 0;
  private offY = 0;
  private dragging = false;
  private dragged = 0;
  private lastX = 0;
  private lastY = 0;

  constructor(leaf: WorkspaceLeaf, host: IndexHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string { return GRAPH_VIEW; }
  getDisplayText(): string { return "Silica community graph"; }
  getIcon(): string { return "git-fork"; }

  async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("silica-graph");
    const bar = el.createDiv({ cls: "silica-graph-bar" });
    const rebuild = bar.createEl("button", { cls: "silica-quiet silica-graph-rebuild" });
    setIcon(rebuild, "refresh-cw");
    rebuild.createSpan({ text: "Rebuild" });
    rebuild.setAttribute("aria-label", "Re-index the vault and lay the graph out again");
    rebuild.onclick = () => void this.rebuild();
    this.legendEl = bar.createDiv({ cls: "silica-graph-legend" });
    this.canvas = el.createEl("canvas", { cls: "silica-graph-canvas" });
    this.registerDomEvent(this.canvas, "wheel", (e) => this.onWheel(e));
    this.registerDomEvent(this.canvas, "mousedown", (e) => this.onDown(e));
    this.registerDomEvent(window, "mousemove", (e) => this.onMove(e));
    this.registerDomEvent(window, "mouseup", (e) => this.onUp(e));
    // Not onResize(): with a warm index the first draw beats the leaf's layout,
    // and a canvas sized off a not-yet-laid-out element gets a tiny backing store
    // that CSS then stretches into a blurry 4x zoom. The observer fires when the
    // element really has a size, which is the only moment the sizing is right.
    const observer = new ResizeObserver(() => this.draw());
    observer.observe(this.canvas);
    this.register(() => observer.disconnect());
    await this.rebuild();
  }

  private async rebuild(): Promise<void> {
    this.legendEl.setText("Indexing…");
    const corpus = await this.host.corpus();
    const graph = buildGraph(corpus, this.app.metadataCache.resolvedLinks);
    layout(graph);
    this.graph = graph;
    this.labels = communityLabels(graph, corpus);
    this.scale = 1;
    this.offX = this.offY = 0;
    if (graph.truncated) {
      new Notice(`Silica graph: showing the ${MAX_NODES} most connected notes, ${graph.truncated} left out.`);
    }
    this.renderLegend();
    this.draw();
  }

  private renderLegend(): void {
    this.legendEl.empty();
    const graph = this.graph;
    if (!graph) return;
    this.legendEl.createSpan({ cls: "silica-graph-count", text: `${graph.nodes.length} notes, ${graph.communities} communities` });
    const paper = isPaper();
    // Past ten the hues stop being tellable apart, so the legend stops too.
    for (let c = 0; c < Math.min(graph.communities, 10); c++) {
      const chip = this.legendEl.createSpan({ cls: "silica-graph-chip" });
      chip.createSpan({ cls: "silica-graph-dot" }).style.background = communityColor(c, paper);
      chip.createSpan({ text: this.labels[c] || `community ${c}` });
    }
  }

  /** The unit box -> pixels mapping, shared by the renderer and the hit test so
   * the two can never disagree about where a node is. */
  private frame(): { w: number; h: number; baseX: number; baseY: number; span: number } {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const span = Math.max(40, Math.min(w, h) - 56);
    return { w, h, baseX: (w - span) / 2, baseY: (h - span) / 2, span };
  }

  private draw(): void {
    const graph = this.graph;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const { w, h, baseX, baseY, span } = this.frame();
    if (this.canvas.clientWidth < 2 || this.canvas.clientHeight < 2) return; // no layout yet
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!graph || !graph.nodes.length) {
      ctx.fillStyle = this.themeColor("--text-faint", "#888");
      ctx.font = this.font(13);
      ctx.fillText("No edges yet — write a link or index a few more notes.", 12, 24);
      return;
    }

    const px = (n: { x: number; y: number }): [number, number] => [
      baseX + n.x * span * this.scale + this.offX,
      baseY + n.y * span * this.scale + this.offY,
    ];
    const paper = isPaper();

    // Written links first and quiet; the inferred mesh is the one vivid layer,
    // and drawing it second keeps it readable over the neutrals.
    for (const inferred of [false, true]) {
      ctx.strokeStyle = inferred
        // An inferred edge is Silica's own claim, so it wears the plugin accent
        // — the same hue as the status dot and the overlap bars, and the only
        // place the picture says "this one is mine".
        ? this.themeColor("--silica-accent", paper ? "#0b7285" : "#22b8cf")
        : this.themeColor("--text-faint", paper ? "#9aa0a6" : "#5a5f6b");
      ctx.globalAlpha = inferred ? 0.35 : 0.6;
      ctx.beginPath();
      for (const e of graph.edges) {
        if (e.inferred !== inferred) continue;
        const [ax, ay] = px(graph.nodes[e.a]);
        const [bx, by] = px(graph.nodes[e.b]);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.lineWidth = inferred ? 0.6 : 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const node of graph.nodes) {
      const [x, y] = px(node);
      ctx.fillStyle = communityColor(node.community, paper);
      ctx.beginPath();
      ctx.arc(x, y, 2 + Math.sqrt(node.deg), 0, Math.PI * 2);
      ctx.fill();
    }

    // Labels for the hubs first, and only where one fits: a label that overlaps
    // one already drawn is skipped, not shrunk. Zooming in frees room, which is
    // what makes the picture readable at every scale instead of only when small.
    ctx.fillStyle = this.themeColor("--text-muted", paper ? "#444" : "#bbb");
    ctx.font = this.font(11);
    ctx.textAlign = "center";
    const taken: Array<[number, number, number, number]> = [];
    for (const node of [...graph.nodes].sort((a, b) => b.deg - a.deg)) {
      if (taken.length >= 60) break; // past this the picture is text, not a graph
      const [x, y] = px(node);
      const half = ctx.measureText(node.title).width / 2 + 2;
      const top = y - 6 - Math.sqrt(node.deg);
      const box: [number, number, number, number] = [x - half, top - 11, x + half, top + 2];
      if (box[2] < 0 || box[0] > w || box[3] < 0 || box[1] > h) continue; // off screen
      if (taken.some((t) => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) continue;
      taken.push(box);
      ctx.fillText(node.title, x, top);
    }
    ctx.textAlign = "start";
  }

  private themeColor(name: string, fallback: string): string {
    return getComputedStyle(this.containerEl).getPropertyValue(name).trim() || fallback;
  }

  /** Canvas resolves no CSS var, so the interface font has to be read off the
   * element. Without it the graph is the one surface in the plugin set in a
   * different typeface from everything around it. */
  private font(px: number): string {
    return `${px}px ${getComputedStyle(this.containerEl).fontFamily || "sans-serif"}`;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const next = Math.min(8, Math.max(0.3, this.scale * Math.exp(-e.deltaY / 400)));
    const rect = this.canvas.getBoundingClientRect();
    const { baseX, baseY } = this.frame();
    // Keep whatever is under the cursor under the cursor: solve for the offset
    // that leaves this point's pixel position unchanged at the new scale.
    const cx = e.clientX - rect.left - baseX;
    const cy = e.clientY - rect.top - baseY;
    const ratio = next / this.scale;
    this.offX = cx - (cx - this.offX) * ratio;
    this.offY = cy - (cy - this.offY) * ratio;
    this.scale = next;
    this.draw();
  }

  private onDown(e: MouseEvent): void {
    this.dragging = true;
    this.dragged = 0;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  }

  private onMove(e: MouseEvent): void {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.dragged += Math.abs(dx) + Math.abs(dy);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.offX += dx;
    this.offY += dy;
    this.draw();
  }

  private onUp(e: MouseEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.dragged > DRAG_SLOP) return; // that was a pan, not a click
    const node = this.nodeAt(e);
    if (node) void this.app.workspace.openLinkText(node.path, "", false);
  }

  private nodeAt(e: MouseEvent): { path: string } | null {
    const graph = this.graph;
    if (!graph) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return null;
    const { baseX, baseY, span } = this.frame();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: { path: string } | null = null;
    let bestD = 12 * 12; // a 12px grab radius, in squared pixels
    for (const node of graph.nodes) {
      const x = baseX + node.x * span * this.scale + this.offX;
      const y = baseY + node.y * span * this.scale + this.offY;
      const d = (x - mx) * (x - mx) + (y - my) * (y - my);
      if (d < bestD) {
        bestD = d;
        best = node;
      }
    }
    return best;
  }
}
