// Ad-hoc entity/block inspector. Usage examples:
//   node show.cjs e 174 225 265
//   node show.cjs uuid 671c960d-dcd2-4429-b7a9-e30b304c787e
//   node show.cjs tree 165 20
//   node show.cjs refs-in-titles
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const datoms = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'datoms.json'), 'utf8'));

const E = new Map();
for (const [e, a, v] of datoms) {
  if (!E.has(e)) E.set(e, new Map());
  const em = E.get(e);
  if (!em.has(a)) em.set(a, []);
  em.get(a).push(v);
}
const get = (e, a) => { const m = E.get(e); return m ? (m.get(a) || []) : []; };
const get1 = (e, a) => get(e, a)[0];
const title = (e) => get1(e, ':block/title');
const name = (e) => get1(e, ':block/name');
const ident = (e) => get1(e, ':db/ident');
const label = (e) => {
  if (typeof e !== 'number') return JSON.stringify(e);
  return `${e}${title(e) !== undefined ? `(t=${JSON.stringify(String(title(e)).slice(0, 70))})` : ''}${name(e) !== undefined ? `(n=${JSON.stringify(name(e))})` : ''}${ident(e) !== undefined ? `(id=${ident(e)})` : ''}`;
};
const uuidIndex = new Map();
for (const [e, m] of E) if (m.has(':block/uuid')) uuidIndex.set(String(get1(e, ':block/uuid')), e);

const cmd = process.argv[2];
const args = process.argv.slice(3).map((x) => (/^\d+$/.test(x) ? Number(x) : x));

if (cmd === 'e') {
  for (const e of args) {
    console.log(`\n=== entity ${e} ===`);
    const m = E.get(e);
    if (!m) { console.log('  (missing)'); continue; }
    for (const [a, vs] of m) {
      const shown = vs.map((v) => (Array.isArray(v) ? JSON.stringify(v) : (typeof v === 'number' && E.has(v) ? label(v) : JSON.stringify(v))));
      console.log(`  ${a} = ${shown.join(' | ')}`);
    }
  }
} else if (cmd === 'uuid') {
  for (const u of args) console.log(u, '->', uuidIndex.get(u) === undefined ? 'NOT FOUND' : label(uuidIndex.get(u)));
} else if (cmd === 'tree') {
  const [pageEid, limitStr] = [args[0], args[1]];
  const limit = Number(limitStr) || 200;
  const kids = new Map(); // parent -> [ [order, eid] ]
  for (const [e, m] of E) {
    if (m.has(':block/page') && m.get(':block/page')[0] === pageEid && m.has(':block/order')) {
      const parent = m.get(':block/parent') ? m.get(':block/parent')[0] : pageEid;
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push([m.get(':block/order')[0], e]);
    }
  }
  for (const [, arr] of kids) arr.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  let n = 0;
  function walk(parent, depth) {
    for (const [, e] of kids.get(parent) || []) {
      if (n++ >= limit) return;
      const xprops = [];
      for (const [a, vs] of E.get(e) || []) {
        if (a.startsWith(':user.property/') || [':logseq.task/status', ':block/tags', ':block/collapsed?', ':logseq.property/heading'].includes(a)) {
          const val = vs.map((v) => (Array.isArray(v) ? JSON.stringify(v) : (typeof v === 'number' && E.has(v) ? label(v) : JSON.stringify(v)))).join(', ');
          xprops.push(`${a}=${val}`);
        }
      }
      console.log(`${'  '.repeat(depth)}- [#${e}] ${JSON.stringify(title(e))}${xprops.length ? '  <<' + xprops.join(' | ') + '>>' : ''}`);
      walk(e, depth + 1);
    }
  }
  walk(pageEid, 0);
} else if (cmd === 'refs-in-titles') {
  // find titles containing ~^ and report referenced uuid
  const seen = new Map();
  const re = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
  for (const [e, m] of E) {
    if (!m.has(':block/title')) continue;
    const t = String(get1(e, ':block/title'));
    if (!t.includes('~^')) continue;
    let mm;
    while ((mm = re.exec(t))) {
      const u = mm[1];
      if (!seen.has(u)) seen.set(u, []);
      seen.get(u).push(e);
    }
  }
  console.log('~^ refs count:', seen.size);
  for (const [u, es] of seen) console.log(u, '->', uuidIndex.get(u) === undefined ? 'NOT FOUND' : label(uuidIndex.get(u)), 'used by eids:', es.slice(0, 5).join(','), 'x' + es.length);
} else {
  console.log('unknown cmd');
}
