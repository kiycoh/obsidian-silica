# Silica ⇄ Obsidian bridge protocol — v1

The single shared contract between the Python side (`silica connect`, hosts the
WebSocket server) and the TypeScript plugin (`obsidian-silica`, dials in as
client). This file is duplicated verbatim in both repos; change it in lockstep.

Transport: one WebSocket, JSON **text** frames, loopback only. Symmetric once
open — either side sends frames at any time. `protocolVersion` below is `1`.

## Connection lifecycle

1. `silica connect` binds `ws://127.0.0.1:<port>` and writes
   `<vault>/.obsidian/silica-bridge.json` (mode 0600):
   `{ "port": <int>, "token": "<hex>", "pid": <int>, "protocolVersion": 1 }`.
2. The plugin reads that file via `vault.adapter.read`, dials the port, and sends
   `hello`. The server validates the token and `protocolVersion`, then replies
   `welcome` or closes with a reason.
3. Server ⇄ plugin now exchange frames until either side drops. On drop the
   plugin reconnects with backoff; the server keeps listening for the session's
   lifetime and dies when the session ends.

Why the server is on the Python side: it must live only inside the invoked
session (CHARTER — no resident listener), and the plugin gets a native
`WebSocket` client for free (no bundled `ws` dependency).

## Security model

- **Loopback bind only** (`127.0.0.1`). Never `0.0.0.0`.
- **Shared token** on `hello`. Any local process can reach a loopback port, so
  the token is the gate. It lives in `silica-bridge.json`, same local trust
  domain as the vault on disk.
- **Fixed method allowlist.** The plugin dispatches `rpc.method` against a static
  handler table — there is no `eval`, no dynamic code path. An unknown method
  returns `rpc_error`, never executes.
- **`normalizePath`** every path field of every incoming `rpc` before it touches
  `vault`/`fileManager`.
- **Origin**: accept a handshake only when `Origin` is absent (native WebSocket
  clients) or is `app://obsidian.md` (Obsidian's Electron renderer always sends
  it). Every web-page origin — loopback included — is refused.

## Frames

Every frame is a JSON object with a `type`. Correlation: `rpc*` frames by `id`
(server-assigned, monotonic per connection); `chat*` frames by `turnId`.

### Handshake

- plugin → server: `{ "type": "hello", "token": "<hex>", "protocolVersion": 1, "role": "plugin" }`
- server → plugin: `{ "type": "welcome", "vault": "<name>", "obsidianVersion": "<x>", "protocolVersion": 1 }`
- On bad token / version mismatch the server sends
  `{ "type": "bye", "reason": "<text>" }` and closes.

### Vault op (server → plugin, the driver channel)

- request: `{ "type": "rpc", "id": <int>, "method": "<name>", "params": { ... } }`
- reply:   `{ "type": "rpc_result", "id": <int>, "result": <json> }`
- error:   `{ "type": "rpc_error", "id": <int>, "error": "<message>" }`

The reply is sent **only after the native promise resolves** — the op's
postcondition (below) already holds. There is no settle-polling on the Python
side.

### Metadata event (plugin → server, unsolicited)

- `{ "type": "event", "name": "resolved", "path": "<vault-rel>" }`

Emitted when `metadataCache` finishes re-resolving links after a mutation. The
Python side may await it after a link-changing write but treats its absence as
**non-fatal** (registration ≠ resolution; the batch LINT gate audits graph
consistency afterward).

### Chat (plugin → server, the panel channel)

- plugin → server: `{ "type": "chat", "turnId": "<str>", "text": "<user input>" }`
- server → plugin: `{ "type": "chat_event", "turnId": "<str>", "event": <event dict> }`
  streamed 0..N times (see event vocabulary), then exactly one terminal:
  - `{ "type": "chat_done", "turnId": "<str>", "answer": "<md>", "html": "<html>" }`
  - `{ "type": "chat_error", "turnId": "<str>", "error": "<message>" }`
