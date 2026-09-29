// Local player: client-predicted movement (shared physics), camera, weapons.
//
// Movement is predicted locally for zero-latency feel and sent to the server,
// which relays it. Damage is NOT decided here — the server raycasts and
// reports hits. Ammo is predicted (a shot decrements the magazine at once) and
// corrected by the server's `ammo`/`inv` messages; the inventory, money and
// armour are the server's, mirrored from `inv`.

import { movePlayer } from '../shared/physics.js';
import { PLAYER, WEAPONS, DRAW_TIME, SLOTS } from '../shared/constants.js';
import { newRecoil, resetRecoil, shotSpread, spreadDir, kick, decayPunch, aimWithPunch } from '../shared/ballistics.js';

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
    this.recoil = newRecoil(); // CS punch angles (the spray pattern) + accuracy state
    this.zoom = 0;        // 0 none, 1, 2
    this.planting = false; // holding the trigger with the C4 out
    this.pinPulled = false; // grenade: armed while the trigger is held
    this.nades = {};
    this.defusing = false; // holding E on the bomb
    this.frozen = false;   // freeze time: look, buy, but no moving
    this.shotCount = 0;    // for the HUD's crosshair kick
    this.sound = () => {}; // (name, opts) -> set by main.js
    this.surfaceAt = () => 'sand';
    this._stepDist = 0;
    this._wasGround = true;
    this._fallSpeed = 0;
    this._reloadTimers = [];
    this.kills = 0; this.deaths = 0;
    this.others = () => [];
    this.bodies = () => []; // solid boxes of the other live players (main.js)

    this.camera.rotation.order = 'YXZ';
    this._sendTimer = 0;
    this._eyeSmooth = PLAYER.standEye;
    this._fov = BASE_FOV;
  }

  // ------------------------------------------------------------ server sync

  applyInv(m) {
    this.money = m.money;
    this.kit = !!m.kit;
    this.c4 = !!m.c4;
    this.nades = m.nades || {};
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
    this.recoil = newRecoil();
    resetRecoil(this.recoil, this.weapon);
    this.reloadUntil = 0;
    this.setZoom(0);
  }

  // ------------------------------------------------------------ helpers

  eyeHeight() { return this.state.crouching ? PLAYER.crouchEye : PLAYER.standEye; }
  speed() { return Math.hypot(this.state.vel[0], this.state.vel[2]); }
  isMoving() { return this.speed() > 12; }
  reloading(now = performance.now() / 1000) { return this.reloadUntil > now; }
  mag() {
    if (WEAPONS[this.weapon] && WEAPONS[this.weapon].grenade) return this.nades[this.weapon] || 0;
    return this.ammo[this.weapon] ? this.ammo[this.weapon].mag : 0;
  }
  reserve() { return this.ammo[this.weapon] ? this.ammo[this.weapon].reserve : 0; }

  // bullets leave along view + punch: the punch is the spray pattern
  aimDir() { return aimWithPunch(this.state.yaw, this.state.pitch, this.recoil.punch); }

  // flinch when hit (CS adds view punch on damage)
  flinch(deg = 1.5) { this.recoil.punch[0] = Math.min(this.recoil.punch[0] + deg, 12); }

  eyePos() {
    return [this.state.pos[0], this.state.pos[1] + this.eyeHeight(), this.state.pos[2]];
  }

  // ------------------------------------------------------------ weapons

  equip(id, tell = true) {
    if (!id || !WEAPONS[id]) return;
    if (id !== this.weapon) this.prevWeapon = this.weapon;
    this.weapon = id;
    this.reloadUntil = 0;
    resetRecoil(this.recoil, id);
    this.nextFire = performance.now() / 1000 + DRAW_TIME;
    this.setZoom(0);
    this.cancelReloadSounds();
    this.vm.setWeapon(id);
    this.sound('deploy', { volume: 0.5 });
    if (tell) this.net.send({ t: 'weapon', id });
  }

  selectSlot(n) {
    const slot = SLOTS[n - 1];
    if (!slot) return;
    if (slot === 'grenade') {
      // 4 cycles through the grenades you carry
      const kinds = ['hegrenade', 'flashbang', 'smokegrenade'].filter((k) => this.nades[k] > 0);
      if (!kinds.length) return;
      const i = kinds.indexOf(this.weapon);
      this.equip(kinds[(i + 1) % kinds.length]);
      return;
    }
    const id = this.inv[slot];
    if (id && id !== this.weapon) this.equip(id);
  }

  cycle(dir) {
    const owned = SLOTS.map((s) => s && this.inv[s]).filter(Boolean);
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
    // magazine out, in, then the bolt / slide
    this.cancelReloadSounds();
    const seq = [[0.18, 'mag_out'], [0.62, 'mag_in'], [0.84, 'bolt']];
    for (const [f, name] of seq) this._reloadTimers.push(setTimeout(() => this.sound(name, { volume: 0.7 }), f * w.reload * 1000));
  }

  cancelReloadSounds() { for (const t of this._reloadTimers) clearTimeout(t); this._reloadTimers = []; }

  fire(now) {
    const w = WEAPONS[this.weapon];
    const a = this.ammo[this.weapon];
    this.sound(w.melee ? 'knife_slash' : `fire_${this.weapon}`, { volume: w.melee ? 0.7 : 0.95, jitter: 0.03 });
    if (!w.melee) {
      if (!a || a.mag <= 0) return;
      a.mag--;
    }
    this.lastFire = now;
    this.nextFire = now + w.rof;
    const ctx = { now, onGround: this.state.onGround, speed: this.speed(), ducking: this.state.crouching, zoomed: this.zoom > 0 };
    const spread = shotSpread(this.recoil, this.weapon, ctx);   // mirrors the server's roll
    const dir = this.aimDir();
    const origin = this.eyePos();
    this.shotCount++;
    this.net.send({ t: 'fire', origin, dir, zoomed: this.zoom > 0 });
    kick(this.recoil, this.weapon, ctx);                        // next shot climbs
    this.vm.fire();

    // local impacts with a guessed spread (the server rolls its own)
    if (w.melee) {
      this.fx.shot(origin, dir, null, this.others(), null, { tracer: false });
    } else {
      const d = spreadDir(dir, spread);
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
      // frozen at round start, and rooted while planting or defusing (as in CS)
      const still = this.frozen || this.planting || this.defusing;
      const keys = input.moveKeys();
      keys.maxSpeed = WEAPONS[this.weapon].speed;
      // other players block you, as in CS
      const bodies = this.bodies();
      const solids = bodies.length ? this.colliders.concat(bodies) : this.colliders;
      movePlayer(this.state, still ? { ...keys, f: 0, b: 0, l: 0, r: 0, jump: 0, crouch: this.defusing || keys.crouch } : keys, dt, solids);

      if (canAct) {
        const slot = input.consumeWeaponSlot();
        if (slot) this.selectSlot(slot);
        if (input.consumeLastWeapon() && this.inv && Object.values(this.inv).includes(this.prevWeapon)) this.equip(this.prevWeapon);
        const wheel = input.consumeWheel();
        if (wheel) this.cycle(wheel > 0 ? 1 : -1);

        const w = WEAPONS[this.weapon];
        // grenade: press pulls the pin, release throws (CS)
        if (w.grenade) {
          input.consumeFirePressed();
          if (input.fireHeld && !this.pinPulled && now >= this.nextFire && this.mag() > 0) {
            this.pinPulled = true;
            this.sound('pin', { volume: 0.6 });
          } else if (!input.fireHeld && this.pinPulled) {
            this.pinPulled = false;
            this.nextFire = now + 0.6;
            this.net.send({ t: 'throw', vel: this.state.vel });
            this.sound('throw', { volume: 0.6 });
            this.vm.fire();
          }
        } else this.pinPulled = false;
        // C4: hold the trigger to plant (the server checks the bombsite)
        if (w.bomb) {
          const hold = input.fireHeld;
          input.consumeFirePressed();
          if (hold !== this.planting) { this.planting = hold; this.net.send({ t: 'plant', on: hold }); }
        } else if (this.planting) { this.planting = false; this.net.send({ t: 'plant', on: false }); }
        // E: defuse (the server checks you are next to the planted bomb)
        const use = input.useHeld();
        if (use !== this.defusing) { this.defusing = use; this.net.send({ t: 'defuse', on: use }); }
        if (input.consumeDrop()) this.net.send({ t: 'drop' });
        if (input.consumeZoom() && w.zoomFov && !this.reloading(now)) {
          this.setZoom((this.zoom + 1) % 3);
        }
        const wantFire = !w.bomb && !w.grenade && !this.frozen && (w.auto ? input.fireHeld : input.consumeFirePressed());
        if (w.auto) input.consumeFirePressed();
        if (wantFire && !this.reloading(now) && now >= this.nextFire) {
          if (w.melee || this.mag() > 0) this.fire(now);
          else if (this.reserve() > 0) this.startReload();
          else { this.sound('dryfire', { volume: 0.7 }); this.nextFire = now + 0.25; }
        }
        if (input.consumeReload()) this.startReload();
      }
      if (this.reloadUntil && now >= this.reloadUntil + 0.6) this.reloadUntil = 0; // server never answered
    } else {
      input.consumeLook();
    }

    // footsteps: audible when running (CS: walking and crouching are silent)
    if (this.alive) {
      const sp = this.speed();
      if (this.state.onGround && sp > 150 && !this.state.crouching) {
        this._stepDist += sp * dt;
        if (this._stepDist > 88) { this._stepDist = 0; this.sound('step', { surface: this.surfaceAt(this.state.pos), volume: 0.28 }); }
      }
      if (!this.state.onGround) this._fallSpeed = Math.max(this._fallSpeed, -this.state.vel[1]);
      if (this.state.onGround && !this._wasGround && this._fallSpeed > 320) this.sound('land', { volume: Math.min(1, this._fallSpeed / 600) });
      if (this.state.landSpeed) { if (this.state.landSpeed > 580) this.net.send({ t: 'fall', speed: this.state.landSpeed }); this.state.landSpeed = 0; }
      if (this.state.onGround) this._fallSpeed = 0;
      this._wasGround = this.state.onGround;
    }

    // punch recovers toward zero (CS 1.6 decay)
    decayPunch(this.recoil, dt);

    // smooth eye height when (un)crouching
    this._eyeSmooth += (this.eyeHeight() - this._eyeSmooth) * Math.min(1, dt * 14);
    this.applyCamera(dt);

    this._sendTimer -= dt;
    if (this.alive && this._sendTimer <= 0) {
      this._sendTimer = 0.04; // 25 Hz
      this.net.send({
        t: 'state', pos: this.state.pos, yaw: this.state.yaw, pitch: this.state.pitch,
        crouching: this.state.crouching, moving: this.isMoving(), speed: Math.round(this.speed()),
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
    // the view shows the punch, as CS 1.6 does
    this.camera.rotation.y = this.state.yaw + this.recoil.punch[1] * Math.PI / 180;
    this.camera.rotation.x = this.state.pitch + this.recoil.punch[0] * Math.PI / 180;
    const target = this.fovTarget();
    this._fov += (target - this._fov) * Math.min(1, dt * 18);
    if (Math.abs(this.camera.fov - this._fov) > 0.01) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
