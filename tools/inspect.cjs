// Inspect decoded datoms to understand the graph content.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const datoms = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'datoms.json'), 'utf8'));

// e -> a -> [values]
const E = new Map();
for (const [e, a, v, tx] of datoms) {
  if (!E.has(e)) E.set(e, new Map());
  const em = E.get(e);
  if (!em.has(a)) em.set(a, []);
  em.get(a).push(v);
}
const get = (e, a) => { const m = E.get(e); return m ? (m.get(a) || []) : []; };
const get1 = (e, a) => get(e, a)[0];

function typeOf(e) { return get1(e, ':block/type'); }
function titleOf(e) { return get1(e, ':block/title'); }
function nameOf(e) { return get1(e, ':block/name'); }

console.log('=== entity overview by type ===');
const byType = new Map();
for (const e of E.keys()) {
  const t = typeOf(e) || '(none)';
  if (!byType.has(t)) byType.set(t, []);
  byType.get(t).push(e);
}
for (const [t, es] of byType) console.log(t, es.length, 'eids', es.slice(0, 10).join(','));

console.log('\n=== pages ===');
for (const e of (byType.get('page') || []).concat(byType.get('journal') || [], byType.get('hidden') || [])) {
  const parts = [];
  parts.push(`eid=${e}`);
  if (nameOf(e)) parts.push(`name=${JSON.stringify(nameOf(e))}`);
  if (titleOf(e)) parts.push(`title=${JSON.stringify(titleOf(e))}`);
  if (get1(e, ':block/journal-day')) parts.push(`journal=${get1(e, ':block/journal-day')}`);
  if (get(e, ':block/tags').length) parts.push(`tags=${JSON.stringify(get(e, ':block/tags'))}`);
  const userProps = [];
  for (const [a, vs] of E.get(e)) if (a.startsWith(':user.property/')) userProps.push(`${a}=${JSON.stringify(vs)}`);
  if (userProps.length) parts.push(`userProps=${userProps.join(' | ')}`);
  if (get1(e, ':logseq.property/icon')) parts.push(`icon=${JSON.stringify(get1(e, ':logseq.property/icon'))}`);
  if (get(e, ':block/alias').length) parts.push(`alias=${JSON.stringify(get(e, ':block/alias').map((x) => titleOf(x) || nameOf(x) || x))}`);
  const builtin = [];
  for (const [a, vs] of E.get(e)) if (a.startsWith(':logseq.property/') && ![':logseq.property/created-from-property', ':logseq.property/built-in?'].includes(a)) builtin.push(`${a}=${JSON.stringify(vs)}`);
  if (builtin.length) parts.push(`props=${builtin.join(' | ')}`);
  console.log(parts.join('  '));
}

console.log('\n=== classes (type class) ===');
for (const e of byType.get('class') || []) {
  const props = get(e, ':logseq.property.class/properties').map((p) => titleOf(p) || nameOf(p) || get1(p, ':db/ident'));
  console.log(`eid=${e} name=${JSON.stringify(nameOf(e))} title=${JSON.stringify(titleOf(e))} builtin=${get1(e, ':logseq.property/built-in?')} classProps=${JSON.stringify(props)}`);
}

console.log('\n=== user properties (type property, not built-in) ===');
for (const e of byType.get('property') || []) {
  if (get1(e, ':logseq.property/built-in?')) continue;
  console.log(`eid=${e} ident=${get1(e, ':db/ident')} name=${JSON.stringify(nameOf(e))} title=${JSON.stringify(titleOf(e))} schema=${JSON.stringify(get1(e, ':block/schema'))}`);
}

console.log('\n=== closed values ===');
for (const e of byType.get('closed value') || []) {
  const prop = get1(e, ':block/closed-value-property');
  console.log(`eid=${e} title=${JSON.stringify(titleOf(e))} property=${prop} (${get1(prop, ':db/ident')}) icon=${JSON.stringify(get1(e, ':logseq.property/icon'))}`);
}

console.log('\n=== file entities ===');
for (const [e, m] of E) {
  if (m.has(':file/path')) {
    const parts = ['eid=' + e];
    for (const [a, vs] of m) parts.push(`${a}=${JSON.stringify(vs).slice(0, 200)}`);
    console.log(parts.join('  '));
  }
}

console.log('\n=== user.property datoms (all) ===');
for (const [e, m] of E) {
  for (const [a, vs] of m) {
    if (a.startsWith(':user.property/')) {
      const propEnt = [...E.keys()].find((p) => get1(p, ':db/ident') === a);
      console.log(`eid=${e} (${typeOf(e) || 'block'}, ${JSON.stringify(titleOf(e) || nameOf(e) || '').slice(0, 60)})  ${a} = ${JSON.stringify(vs)}`);
    }
  }
}

console.log('\n=== block/tags targets ===');
for (const [e, m] of E) {
  if (m.has(':block/tags')) {
    console.log(`eid=${e} type=${typeOf(e)} title=${JSON.stringify(titleOf(e) || nameOf(e) || '').slice(0, 60)} tags=${JSON.stringify(m.get(':block/tags').map((t) => ({ eid: t, title: titleOf(t) || nameOf(t), type: typeOf(t) })))}`);
  }
}

console.log('\n=== task statuses ===');
for (const [e, m] of E) {
  if (m.has(':logseq.task/status')) {
    console.log(`eid=${e} title=${JSON.stringify(titleOf(e) || '').slice(0, 80)} status=${JSON.stringify(m.get(':logseq.task/status').map((s) => titleOf(s)))}`);
  }
}

console.log('\n=== sample blocks ===');
let n = 0;
for (const [e, m] of E) {
  if (!m.has(':block/page') || !m.has(':block/title')) continue;
  if (n++ >= 15) break;
  const parts = [`eid=${e}`, `page=${m.get(':block/page')}`, `parent=${m.get(':block/parent')}`, `order=${m.get(':block/order')}`];
  parts.push(`title=${JSON.stringify(m.get(':block/title'))}`);
  if (m.has(':block/refs')) parts.push(`refs=${JSON.stringify(m.get(':block/refs').map((r) => `${r}:${(titleOf(r) || nameOf(r) || '').slice(0, 30)}`))}`);
  if (m.has(':block/collapsed?')) parts.push('collapsed');
  console.log(parts.join('  '));
}

console.log('\n=== pages with block counts ===');
const countByPage = new Map();
for (const [e, m] of E) {
  if (m.has(':block/page') && m.has(':block/title')) {
    const p = m.get(':block/page')[0];
    countByPage.set(p, (countByPage.get(p) || 0) + 1);
  }
}
for (const e of (byType.get('page') || []).concat(byType.get('journal') || [], byType.get('hidden') || [])) {
  console.log(`eid=${e} title=${JSON.stringify(titleOf(e) || nameOf(e))} blocks=${countByPage.get(e) || 0}`);
}