- plugin → server: `{ "type": "chat_cancel", "turnId": "<str>" }` (sets the
  turn's cancel token; effective at the next agent-loop boundary)
- A second `chat` while one is in flight is refused:
  `chat_error` with `"a turn is already in progress"` (mirrors the GUI `_busy`/409).

`event` dicts are `event_to_json(...)` output, reused verbatim from the web GUI:

| `event.type` | fields | meaning |
|---|---|---|
| `delta` | `kind` ∈ {reset, reasoning, text}, `text` | streamed LLM output |
| `tool_start` | `name`, `id` | tool call began (name is the human verb) |
| `tool_done` | `name`, `id` | tool call finished |
| `tool_error` | `name`, `id`, `error` | tool call failed |
| `batch` | `kind`, `label` | sub-agent batch run started |

## RPC method table

Every method is a static handler on the plugin's dispatch table. `path` fields
are `normalizePath`-ed. Postconditions are the reply's guarantee — the plugin
does not resolve the promise until they hold.

### Reads

| method | params | result | notes |
|---|---|---|---|
| `read` | `path` | `{ path, content, size }` | `vault.cachedRead` |
| `list_files` | `folder?` | `[{ name, path }]` | markdown files, folder-filtered |
| `search_context` | `query` | `[{ path, name, matches: [{ line, content }] }]` | per-line substring, lowercase |
| `search_context_batch` | `queries: [str]` | `{ query: [ …matches ] }` | one `cachedRead` sweep, all queries |
| `props_of` | `path` | `{ …frontmatter }` | `metadataCache.getFileCache(f).frontmatter` |
| `outline` | `path` | `[{ level, text, position }]` | `getFileCache(f).headings` |
| `resolved_links` | — | `{ resolved: {…}, unresolved: {…} }` | bulk `metadataCache.resolvedLinks`/`unresolvedLinks` — one round-trip feeds links/backlinks/orphans/unresolved/graph client-side |
| `mention_index` | `titles: [str]` | `{ title_lower: [path] }` | title-trie sweep over `cachedRead` bodies (mirrors `base.mentions_in`) |

### Writes (graph-safe)

| method | params | postcondition |
|---|---|---|
| `create` | `path`, `content` | file exists, readable, content reflects verbatim; errors if it already exists |
| `overwrite` | `path`, `content` | content reflects verbatim, **in place** (history/block-refs preserved — `vault.process`, not delete+create) |
| `append` | `path`, `content` | fragment visible at end (`vault.process(f, cur => cur + add)` — no Python-side read-modify-write) |
| `set_prop` | `path`, `name`, `value`, `type?` | `props_of(path)[name] === value` (`fileManager.processFrontMatter`, atomic) |
| `move` | `path`, `to` | dest readable **and** source gone **and** backlinks(source) empty (`fileManager.renameFile` — rewrites incoming wikilinks) |
| `delete` | `path` | path gone (`fileManager.trashFile` — recoverable, not `vault.delete`) |
| `autolink_note` | `path`, `candidates?` | returns `[titles linked]`; unlinked mentions of resolvable vault titles wrapped in links, single atomic `vault.process` write |

`result` for `create` is `{ name, path }`; the mutating writes reply `{ ok: true }`.

## Error taxonomy

- **Fatal** (op failed, propagate): `create` on existing path, `read`/`props_of`
  of a missing file, `move`/`delete` of a missing source, malformed params.
  → `rpc_error`; the Python driver raises.
- **Non-fatal** (best-effort, degrade): the `resolved` event never arriving,
  `mention_index` partial on a huge vault. The Python driver logs and continues;
  the batch LINT gate is the real consistency check.

The Python side keeps the same "default-vs-raise" split the CLI backend had
(distinguish "Obsidian unreachable" from "empty result") — but as an in-band
error-vs-empty distinction, not stdout archaeology.

## Backend fallback chain (Python startup, logged once)

`ws` (handshake ok) → `cli` (obsidian CLI + running Obsidian present) → `fs`
(headless disk). `cli_backend` is kept as fallback, not replaced.

## What v1 deliberately excludes

Version-history restore over the wire (Python uses content snapshots), the 30 KB
large-content special case (framing handles any size), settle-polling, and any
`eval`/dynamic-JS method. See the plan for the full non-port checklist.
