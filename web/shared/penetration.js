// Bullet penetration, as cstrike's FireBullets3.
//
// A bullet travels until it hits a wall or a player. If it still has
// penetrations left and has not gone past its calibre's penetration range,
// it jumps `power` units ahead (power scaled by the surface material) and, if
// that point is outside anything solid, carries on with its damage scaled by
// the material and half of its remaining range. Damage also falls off per
// segment by the weapon's range modifier. Players are passed through too
// (x0.75 damage). A wall thicker than the jump stops the bullet.

import { raycast, raycastPlayers } from './physics.js';
import { HITGROUP, BULLETS } from './constants.js';

// [power multiplier, damage multiplier] per material class
export const MATERIAL_PEN = {
  metal: [0.15, 0.2], concrete: [0.25, 0.5], tile: [0.65, 0.3], wood: [1.0, 0.6], soft: [1.0, 0.5], flesh: [1.0, 0.75],
};

// material class from the surface texture a palette material uses
export function materialClass(tex) {
  if (!tex) return 'concrete';
  if (/metal|corrugated|container|barrel/.test(tex)) return 'metal';
  if (/crate|plank|wood|door|pallet/.test(tex)) return 'wood';
  if (/drywall|ceiling|carpet|plaster|tile/.test(tex)) return 'tile';
  if (/hedge|foliage|burlap|water/.test(tex)) return 'soft';
  return 'concrete';
}

function inside(p, colliders) {
  return colliders.some((c) => p[0] > c.min[0] + 0.01 && p[0] < c.max[0] - 0.01 && p[1] > c.min[1] + 0.01 && p[1] < c.max[1] - 0.01 && p[2] > c.min[2] + 0.01 && p[2] < c.max[2] - 0.01);
}

// opts: { origin, dir, colliders, targets: [{id, box}], exclude, w (weapon stats),
//         matOf(collider) -> class, maxDist }
// -> { hits: [{ id, part, point, dmg, dist, pen }], impacts: [point], exits: [point] }
export function traceBullet({ origin, dir, colliders, targets, exclude, w, matOf, maxDist = 8192, onGlass = null }) {
  const [power, penRange] = BULLETS[w.caliber] || [0, 0];
  let left = w.pen || 0;
  let src = origin, range = maxDist, dmg = w.dmg, total = 0, pens = 0;
  const hits = [], impacts = [], exits = [];
  const skip = new Set([exclude]);
  for (let guard = 0; guard < 8 && range > 1; guard++) {
    const wall = raycast(src, dir, colliders, range);
    const cand = targets.filter((t) => !skip.has(t.id));
    const ph = raycastPlayers(src, dir, cand, range, exclude);
    const player = ph && (!wall || ph.t < wall.t);
    const hit = player ? ph : wall;
    if (!hit) break;
    // glass shatters and the bullet carries on (no penetration used up)
    if (!player && hit.box.glass && onGlass) {
      onGlass(hit.box, hit.point);
      total += hit.t;
      range -= hit.t;
      src = [hit.point[0] + dir[0] * 0.5, hit.point[1] + dir[1] * 0.5, hit.point[2] + dir[2] * 0.5];
      continue;
    }
    total += hit.t;
    dmg *= Math.pow(w.rangeMod, hit.t / 500);
    if (player) {
      const g = HITGROUP[ph.part] || HITGROUP.chest;
      hits.push({ id: ph.id, part: ph.part, point: ph.point, dmg: dmg * g.mul, dist: total, pen: pens > 0 });
      skip.add(ph.id);
    } else impacts.push(hit.point);
    if (left <= 0 || total > penRange) break;
    const [pm, dm] = MATERIAL_PEN[player ? 'flesh' : (matOf ? matOf(hit.box) : 'concrete')] || MATERIAL_PEN.concrete;
    const eff = power * pm;
    const next = [hit.point[0] + dir[0] * eff, hit.point[1] + dir[1] * eff, hit.point[2] + dir[2] * eff];
    if (!player && inside(next, colliders)) break;          // too thick for this bullet
    if (!player) exits.push(next);
    src = next;
    range = (range - hit.t - eff) * 0.5;
    dmg *= dm;
    left--; pens++;
  }
  return { hits, impacts, exits };
}
