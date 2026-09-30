// Guns lying on the floor (dropped with G, left by the dead, swapped out
// when buying): the same weapons.glb models, lying on their side, from the
// server snapshot. Walking over one with that slot free picks it up.

import * as THREE from 'three';
import { weaponModel } from './assets.js';
import { applyFinish } from './finishes.js';

export class DropView {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.list = new Map();
  }

  sync(drops) {
    const seen = new Set();
    for (const d of drops || []) {
      seen.add(d.id);
      if (this.list.has(d.id)) continue;
      const mid = d.mode === 'silenced' && weaponModel(d.w + '_s') ? d.w + '_s' : d.w;
      const m = weaponModel(mid);
      if (!m) continue;
      m.traverse((o) => { if (o.isMesh) { o.material = new THREE.MeshLambertMaterial({ map: o.material.map, normalMap: o.material.normalMap || null }); } });
      applyFinish(m, d.fin || 0);
      const g = new THREE.Group();
      g.add(m);
      m.rotation.z = Math.PI / 2;            // on its side
      m.position.y = 1.4;
      g.position.set(d.pos[0], d.pos[1], d.pos[2]);
      g.rotation.y = d.yaw || 0;
      const light = this.world ? this.world.sampleLight(d.pos) : 1;
      m.traverse((o) => { if (o.material && o.material.color) o.material.color.setScalar(light); });
      this.scene.add(g);
      this.list.set(d.id, g);
    }
    for (const [id, g] of this.list) if (!seen.has(id)) { this.scene.remove(g); this.list.delete(id); }
  }

  dispose() { for (const g of this.list.values()) this.scene.remove(g); this.list.clear(); }
}
