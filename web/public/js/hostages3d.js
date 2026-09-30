// Hostages (cs_ maps): the civilian model from hostage.glb, placed from the
// server snapshot (the server walks them; nothing is simulated here), with
// the same idle / walk / run / death clips as the soldiers. Rescue zones get
// a faint ring on the ground so CTs know where to lead them.

import * as THREE from 'three';
import { clone as cloneSkinned } from '../vendor/addons/utils/SkeletonUtils.js';
import { Models } from './assets.js';

const STRIDE = { walk: 61.4, run: 90 };

export class HostageView {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.list = new Map();
    this.rings = [];
  }

  // rescue zones: [[x, y, z, radius], ...]
  setZones(zones) {
    for (const r of this.rings) { this.scene.remove(r); r.geometry.dispose(); r.material.dispose(); }
    this.rings = [];
    for (const z of zones || []) {
      const rad = z[3] || 280;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(rad - 10, rad, 64),
        new THREE.MeshBasicMaterial({ color: 0x7fd48a, transparent: true, opacity: 0.35, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(z[0], (z[1] || 0) + 1.5, z[2]);
      ring.renderOrder = 2;
      this.scene.add(ring);
      this.rings.push(ring);
    }
  }

  make(h) {
    const src = Models.hostage;
    const group = new THREE.Group();
    let mixer = null, actions = {};
    if (src) {
      const model = cloneSkinned(src.scene);
      model.traverse((o) => {
        if (o.isMesh) {
          o.material = new THREE.MeshLambertMaterial({ map: o.material.map, normalMap: o.material.normalMap || null });
          o.frustumCulled = false;
        }
      });
      group.add(model);
      mixer = new THREE.AnimationMixer(model);
      for (const clip of src.animations) {
        const a = mixer.clipAction(clip);
        if (clip.name === 'death') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
        actions[clip.name] = a;
      }
    }
    this.scene.add(group);
    const e = { id: h.id, group, mixer, actions, clip: null, cur: { pos: h.pos.slice(), yaw: h.yaw || 0 },
      tgt: { pos: h.pos.slice(), yaw: h.yaw || 0 }, vel: [0, 0, 0], netVel: [0, 0, 0], t: undefined,
      alive: true, rescued: false, light: 1, lightT: 0 };
    this.list.set(h.id, e);
    this.play(e, 'idle', 0);
    return e;
  }

  play(e, name, fade = 0.2) {
    if (!e.mixer || e.clip === name || !e.actions[name]) return;
    for (const [n, a] of Object.entries(e.actions)) {
      if (n === name || !a.isRunning()) continue;
      if (fade > 0) a.fadeOut(fade); else a.stop();
    }
    const next = e.actions[name];
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    if (fade > 0) next.fadeIn(fade);
    e.clip = name;
  }

  // snapshot: [{ id, pos, yaw, alive, rescued, leader, moving }]
  sync(hostages) {
    const seen = new Set();
    const now = performance.now() / 1000;
    for (const h of hostages || []) {
      seen.add(h.id);
      const e = this.list.get(h.id) || this.make(h);
      if (e.t !== undefined && now - e.t > 0.015) {
        const w = 1 / (now - e.t);
        let v = [0, 1, 2].map((i) => (h.pos[i] - e.tgt.pos[i]) * w);
        if (Math.hypot(v[0], v[2]) > 700) { v = [0, 0, 0]; e.cur.pos = h.pos.slice(); }
        e.netVel = e.netVel.map((x, i) => x + (v[i] - x) * 0.5);
      }
      e.t = now;
      e.tgt.pos = h.pos.slice();
      e.tgt.yaw = h.yaw || 0;
      e.leader = h.leader;
      if (e.alive && !h.alive) this.play(e, 'death', 0.1);
      if (!e.alive && h.alive) { if (e.mixer) e.mixer.stopAllAction(); e.clip = null; this.play(e, 'idle', 0); e.cur.pos = h.pos.slice(); }
      e.alive = h.alive;
      e.rescued = h.rescued;
    }
    for (const id of [...this.list.keys()]) if (!seen.has(id)) this.remove(id);
  }

  remove(id) {
    const e = this.list.get(id);
    if (!e) return;
    this.scene.remove(e.group);
    if (e.mixer) e.mixer.stopAllAction();
    this.list.delete(id);
  }

  clear() { for (const id of [...this.list.keys()]) this.remove(id); this.setZones([]); }

  update(dt) {
    const t = Math.min(1, dt * 12);
    const now = performance.now() / 1000;
    for (const e of this.list.values()) {
      e.group.visible = !e.rescued;
      for (let i = 0; i < 3; i++) e.cur.pos[i] += (e.tgt.pos[i] - e.cur.pos[i]) * t;
      let dy = e.tgt.yaw - e.cur.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      e.cur.yaw += dy * t;
      e.group.position.set(...e.cur.pos);
      e.group.rotation.y = e.cur.yaw;
      const nv = e.t !== undefined && now - e.t < 0.3 ? e.netVel : [0, 0, 0];
      for (let i = 0; i < 3; i++) e.vel[i] += (nv[i] - e.vel[i]) * Math.min(1, dt * 8);
      const speed = Math.hypot(e.vel[0], e.vel[2]);
      if (e.alive) this.play(e, speed > 160 ? 'run' : speed > 20 ? 'walk' : 'idle');
      if (e.mixer) {
        const act = e.actions[e.clip];
        if (act && STRIDE[e.clip]) act.setEffectiveTimeScale(Math.max(0.35, Math.min(2.4, speed * act.getClip().duration / STRIDE[e.clip])));
        e.mixer.update(dt);
      }
      e.lightT -= dt;
      if (e.lightT <= 0 && this.world) {
        e.lightT = 0.25;
        e.lightTarget = this.world.sampleLight(e.cur.pos);
      }
      if (e.lightTarget !== undefined) {
        e.light += (e.lightTarget - e.light) * Math.min(1, dt * 5);
        e.group.traverse((o) => { if (o.material && o.material.color) o.material.color.setScalar(e.light); });
      }
    }
  }

  // live, unrescued hostages (bullet impact effects, the E prompt, radar)
  alive() { return [...this.list.values()].filter((e) => e.alive && !e.rescued); }

  targets() { return this.alive().map((e) => ({ id: e.id, pos: e.cur.pos, crouching: false })); }

  dispose() { this.clear(); }
}
