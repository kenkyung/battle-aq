// The three.js world for a map.
//
// Collision still comes from the shared map spec (buildColliders), exactly as
// on the server. What you SEE is the Blender build of that same collider set
// (assets/maps/<id>.glb, art/blender/build_maps.py): world-tiled surface
// textures plus a baked lightmap, drawn with unlit materials the way GoldSrc
// drew its BSPs — the whole level costs one texture fetch pair per pixel and
// no real-time lighting, so it runs on old integrated GPUs.
//
// Live lights (sun + sky) exist only for players and weapons, and those are
// tinted by the lightmap under their feet (sampleLight), so a player standing
// in shadow is darker, as in CS 1.6.

import * as THREE from 'three';
import { buildColliders } from '../shared/physics.js';
import { themeFor } from '../shared/themes.js';
import { loadGLB, loadTexture } from './assets.js';

const LM_SCALE = 4.0; // must match art/blender/build_maps.py

// ------------------------------------------------------------ sky

function makeSky(map, theme, sunDir) {
  const geo = new THREE.SphereGeometry(40000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(map.sky.top).multiplyScalar(0.85) },
      horizon: { value: new THREE.Color(map.sky.horizon) },
      ground: { value: new THREE.Color(map.fog.color).multiplyScalar(0.8) },
      sunDir: { value: sunDir.clone() },
      sunColor: { value: new THREE.Color('#' + theme.sunColor) },
      cloudAmt: { value: theme.clouds },
      time: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 top, horizon, ground, sunDir, sunColor;
      uniform float cloudAmt, time;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h > 0.0 ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(horizon, ground, clamp(-h * 4.0, 0.0, 1.0));
        float s = max(dot(d, sunDir), 0.0);
        col += sunColor * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.25 + pow(s, 3.0) * 0.08);
        if (h > 0.0) {
          vec2 uv = d.xz / (h + 0.12) * 1.4 + vec2(time * 0.004, time * 0.002);
          float c = smoothstep(0.52 - cloudAmt * 0.18, 0.85, fbm(uv));
          vec3 cloudCol = mix(vec3(1.0), sunColor, 0.25) * (0.9 + 0.2 * s);
          col = mix(col, cloudCol, c * smoothstep(0.0, 0.25, h) * 0.85);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}

// ------------------------------------------------------------ fallback

// Flat-coloured boxes, used only if the baked map failed to load.
function flatWorld(map, colliders) {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mats = new Map();
  for (const c of colliders) {
    if (!mats.has(c.mat)) mats.set(c.mat, new THREE.MeshLambertMaterial({ color: map.palette[c.mat] ?? 0x8a8a8a }));
    const m = new THREE.Mesh(geo, mats.get(c.mat));
    m.scale.set(c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]);
    m.position.set((c.min[0] + c.max[0]) / 2, (c.min[1] + c.max[1]) / 2, (c.min[2] + c.max[2]) / 2);
    g.add(m);
  }
  return g;
}

// ------------------------------------------------------------ bombsite marks

