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
  stepHeight: 18,     // auto step-up (CS 1.6 sv_stepsize 18)
  maxHp: 100,
};

// CS 1.6 player movement (pm_shared.c + cstrike server defaults).
export const MOVE = {
  gravity: 800,           // sv_gravity
  jumpVelocity: 268.3,    // sqrt(2 * 800 * 45): a 45 u jump
  runSpeed: 250,          // knife / pistols; heavier guns lower it (WEAPONS.speed)
  walkSpeed: 130,         // +speed (Shift) = 0.52 x run speed
  crouchSpeedMul: 0.333,  // ducked
  friction: 4,            // sv_friction
  stopSpeed: 75,          // sv_stopspeed
  accelerate: 5,          // sv_accelerate
  airAccelerate: 10,      // sv_airaccelerate
  airSpeedCap: 30,        // wishspeed cap in the air (what makes air-strafing work)
  jumpFatigue: 1.315,     // s after landing during which a jump is slowed (anti bunny-hop)
  fallSafe: 580,          // fall speed above which you take damage
  fallFatal: 1024,        // fall speed that kills
};

// Weapons: CS 1.6 values (HLSDK / CS 1.6 weapon code, cstrike 1.6).
//   dmg        base damage per bullet (x hit-group multiplier, see HITGROUP)
//   rangeMod   damage *= rangeMod ^ (distance / 500)
//   armorRatio armour penetration: with kevlar, HP damage = dmg * 0.5 * armorRatio
//   speed      max run speed while holding it (u/s)
//   acc        accuracy model: auto rifles grow inaccuracy with shots fired,
//              pistols recover it with time between shots
//   spread     { air, move:[threshold, a, b], duck, stand } -> a + b * accuracy
//   kick       KickBack(up_base, lat_base, up_mod, lat_mod, up_max, lat_max, dir_change)
//              per stance; pistols/snipers use a single upward punch instead
export const WEAPONS = {
  knife:  { name: 'Knife', price: 0, dmg: 15, rangeMod: 1, armorRatio: 1.0, rof: 0.4, mag: 1, reserve: 0, reload: 0,
            speed: 250, auto: false, melee: true, slot: 'melee', team: 0 },
  glock:  { name: 'Glock-18', price: 400, dmg: 25, rangeMod: 0.75, armorRatio: 1.05, rof: 0.2, mag: 20, reserve: 120, reload: 2.2,
            speed: 250, auto: false, slot: 'secondary', team: 0,
            acc: { type: 'pistol', start: 0.9, min: 0.6, k: 0.275, t: 0.325 },
            spread: { air: [0, 1.0], move: [0, 0, 0.165], duck: [0, 0.075], stand: [0, 0.1] }, punch: 2 },
  usp:    { name: 'USP .45', price: 500, dmg: 34, rangeMod: 0.79, armorRatio: 1.0, rof: 0.15, mag: 12, reserve: 100, reload: 2.7,
            speed: 250, auto: false, slot: 'secondary', team: 0,
            acc: { type: 'pistol', start: 0.92, min: 0.6, k: 0.275, t: 0.3 },
            spread: { air: [0, 1.2], move: [0, 0, 0.225], duck: [0, 0.08], stand: [0, 0.1] }, punch: 2 },
  deagle: { name: 'Desert Eagle', price: 650, dmg: 54, rangeMod: 0.81, armorRatio: 1.5, rof: 0.225, mag: 7, reserve: 35, reload: 2.2,
            speed: 250, auto: false, slot: 'secondary', team: 0,
            acc: { type: 'pistol', start: 0.9, min: 0.55, k: 0.35, t: 0.4 },
            spread: { air: [0, 1.5], move: [0, 0, 0.25], duck: [0, 0.115], stand: [0, 0.13] }, punch: 2 },
  mp5:    { name: 'MP5-Navy', price: 1500, dmg: 26, rangeMod: 0.84, armorRatio: 1.2, rof: 0.075, mag: 30, reserve: 120, reload: 2.63,
            speed: 250, auto: true, slot: 'primary', team: 0,
            acc: { type: 'auto', div: 220.1, exp: 2, base: 0.45, max: 0.75 },
            spread: { air: [0, 0.2], move: [140, 0, 0.04], duck: [0, 0.04], stand: [0, 0.04] },
            kick: { move: [0.5, 0.275, 0.2, 0.03, 3, 2, 10], air: [0.9, 0.475, 0.35, 0.0425, 5, 3, 6],
                    duck: [0.225, 0.15, 0.1, 0.015, 2, 1, 10], stand: [0.25, 0.175, 0.125, 0.02, 2.25, 1.25, 10] } },
  ump45:  { name: 'UMP45', price: 1700, dmg: 30, rangeMod: 0.82, armorRatio: 1.0, rof: 0.1, mag: 25, reserve: 100, reload: 3.5,
            speed: 250, auto: true, slot: 'primary', team: 0,
            acc: { type: 'auto', div: 210, exp: 2, base: 0.5, max: 1.0 },
            spread: { air: [0, 0.24], move: [140, 0, 0.04], duck: [0, 0.04], stand: [0, 0.04] },
            kick: { move: [0.55, 0.3, 0.225, 0.03, 3.5, 2.5, 10], air: [0.125, 0.65, 0.55, 0.0475, 5.5, 4, 10],
                    duck: [0.25, 0.175, 0.125, 0.02, 2.25, 1.25, 10], stand: [0.275, 0.2, 0.15, 0.0225, 2.5, 1.5, 10] } },
  ak47:   { name: 'AK-47', price: 2500, dmg: 36, rangeMod: 0.98, armorRatio: 1.55, rof: 0.0955, mag: 30, reserve: 90, reload: 2.45,
            speed: 221, auto: true, slot: 'primary', team: 1,
            acc: { type: 'auto', div: 200, exp: 3, base: 0.35, max: 1.25 },
            spread: { air: [0.04, 0.4], move: [140, 0.04, 0.07], duck: [0, 0.0275], stand: [0, 0.0275] },
            kick: { move: [1.5, 0.45, 0.225, 0.05, 6.5, 2.5, 7], air: [2.0, 1.0, 0.5, 0.35, 9, 6, 5],
                    duck: [0.9, 0.35, 0.15, 0.025, 5.5, 1.5, 9], stand: [1.0, 0.375, 0.175, 0.0375, 5.75, 1.75, 8] } },
  m4a1:   { name: 'M4A1', price: 3100, dmg: 32, rangeMod: 0.97, armorRatio: 1.4, rof: 0.0875, mag: 30, reserve: 90, reload: 3.05,
            speed: 230, auto: true, slot: 'primary', team: 2,
            acc: { type: 'auto', div: 220, exp: 3, base: 0.3, max: 1.0 },
            spread: { air: [0.035, 0.4], move: [140, 0.035, 0.07], duck: [0, 0.025], stand: [0, 0.025] },
            kick: { move: [1.0, 0.45, 0.28, 0.045, 3.75, 3, 7], air: [1.2, 0.5, 0.23, 0.15, 5.5, 3.5, 6],
                    duck: [0.6, 0.3, 0.2, 0.0125, 3.25, 2, 7], stand: [0.65, 0.35, 0.25, 0.015, 3.5, 2.25, 7] } },
  m249:   { name: 'M249 Para', price: 5750, dmg: 32, rangeMod: 0.97, armorRatio: 1.6, rof: 0.1, mag: 100, reserve: 200, reload: 4.7,
            speed: 220, auto: true, slot: 'primary', team: 0,
            acc: { type: 'auto', div: 175, exp: 3, base: 0.4, max: 0.9 },
            spread: { air: [0.045, 0.5], move: [140, 0.045, 0.095], duck: [0, 0.03], stand: [0, 0.03] },
            kick: { move: [1.1, 0.5, 0.3, 0.06, 4, 3, 8], air: [1.8, 0.65, 0.45, 0.125, 5, 3.5, 8],
                    duck: [0.75, 0.325, 0.25, 0.025, 3.5, 2.5, 9], stand: [0.8, 0.35, 0.3, 0.03, 3.75, 3, 9] } },
  scout:  { name: 'Scout', price: 2750, dmg: 75, rangeMod: 0.98, armorRatio: 1.7, rof: 1.25, mag: 10, reserve: 90, reload: 2.0,
            speed: 260, auto: false, slot: 'primary', team: 0, zoomFov: 40, zoomFov2: 15,
            spread: { air: [0.2, 0], move: [170, 0.075, 0], duck: [0, 0], stand: [0.007, 0] }, unscoped: 0.025, punch: 2 },
  awp:    { name: 'AWP', price: 4750, dmg: 115, rangeMod: 0.99, armorRatio: 1.95, rof: 1.45, mag: 10, reserve: 30, reload: 2.9,
            speed: 210, auto: false, slot: 'primary', team: 0, zoomFov: 40, zoomFov2: 10,
            spread: { air: [0.85, 0], move: [140, 0.25, 0], duck: [0, 0], stand: [0.001, 0] }, unscoped: 0.08, punch: 2 },
  // Grenades (slot 4): press to pull the pin, release to throw.
  hegrenade:    { name: 'HE Grenade', price: 300, dmg: 0, rangeMod: 1, armorRatio: 1, rof: 1.0, mag: 1, reserve: 0, reload: 0,
                  speed: 250, auto: false, grenade: true, max: 1, slot: 'grenade', team: 0 },
  flashbang:    { name: 'Flashbang', price: 200, dmg: 0, rangeMod: 1, armorRatio: 1, rof: 1.0, mag: 1, reserve: 0, reload: 0,
                  speed: 250, auto: false, grenade: true, max: 2, slot: 'grenade', team: 0 },
  smokegrenade: { name: 'Smoke Grenade', price: 300, dmg: 0, rangeMod: 1, armorRatio: 1, rof: 1.0, mag: 1, reserve: 0, reload: 0,
                  speed: 250, auto: false, grenade: true, max: 1, slot: 'grenade', team: 0 },
  // The bomb: selected like a weapon (5), "fired" by holding the trigger in
  // a bombsite, which plants it. Never bought.
  c4:     { name: 'C4 Explosive', price: 0, dmg: 0, rangeMod: 1, armorRatio: 1, rof: 0.2, mag: 1, reserve: 0, reload: 0,
            speed: 250, auto: true, bomb: true, slot: 'c4', team: 1 },
};

