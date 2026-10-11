// Verifies a current-format Logseq DB (sqlite) produced by db_import.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const transit = require('transit-js');

const mapBuilder = {
  init: () => [],
  add: (acc, k, v) => { acc.push(k, v); return acc; },
  finalize: (acc) => { const m = new Map(); for (let i = 0; i < acc.length; i += 2) m.set(acc[i], acc[i + 1]); return m; },
};
const reader = transit.reader('json', { mapBuilder });
const kwName = (k) => ':' + k._name;
function conv(v) {
  if (v === null || v === undefined) return null;
  if (transit.isKeyword(v)) return kwName(v);
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Map) { const o = {}; for (const [k, val] of v) o[typeof k === 'string' ? k : (transit.isKeyword(k) ? kwName(k) : String(k))] = conv(val); return o; }
  if (Array.isArray(v)) return v.map(conv);
  if (v && typeof v.name === 'function') return kwName(v);
  return String(v);
}
function mget(m, kw) {
  if (!(m instanceof Map)) return undefined;
  for (const [k, v] of m) { if (transit.isKeyword(k) && kwName(k) === kw) return v; if (typeof k === 'string' && k === kw) return v; }
  return undefined;
}

(async () => {
  const dbPath = process.argv[2];
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  console.log('tables:', db.exec("select name from sqlite_master where type='table'")[0].values.map((r) => r[0]).join(', '));
  const rows = db.exec('select addr, content, addresses from kvs')[0].values;
  const nodes = new Map();
  for (const [addr, content, addresses] of rows) nodes.set(addr, { content: reader.read(content), addresses: addresses ? JSON.parse(addresses) : null });
  const root = nodes.get(0).content;
  const datoms = [];
  const visited = new Set();
  function walk(addr, tag) {
    if (visited.has(tag + ':' + addr)) return;
    visited.add(tag + ':' + addr);
    const node = nodes.get(addr);
    const keys = mget(node.content, ':keys');
    if (node.addresses && node.addresses.length) { for (const c of node.addresses) walk(c, tag); }
    else if (keys) for (const d of keys) datoms.push(conv(d));
  }
  walk(mget(root, ':eavt'), 'eavt');
  console.log('eavt datoms:', datoms.length, 'expected:', conv(mget(mget(root, ':eavt-metadata'), ':count')));
  const E = new Map();
  for (const [e, a, v] of datoms) { if (!E.has(e)) E.set(e, new Map()); const m = E.get(e); if (!m.has(a)) m.set(a, []); m.get(a).push(v); }
  const g = (e, a) => { const m = E.get(e); return m ? (m.get(a) || []) : []; };
  const g1 = (e, a) => g(e, a)[0];
  const pages = [...E.keys()].filter((e) => ['page', 'journal'].includes(g1(e, ':block/type')));
  console.log('pages+journals:', pages.length);
  const journals = pages.filter((e) => g1(e, ':block/journal-day'));
  console.log('journals:', journals.map((e) => `${g1(e, ':block/title')}(${g1(e, ':block/journal-day')})`).join(', '));
  const named = ['Contents', 'english', 'chinese', 'japanese', 'english-word', 'Tags', 'chatGPT', 'grammer', 'english-grammer', 'lang'];
  for (const n of named) {
    const p = pages.find((e) => g1(e, ':block/name') === n.toLowerCase() || g1(e, ':block/title') === n);
    console.log(`page ${n}:`, p === undefined ? 'MISSING' : `eid=${p} title=${JSON.stringify(g1(p, ':block/title'))} name=${JSON.stringify(g1(p, ':block/name'))} tags=${JSON.stringify(g(p, ':block/tags'))} alias=${JSON.stringify(g(p, ':block/alias').map((x) => g1(x, ':block/title')))}`);
  }
  const blocks = [...E.keys()].filter((e) => g1(e, ':block/page') !== undefined && g1(e, ':block/title') !== undefined && !['page', 'journal'].includes(g1(e, ':block/type')));
  console.log('blocks (incl property values):', blocks.length);
  // print titles of known blocks
  const findTitle = (sub) => blocks.filter((e) => typeof g1(e, ':block/title') === 'string' && g1(e, ':block/title').includes(sub)).slice(0, 3)
    .map((e) => `[${e}] ${JSON.stringify(String(g1(e, ':block/title')).slice(0, 70))} page=${JSON.stringify(g1(g1(e, ':block/page') === undefined ? -1 : g1(e, ':block/page'), ':block/title'))}`);
  for (const s of ['et al.', '语法测试', '從零開始學日文', 'xitu/gold-miner', 'Collections', 'lang/Chinese']) {
    console.log(`blocks containing ${JSON.stringify(s)}:`, findTitle(s).join(' | ') || 'NONE');
  }
  // tasks
  const taskBlocks = [...E.keys()].filter((e) => g(e, ':logseq.task/status').length);
  console.log('task blocks:', taskBlocks.length);
  for (const t of taskBlocks) console.log(' task', JSON.stringify(String(g1(t, ':block/title')).slice(0, 60)), 'status=', JSON.stringify(g(g1(t, ':logseq.task/status'), ':block/title')), 'deadline=', JSON.stringify(g(t, ':logseq.task/deadline').map((d) => g1(d, ':block/title') || g1(d, ':block/journal-day'))));
  // user properties
  const props = [...E.keys()].filter((e) => g(e, ':block/tags').some((t) => String(g1(t, ':block/name')) === 'property'));
  console.log('property entities (user-defined):', props.length);
  for (const p of props.slice(0, 30)) console.log(' prop', JSON.stringify(g1(p, ':block/title')), g(p, ':db/ident')[0] ?? '');
  // page 87 'also' property?
  const chinesePage = pages.find((e) => g1(e, ':block/name') === 'chinese');
  if (chinesePage !== undefined) {
    const m = E.get(chinesePage);
    for (const [a, vs] of m) if (a.startsWith(':user.property/')) console.log(' chinese user prop', a, '=', vs.map((v) => (typeof v === 'number' && E.has(v) ? JSON.stringify(g1(v, ':block/title')) : JSON.stringify(v))).join(','));
  }
  const wordPage = pages.find((e) => g1(e, ':block/name') === 'english-word');
  if (wordPage !== undefined) {
    const hmm = E.get(wordPage);
    for (const [a, vs] of hmm) if (a === ':logseq.property/page-tags') console.log(' english-word page-tags:', vs.map((v) => g1(v, ':block/title')));
  }
  // page 176 source property
  const coll = blocks.find((e) => typeof g1(e, ':block/title') === 'string' && g1(e, ':block/title').includes('Collections'));
  if (coll !== undefined) {
    const m = E.get(coll);
    for (const [a, vs] of m) if (a.startsWith(':user.property/')) console.log(' Collections user prop', a, '=', vs.map((v) => typeof v === 'number' && E.has(v) ? JSON.stringify((g1(v, ':block/title') !== undefined ? g1(v, ':block/title') : g1(v, ':logseq.property/value'))) : JSON.stringify(v)).join(','));
    console.log(' Collections children:', g(coll, ':block/_parent').length, 'props:', [...m.keys()].join(','));
  }
})().catch((e) => { console.error(e); process.exit(1); });
