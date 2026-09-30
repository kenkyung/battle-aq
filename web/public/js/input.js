// Keyboard + pointer-lock mouse state. The player controller polls this each
// frame; nothing here touches the network. UI keys (buy, scores, chat) are
// delivered as callbacks so main.js can route them.

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyR', 'KeyQ', 'KeyE', 'KeyB', 'KeyY', 'KeyG', 'KeyZ', 'KeyX', 'KeyV',
  'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'Tab',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1', 'F2', 'Comma', 'Period', 'KeyO',
]);

// Key bindings, CS style: physical key -> action. The game logic listens for
// each action's canonical key (CANON), so a rebind is a translation here and
// nothing else changes. Edited with the console (bind / unbind / binds).
export const DEFAULT_BINDS = {
  KeyW: '+forward', KeyS: '+back', KeyA: '+moveleft', KeyD: '+moveright',
  ArrowUp: '+forward', ArrowDown: '+back', ArrowLeft: '+moveleft', ArrowRight: '+moveright',
  Space: '+jump', KeyC: '+duck', ControlLeft: '+duck', ControlRight: '+duck', ShiftLeft: '+speed', ShiftRight: '+speed',
  KeyR: '+reload', KeyE: '+use', KeyG: 'drop', KeyQ: 'lastinv', KeyB: 'buymenu', Tab: '+showscores',
  KeyY: 'messagemode', KeyZ: 'radio1', KeyX: 'radio2', KeyV: 'radio3', F1: 'autobuy', F2: 'rebuy', F3: 'ready',
  Comma: 'buyammo1', Period: 'buyammo2', KeyO: 'buyequip', KeyM: 'chooseteam', Backquote: 'toggleconsole',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4', Digit5: 'slot5',
  KeyN: 'nightvision', KeyK: '+voicerecord',
};
export const CANON = {
  '+forward': 'KeyW', '+back': 'KeyS', '+moveleft': 'KeyA', '+moveright': 'KeyD', '+jump': 'Space', '+duck': 'KeyC',
  '+speed': 'ShiftLeft', '+reload': 'KeyR', '+use': 'KeyE', drop: 'KeyG', lastinv: 'KeyQ', buymenu: 'KeyB',
  '+showscores': 'Tab', messagemode: 'KeyY', radio1: 'KeyZ', radio2: 'KeyX', radio3: 'KeyV', autobuy: 'F1', rebuy: 'F2', ready: 'F3',
  buyammo1: 'Comma', buyammo2: 'Period', buyequip: 'KeyO', chooseteam: 'KeyM', toggleconsole: 'Backquote',
  slot1: 'Digit1', slot2: 'Digit2', slot3: 'Digit3', slot4: 'Digit4', slot5: 'Digit5',
  nightvision: 'KeyN', '+voicerecord': 'KeyK',
};
const UI_KEYS = ['F3', 'KeyB', 'Tab', 'KeyY', 'Escape', 'Enter', 'KeyZ', 'KeyX', 'KeyV', 'F1', 'F2', 'Comma', 'Period', 'KeyO', 'KeyM', 'Backquote', 'KeyN', 'KeyK'];

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
    this.binds = { ...DEFAULT_BINDS };
    this.held = new Map();     // canonical key -> physical keys holding it
  }

  // physical key -> the canonical key of its bound action (or null)
  canon(code) {
    const action = this.binds[code];
    return action ? CANON[action] || null : null;
  }

  attach(el) {
    this._el = el;

    window.addEventListener('keydown', (e) => {
      if (this.typing) return;
      // Crouch is Ctrl, so Ctrl+D (strafe right) would open Chrome's bookmark
      // dialog, Ctrl+S "save page", etc. While playing, the game owns the
      // keyboard. (Ctrl+W can only be blocked in fullscreen: see lockKeys.)
      if (this.capture && (e.ctrlKey || e.metaKey || e.altKey || GAME_KEYS.has(e.code) || this.binds[e.code])) e.preventDefault();
      if (e.code === 'Tab' || e.code === 'F1' || e.code === 'F2' || e.code === 'F3') e.preventDefault();   // F1 would open Chrome's help
      if (this.consoleOpen) return;                   // the console has the keyboard
      // digits pick a radio / buy / team menu line whatever they are bound to
      if ((this.radioOpen || this.buyOpen || this.menuOpen) && /^Digit[0-9]$/.test(e.code)) { if (this.onKey) this.onKey(e.code, e, true); return; }
      const code = e.code === 'Escape' || e.code === 'Enter' ? e.code : this.canon(e.code);
      if (!code) return;
      if (UI_KEYS.includes(code) && this.onKey) this.onKey(code, e, true);
      if (e.repeat) return;
      if (!this.held.has(code)) this.held.set(code, new Set());
      this.held.get(code).add(e.code);
      this.keys.add(code);
      if (code === 'KeyR') this.reloadPressed = true;
      if (code === 'KeyG') this.dropPressed = true;
      if (code === 'KeyQ') this.lastWeapon = true;
      if (code.startsWith('Digit')) {
        const n = parseInt(code.slice(5), 10);
        if (n >= 1 && n <= 5) this.weaponSlot = n;
      }
      if (code === 'KeyC' || code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      const code = this.canon(e.code);
      if (!code) return;
      const h = this.held.get(code);
      if (h) h.delete(e.code);
      if (!h || !h.size) this.keys.delete(code);   // another key bound to it may still hold it
      if ((code === 'Tab' || code === 'KeyK') && this.onKey) this.onKey(code, e, false);
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.held.clear(); this.fireHeld = false; });

    el.addEventListener('mousedown', (e) => {
      if (!this.locked) { this.lock(); return; }
      // the buy menu keeps the mouse captured and drives an in-game cursor
      if (this.buyOpen && this.onCursorClick) { if (e.button === 0) this.onCursorClick(); return; }
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
      if (this.buyOpen && this.onCursor) { this.onCursor(e.movementX || 0, e.movementY || 0); return; }
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
  // Esc is then delivered to the game too, so it no longer drops the mouse.
  async toggleFullscreen() {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    await this.enterFullscreen();
  }

  async enterFullscreen() {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    if (navigator.keyboard && navigator.keyboard.lock) {
      try { await navigator.keyboard.lock(); } catch { /* not supported here */ }
    }
  }

  get keyboardLocked() { return !!document.fullscreenElement && !!(navigator.keyboard && navigator.keyboard.lock); }

  // Movement key snapshot for the player controller.
  moveKeys() {
    const k = this.keys;
    if (this.typing) return { f: 0, b: 0, l: 0, r: 0, jump: 0, crouch: 0, walk: 0 };
    return {
      f: k.has('KeyW'), b: k.has('KeyS'), l: k.has('KeyA'), r: k.has('KeyD'),
      jump: k.has('Space'), crouch: k.has('KeyC'), walk: k.has('ShiftLeft'),
    };
  }

  // Consume accumulated mouse-look deltas (radians), applying sensitivity.
  consumeLook() {
    const s = this.sensitivity * this.fovScale;
    const dx = this.lookX * s;
    const dy = this.lookY * s * (this.pitchSign || 1);   // m_pitch < 0: inverted
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
