// Local player: client-predicted movement (shared physics), camera, weapons.
//
// Movement is predicted locally for zero-latency feel and sent to the server,
// which relays it. Damage is NOT decided here — the server raycasts and
// reports hits. Ammo is predicted (a shot decrements the magazine at once) and
// corrected by the server's `ammo`/`inv` messages; the inventory, money and
// armour are the server's, mirrored from `inv`.

import * as THREE from 'three';
import { movePlayer } from '../shared/physics.js';
import {
  PLAYER, WEAPONS, CONE_SHOTS_TO_MAX, CONE_RECOVERY_PER_SEC, AIR_CONE_MUL, RUN_CONE_MUL,
  DRAW_TIME, NOSCOPE_CONE, SLOTS,
} from '../shared/constants.js';

const PITCH_LIMIT = 1.5;
const BASE_FOV = 78;

export class LocalPlayer {
  constructor(camera, colliders, net, vm, fx) {
    this.camera = camera;
    this.colliders = colliders;
    this.net = net;
    this.vm = vm;
    this.fx = fx;

    this.state = { pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, onGround: false, crouching: false };
    this.hp = PLAYER.maxHp;
    this.armor = 0; this.helmet = false;
    this.money = 0;
    this.alive = false;
    this.inv = { primary: null, secondary: 'glock', melee: 'knife' };
    this.ammo = {};
    this.weapon = 'glock';
    this.prevWeapon = 'knife';
    this.reloadUntil = 0;
    this.reloadStart = 0;
    this.nextFire = 0;
    this.burst = 0;
    this.lastFire = 0;
    this.punch = 0;       // view punch (radians), recoil you can see and must pull down
    this.punchYaw = 0;
    this.zoom = 0;        // 0 none, 1, 2
    this.kills = 0; this.deaths = 0;
    this.others = () => [];

    this.camera.rotation.order = 'YXZ';
    this._sendTimer = 0;
    this._eyeSmooth = PLAYER.standEye;
    this._fov = BASE_FOV;
  }

  // ------------------------------------------------------------ server sync

  applyInv(m) {
    this.money = m.money;
    this.armor = m.armor; this.helmet = m.helmet;
    if (typeof m.hp === 'number' && this.alive) this.hp = m.hp;
    this.inv = m.inv;
    this.ammo = {};
    for (const [id, a] of Object.entries(m.ammo)) this.ammo[id] = { mag: a[0], reserve: a[1] };
    if (!m.reloading) this.reloadUntil = 0;
    if (m.weapon !== this.weapon || this.vm.weapon !== m.weapon) this.equip(m.weapon, false);
  }

  applyAmmo(m) {
    if (m.weapon !== this.weapon) return;
    this.ammo[m.weapon] = { mag: m.mag, reserve: m.reserve };
    if (!m.reloading && this.reloadUntil) { this.reloadUntil = 0; }
  }

  spawnAt(pos, yaw) {
    this.state.pos = [pos[0], pos[1], pos[2]];
    this.state.vel = [0, 0, 0];
    if (typeof yaw === 'number') { this.state.yaw = yaw; this.state.pitch = 0; }
    this.hp = PLAYER.maxHp;
    this.alive = true;
    this.burst = 0; this.punch = 0; this.punchYaw = 0;
    this.reloadUntil = 0;
    this.setZoom(0);
  }

  // ------------------------------------------------------------ helpers

  eyeHeight() { return this.state.crouching ? PLAYER.crouchEye : PLAYER.standEye; }
  speed() { return Math.hypot(this.state.vel[0], this.state.vel[2]); }
  isMoving() { return this.speed() > 12; }
  reloading(now = performance.now() / 1000) { return this.reloadUntil > now; }
  mag() { return this.ammo[this.weapon] ? this.ammo[this.weapon].mag : 0; }
  reserve() { return this.ammo[this.weapon] ? this.ammo[this.weapon].reserve : 0; }

