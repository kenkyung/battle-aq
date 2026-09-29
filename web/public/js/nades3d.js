// Grenades in the world: each throw the server announces is flown locally
// with the same shared physics (so it bounces where the server's does), then
// replaced by its effect when the server says it went off:
//   HE     fireball, smoke, debris, shake
//   flash  a white pop (the blinding itself is the server's 'flashed' message)
//   smoke  a billowing grey cloud that lasts ~18 s

import * as THREE from 'three';
import { stepNade, newNade } from '../shared/grenades.js';
import { weaponModel } from './assets.js';
import { puffTexture } from './textures.js';

class SmokeCloud {
  constructor(scene, pos, seconds) {
    this.group = new THREE.Group();
    this.group.position.set(pos[0], pos[1], pos[2]);
    this.t = 0; this.life = seconds;
    const tex = puffTexture();
    this.puffs = [];
    for (let i = 0; i < 34; i++) {
      const m = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(0.66, 0.66, 0.64).multiplyScalar(0.85 + Math.random() * 0.2), transparent: true, depthWrite: false, opacity: 0 });
      const s = new THREE.Sprite(m);
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 125;
      s.userData = { tx: Math.cos(a) * r, ty: 20 + Math.random() * 90, tz: Math.sin(a) * r, size: 110 + Math.random() * 90, spin: (Math.random() - 0.5) * 0.2 };
      this.group.add(s);
      this.puffs.push(s);
    }
    scene.add(this.group);
    this.scene = scene;
  }

  update(dt) {
    this.t += dt;
    const grow = Math.min(1, this.t / 1.6);
    const fade = this.t > this.life - 3 ? Math.max(0, (this.life - this.t) / 3) : 1;
    for (const s of this.puffs) {
      const u = s.userData;
      s.position.set(u.tx * grow, u.ty * (0.3 + 0.7 * grow), u.tz * grow);
      const size = u.size * (0.3 + 0.7 * grow);
      s.scale.set(size, size, 1);
      s.material.rotation += u.spin * dt;
      s.material.opacity = 0.92 * fade * Math.min(1, this.t * 3);
    }
    return this.t < this.life;
  }

  dispose() { this.scene.remove(this.group); }
}

export class NadeView {
  constructor(scene, fx, sfx, colliders) {
    this.scene = scene; this.fx = fx; this.sfx = sfx; this.colliders = colliders;
    this.flying = new Map();   // id -> { n, mesh }
    this.smokes = [];
    this.shake = 0;
  }

  thrown(msg) {
    const n = newNade(msg.kind, msg.pos, msg.vel);
    let mesh = weaponModel(msg.kind);
    if (mesh) mesh.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshLambertMaterial({ map: o.material.map }); });
    else mesh = new THREE.Mesh(new THREE.SphereGeometry(2.2, 8, 6), new THREE.MeshLambertMaterial({ color: 0x3a4a30 }));
    mesh.position.set(...msg.pos);
    this.scene.add(mesh);
    this.flying.set(msg.id, { n, mesh, spin: new THREE.Vector3(Math.random() * 12, Math.random() * 12, 0) });
  }

  boom(msg, listener) {
    const f = this.flying.get(msg.id);
    if (f) { this.scene.remove(f.mesh); this.flying.delete(msg.id); }
    const p = msg.pos;
    const up = [p[0], p[1] + 10, p[2]];
    if (msg.kind === 'hegrenade') {
      this.fx.muzzleFlash(up, 260);
      for (let i = 0; i < 26; i++) {
        const a = Math.random() * Math.PI * 2, u = Math.random();
        this.fx.puff(up, [Math.cos(a) * 420 * (1 - u), 120 + u * 420, Math.sin(a) * 420 * (1 - u)], new THREE.Color(1, 0.6 + Math.random() * 0.3, 0.25), 40 + Math.random() * 50, 0.35 + Math.random() * 0.3, 90, 60, true);
      }
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2;
        this.fx.puff(up, [Math.cos(a) * 160, 60 + Math.random() * 160, Math.sin(a) * 160], new THREE.Color(0.2, 0.19, 0.18), 50 + Math.random() * 60, 1.8 + Math.random(), 50, -10);
      }
      this.sfx.playAt('he_explode', up, { volume: 1, ref: 500, max: 9000, occlude: false, jitter: 0.03 });
      if (listener) this.shake = Math.max(this.shake, Math.max(0, 1 - Math.hypot(p[0] - listener[0], p[2] - listener[2]) / 900));
    } else if (msg.kind === 'flashbang') {
      this.fx.muzzleFlash(up, 180);
      this.sfx.playAt('flash_pop', up, { volume: 1, ref: 400, max: 7000, occlude: false });
    } else if (msg.kind === 'smokegrenade') {
      this.smokes.push(new SmokeCloud(this.scene, p, msg.duration || 18));
      this.sfx.playAt('smoke_hiss', up, { volume: 0.8, ref: 250, max: 3000 });
    }
  }

  addSmoke(pos, secondsLeft) { this.smokes.push(Object.assign(new SmokeCloud(this.scene, [pos[0], pos[1] - 40, pos[2]], secondsLeft), { t: 1.6 })); }

  update(dt) {
    for (const f of this.flying.values()) {
      if (stepNade(f.n, dt, this.colliders)) this.sfx.playAt('bounce', f.n.pos, { volume: 0.7, ref: 120, max: 2500 });
      f.mesh.position.set(...f.n.pos);
      if (!f.n.rest) { f.mesh.rotation.x += f.spin.x * dt; f.mesh.rotation.y += f.spin.y * dt; }
    }
    this.smokes = this.smokes.filter((s) => { const alive = s.update(dt); if (!alive) s.dispose(); return alive; });
    this.shake = Math.max(0, this.shake - dt * 2);
  }

  clear() {
    for (const f of this.flying.values()) this.scene.remove(f.mesh);
    this.flying.clear();
    for (const s of this.smokes) s.dispose();
    this.smokes = [];
  }
}
