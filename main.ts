import { App, ItemView, MarkdownRenderer, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, addIcon, editorInfoField, normalizePath, setIcon, type SettingDefinitionItem, type TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";

import { BridgeClient, str, type BridgeInfo, type Frame, type SocketLike, type Status } from "./bridge.ts";
import { applyChatFrame, emptyTurn, type TurnState } from "./chat.ts";
import { acceptInBaseline, diffLines, dropHunk, hunks, rejectEdit, revertHunks, silicaHunks, tally, type DiffLine, type Hunk } from "./diff.ts";
import { refreshEditors, silicaDiff, type DiffHost } from "./editorDiff.ts";
import { autolinkNote, dispatchRpc, ensureFolder, RPC_METHODS, type Change, type RpcApp } from "./handlers.ts";
import { buildCorpus, type Corpus, type CorpusVault } from "./corpus.ts";
import { GraphView, GRAPH_VIEW, NoteView, RELATED_VIEW, SearchModal, type IndexHost } from "./views.ts";

const VIEW_TYPE = "silica-bridge-view";
const BRIDGE_BASENAME = "silica-bridge.json";
const MAX_CHANGED_FILES = 200; // a long /ingest run, not a memory leak
const MAX_DIFF_LINES = 400; // per expanded file — a 5k-line overwrite must not stall the sidebar
const CONFIRM_WINDOW = 5000; // ms an armed "Reject all" waits before standing down

/** The plugin's own mark, and the same one the agent, the README banner and the
 * site now carry: a hexagonal cell with six nodes inside it, joined to a centre
 * by six curved arms that all lean the same way.
 *
 * Derived from silica-agent's assets/silica-mark-favicon.svg rather than drawn
 * again, so the two cannot drift: scale every coordinate by 100/512 onto
 * Obsidian's icon grid, drop the gradient and the nested-ring moire, and swap
 * the fills for currentColor. Redo exactly that when the mark changes.
 *
 * What is not a straight port is the ink, and it was picked against renders at
 * 16/18/20/24/48px, which is where a ribbon and a view tab actually live:
 *
 *   stroke 6 / 5.5  — the source's own weights land near 2 on this grid, which
 *                     is a hairline at 18px and reads lighter than every lucide
 *                     glyph beside it.
 *   r 4             — the nodes carry the mass, but at r 4.6 they touched the
 *                     arms at 16px and the middle closed into a blob.
 *   the moire       — eight nested rings render as a halo, not as rings, at any
 *                     size a tab or a ribbon gives them.
 */
const SILICA_ICON = "silica-lattice";
const SILICA_ICON_SVG = `
<g fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round">
  <path d="M93 46.1Q95.3 50 93 53.9L74.9 85.3Q72.7 89.2 68.1 89.2L31.9 89.2Q27.3 89.2 25.1 85.3L7 53.9Q4.7 50 7 46.1L25.1 14.7Q27.3 10.8 31.9 10.8L68.1 10.8Q72.7 10.8 74.9 14.7Z" />
</g>
<g fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round">
  <path d="M53 55 Q55.2 58.5 60.9 60.9" />
  <path d="M47.2 55.1 Q45.3 58.7 46 64.8" />
  <path d="M44.1 50.1 Q40.1 50.2 35.1 53.9" />
  <path d="M47 45 Q44.8 41.5 39.1 39.1" />
  <path d="M52.8 44.9 Q54.7 41.3 54 35.2" />
  <path d="M55.9 49.9 Q59.9 49.8 64.9 46.1" />
</g>
<g fill="currentColor">
  <circle cx="64.3" cy="62.4" r="4" />
  <circle cx="46.4" cy="68.5" r="4" />
  <circle cx="32.2" cy="56.2" r="4" />
  <circle cx="35.7" cy="37.6" r="4" />
  <circle cx="53.6" cy="31.5" r="4" />
  <circle cx="67.8" cy="43.8" r="4" />
  <path d="M53.1 54.3Q52.4 55.4 51.1 55.2L47.8 54.9Q46.6 54.7 46 53.6L44.7 50.6Q44.2 49.4 44.9 48.3L46.9 45.7Q47.6 44.6 48.9 44.8L52.2 45.1Q53.4 45.3 54 46.4L55.3 49.4Q55.8 50.6 55.1 51.7Z" />
</g>`;

interface SilicaSettings {
  portOverride: string;
  /** Comma-separated folder prefixes whose notes nobody else's pane, graph or
   * queue ever has to hear about — while their own pane still reads the vault.
   * Journals are the canonical case: notes written from a daily template all
   * relate to each other, no corpus statistic can tell a template from a topic
   * when they are a minority of the vault, and a daily note is a dashboard, so
   * the direction that matters is the one it points outwards. */
  excludeFolders: string;
}
const DEFAULT_SETTINGS: SilicaSettings = { portOverride: "", excludeFolders: "" };

/** The Daily notes core plugin's folder, or null when the plugin is off, the
 * folder is the vault root (excluding the root would exclude everything) or the
 * unofficial `internalPlugins` surface changed shape — every miss degrades to
 * "no seed", never a crash. Read so the excludeFolders default can name the one
 * folder Obsidian already knows holds templated notes. */
function dailyNotesFolder(app: App): string | null {
  const internal = (
    app as unknown as { internalPlugins?: { getEnabledPluginById?: (id: string) => unknown } }
  ).internalPlugins;
  const daily = internal?.getEnabledPluginById?.("daily-notes") as
    | { options?: { folder?: unknown } }
    | null
    | undefined;
  const folder = daily?.options?.folder;
  return typeof folder === "string" && folder.trim().replace(/^\/+|\/+$/g, "") ? folder.trim() : null;
}

export default class SilicaBridgePlugin extends Plugin implements DiffHost, IndexHost {
  settings: SilicaSettings = DEFAULT_SETTINGS;
  client: BridgeClient | null = null;
  status: Status = "disconnected";
  statusDetail = "";
  /** What Silica has written this session, one row per file, insertion-ordered. */
  changes = new Map<string, Change>();
  /** The offline index. Rebuilt on demand, incremental on mtime, never persisted
   * — a full build of a few thousand notes is a second, and a stale cache on
   * disk is a bug class this does not need. */
  private corpusCache: Corpus | null = null;
  private corpusInFlight: Promise<Corpus> | null = null;

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<SilicaSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // Until the user touches the field — even to clear it — the exclusion
    // follows the Daily notes folder: journals are the canonical templated
    // class, and Obsidian already knows where they live. Not persisted here, so
    // an untouched setting keeps tracking a moved daily folder; the first
    // saveSettings after an edit writes the key and ends the seeding.
    if (saved?.excludeFolders === undefined) {
      this.settings.excludeFolders = dailyNotesFolder(this.app) ?? "";
    }
    this.registerView(VIEW_TYPE, (leaf) => new BridgeView(leaf, this));
    this.registerView(RELATED_VIEW, (leaf) => new NoteView(leaf, this));
    this.registerView(GRAPH_VIEW, (leaf) => new GraphView(leaf, this));
    // Inline accept/reject blocks. The path lookup is passed in so editorDiff.ts
    // stays free of Obsidian imports and can be exercised headlessly.
    this.registerEditorExtension(
      silicaDiff(this, (state) => state.field(editorInfoField, false)?.file?.path ?? null),
    );
    addIcon(SILICA_ICON, SILICA_ICON_SVG);
    this.addRibbonIcon(SILICA_ICON, "Silica bridge", () => void this.activateView());
    // The graph is a destination, not a panel, so it gets the affordance core
    // Obsidian gives its own graph: an icon in the ribbon. Same glyph as the view
    // tab, which is what makes the two read as one thing.
    this.addRibbonIcon("git-fork", "Silica community graph", () => void this.activateLeaf(GRAPH_VIEW, "tab"));
    this.addCommand({
      id: "open-panel", // Obsidian prefixes the plugin name; don't repeat it here.
      name: "Open bridge panel",
      callback: () => void this.activateView(),
    });
    // Everything below runs with the agent switched off: the algorithms are the
    // plugin's own, the vault is the only input.
    this.addCommand({
      id: "autolink-note",
      name: "Autolink this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.autolink([file.path]);
        return true;
      },
    });
    this.addCommand({
      id: "autolink-vault",
      name: "Autolink every note",
      callback: () => void this.autolink(this.app.vault.getMarkdownFiles().map((f) => f.path)),
    });
    this.addCommand({
      id: "open-related", // id kept: renaming it would drop everyone's hotkey
      name: "Open note panel",
      callback: () => void this.activateLeaf(RELATED_VIEW),
    });
    this.addCommand({
      id: "next-attention",
      name: "Open the next note that needs attention",
      callback: () => void this.nextAttention(),
    });
    this.addCommand({
      id: "search",
      name: "Search by relevance",
      callback: () => void this.corpus().then((c) => new SearchModal(this.app, c).open()),
    });
    this.addCommand({
      id: "open-graph",
      name: "Open community graph",
      callback: () => void this.activateLeaf(GRAPH_VIEW, "tab"),
    });
    // The note panel follows the reader; the corpus behind it is memoised and now
    // returns the same object when nothing moved, so this costs an mtime scan per
    // note switch, not a reindex. `resolved` is here too because half the panel
    // reads the link tables, and those settle after the file does.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshNotePanel()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.refreshNotePanel()));
    this.addSettingTab(new SilicaSettingTab(this.app, this));
    // Heavy setup after layout is ready (avoids the startup `create` event storm).
    this.app.workspace.onLayoutReady(() => this.connect());
  }

  /** The corpus, refreshed against the vault's mtimes. Concurrent callers share
   * one build — the related pane and the graph both ask on open. */
  corpus(): Promise<Corpus> {
    if (this.corpusInFlight) return this.corpusInFlight;
    const vault = this.app.vault as unknown as CorpusVault;
    const exclude = this.settings.excludeFolders.split(",").filter((p) => p.trim());
    const build = buildCorpus(vault, this.corpusCache, exclude).then(
      (c) => {
        this.corpusCache = c;
        this.corpusInFlight = null;
        return c;
      },
      (e: unknown) => {
        this.corpusInFlight = null;
        throw e;
      },
    );
    return (this.corpusInFlight = build);
  }

  refreshNotePanel(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(RELATED_VIEW)) {
      if (leaf.view instanceof NoteView) void leaf.view.refresh();
    }
  }

  /** The palette twin of the panel's Next button. Opens the panel first, so the
   * reader lands on the note with the reasons already beside it. */
  private async nextAttention(): Promise<void> {
    await this.activateLeaf(RELATED_VIEW);
    for (const leaf of this.app.workspace.getLeavesOfType(RELATED_VIEW)) {
      if (leaf.view instanceof NoteView) {
        await leaf.view.next();
        return;
      }
    }
  }

  /** Autolink the note in front of the reader. The command can gray itself out
   * when there is none; a button in the panel cannot, so it says so instead. */
  async autolinkActive(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Silica: open a markdown note first.");
      return;
    }
    await this.autolink([file.path]);
  }

  /** Inject wikilinks for vault titles a note mentions but does not link. Every
   * touched file lands in the changes panel, so the pass is reviewed and revertable
   * exactly like one the agent drove. */
  private async autolink(paths: string[]): Promise<void> {
    const rpc = this.app as unknown as RpcApp; // same narrowing as onRpc
    let touched = 0;
    let added = 0;
    for (const path of paths) {
      try {
        const links = await autolinkNote(rpc, path, null, (c) => this.noteChange(c));
        if (links.length) {
          touched++;
          added += links.length;
        }
      } catch (e) {
        new Notice(`Silica: autolink failed on ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    new Notice(
      added
        ? `Silica: ${added} link${added === 1 ? "" : "s"} across ${touched} note${touched === 1 ? "" : "s"} — review them in the bridge panel.`
        : "Silica: nothing to link.",
    );
    if (added) await this.activateView();
  }

  onunload(): void {
    this.client?.stop();
    this.client = null;
  }

  connect(): void {
    if (this.client) return;
    this.client = new BridgeClient({
      readBridgeInfo: async () => {
        // The config folder is whatever the vault says it is, not `.obsidian`:
        // a vault that renamed it is the one case where a hardcoded path would
        // silently never connect. The writer (`silica connect`, the Python
        // side) resolves the same way.
        let info: BridgeInfo;
        try {
          const raw = await this.app.vault.adapter.read(`${this.app.vault.configDir}/${BRIDGE_BASENAME}`);
          info = JSON.parse(raw) as BridgeInfo;
        } catch {
          return null; // absent or unreadable — no session running yet
        }
        const override = this.settings.portOverride.trim();
        return override ? { ...info, port: Number(override) } : info;
      },
      connect: (url) => wrapSocket(new WebSocket(url)),
      // Popout windows get their own timer scope; `window` is the correct one.
      schedule: (fn, ms) => window.setTimeout(fn, ms),
      cancel: (handle) => window.clearTimeout(handle as number),
      // Defense-in-depth: refuse a bridge whose vault isn't this one, so a stray
      // silica-bridge.json can't make Silica reason over vault A and write to B.
      verifyWelcome: (frame) => {
        const served = str(frame.vault);
        const mine = this.app.vault.getName();
        return served && served !== mine
          ? `bridge serves vault "${served}", not "${mine}" — run silica connect in this vault`
          : null;
      },
      onStatus: (s, detail) => {
        this.status = s;
        this.statusDetail = detail;
        this.refreshViews();
      },
      onFrame: (frame, send) => this.onFrame(frame, send),
    });
    void this.client.start();
  }

  onFrame(frame: Frame, send: (f: Frame) => void): void {
    if (frame.type === "rpc") return this.onRpc(frame, send);
    // Chat replies (chat_event/chat_done/chat_error) → the panel that owns the turn.
    if (typeof frame.type === "string" && frame.type.startsWith("chat_")) {
      this.eachView((v) => v.handleChatFrame(frame));
    }
  }

  /** Fold one write into the per-file change list, then repaint the panel. Kind is
   * derived from the (baseline, head) pair rather than tracked, so a file written
   * five times in one run still yields one honest row. */
  noteChange(c: Change): void {
    if (c.kind === "rename") {
      // The row follows the file, so a note Silica wrote and then moved keeps its
      // baseline instead of splitting into a phantom pair.
      const prev = c.from ? this.changes.get(c.from) : undefined;
      if (c.from) this.changes.delete(c.from);
      this.changes.set(c.path, prev ? { ...prev, path: c.path, from: c.from } : c);
    } else {
      const prev = this.changes.get(c.path);
      // Whatever the reader typed since Silica's last write belongs in the
      // baseline, not in the review: the baseline is the file as it stands with
      // only Silica's still-pending blocks taken back out. Without this a second
      // write would hand the reader their own paragraphs to accept or reject.
      const before = prev
        ? revertHunks(c.before, silicaHunks(prev.before, prev.after, c.before))
        : c.before;
      // ponytail: an overwrite to "" therefore reads as a delete. The write path's
      // min-snippet gate means it does not happen, and the diff is all-red anyway.
      if (before === "" && c.after === "") this.changes.delete(c.path); // created, then gone
      else {
        const kind = before === "" ? "create" : c.after === "" ? "delete" : "modify";
        this.changes.set(c.path, { ...c, before, kind, from: prev?.from });
      }
    }
    // Map iterates in insertion order and `set` on an existing key keeps its slot,
    // so rows stay put during a run and the cap drops the oldest file first.
    while (this.changes.size > MAX_CHANGED_FILES) {
      const oldest = this.changes.keys().next().value;
      if (oldest === undefined) break;
      this.changes.delete(oldest);
    }
    this.repaint();
  }

  /** Both surfaces read the same store, so both are redrawn together. */
  private repaint(): void {
    this.eachView((v) => v.renderChanges());
    refreshEditors();
  }

  // --- Inline review (DiffHost). The row's own pair — the baseline `before` and
  // Silica's version `after` — is what review is over. The document is a third
  // text that drifts from both as the reader types, and blocks are located in it
  // rather than derived from it, which is what keeps the reader's own edits out
  // of the review entirely.

  hunksFor(path: string, doc: string): Hunk[] {
    const c = this.changes.get(path);
    // A rename moved bytes without changing them, a delete left no editor open.
    return c && c.kind !== "rename" && c.kind !== "delete" ? silicaHunks(c.before, c.after, doc) : [];
  }

  /** Accept: the baseline takes the block, the document keeps the bytes it has. */
  acceptHunk(path: string, hunk: Hunk): void {
    const c = this.changes.get(path);
    if (c) this.settle(path, acceptInBaseline(c.before, hunk), c.after);
  }

  /** Reject: one transaction, so Ctrl+Z brings Silica's version back. */
  rejectHunk(path: string, hunk: Hunk, view: EditorView): void {
    const c = this.changes.get(path);
    if (!c) return;
    view.dispatch({ changes: rejectEdit(view.state.doc.toString(), hunk) });
    const doc = view.state.doc.toString();
    // Last block of a file Silica created: the empty file itself has to follow.
    if (c.kind === "create" && doc === "") void this.revertPaths([path]);
    // Silica's version drops the block too — the row clears when the pair agrees,
    // and the document is no longer the half being compared.
    else this.settle(path, c.before, dropHunk(c.before, c.after, hunk));
  }

  /** Fold a reviewed pair back into the row, dropping it once the two agree. */
  private settle(path: string, before: string, after: string): void {
    const c = this.changes.get(path);
    if (!c) return;
    if (before === after) this.changes.delete(path);
    else this.changes.set(path, { ...c, before, after, kind: before === "" ? "create" : "modify" });
    this.repaint();
  }

  /** Put `text` back into a file, through the open editor when there is one.
   *
   * `vault.process` reaches disk, but an editor holding that file keeps its own
   * document and writes it back on its next save, so a revert of an open note
   * silently undid itself a second or two later. Measured: reject-all wrote the
   * baseline (3352 chars), and the editor's save restored Silica's version
   * (3356) with the changes list already empty. The editor is the authority
   * whenever one exists; disk is only the authority when none does.
   *
   * One `replaceRange` per view, not `setValue`, so it lands as a single
   * transaction and Ctrl+Z brings Silica's version back, matching what the
   * per-hunk reject already does. */
  private async restore(file: TFile, text: string): Promise<void> {
    const views = this.editorsFor(file.path);
    if (!views.length) {
      await this.app.vault.process(file, () => text);
      return;
    }
    for (const { editor } of views) {
      // Panes on one file share a document, so the first write settles the rest;
      // the others fall through this guard rather than stacking no-op transactions.
      if (editor.getValue() === text) continue;
      editor.replaceRange(text, { line: 0, ch: 0 }, editor.offsetToPos(editor.getValue().length));
    }
    // Flush now instead of waiting out the idle timer: a reader who rejects and
    // quits within the second should still find the revert on disk.
    await Promise.all(views.map((v) => v.save()));
  }

  private editorsFor(path: string): MarkdownView[] {
    return this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === path);
  }

  /** The file as it stands now, read from the editor holding it when there is
   * one — the same authority `restore` writes back through, and a save ahead of
   * what disk would say. */
  private async current(file: TFile): Promise<string> {
    const [view] = this.editorsFor(file.path);
    return view ? view.editor.getValue() : this.app.vault.read(file);
  }

  /** Keep every write, forget the list. Nothing on disk moves. */
  acceptAll(): void {
    this.changes.clear();
    this.repaint();
  }

  rejectAll(): Promise<void> {
    return this.revertPaths([...this.changes.keys()]);
  }

  /** Take Silica's writing back out of these files, block by block, leaving
   * whatever the reader wrote themselves exactly where it is. One repaint at the
   * end: a 200-file revert must not rebuild the panel 200 times. */
  private async revertPaths(paths: string[]): Promise<void> {
    const { vault, fileManager } = this.app;
    const rpc = this.app as unknown as RpcApp; // same narrowing as onRpc
    for (const path of paths) {
      const c = this.changes.get(path);
      if (!c) continue;
      this.changes.delete(path);
      const file = vault.getFileByPath(path);
      try {
        if (c.kind === "delete") {
          await ensureFolder(rpc, path);
          if (file) await this.restore(file, c.before); // recreated meanwhile
          else await vault.create(path, c.before);
        } else if (c.kind === "rename") {
          if (file && c.from) {
            await ensureFolder(rpc, c.from);
            await fileManager.renameFile(file, c.from);
          }
        } else if (file) {
          // Only Silica's blocks come out, the same ones the inline buttons offer
          // — so a file the reader kept working in comes back to their version of
          // it, not to a snapshot from before they started.
          const now = await this.current(file);
          const left = revertHunks(now, silicaHunks(c.before, c.after, now));
          // A file Silica created is only trashed if nothing of the reader's is
          // left in it, which is the rule the last inline reject already follows.
          if (c.kind === "create" && left === "") await fileManager.trashFile(file);
          else await this.restore(file, left);
        }
      } catch (e) {
        new Notice(`Silica: could not revert ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.repaint();
  }

  // RPC dispatch (phases 3–4): allowlist → typed read/write handlers. An unknown
  // method is refused, never executed (PROTOCOL §Security: fixed allowlist).
  onRpc(frame: Frame, send: (f: Frame) => void): void {
    const id = frame.id as number;
    const method = String(frame.method);
    const params = (frame.params ?? {}) as Record<string, unknown>;
    if (!RPC_METHODS.has(method)) {
      send({ type: "rpc_error", id, error: `method not implemented: ${method}` });
      return;
    }
    // `as unknown as`: RpcApp's file params (TFileLike) are intentionally
    // narrower than Obsidian's TAbstractFile, so a direct cast can't prove the
    // contravariant param match. Runtime App satisfies RpcApp — the mock proves
    // the shape headlessly in handlers.test.ts.
    dispatchRpc(this.app as unknown as RpcApp, method, params, normalizePath, (c) => this.noteChange(c))
      .then((result) => send({ type: "rpc_result", id, result }))
      .catch((e: unknown) => send({ type: "rpc_error", id, error: e instanceof Error ? e.message : String(e) }));
  }

  async activateView(): Promise<void> {
    await this.activateLeaf(VIEW_TYPE);
  }

  /** Reveal the one leaf of `type`, creating it where it belongs: the panels go
   * in the sidebar, the graph gets a full tab. */
  async activateLeaf(type: string, where: "right" | "tab" = "right"): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(type);
    const leaf: WorkspaceLeaf | null = existing.length
      ? existing[0]
      : where === "tab"
        ? workspace.getLeaf("tab")
        : workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing.length) await leaf.setViewState({ type, active: true });
    await workspace.revealLeaf(leaf);
  }

  refreshViews(): void {
    this.eachView((v) => v.renderStatus());
  }

  private eachView(fn: (v: BridgeView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof BridgeView) fn(leaf.view);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

function wrapSocket(ws: WebSocket): SocketLike {
  const s: SocketLike = {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onOpen: null, onMessage: null, onClose: null, onError: null,
  };
  ws.onopen = () => s.onOpen?.();
  ws.onmessage = (ev) => s.onMessage?.(String(ev.data));
  ws.onclose = () => s.onClose?.();
  ws.onerror = (e) => s.onError?.(e);
  return s;
}

// Chat panel: a message log + input over the bridge's chat channel. The pure
// event→view-model fold lives in chat.ts; this class owns only the DOM and the
// in-flight turn. One turn at a time (the server refuses a concurrent chat).
class BridgeView extends ItemView {
  plugin: SilicaBridgePlugin;
  private statusEl: HTMLElement | null = null;
  private statusLabelEl!: HTMLElement;
  private statusDetailEl!: HTMLElement;
  private emptyEl: HTMLElement | null = null;
  private logEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private turnId: string | null = null;
  private turn: TurnState | null = null;
  private bodyEl!: HTMLElement;
  private toolsEl!: HTMLElement;
  private changesEl: HTMLElement | null = null;
  private expanded = new Set<string>(); // paths whose diff is open — survives repaints
  private armed = false; // "Reject all" clicked once, waiting for the confirm
  private confirmTimer = 0;
  // Every write repaints the whole list, so the per-row diff is memoised. noteChange
  // rebuilds the Change object on each write, which is exactly the invalidation.
  private diffCache = new WeakMap<Change, DiffLine[]>();

  constructor(leaf: WorkspaceLeaf, plugin: SilicaBridgePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Silica bridge"; }
  getIcon(): string { return SILICA_ICON; }
  async onOpen(): Promise<void> { this.build(); }
  async onClose(): Promise<void> { window.clearTimeout(this.confirmTimer); }

  private build(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("silica-bridge");
    // The offline surfaces have nowhere else to be reached from: without this row
    // they live only in the command palette, which is where a feature goes to be
    // missed. They sit above the status line because they work whatever it says.
    const launchers = el.createDiv({ cls: "silica-launchers" });
    const launch = (label: string, tip: string, run: () => void) => {
      const button = launchers.createEl("button", { cls: "silica-quiet silica-launcher", text: label });
      button.setAttribute("aria-label", tip);
      button.onclick = run;
    };
    launch("Related", "Notes about the same thing as the open one", () =>
      void this.plugin.activateLeaf(RELATED_VIEW));
    launch("Search", "Rank the whole vault by relevance", () =>
      void this.plugin.corpus().then((c) => new SearchModal(this.app, c).open()));
    launch("Graph", "Community graph of the vault", () =>
      void this.plugin.activateLeaf(GRAPH_VIEW, "tab"));
    launch("Autolink", "Link the titles this note mentions", () =>
      void this.plugin.autolinkActive());
    // A dot and a sentence, not the raw enum: this line is on screen the whole
    // time the panel is, so it is the plugin's most-read piece of copy.
    this.statusEl = el.createEl("p", { cls: "silica-status" });
    this.statusEl.createSpan({ cls: "silica-status-dot" });
    this.statusLabelEl = this.statusEl.createSpan({ cls: "silica-status-label" });
    this.statusDetailEl = this.statusEl.createSpan({ cls: "silica-status-detail" });
    this.logEl = el.createDiv({ cls: "silica-log" });
    this.renderEmpty();
    this.changesEl = el.createDiv({ cls: "silica-changes" });
    this.renderChanges();
    const row = el.createDiv({ cls: "silica-input-row" });
    this.inputEl = row.createEl("textarea", { attr: { rows: "2", placeholder: "Message Silica…" } });
    // Send is the primary action here, so it wears Obsidian's own primary
    // button rather than looking like the Stop next to it.
    this.sendBtn = row.createEl("button", { cls: "mod-cta", text: "Send" });
    this.stopBtn = row.createEl("button", { text: "Stop" });
    this.stopBtn.hide();
    this.sendBtn.onclick = () => this.sendChat();
    this.stopBtn.onclick = () => {
      if (this.turnId) this.plugin.client?.send({ type: "chat_cancel", turnId: this.turnId });
    };
    this.registerDomEvent(this.inputEl, "keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.sendChat(); }
    });
    this.renderStatus();
  }

  /** Until the first turn the log is an empty box under a toolbar, which reads
   * as broken rather than as new. One line saying what the panel is for. */
  private renderEmpty(): void {
    this.emptyEl = this.logEl.createDiv({ cls: "silica-empty-chat" });
    setIcon(this.emptyEl.createDiv(), SILICA_ICON);
    this.emptyEl.createDiv({ text: "Ask Silica about the vault." });
    this.emptyEl.createDiv({ text: "It reads your notes, and writes only where you let it." });
  }

  renderStatus(): void {
    if (!this.statusEl) return; // status can fire before onOpen builds the DOM
    const s = this.plugin.status;
    if (s !== "connected" && this.turnId) this.abortTurn(s); // dropped mid-turn
    // The class carries the colour, the word carries the state: the dot alone
    // would put the whole signal on hue.
    this.statusEl.className = `silica-status silica-status-${s}`;
    this.statusLabelEl.setText({ connected: "Connected", connecting: "Connecting…", disconnected: "Disconnected" }[s]);
    this.statusDetailEl.setText(this.plugin.statusDetail);
    // The detail is the only place a dial error is ever shown, and it elides,
    // so the full string has to survive on hover.
    this.statusDetailEl.title = this.plugin.statusDetail;
    const blocked = s !== "connected" || this.turnId !== null;
    this.inputEl.disabled = blocked;
    this.sendBtn.disabled = blocked;
  }

  /** Source-control shape: the list of files Silica wrote, each expanding into its
   * own +/− diff. The store is the plugin's, not the turn's — a `/ingest` driven
   * from the terminal writes over this same bridge with no chat turn to hang off. */
  renderChanges(): void {
    const el = this.changesEl;
    if (!el) return; // a write can land before onOpen builds the DOM
    const changes = [...this.plugin.changes.values()];
    el.empty();
    el.toggle(changes.length > 0);
    if (!changes.length) return;

    const head = el.createDiv({ cls: "silica-changes-head" });
    head.createSpan({
      cls: "silica-changes-count",
      text: `${changes.length} file${changes.length === 1 ? "" : "s"} changed`,
    });
    const accept = head.createEl("button", {
      cls: "silica-quiet",
      text: "Accept all",
      attr: { "aria-label": "Keep every change and empty the list" },
    });
    accept.onclick = () => {
      this.expanded.clear();
      this.plugin.acceptAll();
    };
    // Two-step instead of a modal, and the armed state lives on the view so a
    // write landing mid-window repaints the header without losing it.
    const reject = head.createEl("button", {
      cls: this.armed ? "silica-quiet silica-armed" : "silica-quiet",
      text: this.armed ? "Sure?" : "Reject all",
      // It rejects every block at once, which is the only difference from the
      // inline buttons: what the reader wrote themselves stays either way.
      attr: {
        "aria-label": this.armed
          ? "Confirm taking back every block Silica wrote"
          : "Take back every block Silica wrote across all these files, keeping your own edits",
      },
    });
    reject.onclick = () => {
      window.clearTimeout(this.confirmTimer);
      if (this.armed) {
        this.armed = false;
        this.expanded.clear();
        void this.plugin.rejectAll();
        return;
      }
      this.armed = true;
      this.confirmTimer = window.setTimeout(() => {
        this.armed = false;
        this.renderChanges();
      }, CONFIRM_WINDOW);
      this.renderChanges();
    };

    const list = el.createDiv({ cls: "silica-changes-list" });
    for (const c of changes) this.renderChange(list, c);
  }

  private diffOf(c: Change): DiffLine[] {
    let lines = this.diffCache.get(c);
    if (!lines) this.diffCache.set(c, (lines = c.kind === "rename" ? [] : diffLines(c.before, c.after)));
    return lines;
  }

  private renderChange(parent: HTMLElement, c: Change): void {
    const lines = this.diffOf(c);
    const { added, removed } = tally(lines);
    const open = this.expanded.has(c.path);
    const row = parent.createDiv({ cls: "silica-change" });

    // A real button, not a clickable div: every row has to be keyboard reachable.
    const toggle = row.createEl("button", { cls: "silica-quiet silica-change-toggle" });
    toggle.setAttribute("aria-label", `${c.kind} ${c.path}, ${added} added, ${removed} removed`);
    // The chevron says the row opens. Without it the only affordance was that a
    // filename happened to highlight on hover, which is not one.
    const chevron = toggle.createSpan({
      cls: open ? "silica-change-chevron silica-change-open-chevron" : "silica-change-chevron",
    });
    setIcon(chevron, "chevron-right");
    // Letter + colour + sign: the status never rides on colour alone.
    toggle.createSpan({ cls: `silica-kind silica-kind-${c.kind}`, text: c.kind[0].toUpperCase() });
    toggle.createSpan({ cls: "silica-change-path", text: c.from ? `${c.from} → ${c.path}` : c.path });
    if (added) toggle.createSpan({ cls: "silica-plus", text: `+${added}` });
    if (removed) toggle.createSpan({ cls: "silica-minus", text: `−${removed}` });
    if (lines.length) {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.onclick = () => {
        if (open) this.expanded.delete(c.path);
        else this.expanded.add(c.path);
        this.renderChanges();
      };
    } else {
      toggle.disabled = true; // a rename moved bytes, it did not change them
    }

    const reveal = row.createEl("button", { cls: "silica-quiet silica-change-open" });
    setIcon(reveal, "external-link");
    reveal.setAttribute("aria-label", `Open ${c.path}`);
    reveal.disabled = c.kind === "delete"; // in the trash — nothing to open
    reveal.onclick = () => void this.app.workspace.openLinkText(c.path, "", false);

    if (open && lines.length) this.renderDiff(parent, lines);
  }

  private renderDiff(parent: HTMLElement, lines: DiffLine[]): void {
    const box = parent.createDiv({ cls: "silica-diff" });
    // Inner track sized to the longest line, so a +/− block keeps its colour all
    // the way across when the reader scrolls a long line sideways.
    const track = box.createDiv({ cls: "silica-diff-track" });
    const groups = hunks(lines);
    const total = groups.reduce((n, g) => n + g.length, 0);
    let budget = MAX_DIFF_LINES;
    for (const g of groups) {
      if (budget <= 0) break;
      if (budget < MAX_DIFF_LINES) track.createDiv({ cls: "silica-diff-gap", text: "⋯" });
      for (const l of g.slice(0, budget)) {
        const cls = l.op === "+" ? "add" : l.op === "-" ? "del" : "ctx";
        track.createDiv({ cls: `silica-diff-line silica-diff-${cls}`, text: `${l.op}${l.text}` });
      }
      budget -= g.length;
    }
    if (total > MAX_DIFF_LINES) {
      track.createDiv({ cls: "silica-diff-gap", text: `⋯ ${total - MAX_DIFF_LINES} more lines — open the note for the rest` });
    }
  }

  private bubble(role: "user" | "silica"): HTMLElement {
    this.emptyEl?.remove(); // the log has content now; it never comes back empty
    this.emptyEl = null;
    const b = this.logEl.createDiv({ cls: `silica-msg silica-${role}` });
    this.logEl.scrollTop = this.logEl.scrollHeight;
    return b;
  }

  private sendChat(): void {
    if (this.plugin.status !== "connected" || this.turnId !== null) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.bubble("user").setText(text);
    const asst = this.bubble("silica");
    this.toolsEl = asst.createDiv({ cls: "silica-tools" });
    // `markdown-rendered` is what Obsidian's own typography hangs off: without it
    // a blockquote falls back to the browser's 40px indent and a code fence to no
    // styling at all, which is the answer looking nothing like the note beside it.
    this.bodyEl = asst.createDiv({ cls: "silica-body markdown-rendered" });
    this.streaming("");
    this.turnId = crypto.randomUUID();
    this.turn = emptyTurn();
    this.plugin.client?.send({ type: "chat", turnId: this.turnId, text });
    this.stopBtn.show();
    this.renderStatus();
  }

  handleChatFrame(frame: Frame): void {
    if (!this.turn || frame.turnId !== this.turnId) return; // not our turn
    applyChatFrame(this.turn, frame);
    this.renderTurn();
    if (this.turn.done) this.finishTurn();
  }

  private renderTurn(): void {
    const t = this.turn;
    if (!t) return;
    this.toolsEl.empty();
    for (const tool of t.tools) {
      const row = this.toolsEl.createDiv({ cls: `silica-tool silica-tool-${tool.status}` });
      // An icon rather than a text glyph: everything else in Obsidian's chrome
      // is lucide, and ✓/✗/⏺ never match its weight at any font size.
      setIcon(row, tool.status === "done" ? "check" : tool.status === "error" ? "x" : "circle");
      // Two spans, not one string: the label holds a path and has to elide, but
      // the reason an error gives is the whole point of the row and must not be
      // what the ellipsis eats.
      row.createSpan({ cls: "silica-tool-label", text: tool.label });
      if (tool.error) row.createSpan({ cls: "silica-tool-reason", text: tool.error });
    }
    if (!t.done) this.streaming(t.text);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** The answer as it arrives, with the caret that says more is coming. The
   * caret is the only thing standing in for an empty body, so a turn that has
   * not emitted a token yet still reads as working rather than as stuck. */
  private streaming(text: string): void {
    this.bodyEl.empty();
    // Raw tokens, so the newlines in them are the only structure there is and
    // have to survive. The class carries that, not the body: once the markdown
    // is rendered the newlines BETWEEN its blocks become text nodes of their
    // own, and a body still set to pre-wrap paints every one of them as a blank
    // line — the answer arrives correctly spaced and then doubles.
    if (text) this.bodyEl.createSpan({ cls: "silica-stream", text });
    this.bodyEl.createSpan({ cls: "silica-caret" });
  }

  private finishTurn(): void {
    const t = this.turn;
    this.bodyEl.empty();
    if (t?.error) {
      this.bodyEl.addClass("silica-error");
      this.bodyEl.setText(`error: ${t.error}`);
    } else {
      // Render markdown (not the server's html) → clickable wikilinks, no innerHTML.
      void MarkdownRenderer.render(this.app, t?.answer || t?.text || "", this.bodyEl, "", this);
    }
    // The answer landing is the one moment the plugin animates. It settles from
    // where the streaming text already was, so nothing appears out of nowhere.
    this.bodyEl.addClass("silica-in");
    this.turnId = null;
    this.turn = null;
    this.stopBtn.hide();
    this.renderStatus();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private abortTurn(reason: string): void {
    if (this.turn && this.bodyEl) {
      this.bodyEl.empty();
      this.bodyEl.addClass("silica-error");
      this.bodyEl.setText(`turn aborted: ${reason}`);
    }
    this.turnId = null;
    this.turn = null;
    this.stopBtn.hide();
  }
}

const PORT_DESC = "Leave empty to use the port from silica-bridge.json.";
const EXCLUDE_DESC =
  "Comma-separated folders whose notes stay out of everyone else's related notes, community graph and attention " +
  "— for journals and other templated notes that would otherwise all relate to each other. Their own related pane " +
  "still works, so a daily note keeps suggesting what the vault holds on what you wrote. Search still finds them. " +
  "Follows your Daily notes folder until you edit it; clear it to exclude nothing.";

// Declarative settings (Obsidian 1.13+): getSettingDefinitions replaces the
// deprecated display(); getControlValue/setControlValue bind keys to our store.
// display() stays for 1.7.2–1.12, which never calls the declarative path.
class SilicaSettingTab extends PluginSettingTab {
  plugin: SilicaBridgePlugin;

  constructor(app: App, plugin: SilicaBridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { name: "Connection status", desc: this.statusDesc() },
      {
        name: "Port override",
        desc: PORT_DESC,
        control: { type: "text", key: "portOverride", placeholder: "Auto" },
      },
      {
        name: "Excluded folders",
        desc: EXCLUDE_DESC,
        control: { type: "text", key: "excludeFolders", placeholder: "journal, daily" },
      },
    ];
  }

  /** Obsidian before 1.13 ignores getSettingDefinitions entirely, and
   * `minAppVersion` is 1.7.2: the same two rows, drawn by hand. */
  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("Connection status").setDesc(this.statusDesc());
    new Setting(this.containerEl)
      .setName("Port override")
      .setDesc(PORT_DESC)
      .addText((text) =>
        text
          .setPlaceholder("Auto")
          .setValue(this.plugin.settings.portOverride)
          .onChange((value) => void this.setControlValue("portOverride", value)),
      );
    new Setting(this.containerEl)
      .setName("Excluded folders")
      .setDesc(EXCLUDE_DESC)
      .addText((text) =>
        text
          .setPlaceholder("journal, daily")
          .setValue(this.plugin.settings.excludeFolders)
          .onChange((value) => void this.setControlValue("excludeFolders", value)),
      );
  }

  private statusDesc(): string {
    return this.plugin.statusDetail ? `${this.plugin.status} — ${this.plugin.statusDetail}` : this.plugin.status;
  }

  getControlValue(key: string): unknown {
    if (key === "portOverride") return this.plugin.settings.portOverride;
    if (key === "excludeFolders") return this.plugin.settings.excludeFolders;
    return undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "portOverride") {
      this.plugin.settings.portOverride = str(value);
    } else if (key === "excludeFolders") {
      this.plugin.settings.excludeFolders = str(value);
      this.plugin.refreshNotePanel(); // the pane behind the modal reflects the change now
    } else {
      return;
    }
    await this.plugin.saveSettings();
  }
}
