// Exports the decoded 2024 Logseq DB graph into a standard Logseq file graph (markdown).
// Usage: node export-md.cjs <outDir>
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'datoms.json'), 'utf8'));
const tailBatches = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'tail.json'), 'utf8'));

const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'recovered-graph'));
const warnings = [];

// ---------- build entity map ----------
const E = new Map(); // eid -> Map(attr -> [values])
for (const [e, a, v, tx] of data) {
  if (!E.has(e)) E.set(e, new Map());
  const m = E.get(e);
  if (!m.has(a)) m.set(a, []);
  m.get(a).push(v);
}
// apply tail additions (last few transactions not in the tree)
for (const batch of tailBatches) {
  for (const [e, a, v, tx] of batch) {
    if (!E.has(e)) E.set(e, new Map());
    const m = E.get(e);
    if (!m.has(a)) m.set(a, []);
    if (!m.get(a).includes(v)) m.get(a).push(v);
  }
}

const get = (e, a) => { const m = E.get(e); return m ? (m.get(a) || []) : []; };
const get1 = (e, a) => get(e, a)[0];
const title = (e) => get1(e, ':block/title');
const typeOf = (e) => get1(e, ':block/type');
const uuidOf = (e) => get1(e, ':block/uuid');
const isPage = (e) => ['page', 'journal'].includes(typeOf(e));
const isPropertyValueBlock = (e) => get1(e, ':logseq.property/created-from-property') !== undefined;

const uuidIndex = new Map();
for (const [e, m] of E) if (m.has(':block/uuid')) uuidIndex.set(String(get1(e, ':block/uuid')), e);

// value blocks: owner -> propEntityEid -> value block eid
const valueBlocks = new Map(); // owner -> Map(prop -> block)
for (const [e, m] of E) {
  const prop = get1(e, ':logseq.property/created-from-property');
  if (prop === undefined) continue;
  const owner = get1(e, ':block/parent');
  if (typeof owner !== 'number') continue;
  if (!valueBlocks.has(owner)) valueBlocks.set(owner, new Map());
  const mm = valueBlocks.get(owner);
  if (!mm.has(prop)) mm.set(prop, e); // first wins (should be unique)
}

// children index: parent -> [eid] (regular blocks only)
const children = new Map();
for (const [e, m] of E) {
  if (!m.has(':block/parent')) continue;
  if (isPropertyValueBlock(e)) continue;
  if (!m.has(':block/order') && !m.has(':block/title')) continue;
  const p = get1(e, ':block/parent');
  if (typeof p !== 'number') continue;
  if (!children.has(p)) children.set(p, []);
  children.get(p).push(e);
}
const orderOf = (e) => String(get1(e, ':block/order') ?? '');
const byOrder = (a, b) => (orderOf(a) < orderOf(b) ? -1 : orderOf(a) > orderOf(b) ? 1 : a - b);
for (const [, arr] of children) arr.sort(byOrder);

// ---------- property helpers ----------
const propName = (pe) => {
  const t = title(pe);
  if (typeof t === 'string' && t.length) return t;
  const id = get1(pe, ':db/ident');
  if (typeof id === 'string' && id.startsWith(':user.property/')) {
    const local = id.slice(':user.property/'.length);
    // prefix is a 21 char random string followed by '-'
    if (local.length > 22 && local[21] === '-') return local.slice(22);
    const dash = local.indexOf('-');
    return dash >= 0 ? local.slice(dash + 1) : local;
  }
  if (typeof id === 'string' && id.startsWith(':logseq.property/')) return id.slice(':logseq.property/'.length);
  if (typeof id === 'string' && id.startsWith(':logseq.task/')) return 'logseq.task/' + id.slice(':logseq.task/'.length);
  return id;
};

const propEntityByAttr = new Map(); // attr kw -> property entity eid
for (const [e, m] of E) {
  const id = get1(e, ':db/ident');
  if (typeof id === 'string') propEntityByAttr.set(id, e);
}

const statusMarker = new Map([
  [':logseq.task/status.todo', 'TODO'],
  [':logseq.task/status.doing', 'DOING'],
  [':logseq.task/status.done', 'DONE'],
  [':logseq.task/status.canceled', 'CANCELED'],
  [':logseq.task/status.backlog', 'BACKLOG'],
  [':logseq.task/status.in-review', 'IN-REVIEW'],
]);

