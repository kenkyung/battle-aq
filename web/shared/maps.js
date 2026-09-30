// Map definitions for the web build, ported from godot/scripts/maps/*.gd.
//
// Each map is plain data shared by the server (authoritative collision +
// hit registration) and the client (three.js rendering), so the two never
// disagree about the world.
//
// Geometry model (deliberately simple — these are blockouts):
//   boxes   axis-aligned boxes: { c:[x,y,z] center, s:[sx,sy,sz] full size, mat }
//   ramps   sloped walkways:    { a:[x,y,z] low end, b:[x,y,z] high end, width, mat }
//   columns square pillars:     { pos:[x,z], r, h, mat }  (aztec temple)
//   water   decorative sheets:  { y, w, d, mat }          (non-solid, walk-through)
//
// One big solid floor slab sits under each map at y=0 (top surface); raised
// platforms are boxes on top of it. There are no holes in the floor — the
// aztec canal and the dust "pit" are rendered as depressions but floored, so
// collision stays axis-aligned everywhere.

import { TEAM } from './constants.js';
import { PROPS } from './props-data.js';
import { HOSTAGE_MAPS } from './maps-hostage.js';
import { CLASSIC_MAPS, dust as dustClassic } from './maps-classic.js';

const hex = (r, g, b) =>
  (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);

// Box shorthand. W = wall/solid box (center + size). G = ground slab whose TOP
// surface is at topY (64 u thick by default).
const W = (x, y, z, sx, sy, sz, mat) => ({ c: [x, y, z], s: [sx, sy, sz], mat });
const G = (x, z, w, d, mat, topY = 0, thick = 64) =>
  ({ c: [x, topY - thick / 2, z], s: [w, thick, d], mat });
const RAMP = (ax, ay, az, bx, by, bz, width, mat) =>
  ({ a: [ax, ay, az], b: [bx, by, bz], width, mat });

// 2x2 spawn cluster centred on (cx, cz). `y` is the feet height.
function spawnCluster(cx, cz, y = 0) {
  const o = 32;
  return [
    [cx - o, y, cz - o], [cx + o, y, cz - o],
    [cx - o, y, cz + o], [cx + o, y, cz + o],
  ];
}

// Cover crates scattered (deterministically) across the given zones by the
// server; zones are [x0, z0, x1, z1]. Exported so client renders the same set.

// ------------------------------------------------------------------ de_aq_dust

