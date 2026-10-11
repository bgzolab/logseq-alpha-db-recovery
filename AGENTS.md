# AGENTS.md — Maintenance Notes

This repository recovers a 2024 **Logseq DB alpha** `db.sqlite` (schema v42) into (a) a standard Markdown file graph and (b) a current-schema database built with Logseq’s own importer.

`README.md` is the user-facing, intentionally short document. **Keep it that way.** Everything about the internals — the old storage format, the recovery pipeline, verification, tooling, and maintenance rules — belongs in this file.

All content in the generated outputs is personal graph data. Do not paste page names, journal dates, block counts, metadata values, or asset filenames into `README.md`; use placeholders and generic examples there.

---

## Context: why the original file cannot be imported

The old file is a **Logseq DB alpha** storage format:

| | Old file (2024 alpha) | Current version |
| --- | --- | --- |
| Storage engine | DataScript + custom SQLite adapter | Modern SQLite schema |
| Tables | A single `kvs` table (transaction/storage tree) | Full new schema |
| Schema version | **42** (older alpha versions differ) | **65.x** |
| Importer | — | Current schema only |

The importer rejects the outdated schema (*“Something went wrong”*). Only the container format is obsolete — the payload is intact.

---

## Inside the old file

### SQLite layer

The file contains exactly one table:

```sql
CREATE TABLE kvs (
  addr      INTEGER PRIMARY KEY,  -- node address
  content   TEXT,                 -- serialized node payload (Transit JSON)
  addresses JSON                  -- child node addresses (branch nodes only)
);
```

`addr` semantics (from Logseq’s DataScript storage implementation):

| addr | Meaning |
| --- | --- |
| `0` | **Root node**: schema, root addresses of the three indexes, `max-eid` / `max-tx` / `max-addr`, branch factor, index metadata |
| `1` | **Tail**: the most recent transactions (not yet merged into the storage tree; must be replayed) |
| `>= 1000000` | **Storage tree nodes**: leaves and branches of a B-tree |

Rows that were updated but not garbage-collected remain in the table, so the total row count is larger than the set of reachable nodes. Always walk from the root.

### Payload encoding: Transit (verbose JSON)

`content` is ClojureScript **Transit** text. Common forms:

| Form | Meaning |
| --- | --- |
| `["^ ", k1, v1, k2, v2, …]` | map (`"^ "` is Transit’s map marker) |
| `~:foo/bar` | keyword (property names etc.) |
| `~i42` | integer |
| `~u<uuid>` | UUID |
| `^5`, `^A`, … | cached string back-references (a string’s second occurrence becomes `^` + index) |
| `[…]` | arrays/vectors |

Every node looks like:

```json
["^ ", "~:keys", [ [entity-id, "~:attribute", value, tx-id], ... ]]
```

i.e. a leaf stores a batch of **datoms**: `[e a v tx]`
(e = entity id, a = attribute keyword, v = value, tx = transaction id). Branch nodes also have `:keys` plus their children’s addresses in the `addresses` column.

### Root node (addr = 0) metadata

```
:schema            attribute definitions + entity-id ↔ :db/ident table
:eavt / :aevt / :avet   root addresses of the three indexes
:eavt-metadata    {:count <datom count>, :shift <n>}
:max-eid <highest entity id>
:max-tx <highest transaction id>
:max-addr <highest node address>
:branching-factor <n>
:ref-type <:strong / other>
```

Plus `:logseq.kv/...` entries such as `schema-version`, `graph-created-at` and import metadata. `:logseq.kv/schema-version` tells you which era of the format you are dealing with (`42` for the file in this recovery).

`:eavt-metadata{:count}` is the authoritative datom count and is used as the decode self-check.

### Tail (addr = 1)

The tail is a list of recent transaction batches: `[ [datom...], [datom...], ... ]`, each datom being `[e a v tx]`.
Reading the complete database = **leaf datoms from the storage tree + replaying the tail**. In some files the tail only holds a few metadata entries and does not affect the content.

### schema v42 data-model quirks

