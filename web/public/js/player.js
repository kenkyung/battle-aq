// Local player: client-predicted movement (shared physics), camera, weapons.
//
// Movement is predicted locally for zero-latency feel and sent to the server,
// which relays it. Damage is NOT decided here — the server raycasts and
// reports hits. Ammo is predicted (a shot decrements the magazine at once) and
// corrected by the server's `ammo`/`inv` messages; the inventory, money and
// armour are the server's, mirrored from `inv`.

import { movePlayer, waterLevel } from '../shared/physics.js';
import { PLAYER, WEAPONS, DRAW_TIME, SLOTS, weaponStats } from '../shared/constants.js';
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
    this.modes = {};      // weapon id -> 'silenced' | 'burst' (server's, mirrored)
    this.burstLeft = 0;   // rounds still to come in a Glock / FAMAS burst
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
    // usercmds (M11): every frame's input is predicted here and sent; the
    // server's `you` acks a sequence number and its state, and the commands
    // it has not seen yet are replayed on top (reconciliation)
    this.seq = 0;
    this.pending = [];
    this.cmdOut = [];
    this.smooth = [0, 0, 0];   // visual error left from a correction, decays
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
    if (m.modes) this.modes = m.modes;
    this.nvg = !!m.nvg;
    if (!!m.shield !== !!this.shield) { this.shield = !!m.shield; this.vm.setShield(this.shield); }
    this.ammo = {};
    for (const [id, a] of Object.entries(m.ammo)) this.ammo[id] = { mag: a[0], reserve: a[1] };
    if (!m.reloading) this.reloadUntil = 0;
    if (m.weapon !== this.weapon || this.vm.weapon !== m.weapon) this.equip(m.weapon, false);
  }

  applyAmmo(m) {
    if (m.weapon !== this.weapon) return;
    this.ammo[m.weapon] = { mag: m.mag, reserve: m.reserve };
    const w = WEAPONS[m.weapon];
    if (w && w.shell) {
      // a shell went in: its sound; done when full or out of shells
      if (this.reloadUntil && m.mag > 0) { this.sound('shell_insert', { volume: 0.6 }); this.vm.cycle('shell', 0.3); }
      if (m.mag >= w.mag || m.reserve <= 0) this.reloadUntil = 0;
      return;
    }
    if (!m.reloading && this.reloadUntil) { this.reloadUntil = 0; }
  }

  applyMode(m) {
    this.modes[m.weapon] = m.mode;
    if (m.weapon === this.weapon) this.vm.setWeapon(this.weapon, m.mode);
  }

  mode(id = this.weapon) { return this.modes[id] || null; }

  spawnAt(pos, yaw) {
    this.state.pos = [pos[0], pos[1], pos[2]];
    this.state.vel = [0, 0, 0];
    this.pending = []; this.smooth = [0, 0, 0];
    if (typeof yaw === 'number') { this.state.yaw = yaw; this.state.pitch = 0; }
    this.hp = PLAYER.maxHp;
    this.alive = true;
    this.recoil = newRecoil();
    resetRecoil(this.recoil, this.weapon);
    this.reloadUntil = 0;
    this.setZoom(0);
  }

  // ------------------------------------------------------------ helpers

  // view offset from the feet: set by the physics' duck (0.4 s spline down, instant up)
  eyeHeight() { return this.state.eye || (this.state.crouching ? PLAYER.crouchEye : PLAYER.standEye); }
  speed() { return Math.hypot(this.state.vel[0], this.state.vel[2]); }
  isMoving() { return this.speed() > 12; }
  // a shotgun reloads shell by shell and may fire in between (if it has one)
  reloading(now = performance.now() / 1000) { return this.reloadUntil > now && !(WEAPONS[this.weapon].shell && this.mag() > 0); }
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
    this.burstLeft = 0;
    resetRecoil(this.recoil, id);
    this.nextFire = performance.now() / 1000 + (WEAPONS[id].deploy || DRAW_TIME);
    this.setZoom(0);
    this.cancelReloadSounds();
    this.vm.setWeapon(id, this.mode(id));
    // CS draw sounds: the knife's shing, a pistol's slide, a rifle's handling
    const dw = WEAPONS[id];
    this.sound(dw.melee ? 'knife_deploy' : dw.slot === 'secondary' ? 'slide' : 'deploy', { volume: dw.melee ? 0.45 : 0.5 });
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
    this.zoom = w && w.zoomFov ? Math.min(level, w.zoomLevels || 2) : 0;
  }

  // AWP / Scout / autosnipers show the scope overlay; AUG / SG552 just zoom
  scoped() { const w = WEAPONS[this.weapon]; return this.zoom > 0 && w.cls === 'sniper'; }

  // right click: zoom, silencer, burst mode or the knife's stab
  secondary(now) {
    const w = WEAPONS[this.weapon];
    if (w.zoomFov) { if (!this.reloading(now)) this.setZoom((this.zoom + 1) % ((w.zoomLevels || 2) + 1)); return; }
    if (w.alt === 'stab') { if (now >= this.nextFire) this.fire(now, true); return; }
    if (w.alt === 'silencer') {
      if (now < this.nextFire || this.reloading(now)) return;
      this.nextFire = now + w.silencerTime;
      this.vm.cycle('screw', w.silencerTime);
      this._reloadTimers.push(setTimeout(() => this.sound('bolt', { volume: 0.5 }), w.silencerTime * 700));
      this.net.send({ t: 'alt' });
      return;
    }
    if (w.alt === 'burst') { this.net.send({ t: 'alt' }); this.sound('dryfire', { volume: 0.4 }); }
  }

  startReload() {
    const w = WEAPONS[this.weapon];
    const a = this.ammo[this.weapon];
    if (w.melee || !a || this.reloadUntil > performance.now() / 1000 || a.mag >= w.mag || a.reserve <= 0) return;
    const now = performance.now() / 1000;
    this.burstLeft = 0;
    if (w.shell) {
      // shotgun: shells go in one by one (the server sends the count as they do)
      const n = Math.min(w.mag - a.mag, a.reserve);
      this.reloadStart = now;
      this.reloadUntil = now + w.shell.start + w.shell.each * n;
      this.setZoom(0);
      this.vm.cycle('shell', w.shell.start);       // tip the gun to the loading port
      this.net.send({ t: 'reload' });
      return;
    }
    this.reloadStart = now;
    this.reloadUntil = now + w.reload;
    this.setZoom(0);
    this.vm.reload(w.reload);
    this.net.send({ t: 'reload' });
    // the reload's sounds by weapon family (fractions of the reload time)
    this.cancelReloadSounds();
    const seq = w.cls === 'mg' ? [[0.08, 'box_open'], [0.3, 'mag_out'], [0.55, 'belt'], [0.72, 'mag_in'], [0.88, 'box_close']]
      : w.slot === 'secondary' ? [[0.2, 'mag_out'], [0.6, 'mag_in'], [0.86, 'slide']]
        : [[0.18, 'mag_out'], [0.62, 'mag_in'], [0.84, 'bolt']];
    for (const [f, name] of seq) this._reloadTimers.push(setTimeout(() => this.sound(name, { volume: 0.7 }), f * w.reload * 1000));
  }

  cancelReloadSounds() { for (const t of this._reloadTimers) clearTimeout(t); this._reloadTimers = []; }

  fire(now, alt = false) {
    const base = WEAPONS[this.weapon];
    const mode = base.alt === 'stab' ? (alt ? 'stab' : null) : this.mode();
    const w = weaponStats(this.weapon, mode);
    const a = this.ammo[this.weapon];
    const snd = w.melee ? (alt ? 'knife_stab' : 'knife_slash') : mode === 'silenced' ? `fire_${this.weapon}_s` : `fire_${this.weapon}`;
    this.sound(snd, { volume: w.melee ? 0.7 : mode === 'silenced' ? 0.6 : 0.95, jitter: 0.03 });
    if (!w.melee) {
      if (!a || a.mag <= 0) return;
      a.mag--;
    }
    if (this.reloadUntil && w.shell) { this.reloadUntil = 0; this.vm.reload(0.01); }   // firing breaks a shell reload
    this.lastFire = now;
    const zoomed = this.zoom > 0;
    if (mode === 'burst') {
      // first round of a burst: the rest follow on their own (update)
      if (this.burstLeft <= 0) { this.burstLeft = w.count - 1; this.burstStart = now; }
      else this.burstLeft--;
      this.nextFire = this.burstLeft > 0 ? now + w.gap : this.burstStart + w.cycle;
    } else this.nextFire = now + (zoomed && w.zoomRof ? w.zoomRof : w.rof);
    const ctx = { now, onGround: this.state.onGround, speed: this.speed(), ducking: this.state.crouching, zoomed, mode };
    const spread = shotSpread(this.recoil, this.weapon, ctx);   // mirrors the server's roll
    const dir = this.aimDir();
    const origin = this.eyePos();
    this.shotCount++;
    this.net.send({ t: 'fire', origin, dir, zoomed, alt: alt || undefined, vt: this.viewTime ? this.viewTime() : undefined });
    kick(this.recoil, this.weapon, ctx);                        // next shot climbs
    this.vm.fire(alt);

    // local impacts with a guessed spread (the server rolls its own)
    if (w.melee) {
      this.fx.shot(origin, dir, null, this.others(), null, { tracer: false, reach: w.reach });
    } else {
      const muz = this.vm.muzzleWorld(this.camera);
      for (let k = 0; k < (w.pellets || 1); k++) {
        const d = spreadDir(dir, spread);
        this.fx.shot(origin, d, k === 0 && Math.random() < 0.5 ? [muz.x, muz.y, muz.z] : null, this.others(), null, { tracer: k === 0, silent: k > 0 });
      }
    }
    if (this.weapon === 'm3') setTimeout(() => { if (this.weapon === 'm3') this.vm.cycle('pump', 0.45); }, 180);
    if (w.cls === 'sniper' && !w.autoSniper) {
      setTimeout(() => this.vm.cycle('bolt', 0.7), 250);
      this.setZoom(0); // bolt-action: the scope drops after the shot
      this._reloadTimers.push(setTimeout(() => this.sound('bolt', { volume: 0.6 }), 450));
    }
    // the spent case hits the floor a moment later
    if (!w.melee) this._reloadTimers.push(setTimeout(() => this.sound(w.pellets ? 'shell_shotgun' : 'shell_brass', { volume: 0.22 }), 380 + Math.random() * 250));
    if (!w.melee && a.mag === 0) { this.burstLeft = 0; this.startReload(); }
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
      const wz = WEAPONS[this.weapon];
      keys.maxSpeed = (this.zoom > 0 && wz.zoomSpeed ? wz.zoomSpeed : wz.speed) * (this.shield ? 0.9 : 1);   // scoped / shield: slower
      keys.water = this.map && this.map.water;
      keys.ladders = this.map && this.map.ladders;
      // other players block you, as in CS
      const bodies = this.bodies();
      const solids = bodies.length ? this.colliders.concat(bodies) : this.colliders;
      const mk = still ? { ...keys, f: 0, b: 0, l: 0, r: 0, jump: 0, crouch: this.defusing || keys.crouch } : keys;
      const cmd = {
        s: ++this.seq, dt: Math.round(dt * 10000) / 10000,
        k: (mk.f ? 1 : 0) | (mk.b ? 2 : 0) | (mk.l ? 4 : 0) | (mk.r ? 8 : 0) | (mk.jump ? 16 : 0) | (mk.crouch ? 32 : 0) | (mk.walk ? 64 : 0),
        y: Math.round(this.state.yaw * 10000) / 10000, p: Math.round(this.state.pitch * 10000) / 10000, z: this.zoom > 0 ? 1 : 0,
      };
      movePlayer(this.state, mk, cmd.dt, solids);
      this.pending.push({ cmd, keys: mk });
      if (this.pending.length > 240) this.pending.shift();
      this.cmdOut.push(cmd);

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
        // on hostage maps E is a press (take / release a hostage), not a hold
        const use = input.useHeld();
        if (this.hostageMode) { if (use && !this.useWas) this.net.send({ t: 'defuse', on: true }); this.useWas = use; }
        else if (use !== this.defusing) { this.defusing = use; this.net.send({ t: 'defuse', on: use }); }
        if (input.consumeDrop()) this.net.send({ t: 'drop' });
        if (input.consumeZoom() && !this.frozen) this.secondary(now);
        // a burst keeps going by itself once started
        if (this.burstLeft > 0 && now >= this.nextFire && this.mag() > 0 && this.mode() === 'burst') this.fire(now);
        const wantFire = !w.bomb && !w.grenade && !this.frozen && this.burstLeft <= 0 && (w.auto && this.mode() !== 'burst' ? input.fireHeld : input.consumeFirePressed());
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
      const wet = this.map ? waterLevel(this.map, this.state.pos, this.state.crouching) : 0;
      if (this.state.onGround && sp > 150 && !this.state.crouching) {
        this._stepDist += sp * dt;
        if (this._stepDist > 88) { this._stepDist = 0; this.sound('step', { surface: wet ? 'water' : this.surfaceAt(this.state.pos), volume: wet ? 0.4 : 0.28 }); }
      }
      // ladder rungs clank as you climb (CS: every ~0.4 s of climbing)
      if (this.state.onLadder && Math.abs(this.state.vel[1]) > 30) {
        this._ladderT = (this._ladderT || 0) - dt;
        if (this._ladderT <= 0) { this._ladderT = 0.4; this.sound('step', { surface: 'metal', volume: 0.35 }); }
      }
      if (!this.state.onGround) this._fallSpeed = Math.max(this._fallSpeed, -this.state.vel[1]);
      if (this.state.onGround && !this._wasGround && this._fallSpeed > 320) this.sound('land', { volume: Math.min(1, this._fallSpeed / 600) });
      // landing in water takes no fall damage (PM_CheckFalling: waterlevel > 0)
      // fall damage is the server's (it simulates our commands)
      if (this.state.landSpeed) this.state.landSpeed = 0;
      void wet;
      if (this.state.onGround) this._fallSpeed = 0;
      this._wasGround = this.state.onGround;
    }

    // punch recovers toward zero (CS 1.6 decay)
    decayPunch(this.recoil, dt);

    // the duck already blends the view down over 0.4 s; standing up is
    // instant in CS, only step-ups are smoothed a touch
    this._eyeSmooth = this.eyeHeight();
    this.applyCamera(dt);

    // commands go out every frame (batched above ~80 fps)
    this._sendTimer -= dt;
    if (this.cmdOut.length && this._sendTimer <= 0) {
      this._sendTimer = 0.012;
      this.net.send({ t: 'cmd', c: this.cmdOut });
      this.cmdOut = [];
    }
    const k = Math.exp(-dt * 12);
    for (let i = 0; i < 3; i++) this.smooth[i] *= k;
  }

  // The server's word on where we are after command `msg.s`: take its state
  // and replay the newer commands on top. A small difference is blended out
  // over a few frames instead of snapping the camera.
  reconcile(msg) {
    this.pending = this.pending.filter((q) => q.cmd.s > msg.s);
    if (!this.alive || !msg.st) return;
    const before = this.state.pos.slice();
    const yaw = this.state.yaw, pitch = this.state.pitch, land = this.state.landSpeed;
    const st = msg.st;
    Object.assign(this.state, {
      pos: st.pos.slice(), vel: st.vel.slice(), onGround: st.onGround, crouching: st.crouching, inDuck: st.inDuck,
      duckT: st.duckT, eye: st.eye, velMod: st.velMod, tagAcc: st.tagAcc, fatigue: st.fatigue, jumpHeld: st.jumpHeld, offLadder: st.offLadder,
    });
    const bodies = this.bodies();
    const solids = bodies.length ? this.colliders.concat(bodies) : this.colliders;
    for (const q of this.pending) {
      this.state.yaw = q.cmd.y; this.state.pitch = q.cmd.p;
      movePlayer(this.state, q.keys, q.cmd.dt, solids);
    }
    this.state.yaw = yaw; this.state.pitch = pitch; this.state.landSpeed = land;
    const err = [before[0] - this.state.pos[0], before[1] - this.state.pos[1], before[2] - this.state.pos[2]];
    if (Math.hypot(...err) > 48) this.smooth = [0, 0, 0];           // a real teleport: snap
    else for (let i = 0; i < 3; i++) this.smooth[i] += err[i];
  }

  // CS zoom levels are fields of view out of its 90 degrees: the same
  // magnification, tan(f/2) / tan(45), applied to our base view
  fovTarget() {
    const w = WEAPONS[this.weapon];
    const f = this.zoom === 1 ? w.zoomFov : this.zoom === 2 ? (w.zoomFov2 || w.zoomFov) : 0;
    if (!f) return BASE_FOV;
    const mag = Math.tan((f / 2) * Math.PI / 180);
    return 2 * Math.atan(Math.tan((BASE_FOV / 2) * Math.PI / 180) * mag) * 180 / Math.PI;
  }

  applyCamera(dt) {
    const e = this._eyeSmooth;
    this.camera.position.set(this.state.pos[0] + this.smooth[0], this.state.pos[1] + e + this.smooth[1], this.state.pos[2] + this.smooth[2]);
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