const dust = {
  id: 'de_aq_dust',
  name: 'de_aq_dust',
  bounds: { x0: -2304, z0: -1792, x1: 2304, z1: 1792 },
  palette: {
    floor: hex(0.72, 0.64, 0.46), wall: hex(0.80, 0.70, 0.52),
    cover: hex(0.45, 0.30, 0.17), metal: hex(0.45, 0.45, 0.48),
    accent: hex(0.52, 0.42, 0.30), wood: hex(0.60, 0.46, 0.32),
  },
  sky: { top: hex(0.55, 0.65, 0.75), horizon: hex(0.85, 0.78, 0.65) },
  fog: { color: hex(0.78, 0.72, 0.55), density: 0.00022 },
  ambient: 0.75,
  sun: 1.0,

  boxes: [
    G(0, 0, 4608, 3584, 'floor'), // main floor, top at y=0

    // perimeter
    W(0, 128, -1792, 4544, 256, 64, 'accent'),
    W(0, 128, 1792, 4544, 256, 64, 'accent'),
    W(2304, 128, 0, 64, 256, 3584, 'accent'),
    W(-2304, 128, 0, 64, 256, 3584, 'accent'),

    // T spawn pocket (backs onto -z)
    W(-1856, 128, -1248, 64, 256, 896, 'wall'),
    W(-2432, 128, -1216, 64, 256, 960, 'wall'),
    W(-2112, 128, -1440, 576, 256, 64, 'wall'),
    // CT spawn pocket (backs onto +z)
    W(1856, 128, 1248, 64, 256, 896, 'wall'),
    W(2432, 128, 1216, 64, 256, 960, 'wall'),
    W(2112, 128, 1440, 576, 256, 64, 'wall'),
    // CT-to-B wall with a 128 u door at z = 960
    W(-896, 128, 832, 1088, 256, 64, 'wall'),
    // short CT-to-A wall, 256 u gap on the east approach
    W(1344, 128, 896, 512, 256, 64, 'wall'),

    // mid door (128 u walkable gap at x = 0..128, z = -64..64)
    W(-896, 128, 0, 1792, 256, 64, 'wall'),
    W(1152, 128, 0, 2048, 256, 64, 'wall'),
    W(-64, 64, 0, 64, 128, 64, 'metal'),
    W(192, 64, 0, 64, 128, 64, 'metal'),
    W(64, 160, 0, 320, 64, 64, 'metal'),
    W(64, 48, 0, 128, 96, 64, 'metal'),

    // long corridor divider
    W(-1376, 128, 448, 1088, 256, 64, 'wall'),
    W(-832, 128, 640, 64, 256, 256, 'wall'),
    W(-640, 128, 384, 64, 256, 896, 'wall'),
    W(-2112, 128, 1664, 256, 256, 192, 'wall'),
    W(-1856, 128, 1216, 64, 256, 640, 'wall'),

    // A platform mass (+64 u deck) and its access
    W(1536, 32, -960, 64, 192, 384, 'wall'),
    W(1536, 32, -1152, 1024, 192, 64, 'wall'),
    // west wall of the A platform, with a gap where the ramp arrives
    W(1088, 32, -1088, 64, 192, 192, 'wall'),
    W(1088, 32, -704, 64, 192, 192, 'wall'),
    W(1216, 32, -640, 832, 192, 64, 'wall'),
    W(1024, 96, -1216, 64, 256, 256, 'wall'),
    // A site deck on top of the platform mass
    G(1600, -896, 832, 640, 'floor', 64),

    // B site enclosure (low walls you can see over) around the flat site
    W(-1344, 32, 192, 512, 64, 64, 'wall'),
    W(-1088, 32, 768, 896, 64, 64, 'wall'),
    W(-768, 32, 480, 64, 64, 320, 'wall'),

    // short A (catwalk path) screens
    W(-1280, 128, -704, 192, 256, 192, 'wall'),
    W(-704, 128, -1280, 192, 256, 192, 'metal'),
    // catwalk upper deck
    G(0, -832, 2048, 256, 'metal', 64),
    G(-1024, 0, 256, 128, 'metal', 64),
    G(1152, 0, 256, 128, 'metal', 64),

    // long corridor cover
    W(-1728, 32, 704, 64, 64, 64, 'cover'),
    W(-1600, 32, 1088, 64, 64, 64, 'cover'),
    W(-1600, 96, 1088, 64, 64, 64, 'cover'),
    W(-1472, 32, 512, 64, 64, 64, 'cover'),
    // B approach cover
    W(-1408, 32, 1280, 64, 64, 64, 'cover'),
    W(-1152, 32, 1344, 64, 64, 64, 'cover'),
    W(-1280, 32, 896, 64, 64, 64, 'cover'),
    W(448, 32, 704, 64, 64, 64, 'metal'),
    W(-576, 32, -576, 64, 64, 64, 'metal'),
  ],

  ramps: [
    // up onto the A platform from the west
    RAMP(1088, 0, -896, 1216, 64, -896, 192, 'metal'),
    // up onto the catwalk from T side
    RAMP(-1024, 0, -704, -1024, 64, -832, 128, 'metal'),
    // second way up to A, from the CT side (north edge of the deck)
    RAMP(1856, 0, -448, 1856, 64, -576, 160, 'wood'),
  ],

  columns: [],
  water: [],

  coverZones: [
    [-2176, -1344, -1344, -768],
    [-2176, 512, -1664, 1536],
    [-1664, 1088, -768, 1536],
    [-640, -1088, 384, -192],
    [1216, -512, 2112, 640],
    [-704, 704, 896, 1408],
    [1280, 1024, 2112, 1408],
  ],
  coverCount: 30,
  coverSeed: 0xD057,

  spawns: {
    // Kept clear of the spawn-pocket walls (a cluster hugging the wall made
    // players spawn inside it; the old centre overlapped TSpawn_N/CTSpawn_S).
    [TEAM.T]: spawnCluster(-2144, -1580),
    [TEAM.CT]: spawnCluster(2144, 1580),
  },
  bombsites: { A: [1856, 64, -1088], B: [-1088, 0, 480] },
};

// ------------------------------------------------------------------ de_aq_inferno

