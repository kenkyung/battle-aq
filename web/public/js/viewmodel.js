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
  rifle:  { pos: [5.0, -6.4, -15.5], rot: [0.02, 0.05, 0] },
  sniper: { pos: [4.8, -6.6, -15.0], rot: [0.02, 0.04, 0] },
  pistol: { pos: [3.6, -4.6, -14.0], rot: [0.04, 0.08, 0] },
  knife:  { pos: [7.0, -6.2, -11.0], rot: [0.35, 0.35, -0.5] },
};
const holdFor = (id) => {
  const w = WEAPONS[id];
  if (w.melee) return HOLD.knife;
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
    gun.traverse((o) => {
      if (o.isMesh) {
        o.material = toPhong(o.material, id === 'deagle' || id === 'knife');
        o.frustumCulled = false;
      }
    });
    this.holder.add(gun);
    const hold = holdFor(id);
    this.holder.position.set(...hold.pos);
    this.holder.rotation.set(...hold.rot);

    this.muzzle = gun.getObjectByName(`${id}_muzzle`) || gun;
    this.muzzle.add(this.flash);
    this.flash.position.set(0, 0, -1.5);

    // arms: right hand on the grip, left on the handguard (or cupping the
    // right hand for pistols); forearms run back past the camera
    const armId = this.team === TEAM.CT ? 'arm_ct' : 'arm_t';
    const right = weaponModel(armId);
    const left = weaponModel(armId);
    for (const a of [right, left]) {
      if (!a) continue;
      a.traverse((o) => { if (o.isMesh) { o.material = toPhong(o.material, false); o.frustumCulled = false; } });
    }
    const w = WEAPONS[id];
    if (right) {
      // forearm (+Z in the arm model) must run down and back out of frame
      right.position.set(0.2, -0.4, 0.4);
      right.rotation.set(0.95, 0.5, 0.1, 'YXZ');
      if (w.melee) right.rotation.set(0.8, 0.35, 0.0, 'YXZ');
      gun.add(right);
    }
    if (left && !w.melee) {
      const lh = gun.getObjectByName(`${id}_lhand`);
      left.scale.x = -1;
      if (lh) {
        left.position.copy(lh.position).add(new THREE.Vector3(-0.4, -0.6, 0));
        left.rotation.set(0.75, -0.75, 0.25, 'YXZ');
      } else {
        left.position.set(-1.4, -1.8, 1.4);
        left.rotation.set(1.0, -0.6, 0.1, 'YXZ');
      }
      gun.add(left);
    }
    if (animate) this.drawT = 0;
    this.reloadT = 1;
  }

  fire() {
    const w = WEAPONS[this.weapon];
    if (w.melee) { this.swingT = 0; return; }
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

  render(renderer) {
    if (!this.visible || !this.gun) return;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}

function toPhong(m, shiny) {
  return new THREE.MeshPhongMaterial({
    map: m.map || null,
    color: m.map ? 0xffffff : (m.color || 0x888888),
    shininess: shiny ? 70 : 28,
    specular: shiny ? 0x666666 : 0x2a2a2a,
  });
}

const easeOut = (t) => 1 - (1 - t) * (1 - t);