const pad = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function journalDayToDecorated(day) {
  const s = String(day).replace(/\D/g, '');
  const y = Number(s.slice(0, 4)), mo = Number(s.slice(4, 6)), d = Number(s.slice(6, 8));
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return { iso: `${y}-${pad(mo)}-${pad(d)}`, wd: WEEKDAYS[dt.getUTCDay()], title: s };
}
const journalTitle = (e) => {
  const t = title(e);
  return typeof t === 'string' && t.length ? t : String(get1(e, ':block/journal-day'));
};

// resolve a property value (datom value) to a rendered string + meta
function resolveValue(v, seen) {
  // returns {text, isPage, linked}
  if (typeof v === 'number' && E.has(v)) return renderEntityValue(v);
  if (Array.isArray(v)) {
    if (v[0] === ':block/uuid' && typeof v[1] === 'string') {
      const e = uuidIndex.get(v[1]);
      if (e === undefined) { warnings.push(`unresolved uuid ${v[1]}`); return { text: JSON.stringify(v) }; }
      return renderEntityValue(e);
    }
    if (v.length === 1 && Array.isArray(v[0]) && v[0][0] === ':block/uuid') {
      return resolveValue(v[0], seen);
    }
    warnings.push(`unexpected composite value ${JSON.stringify(v)}`);
    return { text: JSON.stringify(v) };
  }
  if (typeof v === 'boolean') return { text: String(v) };
  if (v === null || v === undefined) return { text: '' };
  return { text: String(v) };
}
function renderEntityValue(e) {
  if (isPage(e)) {
    return { text: `[[${journalTitle(e)}]]`, isPage: true, entity: e };
  }
  // block / value block -> its text
  const t = entityText(e);
  return { text: t, isPage: false, entity: e };
}
function entityText(e) {
  let t = title(e);
  if (typeof t !== 'string' || t.length === 0) {
    const c = get1(e, ':property.value/content');
    if (typeof c === 'string') return resolveInlineRefs(c);
    return typeof t === 'string' ? t : '';
  }
  return resolveInlineRefs(t);
}

// ---------- inline refs (~^uuid) ----------
const REF_RE = /~[\\]?\^([0-9a-fA-F-]{36})/g;
function resolveInlineRefs(s) {
  if (typeof s !== 'string' || !s.includes('~')) return s;
  return s.replace(REF_RE, (m, uuid) => {
    const e = uuidIndex.get(uuid.toLowerCase()) ?? uuidIndex.get(uuid);
    if (e === undefined) { warnings.push(`unresolved ~^ ref ${uuid}`); return m; }
    if (isPage(e)) return journalTitle(e);
    // block ref: keep uuid form with (( ))
    return `(( ${uuid} ))`;
  });
}

// ---------- property collection for an entity ----------
const SKIP_ATTRS = new Set([
  ':block/page', ':block/parent', ':block/order', ':block/refs', ':block/path-refs',
  ':block/created-at', ':block/updated-at', ':block/format', ':block/uuid', ':block/name',
  ':block/type', ':block/tx-id', ':block/journal-day', ':block/link', ':block/schema', ':block/title',
  ':block/closed-value-property', ':block/alias', ':block/tags',
  ':logseq.property/created-from-property', ':logseq.property/built-in?',
  ':logseq.property.class/properties', ':logseq.property.class/hide-from-node',
  ':logseq.property/heading', ':logseq.task/status', ':logseq.task/deadline',
  ':logseq.task/priority', ':logseq.property/icon', ':logseq.property/public',
  ':logseq.property/exclude-from-graph-view', ':logseq.property/parent',
  ':logseq.property/page-tags', ':logseq.property/view/type', ':logseq.property/view-for',
  ':logseq.property/description', ':logseq.property/query', ':logseq.property.class/extends',
  ':property/schema.classes', ':db/ident', ':db/cardinality', ':db/index', ':db/valueType',
  ':db/unique', ':logseq.property/table/sorting', ':logseq.property/table/filters',
  ':logseq.property/table/hidden-columns', ':logseq.property/table/ordered-columns',
  ':logseq.property/table/sized-columns', ':logseq.property/table/view-for',
  ':logseq.property.asset/type', ':logseq.property.asset/size', ':logseq.property.asset/checksum',
  ':logseq.property.asset/last-visit-page', ':logseq.property.asset/remote-metadata',
  ':logseq.property.asset/resize-metadata', ':logseq.property.fsrs/due', ':logseq.property.fsrs/state',
  ':logseq.property.pdf/hl-type', ':logseq.property.pdf/hl-color', ':logseq.property.pdf/hl-page',
  ':logseq.property.pdf/hl-image', ':logseq.property.pdf/hl-value',
  ':logseq.property.linked-references/includes', ':logseq.property.linked-references/excludes',
  ':logseq.property.journal/title-format', ':kv/value', ':file/path', ':file/content',
  ':file/created-at', ':file/last-modified-at', ':property.value/content',
]);

