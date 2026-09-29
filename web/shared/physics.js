// Shared physics for the web build. Pure math (no three.js, no DOM) so the
// Node server and the browser client run the *identical* simulation.
//
//   buildColliders(map) -> flat AABB list used by BOTH sides
//   movePlayer(state, input, dt, colliders) -> CS 1.6 Quake-style movement
//   raycast(origin, dir, colliders, maxDist) -> nearest AABB hit (hitscan)
//
// Units are Half-Life units (~1 u = 1 inch), matching shared/constants.js and
// shared/maps.js.

import { PLAYER, MOVE } from './constants.js';
import { propColliders } from './props.js';
import { hitPart, HEAD_RADIUS } from './ballistics.js';

// ---------------------------------------------------------------- vectors

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const len2 = (a) => Math.hypot(a[0], a[2]); // horizontal length
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- RNG (deterministic, shared)

// mulberry32: tiny seeded PRNG so client and server generate identical cover.
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- colliders

// AABB: { min:[x,y,z], max:[x,y,z], mat }.
function box(c, s, mat) {
  return {
    min: [c[0] - s[0] / 2, c[1] - s[1] / 2, c[2] - s[2] / 2],
    max: [c[0] + s[0] / 2, c[1] + s[1] / 2, c[2] + s[2] / 2],
    mat,
  };
}

// Expand a ramp (low point a, high point b, width) into `steps` stacked AABBs.
// The movement code's auto step-up then walks up them like stairs; small steps
// read as a smooth slope.
function rampSteps(r, steps = 8, mat = r.mat) {
  const [ax, ay, az] = r.a;
  const [bx, by, bz] = r.b;
  const out = [];
  // Footprint is the rectangle spanning a->b in the dominant axis, `width` wide.
  const dx = bx - ax, dz = bz - az;
  const horizLen = Math.hypot(dx, dz);
  if (horizLen < 1e-6) {
    // vertical-only: just a box.
    const w = r.width / 2;
    out.push(box([(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2],
      [r.width, Math.abs(by - ay) || 64, r.width], mat));
    return out;
  }
  // Unit direction and perpendicular for width.
  const ux = dx / horizLen, uz = dz / horizLen;
  const px = -uz, pz = ux; // perpendicular in XZ
  const stepLen = horizLen / steps;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps, t1 = (i + 1) / steps;
    // centre of this step along the ramp
    const tm = (t0 + t1) / 2;
    const cx = ax + dx * tm, cz = az + dz * tm;
    const topY = lerp(ay, by, t1);          // top surface at the far edge of the step
    const botY = Math.min(ay, by) - 64;      // plenty of body below
    // step half-extents along the direction and the width
    const hLen = stepLen / 2 + 0.5;
    const hW = r.width / 2 + 0.5;
    // axis-aligned box containing the step segment (approx: bounding box)
    const minX = Math.min(cx - ux * hLen - Math.abs(px) * 0, cx + ux * hLen) - hW * Math.abs(px);
    const maxX = Math.max(cx - ux * hLen, cx + ux * hLen) + hW * Math.abs(px);
    const minZ = Math.min(cz - uz * hLen, cz + uz * hLen) - hW * Math.abs(pz);
    const maxZ = Math.max(cz - uz * hLen, cz + uz * hLen) + hW * Math.abs(pz);
    out.push({
      min: [minX, botY, minZ],
      max: [maxX, topY, maxZ],
      mat,
    });
  }
  return out;
}

// A square column (radius r, height h) as an AABB sitting on the floor.
function columnBox(col) {
  const half = Math.round(col.r * 1.0); // 4-sided cylinder ~= square of side 2r/sqrt2; use r for simplicity
  return {
    min: [col.pos[0] - half, 0, col.pos[1] - half],
    max: [col.pos[0] + half, col.h, col.pos[1] + half],
    mat: col.mat,
  };
}