// CS 1.6 hit groups: damage multiplier and whether kevlar covers it.
// Arms count as chest. The helmet covers the head.
export const HITGROUP = {
  head:    { mul: 4.0,  armor: 'helmet' },
  chest:   { mul: 1.0,  armor: true },
  stomach: { mul: 1.25, armor: true },
  legs:    { mul: 0.75, armor: false },
};

export const START_WEAPON = 'glock';

// Loadouts (M2). `team` on a weapon is 0 (both), TEAM.T (1) or TEAM.CT (2).
// Everyone spawns with a knife and their side's pistol; primaries are bought.
export const DEFAULT_PISTOL = { 1: 'glock', 2: 'usp' };
export const SLOTS = ['primary', 'secondary', 'melee', 'grenade', 'c4']; // keys 1-5
export const DRAW_TIME = 0.35;       // s after switching before the first shot
export const MELEE_REACH = 72;       // u, knife hit distance
export const NOSCOPE_CONE = 8.0;     // deg, sniper fired without the scope up

// CS 1.6 dynamic crosshair (cl_dll ammo.cpp): base gap and how much each
// shot pushes it out, per weapon. The HUD scales these to the screen.
export const CROSSHAIR = {
  knife: [7, 3], glock: [8, 3], usp: [8, 3], deagle: [8, 3], mp5: [6, 2],
  ak47: [4, 4], m4a1: [4, 3], awp: [8, 3], scout: [5, 3], c4: [6, 3], ump45: [6, 3], m249: [6, 3], hegrenade: [7, 3], flashbang: [7, 3], smokegrenade: [7, 3],
};

