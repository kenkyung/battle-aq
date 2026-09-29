// Collision rules: players block each other (and can always step apart),
// bodies never shove anyone through a wall, a player hammering at walls never
// ends up inside or past one, and the server refuses steps through walls.
//   node server/collide.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { movePlayer, bodyBox, playerBox, aabbOverlap, buildColliders, rng } = await import('../shared/physics.js');
const { MAPS } = await import('../shared/maps.js');
const { PLAYER, TEAM } = await import('../shared/constants.js');
const { Game } = await import('./game.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const floor = [{ min: [-4000, -64, -4000], max: [4000, 0, 4000] }];
const st = (pos, yaw = 0) => ({ pos, vel: [0, 0, 0], yaw, pitch: 0, onGround: true, crouching: false });
const run = (s, keys, cols, secs) => { for (let i = 0; i < secs * 60; i++) movePlayer(s, keys, 1 / 60, cols); };
const fwd = { f: 1, b: 0, l: 0, r: 0, jump: 0, crouch: 0, walk: 0 };

console.log('players');
{
  const s = st([0, 0, 200]);                       // walks -Z toward a player at z=0
  run(s, fwd, floor.concat([bodyBox([0, 0, 0], false)]), 2);
  ok(s.pos[2] >= PLAYER.halfWidth * 2 - 0.1, `walking into a player stops at their hull (z=${s.pos[2].toFixed(2)})`);
  const o = st([0, 0, 10]);                        // already overlapping (they walked into us)
  run(o, fwd, floor.concat([bodyBox([0, 0, 0], false)]), 0.3);
  ok(o.pos[2] >= 10 - 1e-6, 'overlapping: cannot move closer');
  const back = { ...fwd, f: 0, b: 1 };
  run(o, back, floor.concat([bodyBox([0, 0, 0], false)]), 0.5);
  ok(o.pos[2] > PLAYER.halfWidth * 2, 'overlapping: can step apart');
  // a body standing inside you next to a thin wall must not push you through it
  const wall = { min: [-200, 0, 40], max: [200, 128, 48] };
  const w = st([0, 0, 22]);
  run(w, { ...fwd, f: 0 }, floor.concat([wall, bodyBox([0, 0, 12], false)]), 1);
  ok(w.pos[2] < 40 - PLAYER.halfWidth + 0.1, `a body never shoves you into a wall (z=${w.pos[2].toFixed(2)})`);
}

console.log('walls (fuzz: sprint, jump and crouch into walls on every map)');
for (const map of Object.values(MAPS)) {
  const cols = buildColliders(map);
  const r = rng(7);
  let inside = 0, runs = 0;
  const spots = [...map.spawns[TEAM.T], ...map.spawns[TEAM.CT], ...Object.values(map.bombsites || {})];
  for (let k = 0; k < 60; k++) {
    const sp = spots[k % spots.length];
    const s = st([sp[0], sp[1], sp[2]], r() * Math.PI * 2);
    for (let i = 0; i < 60 * 12; i++) {
      if (i % 40 === 0) s.yaw += (r() - 0.5) * 2.5;
      const keys = { f: 1, b: 0, l: r() < 0.3 ? 1 : 0, r: 0, jump: r() < 0.05 ? 1 : 0, crouch: r() < 0.2 ? 1 : 0, walk: 0 };
      movePlayer(s, keys, 1 / 60, cols);
      const box = playerBox(s.pos, s.crouching);
      box.min[0] += 0.5; box.min[2] += 0.5; box.max[0] -= 0.5; box.max[2] -= 0.5; box.min[1] += 0.5;
      if (cols.some((c) => aabbOverlap(box, c))) { inside++; break; }
    }
    runs++;
  }
  ok(inside === 0, `${map.id}: ${runs} runs, never inside a solid (${inside})`);
}

console.log('server check');
{
  const g = new Game('de_aq_dust', { practice: true });
  const sent = [];
  const p = g.addPlayer({ readyState: 1, send: (m) => sent.push(JSON.parse(m)) }, 'Walker', { team: TEAM.T });
  g.phase = 'round';
  // find a wall: a long thin one, step across it
  const wall = g.colliders.find((c) => c.max[1] - c.min[1] >= 128 && c.max[0] - c.min[0] <= 64 && c.max[2] - c.min[2] >= 256 && c.min[1] <= 1);
  const z = (wall.min[2] + wall.max[2]) / 2;
  const before = [wall.min[0] - 30, 0, z];
  p.pos = before.slice(); p.moveT = fake / 1000;
  fake += 100;
  g.onMessage(p, { t: 'state', pos: [wall.max[0] + 30, 0, z], yaw: 0, pitch: 0 });
  ok(p.pos[0] === before[0] && sent.some((m) => m.t === 'correct'), 'a step through a wall is refused and corrected');
  fake += 100;
  g.onMessage(p, { t: 'state', pos: [before[0] - 20, 0, z], yaw: 0, pitch: 0 });
  ok(p.pos[0] === before[0] - 20, 'a normal step is accepted');
}

console.log('no false positives (legit movement is never refused)');
for (const map of Object.values(MAPS)) {
  const g = new Game(map.id, { practice: true });
  const sent = [];
  const p = g.addPlayer({ readyState: 1, send: (m) => sent.push(JSON.parse(m)) }, 'Walker', { team: TEAM.T });
  g.phase = 'round';
  const r = rng(11);
  const spots = [...map.spawns[TEAM.T], ...map.spawns[TEAM.CT], ...Object.values(map.bombsites || {})];
  let refused = 0, steps = 0;
  for (let k = 0; k < 30; k++) {
    const sp = spots[k % spots.length];
    const s = st([sp[0], sp[1], sp[2]], r() * Math.PI * 2);
    p.pos = s.pos.slice(); p.moveT = fake / 1000;
    for (let i = 0; i < 60 * 10; i++) {
      if (i % 40 === 0) s.yaw += (r() - 0.5) * 2.5;
      const keys = { f: 1, b: 0, l: r() < 0.3 ? 1 : 0, r: 0, jump: r() < 0.05 ? 1 : 0, crouch: r() < 0.2 ? 1 : 0, walk: 0, maxSpeed: 250 };
      movePlayer(s, keys, 1 / 60, g.colliders);
      fake += 1000 / 60;
      if (i % 2) continue;                                         // the client sends ~30 Hz
      g.onMessage(p, { t: 'state', pos: s.pos.slice(), yaw: s.yaw, pitch: 0, crouching: s.crouching });
      steps++;
      if (p.pos[0] !== s.pos[0] || p.pos[2] !== s.pos[2] || p.pos[1] !== s.pos[1]) { refused++; if (process.env.V) console.log("   refused", p.pos.map(Math.round), "->", s.pos.map((v) => +v.toFixed(1)), s.crouching); p.pos = s.pos.slice(); }
    }
  }
  ok(refused === 0, `${map.id}: ${steps} legit steps, ${refused} refused`);
}

console.log(failures.length ? `\ncollide: ${failures.length} FAILED` : '\ncollide: all checks passed');
process.exit(failures.length ? 1 : 0);