// Deterministic cover crates, mirroring the Godot layout: 64 u cubes, 1-3 high
// stacks, scattered inside the given zones without overlapping.
export function coverCrates(map) {
  const rand = rng(map.coverSeed);
  const SIZE = 64;
  const placed = [];
  const crates = [];
  let attempts = 0;
  while (placed.length < map.coverCount && attempts < map.coverCount * 40) {
    attempts++;
    const z = map.coverZones[Math.floor(rand() * map.coverZones.length)];
    const x = Math.round((z[0] + rand() * (z[2] - z[0])) / SIZE) * SIZE;
    const zz = Math.round((z[1] + rand() * (z[3] - z[1])) / SIZE) * SIZE;
    const stack = 1 + Math.floor(rand() * 3);
    let clash = false;
    for (const c of placed) {
      if (Math.abs(c[0] - x) < SIZE * 1.5 && Math.abs(c[1] - zz) < SIZE * 1.5) { clash = true; break; }
    }
    if (clash) continue;
    for (let lvl = 0; lvl < stack; lvl++) {
      crates.push(box([x, SIZE / 2 + lvl * SIZE, zz], [SIZE, SIZE, SIZE], 'cover'));
    }
    placed.push([x, zz]);
  }
  return crates;
}

// Full static collision set for a map. Water is excluded (walk-through).
export function buildColliders(map) {
  const out = [];
  for (const b of map.boxes) out.push(box(b.c, b.s, b.mat));
  for (const b of (map.bridges || [])) out.push(box(b.c, b.s, b.mat));
  for (const r of map.ramps) out.push(...rampSteps(r));
  for (const c of map.columns) out.push(columnBox(c));
  out.push(...coverCrates(map));
  for (const p of (map.props || [])) out.push(...propColliders(p));
  return out;
}

// Player AABB from feet position and stance.
export function playerBox(pos, crouching) {
  const h = crouching ? PLAYER.crouchHeight : PLAYER.standHeight;
  const hw = PLAYER.halfWidth;
  return {
    min: [pos[0] - hw, pos[1], pos[2] - hw],
    max: [pos[0] + hw, pos[1] + h, pos[2] + hw],
  };
}

// Box that bullets test against. Standing it equals the hull; crouched it is
// taller than the 36 u movement hull because the crouched model's head is.
export function hitBox(pos, crouching) {
  const h = crouching ? PLAYER.crouchHitHeight : PLAYER.standHeight;
  const hw = PLAYER.halfWidth;
  return {
    min: [pos[0] - hw, pos[1], pos[2] - hw],
    max: [pos[0] + hw, pos[1] + h, pos[2] + hw],
  };
}

export function aabbOverlap(a, b) {
  return a.min[0] < b.max[0] && a.max[0] > b.min[0]
      && a.min[1] < b.max[1] && a.max[1] > b.min[1]
      && a.min[2] < b.max[2] && a.max[2] > b.min[2];
}

// ---------------------------------------------------------------- movement

