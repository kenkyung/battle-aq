// Grenades, CS 1.6 style. Shared so the server (authoritative flight +
// detonation) and every client (drawing the grenade in flight) run the same
// bouncing physics from the same throw.
//
// Throw (CBasePlayerWeapon, HL/CS): the view pitch is remapped so the throw
// leaves ~10° above where you look, speed = (90 - pitch) x 6 capped at 750,
// plus your own velocity. Flight: gravity x 0.55, each bounce keeps ~45 % of
// the speed along the hit axis and loses some sliding speed; it comes to rest
// on the ground. Fuse: 1.5 s after the throw (smoke: once it has settled).

import { aabbOverlap, raycast } from './physics.js';

export const NADES = {
  hegrenade:    { fuse: 1.5, damage: 100, radius: 350 },
  flashbang:    { fuse: 1.5, radius: 1500 },
  smokegrenade: { fuse: 1.5, duration: 18, radius: 150, settle: true },
};

const GRAVITY = 800 * 0.55;
const R = 2; // grenade half-size

// HL pitch is positive looking DOWN; ours is positive looking up.
export function throwVelocity(yaw, pitch, playerVel = [0, 0, 0]) {
  let x = (-pitch * 180) / Math.PI;
  if (x < 0) x = -10 + x * ((90 - 10) / 90);
  else x = -10 + x * ((90 + 10) / 90);
  const speed = Math.min(750, (90 - x) * 6);
  const p = (-x * Math.PI) / 180;
  const fwd = [-Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p)];
  return { vel: [fwd[0] * speed + playerVel[0], fwd[1] * speed + playerVel[1], fwd[2] * speed + playerVel[2]], fwd };
}

export function newNade(kind, origin, vel) {
  return { kind, pos: origin.slice(), vel: vel.slice(), age: 0, rest: false, bounces: 0 };
}

function boxAt(p) { return { min: [p[0] - R, p[1] - R, p[2] - R], max: [p[0] + R, p[1] + R, p[2] + R] }; }

// Advance one grenade by dt; returns true if it bounced this step.
export function stepNade(n, dt, colliders) {
  n.age += dt;
  if (n.rest) return false;
  let bounced = false;
  const sub = 3, h = dt / sub;
  for (let s = 0; s < sub; s++) {
    n.vel[1] -= GRAVITY * h;
    for (let axis = 0; axis < 3; axis++) {
      const prev = n.pos[axis];
      n.pos[axis] += n.vel[axis] * h;
      const b = boxAt(n.pos);
      const hit = colliders.find((c) => aabbOverlap(b, c));
      if (!hit) continue;
      n.pos[axis] = prev;
      const impact = Math.abs(n.vel[axis]);
      n.vel[axis] = -n.vel[axis] * 0.45;
      if (axis === 1) { n.vel[0] *= 0.75; n.vel[2] *= 0.75; }
      if (impact > 60) { bounced = true; n.bounces++; }
    }
  }
  // settled on the ground?
  const below = raycast(n.pos, [0, -1, 0], colliders, R + 1.5);
  if (below && Math.hypot(n.vel[0], n.vel[1], n.vel[2]) < 25) { n.rest = true; n.vel = [0, 0, 0]; n.pos[1] = below.point[1] + R; }
  if (n.pos[1] < -2000) n.rest = true;
  return bounced;
}

// Does the segment a->b pass through any active smoke cloud?
export function smokeBlocks(a, b, smokes, now) {
  for (const s of smokes) {
    if (now < s.from || now > s.until) continue;
    const r = s.radius * Math.min(1, (now - s.from) / 1.5);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
    let t = ((s.pos[0] - a[0]) * d[0] + (s.pos[1] - a[1]) * d[1] + (s.pos[2] - a[2]) * d[2]) / L2;
    t = Math.max(0, Math.min(1, t));
    const c = [a[0] + d[0] * t - s.pos[0], a[1] + d[1] * t - s.pos[1], a[2] + d[2] * t - s.pos[2]];
    if (c[0] * c[0] + c[1] * c[1] * 2.5 + c[2] * c[2] < r * r) return true;   // squashed sphere
  }
  return false;
}

// How badly a flash blinds a viewer (0..1) and for how long (s): distance
// falloff, and whether they were facing it (CS: dot >= 0.5 full, >= -0.5 half,
// behind a quarter). Line of sight is checked by the caller.
export function flashAmount(eye, yaw, pitch, flashPos) {
  const d = [flashPos[0] - eye[0], flashPos[1] - eye[1], flashPos[2] - eye[2]];
  const dist = Math.hypot(...d);
  if (dist >= NADES.flashbang.radius) return { amount: 0, seconds: 0 };
  const fwd = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  const dot = (d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2]) / (dist || 1);
  const facing = dot >= 0.5 ? 1 : dot >= -0.5 ? 0.55 : 0.25;
  const near = 1 - dist / NADES.flashbang.radius;
  const amount = Math.min(1, facing * (0.35 + 0.9 * near));
  return { amount, seconds: 0.4 + 4.6 * amount * near + (facing === 1 ? 0.8 : 0) };
}
