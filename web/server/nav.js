// Navigation graph for bots, generated from a map's collision boxes.
//
// The level is sampled on a 32 u grid. Every surface a standing player fits
// on becomes a node (several per column where there are platforms, bridges
// or balconies). Nodes link to their 8 neighbours when the step up is small
// enough to walk (ramps are stacks of short steps) or it is a safe drop down.
// Paths come from A*, then get string-pulled so bots walk straight lines
// instead of grid zig-zags.
//
// Built once per map and cached; ~20k nodes, well under a second.

import { PLAYER } from '../shared/constants.js';
import { aabbOverlap, raycast } from '../shared/physics.js';

const CELL = 32;
const MAX_STEP = PLAYER.stepHeight;   // walkable rise between neighbours
const MAX_DROP = 160;                 // safe fall between neighbours

const cache = new Map();

export function navFor(map, colliders) {
  if (!cache.has(map.id)) cache.set(map.id, new NavGraph(map, colliders));
  return cache.get(map.id);
}

export class NavGraph {
  constructor(map, colliders) {
    const t0 = Date.now();
    this.colliders = colliders;
    const b = map.bounds;
    this.x0 = b.x0; this.z0 = b.z0;
    this.nx = Math.ceil((b.x1 - b.x0) / CELL);
    this.nz = Math.ceil((b.z1 - b.z0) / CELL);
    this.nodes = [];            // { i, x, y, z, cx, cz, links: [[j, cost]] }
    this.columns = new Map();   // cx,cz -> [node ids]

    // candidate floors per column: tops of colliders under the cell centre
    for (let cz = 0; cz < this.nz; cz++) {
      for (let cx = 0; cx < this.nx; cx++) {
        const x = this.x0 + (cx + 0.5) * CELL, z = this.z0 + (cz + 0.5) * CELL;
        const tops = new Set();
        for (const c of colliders) {
          if (x > c.min[0] && x < c.max[0] && z > c.min[2] && z < c.max[2]) tops.add(c.max[1]);
        }
        const ids = [];
        for (const y of [...tops].sort((a, c) => a - c)) {
          if (!this.standable(x, y, z)) continue;
          const node = { i: this.nodes.length, x, y, z, cx, cz, links: [] };
          this.nodes.push(node);
          ids.push(node.i);
        }
        if (ids.length) this.columns.set(cx + cz * this.nx, ids);
      }
    }

    // links
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const n of this.nodes) {
      for (const [dx, dz] of dirs) {
        const ids = this.columns.get((n.cx + dx) + (n.cz + dz) * this.nx);
        if (!ids || n.cx + dx < 0 || n.cx + dx >= this.nx) continue;
        for (const j of ids) {
          const m = this.nodes[j];
          const rise = m.y - n.y;
          if (rise > MAX_STEP || rise < -MAX_DROP) continue;
          // diagonals only when both straight neighbours are walkable (no corner cutting)
          if (dx && dz && (!this.nodeAt(n.cx + dx, n.cz, n.y) || !this.nodeAt(n.cx, n.cz + dz, n.y))) continue;
          if (!this.standable((n.x + m.x) / 2, Math.max(n.y, m.y), (n.z + m.z) / 2)) continue;
          const cost = Math.hypot(m.x - n.x, m.z - n.z) + Math.max(0, rise) * 2;
          n.links.push([j, cost]);
        }
      }
    }
    // the largest connected area is "the map"; islands (crate tops, wall
    // tops) are skipped when picking places to go
    const comp = new Int32Array(this.nodes.length).fill(-1);
    const adj = this.nodes.map(() => []);
    for (const n of this.nodes) for (const [j] of n.links) { adj[n.i].push(j); adj[j].push(n.i); }
    let best = -1, bestSize = 0;
    for (const n of this.nodes) {
      if (comp[n.i] >= 0) continue;
      const c = n.i, stack = [n.i];
      comp[n.i] = c;
      let size = 0;
      while (stack.length) { const i = stack.pop(); size++; for (const j of adj[i]) if (comp[j] < 0) { comp[j] = c; stack.push(j); } }
      if (size > bestSize) { bestSize = size; best = c; }
    }
    this.main = this.nodes.filter((n) => comp[n.i] === best);
    for (const n of this.main) n.main = true;
    this.buildTime = Date.now() - t0;
  }

  standable(x, y, z) {
    // exactly the body: touching a wall is fine (the physics overlap test is
    // strict), anything narrower would let bots wedge into corners
    const hw = PLAYER.halfWidth;
    const box = { min: [x - hw, y + 1, z - hw], max: [x + hw, y + PLAYER.standHeight, z + hw] };
    // anything low enough to step onto (the next stair of a ramp) is not in the way
    for (const c of this.colliders) if (c.max[1] > y + MAX_STEP && aabbOverlap(box, c)) return false;
    return true;
  }

  nodeAt(cx, cz, nearY) {
    const ids = this.columns.get(cx + cz * this.nx);
    if (!ids) return null;
    let best = null;
    for (const j of ids) {
      const n = this.nodes[j];
      if (Math.abs(n.y - nearY) <= MAX_STEP + 1 && (!best || Math.abs(n.y - nearY) < Math.abs(best.y - nearY))) best = n;
    }
    return best;
  }

  // Closest node to a world position (searching outward a few cells).
  nearest(pos) {
    const cx = Math.floor((pos[0] - this.x0) / CELL), cz = Math.floor((pos[2] - this.z0) / CELL);
    let best = null, bestD = Infinity;
    for (let r = 0; r <= 6 && !best; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ids = this.columns.get((cx + dx) + (cz + dz) * this.nx);
          if (!ids) continue;
          for (const j of ids) {
            const n = this.nodes[j];
            if (n.y > pos[1] + MAX_STEP + 2) continue; // not above our head
            const d = Math.hypot(n.x - pos[0], (n.y - pos[1]) * 2, n.z - pos[2]) + (n.main ? 0 : 200);
            if (d < bestD) { bestD = d; best = n; }
          }
        }
      }
    }
    return best;
  }

  randomNode(rand = Math.random) {
    return this.main[Math.floor(rand() * this.main.length)];
  }

  // A* from world position to world position; returns [[x,y,z], ...] or null.
  path(from, to) {
    this.calls = (this.calls || 0) + 1;
    const s = this.nearest(from), g = this.nearest(to);
    if (!s || !g) return null;
    if (s === g) return [[g.x, g.y, g.z]];
    const N = this.nodes.length;
    const gScore = new Float64Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = new MinHeap();
    gScore[s.i] = 0;
    heap.push(s.i, this.h(s, g));
    let found = false, expanded = 0;
    while (heap.size) {
      const i = heap.pop();
      if (i === g.i) { found = true; break; }
      if (closed[i]) continue;
      closed[i] = 1;
      if (++expanded > 20000) break;
      const n = this.nodes[i];
      for (const [j, cost] of n.links) {
        if (closed[j]) continue;
        const ng = gScore[i] + cost;
        if (ng < gScore[j]) {
          gScore[j] = ng;
          came[j] = i;
          heap.push(j, ng + this.h(this.nodes[j], g));
        }
      }
    }
    if (!found) return null;
    const raw = [];
    for (let i = g.i; i !== -1; i = came[i]) raw.push(this.nodes[i]);
    raw.reverse();
    return this.smooth(raw).map((n) => [n.x, n.y, n.z]);
  }

  h(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

  // String pulling: from each kept node, jump to the farthest later node that
  // is reachable in a straight line on (roughly) level ground.
  smooth(nodes) {
    if (nodes.length <= 2) return nodes;
    const out = [nodes[0]];
    let i = 0;
    while (i < nodes.length - 1) {
      let j = Math.min(nodes.length - 1, i + 24);
      for (; j > i + 1; j--) if (this.walkable(nodes[i], nodes[j])) break;
      out.push(nodes[j]);
      i = j;
    }
    return out;
  }

  // Straight-line walkability, checked on the grid itself (cheap): every
  // 16 u along a->b there must be a node within a step of the running height,
  // and no step up/down between samples may exceed what a player can walk.
  walkable(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(L / 16));
    let y = a.y;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const x = a.x + dx * t, z = a.z + dz * t;
      // the body is 32 u wide: check both shoulders too
      for (const off of [0, -12, 12]) {
        const ox = x + (-dz / (L || 1)) * off, oz = z + (dx / (L || 1)) * off;
        const n = this.nodeAt(Math.floor((ox - this.x0) / CELL), Math.floor((oz - this.z0) / CELL), y);
        if (!n || Math.abs(n.y - y) > MAX_STEP) return false;
        if (off === 0) y = n.y;
      }
    }
    return true;
  }

  // Line of sight between two eye positions.
  visible(a, b) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(...d);
    if (L < 1) return true;
    return !raycast(a, d.map((v) => v / L), this.colliders, L - 1);
  }
}

class MinHeap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(k, p) {
    const K = this.k, P = this.p;
    K.push(k); P.push(p);
    let i = K.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (P[up] <= P[i]) break;
      [K[up], K[i]] = [K[i], K[up]]; [P[up], P[i]] = [P[i], P[up]];
      i = up;
    }
  }
  pop() {
    const K = this.k, P = this.p;
    const top = K[0];
    const lk = K.pop(), lp = P.pop();
    if (K.length) {
      K[0] = lk; P[0] = lp;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < K.length && P[l] < P[m]) m = l;
        if (r < K.length && P[r] < P[m]) m = r;
        if (m === i) break;
        [K[m], K[i]] = [K[i], K[m]]; [P[m], P[i]] = [P[i], P[m]];
        i = m;
      }
    }
    return top;
  }
}
