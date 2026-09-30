// fy_ maps (M20) on a fake clock: floor guns each round, no buying, short
// freeze, bots fetch guns and fight, deathmatch respawns taken guns.
//   node server/fy.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { Game } = await import('./game.js');
const { TEAM } = await import('../shared/constants.js');
const { MAPS } = await import('../shared/maps.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => { const s = { readyState: 1, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)) }; s.got = (t) => s.msgs.filter((m) => m.t === t); return s; };
const advance = (g, sec) => { const n = Math.ceil(sec * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); } };

for (const id of ['fy_pool_day2', 'fy_snow', 'fy_aq_rooftops']) {
  console.log(id);
  const g = new Game(id, { practice: true });
  const ws = sock();
  const p = g.addPlayer(ws, 'Me', { team: TEAM.T });
  g.addPlayer(sock(), 'You', { team: TEAM.CT });
  g.checkMode();
  const n = MAPS[id].floorWeapons.length;
  ok(g.drops.filter((d) => d.spot !== undefined).length === n, `${n} guns on the floor at round start`);
  ok(g.drops.every((d) => d.pos[1] >= -1 && d.pos[1] < 300), 'every gun rests on a surface');
  ok(g.freezeTime <= 3 && g.roundTime <= 105, 'short freeze and rounds');
  p.money = 16000;
  g.onMessage(p, { t: 'buy', item: 'ak47' });
  ok(!p.inv.primary && /fy_/.test((ws.got('buy_fail').at(-1) || ws.got('notice').at(-1) || {}).reason || JSON.stringify(ws.msgs.slice(-3))), 'buying is refused');
  // walk onto a T-side rifle: it is picked up
  const d = g.drops.find((q) => q.weapon === 'ak47');
  p.pos = [...d.pos];
  advance(g, 0.1);
  ok(p.inv.primary === 'ak47', 'walking over a floor gun picks it up');
}

console.log('bots arm themselves on fy_snow');
{
  const g = new Game('fy_snow', { practice: true });
  g.addPlayer(sock(), 'Watcher', { team: TEAM.T });
  const bots = [g.addBot(TEAM.T, 'normal'), g.addBot(TEAM.CT, 'normal'), g.addBot(TEAM.CT, 'normal')];
  g.checkMode();
  advance(g, 20);
  const armed = bots.filter((b) => b.inv.primary).length;
  ok(armed >= 2, `${armed}/3 bots picked up a primary within 20 s`);
}

console.log('deathmatch on fy_aq_rooftops: taken guns come back');
{
  const g = new Game('fy_aq_rooftops', { practice: true, rules: 'deathmatch' });
  const p = g.addPlayer(sock(), 'DM', { team: TEAM.T });
  g.addPlayer(sock(), 'DM2', { team: TEAM.CT });
  g.checkMode();
  advance(g, 1);
  const d = g.drops.find((q) => q.weapon === 'awp');
  ok(!!d, 'the AWP is on the middle roof');
  p.inv.primary = null; p.pos = [...d.pos];
  advance(g, 0.2);
  ok(p.inv.primary === 'awp' && !g.drops.some((q) => q.spot === d.spot), 'picked up');
  p.pos = [0, 0, 1300];
  advance(g, 22);
  ok(g.drops.some((q) => q.spot === d.spot), 'it respawns after 20 s');
}

console.log(failures.length ? `\nfy: ${failures.length} FAILED` : '\nfy: all checks passed');
process.exit(failures.length ? 1 : 0);
