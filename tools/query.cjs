// Targeted queries over decoded datoms
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
const desc = (e) => `${e}:${JSON.stringify(title(e) ?? get1(e, ':db/ident') ?? '')}`;

for (const attr of [':logseq.property/heading', ':logseq.task/deadline', ':logseq.property/order-list-type', ':logseq.property/icon', ':block/link', ':logseq.property/background-color', ':logseq.property/background-image', ':logseq.property/table', ':logseq.property/query', ':logseq.property/description', ':block/alias', ':logseq.property/exclude-from-graph-view', ':logseq.property/public', ':logseq.property/created-from-property']) {
  const matching = [];
  for (const [e, m] of E) if (m.has(attr)) matching.push([e, m.get(attr)]);
  console.log(`\n### ${attr} (${matching.length} entities)`);
  for (const [e, vs] of matching.slice(0, 30)) {
    console.log(`  eid=${desc(e)}  vals=${JSON.stringify(vs).slice(0, 220)}`);
  }
}

console.log('\n### titles containing assets/');
for (const [e, m] of E) {
  const t = title(e);
  if (typeof t === 'string' && t.includes('assets/')) console.log(' ', e, JSON.stringify(t).slice(0, 160));
}

console.log('\n### titles containing ((');
for (const [e, m] of E) {
  const t = title(e);
  if (typeof t === 'string' && t.includes('((')) console.log(' ', e, JSON.stringify(t).slice(0, 160));
}

console.log('\n### journal pages');
for (const [e, m] of E) {
  if (m.has(':block/journal-day')) console.log(' ', e, JSON.stringify(m.get(':block/journal-day')), 'uuid=', get1(e, ':block/uuid'), 'title=', JSON.stringify(title(e)));
}

console.log('\n### hidden pages content');
for (const e of [85, 848]) {
  console.log(' page', e, 'blocks:');
  for (const [be, m] of E) if (get1(be, ':block/page') === e) console.log('   ', desc(be), JSON.stringify(title(be)));
}

console.log('\n### page 165 english-word direct children count & first props');
console.log('\n### max title length');
let mx = 0, mxe = 0;
for (const [e, m] of E) { const t = title(e); if (typeof t === 'string' && t.length > mx) { mx = t.length; mxe = e; } }
console.log(mx, 'at', mxe);

console.log('\n### all :block/refs with page refs to journal pages');
for (const [e, m] of E) {
  if (m.has(':block/refs')) {
    const journals = m.get(':block/refs').filter((r) => get1(r, ':block/journal-day'));
    if (journals.length) console.log(' ', desc(e), '->', journals.map(desc).join(','));
  }
}