- Pages: `:block/type` is `"page"` / `"journal"`; names/titles live in `:block/name` / `:block/title`; journals have `:block/journal-day`.
- Blocks: `:block/page` (owning page), `:block/parent`, `:block/order` (base62 fractional index, sortable as strings), `:block/title` (content).
- **Property-value blocks**: a block property such as `key:: value` also creates a child block carrying `:logseq.property/created-from-property` (pointing back to the property entity). The value lives in the child’s title, sometimes as a `[:block/uuid …]` composite ref or in `:property.value/content`.
- Content references are encoded as `[[~^<uuid>]]` (including tag syntax `#[[~^<uuid>]]`).
- Legacy concepts: “Page Tags” use `:logseq.property/page-tags`; task status uses `:logseq.task/status` pointing at “closed value” entities.

---

## The recovery pipeline

The key insight: the old file **is** a complete set of EAVT datoms — decoding the storage tree yields the entire graph, which can then be mapped to any target format.

```
decode kvs (Transit) ──▶ walk the :eavt storage tree + replay tail ──▶ rebuild entities/tree
        ──▶ write a Markdown file graph ──▶ official importer builds a current-schema db.sqlite
```

### Decode kv rows into datoms

- Read the table with `sql.js`; decode each `content` with `transit-js` (its reader accepts verbose Transit).
- Start from `:eavt` in the root node and recursively walk nodes: nodes with `addresses` are branches (descend), leaves contribute their `:keys` datoms.
- Merge the transactions stored at `addr=1` (tail).
- Self-check: the recovered datom count must equal the root metadata’s `:eavt-metadata{:count}`.

### Rebuild entities and the block tree

- Group datoms into `entity id → attribute → values`.
- Rebuild pages/blocks from `:block/page`, `:block/parent`, `:block/order` (sorted by fractional index).
- Index `:block/uuid` so inline `~^<uuid>` references can be turned back into page titles.

### Markdown export mapping

| Old data | Exported as |
| --- | --- |
| Pages / journals | `pages/*.md` / `journals/YYYY_MM_DD.md` |
| `:block/title` with bracket refs | `- content`, `[[~^uuid]]` → `[[Page Title]]`, `#[[~^uuid]]` → `#[[Page Title]]` |
| Property-value blocks (`created-from-property`) | `property-name:: value` lines under the parent block |
| Task status | leading `TODO` / `DOING` / `DONE` / `CANCELED` markers |
| Task deadline | appended `DEADLINE: <YYYY-MM-DD Day>` |
| `:block/collapsed?`, `:logseq.property/background-color`, `:logseq.property/order-list-type` | `collapsed:: true`, `background-color:: grey`, `logseq.order-list-type:: number` |
| Page `alias` / `icon` / `public` / `exclude-from-graph-view` | same page properties |
| `:logseq.property/parent` (page hierarchy) | folder hierarchy `pages/parent/child.md` |
| `:file/content` of `logseq/config.edn`, `custom.css`, `custom.js` | written back verbatim |

### Importer pitfalls (learned the hard way)

1. Journal files must be named `journals/YYYY_MM_DD.md`, and `logseq/config.edn` should set `:journal/page-title-format` to the format used by the graph’s journal links, so links such as `[[YYYYMMDD]]` resolve to journal pages.
2. Completely empty page/journal files are not imported as pages — add a `title:: <name>` line to keep them alive.
3. Empty journal files cause `[:block/uuid …]` lookup failures during import; hence pitfall 2.
4. A page property `tags:: [[some-tag]]` survives in the Markdown, but the official converter can drop it when the same page also contains a self-reference. Markdown is unaffected.
5. With `--all-tags` (the app’s default), inline hashtags become class tags and are moved out of block text into `:block/tags`.
6. Page hierarchy is preserved as folders in the file graph; the importer keeps the child’s name/title but does not recreate a page-parent link in the DB.
7. Assets are never inside `db.sqlite`: only references. Unresolved references are listed by the importer as “Ignored assets” (see `recovered-db/import-log.txt`). Restore the files under `recovered-graph/assets/` to fix them.

### Build the current-schema db.sqlite

```bash
# from the logseq repo clone, inside deps/graph-parser
pnpm exec nbb-logseq script/db_import.cljs <Markdown graph> <output db.sqlite> --validate --all-tags
```

The script is the same code path the app’s “File graph → DB” import uses.

---

## Verification results

