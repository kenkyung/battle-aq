// Sound: every effect is synthesized at load with Web Audio (no audio files
// to download), then played through a 3D HRTF panner at its world position.
// Sounds behind walls are muffled (low-pass + quieter), as in CS 1.6 where
// you hear footsteps and gunfire through the map.
//
// Recipes are small signal graphs rendered once in an OfflineAudioContext:
//   guns      crack (high-passed noise) + body (low-passed noise) + a falling
//             sine "thump" + mechanism clack, into an outdoor echo tail
//   steps     surface-specific crunch / tap / clang / knock, 4 variants each
//   bomb      keypad beeps, planted beep, defuse ticks, a long explosion
//   ambience  per-map wind / town / jungle loops
// Radio lines ("Bomb has been planted", "Terrorists win") use the browser's
// speech synthesis.

import { raycast } from '../shared/physics.js';

const SR = 32000;

// deterministic noise so every visit sounds the same
function makeRand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function render(seconds, build, seed = 1) {
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR);
  const rand = makeRand(seed);
  const noise = ctx.createBuffer(1, Math.ceil(SR * Math.min(seconds, 4)), SR);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1;
  const h = {
    ctx, rand,
    out: ctx.destination,
    noise(dest, { at = 0, dur = seconds, rate = 1 } = {}) {
      const s = ctx.createBufferSource(); s.buffer = noise; s.playbackRate.value = rate;
      s.connect(dest); s.start(at, rand() * 0.5); s.stop(at + dur); return s;
    },
    filter(type, freq, q = 0.8, dest) {
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      if (dest) f.connect(dest); return f;
    },
    env(dest, { at = 0, a = 0.002, d = 0.2, peak = 1, hold = 0 } = {}) {
      const g = ctx.createGain(); g.gain.value = 0;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak, at + a);
      if (hold) g.gain.setValueAtTime(peak, at + a + hold);
      g.gain.exponentialRampToValueAtTime(0.0001, at + a + hold + d);
      if (dest) g.connect(dest); return g;
    },
    osc(type, f0, f1, dest, { at = 0, dur = 0.2, glide = dur } = {}) {
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, at);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), at + glide);
      o.connect(dest); o.start(at); o.stop(at + dur); return o;
    },
    // outdoor echo: exponentially decaying noise impulse response
    verb(dest, decay = 1.0, gain = 0.3, pre = 0.02) {
      const ir = ctx.createBuffer(1, Math.ceil(SR * (decay + pre)), SR);
      const x = ir.getChannelData(0);
      for (let i = Math.floor(pre * SR); i < x.length; i++) {
        const t = i / SR - pre;
        x[i] = (rand() * 2 - 1) * Math.exp(-t * 6 / decay) * (1 - 0.5 * Math.min(1, t * 8));
      }
      const c = ctx.createConvolver(); c.buffer = ir; c.normalize = true;
      const g = ctx.createGain(); g.gain.value = gain;
      c.connect(g); g.connect(dest); return c;
    },
  };
  build(h);
  const buf = await ctx.startRendering();
  // normalise to a common peak so the mix levels below mean something
  const ch = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (peak > 0) for (let i = 0; i < ch.length; i++) ch[i] *= 0.9 / peak;
  return buf;
}

// ------------------------------------------------------------ recipes

const GUNS = {
  //          dur  crackHz crack cDec  bodyHz body bDec  thumpHz thump tail  tDec  mech
  glock:  [0.9, 2600, 0.8, 0.03, 1600, 0.9, 0.08, 150, 0.5, 0.35, 0.8, 0.3],
  usp:    [0.9, 2200, 0.7, 0.03, 1100, 1.0, 0.10, 110, 0.7, 0.35, 0.8, 0.3],
  deagle: [1.3, 1800, 0.9, 0.05, 900, 1.0, 0.16, 80, 1.0, 0.45, 1.2, 0.35],
  mp5:    [0.7, 3000, 0.6, 0.025, 1500, 0.8, 0.07, 140, 0.4, 0.3, 0.6, 0.35],
  ump45:  [0.8, 2400, 0.6, 0.03, 1000, 0.9, 0.09, 105, 0.6, 0.3, 0.7, 0.35],
  ak47:   [1.1, 2000, 0.9, 0.04, 1000, 1.0, 0.13, 85, 0.9, 0.4, 1.0, 0.4],
  m4a1:   [1.0, 2600, 0.9, 0.035, 1200, 0.9, 0.11, 95, 0.8, 0.4, 0.9, 0.35],
  m249:   [1.2, 1900, 0.9, 0.04, 950, 1.0, 0.14, 80, 1.0, 0.45, 1.1, 0.45],
  scout:  [1.5, 2800, 1.0, 0.04, 1300, 0.9, 0.12, 90, 0.8, 0.5, 1.4, 0.2],
  awp:    [2.0, 1700, 1.0, 0.06, 800, 1.0, 0.22, 60, 1.0, 0.6, 1.8, 0.2],
};

