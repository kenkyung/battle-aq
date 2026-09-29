// Asset loading: the Blender-built GLBs and the baked textures under
// public/assets/. URLs resolve relative to this module, so the game works
// from any base path (e.g. behind the arcade's /battle/ proxy).

import * as THREE from 'three';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js';

const BASE = new URL('../assets/', import.meta.url);
export const assetUrl = (p) => new URL(p, BASE).href;

const gltf = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
const cache = new Map();

let maxAniso = 1;
export function setAnisotropy(n) { maxAniso = n; }

export function loadGLB(path) {
  if (!cache.has(path)) cache.set(path, gltf.loadAsync(assetUrl(path)));
  return cache.get(path);
}

// glTF-style textures: flipY off (matches the exported UVs), repeat-wrapped.
export function loadTexture(path, { srgb = true, repeat = true } = {}) {
  const key = 'tex:' + path;
  if (!cache.has(key)) {
    cache.set(key, texLoader.loadAsync(assetUrl(path)).then((t) => {
      t.flipY = false;
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = maxAniso;
      t.needsUpdate = true;
      return t;
    }));
  }
  return cache.get(key);
}

// Shared models, loaded once at startup.
export const Models = { weapons: null, soldiers: {} };

export async function preloadModels(onProgress = () => {}) {
  const jobs = [
    loadGLB('models/weapons.glb').then((g) => { Models.weapons = g; }),
    loadGLB('models/soldier_t.glb').then((g) => { Models.soldiers[1] = g; }),
    loadGLB('models/soldier_ct.glb').then((g) => { Models.soldiers[2] = g; }),
  ];
  let done = 0;
  for (const j of jobs) j.then(() => onProgress(++done / jobs.length));
  await Promise.all(jobs);
}

// A fresh copy of one weapon (or arm) from weapons.glb, with its empties.
export function weaponModel(id) {
  const src = Models.weapons && Models.weapons.scene.getObjectByName(id);
  if (!src) return null;
  const m = src.clone(true);
  m.position.set(0, 0, 0);
  m.rotation.set(0, 0, 0);
  return m;
}
