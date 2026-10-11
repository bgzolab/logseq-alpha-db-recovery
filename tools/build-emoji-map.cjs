const fs = require('fs');
const path = require('path');
const base = path.join(__dirname, 'node_modules/@emoji-mart/data/sets');
for (const set of ['15', '14', '13.1']) {
  for (const file of ['native.json', 'all.json']) {
    const p = path.join(base, set, file);
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const emojis = j.emojis || {};
    console.log(`${set}/${file}: ${Object.keys(emojis).length} emojis, has scales: ${!!emojis['scales']}`, emojis['scales'] ? JSON.stringify(emojis['scales']).slice(0, 300) : '');
    if (emojis['scales']) {
      // build id -> native map
      const map = {};
      for (const [id, em] of Object.entries(emojis)) {
        const n = em.skins && em.skins[0] && em.skins[0].native;
        if (n) map[id] = n;
      }
      for (const [id, t] of Object.entries(j.aliases || {})) if (map[t] && !map[id]) map[id] = map[t];
      fs.writeFileSync(path.join(__dirname, 'emoji-map.json'), JSON.stringify(map));
      console.log('wrote emoji-map.json, ids:', Object.keys(map).length, 'scales ->', JSON.stringify(map['scales']));
      return;
    }
  }
}
console.log('scales not found in any set');
