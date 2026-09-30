// Weapon finishes (M21). The patterns are painted once at startup on small
// tiling canvases (no downloads); a finish is applied by patching a weapon
// material's shader: the gun's dark, unsaturated parts (steel, polymer) take
// the pattern or gold, while wood, brass and bright details keep the baked
// look. Works on the viewmodel's standard material and the Lambert ones used
// for third-person guns and drops.

import * as THREE from 'three';
import { FINISHES } from '../shared/constants.js';

const SIZE = 256;

// tileable value noise, a few octaves
function fbm(seed) {
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const octaves = [4, 8, 16, 32].map((p) => ({ p, v: Float32Array.from({ length: p * p }, rnd) }));
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    let sum = 0, amp = 0.55, norm = 0;
    for (const { p, v } of octaves) {
      const fx = x * p, fy = y * p;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = sm(fx - x0), ty = sm(fy - y0);
      const at = (i, j) => v[((i % p) + p) % p + (((j % p) + p) % p) * p];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
      sum += (a + (b - a) * ty) * amp; norm += amp; amp *= 0.5;
    }
    return sum / norm;
  };
}

const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];

function paint(fn) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  const img = g.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, gg, b] = fn(x / SIZE, y / SIZE, x, y);
      const i = (x + y * SIZE) * 4;
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// four-colour camo: thresholds on noise
function camo(cols, seed, cuts = [0.42, 0.52, 0.6], block = 1) {
  const n = fbm(seed), c = cols.map(hex);
  return paint((u, v) => {
    if (block > 1) { u = Math.floor(u * SIZE / block) * block / SIZE; v = Math.floor(v * SIZE / block) * block / SIZE; }
    const k = n(u, v);
    return c[k < cuts[0] ? 0 : k < cuts[1] ? 1 : k < cuts[2] ? 2 : 3];
  });
}

const PAINTERS = {
  desert: () => camo([0xc9ad7f, 0xa88a5c, 0x8a6a45, 0x5e4a33], 11),
  urban: () => camo([0x8d9196, 0x6a6e73, 0x45484c, 0x26282b], 23),
  forest: () => camo([0x6b7447, 0x4d5733, 0x3a3523, 0x1f231a], 37),
  arctic: () => camo([0xeef0f2, 0xd2d6da, 0xa8aeb4, 0x7a8087], 41),
  digital: () => camo([0x7f8c9a, 0x5c6b7a, 0x3d4a57, 0x222b33], 53, [0.4, 0.5, 0.6], 8),
  tiger: () => {
    const n = fbm(61);
    return paint((u, v) => {
      const s = Math.sin((u * 6 + n(u, v) * 2.2) * Math.PI * 2);
      return s > 0.55 ? [24, 18, 12] : hex(0xd9822b).map((x) => x * (0.85 + n(v, u) * 0.3));
    });
  },
  crimson: () => {
    const n = fbm(71);
    return paint((u, v) => {
      // a spider web: spokes + rings around the tile centre (tiles into a net)
      const x = u - 0.5, y = v - 0.5, r = Math.hypot(x, y), a = Math.atan2(y, x);
      const spoke = Math.abs(Math.sin(a * 6)) < 0.06 + r * 0.02;
      const ring = Math.abs(Math.sin((r + n(u, v) * 0.03) * Math.PI * 14)) < 0.12;
      return spoke || ring ? [20, 8, 8] : hex(0x8e1b1b).map((c) => c * (0.8 + n(u, v) * 0.4));
    });
  },
};

const textures = {};
function patternFor(id) {
  if (!textures[id] && PAINTERS[id]) textures[id] = PAINTERS[id]();
  return textures[id] || null;
}

export function finishId(idx) { return (FINISHES[idx] || FINISHES[0]).id; }

// A copy of `mat` wearing finish `idx` (0 = unchanged: returns mat itself).
export function finishMaterial(mat, idx) {
  const id = finishId(idx);
  if (!idx || id === 'factory') return mat;
  const m = mat.clone();
  const gold = id === 'gold';
  const tex = gold ? null : patternFor(id);
  m.defines = { ...(m.defines || {}), USE_FINISH: '' };
  m.customProgramCacheKey = () => 'finish-' + (gold ? 'gold' : 'pattern') + '-' + (mat.type || '');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tFinish = { value: tex };
    sh.uniforms.uFinGold = { value: gold ? 1 : 0 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFinPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFinPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFinPos;\nuniform sampler2D tFinish;\nuniform float uFinGold;')
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec3 c = diffuseColor.rgb;
        float lum = dot(c, vec3(0.299, 0.587, 0.114));
        float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
        float mask = (1.0 - smoothstep(0.05, 0.14, sat)) * (1.0 - smoothstep(0.4, 0.62, lum));
        vec3 fin;
        if (uFinGold > 0.5) fin = vec3(1.0, 0.72, 0.28) * (0.42 + lum * 1.8);
        else fin = texture2D(tFinish, vec2(vFinPos.z + vFinPos.x * 0.6, vFinPos.y + vFinPos.x * 0.35) * 0.075).rgb * (0.62 + lum * 1.25);
        diffuseColor.rgb = mix(c, fin, mask);
      }`);
  };
  if (gold && m.isMeshStandardMaterial) { m.metalness = Math.max(m.metalness, 0.75); m.roughness = Math.min(m.roughness, 0.35); }
  return m;
}

// every mesh under `obj`
export function applyFinish(obj, idx) {
  if (!idx) return obj;
  obj.traverse((o) => { if (o.isMesh && o.material) o.material = finishMaterial(o.material, idx); });
  return obj;
}

// a small swatch (menu) for finish idx
export function swatchURL(idx) {
  const id = finishId(idx);
  if (id === 'factory') return null;
  if (id === 'gold') return null;
  const t = patternFor(id);
  return t ? t.image.toDataURL('image/jpeg', 0.8) : null;
}