const inferno = {
  id: 'de_aq_inferno',
  name: 'de_aq_inferno',
  bounds: { x0: -1920, z0: -1536, x1: 1920, z1: 1536 },
  palette: {
    floor: hex(0.50, 0.47, 0.43), wall: hex(0.78, 0.70, 0.58),
    cover: hex(0.55, 0.36, 0.22), accent: hex(0.62, 0.28, 0.18),
    metal: hex(0.40, 0.40, 0.42), wood: hex(0.48, 0.33, 0.20),
  },
  sky: { top: hex(0.45, 0.5, 0.6), horizon: hex(0.65, 0.55, 0.45) },
  fog: { color: hex(0.55, 0.5, 0.45), density: 0.00022 },
  ambient: 0.6,
  sun: 0.9,

  boxes: [
    G(0, 0, 3840, 3136, 'floor'),

    // perimeter
    W(0, 128, -1536, 3840, 256, 64, 'accent'),
    W(0, 128, 1536, 3840, 256, 64, 'accent'),
    W(1920, 128, 0, 64, 256, 3136, 'accent'),
    W(-1920, 128, 0, 64, 256, 3136, 'accent'),

    // T spawn pocket
    W(-1824, 128, -768, 192, 256, 64, 'wall'),   // T spawn north wall, door at x -1728..-1568
    W(-1488, 128, -768, 160, 256, 64, 'wall'),
    W(-1408, 128, -1216, 64, 256, 896, 'wall'),
    // CT spawn pocket
    W(1536, 128, 896, 768, 256, 64, 'wall'),

    // banana arc (stepped)
    W(-1792, 128, -256, 64, 256, 640, 'wall'),
    W(-1728, 128, 192, 64, 256, 256, 'wall'),
    W(-1600, 128, 384, 64, 256, 192, 'wall'),
    W(-1536, 128, 576, 64, 256, 128, 'wall'),
    W(-1408, 128, 704, 64, 256, 128, 'wall'),
    W(-1280, 128, 832, 64, 256, 144, 'wall'),
    W(-1152, 128, 960, 64, 256, 112, 'wall'),
    W(-960, 128, -128, 832, 256, 64, 'wall'),
    W(-704, 128, -64, 256, 256, 64, 'wall'),

    // mid connector to the apartments block
    W(-896, 128, 192, 448, 256, 64, 'wall'),

    // apartments: ground shell (y 0..128)
    W(-128, 64, 256, 768, 128, 64, 'wall'),
    W(-384, 64, 1024, 256, 128, 64, 'wall'),
    W(128, 64, 1024, 256, 128, 64, 'wall'),
    W(256, 64, 384, 64, 128, 256, 'wall'),
    W(256, 64, 896, 64, 128, 256, 'wall'),
    W(-512, 64, 320, 64, 128, 128, 'wall'),
    W(-512, 64, 640, 64, 128, 128, 'wall'),
    W(-512, 64, 896, 64, 128, 128, 'wall'),
    // upper storey walls (y 128..256)
    W(-128, 192, 256, 768, 128, 64, 'wall'),
    W(-128, 192, 1024, 768, 128, 64, 'wall'),
    W(256, 192, 384, 64, 128, 256, 'wall'),
    W(256, 192, 896, 64, 128, 256, 'wall'),
    W(-512, 192, 320, 64, 128, 128, 'wall'),
    W(-512, 192, 640, 64, 128, 128, 'wall'),
    W(-512, 192, 896, 64, 128, 128, 'wall'),
    // apartment floors: ground at y=0 (main floor), upper at +128, roof +256
    G(-128, 640, 768, 768, 'wood', 128),

    // stair tower
    W(384, 64, 608, 64, 128, 128, 'wall'),
    W(384, 64, 320, 64, 128, 128, 'wall'),
    W(320, 128, 256, 64, 256, 64, 'wall'),
    W(256, 192, 512, 64, 128, 64, 'wall'),
    G(96, 480, 128, 192, 'wood', 128, 128),
    G(-192, 512, 128, 192, 'wood', 192),

    // B site pocket and CT-side wall
    W(-1248, 64, 480, 576, 128, 64, 'wall'),
    W(-1408, 128, 1216, 896, 256, 64, 'wall'),
    W(-192, 128, 1280, 1344, 256, 64, 'wall'),
    W(896, 128, -128, 1408, 256, 64, 'wall'),

    // A site walls
    W(1024, 128, -704, 64, 256, 768, 'wall'),
    W(1536, 128, -1152, 1024, 256, 64, 'wall'),
    W(1664, 128, -448, 640, 256, 64, 'wall'),
    // balcony mass at A (overhang deck at y = 128)
    W(1408, 64, -448, 768, 128, 128, 'wall'),
    W(1504, 160, -384, 384, 64, 64, 'wood'),
    W(1408, 160, -448, 832, 64, 64, 'wood'),
    W(1024, 160, -352, 64, 64, 256, 'wood'),
    W(1792, 160, -352, 64, 64, 256, 'wood'),
    G(1408, -448, 768, 128, 'wood', 128),

    // terraces (non-walkable roofs for skyline)
    W(-1856, 64, -1152, 64, 128, 768, 'accent'),     // (was on top of the T spawn; now hugs the perimeter)
    W(704, 64, 512, 128, 128, 1024, 'accent'),
    W(-512, 64, 1344, 1024, 128, 64, 'accent'),
  ],

  ramps: [
    // banana entry curve
    RAMP(-1792, 0, -576, -1792, 32, -512, 128, 'floor'),
    // apartments ground-floor door + stair tower
    RAMP(320, 0, 1024, 320, 32, 1024, 128, 'wood'),
    RAMP(384, 0, 480, 384, 128, 480, 128, 'wood'),
    RAMP(320, 0, 576, 320, 192, 576, 128, 'wood'),
    // A site +64 lip
    RAMP(1088, 0, -896, 1088, 64, -896, 128, 'wood'),
  ],

  columns: [],
  water: [],

  coverZones: [
    [-1856, -1024, -1408, -768],
    [-1600, 640, -1088, 1152],
    [-896, 192, -576, 1024],
    [384, -1024, 896, -640],
    [1152, -1024, 1792, -512],
    [1216, -256, 1792, 768],
    [-128, -256, 640, 128],
  ],
  coverCount: 30,
  coverSeed: 0x1F,

  spawns: {
    [TEAM.T]: spawnCluster(-1600, -1200),
    [TEAM.CT]: spawnCluster(1500, 1100),
  },
  bombsites: { A: [1536, 0, -768], B: [-1152, 0, 896] },
};

