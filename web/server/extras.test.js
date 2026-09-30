// M18 extras on a fake clock: nightvision + tactical shield purchases, the
// shield stopping frontal fire, swimming (PM_WaterMove) and drowning.
//   node server/extras.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { Game } = await import('./game.js');
const { TEAM, WEAPONS, ROUND } = await import('../shared/constants.js');
const { movePlayer } = await import('../shared/physics.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => { const s = { readyState: 1, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)) }; s.got = (t) => s.msgs.filter((m) => m.t === t); return s; };
const advance = (g, sec) => { const n = Math.ceil(sec * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); } };

console.log('nightvision + shield');
{
  const g = new Game('de_aq_dust', { practice: true });
  const wc = sock();
  const t = g.addPlayer(sock(), 'T', { team: TEAM.T });
  const c = g.addPlayer(wc, 'CT', { team: TEAM.CT });
  g.checkMode();
  c.money = 16000; t.money = 16000;
  g.onMessage(c, { t: 'buy', item: 'nvg' });
  ok(c.nvg && wc.got('inv').at(-1).nvg, 'nightvision bought ($1250)');
  g.onMessage(c, { t: 'buy', item: 'm4a1' });
  g.onMessage(c, { t: 'buy', item: 'shield' });
  ok(c.shield && !c.inv.primary && g.drops.some((d) => d.weapon === 'm4a1'), 'the shield takes the primary slot (the M4 drops)');
  g.onMessage(t, { t: 'buy', item: 'shield' });
  ok(!t.shield, 'terrorists cannot buy the shield');
  advance(g, ROUND.freezeTime + 0.2);
  c.pos = [0, 128, 2000]; c.yaw = 0;                 // facing -z
  t.pos = [0, 128, 1800];                            // in front of the CT
  c.hp = 100; c.armor = 0; c.lastFire = 0;
  g.applyDamage(t, { id: c.id, part: 'chest', point: c.pos, t: 200 }, WEAPONS.ak47, 36);
  ok(c.hp === 100 && g.players.size, 'a chest shot from the front hits the shield');
  g.applyDamage(t, { id: c.id, part: 'legs', point: c.pos, t: 200 }, WEAPONS.ak47, 27);
  ok(c.hp < 100, 'the legs are not covered');
  c.hp = 100; t.pos = [0, 128, 2200];                // behind
  g.applyDamage(t, { id: c.id, part: 'chest', point: c.pos, t: 200 }, WEAPONS.ak47, 36);
  ok(c.hp < 100, 'from behind the shield does nothing');
}

console.log('swimming');
{
  const water = [{ y: 120, w: 400, d: 400, pos: [0, 0] }];
  const floor = [{ min: [-2000, -64, -2000], max: [2000, 0, 2000] }];
  const s = { pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0.8, onGround: true, crouching: false };
  for (let i = 0; i < 60; i++) movePlayer(s, { f: 1, b: 0, l: 0, r: 0, jump: 0, crouch: 0, walk: 0, maxSpeed: 250, water }, 1 / 60, floor);
  ok(s.pos[1] > 40, `looking up and swimming forward rises (y ${s.pos[1].toFixed(0)})`);
  const top = s.pos[1];
  for (let i = 0; i < 60; i++) movePlayer(s, { f: 0, b: 0, l: 0, r: 0, jump: 0, crouch: 0, walk: 0, maxSpeed: 250, water }, 1 / 60, floor);
  ok(s.pos[1] < top, 'with no input you sink');
  const sp = Math.hypot(...s.vel);
  ok(sp <= 250 * 0.8 + 1, 'swim speed is 0.8 x run speed at most');
}

console.log('drowning');
{
  const g = new Game('de_aq_dust', { practice: true });
  g.map = { ...g.map, water: [{ y: 400, w: 2000, d: 2000, pos: [0, 2000] }] };   // flood the T spawn
  const ws = sock();
  const p = g.addPlayer(ws, 'Diver', { team: TEAM.T });
  g.addPlayer(sock(), 'Other', { team: TEAM.CT });
  g.checkMode(); advance(g, ROUND.freezeTime + 0.2);
  p.pos = [0, 128, 2000]; g.resetMove(p);
  let seq = 0;
  for (let i = 0; i < 16 * 30; i++) { fake += 1000 / 30; g.onMessage(p, { t: 'cmd', c: [{ s: ++seq, dt: 1 / 30, k: 0, y: 0, p: -1.4 }] }); }
  ok(p.hp < 100 && ws.got('hit').some((m) => m.weapon === 'drown'), `12 s under water, then drowning (hp ${p.hp})`);
}

console.log(failures.length ? `\nextras: ${failures.length} FAILED` : '\nextras: all checks passed');
process.exit(failures.length ? 1 : 0);
