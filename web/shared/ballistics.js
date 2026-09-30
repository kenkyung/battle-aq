// CS 1.6 gun behaviour, shared by the server (authoritative spread + damage)
// and the client (view punch / spray pattern, predicted impacts).
//
// How CS 1.6 does it (HLSDK cstrike weapon code):
//  - Every shot adds "punch" to the view angles through KickBack(): a climb
//    that grows with the shots fired in the burst, plus a sideways drift that
//    flips direction at random (1 in dir_change). Bullets leave along
//    view + punch, so the punch IS the spray pattern; it decays back over time.
//  - On top, each bullet gets random spread: FireBullets3 offsets the direction
//    by spread * (U(-.5,.5) + U(-.5,.5)) along right and up. Spread depends on
//    stance (air / moving / crouched / standing) and on "accuracy", which for
//    automatics grows with shots fired (shots^n / div + base, capped) and for
//    pistols recovers with time between shots.
//  - Damage: base x hit group (head 4, stomach 1.25, legs 0.75) x
//    rangeMod ^ (distance / 500); kevlar lets through 0.5 x armorRatio.

import { WEAPONS, HITGROUP, PLAYER } from './constants.js';

// Per-shooter state (one per player, per weapon switch it resets).
export function newRecoil() {
  return { shots: 0, accuracy: 0.2, lastFire: -10, dir: 1, punch: [0, 0] };
}

export function resetRecoil(r, weaponId) {
  const w = WEAPONS[weaponId];
  r.shots = 0;
  r.accuracy = w && w.acc && w.acc.type === 'pistol' ? w.acc.start : 0.2;
  r.dir = 1;
}

function stanceOf({ onGround, speed, ducking }, threshold = 140) {
  if (!onGround) return 'air';
  if (speed > threshold) return 'move';
  if (ducking) return 'duck';
  return 'stand';
}

// Call once per shot BEFORE computing spread. Returns the spread (tangent
// units, as FireBullets3 uses) for this bullet.
export function shotSpread(r, weaponId, ctx) {
  const w = WEAPONS[weaponId];
  if (!w || w.melee || w.bomb) return 0;
  const now = ctx.now;
  const gap = now - r.lastFire;
  // letting go of the trigger bleeds off the burst (CS: one shot per 22.5 ms
  // once you stop firing), so taps are accurate and sprays are not
  if (gap > w.rof * 1.25) r.shots = Math.max(0, r.shots - Math.floor((gap - w.rof * 1.25) / 0.0225));
  r.shots++;
  if (w.acc && w.acc.type === 'auto') {
    r.accuracy = Math.min(w.acc.max, Math.pow(r.shots, w.acc.exp) / w.acc.div + w.acc.base);
  } else if (w.acc && w.acc.type === 'pistol') {
    // accuracy recovers the longer you wait between shots
    if (r.shots === 1 || gap > 1) r.accuracy = w.acc.start;
    else r.accuracy = Math.max(w.acc.min, Math.min(w.acc.start, r.accuracy - (w.acc.t - gap) * w.acc.k));
  }
  r.lastFire = now;
  const sp = w.spread;
  const st = stanceOf(ctx, sp.move[0] || 140);
  const pistol = w.acc && w.acc.type === 'pistol';
  let s;
  if (st === 'move') s = pistol ? sp.move[2] * (1 - r.accuracy) : sp.move[1] + sp.move[2] * r.accuracy;
  else {
    const [a, b] = sp[st];
    s = pistol ? b * (1 - r.accuracy) : a + b * (w.zoomFov ? 1 : r.accuracy);
  }
  if (w.zoomFov) s = sp[st === 'move' ? 'move' : st][st === 'move' ? 1 : 0] + (ctx.zoomed ? 0 : w.unscoped);
  return s;
}