// ------------------------------------------------------------------ de_aq_aztec

const aztec = {
  id: 'de_aq_aztec',
  name: 'de_aq_aztec',
  bounds: { x0: -2112, z0: -1600, x1: 2112, z1: 1600 },
  palette: {
    floor: hex(0.54, 0.51, 0.44), wall: hex(0.60, 0.58, 0.52),
    wood: hex(0.46, 0.32, 0.20), water: hex(0.12, 0.36, 0.46),
    cover: hex(0.22, 0.42, 0.20), foliage: hex(0.22, 0.42, 0.20),
    accent: hex(0.68, 0.63, 0.52), metal: hex(0.42, 0.42, 0.44),
    stone: hex(0.60, 0.58, 0.52),
  },
  sky: { top: hex(0.5, 0.6, 0.7), horizon: hex(0.6, 0.7, 0.6) },
  fog: { color: hex(0.45, 0.55, 0.55), density: 0.00022 },
  ambient: 0.7,
  sun: 1.0,

  boxes: [
    G(0, 0, 4224, 3264, 'floor'),

    // perimeter
    W(0, 128, -1600, 4224, 256, 64, 'accent'),
    W(0, 128, 1600, 4224, 256, 64, 'accent'),
    W(2112, 128, 0, 64, 256, 3264, 'accent'),
    W(-2112, 128, 0, 64, 256, 3264, 'accent'),

    // T spawn pocket
    W(-1408, 128, -1248, 64, 256, 960, 'wall'),
    W(-1792, 128, -896, 576, 256, 64, 'wall'),
    // CT spawn pocket
    W(1408, 128, 1248, 64, 256, 960, 'wall'),
    W(1664, 128, 896, 320, 256, 64, 'wall'),     // CT spawn south wall, door at x 1824..1984
    W(2048, 128, 896, 128, 256, 64, 'wall'),

    // canal walls (decorative depression; water is a sheet on the floor)
    W(0, 32, -1024, 2048, 64, 64, 'wall'),
    W(0, 32, -640, 2048, 64, 64, 'wall'),
    // pier that carries the sniper-approach over the water
    W(1728, 32, 64, 64, 64, 128, 'stone'),

    // bridge guard walls
    W(1728, 32, -896, 64, 192, 192, 'wood'),
    W(1728, 32, -512, 64, 192, 192, 'wood'),
    W(1600, 96, -832, 192, 64, 64, 'wood'),
    // underpass support pillars
    W(1280, 0, -64, 64, 128, 128, 'wall'),
    W(1280, 0, 64, 64, 128, 128, 'wall'),

    // temple (B site) shell
    W(-1088, 64, 576, 832, 128, 64, 'wall'),
    W(-1344, 64, 1408, 320, 128, 64, 'wall'),
    W(-832, 64, 1408, 320, 128, 64, 'wall'),
    W(-1472, 64, 704, 64, 128, 192, 'wall'),
    W(-1472, 64, 1280, 64, 128, 192, 'wall'),
    W(-704, 64, 640, 64, 128, 128, 'wall'),
    W(-704, 64, 1280, 64, 128, 192, 'wall'),
    G(-1088, 992, 768, 832, 'floor', 0),
    G(-1088, 1408, 256, 256, 'stone', 0),

    // mid walls (the -64..64 gap between them is the walk-through)
    W(-1920, 96, 64, 384, 192, 64, 'wall'),
    W(-1536, 96, 64, 384, 192, 64, 'wall'),
    W(576, 96, 64, 384, 192, 64, 'wall'),
    W(960, 96, 64, 384, 192, 64, 'wall'),
    W(-384, 96, 960, 640, 192, 64, 'wall'),

    // snipers' nest structure (landing y = 128)
    W(1792, 128, 0, 64, 256, 640, 'wall'),
    W(1664, 128, -320, 320, 256, 64, 'wall'),
    W(1664, 128, 320, 320, 256, 64, 'wall'),
    W(1600, 192, -64, 64, 128, 128, 'wall'),
    W(1600, 192, 64, 64, 128, 128, 'wall'),
    G(1696, 0, 256, 640, 'metal', 128, 128),

    // CT terrace and B-side ledge
    W(1280, 64, 896, 768, 128, 1088, 'accent'),
    W(-1280, 32, 640, 128, 64, 192, 'wall'),

    // foliage hedgerow
    W(960, 32, -832, 256, 64, 64, 'foliage'),
    W(576, 32, -1088, 256, 64, 64, 'foliage'),
    W(-256, 32, -1408, 256, 64, 64, 'foliage'),
    W(-1664, 32, 1408, 256, 64, 64, 'foliage'),
    W(832, 32, 1408, 256, 64, 64, 'foliage'),

    // temple cover
    W(-1024, 32, 1152, 64, 64, 64, 'wood'),
    W(-1152, 32, 768, 64, 64, 64, 'wood'),
    W(-1024, 96, 1152, 64, 64, 64, 'wood'),
  ],

  // The bridge deck at +64 spanning the canal (reached by ramps).
  bridges: [
    G(1408, -832, 512, 576, 'wood', 64),
  ],

  ramps: [
    // main floor up to the bridge deck (+64)
    RAMP(1088, 0, -704, 1088, 64, -832, 128, 'wood'),
    RAMP(1728, 0, -512, 1728, 64, -704, 128, 'wood'),
    // up to the snipers' nest (+128)
    RAMP(1728, 0, 256, 1728, 128, 192, 128, 'stone'),
    RAMP(1600, 64, -192, 1600, 128, -64, 128, 'wood'),
    // temple entrance steps
    RAMP(-512, 0, 960, -512, 32, 960, 128, 'stone'),
    RAMP(-1440, 0, 704, -1440, 64, 704, 128, 'stone'),
  ],

  columns: [
    { pos: [-832, 704], r: 64, h: 160, mat: 'stone' },
    { pos: [-1344, 704], r: 64, h: 160, mat: 'stone' },
    { pos: [-832, 1152], r: 64, h: 160, mat: 'stone' },
    { pos: [-1344, 1152], r: 64, h: 160, mat: 'stone' },
  ],

  water: [
    // thin translucent sheet on the canal floor, under the bridge at z=-832
    { y: 2, w: 4224, d: 384, mat: 'water', pos: [0, -832] },
  ],

  coverZones: [
    [-1984, -1408, -1472, -832],
    [-1984, -128, -1408, 1408],
    [320, -1472, 1024, -640],
    [1152, -1152, 1728, -576],
    [-1408, 576, -768, 1408],
    [1536, 384, 1984, 1152],
    [-384, -1408, 256, 1408],
  ],
  coverCount: 30,
  coverSeed: 0xA27EC,

  spawns: {
    [TEAM.T]: spawnCluster(-1900, -1400),
    [TEAM.CT]: spawnCluster(1900, 1400),
  },
  bombsites: { A: [1408, 64, -832], B: [-1088, 0, 992] },
};

// flipped on once the client renders hostages (HUD, models, rescue zones)
const HOSTAGE_READY = true;
// de_aq_dust is the original-layout rebuild (underpass + bridge) from maps-classic.js
const ALL = [dustClassic, inferno, aztec, ...CLASSIC_MAPS, ...(HOSTAGE_READY ? HOSTAGE_MAPS : [])];
for (const m of ALL) m.props = PROPS[m.id] || [];

export const MAPS = Object.fromEntries(ALL.map((m) => [m.id, m]));
export const MAP_LIST = ALL;
export function getMap(id) {
  const m = MAPS[id];
  if (!m) throw new Error(`unknown map '${id}' (have ${Object.keys(MAPS).join(', ')})`);
  return m;
}