function gun(p) {
  const [dur, crackHz, crack, cDec, bodyHz, body, bDec, thumpHz, thump, tail, tDec, mech] = p;
  return (h) => {
    const comp = h.ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 6;
    comp.connect(h.out);
    const echo = h.verb(comp, tDec, tail, 0.03);
    const bus = h.ctx.createGain(); bus.connect(comp); bus.connect(echo);
    h.noise(h.filter('highpass', crackHz, 0.7, h.env(bus, { a: 0.0004, d: cDec, peak: crack })), { dur: cDec * 3 });
    h.noise(h.filter('lowpass', bodyHz, 0.9, h.env(bus, { a: 0.001, d: bDec, peak: body })), { dur: bDec * 3 });
    h.osc('sine', thumpHz * 1.8, thumpHz * 0.5, h.env(bus, { a: 0.001, d: 0.14, peak: thump }), { dur: 0.3, glide: 0.12 });
    h.noise(h.filter('bandpass', 3800, 6, h.env(bus, { at: 0.012, a: 0.0005, d: 0.02, peak: mech })), { at: 0.012, dur: 0.05 });
    void dur;
  };
}

function click(freq, q, d, peak = 1) {
  return (h) => {
    h.noise(h.filter('bandpass', freq, q, h.env(h.out, { a: 0.0003, d, peak })), { dur: d * 4 });
    h.osc('square', freq * 0.9, freq * 0.7, h.env(h.out, { a: 0.0003, d: d * 0.8, peak: peak * 0.25 }), { dur: d * 2 });
  };
}

function step(kind) {
  return (h) => {
    if (kind === 'sand') {
      for (let i = 0; i < 6; i++) {
        const at = i * 0.012 + h.rand() * 0.01;
        h.noise(h.filter('bandpass', 700 + h.rand() * 900, 1.2, h.env(h.out, { at, a: 0.002, d: 0.04, peak: 0.6 + h.rand() * 0.4 })), { at, dur: 0.12 });
      }
      h.noise(h.filter('lowpass', 400, 0.7, h.env(h.out, { a: 0.003, d: 0.07, peak: 0.6 })), { dur: 0.2 });
    } else if (kind === 'stone') {
      h.osc('sine', 140, 70, h.env(h.out, { a: 0.001, d: 0.06, peak: 0.8 }), { dur: 0.15 });
      h.noise(h.filter('bandpass', 2400, 1.5, h.env(h.out, { a: 0.0005, d: 0.025, peak: 0.7 })), { dur: 0.08 });
      h.noise(h.filter('lowpass', 900, 0.7, h.env(h.out, { at: 0.02, a: 0.002, d: 0.05, peak: 0.3 })), { at: 0.02, dur: 0.1 });
    } else if (kind === 'metal') {
      const bus = h.env(h.out, { a: 0.0005, d: 0.25, peak: 0.8 });
      for (const f of [420, 1130, 2290, 3720]) h.osc('sine', f, f * 0.995, h.env(bus, { a: 0.0005, d: 0.08 + 60 / f, peak: 0.5 }), { dur: 0.35 });
      h.noise(h.filter('highpass', 1800, 0.7, h.env(h.out, { a: 0.0005, d: 0.02, peak: 0.6 })), { dur: 0.05 });
    } else { // wood
      h.osc('sine', 190, 150, h.env(h.out, { a: 0.001, d: 0.09, peak: 0.9 }), { dur: 0.2 });
      h.osc('triangle', 420, 380, h.env(h.out, { a: 0.001, d: 0.05, peak: 0.3 }), { dur: 0.12 });
      h.noise(h.filter('bandpass', 1400, 2, h.env(h.out, { a: 0.0008, d: 0.03, peak: 0.5 })), { dur: 0.08 });
    }
  };
}

