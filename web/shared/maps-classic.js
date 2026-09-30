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

export const CLASSIC_MAPS = [dust2];