function bombsiteDecal(label, pos) {
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = 256;
  const ctx = cvs.getContext('2d');
  ctx.strokeStyle = 'rgba(170,30,22,0.8)';
  ctx.lineWidth = 12;
  ctx.setLineDash([26, 14]);
  ctx.beginPath(); ctx.arc(128, 128, 108, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = 'rgba(170,30,22,0.85)';
  ctx.font = 'bold 150px Impact, "Arial Black", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, 128, 138);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, opacity: 0.8,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(pos[0], pos[1] + 0.5, pos[2]);
  m.renderOrder = 2;
  return m;
}

// ------------------------------------------------------------ world

export async function loadWorld(scene, map) {
  const theme = themeFor(map.id);
  const sunDir = new THREE.Vector3(...theme.sunDir).normalize();
  const colliders = buildColliders(map);
  const root = new THREE.Group();
  root.name = 'world';

  scene.background = new THREE.Color(map.sky.horizon);
  scene.fog = new THREE.FogExp2(map.fog.color, map.fog.density * 0.7);
  const sky = makeSky(map, theme, sunDir);
  root.add(sky);

  // live lights: players, weapons, skyline only (the level itself is baked)
  const hemi = new THREE.HemisphereLight(map.sky.top, map.palette.floor ?? 0x806a50, 1.25 * map.ambient);
  const sun = new THREE.DirectionalLight('#' + theme.sunColor, 2.0 * map.sun);
  sun.position.copy(sunDir).multiplyScalar(1000);
  root.add(hemi, sun);

  let level = null;
  let lightImage = null;
  const lmMeshes = [];
  try {
    const [glb, lm] = await Promise.all([
      loadGLB(`maps/${map.id}.glb`),
      loadTexture(`maps/${map.id}_lm.jpg`, { repeat: false }),
    ]);
    lm.channel = 1;
    lightImage = readPixels(lm.image);
    level = glb.scene;
    const texFor = new Map();
    const pending = [];
    level.traverse((o) => {
      if (!o.isMesh) return;
      o.matrixAutoUpdate = false;
      o.updateMatrix();
      // skyline + thin fixtures (ladders) are lit live, the level is baked
      const inSkyline = isUnder(o, 'skyline') || isUnder(o, 'fixtures');
      const name = (o.material.name || '').replace(/\.\d+$/, '');
      const water = /water/.test(name);
      const mat = inSkyline
        ? new THREE.MeshLambertMaterial({ color: 0xe8e2d8 })
        : new THREE.MeshBasicMaterial({
          lightMap: lm, lightMapIntensity: LM_SCALE * Math.PI,
          transparent: water, opacity: water ? (name === 'pool_water' ? 0.62 : 0.82) : 1,
          side: water ? THREE.DoubleSide : THREE.FrontSide, depthWrite: !water,
        });
      mat.name = name;
      if (!texFor.has(name)) texFor.set(name, loadTexture(`tex/${name}.jpg`).catch(() => null));
      pending.push(texFor.get(name).then((t) => { if (t) { mat.map = t; mat.needsUpdate = true; } }));
      o.material = mat;
      if (!inSkyline) lmMeshes.push(o);
    });
    await Promise.all(pending);
    root.add(level);
  } catch (err) {
    console.warn('baked map unavailable, using flat boxes:', err);
    level = flatWorld(map, colliders);
    root.add(level);
  }

  for (const [label, pos] of Object.entries(map.bombsites || {})) root.add(bombsiteDecal(label, pos));
  scene.add(root);

  // --- lightmap probe under a point: how lit is the ground here (0.25..1.3)
  const ray = new THREE.Raycaster();
  ray.far = 400;
  const down = new THREE.Vector3(0, -1, 0);
  const tmp = new THREE.Vector3();
  const reference = 0.72; // stored value of fully sunlit ground, roughly
  function sampleLight(pos) {
    if (!lightImage || !lmMeshes.length) return 1;
    ray.set(tmp.set(pos[0], pos[1] + 24, pos[2]), down);
    const hit = ray.intersectObjects(lmMeshes, false)[0];
    if (!hit || !hit.uv1) return 1;
    const { data, width, height } = lightImage;
    const x = Math.min(width - 1, Math.max(0, Math.floor(hit.uv1.x * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(hit.uv1.y * height)));
    const i = (y * width + x) * 4;
    const v = (data[i] * 0.3 + data[i + 1] * 0.55 + data[i + 2] * 0.15) / 255;
    return Math.max(0.28, Math.min(1.3, 0.2 + 0.8 * v / reference));
  }

  return {
    colliders, root, sky, sun, hemi, theme, sunDir,
    sampleLight,
    update(t) { sky.material.uniforms.time.value = t; },
    dispose() {
      scene.remove(root);
      root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    },
  };
}

function isUnder(o, name) {
  for (let p = o; p; p = p.parent) if (p.name === name) return true;
  return false;
}

function readPixels(img) {
  try {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
  } catch { return null; }
}
