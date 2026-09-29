// Keyboard + pointer-lock mouse state. The player controller polls this each
// frame; nothing here touches the network. UI keys (buy, scores, chat) are
// delivered as callbacks so main.js can route them.

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyR', 'KeyQ', 'KeyE', 'KeyB', 'KeyY', 'KeyG',
  'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'Tab',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1',
]);

export class Input {
  constructor() {
    this.keys = new Set();
    this.lookX = 0;      // accumulated mouse deltas since last consume
    this.lookY = 0;
    this.lastLookX = 0;  // last consumed (radians), for viewmodel sway
    this.lastLookY = 0;
    this.fireHeld = false;
    this.firePressed = false;  // edge-triggered, consumed by player
    this.zoomPressed = false;
    this.reloadPressed = false;
    this.weaponSlot = 0;       // 1..3, 0 = none this frame
    this.lastWeapon = false;
    this.wheel = 0;
    this.locked = false;
    this.typing = false;       // chat box open: game keys are ignored
    this.capture = false;      // in a match: swallow browser shortcuts (Ctrl+D, Ctrl+S, …)
    this.onLockChange = null;
    this.onKey = null;         // (code, event) for UI keys: KeyB, Tab, KeyY, Escape
    this.sensitivity = 0.0022;
    this.fovScale = 1;         // < 1 while scoped
    this._el = null;
  }

  attach(el) {
    this._el = el;

    window.addEventListener('keydown', (e) => {
      if (this.typing) return;
      // Crouch is Ctrl, so Ctrl+D (strafe right) would open Chrome's bookmark
      // dialog, Ctrl+S "save page", etc. While playing, the game owns the
      // keyboard. (Ctrl+W can only be blocked in fullscreen: see lockKeys.)
      if (this.capture && (e.ctrlKey || e.metaKey || e.altKey || GAME_KEYS.has(e.code))) e.preventDefault();
      if (e.code === 'Tab') e.preventDefault();
      if (['KeyB', 'Tab', 'KeyY', 'Escape', 'Enter'].includes(e.code) && this.onKey) this.onKey(e.code, e, true);
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.reloadPressed = true;
      if (e.code === 'KeyG') this.dropPressed = true;
      if (e.code === 'KeyQ') this.lastWeapon = true;
      if (e.code.startsWith('Digit')) {
        const n = parseInt(e.code.slice(5), 10);
        if (n >= 1 && n <= 5) this.weaponSlot = n;
      }
      if (e.code === 'ControlLeft' || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Tab' && this.onKey) this.onKey('Tab', e, false);
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.fireHeld = false; });

    el.addEventListener('mousedown', (e) => {
      if (!this.locked) { this.lock(); return; }
      if (e.button === 0) { this.fireHeld = true; this.firePressed = true; }
      if (e.button === 2) this.zoomPressed = true;
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.fireHeld = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      if (!this.locked) { this.fireHeld = false; }
      if (this.onLockChange) this.onLockChange(this.locked);
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lookX += e.movementX || 0;
      this.lookY += e.movementY || 0;
    });
  }

  lock() {
    if (!this._el || this.locked) return;
    // raw (unaccelerated) mouse where supported; plain lock otherwise. Without
    // a user gesture this fails quietly and the "click to play" hint remains.
    const plain = () => { try { const r = this._el.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch { /* not now */ } };
    try {
      const r = this._el.requestPointerLock({ unadjustedMovement: true });
      if (r && r.catch) r.catch((e) => { if (e && e.name === 'NotSupportedError') plain(); });
    } catch { plain(); }
  }

  // Fullscreen + Keyboard Lock: the only way a page may receive Ctrl+W, Ctrl+T
  // and friends (Chromium). Esc must then be HELD to leave fullscreen.
  async toggleFullscreen() {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    if (navigator.keyboard && navigator.keyboard.lock) {
      try { await navigator.keyboard.lock(); } catch { /* not supported here */ }
    }
  }

  // Movement key snapshot for the player controller.
  moveKeys() {
    const k = this.keys;
    if (this.typing) return { f: 0, b: 0, l: 0, r: 0, jump: 0, crouch: 0, walk: 0 };
    return {
      f: k.has('KeyW') || k.has('ArrowUp'),
      b: k.has('KeyS') || k.has('ArrowDown'),
      l: k.has('KeyA') || k.has('ArrowLeft'),
      r: k.has('KeyD') || k.has('ArrowRight'),
      jump: k.has('Space'),
      crouch: k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyC'),
      walk: k.has('ShiftLeft') || k.has('ShiftRight'),
    };
  }

  // Consume accumulated mouse-look deltas (radians), applying sensitivity.
  consumeLook() {
    const s = this.sensitivity * this.fovScale;
    const dx = this.lookX * s;
    const dy = this.lookY * s;
    this.lookX = 0; this.lookY = 0;
    this.lastLookX = dx; this.lastLookY = dy;
    return [dx, dy];
  }

  consumeFirePressed() { const v = this.firePressed; this.firePressed = false; return v; }
  consumeZoom() { const v = this.zoomPressed; this.zoomPressed = false; return v; }
  consumeReload() { const v = this.reloadPressed; this.reloadPressed = false; return v; }
  consumeWeaponSlot() { const v = this.weaponSlot; this.weaponSlot = 0; return v; }
  consumeLastWeapon() { const v = this.lastWeapon; this.lastWeapon = false; return v; }
  consumeWheel() { const v = this.wheel; this.wheel = 0; return v; }
  consumeDrop() { const v = this.dropPressed; this.dropPressed = false; return v; }
  useHeld() { return !this.typing && this.keys.has('KeyE'); }
}
