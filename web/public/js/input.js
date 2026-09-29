// Keyboard + pointer-lock mouse state. The player controller polls this each
// frame; nothing here touches the network.

export class Input {
  constructor() {
    this.keys = new Set();
    this.lookX = 0;      // accumulated mouse deltas since last consume
    this.lookY = 0;
    this.fireHeld = false;
    this.firePressed = false;  // edge-triggered, consumed by player
    this.reloadPressed = false;
    this.weaponSlot = 0;       // 1..9, 0 = none this frame
    this.locked = false;
    this.onLockChange = null;
    this.sensitivity = 0.0025;
    this._el = null;
  }

  attach(el) {
    this._el = el;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.reloadPressed = true;
      if (e.code.startsWith('Digit')) {
        const n = parseInt(e.code.slice(5), 10);
        if (n >= 1 && n <= 9) this.weaponSlot = n;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        if (!this.locked) { el.requestPointerLock(); }
        this.fireHeld = true;
        this.firePressed = true;
      }
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.fireHeld = false; });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      if (!this.locked) { this.fireHeld = false; this.keys.clear(); }
      if (this.onLockChange) this.onLockChange(this.locked);
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lookX += e.movementX || 0;
      this.lookY += e.movementY || 0;
    });
  }

  // Movement key snapshot for the player controller.
  moveKeys() {
    const k = this.keys;
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
    const dx = this.lookX * this.sensitivity;
    const dy = this.lookY * this.sensitivity;
    this.lookX = 0; this.lookY = 0;
    return [dx, dy];
  }

  consumeFirePressed() { const v = this.firePressed; this.firePressed = false; return v; }
  consumeReload() { const v = this.reloadPressed; this.reloadPressed = false; return v; }
  consumeWeaponSlot() { const v = this.weaponSlot; this.weaponSlot = 0; return v; }
}
