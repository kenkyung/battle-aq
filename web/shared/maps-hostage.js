// Hostage-rescue maps (cs_*): Terrorists guard four hostages, CTs lead them to
// a rescue zone. Same blockout conventions as maps.js (64 u grid, boxes /
// ramps / columns). Extra fields:
//   hostages     [[x,y,z], ...] where the hostages stand at round start
//   rescueZones  [[x,y,z,radius], ...]
//   lights       [[x,y,z, power (W), 'rrggbb'], ...] baked by Blender (indoor)
//   indoorFloor  palette key of the interior floor (footsteps / impacts)

import { TEAM } from './constants.js';

const hex = (r, g, b) => (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
const W = (x, y, z, sx, sy, sz, mat) => ({ c: [x, y, z], s: [sx, sy, sz], mat });
const G = (x, z, w, d, mat, topY = 0, thick = 64) => ({ c: [x, topY - thick / 2, z], s: [w, thick, d], mat });
const RAMP = (ax, ay, az, bx, by, bz, width, mat) => ({ a: [ax, ay, az], b: [bx, by, bz], width, mat });
function spawnCluster(cx, cz, y = 0) {
  const o = 32;
  return [[cx - o, y, cz - o], [cx + o, y, cz - o], [cx - o, y, cz + o], [cx + o, y, cz + o]];
}
// A wall along x (at z) from x0 to x1, leaving the given door gaps [[center, width], ...]
function wallX(z, x0, x1, gaps, h, y0, thick, mat) {
  const out = [];
  let cur = x0;
  for (const [c, w] of [...gaps].sort((a, b) => a[0] - b[0])) {
    if (c - w / 2 > cur) out.push(W((cur + c - w / 2) / 2, y0 + h / 2, z, c - w / 2 - cur, h, thick, mat));
    cur = c + w / 2;
  }
  if (x1 > cur) out.push(W((cur + x1) / 2, y0 + h / 2, z, x1 - cur, h, thick, mat));
  return out;
}
function wallZ(x, z0, z1, gaps, h, y0, thick, mat) {
  return wallX(0, z0, z1, gaps, h, y0, thick, mat).map((b) => W(x, b.c[1], b.c[0], thick, b.s[1], b.s[0], mat));
}
const perimeter = (b, mat, h = 256) => [
  W((b.x0 + b.x1) / 2, h / 2, b.z0, b.x1 - b.x0, h, 64, mat), W((b.x0 + b.x1) / 2, h / 2, b.z1, b.x1 - b.x0, h, 64, mat),
  W(b.x0, h / 2, (b.z0 + b.z1) / 2, 64, h, b.z1 - b.z0, mat), W(b.x1, h / 2, (b.z0 + b.z1) / 2, 64, h, b.z1 - b.z0, mat),
];

// ------------------------------------------------------------------ cs_aq_office
// An office block in the snow. T and the hostages are upstairs-quiet offices
// on the north side; CT start in the snowy car park to the south. Ways in:
// the front doors into the lobby, a side door into the west conference room,
// and the east garage door straight onto the corridor.

const officeB = { x0: -1792, z0: -1536, x1: 1792, z1: 1536 };
const office = {
  id: 'cs_aq_office', name: 'cs_aq_office', mode: 'hostage',
  bounds: officeB,
  palette: {
    floor: hex(0.86, 0.88, 0.9), carpet: hex(0.33, 0.32, 0.36), wall: hex(0.78, 0.76, 0.7),
    concrete: hex(0.58, 0.58, 0.57), ceiling: hex(0.86, 0.86, 0.83), wood: hex(0.42, 0.28, 0.17),
    metal: hex(0.40, 0.42, 0.45), cover: hex(0.45, 0.30, 0.17), foliage: hex(0.2, 0.32, 0.2),
    accent: hex(0.52, 0.5, 0.48),
  },
  sky: { top: hex(0.62, 0.66, 0.72), horizon: hex(0.82, 0.84, 0.87) },
  fog: { color: hex(0.82, 0.84, 0.87), density: 0.00028 },
  ambient: 0.85, sun: 0.55,
  boxes: [
    G(0, 0, 3584, 3072, 'floor'),
    ...perimeter(officeB, 'accent'),
    // building shell (concrete, 192 high), carpet floor, ceiling
    G(0, -416, 2688, 1728, 'carpet', 2, 4),
    ...wallX(-1280, -1360, 1360, [], 192, 0, 32, 'concrete'),
    ...wallX(448, -1360, 1360, [[0, 256]], 192, 0, 32, 'concrete'),
    ...wallZ(-1344, -1280, 448, [[64, 128]], 192, 0, 32, 'concrete'),
    ...wallZ(1344, -1280, 448, [[-608, 192]], 192, 0, 32, 'concrete'),
    G(0, -416, 2720, 1760, 'ceiling', 192, 16),
    // corridor (z -512..-320) with office doors to the north and room doors south
    ...wallX(-512, -1328, 1328, [[-1008, 128], [-336, 128], [336, 128], [1008, 128]], 174, 2, 32, 'wall'),
    ...wallX(-320, -1328, 1328, [[-896, 128], [0, 896], [896, 128]], 174, 2, 32, 'wall'),
    // office dividers
    ...[-672, 0, 672].map((x) => W(x, 89, -896, 32, 174, 768, 'wall')),
    // lobby side walls
    W(-448, 89, 64, 32, 174, 768, 'wall'), W(448, 89, 64, 32, 174, 768, 'wall'),
    // furniture: desks, filing cabinets, reception, conference table
    W(-560, 18, -1150, 96, 32, 48, 'wood'), W(-160, 18, -1150, 96, 32, 48, 'wood'),
    W(160, 18, -1150, 96, 32, 48, 'wood'), W(560, 18, -1150, 96, 32, 48, 'wood'),
    W(880, 18, -1120, 96, 32, 48, 'wood'), W(1200, 18, -880, 48, 32, 96, 'wood'),
    W(-1240, 18, -1180, 96, 32, 48, 'wood'), W(-800, 18, -700, 48, 32, 96, 'wood'),
    W(-640, 38, -1240, 32, 72, 48, 'metal'), W(40, 38, -1240, 32, 72, 48, 'metal'), W(1300, 38, -1240, 32, 72, 48, 'metal'),
    W(0, 22, 200, 256, 40, 64, 'wood'),
    W(-896, 18, 64, 256, 32, 128, 'wood'),
    W(1100, 38, 300, 128, 72, 32, 'metal'),
    // car park: vans, a skip, hedges
    W(-900, 48, 1000, 96, 96, 224, 'metal'), W(700, 48, 900, 224, 96, 96, 'metal'),
    W(-300, 40, 1350, 160, 80, 96, 'metal'),
    W(-420, 32, 640, 256, 64, 48, 'foliage'), W(420, 32, 640, 256, 64, 48, 'foliage'),
    W(1560, 40, -300, 96, 80, 200, 'metal'), W(1560, 40, 250, 96, 80, 200, 'metal'),
  ],
  ramps: [],
  columns: [],
  water: [],
  lights: [
    ...[-1152, -576, 0, 576, 1152].map((x) => [x, 170, -416, 9e5, 'fff2dc']),
    ...[-1008, -336, 336, 1008].map((x) => [x, 170, -896, 1.1e6, 'f4f6ff']),
    [0, 170, -60, 1.1e6, 'fff2dc'], [0, 170, 260, 1.0e6, 'fff2dc'],
    [-896, 170, 64, 1.0e6, 'fff0d0'], [896, 170, 64, 1.0e6, 'fff0d0'],
  ],
  indoorFloor: 'carpet',
  coverZones: [[-1600, 560, -600, 1300], [520, 560, 1600, 1300], [1420, -1400, 1740, 400]],
  coverCount: 10,
  coverSeed: 0x0FF1CE,
  spawns: {
    [TEAM.T]: spawnCluster(-1008, -896, 2),
    [TEAM.CT]: spawnCluster(0, 1280, 0),
  },
  bombsites: {},
  hostages: [[-420, 2, -1000], [-230, 2, -760], [240, 2, -1000], [430, 2, -760]],
  rescueZones: [[0, 0, 1260, 320], [1600, 0, -600, 220]],
};

// ------------------------------------------------------------------ cs_aq_assault
// A warehouse in a fenced yard. Hostages in the back office; T hold the hall
// (crate stacks, a catwalk along the east wall). CT come from the gate to the
// south; doors: the big front roller door, a west side door, a back door.

const assaultB = { x0: -2048, z0: -1792, x1: 2048, z1: 1792 };
const crate = (x, z, h = 1) => Array.from({ length: h }, (_, i) => W(x, 64 + i * 128, z, 128, 128, 128, 'cover'));
const assault = {
  id: 'cs_aq_assault', name: 'cs_aq_assault', mode: 'hostage',
  bounds: assaultB,
  palette: {
    floor: hex(0.33, 0.33, 0.34), concrete: hex(0.6, 0.6, 0.58), wall: hex(0.55, 0.58, 0.6),
    ceiling: hex(0.8, 0.8, 0.78), roof: hex(0.5, 0.52, 0.54), container: hex(0.58, 0.26, 0.18),
    metal: hex(0.42, 0.44, 0.46), cover: hex(0.45, 0.30, 0.17), wood: hex(0.5, 0.36, 0.22),
    accent: hex(0.5, 0.49, 0.46), office: hex(0.78, 0.76, 0.7),
  },
  sky: { top: hex(0.5, 0.6, 0.72), horizon: hex(0.78, 0.76, 0.7) },
  fog: { color: hex(0.72, 0.7, 0.66), density: 0.00022 },
  ambient: 0.75, sun: 0.9,
  boxes: [
    G(0, 0, 4096, 3584, 'floor'),
    ...perimeter(assaultB, 'accent'),
    // warehouse: concrete floor, corrugated walls 384 high, roof
    G(128, -448, 2304, 1664, 'concrete', 2, 4),
    ...wallX(-1280, -1040, 1296, [[896, 128]], 384, 0, 32, 'wall'),
    ...wallX(384, -1040, 1296, [[128, 256]], 384, 0, 32, 'wall'),
    ...wallZ(-1024, -1280, 384, [[-256, 128]], 384, 0, 32, 'wall'),
    ...wallZ(1280, -1280, 384, [], 384, 0, 32, 'wall'),
    G(128, -448, 2368, 1728, 'roof', 400, 16),
    // back office (hostages): x -1024..-512, z -1280..-768, door on its east side
    ...wallZ(-512, -1280, -768, [[-960, 128]], 174, 2, 32, 'office'),
    ...wallX(-768, -1024, -496, [], 174, 2, 32, 'office'),
    G(-768, -1024, 512, 512, 'ceiling', 176, 16),
    // crate stacks in the hall
    ...crate(-256, -1000, 2), ...crate(-256, -560), ...crate(256, -1000), ...crate(256, -560, 2),
    ...crate(-640, -300), ...crate(640, -760, 2), ...crate(0, 0), ...crate(-512, 128),
    // catwalk along the east wall, stairs at its south end
    G(1120, -640, 256, 1216, 'metal', 192, 16),
    W(984, 216, -700, 16, 48, 1096, 'metal'),
    // the hall's own office box / tool cages
    W(900, 48, 200, 160, 96, 160, 'metal'),
    // yard: shipping containers, a truck, a pallet stack
    W(-1500, 128, -400, 192, 256, 448, 'container'), W(-1500, 128, 400, 192, 256, 448, 'container'),
    W(1700, 128, -900, 448, 256, 192, 'container'), W(-1600, 128, 1200, 448, 256, 192, 'container'),
    W(700, 64, 1000, 224, 128, 448, 'metal'),
    W(-600, 32, 900, 128, 64, 128, 'wood'),
  ],
  ramps: [
    RAMP(1120, 0, 352, 1120, 192, -32, 128, 'metal'),
  ],
  columns: [
    { pos: [-640, -800], r: 24, h: 384, mat: 'metal' }, { pos: [640, -80], r: 24, h: 384, mat: 'metal' },
  ],
  water: [],
  lights: [
    ...[-640, 0, 640].flatMap((x) => [-1080, -620, -160].map((z) => [x, 370, z, 2.2e6, 'fff4e0'])),
    [1120, 370, -640, 1.6e6, 'fff4e0'],
    [-768, 165, -1024, 1.2e6, 'f4f6ff'],
  ],
  indoorFloor: 'concrete',
  coverZones: [[-1900, 600, -800, 1500], [300, 1300, 1900, 1650], [-1900, -1700, -1200, -800], [1500, -500, 1900, 600]],
  coverCount: 14,
  coverSeed: 0xA55A17,
  spawns: {
    [TEAM.T]: spawnCluster(-640, -520, 2),
    [TEAM.CT]: spawnCluster(0, 1480, 0),
  },
  bombsites: {},
  hostages: [[-900, 2, -1180], [-640, 2, -1180], [-900, 2, -900], [-700, 2, -880]],
  rescueZones: [[0, 0, 1440, 340]],
};

// ------------------------------------------------------------------ cs_aq_italy
// A small Italian town. The hostages are in a house on the north-west corner
// of the T courtyard (doors on its east and south sides); the market square
// and its fountain sit in the middle; CT start in the south-east piazza.

const italyB = { x0: -2048, z0: -1792, x1: 2048, z1: 1792 };
const block = (x0, z0, x1, z1, h = 320) => [
  W((x0 + x1) / 2, h / 2, (z0 + z1) / 2, x1 - x0, h, z1 - z0, 'wall'),
  W((x0 + x1) / 2, h + 12, (z0 + z1) / 2, x1 - x0 + 24, 24, z1 - z0 + 24, 'accent'),   // tiled roof edge
];
const italy = {
  id: 'cs_aq_italy', name: 'cs_aq_italy', mode: 'hostage',
  bounds: italyB,
  palette: {
    floor: hex(0.52, 0.49, 0.45), wall: hex(0.84, 0.72, 0.52), accent: hex(0.62, 0.3, 0.2),
    wood: hex(0.46, 0.32, 0.2), cover: hex(0.45, 0.30, 0.17), stone: hex(0.66, 0.62, 0.54),
    metal: hex(0.4, 0.4, 0.42), foliage: hex(0.22, 0.4, 0.2), ceiling: hex(0.8, 0.76, 0.66),
    house: hex(0.9, 0.82, 0.66),
  },
  sky: { top: hex(0.42, 0.6, 0.82), horizon: hex(0.86, 0.8, 0.68) },
  fog: { color: hex(0.84, 0.78, 0.66), density: 0.0002 },
  ambient: 0.75, sun: 1.05,
  boxes: [
    G(0, 0, 4096, 3584, 'floor'),
    ...perimeter(italyB, 'wall', 320),
    // town blocks
    ...block(-1344, -1024, -768, -448), ...block(320, -1024, 1152, -448),
    ...block(-1344, 448, -640, 1152), ...block(640, 448, 1344, 1024),
    ...block(-2016, -64, -1600, 1152, 288), ...block(1664, -1152, 2016, 192, 288),
    ...block(-704, -1760, -320, -1344, 288),
    // hostage house: x -1600..-896, z -1664..-1152, doors east (z -1408) and south (x -1248)
    G(-1248, -1408, 704, 512, 'wood', 2, 4),
    ...wallX(-1664, -1616, -880, [], 240, 0, 32, 'house'),
    ...wallX(-1152, -1616, -880, [[-1248, 128]], 240, 0, 32, 'house'),
    ...wallZ(-1600, -1664, -1152, [], 240, 0, 32, 'house'),
    ...wallZ(-896, -1664, -1152, [[-1408, 128]], 240, 0, 32, 'house'),
    G(-1248, -1408, 736, 544, 'accent', 256, 16),
    W(-1248, 38, -1580, 256, 72, 48, 'wood'), W(-1520, 22, -1300, 48, 40, 96, 'wood'),
    // market square: fountain, stalls
    W(0, 16, -176, 352, 32, 32, 'stone'), W(0, 16, 176, 352, 32, 32, 'stone'),
    W(-176, 16, 0, 32, 32, 320, 'stone'), W(176, 16, 0, 32, 32, 320, 'stone'),
    W(-480, 48, -300, 128, 96, 64, 'wood'), W(480, 48, 300, 128, 96, 64, 'wood'), W(-480, 48, 300, 64, 96, 128, 'wood'),
    // carts, benches, wine barrels
    W(900, 40, -1400, 160, 80, 96, 'wood'), W(-1000, 24, 1400, 128, 48, 48, 'wood'), W(1400, 32, 1300, 96, 64, 96, 'wood'),
  ],
  ramps: [],
  columns: [{ pos: [0, 0], r: 40, h: 96, mat: 'stone' }],
  water: [{ y: 20, w: 320, d: 320, mat: 'water', pos: [0, 0] }],
  lights: [[-1248, 225, -1408, 1.4e6, 'ffe8c0']],
  indoorFloor: 'wood',
  coverZones: [[-1500, -500, -800, 400], [700, -400, 1600, 400], [-600, 1200, 600, 1700], [500, -1700, 1600, -1200]],
  coverCount: 12,
  coverSeed: 0x17A1,
  spawns: {
    [TEAM.T]: spawnCluster(200, -1480, 0),
    [TEAM.CT]: spawnCluster(900, 1500, 0),
  },
  bombsites: {},
  hostages: [[-1450, 2, -1560], [-1100, 2, -1560], [-1450, 2, -1280], [-1100, 2, -1300]],
  rescueZones: [[900, 0, 1480, 340]],
};

export const HOSTAGE_MAPS = [office, assault, italy];
