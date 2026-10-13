// Controller support. capy-pad.js (vendor/, loaded before this module) wraps
// navigator.getGamepads() so buttons 0..3 are the buttons PRINTED A/B/X/Y on
// the house pad, the Onikuma Iruka (Switch-style: A right, B bottom, X top,
// Y left). This module turns the pad into the same Input state the keyboard
// and mouse fill, so the player controller and the netcode do not change:
// movement is still the 8-way key bitmask the server simulates.
//
//   left stick  move (a light tilt walks, silently)   L3  walk toggle
//   right stick look (deadzone, curve, acceleration)  R3  radio menu (again: next menu)
//   ZR fire · ZL scope / silencer / burst (hold = aim, release = unscope)
//   A jump · B crouch (hold) · X reload · Y next weapon (hold: drop it)
//   L grenades · R use (doors, defuse, hostages)
//   D-pad ▲ primary · ◀ pistol · ▶ knife · ▼ buy menu
//   − scoreboard (hold) · + pause menu
//
// Every HTML overlay (main menu, buy, radio, team, appearance, pause, side
// vote, veto, map vote, reconnect) is driven by CapyPad.nav: D-pad moves,
// A selects, B goes back. No aim assist: the server trusts the same inputs
// from everybody.

const LOOK_DZ = 0.12;          // right stick radial deadzone
const MOVE_DZ = 0.24;          // left stick: below this, no movement
const WALK_TILT = 0.62;        // left stick: below this tilt, walk (silent, slower)
const DIAG = 0.38;             // sin 22.5°: 8-way split of the stick
const NAV = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, back: 8, start: 9, up: 12, down: 13, left: 14, right: 15 };

export class PadControls {
  // hooks: menuRoot() -> Element|null, back(root), start(root), buy(), radio(),
  //        pause(), scores(on), unzoom(), anyPress(), modeChanged(on), toast(text)
  constructor(input, hooks) {
    this.input = input;
    this.h = hooks;
    this.sens = 5;             // 1..10: turn rate at full tilt = sens * 0.55 rad/s before acceleration
    this.invert = false;
    this.prev = [];
    this.block = new Set();    // buttons held across a menu closing: ignored until released
    this.navEat = new Set();   // nav names held as a menu opened: nav ignores them until released
    this.lastMenu = null;
    this.walkToggle = false;
    this.padFire = false;
    this.accT = 0;
    this.zlAt = 0; this.yAt = 0; this.yDone = false;
    this.connected = false;
    this._mode = false;
    this.nav = null;
  }

  get C() { return window.CapyPad || null; }
  label(i) { return this.C ? this.C.label(i) : ''; }

  startNav() {
    if (!this.C || this.nav) return;
    this.nav = this.C.nav({
      root: () => this.h.menuRoot(),
      back: () => { const r = this.h.menuRoot(); if (r) this.h.back(r); },
      start: () => { const r = this.h.menuRoot(); if (r) this.h.start(r); },
      select: 'summary,[data-pad]',
      onButton: (k) => {
        this.input.padMode = true;
        return this.navEat.has(k);
      },
    });
  }

  // menu opened / closed since the last look: hand held buttons over cleanly
  _menuEdge(btn) {
    const m = this.h.menuRoot();
    if (m === this.lastMenu) return m;
    if (m && !this.lastMenu) {
      this.navEat.clear();
      for (const [k, i] of Object.entries(NAV)) if (btn[i]) this.navEat.add(k);
    }
    if (!m) for (let i = 0; i < btn.length; i++) if (btn[i]) this.block.add(i);
    this.lastMenu = m;
    return m;
  }

  _clear() {
    const p = this.input.pad;
    p.f = p.b = p.l = p.r = p.walk = p.jump = p.crouch = p.use = false;
    p.lookX = p.lookY = 0;
    if (this.padFire) { this.input.fireHeld = false; this.padFire = false; }
    this.accT = 0; this.zlAt = 0; this.yAt = 0;
    this.h.scores(false);
  }

  setMode(on) {
    if (on !== this._mode) { this._mode = on; this.h.modeChanged(on); }
  }

  rumble(strong, weak, ms) {
    if (!this.input.padMode || !this.C) return;
    try {
      const gp = this.C.pads().find((g) => g && g.vibrationActuator);
      if (gp) gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
    } catch { /* no rumble */ }
  }