function collectProperties(e) {
  const props = []; // {name, valueText, order, propEid}
  const vb = valueBlocks.get(e) || new Map();
  // map prop entity -> order from its value block
  const orderByProp = new Map();
  for (const [prop, blockEid] of vb) orderByProp.set(prop, orderOf(blockEid));

  for (const [attr, vals] of E.get(e) || []) {
    if (SKIP_ATTRS.has(attr)) continue;
    if (attr === ':block/collapsed?') {
      if (vals[0]) props.push({ name: 'collapsed', valueText: 'true', order: 'zzzz' });
      continue;
    }
    if (attr.startsWith(':user.property/') || attr === ':logseq.property/background-color' || attr === ':logseq.property/order-list-type') {
      const propEid = propEntityByAttr.get(attr);
      let name = propEid !== undefined ? propName(propEid) : attr.replace(/^:user\.property\/[^-]*-/, '');
      for (const v of vals) {
        const r = resolveValue(v);
        props.push({ name, valueText: r.text, order: orderByProp.get(propEid) ?? 'zzz', propEid });
      }
      continue;
    }
    // any other attribute we didn't anticipate - keep as property for safety
    if (attr.startsWith(':logseq.') || attr.startsWith(':')) {
      if (!attr.includes('/')) continue;
      if (attr.startsWith(':user.property/')) continue;
      warnings.push(`unhandled attr ${attr} on eid ${e}`);
    }
  }
  props.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : String(a.name).localeCompare(String(b.name))));
  return props;
}

// ---------- block rendering ----------
const propsLine = (p) => `${p.name}:: ${p.valueText}`;

function renderBlock(e, depth) {
  const lines = [];
  let content = typeof title(e) === 'string' ? resolveInlineRefs(title(e)) : '';
  // task status
  let marker = '';
  const statusRef = get1(e, ':logseq.task/status');
  if (statusRef !== undefined) {
    const statusIdent = get1(statusRef, ':db/ident');
    const stTitle = String(title(statusRef) ?? '');
    marker = statusMarker.get(statusIdent) || statusIdent?.split('.').pop()?.toUpperCase() || stTitle.toUpperCase();
  }
  // deadline
  const deadline = get1(e, ':logseq.task/deadline');
  if (deadline !== undefined) {
    const day = get1(deadline, ':block/journal-day');
    if (day) {
      const d = journalDayToDecorated(day);
      content = `${content}${content ? ' ' : ''}DEADLINE: <${d.iso} ${d.wd}>`;
    }
  }
  const props = collectProperties(e);
  const contentLines = content.split('\n');
  const indent = '  '.repeat(depth);
  const contIndent = indent + '  ';

  let first = `${indent}- ${marker ? marker + ' ' : ''}${contentLines[0]}`;
  if (!contentLines[0] && props.length > 0) {
    // put first property on bullet line
    first = `${indent}- ${marker ? marker + ' ' : ''}${propsLine(props.shift())}`;
  }
  lines.push(first);
  for (const l of contentLines.slice(1)) lines.push(contIndent + l);
  for (const p of props) lines.push(contIndent + propsLine(p));
  for (const c of children.get(e) || []) lines.push(...renderBlock(c, depth + 1));
  return lines;
}

// ---------- page rendering ----------
function sanitizeFileName(s) {
  return String(s)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '');
}

function pagePropertyLines(e) {
  const lines = [];
  // alias
  const aliases = get(e, ':block/alias').map((a) => journalTitle(a));
  if (aliases.length) lines.push(`alias:: ${aliases.join(', ')}`);
  // icon (emoji only)
  const icon = get1(e, ':logseq.property/icon');
  if (icon && typeof icon === 'object') {
    if (icon[':type'] === ':emoji' && typeof icon[':id'] === 'string') {
      const emoji = EMOJI_MAP[icon[':id']];
      if (emoji) lines.push(`icon:: ${emoji}`);
      else warnings.push(`unknown emoji id ${icon[':id']} on page ${e}`);
    }
  }
  if (get1(e, ':logseq.property/public') !== undefined) lines.push(`public:: ${get1(e, ':logseq.property/public')}`);
  if (get1(e, ':logseq.property/exclude-from-graph-view') !== undefined) lines.push(`exclude-from-graph-view:: ${get1(e, ':logseq.property/exclude-from-graph-view')}`);
  // page tags (old "Page Tags" property)
  for (const t of get(e, ':logseq.property/page-tags')) {
    lines.push(`tags:: [[${journalTitle(t)}]]`);
  }
  // user + misc properties (skip the ones already handled)
  for (const p of collectProperties(e)) lines.push(propsLine(p));
  return lines;
}

