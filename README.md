# Logseq DB Recovery (2024 Alpha → Current)

A small toolkit that recovers a `db.sqlite` exported by a 2024 Logseq DB alpha (schema v42), which current Logseq can no longer import (“Something went wrong”). The data is intact; only the storage format is outdated.

The pipeline decodes the old SQLite storage (`kvs` table with Transit-encoded datoms), rebuilds a standard Markdown file graph, and regenerates a current-schema database using Logseq’s own importer.

## Outputs

| Path | Description |
| --- | --- |
| `recovered-graph/` | Standard Logseq file graph (Markdown): `pages/`, `journals/`, `logseq/config.edn`, `logseq/custom.css`, `logseq/custom.js` |
| `recovered-graph.zip` | Zip copy of the file graph |
| `recovered-db/db.sqlite` | Current-schema DB graph, validated by the official importer |
| `recovered-db/datoms.edn` | Datom dump of the new DB (EDN) |

## Import the recovered graph

### From the Markdown file graph (recommended)

Version-agnostic; works with any current Logseq release.

1. Open the **Import** screen (web or desktop DB version).
2. Choose **“File graph → DB”**.
3. Select the **`recovered-graph` folder itself** (it must contain `logseq/config.edn`).
4. Name the graph and wait for the import to finish.

### From SQLite (optional)

Choose **“SQLite”** and upload `recovered-db/db.sqlite`. This file was generated against current Logseq `master`; if your app is older and rejects the schema, use the Markdown import instead.

### Classic (file-based) Logseq

Open `recovered-graph` as a folder graph.

## Run the recovery yourself

```bash
cd tools
npm install          # transit-js, sql.js, @emoji-mart/data
node decode.cjs      # old DB  -> ../work/datoms.json etc.
node export-md.cjs   # datoms  -> ../recovered-graph/
```

Regenerating the current-schema `db.sqlite` additionally needs Node 22, babashka, pnpm and a clone of the Logseq repo; see the end-to-end commands in [AGENTS.md](AGENTS.md).

## Known limitations

- The old DB stores only *references* to attached assets, never the files themselves. Missing references are listed in `recovered-db/import-log.txt`; copy the files back under `recovered-graph/assets/` to restore them.
- `tags::` page properties survive in the Markdown; the official converter may drop one in a self-reference edge case.
- Inline hashtags become class tags on DB import (`--all-tags`, the app default).
- Page hierarchy is kept as folders in the file graph.

## Layout

```
├─ db.sqlite           # original old DB (untouched)
├─ recovered-graph/    # Markdown file graph (output)
├─ recovered-db/       # current-schema DB + datoms dump (output)
├─ work/               # intermediate artifacts and logs
├─ tools/              # recovery scripts and their dependencies
└─ logseq-repo/        # temporary Logseq clone, only used to build the DB output
```

`logseq-repo/`, `tools/node22/`, `tools/bb/` and `tools/node_modules/` are temporary and can be deleted at any time.

## Technical details

Old file format, recovery internals, verification results, and maintenance rules live in [AGENTS.md](AGENTS.md).
