// Local player: client-predicted movement (shared physics), camera, firing.
//
// Movement is predicted locally for zero-latency feel and sent to the server,
// which relays it (the same model the Godot build used). Damage is NOT decided
// here — the server raycasts and reports hits; we only show tracers and recoil.

import * as THREE from 'three';
import { movePlayer } from '/shared/physics.js';
import {
  PLAYER, WEAPONS, START_WEAPON, CONE_SHOTS_TO_MAX,
} from '/shared/constants.js';

const SLOT_WEAPONS = ['knife', 'glock', 'usp', 'deagle', 'mp5', 'ak47', 'm4a1', 'awp', 'scout'];
const PITCH_LIMIT = 1.45;

export class LocalPlayer {
  constructor(camera, colliders, net, scene) {
    this.camera = camera;
    this.colliders = colliders;
    this.net = net;
    this.scene = scene;

    this.state = { pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, onGround: false, crouching: false };
    this.hp = PLAYER.maxHp;
    this.alive = true;
    this.weapon = START_WEAPON;
    this.ammo = WEAPONS[START_WEAPON].mag;
    this.burst = 0;
    this.lastFire = 0;
    this.recoil = 0;
    this.kills = 0; this.deaths = 0;

    this.camera.rotation.order = 'YXZ';
    this._sendTimer = 0;
    this._eyeSmooth = PLAYER.standEye;

    this._makeViewmodel();
    this._tracers = [];
  }

  _makeViewmodel() {
    // cheap viewmodel: a dark box at the lower-right of the camera
    const g = new THREE.BoxGeometry(0.35, 0.35, 1.6);
    const m = new THREE.MeshLambertMaterial({ color: 0x2b2d30 });
    this.viewmodel = new THREE.Mesh(g, m);
    this.viewmodel.position.set(0.45, -0.4, -1.0);
    this.camera.add(this.viewmodel);
  }

  spawnAt(pos) {
    this.state.pos = [pos[0], pos[1], pos[2]];
    this.state.vel = [0, 0, 0];
    this.hp = PLAYER.maxHp;
    this.alive = true;
    this.ammo = WEAPONS[this.weapon].mag;
    this.burst = 0;
    this.recoil = 0;
  }

  eyeHeight() {
    return this.state.crouching ? PLAYER.crouchEye : PLAYER.standEye;
  }

  isMoving() {
    return Math.hypot(this.state.vel[0], this.state.vel[2]) > 12;
  }

  lookDir() {
    const { yaw, pitch } = this.state;
    const cp = Math.cos(pitch);
    return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  }

  muzzleWorld() {
    const d = this.lookDir();
    const e = this.eyeHeight();
    return [
      this.state.pos[0] + d[0] * 24,
      this.state.pos[1] + e - 6,
      this.state.pos[2] + d[2] * 24,
    ];
  }

  update(dt, input) {
    if (this.alive) {
      const [dx, dy] = input.consumeLook();
      this.state.yaw -= dx;
      this.state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.state.pitch - dy));

      movePlayer(this.state, input.moveKeys(), dt, this.colliders);

      const w = WEAPONS[this.weapon];
      const now = performance.now() / 1000;
      const wantFire = w.auto ? input.fireHeld : input.consumeFirePressed();
      if (w.auto) input.consumeFirePressed();
      if (wantFire && this.ammo > 0 && now - this.lastFire >= w.rof) this.fire(now);
      if (this.ammo <= 0 && wantFire) this.net.send({ t: 'reload' });

      if (input.consumeReload()) this.net.send({ t: 'reload' });

      const slot = input.consumeWeaponSlot();
      if (slot > 0 && slot <= SLOT_WEAPONS.length) this.switchWeapon(SLOT_WEAPONS[slot - 1]);
    }

    // smooth eye height when (un)crouching
    const targetEye = this.eyeHeight();
    this._eyeSmooth += (targetEye - this._eyeSmooth) * Math.min(1, dt * 14);

    // recoil recovery
    this.recoil = Math.max(0, this.recoil - dt * 4);

    this.applyCamera();
    this._updateTracers(dt);

    this._sendTimer -= dt;
    if (this._sendTimer <= 0) {
      this._sendTimer = 0.04; // 25 Hz
      this.net.send({
        t: 'state', pos: this.state.pos, yaw: this.state.yaw, pitch: this.state.pitch,
        crouching: this.state.crouching, moving: this.isMoving(),
      });
    }
  }

  fire(now) {
    const w = WEAPONS[this.weapon];
    this.lastFire = now;
    this.ammo--;
    this.burst = Math.min(this.burst + 1, CONE_SHOTS_TO_MAX);
    this.recoil = Math.min(this.recoil + 0.06, 0.5);

    const dir = this.lookDir();
    const origin = [
      this.state.pos[0],
      this.state.pos[1] + this.eyeHeight(),
      this.state.pos[2],
    ];
    this.net.send({ t: 'fire', origin, dir, weapon: this.weapon });

    // local tracer for feedback (server decides actual damage)
    this.spawnTracer(this.muzzleWorld(), dir);
  }

  spawnTracer(from, dir) {
    const to = [from[0] + dir[0] * 4000, from[1] + dir[1] * 4000, from[2] + dir[2] * 4000];
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...from), new THREE.Vector3(...to),
    ]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this._tracers.push({ line, life: 0.08 });
  }

  spawnTracerBetween(from, to) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...from), new THREE.Vector3(...to),
    ]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.8 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this._tracers.push({ line, life: 0.08 });
  }

  _updateTracers(dt) {
    for (let i = this._tracers.length - 1; i >= 0; i--) {
      const tr = this._tracers[i];
      tr.life -= dt;
      if (tr.life <= 0) {
        this.scene.remove(tr.line);
        tr.line.geometry.dispose();
        tr.line.material.dispose();
        this._tracers.splice(i, 1);
      }
    }
  }

  switchWeapon(id) {
    if (!WEAPONS[id] || id === this.weapon) return;
    this.weapon = id;
    this.ammo = WEAPONS[id].mag;
    this.burst = 0;
    this.net.send({ t: 'weapon', id });
  }

  applyCamera() {
    const e = this._eyeSmooth;
    this.camera.position.set(
      this.state.pos[0],
      this.state.pos[1] + e + this.recoil * -4,
      this.state.pos[2],
    );
    this.camera.rotation.y = this.state.yaw;
    this.camera.rotation.x = this.state.pitch + this.recoil * 0.06;
  }
}