// ---------- main ----------
const EMOJI_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'emoji-map.json'), 'utf8'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'pages'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'journals'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'logseq'), { recursive: true });

// config.edn from the recovered file entity (81) with journal title format ensured
let config = String(get1(81, ':file/content') ?? '{}');
config = config.replace(/^[ \t]*:journal\/file-name-format.*\r?\n?/m, '');
if (!config.includes(':journal/page-title-format')) {
  if (/^\{?:meta\/version 1/m.test(config)) {
    config = config.replace(/^(\{?:meta\/version 1.*)$/m, '$1\n\n :journal/page-title-format "yyyyMMdd"');
  } else {
    config = config.replace(/^(\{)/, '$1\n :journal/page-title-format "yyyyMMdd"\n');
  }
}
fs.writeFileSync(path.join(OUT, 'logseq', 'config.edn'), config);
const customCss = get1(82, ':file/content'), customJs = get1(83, ':file/content');
if (customCss) fs.writeFileSync(path.join(OUT, 'logseq', 'custom.css'), customCss);
if (customJs) fs.writeFileSync(path.join(OUT, 'logseq', 'custom.js'), customJs);

// pages to export
const pages = [];
for (const [e, m] of E) {
  const t = typeOf(e);
  if (t !== 'page' && t !== 'journal') continue;
  const name = String(get1(e, ':block/name') ?? '');
  if (name.startsWith('$$$')) { warnings.push(`skip internal page ${name}`); continue; }
  pages.push(e);
}
// skip alias-only stub pages (targets of some :block/alias, with no blocks and no props)
const aliasTargets = new Set();
for (const [e, m] of E) for (const a of get(e, ':block/alias')) aliasTargets.add(a);
const skipPages = new Set();
for (const e of pages) {
  if (aliasTargets.has(e) && (children.get(e) || []).length === 0 && collectProperties(e).length === 0) {
    skipPages.add(e);
    warnings.push(`skip alias stub page ${get1(e, ':block/title')}`);
  }
}
// alias stubs skipped above; also skip pages whose title duplicates another page in same namespace dir? (none expected)

const stats = { pages: 0, journals: 0, blocks: 0 };
for (const e of pages) {
  if (skipPages.has(e)) continue;
  const isJournal = typeOf(e) === 'journal';
  let relPath;
  if (isJournal) {
    const day = String(get1(e, ':block/journal-day'));
    relPath = path.join('journals', `${day.slice(0, 4)}_${day.slice(4, 6)}_${day.slice(6, 8)}.md`);
    stats.journals++;
  } else {
    // namespace: page whose :logseq.property/parent is another page goes into that page's dir
    let dir = 'pages';
    const parent = get1(e, ':logseq.property/parent');
    if (typeof parent === 'number' && E.has(parent) && isPage(parent) && !isJournal) {
      const parentTitle = sanitizeFileName(journalTitle(parent));
      if (parent !== e) dir = path.join('pages', parentTitle);
    }
    relPath = path.join(dir, sanitizeFileName(journalTitle(e)) + '.md');
    stats.pages++;
  }
  const fileLines = [];
  const pp = pagePropertyLines(e);
  if (pp.length) { fileLines.push(...pp, ''); }
  for (const b of children.get(e) || []) {
    fileLines.push(...renderBlock(b, 0));
    stats.blocks++;
  }
  if (fileLines.length === 0) {
    // an empty file would not be imported as a page; a title property ensures the page is created
    fileLines.push(`title:: ${journalTitle(e)}`);
  }
  fs.mkdirSync(path.dirname(path.join(OUT, relPath)), { recursive: true });
  fs.writeFileSync(path.join(OUT, relPath), fileLines.join('\n') + (fileLines.length ? '\n' : ''));
}

// count all blocks rendered (including nested)
function countAll(e) { let n = 1; for (const c of children.get(e) || []) n += countAll(c); return n; }
let total = 0; for (const e of pages) if (!skipPages.has(e)) for (const c of children.get(e) || []) total += countAll(c);
total += 0;

console.log('exported to', OUT);
console.log('pages:', stats.pages, 'journals:', stats.journals, 'top-level blocks:', stats.blocks, 'all blocks:', total);
console.log('warnings:', warnings.length);
const uniq = [...new Set(warnings)];
for (const w of uniq.slice(0, 40)) console.log(' -', w);
if (uniq.length > 40) console.log(` ... and ${uniq.length - 40} more`);