const RECIPES = {
  ...Object.fromEntries(Object.entries(GUNS).map(([id, p]) => [`fire_${id}`, [p[0], gun(p)]])),
  dryfire: [0.1, click(3200, 5, 0.012)],
  mag_out: [0.25, (h) => { click(1800, 3, 0.02)(h); h.noise(h.filter('bandpass', 900, 2, h.env(h.out, { at: 0.04, a: 0.01, d: 0.08, peak: 0.5 })), { at: 0.04, dur: 0.2 }); }],
  mag_in: [0.25, (h) => { h.noise(h.filter('bandpass', 1200, 2, h.env(h.out, { a: 0.005, d: 0.05, peak: 0.4 })), { dur: 0.1 }); click(2600, 4, 0.018)(h); }],
  bolt: [0.35, (h) => {
    h.noise(h.filter('bandpass', 2000, 3, h.env(h.out, { a: 0.001, d: 0.02, peak: 0.8 })), { dur: 0.05 });
    h.noise(h.filter('bandpass', 1500, 1.5, h.env(h.out, { at: 0.03, a: 0.04, d: 0.05, peak: 0.4 })), { at: 0.03, dur: 0.15 });
    h.noise(h.filter('bandpass', 2800, 4, h.env(h.out, { at: 0.16, a: 0.0005, d: 0.03, peak: 1 })), { at: 0.16, dur: 0.06 });
  }],
  deploy: [0.3, (h) => {
    h.noise(h.filter('bandpass', 600, 0.8, h.env(h.out, { a: 0.05, d: 0.1, peak: 0.4 })), { dur: 0.2 });
    click(2200, 4, 0.015, 0.8)(h);
  }],
  knife_slash: [0.35, (h) => {
    const f = h.filter('bandpass', 1200, 1.5, h.env(h.out, { a: 0.06, d: 0.15, peak: 0.8 }));
    f.frequency.setValueAtTime(700, 0); f.frequency.exponentialRampToValueAtTime(3200, 0.15);
    h.noise(f, { dur: 0.3 });
  }],
  knife_hit: [0.4, (h) => {
    h.osc('sine', 160, 60, h.env(h.out, { a: 0.001, d: 0.12, peak: 1 }), { dur: 0.3 });
    h.noise(h.filter('lowpass', 1500, 0.7, h.env(h.out, { a: 0.001, d: 0.08, peak: 0.7 })), { dur: 0.2 });
  }],
  hit_flesh: [0.3, (h) => {
    h.osc('sine', 120, 55, h.env(h.out, { a: 0.001, d: 0.09, peak: 1 }), { dur: 0.2 });
    h.noise(h.filter('lowpass', 900, 1, h.env(h.out, { a: 0.002, d: 0.06, peak: 0.6 })), { dur: 0.15 });
  }],
  helmet: [0.6, (h) => {  // the CS 1.6 headshot "dink"
    for (const [f, g] of [[3150, 1], [5230, 0.5], [7010, 0.3]]) h.osc('sine', f, f * 0.99, h.env(h.out, { a: 0.0005, d: 0.35, peak: g }), { dur: 0.55 });
    h.noise(h.filter('highpass', 4000, 0.7, h.env(h.out, { a: 0.0003, d: 0.01, peak: 0.7 })), { dur: 0.03 });
  }],
  hitmark: [0.08, click(4200, 8, 0.01, 0.8)],
  impact_stone: [0.3, (h) => {
    h.noise(h.filter('bandpass', 2600, 1.2, h.env(h.out, { a: 0.0005, d: 0.03, peak: 1 })), { dur: 0.08 });
    for (let i = 0; i < 4; i++) { const at = 0.03 + h.rand() * 0.12; h.noise(h.filter('bandpass', 1500 + h.rand() * 2500, 3, h.env(h.out, { at, a: 0.001, d: 0.02, peak: 0.3 })), { at, dur: 0.05 }); }
  }],
  impact_metal: [0.5, (h) => {
    for (const f of [1870, 3200, 4410]) h.osc('sine', f, f * 0.98, h.env(h.out, { a: 0.0005, d: 0.25, peak: 0.6 }), { dur: 0.45 });
    h.noise(h.filter('highpass', 3000, 0.7, h.env(h.out, { a: 0.0003, d: 0.015, peak: 1 })), { dur: 0.04 });
  }],
  impact_wood: [0.3, (h) => {
    h.osc('sine', 260, 180, h.env(h.out, { a: 0.001, d: 0.06, peak: 0.9 }), { dur: 0.15 });
    h.noise(h.filter('bandpass', 1800, 1.5, h.env(h.out, { a: 0.0005, d: 0.03, peak: 0.8 })), { dur: 0.08 });
  }],
  impact_dirt: [0.3, (h) => {
    h.noise(h.filter('lowpass', 1400, 0.8, h.env(h.out, { a: 0.001, d: 0.06, peak: 1 })), { dur: 0.15 });
    for (let i = 0; i < 5; i++) { const at = 0.02 + h.rand() * 0.15; h.noise(h.filter('bandpass', 900 + h.rand() * 1200, 2, h.env(h.out, { at, a: 0.002, d: 0.03, peak: 0.25 })), { at, dur: 0.06 }); }
  }],
  ricochet: [0.6, (h) => {
    const g = h.env(h.out, { a: 0.005, d: 0.4, peak: 0.6 });
    const o = h.osc('sine', 3600, 1400, g, { dur: 0.5, glide: 0.45 });
    const lfo = h.ctx.createOscillator(); lfo.frequency.value = 38; const lg = h.ctx.createGain(); lg.gain.value = 90;
    lfo.connect(lg); lg.connect(o.frequency); lfo.start(0); lfo.stop(0.5);
  }],
  land: [0.3, (h) => {
    h.osc('sine', 110, 50, h.env(h.out, { a: 0.001, d: 0.12, peak: 1 }), { dur: 0.25 });
    h.noise(h.filter('lowpass', 700, 0.7, h.env(h.out, { a: 0.002, d: 0.1, peak: 0.6 })), { dur: 0.2 });
  }],
  beep: [0.15, (h) => { h.osc('sine', 2440, 2440, h.env(h.out, { a: 0.002, d: 0.09, peak: 1, hold: 0.03 }), { dur: 0.14 }); }],
  key: [0.12, (h) => { h.osc('square', 1760, 1760, h.filter('lowpass', 3000, 0.7, h.env(h.out, { a: 0.002, d: 0.06, peak: 0.6, hold: 0.02 })), { dur: 0.1 }); }],
  key2: [0.12, (h) => { h.osc('square', 1318, 1318, h.filter('lowpass', 3000, 0.7, h.env(h.out, { a: 0.002, d: 0.06, peak: 0.6, hold: 0.02 })), { dur: 0.1 }); }],
  defuse_tick: [0.1, click(1500, 6, 0.02, 0.7)],
  armed: [0.9, (h) => {
    for (const [at, f] of [[0, 1760], [0.18, 2217], [0.36, 2637]]) h.osc('sine', f, f, h.env(h.out, { at, a: 0.002, d: 0.12, peak: 0.8, hold: 0.04 }), { at, dur: 0.2 });
  }],
  explosion: [4.0, (h) => {
    const comp = h.ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 4; comp.connect(h.out);
    const echo = h.verb(comp, 3.0, 0.5, 0.06);
    const bus = h.ctx.createGain(); bus.connect(comp); bus.connect(echo);
    h.osc('sine', 70, 22, h.env(bus, { a: 0.003, d: 1.6, peak: 1 }), { dur: 2.5, glide: 1.2 });
    h.noise(h.filter('lowpass', 500, 0.7, h.env(bus, { a: 0.005, d: 2.2, peak: 1 })), { dur: 3.5 });
    h.noise(h.filter('highpass', 1500, 0.7, h.env(bus, { a: 0.001, d: 0.25, peak: 0.8 })), { dur: 0.6 });
    for (let i = 0; i < 20; i++) { const at = 0.3 + h.rand() * 2.2; h.noise(h.filter('bandpass', 800 + h.rand() * 3000, 3, h.env(bus, { at, a: 0.002, d: 0.05, peak: 0.12 })), { at, dur: 0.1 }); }
  }],
  pin: [0.25, (h) => { click(3400, 6, 0.012, 0.9)(h); h.osc('sine', 5200, 4800, h.env(h.out, { at: 0.03, a: 0.001, d: 0.12, peak: 0.25 }), { at: 0.03, dur: 0.2 }); }],
  throw: [0.35, (h) => { const f = h.filter('bandpass', 600, 1.2, h.env(h.out, { a: 0.05, d: 0.2, peak: 0.7 })); f.frequency.setValueAtTime(400, 0); f.frequency.exponentialRampToValueAtTime(1600, 0.2); h.noise(f, { dur: 0.3 }); }],
  bounce: [0.2, (h) => { h.osc('triangle', 1250, 1150, h.env(h.out, { a: 0.0005, d: 0.08, peak: 0.8 }), { dur: 0.15 }); h.noise(h.filter('bandpass', 2600, 3, h.env(h.out, { a: 0.0005, d: 0.02, peak: 0.6 })), { dur: 0.05 }); }],
  he_explode: [2.4, (h) => {
    const comp = h.ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 5; comp.connect(h.out);
    const echo = h.verb(comp, 1.8, 0.45, 0.04);
    const bus = h.ctx.createGain(); bus.connect(comp); bus.connect(echo);
    h.osc('sine', 95, 30, h.env(bus, { a: 0.002, d: 0.7, peak: 1 }), { dur: 1.2, glide: 0.6 });
    h.noise(h.filter('lowpass', 900, 0.7, h.env(bus, { a: 0.003, d: 1.0, peak: 1 })), { dur: 2 });
    h.noise(h.filter('highpass', 2000, 0.7, h.env(bus, { a: 0.0008, d: 0.12, peak: 0.9 })), { dur: 0.3 });
  }],
  flash_pop: [1.2, (h) => {
    const echo = h.verb(h.out, 1.0, 0.35, 0.02);
    const bus = h.ctx.createGain(); bus.connect(h.out); bus.connect(echo);
    h.noise(h.filter('highpass', 1200, 0.6, h.env(bus, { a: 0.0005, d: 0.09, peak: 1 })), { dur: 0.25 });
    h.osc('sine', 160, 60, h.env(bus, { a: 0.001, d: 0.12, peak: 0.6 }), { dur: 0.25 });
  }],
  smoke_hiss: [3.0, (h) => { h.noise(h.filter('highpass', 2500, 0.5, h.env(h.out, { a: 0.1, d: 2.6, peak: 0.8, hold: 0.3 })), { dur: 3 }); }],
  ring: [5.0, (h) => { h.osc('sine', 3150, 3100, h.env(h.out, { a: 0.02, d: 4.5, peak: 0.6, hold: 0.4 }), { dur: 5 }); }],
  buy: [0.2, (h) => { click(2600, 3, 0.02, 0.6)(h); h.osc('sine', 1320, 1320, h.env(h.out, { at: 0.04, a: 0.002, d: 0.08, peak: 0.3 }), { at: 0.04, dur: 0.12 }); }],
  money: [0.4, (h) => { for (const [at, f] of [[0, 1568], [0.08, 2093]]) h.osc('triangle', f, f, h.env(h.out, { at, a: 0.002, d: 0.15, peak: 0.5 }), { at, dur: 0.25 }); }],
  radio: [0.15, (h) => { h.noise(h.filter('bandpass', 2000, 1, h.env(h.out, { a: 0.002, d: 0.08, peak: 0.6 })), { dur: 0.12 }); }],
  // ambience beds (looped)
  amb_wind: [8, (h) => {
    const f = h.filter('bandpass', 380, 0.6, h.env(h.out, { a: 1.5, d: 6.5, peak: 1, hold: 0 }));
    const lfo = h.ctx.createOscillator(); lfo.frequency.value = 0.15; const lg = h.ctx.createGain(); lg.gain.value = 180;
    lfo.connect(lg); lg.connect(f.frequency); lfo.start(0); lfo.stop(8);
    h.noise(f, { dur: 8, rate: 0.7 });
  }],
  amb_town: [8, (h) => {
    h.noise(h.filter('lowpass', 500, 0.6, h.env(h.out, { a: 1, d: 7, peak: 0.6 })), { dur: 8 });
    for (let i = 0; i < 6; i++) { const at = h.rand() * 7; const f = 2400 + h.rand() * 1800; for (let k = 0; k < 3; k++) h.osc('sine', f, f * 1.3, h.env(h.out, { at: at + k * 0.09, a: 0.005, d: 0.05, peak: 0.25 }), { at: at + k * 0.09, dur: 0.08 }); }
  }],
  amb_jungle: [8, (h) => {
    h.noise(h.filter('bandpass', 5200, 3, h.env(h.out, { a: 1, d: 7, peak: 0.35 })), { dur: 8 });
    for (let i = 0; i < 14; i++) { const at = h.rand() * 7.5; const f = 1800 + h.rand() * 2600; h.osc('sine', f, f * (0.7 + h.rand() * 0.8), h.env(h.out, { at, a: 0.01, d: 0.12, peak: 0.3 }), { at, dur: 0.2 }); }
  }],
};
for (const kind of ['sand', 'stone', 'metal', 'wood']) {
  for (let v = 0; v < 4; v++) RECIPES[`step_${kind}_${v}`] = [0.3, step(kind), 900 + v];
}

