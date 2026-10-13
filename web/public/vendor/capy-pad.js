/* capy-pad.js — APFORGE Arcade shared controller layer  (v1, 2026-10-12)
 *
 * Canonical copy: amnajb/arcade pad/capy-pad.js. Every game vendors this
 * file unchanged; update it there and copy it out with pad/sync.sh.
 *
 * Load it BEFORE the game's own scripts. It does three things:
 *
 * 1. Button labels follow the controller in your hands.
 *    The house controller is the Onikuma Iruka (C1). It reaches the browser as
 *    an "Xbox 360 / XInput" pad, but its face buttons are printed Nintendo-
 *    style: A on the RIGHT, B on the bottom, X on top, Y on the left. Games
 *    read buttons[0] as "A", so out of the box the Iruka's A did B's job.
 *    navigator.getGamepads() is wrapped so that buttons[0] is the button
 *    PRINTED "A" (and 1 = B, 2 = X, 3 = Y). Every game's existing controller
 *    code and on-screen "press A" prompts then match the Iruka with no
 *    other changes. Real Switch Pro pads land the same way.
 *      layouts: 'nintendo' (default) · 'xbox' (positional, A = bottom)
 *               'playstation' (positional, ✕ = bottom; auto for DualSense/DS4)
 *    The choice lives in localStorage 'capyPad.layout' and is shared by every
 *    game on the arcade (same origin). The picker page has the switch.
 *
 * 2. Odd drivers are flattened to the W3C standard layout: Firefox-on-
 *    Windows XInput (triggers on axes 2/5, right stick on 3/4), D-pads that
 *    arrive as a hat switch (axes[9]) or a pair of axes (6/7). Games always
 *    see mapping 'standard', 17 buttons, 4 axes.
 *
 * 3. CapyPad.nav(): D-pad / left-stick menu navigation for HTML menus.
 *    A clicks the focused control, B presses the screen's back button.
 *
 * API (window.CapyPad):
 *   CapyPad.pads()           normalised pads (what getGamepads() now returns)
 *   CapyPad.native()         the browser's untouched getGamepads()
 *   CapyPad.layout(gp?)      'nintendo' | 'xbox' | 'playstation'
 *   CapyPad.setLayout(v)     v = one of the above, or 'auto' to clear
 *   CapyPad.label(i)         printed name of standard button i ('A','B','✕'…)
 *   CapyPad.read(gp?)        friendly snapshot {a,b,x,y,lb,rb,lt,rt,back,start,
 *                            l3,r3,home,up,down,left,right,lx,ly,rx,ry,any}
 *   CapyPad.nav(opts)        start menu navigation (see below); returns ctl
 */
