// Generates shared/props-data.js: arches over doorways + set-dressing props
// against walls, for every map. Deterministic (seeded), and validated: a prop
// is kept only if it overlaps nothing and every spawn->bombsite route and the
// spawn->spawn route still exist afterwards.   node tools/place-props.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_LIST } from '../shared/maps.js';
import { buildColliders, raycast, rng, aabbOverlap } from '../shared/physics.js';
import { propColliders } from '../shared/props.js';
import { NavGraph } from '../server/nav.js';
import { TEAM } from '../shared/constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KINDS = {
  de_aq_dust: ['barrels', 'sandbags', 'pallets', 'barrel', 'sandbags', 'pallets'],
  de_aq_inferno: ['planter', 'barrels', 'pallets', 'planter', 'barrel'],
  de_aq_aztec: ['planter', 'sandbags', 'barrels', 'planter', 'pallets'],
  de_aq_dust2: ['barrels', 'sandbags', 'pallets', 'barrel', 'sandbags'],
  cs_aq_office: ['pallets', 'barrels', 'barrel', 'pallets'],
  cs_aq_assault: ['barrels', 'pallets', 'sandbags', 'barrel', 'pallets'],
  cs_aq_italy: ['planter', 'barrels', 'pallets', 'planter', 'barrel'],
};

// what every map must keep reachable: bombsites, or hostages + rescue zones
function goals(map) {
  if (map.hostages && map.hostages.length) return [...map.hostages, ...(map.rescueZones || []).map((z) => [z[0], z[1], z[2]])];
  return Object.values(map.bombsites || {});
}
const SIZES = { barrel: [28, 28], barrels: [58, 30], sandbags: [112, 34], pallets: [52, 52], planter: [34, 34] };

function routesOk(map, cols) {
  const nav = new NavGraph(map, cols);
  for (const team of [TEAM.T, TEAM.CT]) {
    for (const site of goals(map)) if (!nav.path(map.spawns[team][0], site)) return false;
    if (!nav.path(map.spawns[team][0], map.spawns[3 - team][0])) return false;
  }
  return true;
}

function arches(map, cols) {
  const walls = cols.filter((c) => c.min[1] <= 1 && c.max[1] - c.min[1] >= 160 &&
    Math.min(c.max[0] - c.min[0], c.max[2] - c.min[2]) <= 72 && ['wall', 'accent'].includes(c.mat));
  const out = [];
  for (const a of walls) for (const b of walls) {
    if (a === b) continue;
    for (const [along, across] of [[0, 2], [2, 0]]) {
      const thinA = a.max[across] - a.min[across], thinB = b.max[across] - b.min[across];
      if (thinA > 72 || thinB > 72 || Math.abs(thinA - thinB) > 1) continue;
      if (Math.abs((a.min[across] + a.max[across]) / 2 - (b.min[across] + b.max[across]) / 2) > 1) continue;
      const gap = b.min[along] - a.max[along];
      if (gap < 96 || gap > 260) continue;
      const mid = (a.max[along] + b.min[along]) / 2;
      const c = (a.min[across] + a.max[across]) / 2;
      const top = Math.min(a.max[1], b.max[1], 184);
      if (top < 172) continue;
      const p = { kind: 'arch', pos: along === 0 ? [mid, 0, c] : [c, 0, mid], axis: along === 0 ? 'x' : 'z', span: gap, thick: thinA, top };
      // the doorway itself must be open at head height
      const inGap = { min: [p.pos[0] - 8, 2, p.pos[2] - 8], max: [p.pos[0] + 8, 130, p.pos[2] + 8] };
      if (cols.some((k) => aabbOverlap(inGap, k))) continue;
      out.push(p);
    }
  }
  return out;
}

function props(map, cols, rand) {
  const nav = new NavGraph(map, cols);
  const kinds = KINDS[map.id] || KINDS.de_aq_dust;
  const avoid = [...Object.values(map.spawns).map((s) => s[0]), ...goals(map)];
  const cands = [];
  for (const n of nav.main) {
    if (n.y > 1) continue;
    if (avoid.some((a) => Math.hypot(a[0] - n.x, a[2] - n.z) < 330)) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const o = [n.x, n.y + 20, n.z];
      const toWall = raycast(o, [dx, 0, dz], cols, 60);
      if (!toWall) continue;
      const open = raycast(o, [-dx, 0, -dz], cols, 420);
      if (open) continue;                                   // needs room in front
      const side1 = raycast(o, [dz, 0, dx], cols, 160), side2 = raycast(o, [-dz, 0, -dx], cols, 160);
      if (side1 || side2) continue;                         // not in a corridor corner
      cands.push({ n, dx, dz, wall: toWall.t });
    }
  }
  const placed = [];
  const order = cands.map((c) => [rand(), c]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  for (const c of order) {
    if (placed.length >= 14) break;
    if (placed.some((p) => Math.hypot(p.pos[0] - c.n.x, p.pos[2] - c.n.z) < 420)) continue;
    const kind = kinds[placed.length % kinds.length];
    const [len, dep] = SIZES[kind];
    const rot = c.dx !== 0 ? 90 : 0; // long side along the wall
    const off = c.wall - dep / 2 - 1;
    const pos = [Math.round(c.n.x + c.dx * off), c.n.y, Math.round(c.n.z + c.dz * off)];
    const p = { kind, pos, rot };
    const boxes = propColliders(p);
    if (boxes.some((b) => cols.some((k) => k.max[1] > 1 && aabbOverlap(b, k)))) continue;
    placed.push(p);
  }
  return placed;
}

// maps that already have props keep them (layouts players know) unless --all
const { PROPS: existing } = await import('../shared/props-data.js');
const all = process.argv.includes('--all');
const data = {};
for (const map0 of MAP_LIST) {
  if (!all && existing[map0.id]) { data[map0.id] = existing[map0.id]; continue; }
  const map = { ...map0, props: [] };
  let cols = buildColliders(map);
  const rand = rng(0xA11CE ^ map.coverSeed);
  const kept = [];
  for (const cand of [...arches(map, cols).slice(0, 8), ...props(map, cols, rand)]) {
    const trial = { ...map, props: [...kept, cand] };
    const tc = buildColliders(trial);
    if (routesOk(trial, tc)) { kept.push(cand); cols = tc; }
  }
  data[map.id] = kept;
  console.log(map.id, 'arches', kept.filter((p) => p.kind === 'arch').length, 'props', kept.filter((p) => p.kind !== 'arch').length);
}
const file = path.join(here, '..', 'shared', 'props-data.js');
const body = Object.entries(data).map(([id, list]) =>
  `  ${id}: [\n${list.map((p) => '    ' + JSON.stringify(p).replace(/"(\w+)":/g, '$1: ') + ',').join('\n')}\n  ],`).join('\n');
fs.writeFileSync(file, `// GENERATED by tools/place-props.mjs — do not edit by hand.\n// Arches over doorways and set dressing, validated against the nav graph.\n\nexport const PROPS = {\n${body}\n};\n`);
console.log('wrote', path.relative(process.cwd(), file));
