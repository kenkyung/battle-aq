// CS 1.6 movement bench (shared/physics.js vs pm_shared numbers): run / walk /
// duck speeds, jump and duck-jump heights, the 0.4 s duck, counter-strafe,
// air-strafe gain, edge friction, being tagged, ladders and water.
//   node server/movement.test.js

const { movePlayer, tag, waterLevel } = await import('../shared/physics.js');
const { PLAYER, MOVE } = await import('../shared/constants.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const DT = 1 / 100;
const floor = [{ min: [-9000, -64, -9000], max: [9000, 0, 9000] }];
const st = (pos = [0, 0, 0], yaw = 0) => ({ pos, vel: [0, 0, 0], yaw, pitch: 0, onGround: true, crouching: false });
const K = (o = {}) => ({ f: 0, b: 0, l: 0, r: 0, jump: 0, crouch: 0, walk: 0, maxSpeed: 250, ...o });
const run = (s, keys, secs, cols = floor, each) => { for (let i = 0; i < Math.round(secs / DT); i++) { movePlayer(s, keys, DT, cols); if (each) each(s, i); } return s; };
const hs = (s) => Math.hypot(s.vel[0], s.vel[2]);

console.log('speeds');
ok(near(hs(run(st(), K({ f: 1 }), 2)), 250, 0.5), 'run 250 u/s (knife)');
ok(near(hs(run(st(), K({ f: 1, walk: 1 }), 2)), 130, 0.5), 'walk (Shift) 130 u/s');
ok(near(hs(run(st(), K({ f: 1, crouch: 1 }), 2)), 250 * 0.333, 0.5), 'ducked 83 u/s');
ok(near(hs(run(st(), K({ f: 1, maxSpeed: 221 }), 2)), 221, 0.5), 'AK-47 in hand: 221 u/s');

console.log('jumps');
{
  let top = 0;
  const s = st(); run(s, K(), 0.2);
  run(s, K({ jump: 1 }), 1.2, floor, (x) => { top = Math.max(top, x.pos[1]); });
  ok(near(top, 45, 1.2), `standing jump peaks at 45 u (${top.toFixed(1)})`);
  let dtop = 0;
  const d = st(); run(d, K(), 0.2);
  run(d, K({ jump: 1 }), 0.05); run(d, K({ jump: 1, crouch: 1 }), 1.2, floor, (x) => { dtop = Math.max(dtop, x.pos[1]); });
  ok(near(dtop, 63, 1.5), `duck-jump lifts the feet to 63 u (${dtop.toFixed(1)})`);
  // onto a crate: 56 u only with a duck-jump, 64 u never (no stepping in the air)
  const crate = (h) => floor.concat([{ min: [-32, 0, -132], max: [32, h, -68] }]);
  const tryJump = (h, duckIt) => { let on = false; const s = st([0, 0, -20]); run(s, K({ f: 1 }), 0.1, crate(h)); run(s, K({ f: 1, jump: 1 }), 0.1, crate(h)); run(s, K({ f: 1, jump: 1, crouch: duckIt ? 1 : 0 }), 0.7, crate(h), (x) => { if (x.onGround && x.pos[1] >= h - 0.5) on = true; }); return on; };
  ok(!tryJump(56, false) && tryJump(56, true), '56 u crate: only a duck-jump makes it');
  ok(!tryJump(64, true), '64 u crate: out of reach even duck-jumping');
  ok(tryJump(40, false), '40 u crate: a plain jump');
}

console.log('ducking');
{
  const s = st(); run(s, K(), 0.1);
  run(s, K({ crouch: 1 }), 0.2);
  ok(!s.crouching && s.eye < PLAYER.standEye && s.eye > PLAYER.crouchEye, `0.2 s in: hull still standing, view half way (${s.eye.toFixed(1)})`);
  run(s, K({ crouch: 1 }), 0.25);
  ok(s.crouching && s.eye === PLAYER.crouchEye, 'after 0.4 s: ducked hull, VEC_DUCK_VIEW');
  run(s, K(), 0.01);
  ok(!s.crouching && s.eye === PLAYER.standEye, 'standing up is instant');
  const low = floor.concat([{ min: [-100, 50, -100], max: [100, 80, 100] }]);
  const u = st(); u.crouching = true; run(u, K({ crouch: 1 }), 0.5, low); run(u, K(), 0.2, low);
  ok(u.crouching, 'cannot stand up under a 50 u ceiling');
}

console.log('stopping');
{
  const a = st(); run(a, K({ f: 1 }), 1); let t1 = 0; run(a, K(), 1, floor, (x, i) => { if (!t1 && hs(x) < 1) t1 = (i + 1) * DT; });
  const b = st(); run(b, K({ f: 1 }), 1); let t2 = 0; run(b, K({ b: 1 }), 1, floor, (x, i) => { if (!t2 && x.vel[2] > -1) t2 = (i + 1) * DT; });
  ok(t1 > 0.2 && t1 < 0.6, `letting go stops you in ${t1.toFixed(2)} s`);
  ok(t2 < t1 * 0.75, `counter-strafing stops faster (${t2.toFixed(2)} s)`);
}

console.log('air strafe');
{
  const s = st(); run(s, K({ f: 1 }), 1);
  run(s, K({ jump: 1, f: 1 }), 0.03);
  for (let i = 0; i < 60; i++) { s.yaw += 0.02; movePlayer(s, K({ r: 0, l: 1 }), DT, floor); }
  ok(hs(s) > 255, `turning with a strafe key gains air speed (${hs(s).toFixed(0)} u/s)`);
}

console.log('edge friction');
{
  const ledge = [{ min: [-9000, -64, -9000], max: [9000, 0, -200] }, { min: [-9000, -600, -9000], max: [9000, -500, 9000] }];
  // sliding at 200 u/s toward a drop at z = -200 (the ground ends 10 u ahead) vs on open ground
  const e = st([0, 0, -210], Math.PI); e.vel = [0, 0, 200];
  const plain = st([0, 0, -1300], Math.PI); plain.vel = [0, 0, 200];
  movePlayer(e, K(), DT, ledge); movePlayer(plain, K(), DT, floor);
  const dropEdge = 200 - hs(e), dropPlain = 200 - hs(plain);
  ok(near(dropEdge, dropPlain * 2, 0.05), `friction doubles 16 u from a drop (${dropEdge.toFixed(2)} vs ${dropPlain.toFixed(2)})`);
}

console.log('tagging');
{
  const s = st(); run(s, K({ f: 1 }), 1);
  tag(s, 0.5); run(s, K({ f: 1 }), 0.05);
  ok(hs(s) < 150, `shot: slowed to ${hs(s).toFixed(0)} u/s`);
  run(s, K({ f: 1 }), 1.0);
  ok(hs(s) > 245, 'recovers to full speed within a second');
}

console.log('ladder');
{
  const lad = [{ min: [-20, 0, -216], max: [20, 200, -200], normal: [0, 1] }];     // wall at z -216, climber on +z
  const wall = floor.concat([{ min: [-200, 0, -300], max: [200, 180, -216] }]);
  const s = st([0, 0, -180], 0);
  run(s, K({ f: 1, ladders: lad }), 0.3, wall);
  const y0 = s.pos[1]; run(s, K({ f: 1, ladders: lad }), 0.25, wall);
  ok(s.onLadder && near((s.pos[1] - y0) / 0.25, MOVE.climbSpeed, 12), `climbs at 200 u/s looking level (${((s.pos[1] - y0) / 0.25).toFixed(0)})`);
  s.pitch = -1.2; const y1 = s.pos[1]; run(s, K({ f: 1, ladders: lad }), 0.2, wall);
  ok(s.pos[1] < y1, 'looking down + forward climbs down');
  s.pitch = 0; run(s, K({ f: 1, ladders: lad }), 1.5, wall);
  ok(s.pos[1] >= 180 - 0.5 && s.pos[2] < -216, 'tops out onto the ledge');
  const j = st([0, 0, -180], 0); run(j, K({ f: 1, ladders: lad }), 0.4, wall);
  run(j, K({ jump: 1, ladders: lad }), DT);
  ok(near(j.vel[2], MOVE.ladderJump, 1), 'jump pushes off the ladder at 270 u/s');
}

console.log('water');
{
  const map = { water: [{ y: 20, w: 320, d: 320, pos: [0, 0] }] };
  ok(waterLevel(map, [0, 0, 0]) === 1 && waterLevel(map, [0, 30, 0]) === 0 && waterLevel(map, [500, 0, 0]) === 0, 'fountain: feet in the water inside it, dry outside');
}

console.log(failures.length ? `\nmovement: ${failures.length} FAILED` : '\nmovement: all checks passed');
process.exit(failures.length ? 1 : 0);
