// CS 1.6 reference values (see CS16_REFERENCE.md). Units are Half-Life units
// (~1 u = 1 inch); the maps are authored on the 64 u grid, matching this scale.
//
// These numbers drive BOTH the client-side predicted movement and the server's
// authoritative hit resolution, so they must live in one shared place.

export const TICK_RATE = 30; // server simulation + state broadcast, Hz
export const SNAPSHOT_RATE = 20; // state snapshots sent to clients, Hz

export const PLAYER = {
  halfWidth: 16,      // x/z half-extent  -> 32 u wide
  standHeight: 72,    // standing height
  crouchHeight: 36,   // crouched height (movement hull)
  crouchHitHeight: 52, // crouched HIT box: the model's head is higher than the hull
  standEye: 64,       // eye offset from feet, standing
  crouchEye: 34,      // eye offset from feet, crouched
  stepHeight: 20,     // auto step-up (CS 1.6 ~18 u)
  maxHp: 100,
};

export const MOVE = {
  gravity: 800,        // u/s^2 (HL1 sv_gravity)
  jumpVelocity: 270,   // u/s upward
  runSpeed: 250,       // u/s max ground speed
  walkSpeed: 75,       // u/s with +speed (Shift)
  crouchSpeedMul: 0.4, // fraction of run speed while crouched (~100 u/s)
  friction: 4,         // ground friction (HL1 sv_friction)
  stopSpeed: 100,      // below this, friction is stronger
  accelerate: 10,      // ground acceleration (HL1 sv_accelerate)
  airAccelerate: 0.7,  // air acceleration (HL1 sv_airaccelerate; low = commit to jumps)
  airSpeedCap: 30,     // extra speed you can add in the air
};

// Weapons: straight from CS16_REFERENCE.md §2/§3.
// damageHead already includes the ~3x headshot multiplier. Damage falls off
// linearly between rangeMod and maxRange, then is flat (0 for the knife).
export const WEAPONS = {
  knife:  { name: 'Knife',        price: 0,    dmgBody: 20,  dmgHead: 60,  dmgLegs: 14, dmgArms: 14,
            rangeMod: 128,  maxRange: 256,  rof: 0.40, mag: 1,  reload: 0.0,
            cone: 0.0, maxCone: 0.0, auto: false, zoomFov: 0, zoomTime: 0, melee: true,
            slot: 'melee', team: 0, reserve: 0 },
  glock:  { name: 'Glock-18',     price: 400,  dmgBody: 20,  dmgHead: 50,  dmgLegs: 11, dmgArms: 14,
            rangeMod: 1500, maxRange: 2000, rof: 0.16, mag: 20, reload: 2.5,
            cone: 1.50, maxCone: 6.50, auto: false, zoomFov: 0, zoomTime: 0,
            slot: 'secondary', team: 0, reserve: 120 },
  usp:    { name: 'USP .45',      price: 500,  dmgBody: 23,  dmgHead: 56,  dmgLegs: 13, dmgArms: 16,
            rangeMod: 1500, maxRange: 2000, rof: 0.18, mag: 12, reload: 2.3,
            cone: 1.40, maxCone: 5.75, auto: false, zoomFov: 0, zoomTime: 0,
            slot: 'secondary', team: 0, reserve: 100 },
  deagle: { name: 'Desert Eagle', price: 650,  dmgBody: 47,  dmgHead: 233, dmgLegs: 30, dmgArms: 33,
            rangeMod: 1870, maxRange: 2200, rof: 0.21, mag: 7,  reload: 2.2,
            cone: 0.50, maxCone: 4.00, auto: false, zoomFov: 0, zoomTime: 0,
            slot: 'secondary', team: 0, reserve: 35 },
  mp5:    { name: 'MP5-Navy',     price: 1500, dmgBody: 23,  dmgHead: 56,  dmgLegs: 13, dmgArms: 16,
            rangeMod: 1440, maxRange: 1800, rof: 0.09, mag: 30, reload: 2.5,
            cone: 1.85, maxCone: 5.50, auto: true,  zoomFov: 0, zoomTime: 0,
            slot: 'primary', team: 0, reserve: 120 },
  ak47:   { name: 'AK-47',        price: 2500, dmgBody: 31,  dmgHead: 96,  dmgLegs: 18, dmgArms: 22,
            rangeMod: 1716, maxRange: 2200, rof: 0.10, mag: 30, reload: 2.5,
            cone: 0.75, maxCone: 6.30, auto: true,  zoomFov: 0, zoomTime: 0,
            slot: 'primary', team: 1, reserve: 90 },
  m4a1:   { name: 'M4A1',         price: 3100, dmgBody: 28,  dmgHead: 84,  dmgLegs: 16, dmgArms: 20,
            rangeMod: 1716, maxRange: 2200, rof: 0.09, mag: 30, reload: 3.0,
            cone: 0.55, maxCone: 5.10, auto: true,  zoomFov: 0, zoomTime: 0,
            slot: 'primary', team: 2, reserve: 90 },
  awp:    { name: 'AWP',          price: 4750, dmgBody: 115, dmgHead: 437, dmgLegs: 55, dmgArms: 81,
            rangeMod: 4500, maxRange: 4500, rof: 1.50, mag: 10, reload: 3.0,
            cone: 0.20, maxCone: 0.20, auto: false, zoomFov: 40, zoomFov2: 10, zoomTime: 1.5,
            slot: 'primary', team: 0, reserve: 30 },
  scout:  { name: 'Scout',        price: 1700, dmgBody: 75,  dmgHead: 188, dmgLegs: 28, dmgArms: 53,
            rangeMod: 2850, maxRange: 3000, rof: 1.35, mag: 10, reload: 3.0,
            cone: 0.30, maxCone: 0.30, auto: false, zoomFov: 40, zoomFov2: 15, zoomTime: 1.0,
            slot: 'primary', team: 0, reserve: 90 },
};

// Loadouts (M2). `team` on a weapon is 0 (both), TEAM.T (1) or TEAM.CT (2).
// Everyone spawns with a knife and their side's pistol; primaries are bought.
export const DEFAULT_PISTOL = { 1: 'glock', 2: 'usp' };
export const SLOTS = ['primary', 'secondary', 'melee']; // keys 1, 2, 3
export const DRAW_TIME = 0.35;       // s after switching before the first shot
export const MELEE_REACH = 72;       // u, knife hit distance
export const NOSCOPE_CONE = 8.0;     // deg, sniper fired without the scope up

// Cone grows per shot toward maxCone over the first 10 shots; recovery only
// once fire stops (CS 1.6 discrete recoil model).
export const CONE_SHOTS_TO_MAX = 10;
export const CONE_RECOVERY_PER_SEC = 2.5;
export const AIR_CONE_MUL = 3.0;
export const RUN_CONE_MUL = 2.0;

// Round structure (CS 1.6 defaults).
export const ROUND = {
  buyTime: 15,
  roundTime: 115,
  roundEndTime: 5,
  roundsToWin: 8,
  maxRounds: 30,
};

// Bullet penetration multiplier by material class.
export const PENETRATION = { wood: 0.7, metal: 0.5, stone: 0.0, default: 0.0 };

// Team ids.
export const TEAM = { T: 1, CT: 2 };
