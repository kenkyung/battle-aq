// Remote player avatars: a team-coloured capsule + name sprite, smoothly
// interpolated between server snapshots. No local simulation — they render
// where the server says they are.

import * as THREE from 'three';
import { TEAM, PLAYER } from '/shared/constants.js';

function makeNameSprite(name, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.strokeText(name, 128, 44);
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 44);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  spr.scale.set(80, 20, 1);
  spr.renderOrder = 5;
  return spr;
}

export class Remotes {
  constructor(scene) {
    this.scene = scene;
    this.players = new Map();
    this.capsuleGeo = new THREE.CapsuleGeometry(PLAYER.halfWidth, PLAYER.standHeight - PLAYER.halfWidth * 2, 4, 10);
    this.matT = new THREE.MeshLambertMaterial({ color: 0xb08a5e });
    this.matCT = new THREE.MeshLambertMaterial({ color: 0x5e83b0 });
  }

  ensure(p) {
    let r = this.players.get(p.id);
    if (r) return r;
    const group = new THREE.Group();
    const capsule = new THREE.Mesh(this.capsuleGeo, p.team === TEAM.CT ? this.matCT : this.matT);
    capsule.position.y = PLAYER.standHeight / 2;
    group.add(capsule);
    const tag = makeNameSprite(p.name || `#${p.id}`, p.team === TEAM.CT ? '#a8ccf0' : '#f0d0a8');
    tag.position.y = PLAYER.standHeight + 20;
    group.add(tag);
    this.scene.add(group);
    r = {
      id: p.id, group, capsule, tag,
      cur: { pos: [...p.pos], yaw: p.yaw || 0 },
      tgt: { pos: [...p.pos], yaw: p.yaw || 0 },
      alive: true,
    };
    this.players.set(p.id, r);
    return r;
  }

  remove(id) {
    const r = this.players.get(id);
    if (!r) return;
    this.scene.remove(r.group);
    this.players.delete(id);
  }

  clear() {
    for (const id of [...this.players.keys()]) this.remove(id);
  }

  setTarget(p) {
    const r = this.ensure(p);
    r.tgt.pos = [...p.pos];
    r.tgt.yaw = p.yaw || 0;
    r.tgt.crouching = !!p.crouching;
    r.alive = p.alive !== false;
    r.capsule.visible = r.alive;
    r.tag.visible = r.alive;
  }

  update(dt) {
    const t = Math.min(1, dt * 12);
    for (const r of this.players.values()) {
      for (let i = 0; i < 3; i++) r.cur.pos[i] += (r.tgt.pos[i] - r.cur.pos[i]) * t;
      let dy = r.tgt.yaw - r.cur.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      r.cur.yaw += dy * t;
      r.group.position.set(r.cur.pos[0], r.cur.pos[1], r.cur.pos[2]);
      r.group.rotation.y = r.cur.yaw;
      const targetH = r.tgt.crouching ? 0.55 : 1.0;
      r.capsule.scale.y += (targetH - r.capsule.scale.y) * t;
    }
  }
}
