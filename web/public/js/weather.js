// Map weather + water view (M20): falling snow on maps flagged `snow`, and a
// blue tint when the camera is under a water sheet (the pool on fy_pool_day2).

import * as THREE from 'three';

const BOX = [1400, 700, 1400];     // flakes live in a box that follows the camera

export class Snow {
  constructor(scene, count = 1800) {
    this.scene = scene;
    const pos = new Float32Array(count * 3);
    this.drift = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * BOX[0];
      pos[i * 3 + 1] = Math.random() * BOX[1];
      pos[i * 3 + 2] = (Math.random() - 0.5) * BOX[2];
      this.drift[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // a soft round flake
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.5, 'rgba(255,255,255,.6)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
    this.mat = new THREE.PointsMaterial({ size: 3.2, map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0.9 });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.t = 0;
  }

  update(dt, cam) {
    this.t += dt;
    const a = this.points.geometry.attributes.position, p = a.array;
    const n = p.length / 3;
    for (let i = 0; i < n; i++) {
      p[i * 3 + 1] -= dt * (38 + (i % 7) * 4);
      p[i * 3] += Math.sin(this.t * 0.8 + this.drift[i]) * dt * 14;
      if (p[i * 3 + 1] < 0) p[i * 3 + 1] += BOX[1];
    }
    a.needsUpdate = true;
    // wrap the box around the camera in steps so flakes do not swim with it
    this.points.position.set(Math.round(cam.x / 64) * 64, cam.y - BOX[1] * 0.45, Math.round(cam.z / 64) * 64);
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.mat.map.dispose(); this.mat.dispose();
  }
}

// is the point under one of the map's water sheets?
export function underWater(map, p) {
  for (const w of (map && map.water) || []) {
    const [cx, cz] = w.pos || [0, 0];
    if (Math.abs(p.x - cx) <= w.w / 2 && Math.abs(p.z - cz) <= w.d / 2 && p.y < w.y) return true;
  }
  return false;
}
