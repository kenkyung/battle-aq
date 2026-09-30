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
import { bodyBox } from '../shared/physics.js';
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

const AIM_BONES = ['hips', 'spine', 'chest', 'head'];
// Ground distance one loop of each locomotion clip covers (printed by
// art/blender/build_characters.py): playback is scaled to the actual speed so
// the feet stay planted instead of skating.
const STRIDE = { walk: 61.4, run: 90, crouch_walk: 27.2 };
const MAX_GAIT = 1.25;   // legs may turn up to ~72 degrees off the aim (CS gait yaw)

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
          o.material = new THREE.MeshLambertMaterial({ map: o.material.map, normalMap: o.material.normalMap || null });
          o.frustumCulled = false;
        }
        if (o.isBone) { bones[o.name] = o; o.userData.rest = o.quaternion.clone(); }
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

  setWeapon(r, id, mode = null) {
    const mid = mode === 'silenced' && weaponModel(id + '_s') ? id + '_s' : id;
    if ((r.weapon === id && r.modelId === mid) || !r.model) return;
    r.weapon = id;
    r.modelId = mid;
    r.mode = mode;
    if (r.gun) r.gun.parent.remove(r.gun);
    const gun = weaponModel(mid);
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
    r.muzzle = gun.getObjectByName(`${mid}_muzzle`) || gun;
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

  // Switch clip: every other clip that still has weight fades out (not just
  // the last one), so no pose — the clamped death pose above all — can linger
  // underneath and bend the body.
  play(r, name, fade = 0.2) {
    if (!r.mixer || r.clip === name || !r.actions[name]) return;
    const next = r.actions[name];
    for (const [n, a] of Object.entries(r.actions)) {
      if (n === name || !a.isRunning()) continue;
      if (fade > 0) a.fadeOut(fade); else a.stop();
    }
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    if (fade > 0) next.fadeIn(fade);
    r.clip = name;
  }

  // a fresh start for the rig (respawn): nothing left over from the death clip
  resetPose(r) {
    if (!r.mixer) return;
    r.mixer.stopAllAction();
    r.clip = null;
    r.gait = 0;
    this.play(r, 'idle', 0);
  }

  remove(id) {
    const r = this.players.get(id);
    if (!r) return;
    this.scene.remove(r.group);
    if (r.mixer) r.mixer.stopAllAction();
    this.players.delete(id);
  }

  clear() { for (const id of [...this.players.keys()]) this.remove(id); }

  // p: a snapshot entry; ts: the snapshot's server time (seconds)
  setTarget(p, ts) {
    const r = this.ensure(p);
    if (Number.isFinite(ts)) {
      r.buf = r.buf || [];
      if (!r.buf.length || ts > r.buf[r.buf.length - 1].ts) r.buf.push({ ts, pos: [...p.pos], yaw: p.yaw || 0, pitch: p.pitch || 0, crouching: !!p.crouching });
      if (r.buf.length > 30) r.buf.shift();
    }
    if (p.reloading && !r.reloading && this.sfx) this.sfx.playAt('mag_out', r.cur.pos.map((v, i) => v + (i === 1 ? 48 : 0)), { volume: 0.6, max: 1400 });
    r.reloading = !!p.reloading;
    if (p.name) r.name = p.name;
    // velocity from successive snapshots over wall-clock time (frame dt is
    // clamped by the render loop, so per-frame deltas lie on slow machines)
    const now = performance.now() / 1000;
    if (r.tgtT !== undefined && now - r.tgtT > 0.015) {
      const w = 1 / (now - r.tgtT);
      let v = [(p.pos[0] - r.tgt.pos[0]) * w, (p.pos[1] - r.tgt.pos[1]) * w, (p.pos[2] - r.tgt.pos[2]) * w];
      if (Math.hypot(v[0], v[2]) > 700) v = [0, 0, 0];     // respawn / teleport
      r.netVel = r.netVel ? r.netVel.map((x, i) => x + (v[i] - x) * 0.5) : v;
    }
    r.tgtT = now;
    r.tgt.pos = [...p.pos];
    r.tgt.yaw = p.yaw || 0;
    r.tgt.pitch = p.pitch || 0;
    r.tgt.crouching = !!p.crouching;
    r.moving = !!p.moving;
    const alive = p.alive !== false;
    if (!alive && r.alive) this.play(r, 'death', 0.1);
    if (alive && !r.alive) { r.cur.pos = [...p.pos]; this.resetPose(r); }
    r.alive = alive;
    if (p.weapon) this.setWeapon(r, p.weapon, p.mode || null);
  }

  // A remote player fired: flash at their muzzle, tracer + impacts from it.
  onShoot(msg, others) {
    const r = this.players.get(msg.id);
    let muzzle = null;
    const silenced = msg.mode === 'silenced';
    if (r && r.muzzle) {
      r.muzzle.getWorldPosition(this._v);
      muzzle = [this._v.x, this._v.y, this._v.z];
      if (r.weapon !== 'knife' && !silenced) this.fx.muzzleFlash(muzzle, 12);
    }
    if (this.sfx) {
      const at = muzzle || msg.origin;
      if (msg.weapon === 'knife') this.sfx.playAt(msg.mode === 'stab' ? 'knife_stab' : 'knife_slash', at, { volume: 0.7, max: 1200 });
      // a suppressed shot is quiet and carries a short way
      else if (silenced) this.sfx.playAt(`fire_${msg.weapon}_s`, at, { volume: 0.7, ref: 120, max: 1800 });
      else this.sfx.playAt(`fire_${msg.weapon}`, at, { volume: 1, ref: 260, max: 7000 });
    }
    if (msg.weapon === 'knife') return;
    const dirs = msg.dirs || [msg.dir];
    dirs.forEach((d, k) => this.fx.shot(msg.origin, d, k === 0 ? muzzle : null, others, msg.id, { tracer: k === 0, exits: k === 0 ? msg.exits : null }));
  }

  // Interpolation (M11): each remote is drawn where it was at the view time
  // (server time - cl_interp), between the two snapshots around it — the
  // same moment the server rewinds to when we shoot (lag compensation).
  interpolate(r, rt) {
    const b = r.buf;
    let i = b.length - 1;
    while (i > 0 && b[i].ts > rt) i--;
    const a = b[i], c = b[Math.min(b.length - 1, i + 1)];
    if (a === c || rt <= a.ts || c.ts <= a.ts) {
      const e = rt <= a.ts ? a : c;
      r.cur.pos = e.pos.slice(); r.cur.yaw = e.yaw; r.cur.pitch = e.pitch; r.icrouch = e.crouching;
      r.ivel = [0, 0, 0];
      return;
    }
    const f = Math.min(1, (rt - a.ts) / (c.ts - a.ts));
    const jump = Math.hypot(c.pos[0] - a.pos[0], c.pos[2] - a.pos[2]) > 220;     // respawn / teleport
    const k = jump ? (f < 0.5 ? 0 : 1) : f;
    r.cur.pos = [0, 1, 2].map((j) => a.pos[j] + (c.pos[j] - a.pos[j]) * k);
    let dy = c.yaw - a.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    r.cur.yaw = a.yaw + dy * f;
    r.cur.pitch = a.pitch + (c.pitch - a.pitch) * f;
    r.icrouch = f < 0.5 ? a.crouching : c.crouching;
    const w = jump ? 0 : 1 / (c.ts - a.ts);
    r.ivel = [0, 1, 2].map((j) => (c.pos[j] - a.pos[j]) * w);
  }

  update(dt, cameraPos) {
    const t = Math.min(1, dt * 12);
    const rt = this.renderTime ? this.renderTime() : null;
    for (const r of this.players.values()) {
      const prev = r.cur.pos.slice();
      if (rt !== null && r.buf && r.buf.length) this.interpolate(r, rt);
      else {
        // no timeline yet: chase the latest target (a big jump snaps)
        if (Math.hypot(r.tgt.pos[0] - r.cur.pos[0], r.tgt.pos[2] - r.cur.pos[2]) > 220) r.cur.pos = r.tgt.pos.slice();
        for (let i = 0; i < 3; i++) r.cur.pos[i] += (r.tgt.pos[i] - r.cur.pos[i]) * t;
        let dy = r.tgt.yaw - r.cur.yaw;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        r.cur.yaw += dy * t;
        r.cur.pitch += (r.tgt.pitch - r.cur.pitch) * t;
        r.ivel = null;
      }
      r.group.position.set(r.cur.pos[0], r.cur.pos[1], r.cur.pos[2]);
      r.group.rotation.y = r.cur.yaw;
      r.group.visible = r.id !== this.hiddenId;

      // smoothed ground velocity -> speed, and its direction relative to the aim
      const k = Math.min(1, dt * 8);
      r.vel = r.vel || [0, 0, 0];
      const nv = r.ivel || (r.tgtT !== undefined && performance.now() / 1000 - r.tgtT < 0.3 && r.netVel) || [0, 0, 0];
      for (let i = 0; i < 3; i++) r.vel[i] += (nv[i] - r.vel[i]) * k;
      r.speed = Math.hypot(r.vel[0], r.vel[2]);
      let gaitTarget = 0;
      r.backwards = false;
      if (r.speed > 20) {
        const sy = Math.sin(r.cur.yaw), cy = Math.cos(r.cur.yaw);
        const fwd = -r.vel[0] * sy - r.vel[2] * cy;          // along the aim
        const right = r.vel[0] * cy - r.vel[2] * sy;         // to its right
        let a = Math.atan2(right, fwd);
        // moving mostly backwards: face the legs forward and play the cycle in reverse
        if (Math.abs(a) > 1.75) { a -= Math.sign(a) * Math.PI; r.backwards = true; }
        gaitTarget = Math.max(-MAX_GAIT, Math.min(MAX_GAIT, a));
      }
      r.gait = (r.gait || 0) + (gaitTarget - (r.gait || 0)) * Math.min(1, dt * 10);
      if (r.alive) {
        let clip = 'idle';
        const air = !(r.icrouch ?? r.tgt.crouching) && Math.abs(r.vel[1]) > 150;
        if (air) clip = 'jump';
        else if ((r.icrouch ?? r.tgt.crouching)) clip = r.speed > 20 ? 'crouch_walk' : 'crouch_idle';
        else if (r.speed > 150) clip = 'run';
        else if (r.speed > 20) clip = 'walk';
        this.play(r, clip, air ? 0.12 : 0.2);
      }
      // running feet are audible through the map, as in CS
      if (this.sfx && r.alive && r.speed > 150 && !(r.icrouch ?? r.tgt.crouching) && Math.abs(r.cur.pos[1] - prev[1]) < 2) {
        r.stepDist = (r.stepDist || 0) + r.speed * dt;
        if (r.stepDist > 88) {
          r.stepDist = 0;
          const v = Math.floor(Math.random() * 4);
          this.sfx.playAt(`step_${this.surfaceAt(r.cur.pos)}_${v}`, [r.cur.pos[0], r.cur.pos[1] + 4, r.cur.pos[2]], { volume: 0.5, ref: 90, max: 2200 });
        }
      }
      if (r.mixer) {
        // feet planted: one loop per STRIDE units travelled; backwards = reversed
        const act = r.actions[r.clip];
        if (act && STRIDE[r.clip]) {
          const rate = Math.max(0.35, Math.min(2.4, r.speed * act.getClip().duration / STRIDE[r.clip]));
          act.setEffectiveTimeScale(r.backwards ? -rate : rate);
        }
        // the aim tilt below is added on top of the clip every frame; a bone the
        // clip does not key would keep the previous frame's tilt and slowly
        // fold the body backwards, so start each frame from the rest pose
        for (const b of AIM_BONES) { const bone = r.bones[b]; if (bone) bone.quaternion.copy(bone.userData.rest); }
        r.mixer.update(dt);
        // aim pitch on top of the clip
        if (r.alive) {
          const p = Math.max(-1.2, Math.min(1.2, r.cur.pitch));
          // the rig's bone +X leans BACK (see build_characters.py), so aiming
          // up = +X; aiming down bends forward, never backwards
          if (r.bones.spine) r.bones.spine.rotateX(p * 0.3);
          if (r.bones.chest) r.bones.chest.rotateX(p * 0.45);
          if (r.bones.head) r.bones.head.rotateX(p * 0.15);
          // gait yaw (CS): the hips and legs turn toward the direction of
          // travel, the spine and chest turn back so the upper body and gun
          // stay on the aim
          const gy = r.gait || 0;
          if (gy && r.bones.hips && r.bones.spine && r.bones.chest) {
            r.bones.hips.rotateY(-gy);
            r.bones.spine.rotateY(gy * 0.6);
            r.bones.chest.rotateY(gy * 0.4);
          }
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

  // solid boxes for the local player's movement
  bodies() {
    const out = [];
    for (const r of this.players.values()) if (r.alive && r.id !== this.hiddenId) out.push(bodyBox(r.cur.pos, (r.icrouch ?? r.tgt.crouching)));
    return out;
  }

  // list for effects raycasts
  targets() {
    const out = [];
    for (const r of this.players.values()) {
      if (r.alive) out.push({ id: r.id, pos: r.cur.pos, crouching: (r.icrouch ?? r.tgt.crouching) });
    }
    return out;
  }
}
