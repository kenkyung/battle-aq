// Small procedural sprites for effects (puffs, bullet holes, muzzle flash).
// Surface textures are baked in Blender (art/blender/build_textures.py).

import * as THREE from 'three';

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Soft round sprite for smoke / dust / sparks.
export function puffTexture() {
  const c = canvas(64), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Bullet hole decal: dark core, cracked rim.
export function bulletHoleTexture() {
  const c = canvas(64), ctx = c.getContext('2d'), r = rng(77);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0, 'rgba(0,0,0,0.95)');
  g.addColorStop(0.22, 'rgba(10,8,6,0.9)');
  g.addColorStop(0.35, 'rgba(40,32,24,0.55)');
  g.addColorStop(1, 'rgba(40,32,24,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  for (let i = 0; i < 7; i++) {
    const a = r() * Math.PI * 2, l = 10 + r() * 14;
    ctx.lineWidth = 0.8 + r();
    ctx.beginPath(); ctx.moveTo(32, 32); ctx.lineTo(32 + Math.cos(a) * l, 32 + Math.sin(a) * l); ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Four-pointed muzzle flash star.
export function flashTexture() {
  const c = canvas(128), ctx = c.getContext('2d');
  ctx.translate(64, 64);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 60);
  g.addColorStop(0, 'rgba(255,255,230,1)');
  g.addColorStop(0.2, 'rgba(255,220,120,0.95)');
  g.addColorStop(0.5, 'rgba(255,140,40,0.5)');
  g.addColorStop(1, 'rgba(255,90,20,0)');
  ctx.fillStyle = g;
  for (let i = 0; i < 6; i++) {
    ctx.rotate(Math.PI / 3);
    ctx.beginPath();
    ctx.moveTo(0, -8); ctx.lineTo(i % 2 ? 40 : 62, 0); ctx.lineTo(0, 8);
    ctx.closePath(); ctx.fill();
  }
  ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
