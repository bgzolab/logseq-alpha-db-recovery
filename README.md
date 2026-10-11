# Logseq DB 旧数据库（schema v42）恢复说明

> 2024 年 Logseq DB 内测版导出的 `db.sqlite`，在当前（2026）网页版/DB 版中导入会报 “Something went wrong”。
> 本文记录该文件的**内部结构**、**恢复原理**与**使用方式**，既作为本次恢复的说明，也供遇到同类问题的朋友参考。
> 结论：**数据没有损坏**，全部内容已成功解出并转换为两种可用格式。

- 原始文件：`db.sqlite`（1.8 MB，2024-10-27，schema v42，**未做任何改动**）
- 恢复结果：
  - `recovered-graph/` —— 标准 Logseq 文件图谱（Markdown），可直接导入当前 DB 版，也可用经典文件版打开
  - `recovered-db/db.sqlite` —— 用官方最新 importer 重新生成的当前格式 DB 图谱（schema 65.34，通过官方校验）
- 恢复规模：**10968 条 datom**（与文件内记录的条数完全一致）、31 个页面/日记、约 690 个块

---

## 目录

- [1. 为什么网页版导入会报错](#1-为什么网页版导入会报错)
- [2. 旧文件内部结构](#2-旧文件内部结构)
- [3. 恢复原理与步骤](#3-恢复原理与步骤)
- [4. 恢复结果与完整性核对](#4-恢复结果与完整性核对)
- [5. 如何使用](#5-如何使用)
- [6. 已知差异与缺失](#6-已知差异与缺失)
- [7. 复现 / 工具说明](#7-复现--工具说明)
- [8. 目录清单与可清理项](#8-目录清单与可清理项)
- [English summary](#english-summary)

---

## 1. 为什么网页版导入会报错

旧文件是 **Logseq DB 内测版**的存储格式：

| | 旧文件（2024-10） | 当前版本（2026） |
| --- | --- | --- |
| 存储引擎 | DataScript + 自定义 SQLite 适配器 | 新版 SQLite schema |
| 表结构 | 只有一张 `kvs` 表（事务日志/存储树） | 完整的新 schema |
| schema 版本 | **42** | **65.34**（本次生成所用版本） |
| 导入器 | 无 | 只兼容当前 schema |

当前版本直接导入旧 schema 会失败，所以出现 “Something went wrong”。这只是**外壳格式过时**，逐条解析后数据是完整的。

---

## 2. 旧文件内部结构

### 2.1 SQLite 层

整个文件只有一张表（共 1574 行）：

```sql
CREATE TABLE kvs (
  addr      INTEGER PRIMARY KEY,  -- 节点地址
  content   TEXT,                 -- 序列化后的节点内容（Transit JSON）
  addresses JSON                  -- 子节点地址列表（仅分支节点有值）
);
```

`addr` 的语义（来自 Logseq/DataScript 的存储实现，见后文“存储树”）：

| addr | 含义 |
| --- | --- |
| `0` | **根节点**：schema、三个索引的根地址、`max-eid`/`max-tx`/`max-addr`、分支因子等元数据 |
| `1` | **tail**：最近几个事务的 datoms（尚未合并进存储树，读取时要重放） |
| `>= 1000000` | **存储树节点**：B 树的叶子/分支节点 |

> 文件里出现过一次的“旧版本”行（upsert 但未 GC）也会留在表中，所以总行数（1574）多于实际可达节点数；以根节点出发遍历到的节点为准。

### 2.2 content 的编码：Transit（verbose JSON）

`content` 是 ClojureScript 的 **Transit** 序列化文本，常见形式：

| 写法 | 含义 |
| --- | --- |
| `["^ ", k1, v1, k2, v2, ...]` | map（`"^ "` 是 Transit 的 map 标记） |
| `~:foo/bar` | keyword（属性名等） |
| `~i42` | 整数 |
| `~u<uuid>` | UUID |
| `^5`、`^A` … | 字符串缓存引用（同一字符串第二次出现时用 `^` + 索引表示） |
| `[…][…]` | 数组/向量 |

每个节点内容形如：

```json
["^ ", "~:keys", [ [实体id, "~:属性", 值, 事务id], ... ]]
```

即叶子节点里保存的是一批 **datom**：`[e a v tx]`
（e=实体 id，a=属性关键字，v=值，tx=事务 id）。分支节点同样有 `:keys`，并在 `addresses` 列保存子节点地址。

### 2.3 根节点（addr = 0）元数据

根节点的 map 里可以读到（节选）：

```
:schema           属性定义 + 实体 id ↔ :db/ident 对照表
:eavt / :aevt / :avet   三个索引的根节点地址
:eavt-metadata    {:count 10968, :shift 2}
:max-eid 1063
:max-tx 536874748
:max-addr 1002349
:branching-factor 32      B 树分支因子
:ref-type :strong
```

以及 `:logseq.kv/...` 条目给出的：`schema-version 42`、`graph-created-at 1729926668877`（2024-10-26）。

### 2.4 tail（addr = 1）

tail 是「最近事务」的列表：`[ [datom...], [datom...], ... ]`，每条又是一批 `[e a v tx]`。
读取完整数据 = **存储树的叶子 datoms + tail 里的事务重放**（本文件 tail 里只有几条 kv 元数据，不影响正文）。

### 2.5 数据模型（schema v42 特有的几点）

- 页面：`:block/type` = `"page"` / `"journal"`；名字/标题在 `:block/name`、`:block/title`；日记有 `:block/journal-day`。
- 块：`[:block/page]` 所属页面、`[:block/parent]` 父块、`[:block/order]` 顺序（base62 分数索引，可用字符串排序）、`[:block/title]` 正文。
- **属性值块**：v42 里 `name:: TBA` 这样的块属性会额外生成一个子块，带 `:logseq.property/created-from-property` 指回属性实体，值放在子块标题里（甚至可能是 `[:block/uuid …]` 复合引用、`:property.value/content`）。
- 内容引用：正文里页面引用被编码成 `[[~^<uuid>]]`（包括标签写法 `#[[~^<uuid>]]`）。
- 老概念：`Page Tags`（页面标签）用 `:logseq.property/page-tags` 表达，而任务状态是 `:logseq.task/status` 指向“闭集值”（closed value）实体。

---

## 3. 恢复原理与步骤

整体思路：**旧文件本身就是一份完整的 EAVT datom 集合**，只要把存储树完整解码，就能重建全部内容，再映射成当前格式。

```
解码 kvs(Transit) ─> 遍历 eavt 存储树 + 重放 tail ─> 重建实体/树结构
        ─> 生成 Markdown 文件图谱 ─> 官方 importer 转换为当前格式 db.sqlite
```

### 步骤 1：解码 kvs（Transit → datoms）

- 用 `sql.js` 读表，用 `transit-js` 解码 `content`（它的 reader 同时兼容 verbose 写法）。
- 从 `addr=0` 的根拿到 `:eavt` 根地址，递归遍历所有节点：有 `addresses` 的是分支（继续下钻），没有的是叶子（收集 `:keys` 里的 datom）。
- 把 `addr=1` 的 tail 事务也合并进来。
- 完整性自检：收集到的 datom 数 = 根元数据里的 `:eavt-metadata{:count}` → **10968 = 10968 ✅**

### 步骤 2：重建实体与块树

- 把 datoms 归并为 `实体 id → 属性 → 值列表`。
- 用 `:block/page`、`:block/parent`、`:block/order` 重建页面与块的层级（按分数索引字符串排序）。
- 用 `:block/uuid` 建索引，把正文里的 `~^<uuid>` 还原成页面标题。

### 步骤 3：转换为文件图谱（Markdown）

| 旧数据 | 导出为 |
| --- | --- |
| 页面 / 日记 | `pages/*.md` / `journals/YYYY_MM_DD.md` |
| `:block/title` + 括号引用 | `- 正文`，`[[~^uuid]]` → `[[页面名]]`、`#[[~^uuid]]` → `#[[页面名]]` |
| 属性值块（`created-from-property`） | 父块下的 `属性名:: 值` 行 |
| `:logseq.task/status` | 块首标记 `TODO` / `DOING` / `DONE` / `CANCELED` 等 |
| `:logseq.task/deadline` | 正文追加 `DEADLINE: <2023-03-26 Sun>` |
| `:block/collapsed?`、`:logseq.property/background-color`、`:logseq.property/order-list-type` | `collapsed:: true`、`background-color:: grey`、`logseq.order-list-type:: number` |
| 页面 `alias` / `icon` / `public` / `exclude-from-graph-view` | 同名页面属性行 |
| `:logseq.property/parent`（页面父子） | 文件层级 `pages/grammer/english-grammer.md` |
| `:file/content` 中的 `logseq/config.edn`、`custom.css`、`custom.js` | 原样写回 |

导出时的几个**关键兼容点**（否则官方 importer 会丢东西或报错）：

1. 日记文件名必须是 `journals/YYYY_MM_DD.md`，并在 `logseq/config.edn` 里写 `:journal/page-title-format "yyyyMMdd"`，这样 `[[20240830]]` 这类引用才能解析回日记页。
2. 完全空的页面/日记文件不会被导入为页面，需要补一行 `title:: <标题>`。
3. 空文件引用会引发 `[:block/uuid …]` 查找失败，这就是补 `title::` 的原因。

### 步骤 4：生成当前格式 db.sqlite

用官方仓库自带脚本（`logseq/logseq` → `deps/graph-parser/script/db_import.cljs`，即 App 内“文件图谱 → DB”导入的同一套代码）把上一步的 Markdown 图谱导入成当前 schema 的 `db.sqlite`：

```bash
# 在 logseq 仓库的 deps/graph-parser 目录下
pnpm exec nbb-logseq script/db_import.cljs <Markdown图谱目录> <输出db.sqlite> --validate --all-tags
```

导入结束时官方自检输出 `Valid!`，并且分页面块数与旧库逐一对齐（见下节）。

---

## 4. 恢复结果与完整性核对

### 4.1 内容清点

- **31 个页面 / 日记**：27 个普通页面 + 4 篇日记（20221219、20230326、20240830、20241026）
- **约 690 个正文块**（不含属性值块），全部层级与顺序保持
- **4 个任务**：Todo / Done / Canceled 状态齐全
- 页面别名（语法、英语语法）、图标（⚖️）、`tags::`、`collapsed`、背景色、有序列表等属性保留
- 自定义属性：`name` / `full` / `description` / `type` / `source` / `created` / `also` / `published-date` / `weread` / `isbn` / `cover`
- 引用与宏原样保留：`[[页面]]`、`#[[标签]]`、`{{cloze …}}`、`{{video …}}`、`$$公式$$`、外链等

### 4.2 核对

| 核对项 | 旧库 | 新库 | 结果 |
| --- | --- | --- | --- |
| datom 数（旧库） | 10968 | —— | 与元数据完全一致 |
| english 页块数 | 390 | 390 | ✅ |
| english-word 页块数 | 121 | 121 | ✅ |
| english-grammer 页块数 | 115 | 115 | ✅ |
| japanese / chinese 页块数 | 31 / 31 | 31 / 31 | ✅ |
| grammer / Contents 页块数 | 2 / 1 | 2 / 1 | ✅ |
| 日记 | 4 篇（标题 yyyyMMdd） | 4 篇（标题 yyyyMMdd） | ✅ |
| 官方校验 | —— | `--validate` → `Valid!` | ✅ |

---

## 5. 如何使用

### 方案 A（推荐）：导入 Markdown 文件图谱 → DB

对版本不敏感，适合任何当前版本：

1. 打开网页版 / DB 版的「导入」（Import）页面；
2. 选择「**文件图谱 → DB**」（file graph / folder 导入）；
3. 选中 `recovered-graph` **文件夹本身**（它里面包含 `logseq/config.edn`，缺一不可）；
4. 填写图谱名称，等待导入完成。

### 方案 B：直接导入 SQLite

在导入页面选择「**SQLite**」，上传 `recovered-db/db.sqlite`。

> 该文件按官方 master（2026-10，schema `65.34`）生成。若你的客户端版本较旧、导入报 schema 错误，请改用方案 A。

### 经典文件版（file-based Logseq）

直接「打开文件夹图谱」选择 `recovered-graph` 即可使用（图片引用在补齐 assets 后也会正常显示）。

---

## 6. 已知差异与缺失

1. **4 张图片资源缺失**（db 里只有引用，没有图片二进制）：

   ```
   assets/english/image_1671455955487_0.png
   assets/english/image_1671456429406_0.png
   assets/english/alphabet_2000px.png
   assets/works/english-alphabet-cheat-sheet.excalidraw.png
   ```

   如果还保留着当初的文件图谱文件夹，把这 4 个文件放进 `recovered-graph/assets/` 对应目录即可恢复图片；否则对应位置会保留引用文字。

2. `english-word` 页的 `tags:: [[english]]` 在 **Markdown 中完整保留**；但官方“文件图谱 → DB”转换在该页存在自引用（`[[english-word]]`）时会漏掉这个 page-tag。这是当前官方 importer 的行为，Markdown 文件不受影响。

3. 老 DB 的“页面标签”在新 schema 中由 class/tag 表达：`#[[sucks]]`、`#[[design]]` 这类内容标签在新 DB 中转换为 class 标签（与网页版导入的默认行为一致，`--all-tags`）。

4. `grammer → english-grammer` 的层级在文件图谱中体现为目录结构；当前 importer 不会在 DB 里生成对应的页面父子关系（页面名与标题不受影响）。

---

## 7. 复现 / 工具说明

### 7.1 脚本（`tools/`）

| 文件 | 作用 |
| --- | --- |
| `decode.cjs` | 读取旧 `db.sqlite`，Transit 解码 `kvs`，遍历存储树，导出 datoms |
| `export-md.cjs` | 把 datoms 转换为 `recovered-graph/` Markdown 文件图谱 |
| `inspect.cjs` / `show.cjs` / `query.cjs` | 数据探查辅助脚本（实体、块树、属性统计等） |
| `verify-db.cjs` | 对新旧 db 做简单核对 |
| `build-emoji-map.cjs` | 由 `@emoji-mart/data` 生成 emoji id → 字符映射（页面图标用） |

用法示例：

```bash
cd tools
npm install                 # 安装 transit-js / sql.js 等
node decode.cjs             # 旧库 -> ../work/datoms.json 等
node export-md.cjs          # datoms -> ../recovered-graph/
```

### 7.2 依赖与运行环境

- 解码/导出：Node.js + `transit-js`、`sql.js`（无需原生编译）
- 生成当前格式 db.sqlite：
  - 官方仓库浅克隆 `logseq-repo/`（只需 `deps/` 目录）；
  - `deps/graph-parser` 下 `pnpm install`（其 `nbb.edn` 会引用 `deps/common`、`deps/db`、`deps/outliner`）——若本机没有 pnpm，可用 `corepack enable` 或 `npm i -g pnpm` 安装；
  - 需要 Node 22（因为 `better-sqlite3` 的预编译二进制）与 babashka（`bb`，nbb 解析依赖用）。
  - 本次为不污染全局环境，使用了便携版：`tools/node22/`、`tools/bb/`。

### 7.3 一条龙复现命令（供参考）

```powershell
# 1) 解码 + 导出 Markdown
cd tools
node decode.cjs
node export-md.cjs

# 2) 用官方脚本转为当前格式 DB（PATH 中带上 node22 和 bb）
$env:PATH = "<本目录>\tools\node22;<本目录>\tools\bb;" + $env:PATH
cd ..\logseq-repo\deps\graph-parser
pnpm exec nbb-logseq script/db_import.cljs "<本目录>\recovered-graph" "<本目录>\recovered-db\db.sqlite" --validate --all-tags
```

### 7.4 给遇到同类问题的朋友

- 2024 年内测阶段的 `db.sqlite`（`kvs` 表 + Transit）都可以按本文方法恢复；核心是：**Transit 解码 → 遍历 `:eavt` 树 → 得到全部 datoms → 再映射为需要的格式**。
- 解码时务必利用 `:eavt-metadata{:count}` 自检 datom 数量，并合并 `addr=1` 的 tail。
- 导出为文件图谱时注意：空页面要补 `title::`、日记文件名用 `YYYY_MM_DD` 且配置 `:journal/page-title-format`，否则官方 importer 会丢页面或解析错引用。

---

## 8. 目录清单与可清理项

```
recover-logseq-db/
├─ db.sqlite              # 原始旧库（未改动，建议保留）
├─ README.md              # 本文
├─ recovered-graph/       # ① Markdown 文件图谱（可导入/可打开）
├─ recovered-graph.zip    # ① 的 zip 备份
├─ recovered-db/
│  ├─ db.sqlite           # ② 当前格式 DB（schema 65.34，Schema 导入用）
│  ├─ datoms.edn          # ② 的全部 datoms 导出（EDN）
│  └─ import-log.txt      # 生成 ② 时的官方导入日志
├─ work/                  # 恢复中间产物与日志
│  ├─ datoms.json         # 从旧库解出的 10968 条原始 datom（建议保留）
│  ├─ tail.json / root.json / entities.json
│  └─ *.txt               # 解码/导出/校验日志
├─ tools/                 # 本次使用的脚本与依赖
│  ├─ decode.cjs / export-md.cjs / … 
│  ├─ node22/             # 便携 Node 22（运行官方脚本用，可删）
│  └─ bb/                 # 便携 babashka（nbb 解析依赖用，可删）
└─ logseq-repo/           # 官方仓库浅克隆（仅用于生成 ②，约 870 MB，可删）
```

> 确认不再需要后，`logseq-repo/`、`tools/node22/`、`tools/bb/`、`tools/node_modules/` 都可以安全删除；
> 请保留 `db.sqlite`、`recovered-graph/`、`recovered-db/`，如果要复现则保留 `work/datoms.json`。

---

## English summary

A 2024 Logseq DB alpha export (`db.sqlite`, schema v42) that no longer imports into current Logseq. The file stores DataScript data as Transit-encoded transaction nodes in a single `kvs` table. We decoded it (10,968 datoms, count-checked), rebuilt the page/block tree, exported a standard Markdown file graph (`recovered-graph/`), and converted it into a current-schema DB (`recovered-db/db.sqlite`, schema 65.34, validated by the official importer). Import instructions: use "File graph → DB" with the `recovered-graph` folder (recommended, version-agnostic) or import `recovered-db/db.sqlite` directly. Only 4 image assets are missing (references are kept). See the Chinese sections above for format details, recovery steps, and the tooling used.
