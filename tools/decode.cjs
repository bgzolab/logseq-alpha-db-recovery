// Decodes a Logseq DB (2024, DataScript-over-SQLite storage) into a plain datom dump.
// Usage: node decode.cjs
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const transit = require('transit-js');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'db.sqlite');
const OUT_DIR = path.join(ROOT, 'work');

// ---- transit decoding ----
const mapBuilder = {
  init: () => [],
  add: (acc, k, v) => { acc.push(k, v); return acc; },
  finalize: (acc) => { const m = new Map(); for (let i = 0; i < acc.length; i += 2) m.set(acc[i], acc[i + 1]); return m; },
};
const reader = transit.reader('json', { mapBuilder });

function kwName(k) {
  // transit Keyword -> ":ns/name"
  return ':' + k._name;
}

// convert decoded transit value to JSON-friendly JS
function conv(v) {
  if (v === null || v === undefined) return null;
  if (transit.isKeyword(v)) return kwName(v);
  if (transit.isSymbol(v)) return String(v);
  if (transit.isUUID ? transit.isUUID(v) : (v && v.constructor && v.constructor.name === 'UUID')) return String(v);
  if (typeof v === 'bigint') return v <= Number.MAX_SAFE_INTEGER ? Number(v) : String(v);
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Map) {
    const o = {};
    for (const [k, val] of v) {
      const key = typeof k === 'string' ? k : (transit.isKeyword(k) ? kwName(k) : String(k));
      o[key] = conv(val);
    }
    return o;
  }
  if (Array.isArray(v)) return v.map(conv);
  if (transit.isSet && transit.isSet(v)) return v.rep ? v.rep.map(conv) : Array.from(v).map(conv);
  // keyword-like object
  if (v && typeof v.name === 'function') return kwName(v);
  return String(v);
}

// get from a decoded Map using either keyword object or string name
function mget(m, kw) {
  if (!(m instanceof Map)) return undefined;
  for (const [k, v] of m) {
    if (transit.isKeyword(k) && kwName(k) === kw) return v;
    if (typeof k === 'string' && k === kw) return v;
  }
  return undefined;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));
  const res = db.exec('select addr, content, addresses from kvs order by addr');
  const rows = new Map();
  for (const r of res[0].values) {
    const [addr, content, addresses] = r;
    rows.set(addr, {
      addr,
      content: reader.read(content),
      addresses: addresses ? JSON.parse(addresses) : null,
    });
  }
  console.log('rows:', rows.size);

  const root = rows.get(0).content;
  const rootDump = {};
  for (const [k, v] of root) {
    const key = transit.isKeyword(k) ? kwName(k) : String(k);
    if (key === ':schema' || key === ':eavt' || key === ':aevt' || key === ':avet' ||
        key === ':eavt-metadata' || key === ':aevt-metadata' || key === ':avet-metadata' ||
        key === ':max-eid' || key === ':max-tx' || key === ':max-addr' || key === ':branching-factor' || key === ':ref-type') {
      rootDump[key] = conv(v);
    }
  }
  console.log('root meta:', JSON.stringify(rootDump, null, 1).slice(0, 4000));

  // walk a tree, collecting leaf datoms
  const visited = new Set();
  function walk(addr, index, out) {
    if (visited.has(index + ':' + addr)) return;
    visited.add(index + ':' + addr);
    const node = rows.get(addr);
    if (!node) { console.log('MISSING NODE', index, addr); return; }
    const keys = mget(node.content, ':keys');
    if (node.addresses && node.addresses.length) {
      for (const child of node.addresses) walk(child, index, out);
    } else {
      if (keys) for (const d of keys) out.push(d);
    }
  }

  const eavt = [];
  walk(mget(root, ':eavt'), 'eavt', eavt);
  const aevtCount = [];
  walk(mget(root, ':aevt'), 'aevt', aevtCount);
  const avetCount = [];
  walk(mget(root, ':avet'), 'avet', avetCount);
  const eavtMeta = mget(root, ':eavt-metadata');
  console.log('eavt leaf datoms:', eavt.length, 'expected:', eavtMeta ? conv(mget(eavtMeta, ':count')) : '?');
  console.log('aevt leaf datoms:', aevtCount.length, 'avet leaf datoms:', avetCount.length);

  // tail
  const tail = rows.get(1).content;
  const tailBatches = tail.map((batch) => batch.map(conv));
  console.log('tail batches:', tailBatches.length, 'datoms per batch:', tailBatches.map((b) => b.length).join(','));
  console.log('tail sample:', JSON.stringify(tailBatches).slice(0, 1000));

  // normalize datoms
  const datoms = eavt.map(conv); // [e, a, v, tx]
  // sanity: all 4-arrays
  let bad = 0;
  for (const d of datoms) if (!Array.isArray(d) || d.length !== 4) bad++;
  console.log('malformed datoms:', bad);

  // for reports
  const attrCounts = new Map();
  for (const d of datoms) attrCounts.set(d[1], (attrCounts.get(d[1]) || 0) + 1);
  const sortedAttrs = [...attrCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('distinct attrs:', sortedAttrs.length);
  console.log(sortedAttrs.map(([a, c]) => `${a} ${c}`).join('\n'));

  const typeVals = new Map();
  for (const d of datoms) if (d[1] === ':block/type') typeVals.set(d[2], (typeVals.get(d[2]) || 0) + 1);
  console.log('block/type values:', JSON.stringify([...typeVals.entries()]));

  // entities
  const entities = new Map();
  for (const [e, a, v] of datoms) {
    if (!entities.has(e)) entities.set(e, {});
    const ent = entities.get(e);
    if (ent[a] === undefined) ent[a] = v;
    else if (Array.isArray(ent[a])) ent[a].push(v);
    else ent[a] = [ent[a], v];
  }
  console.log('entities:', entities.size);

  fs.writeFileSync(path.join(OUT_DIR, 'datoms.json'), JSON.stringify(datoms));
  fs.writeFileSync(path.join(OUT_DIR, 'tail.json'), JSON.stringify(tailBatches));
  fs.writeFileSync(path.join(OUT_DIR, 'root.json'), JSON.stringify(rootDump, null, 1));

  // entities dump keyed by eid
  const entObj = {};
  for (const [e, ent] of entities) entObj[e] = ent;
  fs.writeFileSync(path.join(OUT_DIR, 'entities.json'), JSON.stringify(entObj));

  console.log('wrote work/datoms.json, work/tail.json, work/root.json, work/entities.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
