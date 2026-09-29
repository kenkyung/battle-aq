// Remote players: the Blender soldier models (soldier_t / soldier_ct.glb),
// smoothly interpolated between server snapshots. No local simulation — they
// render where the server says they are.
//
// Animation clips (idle / walk / run / crouch_idle / crouch_walk / death) are
// cross-faded from the replicated state; aim pitch bends the spine and chest
// on top of the clip. The held gun is the same weapons.glb model the owner
// sees in first person, attached to the chest bone.

import * as THREE from 'three';
import { clone as cloneSkinned } from '../vendor/addons/utils/SkeletonUtils.js';
import { TEAM } from '../shared/constants.js';
import { Models, weaponModel } from './assets.js';

// Right-hand grip in model space (three.js coords; Blender (3.8, 13.4, 49.4)).
const GRIP = new THREE.Vector3(3.8, 49.6, -13.4);

function makeNameSprite(name, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 30px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(name, 128, 42);
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 42);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.scale.set(64, 16, 1);
  spr.renderOrder = 5;
  return spr;
}

export class Remotes {
  constructor(scene, fx, world) {
    this.scene = scene;
    this.fx = fx;
    this.world = world;
    this.players = new Map();
    this.myTeam = TEAM.T;
    this.hiddenId = null; // spectated player (first person) is not drawn
    this.sfx = null;      // set by main.js
    this.surfaceAt = () => 'sand';
    this._v = new THREE.Vector3();
  }

  ensure(p) {
    let r = this.players.get(p.id);
    if (r && p.team && r.team !== p.team) { this.remove(p.id); r = null; }
    if (r) return r;
    const team = p.team || TEAM.T;
    const src = Models.soldiers[team];
    const group = new THREE.Group();
    let model = null, mixer = null, actions = {}, bones = {};
    if (src) {
      model = cloneSkinned(src.scene);
      model.traverse((o) => {
        if (o.isSkinnedMesh || o.isMesh) {
          o.material = new THREE.MeshLambertMaterial({ map: o.material.map });
          o.frustumCulled = false;
        }
        if (o.isBone) bones[o.name] = o;
      });
      group.add(model);
      mixer = new THREE.AnimationMixer(model);
      for (const clip of src.animations) {
        const a = mixer.clipAction(clip);
        if (clip.name === 'death') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
        actions[clip.name] = a;
      }
    } else {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(16, 40, 4, 8),
        new THREE.MeshLambertMaterial({ color: team === TEAM.CT ? 0x5e83b0 : 0xb08a5e }));
      m.position.y = 36;
      group.add(m);
    }
    const tag = makeNameSprite(p.name || `#${p.id}`, team === TEAM.CT ? '#a8ccf0' : '#f0d0a8');
    tag.position.y = 84;
    group.add(tag);
    this.scene.add(group);