// FireBullets3: offset the aim by the spread, two uniform samples per axis.
export function spreadDir(dir, spread, rand = Math.random) {
  if (!spread) return dir;
  const x = (rand() - 0.5) + (rand() - 0.5);
  const y = (rand() - 0.5) + (rand() - 0.5);
  const up0 = Math.abs(dir[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  let right = [dir[1] * up0[2] - dir[2] * up0[1], dir[2] * up0[0] - dir[0] * up0[2], dir[0] * up0[1] - dir[1] * up0[0]];
  let L = Math.hypot(...right); right = right.map((v) => v / L);
  let up = [right[1] * dir[2] - right[2] * dir[1], right[2] * dir[0] - right[0] * dir[2], right[0] * dir[1] - right[1] * dir[0]];
  L = Math.hypot(...up); up = up.map((v) => v / L);
  const d = [0, 1, 2].map((i) => dir[i] + x * spread * right[i] + y * spread * up[i]);
  L = Math.hypot(...d);
  return d.map((v) => v / L);
}

// KickBack: adds to r.punch (degrees; [0] = up, [1] = sideways).
export function kick(r, weaponId, ctx, rand = Math.random) {
  const w = WEAPONS[weaponId];
  if (!w || w.melee || w.bomb) return;
  if (w.punch) { r.punch[0] = Math.min(r.punch[0] + w.punch, 12); return; }
  const k = w.kick[stanceOf(ctx, w.spread.move[0] || 140)] || w.kick.stand;
  const [upBase, latBase, upMod, latMod, upMax, latMax, dirChange] = k;
  let up, lat;
  if (r.shots <= 1) { up = upBase; lat = latBase; }
  else { up = upBase + r.shots * upMod; lat = latBase + r.shots * latMod; }
  r.punch[0] = Math.min(r.punch[0] + up, upMax);
  if (r.dir === 1) r.punch[1] = Math.min(r.punch[1] + lat, latMax);
  else r.punch[1] = Math.max(r.punch[1] - lat, -latMax);
  if (Math.floor(rand() * (dirChange + 1)) === 0) r.dir = -r.dir;
}

// CS 1.6 punch decay (per frame): len -= (10 + len * 0.5) * dt.
export function decayPunch(r, dt) {
  const len = Math.hypot(r.punch[0], r.punch[1]);
  if (len <= 0) return;
  const nl = Math.max(0, len - (10 + len * 0.5) * dt);
  r.punch[0] *= nl / len;
  r.punch[1] *= nl / len;
}

// Aim direction from view angles (radians) plus punch (degrees).
export function aimWithPunch(yaw, pitch, punch) {
  const y = yaw + (punch[1] * Math.PI) / 180;
  const p = pitch + (punch[0] * Math.PI) / 180;
  const cp = Math.cos(p);
  return [-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp];
}

// Damage for a hit on `part` at `dist` units, before armour.
export function baseDamage(weaponId, part, dist) {
  const w = WEAPONS[weaponId];
  const g = HITGROUP[part] || HITGROUP.chest;
  let dmg = w.dmg * g.mul;
  if (!w.melee) dmg *= Math.pow(w.rangeMod, dist / 500);
  return dmg;
}

// CBasePlayer::TakeDamage armour logic, with the weapon's armour ratio.
export function armorAbsorb(dmg, part, armor, helmet, armorRatio = 1) {
  const g = HITGROUP[part] || HITGROUP.chest;
  const covered = armor > 0 && (g.armor === true || (g.armor === 'helmet' && helmet));
  if (!covered) return { hpDmg: Math.max(1, Math.round(dmg)), armorDmg: 0 };
  const ratio = Math.min(1, 0.5 * armorRatio);
  let hp = dmg * ratio;
  let arm = (dmg - hp) * 0.5;                // armour bonus 0.5
  if (arm > armor) { arm = armor; hp = dmg - arm * 2; }
  return { hpDmg: Math.max(1, Math.round(hp)), armorDmg: Math.round(arm) };
}

// Hit group from the height of the hit inside a player's hit box, CS-like
// proportions (head ~ top 15 %, chest to ~60 %, stomach to ~47 %, legs below).
export function hitPart(yRel, height) {
  const f = yRel / height;
  if (f >= 0.85) return 'head';
  if (f >= 0.6) return 'chest';
  if (f >= 0.47) return 'stomach';
  return 'legs';
}

// The head is narrower than the body: a hit in the head band that is more
// than this far (u) from the player's vertical axis misses them.
export const HEAD_RADIUS = 7.5;
export const RUN_SPEED = (weaponId) => (WEAPONS[weaponId] ? WEAPONS[weaponId].speed : PLAYER.runSpeed || 250);

// Being hit slows you (cstrike TakeDamage -> m_flVelocityModifier): a "large
// flinch" (rifle / sniper / machine-gun round to the upper body of a standing
// player) leaves 65 % speed, anything else 50 %. Falling does not tag.
const LARGE_FLINCH = new Set(['ak47', 'm4a1', 'scout', 'awp', 'm249']);
export function tagModifier(weaponId, part, ducking) {
  if (weaponId === 'fall') return 1;
  return LARGE_FLINCH.has(weaponId) && part !== 'legs' && !ducking ? 0.65 : 0.5;
}
