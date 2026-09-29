// Builds the three.js world from a map spec.
//
// Rendering is derived from the SAME collision set the physics uses
// (buildColliders), so what you see is exactly what you collide with — there is
// no second, drifting copy of the world. Every solid collider becomes one box
// mesh, coloured by its material name through the map's palette.

import * as THREE from 'three';
import { buildColliders } from '/shared/physics.js';

const boxGeo = new THREE.BoxGeometry(1, 1, 1);

export function buildWorld(scene, map) {
  // --- atmosphere
  scene.background = new THREE.Color(map.sky.horizon);
  scene.fog = new THREE.FogExp2(map.fog.color, map.fog.density);

  const hemi = new THREE.HemisphereLight(map.sky.top, map.sky.horizon, map.ambient);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, map.sun);
  sun.position.set(1400, 2600, 900);
  scene.add(sun);
  scene.add(sun.target);

  // --- materials (one per palette colour, shared across meshes)
  const matCache = new Map();
  const matFor = (name) => {
    if (!matCache.has(name)) {
      const color = map.palette[name] !== undefined ? map.palette[name] : 0x8a8a8a;
      matCache.set(name, new THREE.MeshLambertMaterial({ color }));
    }
    return matCache.get(name);
  };

  // --- solid world: one mesh per collider
  const group = new THREE.Group();
  group.name = 'map';
  const colliders = buildColliders(map);
  for (const c of colliders) {
    const m = new THREE.Mesh(boxGeo, matFor(c.mat));
    m.scale.set(c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]);
    m.position.set(
      (c.min[0] + c.max[0]) / 2,
      (c.min[1] + c.max[1]) / 2,
      (c.min[2] + c.max[2]) / 2,
    );
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    group.add(m);
  }

  // --- water (decorative, translucent, non-solid)
  for (const w of (map.water || [])) {
    const m = new THREE.Mesh(boxGeo, new THREE.MeshLambertMaterial({
      color: map.palette.water !== undefined ? map.palette.water : 0x1f5c78,
      transparent: true, opacity: 0.55,
    }));
    const px = w.pos ? w.pos[0] : 0;
    const pz = w.pos ? w.pos[1] : 0;
    m.scale.set(w.w, 8, w.d);
    m.position.set(px, w.y, pz);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    group.add(m);
  }

  // --- bombsites: a subtle marker so players can find them
  for (const [label, pos] of Object.entries(map.bombsites || {})) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(96, 128, 32),
      new THREE.MeshBasicMaterial({ color: label === 'A' ? 0xd8b56a : 0x6fa3d8, side: THREE.DoubleSide, transparent: true, opacity: 0.4 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos[0], pos[1] + 2, pos[2]);
    ring.matrixAutoUpdate = false;
    ring.updateMatrix();
    group.add(ring);
  }

  scene.add(group);
  return { colliders, group };
}
