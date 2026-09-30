// Asset loading: the Blender-built GLBs and the baked textures under
// public/assets/. URLs resolve relative to this module, so the game works
// from any base path (e.g. behind the arcade's /battle/ proxy).

import * as THREE from 'three';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js';
import { SKINS, TEAM } from '../shared/constants.js';

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
// Skins (M19): the two team defaults are preloaded, the other six load the
// first time someone wears them (skinModel falls back to the default until then).
export const Models = { weapons: null, skins: {}, hostage: null };
const skinLoading = new Set();

export function skinModel(team, idx) {
  const list = SKINS[team] || SKINS[TEAM.T];
  const want = list[idx] || list[0];
  if (Models.skins[want.id]) return { id: want.id, gltf: Models.skins[want.id] };
  if (!skinLoading.has(want.id)) {
    skinLoading.add(want.id);
    loadGLB(`models/skin_${want.id}.glb`).then((g) => { Models.skins[want.id] = g; }).catch(() => {});
  }
  return { id: list[0].id, gltf: Models.skins[list[0].id] || null };
}

export async function preloadModels(onProgress = () => {}) {
  const jobs = [
    loadGLB('models/weapons.glb').then((g) => { Models.weapons = g; }),
    loadGLB('models/skin_phoenix.glb').then((g) => { Models.skins.phoenix = g; }),
    loadGLB('models/skin_seal.glb').then((g) => { Models.skins.seal = g; }),
    loadGLB('models/hostage.glb').then((g) => { Models.hostage = g; }),
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
