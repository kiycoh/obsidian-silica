# Silica Bridge

[Silica](https://github.com/kiycoh/silica-agent)'s mechanical algorithms, running
on your vault with no model, no network and no configuration: a panel that tells
you what the vault knows about the note in front of you and what is wrong with
it, ranked search, bulk autolinking and a community graph. Plus a side panel that
chats with the Silica agent when you have one running, and lets it read and edit
your notes through Obsidian's own APIs. Every write, whoever made it, lands in a
source-control-style changes list with a per-file diff, so you see what changed
before you keep it.

![The bridge panel](https://raw.githubusercontent.com/kiycoh/obsidian-silica/main/assets/screenshot.png)

## Offline

These need nothing but the vault. They run on an index the plugin builds itself
from your notes, kept current by mtime and never written to disk.

- **Note panel**. Everything the vault has to say about the note you have open,
  each note listed once under the sharpest thing there is to say about it:
  - *Related*: Jaccard overlap of each note's top-30 stems, the CORRELATE metric
    from Silica's ADR-0013. Backlinks answer "who linked here"; this answers "who
    is about the same thing", which nobody had to link. A row marked `unlinked`
    is one where the overlap clears the structural bar and no wikilink exists
    either way.
  - *Near-duplicates*: the same idea captured twice, found by Jaccard over whole
    stem sets rather than the top 30, so two notes on one subject do not read as
    copies of each other.
  - *Orphans you could adopt*: notes nobody points at that overlap this one. An
    orphan is invisible from itself, since you never open it; this is the surface
    that can show you one.
  - *Links without substance*: links written out of this note whose target shares
    almost no vocabulary with it. Index notes are exempt.
  - *Broken links*: link text that resolves to no file.
- **Next**. The button at the top of the panel walks the whole vault worst-first,
  one note per press, and says why each one is there. The four signals are fused
  by rank, not by score, because a Jaccard and a count of broken links share no
  scale. Nothing is remembered between presses: the signal is the state, so a
  note you fix simply stops qualifying.
- **Search by relevance**. BM25 over the same index, fused by rank with a title
  match. Obsidian's own search is a boolean filter where every hit is equally
  good; this one ranks. Each hit carries a line of context with the match
  highlighted, and `path:folder/` anywhere in the query scopes it to one folder.
- **Autolink this note** / **Autolink every note**. Injects wikilinks for vault
  titles a note mentions but does not link, skipping frontmatter, code, math,
  headings and existing links. The pass lands in the changes list, so it is
  reviewed and revertable file by file.
- **Community graph**. Louvain over the written links plus the inferred CORRELATE
  edges, one hue per community, labelled with the stems that community has and
  its neighbours do not.

Except for autolink, which you ask for, none of this writes to your vault.

Notes written from a template are what breaks this kind of tool: a vault of daily
notes shares its scaffolding across every file, so a naive overlap relates all of
them to all of them. Every proposal here is therefore gated on the overlap that
survives dropping the stems more than a quarter of the vault carries. That kills
the whole class in the algorithm, which is why there is no list of dismissed
suggestions to maintain.

None of these calls a language model, and the quality ceiling says so: the
stemmer is a light suffix stripper for English and Italian rather than Snowball,
the language is detected once per vault and then frozen, and the thresholds are
starting points rather than measured optima.

## Requirements

The chat panel below is a client: for that half you need the Silica agent
running on the same machine.

```sh
pip install "silica-agent[connect]"
cd /path/to/your/vault
silica connect
```

`silica connect` writes `silica-bridge.json` into the vault's configuration
folder — `.obsidian`, unless the vault renamed it — (mode `0600`) with
the port and a per-session token. The plugin reads that file, connects, and shows
`connected` in the panel.

## Network use

The offline features open no connection at all. The chat panel opens a WebSocket
to `127.0.0.1` (localhost) and nowhere else. It never contacts a remote host. It
talks only to the `silica connect` process you started yourself, and no data
leaves your machine through this plugin.

The agent itself may call a language model, which can be a local one (Ollama, LM
Studio, llama.cpp) or a hosted API. That choice is yours and it is configured on
the Silica side, not here.

## Use

The graph has its own ribbon icon. All of them are also buttons along the top of
the bridge panel, and commands under *Silica Bridge* in the palette. The first one
you run builds the index; after that a rebuild only re-reads the notes whose
mtime moved, and a rebuild that finds nothing moved reuses the index whole.

For the chat panel:

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
- **Excluded folders**: comma-separated folders whose notes are left out of
  related notes, the community graph and attention. Made for journals and other
  templated notes: notes written from the same template share most of their
  vocabulary, so they all relate to each other, and no statistic can tell a
  template from a topic — declaring the folder is the fix. Search still finds
  the excluded notes, and their written wikilinks stay on the graph. Until you
  edit the field it follows your Daily notes folder automatically, so the
  common case needs no setup; clear it to exclude nothing.

## Develop

```sh
npm install
npm run dev      # esbuild watch -> main.js
npm test         # node --test: the four offline algorithms, plus the bridge state machine
npm run build    # strict tsc typecheck + production bundle
```

Symlink or copy this folder into
`<throwaway-vault>/.obsidian/plugins/silica-bridge/` (needs `manifest.json` and a
built `main.js`), then enable it in *Settings -> Community plugins*.

## License

MIT. The Silica agent itself is AGPL-3.0 and lives in
[its own repository](https://github.com/kiycoh/silica-agent).