  aimDir() {
    const yaw = this.state.yaw + this.punchYaw;
    const pitch = this.state.pitch + this.punch;
    const cp = Math.cos(pitch);
    return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  }

  eyePos() {
    return [this.state.pos[0], this.state.pos[1] + this.eyeHeight(), this.state.pos[2]];
  }

  // Same cone the server uses, so the crosshair tells the truth.
  cone(now = performance.now() / 1000) {
    const w = WEAPONS[this.weapon];
    if (w.melee) return 0;
    const burst = Math.max(0, this.burst - (now - this.lastFire) * CONE_RECOVERY_PER_SEC * CONE_SHOTS_TO_MAX);
    let c = w.cone + (w.maxCone - w.cone) * (Math.max(0, Math.ceil(burst) - 1) / (CONE_SHOTS_TO_MAX - 1));
    const air = !this.state.onGround;
    if (air) c *= AIR_CONE_MUL;
    else if (this.isMoving() && !this.state.crouching) c *= RUN_CONE_MUL;
    if (w.zoomFov && !this.zoom) c = Math.max(c, NOSCOPE_CONE);
    return c;
  }

  // ------------------------------------------------------------ weapons

  equip(id, tell = true) {
    if (!id || !WEAPONS[id]) return;
    if (id !== this.weapon) this.prevWeapon = this.weapon;
    this.weapon = id;
    this.reloadUntil = 0;
    this.burst = 0;
    this.nextFire = performance.now() / 1000 + DRAW_TIME;
    this.setZoom(0);
    this.vm.setWeapon(id);
    if (tell) this.net.send({ t: 'weapon', id });
  }

  selectSlot(n) {
    const id = this.inv[SLOTS[n - 1]];
    if (id && id !== this.weapon) this.equip(id);
  }

  cycle(dir) {
    const owned = SLOTS.map((s) => this.inv[s]).filter(Boolean);
    const i = owned.indexOf(this.weapon);
    const next = owned[(i + dir + owned.length) % owned.length];
    if (next && next !== this.weapon) this.equip(next);
  }

  setZoom(level) {
    const w = WEAPONS[this.weapon];
    this.zoom = w && w.zoomFov ? level : 0;
  }

  startReload() {
    const w = WEAPONS[this.weapon];
    const a = this.ammo[this.weapon];
    if (w.melee || !a || this.reloading() || a.mag >= w.mag || a.reserve <= 0) return;
    const now = performance.now() / 1000;
    this.reloadStart = now;
    this.reloadUntil = now + w.reload;
    this.setZoom(0);
    this.vm.reload(w.reload);
    this.net.send({ t: 'reload' });
  }

  fire(now) {
    const w = WEAPONS[this.weapon];
    const a = this.ammo[this.weapon];
    if (!w.melee) {
      if (!a || a.mag <= 0) return;
      a.mag--;
    }
    // recover the cone since the last shot, then grow it
    this.burst = Math.max(0, this.burst - (now - this.lastFire) * CONE_RECOVERY_PER_SEC * CONE_SHOTS_TO_MAX);
    this.lastFire = now;
    this.nextFire = now + w.rof;
    const cone = this.cone(now);
    this.burst = Math.min(this.burst + 1, CONE_SHOTS_TO_MAX);

    const dir = this.aimDir();
    const origin = this.eyePos();
    this.net.send({ t: 'fire', origin, dir, zoomed: this.zoom > 0 });

    // view punch: autos climb, pistols/snipers kick once
    if (!w.melee) {
      const k = w.auto ? 0.012 + 0.0025 * Math.min(this.burst, 8) : (w.zoomFov ? 0.05 : 0.028);
      this.punch = Math.min(this.punch + k, 0.16);
      if (w.auto && this.burst > 4) this.punchYaw += (Math.random() - 0.5) * 0.012;
    }
    this.vm.fire();

    // local impacts with a guessed spread (the server rolls its own)
    if (w.melee) {
      this.fx.shot(origin, dir, null, this.others(), null, { tracer: false });
    } else {
      const d = jitter(dir, cone);
      const muz = this.vm.muzzleWorld(this.camera);
      this.fx.shot(origin, d, Math.random() < 0.5 ? [muz.x, muz.y, muz.z] : null, this.others());
    }
    if (w.zoomFov) this.setZoom(0); // bolt-action: the scope drops after the shot
    if (!w.melee && a.mag === 0) this.startReload();
  }

