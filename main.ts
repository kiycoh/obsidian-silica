import { App, ItemView, MarkdownRenderer, Plugin, PluginSettingTab, WorkspaceLeaf, normalizePath, type SettingDefinitionItem } from "obsidian";

import { BridgeClient, type Frame, type SocketLike, type Status } from "./bridge.ts";
import { applyChatFrame, emptyTurn, type TurnState } from "./chat.ts";
import { diffLines, hunks, tally, type DiffLine } from "./diff.ts";
import { dispatchRpc, RPC_METHODS, type Change, type RpcApp } from "./handlers.ts";

const VIEW_TYPE = "silica-bridge-view";
const BRIDGE_FILE = ".obsidian/silica-bridge.json";
const MAX_CHANGED_FILES = 200; // a long /ingest run, not a memory leak
const MAX_DIFF_LINES = 400; // per expanded file — a 5k-line overwrite must not stall the sidebar

interface SilicaSettings {
  portOverride: string;
}
const DEFAULT_SETTINGS: SilicaSettings = { portOverride: "" };

export default class SilicaBridgePlugin extends Plugin {
  settings: SilicaSettings = DEFAULT_SETTINGS;
  client: BridgeClient | null = null;
  status: Status = "disconnected";
  statusDetail = "";
  /** What Silica has written this session, one row per file, insertion-ordered. */
  changes = new Map<string, Change>();

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new BridgeView(leaf, this));
    this.addRibbonIcon("link", "Silica bridge", () => void this.activateView());
    this.addCommand({
      id: "open-silica-bridge",
      name: "Open Silica bridge panel",
      callback: () => void this.activateView(),
    });
    this.addSettingTab(new SilicaSettingTab(this.app, this));
    // Heavy setup after layout is ready (avoids the startup `create` event storm).
    this.app.workspace.onLayoutReady(() => this.connect());
  }

  onunload(): void {
    this.client?.stop();
    this.client = null;
  }

  connect(): void {
    if (this.client) return;
    this.client = new BridgeClient({
      readBridgeInfo: async () => {
        try {
          const info = JSON.parse(await this.app.vault.adapter.read(BRIDGE_FILE));
          const override = this.settings.portOverride.trim();
          if (override) info.port = Number(override);
          return info;
        } catch {
          return null; // no session running yet
        }
      },
      connect: (url) => wrapSocket(new WebSocket(url)),
      // Defense-in-depth: refuse a bridge whose vault isn't this one, so a stray
      // silica-bridge.json can't make Silica reason over vault A and write to B.
      verifyWelcome: (frame) => {
        const served = String(frame.vault ?? "");
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
      const before = prev ? prev.before : c.before;
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
    this.eachView((v) => v.renderChanges());
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
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);
    const leaf: WorkspaceLeaf | null = existing.length ? existing[0] : workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing.length) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
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
  // Every write repaints the whole list, so the per-row diff is memoised. noteChange
  // rebuilds the Change object on each write, which is exactly the invalidation.
  private diffCache = new WeakMap<Change, DiffLine[]>();

  constructor(leaf: WorkspaceLeaf, plugin: SilicaBridgePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Silica bridge"; }
  getIcon(): string { return "link"; }
  async onOpen(): Promise<void> { this.build(); }

  private build(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("silica-bridge");
    this.statusEl = el.createEl("p", { cls: "silica-status" });
    this.logEl = el.createDiv({ cls: "silica-log" });
    this.changesEl = el.createDiv({ cls: "silica-changes" });
    this.renderChanges();
    const row = el.createDiv({ cls: "silica-input-row" });
    this.inputEl = row.createEl("textarea", { attr: { rows: "2", placeholder: "Message Silica…" } });
    this.sendBtn = row.createEl("button", { text: "Send" });
    this.stopBtn = row.createEl("button", { text: "Stop" });
    this.stopBtn.hide();
    this.sendBtn.onclick = () => this.sendChat();
    this.stopBtn.onclick = () => {
      if (this.turnId) this.plugin.client?.send({ type: "chat_cancel", turnId: this.turnId });
    };
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.sendChat(); }
    });
    this.renderStatus();
  }

  renderStatus(): void {
    if (!this.statusEl) return; // status can fire before onOpen builds the DOM
    const s = this.plugin.status;
    if (s !== "connected" && this.turnId) this.abortTurn(s); // dropped mid-turn
    const detail = this.plugin.statusDetail ? ` — ${this.plugin.statusDetail}` : "";
    this.statusEl.setText(`${s}${detail}`);
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
    head.createSpan({ text: `${changes.length} file${changes.length === 1 ? "" : "s"} changed` });
    const clear = head.createEl("button", { text: "Clear", attr: { "aria-label": "Clear the change list" } });
    clear.onclick = () => {
      this.plugin.changes.clear();
      this.expanded.clear();
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
    const toggle = row.createEl("button", { cls: "silica-change-toggle" });
    toggle.setAttribute("aria-label", `${c.kind} ${c.path}, ${added} added, ${removed} removed`);
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

    const reveal = row.createEl("button", { cls: "silica-change-open", text: "↗" });
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
    this.bodyEl = asst.createDiv({ cls: "silica-body" });
    this.bodyEl.setText("…");
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
      const glyph = tool.status === "done" ? "✓" : tool.status === "error" ? "✗" : "⏺";
      this.toolsEl
        .createDiv({ cls: `silica-tool silica-tool-${tool.status}` })
        .setText(`${glyph} ${tool.label}${tool.error ? ` — ${tool.error}` : ""}`);
    }
    if (!t.done) this.bodyEl.setText(t.text || "…");
    this.logEl.scrollTop = this.logEl.scrollHeight;
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

// Declarative settings (Obsidian 1.13+): getSettingDefinitions replaces the
// deprecated display(); getControlValue/setControlValue bind keys to our store.
class SilicaSettingTab extends PluginSettingTab {
  plugin: SilicaBridgePlugin;

  constructor(app: App, plugin: SilicaBridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const detail = this.plugin.statusDetail ? ` — ${this.plugin.statusDetail}` : "";
    return [
      { name: "Connection status", desc: `${this.plugin.status}${detail}` },
      {
        name: "Port override",
        desc: "Leave empty to use the port from silica-bridge.json.",
        control: { type: "text", key: "portOverride", placeholder: "Auto" },
      },
    ];
  }

  getControlValue(key: string): unknown {
    return key === "portOverride" ? this.plugin.settings.portOverride : undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "portOverride") {
      this.plugin.settings.portOverride = String(value ?? "");
      await this.plugin.saveSettings();
    }
  }
}
