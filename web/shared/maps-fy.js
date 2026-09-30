// fy_ ("fight yard") maps (M20): small, no objective, no buying — the guns
// lie on the floor at the start of every round, grab one and fight. Built for
// quick rounds and for deathmatch. Extra fields:
//   fy            true: no buy, short freeze, time out -> the side with more
//                 players alive wins
//   floorWeapons  [[weapon, x, y, z], ...] laid out each round (dropped from
//                 y + 40 onto whatever is below); in deathmatch / warmup a
//                 taken gun comes back after 20 s
//   snow          client: falling snow

import { TEAM } from './constants.js';
import { carve } from './mapgen.js';

const hex = (r, g, b) => (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
const W = (x, y, z, sx, sy, sz, mat) => ({ c: [x, y, z], s: [sx, sy, sz], mat });
const G = (x, z, w, d, mat, topY = 0, thick = 64) => ({ c: [x, topY - thick / 2, z], s: [w, thick, d], mat });
const RAMP = (ax, ay, az, bx, by, bz, width, mat) => ({ a: [ax, ay, az], b: [bx, by, bz], width, mat });
const cluster = (cx, cz, y = 0) => [[cx - 32, y, cz - 32], [cx + 32, y, cz - 32], [cx - 32, y, cz + 32], [cx + 32, y, cz + 32]];
// A wall along x (at z) from x0 to x1, leaving door gaps [[center, width], ...]
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
// both sides' floor guns, the T set mirrored (z -> -z) from the CT set
const mirrorGuns = (ct, tSwap) => [
  ...ct,
  ...ct.map(([w, x, y, z]) => [tSwap[w] || w, x, y, -z]),
];
const T_GUNS = { m4a1: 'ak47', famas: 'galil', aug: 'sg552' };

// ------------------------------------------------------------------ fy_pool_day2
//
// The pool-party classic: two houses facing each other across a back yard, a
// swimming pool in the middle (deep end on the CT side — you can drown — with
// a slope up to the shallow end and steps out), lawns and hedges down the
// sides. Each house has a door and a glass patio window per room; the guns
// lie in the houses, and a spare AWP sits at the bottom of the deep end.

const S = 128;                       // deck level
const pdB = { x0: -1472, z0: -1856, x1: 1472, z1: 1856 };
const pdAreas = [
  [-1408, -1152, 1408, 1152, S],     // the yard (deck)
  // houses: two roofed rooms each, joined by a hall
  [-960, -1792, -96, -1248, S, S + 160], [96, -1792, 960, -1248, S, S + 160], [-96, -1600, 96, -1440, S, S + 112],
  [-960, 1248, -96, 1792, S, S + 160], [96, 1248, 960, 1792, S, S + 160], [-96, 1440, 96, 1600, S, S + 112],
  // doors and patio windows through the front walls (roofed = lintel)
  ...[-1, 1].flatMap((sz) => [
    [-704, -1248, -512, -1152], [512, -1248, 704, -1152], [-352, -1248, -224, -1152], [224, -1248, 352, -1152],
  ].map(([x0, z0, x1, z1]) => (sz < 0 ? [x0, z0, x1, z1, S, S + 112] : [x0, -z1, x1, -z0, S, S + 112]))),
  // the pool: deep end (CT side), slope, shallow end
  [-480, -320, 480, -64, 0],
  [-480, -64, 480, 128, 0],
  [-480, 128, 480, 320, 96],
];
const patio = (x0, x1, z) => ({ min: [x0, S + 2, z - 3], max: [x1, S + 110, z + 3] });

const poolDay = {
  id: 'fy_pool_day2', name: 'fy_pool_day2', fy: true,
  bounds: pdB,
  palette: {
    floor: hex(0.62, 0.82, 0.86), deck: hex(0.8, 0.78, 0.74), wall: hex(0.90, 0.86, 0.78), accent: hex(0.62, 0.30, 0.22),
    cover: hex(0.45, 0.30, 0.17), wood: hex(0.6, 0.45, 0.3), grass: hex(0.3, 0.48, 0.18),
    foliage: hex(0.2, 0.4, 0.15), metal: hex(0.6, 0.62, 0.64), water: hex(0.2, 0.6, 0.7),
  },
  sky: { top: hex(0.36, 0.58, 0.88), horizon: hex(0.78, 0.88, 0.96) },
  fog: { color: hex(0.8, 0.88, 0.95), density: 0.00012 },
  ambient: 0.8, sun: 1.05,
  boxes: [
    G(0, 0, 2944, 3712, 'floor'),
    ...carve({ bounds: pdB, areas: pdAreas, wallH: S + 224, floorMat: 'deck', roofMat: 'accent' }),
    // tile liners on the pool walls (the deck blocks are concrete)
    W(0, 62, -318, 960, 124, 4, 'floor'), W(0, 62, 318, 960, 124, 4, 'floor'),
    W(-478, 62, 0, 4, 124, 640, 'floor'), W(478, 62, 0, 4, 124, 640, 'floor'),
    // lawns down both sides, hedges along the fences
    W(-1088, S + 1, 0, 576, 2, 2240, 'grass'), W(1088, S + 1, 0, 576, 2, 2240, 'grass'),
    W(-1376, S + 30, 0, 48, 56, 1600, 'foliage'), W(1376, S + 30, 0, 48, 56, 1600, 'foliage'),
    W(-1100, S + 28, -520, 256, 52, 48, 'foliage'), W(1100, S + 28, 520, 256, 52, 48, 'foliage'),
    // garden walls (cover mid-yard)
    W(-760, S + 44, 0, 32, 88, 448, 'wall'), W(760, S + 44, 0, 32, 88, 448, 'wall'),
    // diving board over the deep end
    W(0, S + 4, -350, 64, 8, 200, 'wood'),
    // sun loungers, tables, a bar cart
    ...[-1, 1].flatMap((sz) => [
      W(-640, S + 12, sz * 480, 64, 24, 128, 'wood'), W(-520, S + 12, sz * 480, 64, 24, 128, 'wood'),
      W(560, S + 16, sz * 520, 96, 32, 96, 'wood'), W(1100, S + 32, sz * 880, 128, 64, 64, 'cover'),
    ]),
    W(-1100, S + 32, 880, 64, 64, 64, 'cover'), W(1100, S + 32, -880, 64, 64, 64, 'cover'),
    // inside the houses: counters and sofas
    ...[-1, 1].flatMap((sz) => [
      W(-700, S + 20, sz * 1740, 320, 40, 64, 'wood'), W(700, S + 20, sz * 1740, 320, 40, 64, 'wood'),
      W(-300, S + 16, sz * 1420, 64, 32, 160, 'cover'), W(300, S + 16, sz * 1420, 64, 32, 160, 'cover'),
    ]),
  ],
  ramps: [
    RAMP(0, 0, -64, 0, 96, 128, 960, 'floor'),          // deep end up to the shallow end
    RAMP(0, 96, 208, 0, S, 320, 320, 'floor'),          // steps out of the shallow end
  ],
  columns: [],
  water: [{ y: 116, w: 960, d: 640, pos: [0, 0], mat: 'water' }],
  glass: [
    { id: 'ctW', ...patio(-352, -224, -1200) }, { id: 'ctE', ...patio(224, 352, -1200) },
    { id: 'tW', ...patio(-352, -224, 1200) }, { id: 'tE', ...patio(224, 352, 1200) },
  ],
  lights: [
    [-528, S + 150, -1520, 5e5, 'fff4e0'], [528, S + 150, -1520, 5e5, 'fff4e0'],
    [-528, S + 150, 1520, 5e5, 'fff4e0'], [528, S + 150, 1520, 5e5, 'fff4e0'],
  ],
  coverZones: [],
  coverCount: 0,
  coverSeed: 0xF7,
  spawns: {
    [TEAM.CT]: [...cluster(-560, -1500, S), ...cluster(560, -1500, S), [0, S, -1520], [-800, S, -1400]],
    [TEAM.T]: [...cluster(-560, 1500, S), ...cluster(560, 1500, S), [0, S, 1520], [800, S, 1400]],
  },
  bombsites: {},
  floorWeapons: [
    ...mirrorGuns([
      ['m4a1', -820, S, -1650], ['m4a1', -740, S, -1650], ['awp', -420, S, -1720], ['deagle', -900, S, -1360],
      ['m4a1', 740, S, -1650], ['m4a1', 820, S, -1650], ['m3', 420, S, -1720], ['mp5', 900, S, -1360],
    ], T_GUNS),
    ['awp', 0, 0, -200], ['deagle', 260, 0, -160],       // the bottom of the deep end
    ['scout', -1180, S, 0], ['p90', 1180, S, 0],
  ],
};

// ------------------------------------------------------------------ fy_snow
//
// Winter yard: each side starts in a fenced snowy lot with its guns, three
// gaps lead into the middle courtyard, where a log cabin (two doors, glass
// windows) sits between crate stacks and two watch platforms with ramps.

const snB = { x0: -1280, z0: -1664, x1: 1280, z1: 1664 };
const cabinWin = (x) => [
  W(x, 24, 0, 24, 48, 128, 'wood'),                   // below the window
  W(x, 160, 0, 24, 32, 128, 'wood'),                  // above it
];

const snow = {
  id: 'fy_snow', name: 'fy_snow', fy: true, snow: true,
  bounds: snB,
  palette: {
    floor: hex(0.9, 0.92, 0.96), wall: hex(0.6, 0.6, 0.6), accent: hex(0.45, 0.33, 0.22),
    cover: hex(0.45, 0.30, 0.17), wood: hex(0.42, 0.3, 0.2), metal: hex(0.5, 0.52, 0.55), concrete: hex(0.62, 0.62, 0.6),
  },
  sky: { top: hex(0.66, 0.71, 0.78), horizon: hex(0.88, 0.9, 0.93) },
  fog: { color: hex(0.86, 0.88, 0.92), density: 0.00035 },
  ambient: 0.9, sun: 0.7,
  boxes: [
    G(0, 0, 2560, 3328, 'floor'),
    ...perimeter(snB, 'wall', 320),
    // the lot fences, three gaps each
    ...wallX(960, -1280, 1280, [[-1024, 192], [0, 256], [1024, 192]], 192, 0, 32, 'wall'),
    ...wallX(-960, -1280, 1280, [[-1024, 192], [0, 256], [1024, 192]], 192, 0, 32, 'wall'),
    // log cabin (x -320..320, z -224..224): doors north and south, a window east and west
    ...wallX(-224, -320, 320, [[0, 112]], 176, 0, 24, 'wood'),
    ...wallX(224, -320, 320, [[0, 112]], 176, 0, 24, 'wood'),
    ...wallZ(-320, -224, 224, [[0, 128]], 176, 0, 24, 'wood'),
    ...wallZ(320, -224, 224, [[0, 128]], 176, 0, 24, 'wood'),
    ...cabinWin(-320), ...cabinWin(320),
    W(0, 188, 0, 704, 24, 512, 'accent'),               // roof
    // watch platforms (east / west), ramps up from the south
    W(-1056, 64, 0, 320, 128, 320, 'concrete'), W(1056, 64, 0, 320, 128, 320, 'concrete'),
    W(-1056, 148, -152, 320, 40, 16, 'concrete'), W(1056, 148, -152, 320, 40, 16, 'concrete'),
    // crate stacks and snowy walls in the courtyard
    W(-640, 32, -480, 64, 64, 64, 'cover'), W(-640, 96, -480, 64, 64, 64, 'cover'), W(-576, 32, -480, 64, 64, 64, 'cover'),
    W(640, 32, 480, 64, 64, 64, 'cover'), W(640, 96, 480, 64, 64, 64, 'cover'), W(576, 32, 480, 64, 64, 64, 'cover'),
    W(640, 32, -560, 128, 64, 64, 'cover'), W(-640, 32, 560, 128, 64, 64, 'cover'),
    W(0, 40, -640, 384, 80, 32, 'concrete'), W(0, 40, 640, 384, 80, 32, 'concrete'),
    // the lots: crates
    ...[-1, 1].flatMap((sz) => [
      W(-700, 32, sz * 1250, 64, 64, 64, 'cover'), W(700, 32, sz * 1250, 64, 64, 64, 'cover'),
      W(-700, 96, sz * 1250, 64, 64, 64, 'cover'), W(0, 32, sz * 1150, 128, 64, 64, 'cover'),
    ]),
  ],
  ramps: [
    RAMP(-1056, 0, 400, -1056, 128, 160, 128, 'wood'),
    RAMP(1056, 0, 400, 1056, 128, 160, 128, 'wood'),
  ],
  columns: [],
  water: [],
  glass: [
    { id: 'cabW', min: [-323, 48, -64], max: [-317, 144, 64] },
    { id: 'cabE', min: [317, 48, -64], max: [323, 144, 64] },
  ],
  lights: [[0, 160, 0, 3e5, 'ffd8a0']],
  coverZones: [],
  coverCount: 0,
  coverSeed: 0xF7,
  spawns: {
    [TEAM.T]: [...cluster(-256, 1400), ...cluster(256, 1400), [-600, 0, 1500], [600, 0, 1500]],
    [TEAM.CT]: [...cluster(-256, -1400), ...cluster(256, -1400), [-600, 0, -1500], [600, 0, -1500]],
  },
  bombsites: {},
  floorWeapons: [
    ...mirrorGuns([
      ['m4a1', -400, 0, -1540], ['m4a1', 0, 0, -1560], ['m4a1', 400, 0, -1540],
      ['awp', 900, 0, -1480], ['deagle', -900, 0, -1480], ['mp5', -1100, 0, -1200], ['famas', 1100, 0, -1200],
    ], T_GUNS),
    ['scout', 0, 0, 0], ['xm1014', 160, 0, 120],        // in the cabin
    ['sg550', -1056, 128, 60], ['aug', 1056, 128, -60],  // on the platforms
  ],
};

// ------------------------------------------------------------------ fy_aq_rooftops
//
// Original fy map for deathmatch: a 3 x 3 block of flat-roofed buildings at
// different heights (96 / 128 / 160) over narrow streets. Ramps climb from
// the street to every roof but the middle one, which you reach over two
// plank bridges from its neighbours — the AWP waits there. Drop down to
// flank, climb to take height: never more than a few seconds from a fight.

const rtB = { x0: -1536, z0: -1536, x1: 1536, z1: 1536 };
const BLOCK = [
  [-896, -896, 96], [0, -896, 160], [896, -896, 96],
  [-896, 0, 128], [0, 0, 128], [896, 0, 128],
  [-896, 896, 96], [0, 896, 160], [896, 896, 96],
];
const rtAreas = [
  [-1472, -1472, 1472, 1472, 0],
  ...BLOCK.map(([x, z, h]) => [x - 256, z - 256, x + 256, z + 256, h]),
];

const rooftops = {
  id: 'fy_aq_rooftops', name: 'fy_aq_rooftops', fy: true,
  bounds: rtB,
  palette: {
    floor: hex(0.3, 0.3, 0.31), wall: hex(0.55, 0.3, 0.22), house: hex(0.82, 0.74, 0.62),
    roof: hex(0.55, 0.55, 0.53), accent: hex(0.5, 0.48, 0.45), cover: hex(0.45, 0.30, 0.17),
    wood: hex(0.5, 0.36, 0.22), metal: hex(0.45, 0.46, 0.48),
  },
  sky: { top: hex(0.3, 0.38, 0.62), horizon: hex(0.98, 0.66, 0.44) },
  fog: { color: hex(0.85, 0.66, 0.52), density: 0.00022 },
  ambient: 0.7, sun: 0.95,
  boxes: [
    G(0, 0, 3072, 3072, 'floor'),
    ...carve({ bounds: rtB, areas: rtAreas, wallH: 320, floorMat: 'house' }),
    // roof caps
    ...BLOCK.map(([x, z, h]) => W(x, h + 1, z, 512, 2, 512, 'roof')),
    // parapets on the roof edges facing the middle (a gap where each bridge lands)
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => W(sx * 648, 96 + 16, sz * 896, 16, 32, 512, 'accent'))),
    W(0, 160 + 16, -648, 512, 32, 16, 'accent'), W(0, 160 + 16, 648, 512, 32, 16, 'accent'),
    ...[-1, 1].flatMap((sx) => [W(sx * 648, 128 + 16, -160, 16, 32, 192, 'accent'), W(sx * 648, 128 + 16, 160, 16, 32, 192, 'accent')]),
    // plank bridges from the west / east roofs to the middle one (all at 128)
    W(-448, 124, 0, 384, 8, 96, 'wood'), W(448, 124, 0, 384, 8, 96, 'wood'),
    // cover on the roofs and in the streets
    ...BLOCK.map(([x, z, h], i) => W(x + (i % 2 ? 96 : -96), h + 34, z + (i % 3 ? -96 : 96), 64, 64, 64, 'cover')),
    W(0, 128 + 48, 0, 128, 96, 128, 'metal'),            // water tank on the middle roof
    W(-448, 32, -448, 64, 64, 64, 'cover'), W(448, 32, 448, 64, 64, 64, 'cover'),
    W(448, 32, -448, 64, 64, 128, 'cover'), W(-448, 32, 448, 64, 64, 128, 'cover'),
    W(0, 32, -1312, 128, 64, 64, 'cover'), W(0, 32, 1312, 128, 64, 64, 'cover'),
  ],
  ramps: [
    RAMP(-1024, 0, -300, -1024, 96, -640, 128, 'wood'), RAMP(1024, 0, -300, 1024, 96, -640, 128, 'wood'),
    RAMP(-1024, 0, 300, -1024, 96, 640, 128, 'wood'), RAMP(1024, 0, 300, 1024, 96, 640, 128, 'wood'),
    RAMP(-600, 0, -1024, -256, 160, -1024, 128, 'wood'), RAMP(600, 0, 1024, 256, 160, 1024, 128, 'wood'),
    RAMP(-1440, 0, 128, -1152, 128, 128, 128, 'wood'), RAMP(1440, 0, -128, 1152, 128, -128, 128, 'wood'),
  ],
  columns: [],
  water: [],
  coverZones: [],
  coverCount: 0,
  coverSeed: 0xF7,
  spawns: {
    [TEAM.T]: [...cluster(-448, 1312), ...cluster(448, 1312), [-1300, 0, 1300], [1300, 0, 1300]],
    [TEAM.CT]: [...cluster(-448, -1312), ...cluster(448, -1312), [-1300, 0, -1300], [1300, 0, -1300]],
  },
  bombsites: {},
  floorWeapons: [
    ...mirrorGuns([
      ['m4a1', -448, 0, -1400], ['m4a1', 448, 0, -1400], ['deagle', -560, 0, -1250], ['deagle', 560, 0, -1250],
      ['mp5', -1300, 0, -1100], ['m3', 1300, 0, -1100], ['scout', -896, 96, -896], ['p90', 896, 96, -896],
      ['famas', 0, 160, -896],
    ], T_GUNS),
    ['awp', 170, 128, 170], ['m249', -896, 128, 60], ['xm1014', 896, 128, -60],
  ],
};

export const FY_MAPS = [poolDay, snow, rooftops];
