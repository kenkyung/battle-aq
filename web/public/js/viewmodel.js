// First-person weapon + arms.
//
// Rendered in its own scene with its own camera after the world (depth
// cleared), like every FPS since Quake: the gun never clips into walls and
// its field of view is independent of zoom. The models are the Blender builds
// in weapons.glb; all motion is procedural (bob, sway, recoil kick, draw,
// reload dip, knife swing), driven by the local player each frame.

import * as THREE from 'three';
import { weaponModel } from './assets.js';
import { WEAPONS, TEAM } from '../shared/constants.js';
import { flashTexture } from './textures.js';

// Where the gun sits in front of the eye (inches, camera space).
const HOLD = {
  rifle:  { pos: [5.4, -6.9, -18.5], rot: [0.02, 0.06, 0] },
  sniper: { pos: [5.2, -7.0, -18.0], rot: [0.02, 0.05, 0] },
  pistol: { pos: [3.6, -4.6, -14.0], rot: [0.04, 0.08, 0] },
  knife:  { pos: [7.0, -6.2, -11.0], rot: [0.35, 0.35, -0.5] },
  c4:     { pos: [3.5, -7.5, -12.0], rot: [0.5, 0.2, 0] },
  nade:   { pos: [5.0, -5.8, -11.0], rot: [0.25, 0.2, 0] },
};
const holdFor = (id) => {
  const w = WEAPONS[id];
  if (w.melee) return HOLD.knife;
  if (w.bomb) return HOLD.c4;
  if (w.grenade) return HOLD.nade;
  if (w.zoomFov) return HOLD.sniper;
  if (w.slot === 'secondary') return HOLD.pistol;
  return HOLD.rifle;
};

