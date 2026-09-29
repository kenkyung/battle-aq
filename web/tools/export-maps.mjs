// Dumps every map's collision set (exactly what the server collides with) to
// JSON for the Blender build: art/blender/build_maps.py turns these boxes into
// textured, lightmapped geometry. Run: node tools/export-maps.mjs <outdir>

import fs from 'node:fs';
import path from 'node:path';
import { MAP_LIST } from '../shared/maps.js';
import { buildColliders } from '../shared/physics.js';
import { themeFor } from '../shared/themes.js';

const out = process.argv[2] || 'build/maps';
fs.mkdirSync(out, { recursive: true });
for (const map of MAP_LIST) {
  const data = {
    id: map.id,
    bounds: map.bounds,
    palette: Object.fromEntries(Object.entries(map.palette).map(([k, v]) => [k, v.toString(16).padStart(6, '0')])),
    sky: { top: map.sky.top.toString(16).padStart(6, '0'), horizon: map.sky.horizon.toString(16).padStart(6, '0') },
    sun: map.sun, ambient: map.ambient,
    boxes: buildColliders(map).map((c) => ({ min: c.min, max: c.max, mat: c.mat })),
    water: (map.water || []).map((w) => ({ y: w.y, w: w.w, d: w.d, pos: w.pos || [0, 0] })),
    bombsites: map.bombsites || {},
    coverSeed: map.coverSeed,
    theme: themeFor(map.id),
  };
  fs.writeFileSync(path.join(out, `${map.id}.json`), JSON.stringify(data));
  console.log(`${map.id}: ${data.boxes.length} boxes`);
}