  poll(dt) {
    this.setMode(this.input.padMode);
    const r = this.C ? this.C.read() : null;
    if (!r) {
      if (this.connected) { this.connected = false; this._clear(); }
      this.prev = [];
      return;
    }
    this.connected = true;
    const btn = [r.a, r.b, r.x, r.y, r.lb, r.rb, r.lt > 0.45, r.rt > 0.35, r.back, r.start, r.l3, r.r3, r.up, r.down, r.left, r.right];
    const edge = btn.map((v, i) => v && !this.prev[i]);
    const rel = btn.map((v, i) => !v && this.prev[i]);
    this.prev = btn;
    for (const i of [...this.block]) if (!btn[i]) this.block.delete(i);
    for (const k of [...this.navEat]) if (!btn[NAV[k]]) this.navEat.delete(k);
    const sticks = Math.max(Math.abs(r.lx), Math.abs(r.ly), Math.abs(r.rx), Math.abs(r.ry));
    if (edge.some(Boolean) || sticks > 0.5) {
      if (!this.input.padMode) { this.input.padMode = true; this.setMode(true); }
      if (edge.some(Boolean)) this.h.anyPress();
    }

    const menu = this._menuEdge(btn);
    if (menu || this.input.typing) {
      this._clear();
      if (menu && edge[11] && this.h.radioOpen()) this.h.radio();     // R3 flips through the radio menus
      return;
    }

    const now = performance.now() / 1000;
    const on = (i) => btn[i] && !this.block.has(i);
    const hit = (i) => edge[i] && !this.block.has(i);
    const inp = this.input, p = inp.pad;

    // ---- left stick: 8-way movement, light tilt walks
    const lm = Math.hypot(r.lx, r.ly);
    if (lm > MOVE_DZ) {
      const nx = r.lx / lm, ny = r.ly / lm;
      p.f = ny < -DIAG; p.b = ny > DIAG; p.l = nx < -DIAG; p.r = nx > DIAG;
    } else p.f = p.b = p.l = p.r = false;
    if (hit(10)) { this.walkToggle = !this.walkToggle; this.h.toast(this.walkToggle ? 'walking (silent)' : 'running'); }
    p.walk = this.walkToggle || (lm > MOVE_DZ && lm < WALK_TILT);

    // ---- right stick: look. Radial deadzone, squared response curve, and
    // acceleration once the stick has been at the rim for a moment.
    const rm = Math.hypot(r.rx, r.ry);
    if (rm > LOOK_DZ) {
      const m = Math.min(1, (rm - LOOK_DZ) / (1 - LOOK_DZ));
      if (m > 0.92) this.accT += dt; else this.accT = Math.max(0, this.accT - dt * 3);
      const boost = 1 + 0.8 * Math.min(1, Math.max(0, this.accT - 0.15) / 0.45);
      const rate = this.sens * 0.55 * m * m * boost * dt;
      p.lookX += (r.rx / rm) * rate;
      p.lookY += (r.ry / rm) * rate * 0.72 * (this.invert ? -1 : 1);
    } else this.accT = 0;

    // ---- buttons
    p.jump = on(0);
    p.crouch = on(1);
    p.use = on(5);
    if (hit(7)) { inp.firePressed = true; inp.fireHeld = true; this.padFire = true; }
    if (this.padFire && !btn[7]) { inp.fireHeld = false; this.padFire = false; }
    // ZL: a tap is the right mouse button (zoom levels, silencer, burst);
    // holding it aims, and letting go of a held aim unscopes
    if (hit(6)) { inp.zoomPressed = true; this.zlAt = now; }
    if (rel[6] && this.zlAt) { if (now - this.zlAt > 0.35) this.h.unzoom(); this.zlAt = 0; }
    if (hit(2)) inp.reloadPressed = true;
    // Y: tap = next weapon, hold = drop it
    if (hit(3)) { this.yAt = now; this.yDone = false; }
    if (btn[3] && this.yAt && !this.yDone && now - this.yAt > 0.45) { inp.dropPressed = true; this.yDone = true; }
    if (rel[3] && this.yAt) { if (!this.yDone) inp.wheel += 1; this.yAt = 0; }
    if (hit(4)) inp.weaponSlot = 4;
    if (hit(12)) inp.weaponSlot = 1;
    if (hit(14)) inp.weaponSlot = 2;
    if (hit(15)) inp.weaponSlot = 3;
    if (hit(11)) this.h.radio();
    this.h.scores(on(8));
    // these open menus: whatever is held right now must not act in them
    if (hit(13)) { this.h.buy(); this._menuEdge(btn); }
    if (hit(9)) { this.h.pause(); this._menuEdge(btn); }
  }
}

// "{0} jump · {1} crouch" -> the printed names of the pad in your hands
export function padText(tpl) {
  const C = window.CapyPad;
  return tpl.replace(/\{(\d+)\}/g, (_, i) => (C ? C.label(+i) : ''));
}
