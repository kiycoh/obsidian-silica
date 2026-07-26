# Silica Bridge

Chat with the [Silica](https://github.com/kiycoh/silica-agent) knowledge-graph
agent from a side panel, and let it read and edit your notes through Obsidian's
own APIs. Every write lands in a source-control-style changes list with a
per-file diff, so you see what the agent touched before you keep it.

![The bridge panel](https://raw.githubusercontent.com/kiycoh/obsidian-silica/main/assets/screenshot.png)

## Requirements

This plugin is a client. It does nothing on its own: it needs the Silica agent
running on the same machine.

```sh
pip install "silica-agent[connect]"
cd /path/to/your/vault
silica connect
```

`silica connect` writes `<vault>/.obsidian/silica-bridge.json` (mode `0600`) with
the port and a per-session token. The plugin reads that file, connects, and shows
`connected` in the panel.

## Network use

The plugin opens a WebSocket to `127.0.0.1` (localhost) and nowhere else. It
never contacts a remote host. It talks only to the `silica connect` process you
started yourself, and no data leaves your machine through this plugin.

The agent itself may call a language model, which can be a local one (Ollama, LM
Studio, llama.cpp) or a hosted API. That choice is yours and it is configured on
the Silica side, not here.

## Use

1. Run `silica connect` in the vault.
2. Open the panel: the ribbon icon, or *Silica Bridge: Open bridge panel* in the
   command palette.
3. Type. Replies render as markdown, so wikilinks are clickable.

What the agent can do to the vault is a fixed allowlist: reads (`read`,
`list_files`, `props_of`, `outline`, `search_context`, `resolved_links`,
`mention_index`) and writes (`create`, `overwrite`, `append`, `set_prop`, `move`,
`delete`, `autolink_note`). Anything outside the list is refused by the plugin,
not merely unimplemented. The wire contract is in [PROTOCOL.md](PROTOCOL.md).

Writes driven from the terminal show up in the changes panel too. The list
belongs to the session, not to a chat turn, so a long run started in the
terminal is reviewable in the same place.

## Settings

- **Port override**: leave empty to use the port from `silica-bridge.json`. Set
  it only when you run the agent on a non-default port.

## Develop

```sh
npm install
npm run dev      # esbuild watch -> main.js
npm test         # node --test, handshake and reconnect state machine
npm run build    # strict tsc typecheck + production bundle
```

Symlink or copy this folder into
`<throwaway-vault>/.obsidian/plugins/silica-bridge/` (needs `manifest.json` and a
built `main.js`), then enable it in *Settings -> Community plugins*.

## License

MIT. The Silica agent itself is AGPL-3.0 and lives in
[its own repository](https://github.com/kiycoh/silica-agent).