export class Viewmodel {
  constructor(aspect) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.5, 400);
    this.scene.add(this.camera);

    this.hemi = new THREE.HemisphereLight(0xcfd8e0, 0x5a4a38, 1.6);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 1.8);
    this.sun.position.set(0.4, 1, 0.3);
    this.scene.add(this.hemi, this.sun);
    this.baseHemi = 1.6; this.baseSun = 1.8;

    this.rig = new THREE.Group();      // bob/sway/recoil
    this.camera.add(this.rig);
    this.holder = new THREE.Group();   // per-weapon hold offset
    this.rig.add(this.holder);

    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    this.flash.visible = false;
    this.flashLight = new THREE.PointLight(0xffc070, 0, 60, 1.5);
    this.scene.add(this.flashLight);

    this.weapon = null;
    this.team = TEAM.T;
    this.gun = null;
    this.muzzle = new THREE.Object3D();
    this.t = 0;
    this.bobPhase = 0;
    this.kick = 0;
    this.kickRot = 0;
    this.drawT = 1;
    this.reloadT = 1; this.reloadDur = 1;
    this.swingT = 1;
    this.sway = new THREE.Vector2();
    this.flashT = 0;
    this.tint = 1;
    this.visible = true;
    this.env = null;
    this._mats = new Set();
  }

  setAspect(a) { this.camera.aspect = a; this.camera.updateProjectionMatrix(); }

  setTeam(team) {
    if (team === this.team) return;
    this.team = team;
    const w = this.weapon; this.weapon = null;
    if (w) this.setWeapon(w, false);
  }

  setWeapon(id, animate = true) {
    if (id === this.weapon) return;
    this.weapon = id;
    this.holder.clear();
    const gun = weaponModel(id);
    if (!gun) { this.gun = null; return; }
    this.gun = gun;
    gun.traverse((o) => { if (o.isMesh) { o.material = this.pbr(o.material, id === 'deagle' || id === 'knife'); o.frustumCulled = false; } });
    this.holder.add(gun);
    const hold = holdFor(id);
    this.holder.position.set(...hold.pos);
    this.holder.rotation.set(...hold.rot);

    this.muzzle = gun.getObjectByName(`${id}_muzzle`) || gun;
    this.muzzle.add(this.flash);
    this.flash.position.set(0, 0, -1.5);

    // gloved hands, modelled closed around this gun's grip and handguard
    // (weapons.glb has <id>_grip / <id>_lhand empties for them)
    const team = this.team === TEAM.CT ? 'ct' : 't';
    const w = WEAPONS[id];
    const attach = (handId, emptyName) => {
      const socket = gun.getObjectByName(emptyName);
      const hand = weaponModel(handId);
      if (!socket || !hand) return;
      hand.traverse((o) => { if (o.isMesh) { o.material = this.pbr(o.material, false); o.frustumCulled = false; } });
      socket.add(hand);
    };
    attach('hand_r_' + team, `${id}_grip`);
    if (!w.melee && !w.grenade) attach('hand_l_' + team, `${id}_lhand`);
    if (animate) this.drawT = 0;
    this.reloadT = 1;
  }

  fire() {
    const w = WEAPONS[this.weapon];
    if (w.melee || w.grenade) { this.swingT = 0; return; }
    const heavy = w.zoomFov ? 1.6 : w.slot === 'secondary' ? 1.0 : 0.7;
    this.kick = Math.min(this.kick + 1.4 * heavy, 3.5);
    this.kickRot = Math.min(this.kickRot + 0.05 * heavy, 0.16);
    this.flashT = 0.045;
    this.flash.material.rotation = Math.random() * Math.PI;
    const s = (w.slot === 'secondary' ? 5 : 8) * (0.85 + Math.random() * 0.3);
    this.flash.scale.set(s, s, 1);
  }

  reload(duration) { this.reloadT = 0; this.reloadDur = Math.max(0.3, duration); }
  cancelReload() { this.reloadT = 1; }

  // muzzle position in the MAIN camera's world, for tracers
  muzzleWorld(mainCamera, out = new THREE.Vector3()) {
    this.muzzle.getWorldPosition(out);            // in viewmodel-camera space
    this.camera.worldToLocal(out);
    // map into the main camera frame (same orientation, origin at the eye)
    return mainCamera.localToWorld(out.multiplyScalar(1));
  }

  update(dt, { speed = 0, onGround = true, lookDX = 0, lookDY = 0, tint = 1 } = {}) {
    this.t += dt;
    const k = Math.min(1, dt * 10);
    // bob with ground speed
    const moveAmt = onGround ? Math.min(1, speed / 250) : 0;
    this.bobPhase += dt * (6 + 5 * moveAmt) * (moveAmt > 0.05 ? 1 : 0.25);
    const bx = Math.sin(this.bobPhase) * 0.35 * moveAmt;
    const by = -Math.abs(Math.cos(this.bobPhase)) * 0.28 * moveAmt + Math.sin(this.t * 1.6) * 0.06;
    // sway lags the mouse
    this.sway.x += (-lookDX * 18 - this.sway.x) * k;
    this.sway.y += (lookDY * 18 - this.sway.y) * k;
    this.sway.clampScalar(-1.2, 1.2);

    // recoil recovery
    this.kick = Math.max(0, this.kick - dt * 14);
    this.kickRot = Math.max(0, this.kickRot - dt * 0.9);

    // draw: rise from below
    this.drawT = Math.min(1, this.drawT + dt / 0.35);
    const draw = 1 - easeOut(this.drawT);

    // reload: dip + roll, hold, back up
    this.reloadT = Math.min(1, this.reloadT + dt / this.reloadDur);
    const r = this.reloadT;
    const rl = r < 1 ? Math.sin(Math.min(1, r / 0.25) * Math.PI / 2) * (r > 0.75 ? 1 - (r - 0.75) / 0.25 : 1) : 0;

    // knife swing arc
    this.swingT = Math.min(1, this.swingT + dt / 0.32);
    const sw = this.swingT < 1 ? Math.sin(this.swingT * Math.PI) : 0;

    this.rig.position.set(
      bx + this.sway.x * 0.6 - sw * 3,
      by - this.sway.y * 0.6 - draw * 8 - rl * 2.5,
      this.kick + sw * -2,
    );
    this.rig.rotation.set(
      this.kickRot - draw * 0.9 - rl * 0.35 + sw * 0.3,
      this.sway.x * 0.03 + sw * 0.9,
      -rl * 0.6 - sw * 0.4,
    );

    // flash
    this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    if (this.flash.visible) {
      this.muzzle.getWorldPosition(this.flashLight.position);
      this.flashLight.intensity = 4000;
    } else this.flashLight.intensity = 0;

    // lighting follows the lightmap under the player
    this.tint += (Math.max(0.6, tint) - this.tint) * Math.min(1, dt * 4);
    this.hemi.intensity = this.baseHemi * this.tint;
    this.sun.intensity = this.baseSun * this.tint;
  }

  // glTF PBR material (albedo + normal + roughness maps from the Blender
  // bake), reflecting a small sky environment so metal reads as metal
  pbr(m, shiny) {
    const mat = m.isMeshStandardMaterial ? m : new THREE.MeshStandardMaterial({ map: m.map || null });
    mat.envMap = this.env || null;
    mat.envMapIntensity = shiny ? 1.0 : 0.55;
    if (!shiny) mat.metalness = Math.min(mat.metalness, 0.2);
    if (mat.normalMap) mat.normalScale.set(1, 1);
    this._mats.add(mat);
    return mat;
  }

  buildEnv(renderer) {
    const pm = new THREE.PMREMGenerator(renderer);
    const sc = new THREE.Scene();
    const geo = new THREE.SphereGeometry(10, 32, 16);
    const col = new THREE.Color();
    const pos = geo.attributes.position;
    const colors = [];
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 10;
      col.setRGB(0.55, 0.5, 0.42).lerp(new THREE.Color(0.75, 0.8, 0.88), Math.max(0, y) ** 0.6);
      if (y < 0) col.setRGB(0.36, 0.3, 0.24).lerp(new THREE.Color(0.55, 0.5, 0.42), 1 + y);
      colors.push(col.r, col.g, col.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    sc.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfff2d0 }));
    sunDisc.position.set(4, 7, 3);
    sc.add(sunDisc);
    this.env = pm.fromScene(sc, 0.03).texture;
    pm.dispose();
    for (const m of this._mats) { m.envMap = this.env; m.needsUpdate = true; }
  }

  render(renderer) {
    if (!this.env) this.buildEnv(renderer);
    if (!this.visible || !this.gun) return;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}

const easeOut = (t) => 1 - (1 - t) * (1 - t);
