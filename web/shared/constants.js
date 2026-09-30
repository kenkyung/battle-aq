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
  // view offsets as cstrike's pm_shared: origin at the hull centre, VEC_VIEW
  // 17 above it standing (36 + 17), VEC_DUCK_VIEW 12 above the duck hull's
  // centre (18 + 12)
  standEye: 53,       // eye offset from feet, standing
  crouchEye: 30,      // eye offset from feet, crouched
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
  timeToDuck: 0.4,        // TIME_TO_DUCK: on the ground the hull only shrinks after this
  duckLift: 18,           // hull half-height difference: ducking in the air lifts the feet by it
  edgeFriction: 2,        // sv_edgefriction: friction x2 when the ground ends 16 u ahead
  climbSpeed: 200,        // MAX_CLIMB_SPEED on ladders
  ladderJump: 270,        // push off a ladder when jumping from it
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
  // knife: slash (fire) 15 dmg, 48 u; stab (right click) 65 dmg, 32 u, x3 from behind
  knife:  { name: 'Knife', price: 0, dmg: 15, rangeMod: 1, armorRatio: 1.0, rof: 0.4, mag: 1, reserve: 0, reload: 0,
            speed: 250, auto: false, melee: true, slot: 'melee', team: 0, reach: 48,
            alt: 'stab', modes: { stab: { dmg: 65, reach: 32, rof: 1.1, backstab: 3 } } },
  glock:  { name: 'Glock-18', price: 400, dmg: 25, rangeMod: 0.75, armorRatio: 1.05, rof: 0.2, mag: 20, reserve: 120, reload: 2.2,
            speed: 250, auto: false, slot: 'secondary', team: 0,
            acc: { type: 'pistol', start: 0.9, min: 0.6, k: 0.275, t: 0.325 },
            spread: { air: [0, 1.0], move: [0, 0, 0.165], duck: [0, 0.075], stand: [0, 0.1] }, punch: 2,
            alt: 'burst', modes: { burst: { spread: { air: [0, 1.2], move: [0, 0, 0.185], duck: [0, 0.095], stand: [0, 0.3] }, gap: 0.1, cycle: 0.5, count: 3 } } },
  usp:    { name: 'USP .45', price: 500, dmg: 34, rangeMod: 0.79, armorRatio: 1.0, rof: 0.15, mag: 12, reserve: 100, reload: 2.7,
            speed: 250, auto: false, slot: 'secondary', team: 0,
            acc: { type: 'pistol', start: 0.92, min: 0.6, k: 0.275, t: 0.3 },
            spread: { air: [0, 1.2], move: [0, 0, 0.225], duck: [0, 0.08], stand: [0, 0.1] }, punch: 2,
            alt: 'silencer', silencerTime: 3.1, modes: { silenced: { dmg: 30, spread: { air: [0, 1.3], move: [0, 0, 0.25], duck: [0, 0.125], stand: [0, 0.15] } } } },
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
                    duck: [0.6, 0.3, 0.2, 0.0125, 3.25, 2, 7], stand: [0.65, 0.35, 0.25, 0.015, 3.5, 2.25, 7] },
            alt: 'silencer', silencerTime: 2.0, modes: { silenced: { dmg: 33, rangeMod: 0.95 } } },
  m249:   { name: 'M249 Para', price: 5750, dmg: 32, rangeMod: 0.97, armorRatio: 1.6, rof: 0.1, mag: 100, reserve: 200, reload: 4.7,
            speed: 220, auto: true, slot: 'primary', team: 0,
            acc: { type: 'auto', div: 175, exp: 3, base: 0.4, max: 0.9 },
            spread: { air: [0.045, 0.5], move: [140, 0.045, 0.095], duck: [0, 0.03], stand: [0, 0.03] },
            kick: { move: [1.1, 0.5, 0.3, 0.06, 4, 3, 8], air: [1.8, 0.65, 0.45, 0.125, 5, 3.5, 8],
                    duck: [0.75, 0.325, 0.25, 0.025, 3.5, 2.5, 9], stand: [0.8, 0.35, 0.3, 0.03, 3.75, 3, 9] } },
  scout:  { name: 'Scout', price: 2750, dmg: 75, rangeMod: 0.98, armorRatio: 1.7, rof: 1.25, mag: 10, reserve: 90, reload: 2.0,
            speed: 260, zoomSpeed: 220, deploy: 1.25, auto: false, slot: 'primary', team: 0, zoomFov: 40, zoomFov2: 15,
            spread: { air: [0.2, 0], move: [170, 0.075, 0], duck: [0, 0], stand: [0.007, 0] }, unscoped: 0.025, punch: 2 },
  awp:    { name: 'AWP', price: 4750, dmg: 115, rangeMod: 0.99, armorRatio: 1.95, rof: 1.45, mag: 10, reserve: 30, reload: 2.9,
            speed: 210, zoomSpeed: 150, deploy: 1.45, auto: false, slot: 'primary', team: 0, zoomFov: 40, zoomFov2: 10,
            spread: { air: [0.85, 0], move: [140, 0.25, 0], duck: [0, 0], stand: [0.001, 0] }, unscoped: 0.08, punch: 2 },
  // ---- the rest of the CS 1.6 arsenal (cstrike / ReGameDLL weapon code)
  p228:   { name: 'P228', price: 600, dmg: 32, rangeMod: 0.8, armorRatio: 1.25, rof: 0.2, mag: 13, reserve: 52, reload: 2.7,
            speed: 250, auto: false, slot: 'secondary', team: 0,
            acc: { type: 'pistol', start: 0.9, min: 0.6, k: 0.3, t: 0.325 },
            spread: { air: [0, 1.5], move: [0, 0, 0.255], duck: [0, 0.075], stand: [0, 0.15] }, punch: 2 },
  fiveseven: { name: 'Five-SeveN', price: 750, dmg: 20, rangeMod: 0.885, armorRatio: 1.5, rof: 0.15, mag: 20, reserve: 100, reload: 2.7,
            speed: 250, auto: false, slot: 'secondary', team: 2,
            acc: { type: 'pistol', start: 0.92, min: 0.725, k: 0.25, t: 0.275 },
            spread: { air: [0, 1.5], move: [0, 0, 0.255], duck: [0, 0.075], stand: [0, 0.15] }, punch: 2 },
  elites: { name: 'Dual Berettas', price: 800, dmg: 36, rangeMod: 0.75, armorRatio: 1.05, rof: 0.12, mag: 30, reserve: 120, reload: 4.5,
            speed: 250, auto: false, slot: 'secondary', team: 1,
            acc: { type: 'pistol', start: 0.88, min: 0.55, k: 0.275, t: 0.325 },
            spread: { air: [0, 1.3], move: [0, 0, 0.175], duck: [0, 0.08], stand: [0, 0.1] }, punch: 2 },
  m3:     { name: 'M3 Super 90', price: 1700, dmg: 20, rangeMod: 1, armorRatio: 1.0, rof: 0.875, mag: 8, reserve: 32, reload: 0,
            speed: 230, auto: false, slot: 'primary', team: 0, cls: 'shotgun',
            pellets: 9, pelletSpread: 0.0675, range: 3000, shell: { start: 0.55, each: 0.45 },
            punchRand: { ground: [4, 6], air: [8, 11] } },
  xm1014: { name: 'XM1014', price: 3000, dmg: 20, rangeMod: 1, armorRatio: 1.0, rof: 0.25, mag: 7, reserve: 32, reload: 0,
            speed: 240, auto: false, slot: 'primary', team: 0, cls: 'shotgun',
            pellets: 6, pelletSpread: 0.0725, range: 3048, shell: { start: 0.55, each: 0.3 },
            punchRand: { ground: [3, 5], air: [7, 10] } },
  tmp:    { name: 'TMP', price: 1250, dmg: 20, rangeMod: 0.85, armorRatio: 1.0, rof: 0.07, mag: 30, reserve: 120, reload: 2.12,
            speed: 250, auto: true, slot: 'primary', team: 2, cls: 'smg',
            acc: { type: 'auto', div: 200, exp: 2, base: 0.55, max: 1.4 },
            spread: { air: [0, 0.25], move: [140, 0, 0.03], duck: [0, 0.03], stand: [0, 0.03] },
            kick: { move: [0.8, 0.4, 0.2, 0.03, 3, 2.5, 7], air: [1.1, 0.5, 0.35, 0.045, 4.5, 3.5, 6],
                    duck: [0.7, 0.35, 0.125, 0.025, 2.5, 2, 10], stand: [0.725, 0.375, 0.175, 0.03, 2.75, 2.25, 9] } },
  mac10:  { name: 'MAC-10', price: 1400, dmg: 29, rangeMod: 0.82, armorRatio: 0.95, rof: 0.07, mag: 30, reserve: 100, reload: 3.15,
            speed: 250, auto: true, slot: 'primary', team: 1, cls: 'smg',
            acc: { type: 'auto', div: 200, exp: 2, base: 0.6, max: 1.65 },
            spread: { air: [0, 0.375], move: [140, 0, 0.03], duck: [0, 0.03], stand: [0, 0.03] },
            kick: { move: [0.9, 0.45, 0.25, 0.035, 3.5, 2.75, 7], air: [1.3, 0.55, 0.4, 0.05, 4.75, 3.75, 5],
                    duck: [0.75, 0.4, 0.175, 0.03, 2.75, 2.5, 10], stand: [0.775, 0.425, 0.2, 0.03, 3, 2.75, 9] } },
  p90:    { name: 'P90', price: 2350, dmg: 21, rangeMod: 0.885, armorRatio: 1.5, rof: 0.066, mag: 50, reserve: 100, reload: 3.4,
            speed: 245, auto: true, slot: 'primary', team: 0, cls: 'smg',
            acc: { type: 'auto', div: 175, exp: 2, base: 0.45, max: 1.0 },
            spread: { air: [0, 0.3], move: [170, 0, 0.115], duck: [0, 0.045], stand: [0, 0.045] },
            kick: { move: [0.45, 0.3, 0.2, 0.0275, 4, 2.25, 7], air: [0.9, 0.35, 0.15, 0.025, 5.5, 1.5, 2],
                    duck: [0.275, 0.2, 0.125, 0.02, 3, 1, 9], stand: [0.3, 0.225, 0.125, 0.02, 3.25, 1.25, 8] } },
  galil:  { name: 'Galil', price: 2000, dmg: 30, rangeMod: 0.98, armorRatio: 1.55, rof: 0.0875, mag: 35, reserve: 90, reload: 2.45,
            speed: 240, auto: true, slot: 'primary', team: 1,
            acc: { type: 'auto', div: 200, exp: 3, base: 0.35, max: 1.25 },
            spread: { air: [0.04, 0.3], move: [140, 0.04, 0.07], duck: [0, 0.0375], stand: [0, 0.0375] },
            kick: { move: [1.0, 0.45, 0.28, 0.045, 3.75, 3, 7], air: [1.2, 0.5, 0.23, 0.15, 5.5, 3.5, 6],
                    duck: [0.6, 0.3, 0.2, 0.0125, 3.25, 2, 7], stand: [0.65, 0.35, 0.25, 0.015, 3.5, 2.25, 7] } },
  famas:  { name: 'FAMAS', price: 2250, dmg: 30, rangeMod: 0.96, armorRatio: 1.4, rof: 0.0825, mag: 25, reserve: 90, reload: 3.3,
            speed: 240, auto: true, slot: 'primary', team: 2,
            acc: { type: 'auto', div: 215, exp: 3, base: 0.3, max: 1.0 },
            spread: { air: [0.03, 0.3], move: [140, 0.03, 0.07], duck: [0, 0.02], stand: [0, 0.02] },
            kick: { move: [1.0, 0.45, 0.275, 0.05, 4, 2.5, 7], air: [1.25, 0.45, 0.22, 0.18, 5.5, 4, 5],
                    duck: [0.575, 0.325, 0.2, 0.011, 3.25, 2, 8], stand: [0.625, 0.375, 0.25, 0.0125, 3.5, 2.25, 8] },
            alt: 'burst', modes: { burst: { spreadAdd: 0.01, gap: 0.075, cycle: 0.55, count: 3 } } },
  aug:    { name: 'AUG', price: 3500, dmg: 32, rangeMod: 0.96, armorRatio: 1.4, rof: 0.0825, zoomRof: 0.135, mag: 30, reserve: 90, reload: 3.3,
            speed: 240, auto: true, slot: 'primary', team: 2, zoomFov: 55, zoomLevels: 1,
            acc: { type: 'auto', div: 215, exp: 3, base: 0.3, max: 1.0 },
            spread: { air: [0.035, 0.4], move: [140, 0.035, 0.07], duck: [0, 0.02], stand: [0, 0.02] },
            kick: { move: [1.0, 0.45, 0.275, 0.05, 4, 2.5, 7], air: [1.25, 0.45, 0.22, 0.18, 5.5, 4, 5],
                    duck: [0.575, 0.325, 0.2, 0.011, 3.25, 2, 8], stand: [0.625, 0.375, 0.25, 0.0125, 3.5, 2.25, 8] } },
  sg552:  { name: 'SG 552', price: 3500, dmg: 33, rangeMod: 0.955, armorRatio: 1.4, rof: 0.0825, zoomRof: 0.135, mag: 30, reserve: 90, reload: 3.0,
            speed: 235, zoomSpeed: 200, auto: true, slot: 'primary', team: 1, zoomFov: 55, zoomLevels: 1,
            acc: { type: 'auto', div: 220, exp: 3, base: 0.3, max: 1.0 },
            spread: { air: [0.035, 0.45], move: [140, 0.035, 0.075], duck: [0, 0.02], stand: [0, 0.02] },
            kick: { move: [1.0, 0.45, 0.28, 0.04, 4.25, 2.5, 7], air: [1.25, 0.45, 0.22, 0.18, 6, 4, 5],
                    duck: [0.6, 0.35, 0.2, 0.0125, 3.7, 2, 10], stand: [0.625, 0.375, 0.25, 0.0125, 4, 2.25, 9] } },
  sg550:  { name: 'SG 550', price: 4200, dmg: 70, rangeMod: 0.98, armorRatio: 1.45, rof: 0.25, mag: 30, reserve: 90, reload: 3.35,
            speed: 210, zoomSpeed: 150, auto: false, slot: 'primary', team: 2, zoomFov: 40, zoomFov2: 15, autoSniper: true,
            acc: { type: 'autosniper', base: 0.65, k: 0.35 },
            spread: { air: [0.45], move: [0, 0.15], duck: [0.04], stand: [0.05] }, unscoped: 0.025,
            punchRand: { up: [0.75, 1.25], lat: 0.75 } },
  g3sg1:  { name: 'G3/SG-1', price: 5000, dmg: 80, rangeMod: 0.98, armorRatio: 1.65, rof: 0.25, mag: 20, reserve: 90, reload: 3.5,
            speed: 210, zoomSpeed: 150, auto: false, slot: 'primary', team: 1, zoomFov: 40, zoomFov2: 15, autoSniper: true,
            acc: { type: 'autosniper', base: 0.55, k: 0.3 },
            spread: { air: [0.45], move: [0, 0.15], duck: [0.035], stand: [0.055] }, unscoped: 0.025,
            punchRand: { up: [0.75, 1.75], lat: 0.75 } },
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

