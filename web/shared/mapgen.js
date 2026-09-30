// Map author format (M15): describe the spaces people walk in, not the walls.
//
//   areas: [[x0, z0, x1, z1, floorY = 0, roofY = null], ...]
//
// Every area is carved out of solid rock on a 32 u grid (later areas win
// where they overlap, so a platform can sit inside a room). Whatever is not
// carved becomes wall, merged into as few boxes as possible (greedy
// rectangles); raised floors and roofs become boxes too. The result is the
// same { c, s, mat } box list hand-built maps use, so everything downstream
// (physics, nav, Blender bake, props) works unchanged.

const CELL = 32;

export function carve({ bounds, areas, wallH = 256, wallMat = 'wall', floorMat = 'floor', roofMat = 'accent' }) {
  const nx = Math.round((bounds.x1 - bounds.x0) / CELL), nz = Math.round((bounds.z1 - bounds.z0) / CELL);
  const open = new Uint8Array(nx * nz);
  const floor = new Float32Array(nx * nz);
  const roof = new Float32Array(nx * nz).fill(-1);
  for (const [x0, z0, x1, z1, y = 0, r = null] of areas) {
    for (let j = 0; j < nz; j++) {
      const cz = bounds.z0 + (j + 0.5) * CELL;
      if (cz < z0 || cz > z1) continue;
      for (let i = 0; i < nx; i++) {
        const cx = bounds.x0 + (i + 0.5) * CELL;
        if (cx < x0 || cx > x1) continue;
        open[i + j * nx] = 1;
        floor[i + j * nx] = y;
        roof[i + j * nx] = r === null ? -1 : r;
      }
    }
  }
  const boxes = [];
  // greedy rectangles over cells sharing a key (solid / raised floor / roof)
  const rects = (key) => {
    const used = new Uint8Array(nx * nz);
    const out = [];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = key(i, j);
        if (k === null || used[i + j * nx]) continue;
        let w = 1;
        while (i + w < nx && !used[i + w + j * nx] && key(i + w, j) === k) w++;
        let h = 1;
        outer: while (j + h < nz) {
          for (let a = 0; a < w; a++) if (used[i + a + (j + h) * nx] || key(i + a, j + h) !== k) break outer;
          h++;
        }
        for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) used[i + a + (j + b) * nx] = 1;
        out.push({ x0: bounds.x0 + i * CELL, z0: bounds.z0 + j * CELL, x1: bounds.x0 + (i + w) * CELL, z1: bounds.z0 + (j + h) * CELL, k });
      }
    }
    return out;
  };
  const box = (x0, y0, z0, x1, y1, z1, mat) => boxes.push({ c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], s: [x1 - x0, y1 - y0, z1 - z0], mat });
  // all solid space is filled (merged into big blocks): leaving hollow pockets
  // between wall shells would give the nav graph unreachable islands
  for (const r of rects((i, j) => (!open[i + j * nx] ? 'w' : null))) box(r.x0, 0, r.z0, r.x1, wallH, r.z1, wallMat);
  for (const r of rects((i, j) => (open[i + j * nx] && floor[i + j * nx] > 0 ? floor[i + j * nx] : null))) box(r.x0, 0, r.z0, r.x1, r.k, r.z1, floorMat);
  for (const r of rects((i, j) => (open[i + j * nx] && roof[i + j * nx] > 0 ? roof[i + j * nx] : null))) box(r.x0, r.k, r.z0, r.x1, r.k + 32, r.z1, roofMat);
  return boxes;
}