// palette material -> footstep / impact surface
export function surfaceOf(mat, mapId) {
  if (mat === 'metal') return 'metal';
  if (mat === 'wood' || mat === 'cover') return 'wood';
  if (mat === 'floor') return mapId === 'de_aq_inferno' ? 'stone' : 'sand';
  if (mat === 'bags') return 'sand';
  return 'stone';
}

// ------------------------------------------------------------ player

export class Sfx {
  constructor() {
    this.buffers = {};
    this.ctx = null;
    this.volume = 0.8;
    this.radioOn = true;
    this.colliders = null;
    this.listener = [0, 0, 0];
    this.ready = this.build();
    this.ambient = null;
  }

  async build() {
    const jobs = Object.entries(RECIPES).map(async ([name, [dur, fn, seed]]) => {
      try { this.buffers[name] = await render(dur, fn, seed || name.length * 7919); } catch (e) { console.warn('sfx', name, e); }
    });
    await Promise.all(jobs);
  }

  // Browsers only allow audio after a user gesture: call from a click/key.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  // camera position + orientation (three.js camera)
  setListener(cam) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    const p = cam.position;
    this.listener = [p.x, p.y, p.z];
    const f = cam.getWorldDirection(this._f || (this._f = cam.position.clone()));
    const t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setValueAtTime(p.x, t); L.positionY.setValueAtTime(p.y, t); L.positionZ.setValueAtTime(p.z, t);
      L.forwardX.setValueAtTime(f.x, t); L.forwardY.setValueAtTime(f.y, t); L.forwardZ.setValueAtTime(f.z, t);
      L.upX.setValueAtTime(0, t); L.upY.setValueAtTime(1, t); L.upZ.setValueAtTime(0, t);
    } else {
      L.setPosition(p.x, p.y, p.z); L.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }
  }

  // name: buffer id; opts: { pos:[x,y,z] (omit = 2D), volume, rate, ref, max, occlude }
  play(name, { pos = null, volume = 1, rate = 1, jitter = 0.04, ref = 160, max = 5000, occlude = true } = {}) {
    const buf = this.buffers[name];
    if (!this.ctx || !buf || this.ctx.state !== 'running') return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
    const g = this.ctx.createGain();
    g.gain.value = volume;
    let node = src;
    if (pos) {
      const dx = pos[0] - this.listener[0], dy = pos[1] - this.listener[1], dz = pos[2] - this.listener[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist > max) return null;
      // behind a wall: muffled and quieter
      if (occlude && this.colliders && dist > 48) {
        const d = [dx / dist, dy / dist, dz / dist];
        if (raycast(this.listener, d, this.colliders, dist - 24)) {
          const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
          node.connect(lp); node = lp; g.gain.value *= 0.55;
        }
      }
      const pan = this.ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = ref;
      pan.rolloffFactor = 1.1;
      pan.maxDistance = max;
      if (pan.positionX) { pan.positionX.value = pos[0]; pan.positionY.value = pos[1]; pan.positionZ.value = pos[2]; }
      else pan.setPosition(pos[0], pos[1], pos[2]);
      node.connect(pan); node = pan;
    }
    node.connect(g);
    g.connect(this.master);
    src.start();
    return src;
  }

  playAt(name, pos, opts = {}) { return this.play(name, { ...opts, pos }); }

  startAmbience(mapId) {
    const name = mapId === 'de_aq_aztec' ? 'amb_jungle' : mapId === 'de_aq_inferno' ? 'amb_town' : 'amb_wind';
    if (!this.ctx || !this.buffers[name]) { this._pendingAmb = mapId; return; }
    if (this.ambient) { try { this.ambient.stop(); } catch { /* done */ } }
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[name]; src.loop = true;
    const g = this.ctx.createGain(); g.gain.value = 0.09;
    src.connect(g); g.connect(this.master); src.start();
    this.ambient = src;
  }

  // CS radio lines through the browser's speech synthesis
  radio(text) {
    if (!this.radioOn || !window.speechSynthesis) return;
    try {
      this.play('radio', { volume: 0.4 });
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.08; u.pitch = 0.85; u.volume = Math.min(1, this.volume * 0.8);
      const v = speechSynthesis.getVoices().find((x) => /en[-_](US|GB)/i.test(x.lang));
      if (v) u.voice = v;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch { /* no voices */ }
  }
}
