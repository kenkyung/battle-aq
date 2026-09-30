// Developer console (` / ~), CS style: cvars and commands, key bindings, and
// a config that persists (localStorage stands in for config.cfg).

import { DEFAULT_BINDS, CANON } from './input.js';

// CS key names <-> KeyboardEvent codes
const NAMED = {
  space: 'Space', ctrl: 'ControlLeft', rctrl: 'ControlRight', shift: 'ShiftLeft', rshift: 'ShiftRight', alt: 'AltLeft',
  tab: 'Tab', enter: 'Enter', escape: 'Escape', backspace: 'Backspace', '`': 'Backquote', ',': 'Comma', '.': 'Period',
  '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal',
  uparrow: 'ArrowUp', downarrow: 'ArrowDown', leftarrow: 'ArrowLeft', rightarrow: 'ArrowRight',
  ins: 'Insert', del: 'Delete', home: 'Home', end: 'End', pgup: 'PageUp', pgdn: 'PageDown',
  kp_enter: 'NumpadEnter', capslock: 'CapsLock',
};
export function keyCode(name) {
  const n = String(name).toLowerCase();
  if (NAMED[n]) return NAMED[n];
  if (/^[a-z]$/.test(n)) return 'Key' + n.toUpperCase();
  if (/^[0-9]$/.test(n)) return 'Digit' + n;
  if (/^f([1-9]|1[0-2])$/.test(n)) return n.toUpperCase();
  if (/^kp_[0-9]$/.test(n)) return 'Numpad' + n.slice(3);
  return /^[A-Z][A-Za-z0-9]+$/.test(name) ? name : null;       // already a code
}
export function keyName(code) {
  for (const [k, v] of Object.entries(NAMED)) if (v === code) return k;
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'kp_' + code.slice(6).toLowerCase();
  return code.toLowerCase();
}

export class GameConsole {
  constructor(api) {
    this.api = api;
    this.el = document.createElement('div');
    this.el.id = 'console';
    this.el.className = 'hidden';
    this.el.innerHTML = '<div id="conLog"></div><input id="conInput" spellcheck="false" autocomplete="off" />';
    document.body.appendChild(this.el);
    this.log = this.el.querySelector('#conLog');
    this.inp = this.el.querySelector('#conInput');
    this.history = [];
    this.hIdx = 0;
    this.cvars = {};
    this.defs = {};
    this.cmds = {};
    this.inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') { const line = this.inp.value; this.inp.value = ''; this.exec(line, true); }
      else if (e.code === 'Escape' || e.code === 'Backquote') { e.preventDefault(); this.toggle(false); }
      else if (e.code === 'ArrowUp') { e.preventDefault(); this.hIdx = Math.max(0, this.hIdx - 1); this.inp.value = this.history[this.hIdx] || ''; }
      else if (e.code === 'ArrowDown') { e.preventDefault(); this.hIdx = Math.min(this.history.length, this.hIdx + 1); this.inp.value = this.history[this.hIdx] || ''; }
      else if (e.code === 'Tab') { e.preventDefault(); this.complete(); }
    });
    this.print('Battle-AQ console — "help" lists commands, "cvarlist" the variables.');
  }

  isOpen() { return !this.el.classList.contains('hidden'); }

  toggle(on = !this.isOpen()) {
    this.el.classList.toggle('hidden', !on);
    this.api.input.consoleOpen = on;
    if (on) { this.api.input.keys.clear(); setTimeout(() => this.inp.focus(), 0); if (document.pointerLockElement) document.exitPointerLock(); }
    else { this.inp.blur(); this.api.onClose && this.api.onClose(); }
  }

  print(text, cls = '') {
    const d = document.createElement('div');
    d.textContent = text;
    if (cls) d.className = cls;
    this.log.appendChild(d);
    while (this.log.children.length > 300) this.log.firstChild.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  // a variable: default, help, and what happens when it is set
  cvar(name, def, help, apply) {
    this.defs[name] = { def, help, apply };
    const saved = this.api.store.get('cvar_' + name, null);
    this.cvars[name] = saved !== null ? saved : String(def);
    if (apply) apply(this.cvars[name], true);
  }

  cmd(name, help, fn) { this.cmds[name] = { help, fn }; }

  set(name, value) {
    const d = this.defs[name];
    this.cvars[name] = String(value);
    this.api.store.set('cvar_' + name, String(value));
    if (d && d.apply) d.apply(String(value), false);
  }

  complete() {
    const v = this.inp.value.trim().toLowerCase();
    if (!v) return;
    const all = [...Object.keys(this.cmds), ...Object.keys(this.defs)].filter((n) => n.startsWith(v)).sort();
    if (all.length === 1) this.inp.value = all[0] + ' ';
    else if (all.length) this.print(all.join('  '), 'dim');
  }

  exec(line, echo = false) {
    for (const part of String(line).split(';')) {
      const text = part.trim();
      if (!text) continue;
      if (echo) { this.print('] ' + text, 'echo'); this.history.push(text); this.hIdx = this.history.length; }
      const args = (text.match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
      const name = args[0].toLowerCase();
      if (this.cmds[name]) { try { this.cmds[name].fn(args.slice(1)); } catch (e) { this.print(String(e)); } continue; }
      if (this.defs[name]) {
        if (args.length < 2) this.print(`"${name}" is "${this.cvars[name]}" (default "${this.defs[name].def}") — ${this.defs[name].help}`);
        else this.set(name, args.slice(1).join(' '));
        continue;
      }
      this.print(`Unknown command: ${name}`);
    }
  }
}

// every action a key can be bound to
export const ACTIONS = Object.keys(CANON);
export { DEFAULT_BINDS };
