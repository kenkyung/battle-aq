// M11 netcode on a fake clock: usercmd movement (server-side physics),
// speed-hack budget, the `you` ack, reconciliation matches the server, and
// lag compensation (hit boxes rewound to the shooter's view time).
//   node server/netcode.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { Game } = await import('./game.js');
const { TEAM, WEAPONS, ROUND } = await import('../shared/constants.js');
const { movePlayer } = await import('../shared/physics.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => { const s = { readyState: 1, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)) }; s.got = (t) => s.msgs.filter((m) => m.t === t); s.last = (t) => s.got(t).at(-1); return s; };
const tick = (g, s) => { const n = Math.ceil(s * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); } };

const g = new Game('de_aq_dust', { practice: true });
const wa = sock(), wb = sock();
const a = g.addPlayer(wa, 'Mover', { team: TEAM.T });
const b = g.addPlayer(wb, 'Target', { team: TEAM.CT });
g.checkMode();
tick(g, ROUND.freezeTime + 0.3);

console.log('usercmds');
{
  let seq = 0;
  const { raycast } = await import('../shared/physics.js');
  // face the longest clear line from the spawn
  let yaw = 0, best = 0;
  for (let i = 0; i < 16; i++) {
    const y = i * Math.PI / 8;
    const h = raycast([a.pos[0], a.pos[1] + 40, a.pos[2]], [-Math.sin(y), 0, -Math.cos(y)], g.colliders, 2000);
    const d = h ? h.t : 2000;
    if (d > best) { best = d; yaw = y; }
  }
  const start = a.pos.slice();
  // 1 s of running forward, sent as 60 fps commands, in real time
  const local = { pos: start.slice(), vel: [0, 0, 0], yaw, pitch: 0, onGround: true, crouching: false };
  for (let i = 0; i < 60; i++) {
    const c = { s: ++seq, dt: 1 / 60, k: 1, y: yaw, p: 0 };
    fake += 1000 / 60;
    g.onMessage(a, { t: 'cmd', c: [c] });
    movePlayer(local, { f: 1, b: 0, l: 0, r: 0, jump: 0, crouch: 0, walk: 0, maxSpeed: WEAPONS[a.weapon].speed }, c.dt, g.colliders);
  }
  const moved = Math.hypot(a.pos[0] - start[0], a.pos[2] - start[2]);
  ok(moved > 150 && a.usesCmds, `the server moves the player by its commands (${moved.toFixed(0)} u in 1 s)`);
  ok(Math.hypot(a.pos[0] - local.pos[0], a.pos[2] - local.pos[2]) < 0.5, 'client prediction (same physics) lands where the server does');
  g.broadcastSnapshots();
  const you = wa.last('you');
  ok(you && you.s === seq && Math.abs(you.st.pos[2] - a.pos[2]) < 1e-6, 'snapshot is followed by `you` with the acked sequence + state');
  // speed hack: 2 s of commands in 0.1 s of real time
  const p0 = a.pos.slice();
  const cmds = [];
  for (let i = 0; i < 120; i++) cmds.push({ s: ++seq, dt: 1 / 60, k: 1, y: yaw, p: 0 });
  fake += 100;
  g.onMessage(a, { t: 'cmd', c: cmds });
  const d = Math.hypot(a.pos[0] - p0[0], a.pos[2] - p0[2]);
  ok(d > 10 && d < 250 * 0.45, `a burst of 2 s of commands in 0.1 s is cut by the time budget (${d.toFixed(0)} u)`);
  // replays and old sequence numbers are ignored
  const p1 = a.pos.slice();
  g.onMessage(a, { t: 'cmd', c: [{ s: 3, dt: 0.05, k: 1, y: 0, p: 0 }] });
  ok(a.pos[2] === p1[2], 'an old sequence number is ignored');
}

console.log('lag compensation');
{
  // the target stands still for a moment, then side-steps 100 u; a shooter
  // that saw the old spot 150 ms ago still hits it, one that did not misses
  const s = g.spawnSpots(TEAM.T)[0];
  a.pos = [s[0], s[1], s[2]]; a.move.pos = a.pos.slice();
  b.pos = [s[0], s[1], s[2] - 150];
  tick(g, 0.3);
  const seenAt = fake / 1000;
  b.pos = [s[0] + 100, s[1], s[2] - 150];
  tick(g, 0.15);
  const eye = [a.pos[0], a.pos[1] + 53, a.pos[2]];
  const aim = [0, 0, -1];
  a.weapon = 'deagle'; a.ammo.deagle = { mag: 7, reserve: 35 }; a.nextFire = 0;
  b.hp = 100; b.armor = 0;
  g.onMessage(a, { t: 'fire', origin: eye, dir: aim, vt: seenAt });
  ok(b.hp < 100, `shot at where the target was 150 ms ago (view time): hit (${100 - b.hp})`);
  b.hp = 100; a.nextFire = 0; fake += 300;
  g.onMessage(a, { t: 'fire', origin: eye, dir: aim, vt: fake / 1000 });
  ok(b.hp === 100, 'the same shot at the current time misses (it has moved)');
  b.hp = 100; a.nextFire = 0; fake += 600;
  g.onMessage(a, { t: 'fire', origin: eye, dir: aim, vt: fake / 1000 - 5 });
  ok(b.hp === 100, 'rewinding is capped at 0.5 s (sv_maxunlag)');
}

console.log(failures.length ? `\nnetcode: ${failures.length} FAILED` : '\nnetcode: all checks passed');
process.exit(failures.length ? 1 : 0);