// Cone grows per shot toward maxCone over the first 10 shots; recovery only
// once fire stops (CS 1.6 discrete recoil model).
export const CONE_SHOTS_TO_MAX = 10;
export const CONE_RECOVERY_PER_SEC = 2.5;
export const AIR_CONE_MUL = 3.0;
export const RUN_CONE_MUL = 2.0;

// Round structure (CS 1.6 defaults, shortened match: first to 8 of 15).
export const ROUND = {
  freezeTime: 6,        // s at round start: buy, but no moving
  roundTime: 150,       // 2:30
  roundEndTime: 5,      // s showing the result before the next round
  bombTime: 35,         // s from plant to explosion
  plantTime: 3,
  defuseTime: 10,
  defuseKitTime: 5,
  roundsToWin: 8,
  maxRounds: 15,
  halftimeAfter: 7,     // teams swap sides after this round
  voteTime: 15,         // map vote at match end
};

// Hostage rescue (cs_ maps).
export const HOSTAGE = {
  useReach: 72,        // u to press E on a hostage
  followGap: 72,       // how far behind their leader they walk
  speed: 230,          // u/s
  hp: 100,
  rescueRadius: 280,   // default rescue-zone radius
};

export const BOMB = {
  siteRadius: 240,      // u around a bombsite marker where C4 can be planted
  defuseReach: 72,      // u from the bomb to defuse it
  pickupReach: 48,      // u to pick up a dropped C4
  blastRadius: 900,     // u, damage falls off to 0 here
  blastDamage: 450,     // at ground zero (armour does not help against the blast)
};

// Bullet penetration multiplier by material class.
export const PENETRATION = { wood: 0.7, metal: 0.5, stone: 0.0, default: 0.0 };

// Team ids.
export const TEAM = { T: 1, CT: 2 };
