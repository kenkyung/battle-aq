// Doors and breakable glass (M15): live meshes over colliders the game
// moves or removes. The server decides; this mirrors its `door` / `glass`
// events onto the client's colliders (so prediction collides the same) and
// animates the change.

import * as THREE from 'three';
import { doorBoxAt } from '../shared/physics.js';
import { loadTexture } from './assets.js';

export class DynWorld {
  constructor(scene, map, colliders, world) {
    this.scene = scene; this.map = map; this.colliders = colliders; this.world = world;
    this.doors = new Map();   // id -> { door, mesh, collider, from, to, t }
    this.glass = new Map();   // id -> { mesh, pane }
    const doorTex = loadTexture('tex/door_wood.jpg').catch(() => null);
    for (const d of map.doors || []) {
      const size = [0, 1, 2].map((i) => d.max[i] - d.min[i]);
      const mat = new THREE.MeshLambertMaterial({ color: 0xb09070 });
      doorTex.then((t) => { if (t) { const tt = t.clone(); tt.needsUpdate = true; tt.repeat.set(1, 1); mat.map = tt; mat.color.setHex(0xffffff); mat.needsUpdate = true; } });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
      const c = [0, 1, 2].map((i) => (d.min[i] + d.max[i]) / 2);
      mesh.position.set(...c);
      const tint = world ? world.sampleLight([c[0], d.min[1], c[2]]) : 1;
      mat.color.multiplyScalar(tint);
      scene.add(mesh);
      this.doors.set(d.id, { door: d, mesh, base: c, collider: colliders.find((x) => x.door === d.id), from: 0, to: 0, t: 1 });
    }
    for (const g of map.glass || []) {
      const size = [0, 1, 2].map((i) => g.max[i] - g.min[i]);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size),
        new THREE.MeshBasicMaterial({ color: 0xbfd8e4, transparent: true, opacity: 0.32, depthWrite: false }));
      mesh.position.set(...[0, 1, 2].map((i) => (g.min[i] + g.max[i]) / 2));
      mesh.renderOrder = 3;
      scene.add(mesh);
      this.glass.set(g.id, { mesh, pane: g, broken: false });
    }
  }

  setDoor(id, open, instant = false) {
    const e = this.doors.get(id);
    if (!e) return;
    const b = doorBoxAt(e.door, open);
    if (e.collider) { e.collider.min = b.min; e.collider.max = b.max; }
    e.from = e.t < 1 ? e.from + (e.to - e.from) * e.t : e.to;
    e.to = open ? 1 : 0;
    e.t = instant ? 1 : 0;
    if (instant) e.from = e.to;
    return e;
  }

  breakGlass(id) {
    const e = this.glass.get(id);
    if (!e || e.broken) return null;
    e.broken = true;
    e.mesh.visible = false;
    const i = this.colliders.findIndex((c) => c.glass === id);
    if (i >= 0) this.colliders.splice(i, 1);
    return e.pane;
  }

  resetGlass() {
    for (const [id, e] of this.glass) {
      if (!e.broken) continue;
      e.broken = false; e.mesh.visible = true;
      this.colliders.push({ min: e.pane.min.slice(), max: e.pane.max.slice(), mat: 'glass', glass: id });
    }
  }

  // the nearest closed-or-open door within reach (for the E hint)
  nearDoor(pos, reach = 96) {
    for (const [id, e] of this.doors) {
      const c = e.collider; if (!c) continue;
      const q = [Math.max(c.min[0], Math.min(c.max[0], pos[0])), Math.max(c.min[2], Math.min(c.max[2], pos[2]))];
      if (Math.hypot(q[0] - pos[0], q[1] - pos[2]) < reach) return id;
    }
    return null;
  }

  update(dt) {
    for (const e of this.doors.values()) {
      if (e.t >= 1) continue;
      e.t = Math.min(1, e.t + dt / 0.5);                   // slides over half a second
      const k = e.from + (e.to - e.from) * (e.t * e.t * (3 - 2 * e.t));
      const o = e.door.open;
      e.mesh.position.set(e.base[0] + o[0] * k, e.base[1] + o[1] * k, e.base[2] + o[2] * k);
    }
  }

  dispose() {
    for (const e of this.doors.values()) this.scene.remove(e.mesh);
    for (const e of this.glass.values()) this.scene.remove(e.mesh);
  }
}