| Check | Result |
| --- | --- |
| Recovered datom count vs. root metadata `:count` | matched exactly ✅ |
| Per-page block counts, old DB vs. new DB | all matched ✅ |
| Journals (count, days, titles) | preserved ✅ |
| Tasks and statuses | preserved ✅ |
| Custom properties and page metadata | preserved ✅ |
| Official importer validation (`--validate`) | `Valid!` ✅ |

The new DB reports slightly more datoms at read time than the sum of the old content datoms; the extra ones come from the import marker and newer-schema bookkeeping, not from lost or duplicated content.

Useful spot-checks after a re-run:

- decode self-check: `work/datoms.json` length vs. `work/root.json` `:eavt-metadata.count`
- per-page counts: query the new DB for `[:find ?title (count ?b) :where [?b :block/page ?p] [?p :block/title ?title]]`
- validation: the `--validate` output must end with `Valid!`

---

## Scripts and environment

### Scripts (`tools/`)

| File | Purpose |
| --- | --- |
| `decode.cjs` | Open the old `db.sqlite`, Transit-decode `kvs`, walk the storage tree, dump datoms |
| `export-md.cjs` | Turn datoms into the `recovered-graph/` Markdown file graph |
| `inspect.cjs` / `show.cjs` / `query.cjs` | Ad-hoc exploration helpers (entities, block trees, property stats) |
| `verify-db.cjs` | Basic cross-checks between old and new databases |
| `build-emoji-map.cjs` | Build the emoji id → character map (page icons) from `@emoji-mart/data` |

Basic usage:

```bash
cd tools
npm install          # transit-js, sql.js, @emoji-mart/data
node decode.cjs      # old DB  -> ../work/datoms.json etc.
node export-md.cjs   # datoms  -> ../recovered-graph/
```

### Requirements for the DB conversion step

- Decoding/exporting: any recent Node.js, plus `transit-js` and `sql.js` (pure JS, no native build).
- Building the current-schema `db.sqlite`:
  - a shallow clone of the official `logseq/logseq` repo (only `deps/` is needed);
  - `pnpm install` inside `deps/graph-parser` (its `nbb.edn` pulls in `deps/common`, `deps/db`, `deps/outliner`) — install pnpm via `corepack enable` or `npm i -g pnpm` if needed;
  - **Node 22** (for the `better-sqlite3` prebuilt binary) and **babashka** (`bb`, used by nbb to resolve dependencies).
  - This recovery used portable copies placed in `tools/node22/` and `tools/bb/` to avoid touching the system environment.

### End-to-end commands (reference)

```powershell
# 1) decode + export Markdown
cd tools
node decode.cjs
node export-md.cjs

# 2) convert to current-format DB with the official script
#    (PATH needs node22 and bb from this repo)
$env:PATH = "<this-repo>\tools\node22;<this-repo>\tools\bb;" + $env:PATH
cd ..\logseq-repo\deps\graph-parser
pnpm exec nbb-logseq script/db_import.cljs "<this-repo>\recovered-graph" `
    "<this-repo>\recovered-db\db.sqlite" --validate --all-tags
```

---

## Maintenance notes

- **Keep `README.md` short and user-facing.** Add internals, findings, and caveats to this file instead.
- **Never commit data or toolchains.** `.gitignore` excludes the original `db.sqlite`, all `recovered-*` outputs, `work/`, `logseq-repo/`, `tools/node22/`, `tools/bb/`, `tools/node_modules/`, and generated maps. Committed files should stay limited to scripts, manifests, and docs.
- **Do not put personal graph content into docs.** Use placeholders (`[[YYYYMMDD]]`, `key:: value`) instead of real page names, dates, or asset filenames.
- **After changing the exporter or decoder, re-run the whole pipeline and re-verify:** decode self-check → Markdown export → official import with `--validate` → compare per-page counts. All three steps are expected to pass before results are considered good.
- If the importer behavior changes upstream, the edge cases in *Importer pitfalls* may need revisiting; the cheapest verification is re-running the official `db_import.cljs` on `recovered-graph/` and diffing `recovered-db/import-log.txt`.
- Scripts are plain Node `.cjs` files with zero build step; keep them dependency-light (`transit-js`, `sql.js`, `@emoji-mart/data`).
