// Combat effects: tracers, impact decals, dust / sparks / blood puffs and
// muzzle flashes. Everything is pooled — no allocation per shot — so a full
// magazine dump costs the same every time.

import * as THREE from 'three';
import { raycast, raycastPlayers, hitBox } from '../shared/physics.js';
import { puffTexture, bulletHoleTexture, flashTexture } from './textures.js';

const MAX_DECALS = 160;
const MAX_PUFFS = 96;
const MAX_TRACERS = 24;

const SPARK_MATS = new Set(['metal']);
const WOOD_MATS = new Set(['wood', 'cover']);

export class Effects {
  constructor(scene, map, colliders) {
    this.scene = scene;
    this.sfx = null;               // set by main.js
    this.surfaceOf = () => 'stone';
    this.map = map;
    this.colliders = colliders;
    this.group = new THREE.Group();
    this.group.name = 'fx';
    scene.add(this.group);

    // --- decals: instanced quads (one draw call for all bullet holes)
    const holeMat = new THREE.MeshBasicMaterial({
      map: bulletHoleTexture(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), holeMat, MAX_DECALS);
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 3;
    this.decalNext = 0;
    this.group.add(this.decals);

    // --- puffs: sprites (dust, sparks, blood, smoke)
    const puffTex = puffTexture();
    this.puffs = [];
    for (let i = 0; i < MAX_PUFFS; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true, depthWrite: false }));
      s.visible = false;
      s.userData = { life: 0, max: 1, vel: new THREE.Vector3(), grow: 0, gravity: 0 };
      this.group.add(s);
      this.puffs.push(s);
    }
    this.puffNext = 0;

    // --- tracers: thin additive quads stretched along the shot
    const trMat = new THREE.MeshBasicMaterial({
      color: 0xffe2a0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const trGeo = new THREE.BoxGeometry(0.5, 0.5, 1);
    trGeo.translate(0, 0, -0.5);
    this.tracers = [];
    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = new THREE.Mesh(trGeo, trMat);
      m.visible = false;
      m.userData = { from: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0, t: 0 };
      this.group.add(m);
      this.tracers.push(m);
    }
    this.trNext = 0;

    // --- muzzle flashes in the world (remote players)
    this.flashTex = flashTexture();
    this.flashes = [];
    for (let i = 0; i < 8; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      }));
      s.visible = false;
      s.userData = { life: 0 };
      this.group.add(s);
      this.flashes.push(s);
    }
    this.flashNext = 0;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._z = new THREE.Vector3(0, 0, 1);
  }

  // A shot from `from` along `dir`: tracer + whatever it hits. `players` is
  // [{id, pos, crouching}] for blood (the server decides real damage).
  shot(from, dir, muzzle, players = [], excludeId = null, { tracer = true } = {}) {
    const world = raycast(from, dir, this.colliders, 8192);
    const boxes = players.map((p) => ({ id: p.id, box: hitBox(p.pos, p.crouching) }));
    const ph = boxes.length ? raycastPlayers(from, dir, boxes, 8192, excludeId) : null;
    let end;
    if (ph && (!world || ph.t < world.t)) {
      end = ph.point;
      this.blood(end, dir);
    } else if (world) {
      end = world.point;
      this.impact(world.point, normalOf(world.point, world.box), world.box.mat);
    } else {
      end = [from[0] + dir[0] * 6000, from[1] + dir[1] * 6000, from[2] + dir[2] * 6000];
    }
    if (tracer) this.tracer(muzzle || from, end);
  }

  tracer(from, to) {
    const t = this.tracers[this.trNext++ % MAX_TRACERS];
    const d = t.userData;
    d.from.set(from[0], from[1], from[2]);
    d.dir.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    d.dist = d.dir.length();
    if (d.dist < 40) return;
    d.dir.divideScalar(d.dist);
    d.t = 0;
    t.visible = true;
  }

  impact(point, normal, mat) {
    if (this.sfx) {
      const s = this.surfaceOf(mat);
      const name = s === 'metal' ? 'impact_metal' : s === 'wood' ? 'impact_wood' : s === 'sand' ? 'impact_dirt' : 'impact_stone';
      this.sfx.playAt(name, point, { volume: 0.45, ref: 90, max: 1800, occlude: false });
      if ((s === 'metal' || s === 'stone') && Math.random() < 0.12) this.sfx.playAt('ricochet', point, { volume: 0.35, ref: 120, max: 2000, occlude: false });
    }
    // decal, aligned to the surface
    const s = 3.2 + Math.random() * 1.6;
    this._q.setFromUnitVectors(this._z, this._v.set(normal[0], normal[1], normal[2]));
    const spin = new THREE.Quaternion().setFromAxisAngle(this._v, Math.random() * Math.PI * 2);
    this._q.premultiply(spin);
    this._m.compose(
      new THREE.Vector3(point[0] + normal[0] * 0.2, point[1] + normal[1] * 0.2, point[2] + normal[2] * 0.2),
      this._q, new THREE.Vector3(s, s, s));
    this.decals.setMatrixAt(this.decalNext % MAX_DECALS, this._m);
    this.decalNext++;
    this.decals.count = Math.min(MAX_DECALS, this.decalNext);
    this.decals.instanceMatrix.needsUpdate = true;

    // debris
    const color = this.map.palette[mat] ?? 0x9a8a70;
    const base = new THREE.Color(color).multiplyScalar(0.9);
    for (let i = 0; i < 3; i++) {
      this.puff(point, [normal[0] * 40 + rnd(30), normal[1] * 40 + rnd(30) + 20, normal[2] * 40 + rnd(30)],
        base, 6 + Math.random() * 6, 0.5 + Math.random() * 0.4, 18, -60);
    }
    if (SPARK_MATS.has(mat)) {
      for (let i = 0; i < 4; i++) {
        this.puff(point, [normal[0] * 180 + rnd(160), normal[1] * 180 + rnd(160) + 80, normal[2] * 180 + rnd(160)],
          new THREE.Color(1.0, 0.75, 0.35), 1.6, 0.25, 0, 500, true);
      }
    } else if (WOOD_MATS.has(mat)) {
      for (let i = 0; i < 3; i++) {
        this.puff(point, [normal[0] * 120 + rnd(90), normal[1] * 120 + rnd(90) + 60, normal[2] * 120 + rnd(90)],
          new THREE.Color(0.45, 0.32, 0.2), 1.8, 0.6, 0, 600);
      }
    }
  }

  blood(point, dir) {
    for (let i = 0; i < 4; i++) {
      this.puff(point, [dir[0] * 60 + rnd(50), rnd(40) + 10, dir[2] * 60 + rnd(50)],
        new THREE.Color(0.45, 0.02, 0.02), 5 + Math.random() * 5, 0.45, 14, 120);
    }
  }

  puff(pos, vel, color, size, life, grow = 10, gravity = 0, additive = false) {
    const s = this.puffs[this.puffNext++ % MAX_PUFFS];
    const d = s.userData;
    s.position.set(pos[0], pos[1], pos[2]);
    d.vel.set(vel[0], vel[1], vel[2]);
    d.life = d.max = life;
    d.grow = grow;
    d.gravity = gravity;
    s.material.color.copy(color);
    s.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    s.material.opacity = 1;
    s.scale.set(size, size, 1);
    s.visible = true;
  }

  muzzleFlash(pos, size = 14) {
    const s = this.flashes[this.flashNext++ % this.flashes.length];
    s.position.set(pos[0], pos[1], pos[2]);
    s.scale.set(size, size, 1);
    s.material.rotation = Math.random() * Math.PI;
    s.userData.life = 0.05;
    s.visible = true;
    this.puff(pos, [rnd(10), 14, rnd(10)], new THREE.Color(0.55, 0.55, 0.55), 5, 0.6, 16, -10);
  }

  update(dt) {
    for (const s of this.puffs) {
      if (!s.visible) continue;
      const d = s.userData;
      d.life -= dt;
      if (d.life <= 0) { s.visible = false; continue; }
      d.vel.y -= d.gravity * dt;
      d.vel.multiplyScalar(1 - Math.min(1, dt * 2.5));
      s.position.addScaledVector(d.vel, dt);
      const k = 1 + d.grow * dt / Math.max(1, s.scale.x);
      s.scale.x *= k; s.scale.y *= k;
      s.material.opacity = Math.min(1, d.life / d.max * 1.6);
    }
    const SPEED = 9000, LEN = 160;
    for (const t of this.tracers) {
      if (!t.visible) continue;
      const d = t.userData;
      d.t += dt * SPEED;
      const head = Math.min(d.t, d.dist);
      const tail = Math.max(0, d.t - LEN);
      if (tail >= d.dist) { t.visible = false; continue; }
      t.position.copy(d.from).addScaledVector(d.dir, head);
      t.lookAt(this._v.copy(d.from).addScaledVector(d.dir, head + 1));
      t.scale.set(1, 1, Math.max(1, head - tail));
    }
    for (const f of this.flashes) {
      if (!f.visible) continue;
      f.userData.life -= dt;
      if (f.userData.life <= 0) f.visible = false;
    }
  }

  dispose() {
    this.scene.remove(this.group);
  }
}

const rnd = (s) => (Math.random() - 0.5) * 2 * s;

// Outward normal of the AABB face nearest to a point on its surface.
export function normalOf(p, b) {
  const d = [
    [Math.abs(p[0] - b.min[0]), [-1, 0, 0]], [Math.abs(p[0] - b.max[0]), [1, 0, 0]],
    [Math.abs(p[1] - b.min[1]), [0, -1, 0]], [Math.abs(p[1] - b.max[1]), [0, 1, 0]],
    [Math.abs(p[2] - b.min[2]), [0, 0, -1]], [Math.abs(p[2] - b.max[2]), [0, 0, 1]],
  ];
  d.sort((a, c) => a[0] - c[0]);
  return d[0][1];
}
