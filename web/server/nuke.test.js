// de_aq_nuke (M20): stacked sites, the crouch-only vent and the hatch ladder,
// for players and bots.   node server/nuke.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { Game } = await import('./game.js');
const { TEAM } = await import('../shared/constants.js');
const { movePlayer } = await import('../shared/physics.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => ({ readyState: 1, send() {} });
const advance = (g, sec, each) => { const n = Math.ceil(sec * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); if (each) each(); } };

const g = new Game('de_aq_nuke', { practice: true });
g.addPlayer(sock(), 'Watcher', { team: TEAM.T });
g.checkMode();
advance(g, g.freezeTime + 0.5);

console.log('sites');
ok(g.inSite([-380, 256, -600]) === 'A' && g.inSite([-380, 0, -640]) === 'B', 'A upstairs and B below it are different sites');

console.log('player physics');
{
  const st = { pos: [384, 0, -384], vel: [0, 0, 0], yaw: Math.PI / 2, pitch: 0, onGround: true, crouching: false };
  for (let i = 0; i < 60; i++) movePlayer(st, { f: 1, maxSpeed: 250 }, 1 / 60, g.colliders);
  ok(st.pos[0] > 380, 'standing, you cannot walk into the vent');
  const c = { pos: [540, 0, -384], vel: [0, 0, 0], yaw: Math.PI / 2, pitch: 0, onGround: true, crouching: true };
  for (let i = 0; i < 240; i++) movePlayer(c, { f: 1, crouch: 1, maxSpeed: 250 }, 1 / 60, g.colliders);
  ok(c.pos[0] < 250, `crouched, you crawl through it into B (x ${c.pos[0].toFixed(0)})`);
  const l = { pos: [176, 0, -1072], vel: [0, 0, 0], yaw: Math.PI, pitch: 0, onGround: true, crouching: false };
  for (let i = 0; i < 180; i++) movePlayer(l, { f: 1, maxSpeed: 250, ladders: g.map.ladders }, 1 / 60, g.colliders);
  ok(l.pos[1] >= 255, `the hatch ladder climbs from B up to A (y ${l.pos[1].toFixed(0)})`);
}

const botTo = (from, to, sec) => {
  const b = g.addBot(TEAM.CT, 'normal');
  b.pos = [...from]; b.bot.reset(); b.alive = true;
  b.bot.chooseGoal = () => ({ key: 'test', pos: to });
  b.bot.perceive = () => {};
  let crouched = false, best = Infinity;
  advance(g, sec, () => { crouched = crouched || b.crouching; best = Math.min(best, Math.hypot(b.pos[0] - to[0], (b.pos[1] - to[1]) * 3, b.pos[2] - to[2])); });
  g.removePlayer(b.id);
  return { crouched, best, pos: b.pos };
};

console.log('bots');
{
  const r = botTo([-380, 0, -640], [-380, 256, -600], 25);
  ok(r.best < 80, `a bot climbs from B to A by the ladder (closest ${r.best.toFixed(0)} u)`);
  const v = botTo([700, 0, -384], [100, 0, -384], 20);
  ok(v.best < 80 && v.crouched, `a bot crawls through the vent (crouched: ${v.crouched}, closest ${v.best.toFixed(0)} u)`);
  const d = botTo([-380, 256, -600], [-380, 0, -640], 25);
  ok(d.best < 80, `and comes back down (closest ${d.best.toFixed(0)} u)`);
}

console.log(failures.length ? `\nnuke: ${failures.length} FAILED` : '\nnuke: all checks passed');
process.exit(failures.length ? 1 : 0);