// state: { pos, vel, yaw, pitch, onGround, crouching }
// input: { f, b, l, r (0/1), jump, crouch, walk (0/1) }
export function movePlayer(state, input, dt, colliders) {
  const p = state;
  p.crouching = !!input.crouch;

  // wish direction from yaw (pitch does not move you)
  const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
  const fwd = [ -sy, 0, -cy ];   // three.js -Z forward at yaw 0
  const right = [ cy, 0, -sy ];
  let wish = [0, 0, 0];
  if (input.f) wish = add(wish, fwd);
  if (input.b) wish = sub(wish, fwd);
  if (input.r) wish = add(wish, right);
  if (input.l) wish = sub(wish, right);
  const wl = len2(wish);
  let wishdir = [0, 0, 0];
  if (wl > 0) wishdir = [wish[0] / wl, 0, wish[2] / wl];

  // target speed
  // the weapon in hand sets the run speed (CS: AK 221, AWP 210, knife 250…)
  const run = input.maxSpeed || MOVE.runSpeed;
  let maxspeed = run;
  if (input.walk) maxspeed = run * (MOVE.walkSpeed / MOVE.runSpeed);
  if (p.crouching) maxspeed = run * MOVE.crouchSpeedMul;

  // friction (ground only)
  if (p.onGround) {
    const speed = len2(p.vel);
    if (speed > 0) {
      const control = Math.max(speed, MOVE.stopSpeed);
      const drop = control * MOVE.friction * dt;
      const newspeed = Math.max(0, speed - drop);
      const f = newspeed / speed;
      p.vel[0] *= f; p.vel[2] *= f;
    }
  }

  // accelerate (Quake/HL style)
  const currentSpeed = dot([p.vel[0], 0, p.vel[2]], wishdir);
  if (p.onGround) {
    const addSpeed = maxspeed - currentSpeed;
    if (addSpeed > 0) {
      const accel = Math.min(MOVE.accelerate * maxspeed * dt, addSpeed);
      p.vel[0] += wishdir[0] * accel;
      p.vel[2] += wishdir[2] * accel;
    }
  } else {
    // air: weak influence, capped wishspeed
    const airWish = Math.min(maxspeed, MOVE.airSpeedCap);
    const addSpeed = airWish - currentSpeed;
    if (addSpeed > 0) {
      const accel = Math.min(MOVE.airAccelerate * airWish * dt * 10, addSpeed);
      p.vel[0] += wishdir[0] * accel;
      p.vel[2] += wishdir[2] * accel;
    }
  }

  // jump
  if (input.jump && p.onGround) {
    p.vel[1] = MOVE.jumpVelocity;
    p.onGround = false;
  }

  // gravity
  if (!p.onGround) p.vel[1] -= MOVE.gravity * dt;

  // integrate with axis-separated collide-and-slide
  moveAxis(p, colliders, 0, p.vel[0] * dt);
  moveAxis(p, colliders, 2, p.vel[2] * dt);
  const wasFalling = p.vel[1] <= 0;
  const hitY = moveAxis(p, colliders, 1, p.vel[1] * dt);
  if (hitY < 0 && wasFalling) { p.onGround = true; p.vel[1] = 0; }
  else if (hitY > 0) { p.vel[1] = 0; }
  else if (hitY === 0 && p.onGround) {
    // verify we're still grounded (walking off an edge)
    if (!grounded(p, colliders)) p.onGround = false;
  }

  return p;
}

// Move along one axis and resolve collisions. Returns 0 (free), +/-1 (blocked).
//
// Every clamp is gated on the side the player APPROACHED from (using the
// previous position). This is what stops the classic bug where a player who
// overlaps a box gets teleported to its top: a downward move only "lands" on a
// surface the player was actually above last frame; a surface the player is
// merely inside is treated as a wall and handled on the horizontal axes.
function moveAxis(p, colliders, axis, delta) {
  if (delta === 0) return 0;
  const prev = p.pos[axis];
  p.pos[axis] += delta;
  let blocked = 0;
  const height = () => (p.crouching ? PLAYER.crouchHeight : PLAYER.standHeight);

  for (const c of colliders) {
    let box = playerBox(p.pos, p.crouching);
    if (!aabbOverlap(box, c)) continue;

    if (axis === 1) {
      const h = height();
      if (delta < 0) {
        // falling: land on a surface only if we were above it last frame
        if (prev >= c.max[1] - 0.5) {
          p.pos[1] = c.max[1];
          blocked = -1;
        }
      } else {
        // rising: bonk a ceiling only if our head was below it last frame
        if (prev + h <= c.min[1] + 0.5) {
          p.pos[1] = c.min[1] - h - 0.01;
          blocked = 1;
        }
      }
      continue;
    }

    // horizontal: try auto step-up onto a low obstacle first
    const rel = c.max[1] - p.pos[1];
    if (rel > 0 && rel <= PLAYER.stepHeight) {
      const savedPos = [p.pos[0], p.pos[1], p.pos[2]];
      p.pos[1] = c.max[1] + 0.01;
      if (!colliders.some((o) => o !== c && aabbOverlap(playerBox(p.pos, p.crouching), o))) {
        continue; // stepped up cleanly
      }
      p.pos = savedPos;
    }
    // clamp to the face we approached from
    const half = PLAYER.halfWidth;
    if (delta > 0) {
      if (prev + half <= c.min[axis] + 0.5) {
        p.pos[axis] = c.min[axis] - half - 0.01;
        blocked = 1;
      }
    } else {
      if (prev - half >= c.max[axis] - 0.5) {
        p.pos[axis] = c.max[axis] + half + 0.01;
        blocked = -1;
      }
    }
  }
  return blocked;
}