// Classes, calibres and bullet penetration (cstrike FireBullets3). A calibre
// has a penetration power (u of wood it goes through, less for harder
// materials) and a range after which it stops penetrating; a weapon sets how
// many surfaces its bullet may pass.
const CLASS = {
  glock: 'pistol', usp: 'pistol', deagle: 'pistol', p228: 'pistol', fiveseven: 'pistol', elites: 'pistol',
  mp5: 'smg', ump45: 'smg', tmp: 'smg', mac10: 'smg', p90: 'smg', m3: 'shotgun', xm1014: 'shotgun',
  ak47: 'rifle', m4a1: 'rifle', galil: 'rifle', famas: 'rifle', aug: 'rifle', sg552: 'rifle',
  scout: 'sniper', awp: 'sniper', sg550: 'sniper', g3sg1: 'sniper', m249: 'mg',
};
export const BULLETS = {
  '9mm': [21, 800], '45acp': [15, 500], '50ae': [30, 1000], '357sig': [25, 800], '57mm': [30, 2000],
  '556nato': [35, 4000], '556natobox': [35, 4000], '762nato': [39, 5000], '338magnum': [45, 8000], buckshot: [0, 0],
};
const CALIBER = {
  glock: '9mm', mp5: '9mm', tmp: '9mm', elites: '9mm', usp: '45acp', ump45: '45acp', mac10: '45acp', deagle: '50ae',
  p228: '357sig', fiveseven: '57mm', p90: '57mm', m4a1: '556nato', famas: '556nato', galil: '556nato', sg552: '556nato',
  aug: '556nato', sg550: '556nato', m249: '556natobox', ak47: '762nato', scout: '762nato', g3sg1: '762nato', awp: '338magnum',
  m3: 'buckshot', xm1014: 'buckshot',
};
const PENETRATE = { ak47: 2, m4a1: 2, galil: 2, famas: 2, aug: 2, sg552: 2, sg550: 2, m249: 2, deagle: 2, awp: 3, scout: 3, g3sg1: 3 };
for (const [id, w] of Object.entries(WEAPONS)) {
  if (CLASS[id]) { w.cls = w.cls || CLASS[id]; w.caliber = CALIBER[id]; w.pen = CALIBER[id] === 'buckshot' ? 0 : (PENETRATE[id] || 1); }
}

// Weapon stats in a mode (silenced / burst / stab): the mode's overrides on top.
export function weaponStats(id, mode) {
  const w = WEAPONS[id];
  if (!w || !mode || !w.modes || !w.modes[mode]) return w;
  return { ...w, ...w.modes[mode], mode };
}

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
export const DRAW_TIME = 0.75;       // s after switching before the first shot (CS DefaultDeploy; AWP / Scout longer)
export const MELEE_REACH = 72;       // u, knife hit distance
export const NOSCOPE_CONE = 8.0;     // deg, sniper fired without the scope up

// CS 1.6 dynamic crosshair (cl_dll ammo.cpp): base gap and how much each
// shot pushes it out, per weapon. The HUD scales these to the screen.
export const CROSSHAIR = {
  p228: [8, 3], fiveseven: [8, 3], elites: [8, 3], m3: [8, 6], xm1014: [8, 6], tmp: [7, 3], mac10: [9, 3], p90: [7, 2],
  galil: [4, 4], famas: [4, 4], aug: [3, 3], sg552: [5, 3], sg550: [5, 4], g3sg1: [6, 4],
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
