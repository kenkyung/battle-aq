// Classic-layout maps (M15), authored as open areas and carved by
// shared/mapgen.js. Layouts follow the well-known competitive maps' flow at
// CS scale; the geometry is our own.

import { TEAM } from './constants.js';
import { carve } from './mapgen.js';

const hex = (r, g, b) => (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
const W = (x, y, z, sx, sy, sz, mat) => ({ c: [x, y, z], s: [sx, sy, sz], mat });
const G = (x, z, w, d, mat, topY = 0, thick = 64) => ({ c: [x, topY - thick / 2, z], s: [w, thick, d], mat });
const RAMP = (ax, ay, az, bx, by, bz, width, mat) => ({ a: [ax, ay, az], b: [bx, by, bz], width, mat });
const cluster = (cx, cz, y = 0) => [[cx - 32, y, cz - 32], [cx + 32, y, cz - 32], [cx - 32, y, cz + 32], [cx + 32, y, cz + 32]];

// ------------------------------------------------------------------ de_aq_dust2
//
// T spawn south; A north-east (long A through the long doors, or short A up
// the catwalk from mid); B north-west through the tunnels; CT spawn north,
// between the sites, with mid doors onto middle.

const d2Bounds = { x0: -2560, z0: -2560, x1: 2560, z1: 2560 };
const d2Areas = [
  // T side
  [-700, 1780, 700, 2420],            // T spawn
  [-250, 1100, 250, 1800],            // top mid (T -> mid)
  [700, 1900, 1500, 2300],            // outside long
  [1150, 1380, 1500, 1920],           // to the long doors
  [1250, 1140, 1410, 1400],           // long doors (the gap)
  [1150, -1300, 1650, 1160],          // long A
  [1150, -1520, 1650, -1280],         // A ramp (floor 0, the ramp climbs to 64)
  [460, -2300, 1700, -1500, 64],      // A site (raised)
  // mid + short A
  [-250, -920, 250, 1120],            // middle
  [-80, -1020, 80, -900],             // mid doors
  [-250, -1720, 250, -1000],          // CT mid
  [250, -20, 560, 320],               // short stairs (floor 0, ramp up to 64)
  [300, -1520, 620, 0, 64],           // catwalk (short A), raised
  // CT
  [-400, -2400, 300, -1700],          // CT spawn
  [300, -2140, 460, -1900],           // CT ramp to A (floor 0, climbs to 64)
  [-800, -2000, -400, -1600],         // CT -> B
  [-1100, -1900, -780, -1700],        // B doors (the gap)
  // B side
  [-1500, 1780, -700, 2220],          // T spawn west exit
  [-1700, 580, -1300, 1800, 0, 176],  // upper tunnels (roofed)
  [-1320, 500, -250, 700, 0, 160],    // lower tunnels to mid (roofed)
  [-1700, -420, -1300, 600],          // B tunnel exit
  [-2400, -2300, -1100, -400],        // B site
];

export const dust2 = {
  id: 'de_aq_dust2',
  name: 'de_aq_dust2',
  bounds: d2Bounds,
  palette: {
    floor: hex(0.72, 0.64, 0.46), wall: hex(0.80, 0.70, 0.52),
    cover: hex(0.45, 0.30, 0.17), metal: hex(0.45, 0.45, 0.48),
    accent: hex(0.52, 0.42, 0.30), wood: hex(0.60, 0.46, 0.32),
  },
  sky: { top: hex(0.55, 0.66, 0.78), horizon: hex(0.86, 0.79, 0.66) },
  fog: { color: hex(0.78, 0.72, 0.55), density: 0.0002 },
  ambient: 0.75,
  sun: 1.0,
  boxes: [
    G(0, 0, 5120, 5120, 'floor'),
    ...carve({ bounds: d2Bounds, areas: d2Areas }),
    // top-mid box and some cover in the open
    W(120, 32, 880, 64, 64, 64, 'cover'),
    W(1500, 32, 700, 64, 64, 64, 'cover'),
    W(1550, 96, -1800, 128, 64, 64, 'cover'),        // A site "goose" boxes (on the 64 deck)
    W(900, 96, -2000, 64, 64, 64, 'cover'),
    W(-1900, 32, -1400, 128, 64, 128, 'cover'),       // B site boxes
    W(-1500, 32, -1900, 64, 64, 64, 'cover'),
    W(-1300, 32, 1100, 64, 64, 64, 'cover'),          // upper tunnels crate
  ],
  ramps: [
    RAMP(1400, 0, -1300, 1400, 64, -1500, 480, 'wood'),     // long A up to the site
    RAMP(405, 0, 320, 405, 64, 0, 300, 'wood'),              // short stairs up to the catwalk
    RAMP(300, 0, -2020, 460, 64, -2020, 230, 'wood'),        // CT ramp to A
  ],
  columns: [],
  water: [],
  lights: [
    [-1500, 150, 900, 7e5, 'ffe8c0'], [-1500, 150, 1500, 7e5, 'ffe8c0'],
    [-800, 130, 600, 6e5, 'ffe8c0'],
  ],
  // a sliding door in the B doors gap (E opens it; bots open it too)
  doors: [{ id: 'bdoors', min: [-960, 0, -1900], max: [-930, 136, -1700], open: [0, 0, -210], mat: 'wood' }],
  coverZones: [[1200, -1200, 1600, 1000], [-200, -800, 200, 1000], [-2300, -2200, -1200, -500], [500, -2250, 1650, -1550]],
  coverCount: 10,
  coverSeed: 0xD2D2,
  spawns: { [TEAM.T]: cluster(0, 2100), [TEAM.CT]: cluster(-60, -2080) },
  bombsites: { A: [1100, 64, -1900], B: [-1800, 0, -1500] },
};

// ------------------------------------------------------------------ de_aq_dust
//
// The original dust's flow. The streets are at 128; the UNDERPASS is a sunken
// trench (floor 0) running north from the T side to the CT courtyard, and
// halfway along it runs under THE BRIDGE — a deck at street level that
// crosses the trench east-west. CTs hold the bridge and the courtyard, Ts
// push through the underpass or come up mid to the bridge: that crossing is
// where the round is decided. The long way round (east) climbs to A; B is
// north-west, past the west end of the bridge; CT spawn sits between the
// sites at the north.

const S = 128;            // street level
const duBounds = { x0: -2560, z0: -2560, x1: 2560, z1: 2560 };
const duAreas = [
  // T side
  [-700, 1700, 700, 2300, S],             // T spawn
  [-300, 1100, 300, 1720, S],             // T ramp up to the junction
  [-1300, 900, -280, 1300, S],            // street west, to the underpass
  [-300, 280, 300, 1120, S],              // T mid
  // the underpass (sunken), with the bridge over its middle
  [-1300, 300, -900, 920],                // entry ramp down (floor 0, the ramp climbs to S)
  [-1300, -100, -900, 320],               // trench, open to the sky
  [-1300, -420, -900, -100, 0, S - 32],   // under the bridge (the bridge deck is the roof)
  [-1300, -900, -900, -420],              // trench north
  [-1300, -1320, -900, -900],             // exit ramp up to the CT courtyard (floor 0)
  // the bridge and its approaches, at street level
  [-1800, -420, -1300, -100, S],          // bridge west end
  [-900, -420, -300, -100, S],            // bridge east end
  [-400, -120, 300, 300, S],              // mid, up to the bridge's east end
  // CT side
  [-1500, -1720, -300, -1300, S],         // CT courtyard (underpass exit)
  [-400, -2300, 700, -1700, S],           // CT spawn
  [700, -2020, 920, -1720, S],            // CT to A
  [-1800, -920, -1500, -100, S],          // west street from the bridge to B
  [-2400, -2000, -1480, -900, S],         // bombsite B
  // the long way: east, then north up to A
  [700, 1800, 1500, 2200, S],             // T spawn east
  [1480, -620, 1900, 2200, S],            // long
  [1280, -1120, 1900, -600, S],           // up to A
  [900, -2100, 2200, -1100, S],           // bombsite A
];

export const dust = {
  id: 'de_aq_dust',
  name: 'de_aq_dust',
  bounds: duBounds,
  palette: {
    floor: hex(0.72, 0.64, 0.46), wall: hex(0.80, 0.70, 0.52),
    cover: hex(0.45, 0.30, 0.17), metal: hex(0.45, 0.45, 0.48),
    accent: hex(0.52, 0.42, 0.30), wood: hex(0.60, 0.46, 0.32),
  },
  sky: { top: hex(0.55, 0.65, 0.75), horizon: hex(0.85, 0.78, 0.65) },
  fog: { color: hex(0.78, 0.72, 0.55), density: 0.0002 },
  ambient: 0.75,
  sun: 1.0,
  boxes: [
    G(0, 0, 5120, 5120, 'floor'),
    ...carve({ bounds: duBounds, areas: duAreas, wallH: S + 256 }),
    // bridge parapets (waist high: CTs peek over them into the trench)
    W(-1100, S + 20, -416, 400, 40, 8, 'accent'),
    W(-1100, S + 20, -104, 400, 40, 8, 'accent'),
    // cover: crates at the underpass mouth, on the sites, the famous stack at A
    W(-1180, 32, 150, 64, 64, 64, 'cover'),
    W(-1000, 32, -650, 64, 64, 64, 'cover'),
    W(-1000, 96, -650, 64, 64, 64, 'cover'),
    W(-900, S + 32, -1550, 64, 64, 64, 'cover'),
    W(1500, S + 32, -1500, 128, 64, 128, 'cover'),
    W(1500, S + 96, -1500, 64, 64, 64, 'cover'),
    W(1900, S + 32, -1850, 64, 64, 64, 'cover'),
    W(-2000, S + 32, -1400, 128, 64, 64, 'cover'),
    W(-1700, S + 32, -1700, 64, 64, 64, 'cover'),
    W(0, S + 32, 700, 64, 64, 64, 'cover'),
    W(1700, S + 32, 900, 64, 64, 64, 'cover'),
  ],
  ramps: [
    RAMP(-1100, S, 920, -1100, 0, 500, 400, 'floor'),          // down into the underpass
    RAMP(-1100, 0, -900, -1100, S, -1320, 400, 'floor'),       // up out of it, into the CT courtyard
  ],
  columns: [],
  water: [],
  coverZones: [[1500, -600, 1880, 2100], [-1250, -880, -950, 250], [950, -2050, 2150, -1150], [-2350, -1950, -1500, -950]],
  coverCount: 12,
  coverSeed: 0xD057,
  spawns: { [TEAM.T]: cluster(0, 2000, S), [TEAM.CT]: cluster(150, -2000, S) },
  bombsites: { A: [1500, S, -1650], B: [-1950, S, -1450] },
};


// ------------------------------------------------------------------ de_aq_nuke
//
// Two bombsites stacked in one building, like nuke: A upstairs in the big
// "silo room", B right below it. Ts come in from the south: up the outdoor
// ramp into the lobby (-> A), or west through the long roofed "secret"
// corridor (-> B), or round the big outside yard to the ramp room and the
// crouch-only vent (-> B). CTs reach A over the heaven catwalk (a ramp up from
// the yard) and B through secret or the ramp room. A hatch in A's floor
// drops into B, with a ladder to climb back up.

const NK = 512;                          // wall height
const nkBounds = { x0: -2048, z0: -2048, x1: 2048, z1: 2048 };
const nkAreas = [
  [-1600, 1280, 1600, 1920],             // T spawn
  [512, -1536, 1600, 1280],              // outside
  [-1536, -1920, 1600, -1536],           // CT spawn
  [-1600, 384, -1024, 1280],             // west approach
  [-1536, -1536, -1152, 384, 0, 160],    // secret (roofed)
  [-1152, -896, -1024, -768, 0, 160],    // secret -> B
  [-1024, -1152, 256, -256, 0, 224],     // B (its ceiling is A's floor)
  [96, -1152, 256, -1024],               // the hatch shaft (no ceiling)
  [256, -768, 512, -512, 0, 160],        // ramp room: outside -> B
  [256, -416, 512, -352, 0, 56],         // the vent: crouch only
  [-1024, -256, 256, 384, 256, 448],     // lobby (upstairs)
  [-640, 384, -384, 1280],               // T ramp up to the lobby
  [256, -1152, 512, -896, 256],          // heaven catwalk (upstairs, open)
];
// solid above the low roofed areas, so the upper floor has walls
const above = (x0, z0, x1, z1, y) => ({ c: [(x0 + x1) / 2, (y + NK) / 2, (z0 + z1) / 2], s: [x1 - x0, NK - y, z1 - z0], mat: 'wall' });

export const nuke = {
  id: 'de_aq_nuke',
  name: 'de_aq_nuke',
  bounds: nkBounds,
  palette: {
    floor: hex(0.36, 0.36, 0.37), wall: hex(0.62, 0.62, 0.6), concrete: hex(0.62, 0.62, 0.6),
    roof: hex(0.55, 0.57, 0.6), metal: hex(0.45, 0.47, 0.5), cover: hex(0.45, 0.30, 0.17),
    container: hex(0.3, 0.42, 0.55), accent: hex(0.7, 0.66, 0.4), wood: hex(0.5, 0.36, 0.22),
  },
  sky: { top: hex(0.46, 0.58, 0.75), horizon: hex(0.8, 0.82, 0.84) },
  fog: { color: hex(0.76, 0.78, 0.8), density: 0.00018 },
  ambient: 0.75, sun: 0.95,
  boxes: [
    G(0, 0, 4096, 4096, 'floor'),
    ...carve({ bounds: nkBounds, areas: nkAreas, wallH: NK, roofMat: 'concrete', floorMat: 'concrete' }),
    above(-1536, -1536, -1152, 384, 192), above(-1152, -896, -1024, -768, 192),
    above(256, -768, 512, -512, 192), above(256, -416, 512, -352, 88),
    above(-1024, -256, 256, 384, 480),
    // the silo room's roof over A, and its wall to the lobby (two doors)
    W(-384, 496, -704, 1280, 32, 896, 'roof'),
    ...[[-1024, -696], [-504, -196], [-4, 256]].map(([x0, x1]) => W((x0 + x1) / 2, 368, -240, x1 - x0, 224, 32, 'wall')),
    // B: floor plates, pillars holding A up, the ladder's support
    W(-384, 1, -704, 1280, 2, 896, 'concrete'),
    W(-700, 112, -500, 48, 224, 48, 'concrete'), W(-100, 112, -900, 48, 224, 48, 'concrete'),
    W(176, 112, -1016, 96, 224, 16, 'metal'),
    // A: the famous crates, railings round the hatch
    W(-420, 256 + 32, -820, 128, 64, 64, 'cover'), W(-420, 256 + 96, -820, 64, 64, 64, 'cover'),
    W(-760, 256 + 32, -480, 64, 64, 128, 'cover'), W(60, 256 + 20, -1088, 16, 40, 128, 'metal'),
    // B: boxes
    W(-560, 32, -760, 128, 64, 64, 'cover'), W(-160, 32, -420, 64, 64, 64, 'cover'), W(-900, 32, -1000, 64, 64, 64, 'cover'),
    // outside: containers + silos' plinths, garage block
    W(900, 64, -200, 128, 128, 320, 'container'), W(1300, 64, 400, 320, 128, 128, 'container'),
    W(1300, 192, 400, 320, 128, 128, 'container'), W(800, 64, 800, 128, 128, 320, 'container'),
    W(1200, 32, -800, 64, 64, 64, 'cover'), W(700, 32, 1100, 128, 64, 64, 'cover'),
    // lobby: desk, T ramp crates
    W(-300, 256 + 20, 100, 256, 40, 64, 'wood'), W(-512, 32, 1180, 64, 64, 64, 'cover'),
  ],
  ramps: [
    RAMP(-512, 0, 1240, -512, 256, 384, 256, 'concrete'),     // T ramp up to the lobby
    RAMP(1060, 0, -1024, 512, 256, -1024, 128, 'metal'),       // outside -> heaven catwalk
  ],
  columns: [
    { pos: [1350, -350], r: 110, h: 640, mat: 'metal' }, { pos: [1350, -700], r: 110, h: 640, mat: 'metal' },
  ],
  water: [],
  ladders: [{ min: [136, 0, -1040], max: [216, 264, -1024], normal: [0, -1] }],
  lights: [
    [-384, 200, -704, 1.6e6, 'f4f6ff'], [-700, 200, -1000, 1e6, 'f4f6ff'],
    [-384, 450, -704, 1.8e6, 'f4f6ff'], [-384, 420, 60, 1.2e6, 'fff4e0'],
    [-1344, 140, -500, 6e5, 'fff4e0'], [-1344, 140, 100, 6e5, 'fff4e0'], [384, 140, -640, 5e5, 'fff4e0'],
  ],
  indoorFloor: 'concrete',
  coverZones: [[600, -1400, 1500, 1100]],
  coverCount: 6,
  coverSeed: 0x7E7E,
  spawns: { [TEAM.T]: [...cluster(-200, 1600), ...cluster(200, 1600)], [TEAM.CT]: [...cluster(800, -1720), ...cluster(1200, -1720)] },
  bombsites: { A: [-380, 256, -600], B: [-380, 0, -640] },
};

// ------------------------------------------------------------------ de_aq_train
//
// A rail yard. Bombsite A sits between parked trains in the middle of the
// yard; you fight around, between and ON the boxcars (ladders at the car
// ends, 176 u roofs). Ts come in from the west through ivy or the upper
// route, or take the long roofed tunnel south to B, a siding with two more
// cars. CTs come from the east into the yard, or down to B.

const TR = 176;                          // boxcar height
const trBounds = { x0: -2304, z0: -2304, x1: 2304, z1: 2304 };
const trAreas = [
  [-2240, -1120, -1700, 1280],           // T spawn
  [-1700, -400, -900, 400],              // ivy
  [-1700, -1120, -900, -640],            // T upper
  [-900, -1120, 1100, 700],              // the yard (A)
  [1100, -800, 1400, 400],               // CT -> yard
  [1400, -1280, 2240, 800],              // CT spawn
  [-1700, 960, 300, 1200, 0, 160],       // the tunnel to B (roofed)
  [300, 900, 1400, 1800],                // B siding
  [1400, 800, 1700, 1100],               // CT -> B
  [300, 700, 500, 900],                  // yard -> B connector
];
// a boxcar: x centre, z centre, length (along x)
const car = (x, z, len, mat = 'container') => W(x, TR / 2, z, len, TR, 128, mat);
const rails = (x, z, len) => [W(x, 1, z - 40, len, 2, 8, 'metal'), W(x, 1, z + 40, len, 2, 8, 'metal')];

export const train = {
  id: 'de_aq_train',
  name: 'de_aq_train',
  bounds: trBounds,
  palette: {
    floor: hex(0.4, 0.37, 0.33), wall: hex(0.5, 0.45, 0.4), concrete: hex(0.6, 0.6, 0.58),
    container: hex(0.3, 0.42, 0.55), rust: hex(0.55, 0.3, 0.2), metal: hex(0.4, 0.4, 0.42),
    cover: hex(0.45, 0.30, 0.17), accent: hex(0.5, 0.48, 0.45), wood: hex(0.45, 0.33, 0.22),
  },
  sky: { top: hex(0.5, 0.58, 0.68), horizon: hex(0.82, 0.8, 0.76) },
  fog: { color: hex(0.74, 0.73, 0.7), density: 0.0002 },
  ambient: 0.75, sun: 0.95,
  boxes: [
    G(0, 0, 4608, 4608, 'floor'),
    ...carve({ bounds: trBounds, areas: trAreas, wallH: 320, roofMat: 'concrete', floorMat: 'concrete' }),
    ...rails(100, -760, 2000), ...rails(100, -420, 2000), ...rails(100, 80, 2000), ...rails(100, 420, 2000),
    ...rails(850, 1100, 1100), ...rails(850, 1550, 1100),
    // the yard's trains (a gap between each pair of cars)
    car(-420, -760, 512), car(220, -760, 512, 'rust'),
    car(-100, -420, 640, 'rust'), car(620, -420, 512),
    car(-500, 80, 640), car(200, 80, 512, 'rust'),
    car(-200, 420, 640, 'rust'),
    // B siding
    car(850, 1100, 640), car(750, 1550, 512, 'rust'),
    // crates, a signal box
    W(150, 32, -170, 64, 64, 64, 'cover'), W(-700, 32, -250, 128, 64, 64, 'cover'), W(800, 32, 250, 64, 64, 128, 'cover'),
    W(1000, 32, 1330, 64, 64, 64, 'cover'), W(500, 32, 1330, 128, 64, 64, 'cover'),
    W(-1300, 64, 0, 192, 128, 192, 'concrete'), W(1250, 32, -600, 64, 64, 64, 'cover'),
  ],
  ramps: [],
  columns: [],
  water: [],
  // ladders on the car ends
  ladders: [
    { min: [-836, 0, 40], max: [-820, TR + 8, 120], normal: [-1, 0] },
    { min: [476, 0, -800], max: [492, TR + 8, -720], normal: [1, 0] },
    { min: [876, 0, -460], max: [892, TR + 8, -380], normal: [1, 0] },
    { min: [1170, 0, 1060], max: [1186, TR + 8, 1140], normal: [1, 0] },
  ],
  lights: [[-700, 140, 1080, 6e5, 'fff0d0'], [-100, 140, 1080, 6e5, 'fff0d0']],
  coverZones: [[-850, -1050, 1050, 650]],
  coverCount: 6,
  coverSeed: 0x7A11,
  spawns: { [TEAM.T]: [...cluster(-1970, 100), ...cluster(-1970, 500)], [TEAM.CT]: [...cluster(1820, -300), ...cluster(1820, 100)] },
  bombsites: { A: [150, 0, -170], B: [800, 0, 1330] },
};

export const CLASSIC_MAPS = [dust2, nuke, train];