// Small downward probe: is there something solid just below the feet?
function grounded(p, colliders) {
  const probe = playerBox([p.pos[0], p.pos[1] - 2, p.pos[2]], p.crouching);
  return colliders.some((c) => aabbOverlap(probe, c));
}

// ---------------------------------------------------------------- raycast (hitscan)

// Ray vs single AABB (slab method). Returns entry distance or null.
export function rayBox(origin, dir, b) {
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const d = dir[i];
    if (Math.abs(d) < 1e-9) {
      if (origin[i] < b.min[i] || origin[i] > b.max[i]) return null;
    } else {
      let t1 = (b.min[i] - origin[i]) / d;
      let t2 = (b.max[i] - origin[i]) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin >= 0 ? tmin : (tmax >= 0 ? tmax : null);
}

// Nearest world hit. Returns { t, point, box } or null.
export function raycast(origin, dir, colliders, maxDist = 8192) {
  let best = null;
  for (const c of colliders) {
    const t = rayBox(origin, dir, c);
    if (t !== null && t <= maxDist && (best === null || t < best.t)) {
      best = { t, point: add(origin, scale(dir, t)), box: c };
    }
  }
  return best;
}

// Nearest player hit among candidate player boxes. `players` is a list of
// { id, box } (box from hitBox). Returns { t, id, point, part } or null.
// `part` is a CS hit group (head / chest / stomach / legs) by hit height;
// the head is narrower than the box, so a ray through the head band that
// passes beside the head misses that player.
export function raycastPlayers(origin, dir, players, maxDist, excludeId) {
  let best = null;
  for (const pl of players) {
    if (pl.id === excludeId) continue;
    const b = pl.box;
    const t = rayBox(origin, dir, b);
    if (t === null || t > maxDist) continue;
    if (best !== null && t >= best.t) continue;
    const h = b.max[1] - b.min[1];
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    let hitT = t, part = hitPart(origin[1] + dir[1] * t - b.min[1], h);
    if (part === 'head') {
      // march through the head band looking for the (narrow) head
      const exit = rayBoxExit(origin, dir, b);
      let found = false;
      for (let s = t; s <= exit; s += 1.5) {
        const px = origin[0] + dir[0] * s - cx, pz = origin[2] + dir[2] * s - cz;
        const py = origin[1] + dir[1] * s - b.min[1];
        const pp = hitPart(py, h);
        if (pp === 'head' && Math.hypot(px, pz) <= HEAD_RADIUS) { hitT = s; found = true; break; }
        if (pp !== 'head') { hitT = s; part = pp; found = true; break; }
      }
      if (!found) continue;
    }
    best = { t: hitT, id: pl.id, point: add(origin, scale(dir, hitT)), part };
  }
  return best;
}

function rayBoxExit(origin, dir, b) {
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const d = dir[i];
    if (Math.abs(d) < 1e-9) continue;
    const t1 = (b.min[i] - origin[i]) / d, t2 = (b.max[i] - origin[i]) / d;
    tmax = Math.min(tmax, Math.max(t1, t2));
  }
  return tmax;
}
