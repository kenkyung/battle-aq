// Map validator (M15): every map must let both teams reach every objective
// and each other, spawn nobody inside geometry, and keep its collision set
// small enough for the server.   node tools/validate-maps.mjs [mapId...]

import { MAPS } from '../shared/maps.js';
import { buildColliders, aabbOverlap, playerBox } from '../shared/physics.js';
import { NavGraph } from '../server/nav.js';
import { TEAM } from '../shared/constants.js';

const want = process.argv.slice(2);
let bad = 0;
for (const m of Object.values(MAPS)) {
  if (want.length && !want.includes(m.id)) continue;
  const cols = buildColliders(m);
  const nav = new NavGraph(m, cols);
  const problems = [];
  const goals = m.hostages && m.hostages.length
    ? [...m.hostages.map((h, i) => ['hostage ' + i, h]), ...(m.rescueZones || []).map((z, i) => ['rescue ' + i, [z[0], 0, z[2]]])]
    : Object.entries(m.bombsites || {});
  for (const team of [TEAM.T, TEAM.CT]) {
    const from = m.spawns[team][0];
    for (const [label, pos] of goals) if (!nav.path(from, pos)) problems.push(`${team === TEAM.T ? 'T' : 'CT'} spawn cannot reach ${label}`);
    if (!nav.path(from, m.spawns[3 - team][0])) problems.push('spawns are not connected');
    for (const sp of m.spawns[team]) if (cols.some((c) => aabbOverlap(playerBox(sp, false), c))) problems.push(`spawn ${sp} is inside geometry`);
  }
  for (const h of m.hostages || []) if (cols.some((c) => aabbOverlap(playerBox(h, false), c))) problems.push(`hostage ${h} is inside geometry`);
  for (const d of m.doors || []) if (!d.id || !d.open) problems.push('door without id / open offset');
  if (cols.length > 900) problems.push(`${cols.length} colliders (keep it under 900)`);
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${m.id.padEnd(16)} ${cols.length} colliders, ${nav.main.length} nav nodes${problems.length ? '\n      ' + problems.join('\n      ') : ''}`);
  if (problems.length) bad++;
}
process.exit(bad ? 1 : 0);