(function(){
  'use strict';
  if (window.CapyPad) return;
  var nav0 = window.navigator;
  var nativeGet = nav0.getGamepads ? nav0.getGamepads.bind(nav0) : null;
  var KEY = 'capyPad.layout';
  var LAYOUTS = ['nintendo', 'xbox', 'playstation'];

  function pref(){
    try { var v = localStorage.getItem(KEY); return LAYOUTS.indexOf(v) >= 0 ? v : 'auto'; }
    catch (e) { return 'auto'; }
  }
  function layoutFor(gp){
    var p = pref();
    if (p !== 'auto') return p;
    var id = (gp && gp.id) || '';
    if (/054c|dualsense|dualshock|playstation/i.test(id)) return 'playstation';
    return 'nintendo';
  }

  /* ---- 1+2: normalise one raw Gamepad into a standard-shaped object ---- */
  function btnVal(b){
    if (b == null) return 0;
    if (typeof b === 'number') return b;
    return b.value !== undefined ? (b.pressed && !b.value ? 1 : b.value) : (b.pressed ? 1 : 0);
  }
  function trigAx(v){
    /* trigger axes rest at -1 and travel to +1 on most drivers, a few use 0..1 */
    if (v === undefined) return 0;
    return v < -0.2 ? (v + 1) / 2 : (v > 0.2 ? v : 0);
  }
  function mkBtn(v){ return { pressed: v > 0.5, touched: v > 0.05, value: v }; }

  function standardise(gp){
    var bt = gp.buttons || [], ax = gp.axes || [];
    var std = gp.mapping === 'standard';
    var v = new Array(17), a = [0, 0, 0, 0], i;
    for (i = 0; i < 17; i++) v[i] = 0;
    for (i = 0; i < 12 && i < bt.length; i++) v[i] = btnVal(bt[i]);
    a[0] = ax[0] || 0; a[1] = ax[1] || 0;
    if (std){
      for (i = 12; i < 17 && i < bt.length; i++) v[i] = btnVal(bt[i]);
      a[2] = ax[2] || 0; a[3] = ax[3] || 0;
    } else {
      if (ax.length >= 6){                 /* Firefox-on-Windows XInput */
        a[2] = ax[3] || 0; a[3] = ax[4] || 0;
        v[6] = Math.max(v[6], trigAx(ax[2]));
        v[7] = Math.max(v[7], trigAx(ax[5]));
      } else { a[2] = ax[2] || 0; a[3] = ax[3] || 0; }
      if (bt.length >= 16){
        for (i = 12; i < 17 && i < bt.length; i++) v[i] = btnVal(bt[i]);
      } else if (bt.length >= 13){
        v[16] = btnVal(bt[12]);            /* DirectInput Switch-style: 12 = Home */
      }
      var hx = ax[6], hy = ax[7];
      if (ax.length === 8 && hx !== undefined){
        if (hx < -0.5) v[14] = 1; if (hx > 0.5) v[15] = 1;
        if (hy < -0.5) v[12] = 1; if (hy > 0.5) v[13] = 1;
      }
      var hat = ax[9];
      if (hat !== undefined && hat >= -1.01 && hat <= 1.01){
        /* eight directions spread over -1..1 (step 2/7); rest is ~3.28 */
        var d = Math.round((hat + 1) * 3.5);
        if (d === 7 || d === 0 || d === 1) v[12] = 1;
        if (d >= 1 && d <= 3) v[15] = 1;
        if (d >= 3 && d <= 5) v[13] = 1;
        if (d >= 5 && d <= 7) v[14] = 1;
      }
    }
    return { v: v, a: a };
  }

  /* map printed-label slots to positional slots: out[i] = in[PERM[i]] */
  var SWAP = [1, 0, 3, 2];
  function wrap(gp){
    var s = standardise(gp), lay = layoutFor(gp), v = s.v;
    if (lay === 'nintendo'){
      var f = v.slice(0, 4);
      for (var i = 0; i < 4; i++) v[i] = f[SWAP[i]];
    }
    var buttons = v.map(mkBtn);
    return {
      id: gp.id, index: gp.index, connected: gp.connected !== false,
      mapping: 'standard', timestamp: gp.timestamp,
      axes: s.a, buttons: buttons,
      vibrationActuator: gp.vibrationActuator || null,
      hapticActuators: gp.hapticActuators || [],
      capyLayout: lay, raw: gp
    };
  }

  function pads(){
    if (!nativeGet) return [];
    var raw = nativeGet() || [], out = [];
    for (var i = 0; i < raw.length; i++){
      var g = raw[i];
      out.push(g && g.connected !== false ? wrap(g) : null);
    }
    return out;
  }
  if (nativeGet){
    try {
      Object.defineProperty(nav0, 'getGamepads', { value: pads, configurable: true, writable: true });
    } catch (e) { try { nav0.getGamepads = pads; } catch (e2) {} }
  }

  var LABELS = {
    nintendo:    ['A', 'B', 'X', 'Y', 'L', 'R', 'ZL', 'ZR', '−', '+', 'L3', 'R3', '▲', '▼', '◀', '▶', 'HOME'],
    xbox:        ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3', '▲', '▼', '◀', '▶', 'Guide'],
    playstation: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', '▲', '▼', '◀', '▶', 'PS']
  };

  function first(){
    var p = pads();
    var best = null;
    for (var i = 0; i < p.length; i++){
      var g = p[i]; if (!g) continue;
      if (!best) best = g;
      /* prefer the pad somebody is actually touching */
      for (var j = 0; j < g.buttons.length; j++) if (g.buttons[j].pressed) return g;
      for (var k = 0; k < 4; k++) if (Math.abs(g.axes[k]) > 0.5) return g;
    }
    return best;
  }
  function read(gp){
    gp = gp || first();
    if (!gp) return null;
    if (!gp.capyLayout) gp = wrap(gp);
    var b = function(i){ return gp.buttons[i].pressed; };
    var r = {
      a: b(0), b: b(1), x: b(2), y: b(3), lb: b(4), rb: b(5),
      lt: gp.buttons[6].value, rt: gp.buttons[7].value,
      back: b(8), start: b(9), l3: b(10), r3: b(11), home: b(16),
      up: b(12), down: b(13), left: b(14), right: b(15),
      lx: gp.axes[0], ly: gp.axes[1], rx: gp.axes[2], ry: gp.axes[3],
      id: gp.id, index: gp.index, layout: gp.capyLayout
    };
    r.any = gp.buttons.some(function(x){ return x.pressed; }) ||
            Math.abs(r.lx) > 0.5 || Math.abs(r.ly) > 0.5;
    return r;
  }

  /* ---- 3: menu navigation ------------------------------------------------
     CapyPad.nav({
       root:   () => Element|null   the menu currently on screen (null = off,
                                    e.g. while playing). Default: document.body
       back:   () => void           B / Back. Default: clicks [data-pad-back]
                                    inside root, if any
       start:  () => void           Start / + (optional)
       select: string               CSS for extra focusables
       onButton: (name) => bool     see every press first; return true to eat it
       wrapFocus: bool              keep focus inside root (default true)
     }) → { stop(), focus(el), current() }
     Arrow keys are never touched, so keyboard menus keep working as before. */
  var FOCUSABLE = 'button,a[href],input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"]),[data-pad]';
  var cssDone = false;
  function addCss(){
    if (cssDone) return; cssDone = true;
    var st = document.createElement('style');
    st.textContent = '.cp-focus{outline:3px solid #ffd23d!important;outline-offset:3px!important;' +
      'box-shadow:0 0 0 6px rgba(255,210,61,.28)!important;position:relative;z-index:1}' +
      'body.cp-mouse .cp-focus{outline:none!important;box-shadow:none!important}';
    (document.head || document.documentElement).appendChild(st);
  }
  function visible(el){
    if (!el || el.disabled || el.closest('[hidden],[inert],[aria-hidden=true]')) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.pointerEvents === 'none' || +cs.opacity === 0) return false;
    var w = window.innerWidth, h = window.innerHeight;
    /* on-screen or reachable by scrolling inside the menu */
    return r.right > -w && r.left < 2 * w && r.bottom > -4 * h && r.top < 5 * h;
  }
  function center(r){ return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  function navCtl(opts){
    opts = opts || {};
    addCss();
    var rootFn = typeof opts.root === 'function' ? opts.root : function(){ return document.body; };
    var prev = {}, rep = {}, cur = null, lastC = null, lastRoot = null, alive = true, raf = 0;
    var memo = typeof WeakMap === 'function' ? new WeakMap() : { get: function(){}, set: function(){} };  /* screen -> last control */
    var DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

    function list(root){
      var sel = FOCUSABLE + (opts.select ? ',' + opts.select : '');
      return Array.prototype.filter.call(root.querySelectorAll(sel), visible);
    }
    function setFocus(el){
      if (cur && cur !== el) cur.classList.remove('cp-focus');
      cur = el;
      if (!el) return;
      lastC = center(el.getBoundingClientRect());
      el.classList.add('cp-focus');
      document.body.classList.remove('cp-mouse');
      try { el.focus({ preventScroll: true }); } catch (e) {}
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
    }
    function home(root, els){
      var d = root.querySelector('[data-pad-default]');
      setFocus(d && visible(d) ? d : (els.indexOf(document.activeElement) >= 0 ? document.activeElement : els[0]));
    }
    function move(dir){
      var root = rootFn(); if (!root) return;
      var els = list(root); if (!els.length) return;
      if (!cur || els.indexOf(cur) < 0){ home(root, els); return; }
      /* sliders and dropdowns take left/right themselves */
      if ((dir === 'left' || dir === 'right') && cur.tagName === 'INPUT' && cur.type === 'range'){
        var stp = parseFloat(cur.step) || ((parseFloat(cur.max) - parseFloat(cur.min)) / 20) || 1;
        cur.value = parseFloat(cur.value) + (dir === 'right' ? stp : -stp);
        cur.dispatchEvent(new Event('input', { bubbles: true }));
        cur.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      if ((dir === 'left' || dir === 'right') && cur.tagName === 'SELECT'){
        var n = cur.options.length; if (!n) return;
        cur.selectedIndex = (cur.selectedIndex + (dir === 'right' ? 1 : n - 1)) % n;
        cur.dispatchEvent(new Event('input', { bubbles: true }));
        cur.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      var d = DIRS[dir], c0 = center(cur.getBoundingClientRect()), best = null, bs = 1e9;
      els.forEach(function(el){
        if (el === cur) return;
        var r = el.getBoundingClientRect(), c = center(r);
        var dx = c.x - c0.x, dy = c.y - c0.y;
        var along = dx * d[0] + dy * d[1];
        if (along <= 4) return;
        var across = Math.abs(dx * d[1] + dy * d[0]);
        var s = along + across * 2.2;
        if (s < bs){ bs = s; best = el; }
      });
      if (!best && opts.wrapFocus !== false){
        /* wrap around: farthest element on the opposite side, same row/column */
        els.forEach(function(el){
          if (el === cur) return;
          var c = center(el.getBoundingClientRect());
          var dx = c.x - c0.x, dy = c.y - c0.y;
          var along = -(dx * d[0] + dy * d[1]);
          var across = Math.abs(dx * d[1] + dy * d[0]);
          if (along <= 4) return;
          var s = -along + across * 4;
          if (s < bs){ bs = s; best = el; }
        });
      }
      if (best) setFocus(best);
    }
    function press(){
      var root = rootFn(); if (!root) return;
      if (!cur || !root.contains(cur) || !visible(cur)){ move('down'); return; }
      if (cur.tagName === 'SELECT'){ move('right'); return; }
      if (cur.tagName === 'INPUT' && /^(text|search|email|number|password)$/.test(cur.type)){ cur.focus(); return; }
      cur.click();
    }
    function back(){
      if (opts.back){ opts.back(); return; }
      var root = rootFn(); if (!root) return;
      var b = root.querySelector('[data-pad-back]');
      if (b && visible(b)) b.click();
    }
    function tick(){
      if (!alive) return;
      raf = requestAnimationFrame(tick);
      var root = rootFn();
      var r = read();
      if (!r){ prev = {}; return; }
      if (!root){ if (cur){ cur.classList.remove('cp-focus'); cur = null; } lastC = null; lastRoot = null; prev = {}; return; }
      /* a new screen opened while a controller is in use: highlight its
         default control straight away, so A acts on the first press */
      if (root !== lastRoot){
        if (lastRoot && cur) memo.set(lastRoot, cur);
        lastRoot = root;
        if (cur){ cur.classList.remove('cp-focus'); cur = null; }
        var els1 = list(root), back1 = memo.get(root);
        if (back1 && els1.indexOf(back1) >= 0) setFocus(back1);
        else if (els1.length) home(root, els1);
      }
      /* the menu re-rendered under the cursor (e.g. a picker rebuilt itself):
         land on whatever now sits where the old control was */
      if (cur && !root.contains(cur)){
        cur = null;
        if (lastC){
          var els0 = list(root), bd = 1e9, near = null;
          els0.forEach(function(el){
            var c = center(el.getBoundingClientRect()), d = Math.hypot(c.x - lastC.x, c.y - lastC.y);
            if (d < bd){ bd = d; near = el; }
          });
          if (near && bd < 160) setFocus(near);
        }
      }
      var now = performance.now();
      var st = {
        up: r.up || r.ly < -0.6, down: r.down || r.ly > 0.6,
        left: r.left || r.lx < -0.6, right: r.right || r.lx > 0.6,
        a: r.a, b: r.b, start: r.start, back: r.back, lb: r.lb, rb: r.rb, x: r.x, y: r.y
      };
      for (var k in st){
        var on = st[k], was = prev[k];
        var edge = on && !was;
        if (on && DIRS[k]){
          if (edge) rep[k] = now + 380;
          else if (now >= rep[k]){ rep[k] = now + 110; edge = true; }
        }
        prev[k] = on;
        if (!edge) continue;
        if (opts.onButton && opts.onButton(k) === true) continue;
        if (DIRS[k]) move(k);
        else if (k === 'a') press();
        else if (k === 'b') back();
        else if (k === 'start' && opts.start) opts.start();
      }
    }
    function mouse(){ document.body && document.body.classList.add('cp-mouse'); }
    window.addEventListener('mousemove', mouse, { passive: true });
    raf = requestAnimationFrame(tick);
    return {
      stop: function(){ alive = false; cancelAnimationFrame(raf); window.removeEventListener('mousemove', mouse);
                        if (cur) cur.classList.remove('cp-focus'); },
      focus: setFocus,
      current: function(){ return cur; }
    };
  }

  window.CapyPad = {
    version: 1,
    pads: pads,
    native: function(){ return nativeGet ? nativeGet() : []; },
    layout: function(gp){ return layoutFor(gp || first()); },
    setLayout: function(v){
      try { if (LAYOUTS.indexOf(v) >= 0) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('capypadlayout', { detail: layoutFor(first()) })); } catch (e) {}
    },
    preference: pref,
    label: function(i, lay){ return (LABELS[lay || layoutFor(first())] || LABELS.nintendo)[i] || ''; },
    labels: LABELS,
    read: read,
    nav: navCtl
  };
})();