  // ------------------------------------------------------------ frame

  update(dt, input, { canAct = true } = {}) {
    const now = performance.now() / 1000;
    if (this.alive) {
      const [dx, dy] = input.consumeLook();
      this.state.yaw -= dx;
      this.state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.state.pitch - dy));
      movePlayer(this.state, input.moveKeys(), dt, this.colliders);

      if (canAct) {
        const slot = input.consumeWeaponSlot();
        if (slot) this.selectSlot(slot);
        if (input.consumeLastWeapon() && this.inv && Object.values(this.inv).includes(this.prevWeapon)) this.equip(this.prevWeapon);
        const wheel = input.consumeWheel();
        if (wheel) this.cycle(wheel > 0 ? 1 : -1);

        const w = WEAPONS[this.weapon];
        if (input.consumeZoom() && w.zoomFov && !this.reloading(now)) {
          this.setZoom((this.zoom + 1) % 3);
        }
        const wantFire = w.auto ? input.fireHeld : input.consumeFirePressed();
        if (w.auto) input.consumeFirePressed();
        if (wantFire && !this.reloading(now) && now >= this.nextFire) {
          if (w.melee || this.mag() > 0) this.fire(now);
          else if (this.reserve() > 0) this.startReload();
        }
        if (input.consumeReload()) this.startReload();
      }
      if (this.reloadUntil && now >= this.reloadUntil + 0.6) this.reloadUntil = 0; // server never answered
    } else {
      input.consumeLook();
    }

    // punch recovers toward zero
    this.punch = Math.max(0, this.punch - dt * (0.18 + this.punch * 2.2));
    this.punchYaw *= Math.max(0, 1 - dt * 6);

    // smooth eye height when (un)crouching
    this._eyeSmooth += (this.eyeHeight() - this._eyeSmooth) * Math.min(1, dt * 14);
    this.applyCamera(dt);

    this._sendTimer -= dt;
    if (this.alive && this._sendTimer <= 0) {
      this._sendTimer = 0.04; // 25 Hz
      this.net.send({
        t: 'state', pos: this.state.pos, yaw: this.state.yaw, pitch: this.state.pitch,
        crouching: this.state.crouching, moving: this.isMoving(),
      });
    }
  }

  fovTarget() {
    const w = WEAPONS[this.weapon];
    if (this.zoom === 1) return w.zoomFov;
    if (this.zoom === 2) return w.zoomFov2 || w.zoomFov;
    return BASE_FOV;
  }

  applyCamera(dt) {
    const e = this._eyeSmooth;
    this.camera.position.set(this.state.pos[0], this.state.pos[1] + e, this.state.pos[2]);
    this.camera.rotation.y = this.state.yaw + this.punchYaw;
    this.camera.rotation.x = this.state.pitch + this.punch;
    const target = this.fovTarget();
    this._fov += (target - this._fov) * Math.min(1, dt * 18);
    if (Math.abs(this.camera.fov - this._fov) > 0.01) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

function jitter(dir, coneDeg) {
  if (coneDeg <= 0) return dir;
  const v = new THREE.Vector3(...dir);
  const phi = Math.random() * coneDeg * Math.PI / 180;
  const theta = Math.random() * Math.PI * 2;
  const up = Math.abs(v.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const r = new THREE.Vector3().crossVectors(v, up).normalize();
  const u = new THREE.Vector3().crossVectors(r, v).normalize();
  v.multiplyScalar(Math.cos(phi))
    .addScaledVector(r, Math.cos(theta) * Math.sin(phi))
    .addScaledVector(u, Math.sin(theta) * Math.sin(phi));
  return [v.x, v.y, v.z];
}