    r = {
      id: p.id, team, name: p.name || `#${p.id}`, group, model, mixer, actions, bones, tag,
      cur: { pos: [...p.pos], yaw: p.yaw || 0, pitch: 0 },
      tgt: { pos: [...p.pos], yaw: p.yaw || 0, pitch: 0, crouching: false },
      alive: p.alive !== false, weapon: null, gun: null, muzzle: null,
      clip: null, speed: 0, light: 1, lightT: Math.random() * 0.3,
    };
    this.players.set(p.id, r);
    this.setWeapon(r, p.weapon || 'knife');
    this.play(r, r.alive ? 'idle' : 'death', 0);
    return r;
  }

  setWeapon(r, id) {
    if (r.weapon === id || !r.model) return;
    r.weapon = id;
    if (r.gun) r.gun.parent.remove(r.gun);
    const gun = weaponModel(id);
    if (!gun) return;
    gun.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshLambertMaterial({ map: o.material.map }); });
    // Place it at the grip in model space while the rig is at rest, then let
    // the chest bone carry it (attach() keeps the world transform).
    const chest = r.bones.chest;
    const pose = this._atRest(r);
    gun.position.copy(GRIP);
    r.model.add(gun);
    r.model.updateMatrixWorld(true);
    if (chest) chest.attach(gun);
    pose();
    r.gun = gun;
    r.muzzle = gun.getObjectByName(`${id}_muzzle`) || gun;
  }

  // Temporarily return the skeleton to its bind pose; returns a restore fn.
  _atRest(r) {
    const saved = [];
    r.model.traverse((o) => {
      if (o.isBone) {
        saved.push([o, o.position.clone(), o.quaternion.clone()]);
      }
    });
    const skinned = r.model.getObjectByProperty('isSkinnedMesh', true);
    if (skinned) skinned.skeleton.pose();
    r.group.updateMatrixWorld(true);
    return () => {
      for (const [o, p, q] of saved) { o.position.copy(p); o.quaternion.copy(q); }
    };
  }

  play(r, name, fade = 0.2) {
    if (!r.mixer || r.clip === name || !r.actions[name]) return;
    const next = r.actions[name];
    next.reset().play();
    if (r.clip && r.actions[r.clip]) r.actions[r.clip].crossFadeTo(next, fade, false);
    r.clip = name;
  }

  remove(id) {
    const r = this.players.get(id);
    if (!r) return;
    this.scene.remove(r.group);
    if (r.mixer) r.mixer.stopAllAction();
    this.players.delete(id);
  }

  clear() { for (const id of [...this.players.keys()]) this.remove(id); }

  setTarget(p) {
    const r = this.ensure(p);
    if (p.reloading && !r.reloading && this.sfx) this.sfx.playAt('mag_out', r.cur.pos.map((v, i) => v + (i === 1 ? 48 : 0)), { volume: 0.6, max: 1400 });
    r.reloading = !!p.reloading;
    if (p.name) r.name = p.name;
    r.tgt.pos = [...p.pos];
    r.tgt.yaw = p.yaw || 0;
    r.tgt.pitch = p.pitch || 0;
    r.tgt.crouching = !!p.crouching;
    r.moving = !!p.moving;
    const alive = p.alive !== false;
    if (!alive && r.alive) this.play(r, 'death', 0.1);
    if (alive && !r.alive) { r.cur.pos = [...p.pos]; r.clip = null; this.play(r, 'idle', 0); }
    r.alive = alive;
    if (p.weapon) this.setWeapon(r, p.weapon);
  }

  // A remote player fired: flash at their muzzle, tracer + impacts from it.
  onShoot(msg, others) {
    const r = this.players.get(msg.id);
    let muzzle = null;
    if (r && r.muzzle) {
      r.muzzle.getWorldPosition(this._v);
      muzzle = [this._v.x, this._v.y, this._v.z];
      if (r.weapon !== 'knife') this.fx.muzzleFlash(muzzle, 12);
    }
    if (this.sfx) {
      const at = muzzle || msg.origin;
      if (msg.weapon === 'knife') this.sfx.playAt('knife_slash', at, { volume: 0.7, max: 1200 });
      else this.sfx.playAt(`fire_${msg.weapon}`, at, { volume: 1, ref: 260, max: 7000 });
    }
    if (msg.weapon === 'knife') return;
    this.fx.shot(msg.origin, msg.dir, muzzle, others, msg.id);
  }

  update(dt, cameraPos) {
    const t = Math.min(1, dt * 12);
    for (const r of this.players.values()) {
      const prev = r.cur.pos.slice();
      for (let i = 0; i < 3; i++) r.cur.pos[i] += (r.tgt.pos[i] - r.cur.pos[i]) * t;
      let dy = r.tgt.yaw - r.cur.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      r.cur.yaw += dy * t;
      r.cur.pitch += (r.tgt.pitch - r.cur.pitch) * t;
      r.group.position.set(r.cur.pos[0], r.cur.pos[1], r.cur.pos[2]);
      r.group.rotation.y = r.cur.yaw;
      r.group.visible = r.id !== this.hiddenId;

      const sp = Math.hypot(r.cur.pos[0] - prev[0], r.cur.pos[2] - prev[2]) / Math.max(dt, 1e-3);
      r.speed += (sp - r.speed) * Math.min(1, dt * 8);
      if (r.alive) {
        let clip = 'idle';
        if (r.tgt.crouching) clip = r.speed > 20 ? 'crouch_walk' : 'crouch_idle';
        else if (r.speed > 150) clip = 'run';
        else if (r.speed > 20) clip = 'walk';
        this.play(r, clip);
      }
      // running feet are audible through the map, as in CS
      if (this.sfx && r.alive && r.speed > 150 && !r.tgt.crouching && Math.abs(r.cur.pos[1] - prev[1]) < 2) {
        r.stepDist = (r.stepDist || 0) + r.speed * dt;
        if (r.stepDist > 88) {
          r.stepDist = 0;
          const v = Math.floor(Math.random() * 4);
          this.sfx.playAt(`step_${this.surfaceAt(r.cur.pos)}_${v}`, [r.cur.pos[0], r.cur.pos[1] + 4, r.cur.pos[2]], { volume: 0.9, ref: 110, max: 2600 });
        }
      }
      if (r.mixer) {
        const scale = r.clip === 'run' ? Math.max(0.6, r.speed / 250) : r.clip === 'walk' ? Math.max(0.6, r.speed / 110) : 1;
        r.mixer.timeScale = scale;
        r.mixer.update(dt);
        // aim pitch on top of the clip
        if (r.alive) {
          const p = Math.max(-1.2, Math.min(1.2, r.cur.pitch));
          if (r.bones.spine) r.bones.spine.rotateX(-p * 0.35);
          if (r.bones.chest) r.bones.chest.rotateX(-p * 0.55);
          if (r.bones.head) r.bones.head.rotateX(-p * 0.1);
        }
      }
      r.tag.visible = r.alive && r.team === this.myTeam;

      // lightmap tint, refreshed a few times a second
      r.lightT -= dt;
      if (r.lightT <= 0 && this.world) {
        r.lightT = 0.25;
        r.lightTarget = this.world.sampleLight(r.cur.pos);
      }
      if (r.lightTarget !== undefined) {
        r.light += (r.lightTarget - r.light) * Math.min(1, dt * 5);
        r.group.traverse((o) => { if (o.material && o.material.color && !o.isSprite) o.material.color.setScalar(r.light); });
      }
    }
  }

  // list for effects raycasts
  targets() {
    const out = [];
    for (const r of this.players.values()) {
      if (r.alive) out.push({ id: r.id, pos: r.cur.pos, crouching: r.tgt.crouching });
    }
    return out;
  }
}
