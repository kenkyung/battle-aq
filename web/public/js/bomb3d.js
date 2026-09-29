// The C4 in the world: lying where it was dropped, or planted with its LED
// blinking faster as the timer runs down (the visual half of CS's beeping;
// the sound comes with the audio milestone). Plus the explosion.

import * as THREE from 'three';
import { weaponModel } from './assets.js';
import { puffTexture } from './textures.js';

export class BombView {
  constructor(scene, fx) {
    this.scene = scene;
    this.fx = fx;
    this.group = new THREE.Group();
    this.group.visible = false;
    const model = weaponModel('c4');
    if (model) {
      model.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshLambertMaterial({ map: o.material.map }); });
      model.rotation.y = Math.random() * Math.PI;
      this.group.add(model);
    } else {
      const box = new THREE.Mesh(new THREE.BoxGeometry(10, 4, 7), new THREE.MeshLambertMaterial({ color: 0x5a4a30 }));
      box.position.y = 2;
      this.group.add(box);
    }
    this.led = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexture(), color: 0xff2010, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.led.scale.set(7, 7, 1);
    this.led.position.set(0, 5.5, 0);
    this.group.add(this.led);
    this.light = new THREE.PointLight(0xff3020, 0, 90, 1.5);
    this.light.position.set(0, 10, 0);
    this.group.add(this.light);
    scene.add(this.group);
    this.blinkT = 0;
    this.shake = 0;
  }

  // info: the snapshot's bomb field (state, pos, left)
  update(info, dt) {
    const show = info && info.pos && (info.state === 'planted' || info.state === 'dropped');
    this.group.visible = !!show;
    if (!show) return;
    this.group.position.set(info.pos[0], info.pos[1], info.pos[2]);
    if (info.state === 'planted') {
      // interval shrinks from 1 s to 0.1 s over the last 35 s
      const left = Math.max(0, info.localLeft ?? info.left ?? 35);
      const interval = Math.max(0.1, Math.min(1, left / 30));
      this.blinkT += dt;
      const on = (this.blinkT % interval) < 0.08;
      this.led.visible = on;
      this.light.intensity = on ? 800 : 0;
    } else {
      this.led.visible = false;
      this.light.intensity = 0;
    }
  }

  explode(pos) {
    const fx = this.fx;
    const P = [pos[0], pos[1] + 30, pos[2]];
    fx.muzzleFlash(P, 600);
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, u = Math.random();
      const sp = 300 + Math.random() * 700;
      fx.puff(P, [Math.cos(a) * sp * (1 - u), 200 + u * 600, Math.sin(a) * sp * (1 - u)],
        new THREE.Color(1, 0.55 + Math.random() * 0.3, 0.2), 60 + Math.random() * 90, 0.7 + Math.random() * 0.6, 120, 100, true);
    }
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2;
      fx.puff(P, [Math.cos(a) * 250, 80 + Math.random() * 250, Math.sin(a) * 250],
        new THREE.Color(0.25, 0.23, 0.21), 90 + Math.random() * 120, 2.5 + Math.random() * 2, 80, -20);
    }
    this.shake = 1;
    this.group.visible = false;
  }

  dispose() { this.scene.remove(this.group); }
}
