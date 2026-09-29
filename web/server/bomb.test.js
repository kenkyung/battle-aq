// Bomb mode + round flow test on a fake clock (deterministic, instant):
// plant, defuse, detonation + blast, money, halftime side swap, match end,
// map vote and the map change.   node server/bomb.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = (fn) => 0; // warmup respawn timers are not used here

const { Game } = await import('./game.js');
const { TEAM, ROUND, WEAPONS } = await import('../shared/constants.js');
const { ECONOMY } = await import('../shared/economy.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => { const s = { readyState: 1, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)) }; s.got = (t) => s.msgs.filter((m) => m.t === t); s.last = (t) => s.got(t).at(-1); return s; };
const advance = (g, seconds) => { const n = Math.ceil(seconds * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); } };

const g = new Game('de_aq_dust', { practice: true });
const ws1 = sock(), ws2 = sock();
const t = g.addPlayer(ws1, 'Terry', { team: TEAM.T });
const c = g.addPlayer(ws2, 'Cathy', { team: TEAM.CT });
const site = g.map.bombsites.A;

console.log('round flow + plant');
ok(g.phase === 'freeze', 'match starts in freeze time');
ok(t.c4 && g.bomb.carrier === t.id, 'the only terrorist carries the C4');
ok(ws1.last('inv').inv.c4 === 'c4', 'carrier inventory shows the C4');
t.pos = [...site]; g.onMessage(t, { t: 'weapon', id: 'c4' }); g.onMessage(t, { t: 'plant', on: true });
ok(!g.planting.has(t.id), 'cannot plant during freeze time');
advance(g, ROUND.freezeTime + 0.1);
ok(g.phase === 'round', 'round goes live after freeze');
t.pos = [0, 0, 0];
g.onMessage(t, { t: 'plant', on: true });
ok(ws1.last('plant').state === 'no_site', 'planting outside a bombsite is refused');
t.pos = [...site];
g.onMessage(t, { t: 'plant', on: true });
ok(g.planting.has(t.id), 'planting starts in the bombsite');
advance(g, ROUND.plantTime * 0.5);
t.pos = [site[0] + 40, site[1], site[2]];
advance(g, 0.1);
ok(!g.planting.has(t.id), 'moving cancels the plant');
t.pos = [...site];
g.onMessage(t, { t: 'weapon', id: 'c4' });
g.onMessage(t, { t: 'plant', on: true });
advance(g, ROUND.plantTime + 0.1);
ok(g.phase === 'planted' && g.bomb.state === 'planted', 'bomb planted after 3 s');
ok(ws2.msgs.some((m) => m.t === 'bomb_event' && m.kind === 'planted'), 'CT is told the bomb is planted');
ok(ws1.msgs.some((m) => m.t === 'inv' && m.reason === 'bomb planted' && m.delta === ECONOMY.planterReward), 'planter gets $300');

console.log('defuse');
c.pos = [site[0] + 20, site[1], site[2]];
g.onMessage(c, { t: 'defuse', on: true });
ok(g.defusing.has(c.id), 'defuse starts next to the bomb');
advance(g, ROUND.defuseTime - 1);
ok(g.phase === 'planted', 'no defuse kit: still defusing after 9 s');
advance(g, 1.2);
const re1 = ws1.last('round_end');
ok(re1 && re1.winner === TEAM.CT && re1.how === 'defuse', 'CT wins by defusing');
const loss = ws1.msgs.filter((m) => m.t === 'inv' && m.reason === 'round loss').at(-1);
ok(loss && loss.delta === ECONOMY.lossBonus[0] + ECONOMY.plantBonus, 'terrorists get the plant bonus on a loss');

console.log('detonation');
advance(g, ROUND.roundEndTime + 0.2);
ok(g.phase === 'freeze' && g.roundNumber === 2, 'round 2 starts');
advance(g, ROUND.freezeTime + 0.1);
t.pos = [...site]; g.onMessage(t, { t: 'weapon', id: 'c4' }); g.onMessage(t, { t: 'plant', on: true });
advance(g, ROUND.plantTime + 0.1);
c.pos = [site[0] + 150, site[1], site[2]]; // stays in the blast radius
t.pos = [site[0] + 2500, 0, site[2]];
advance(g, ROUND.bombTime + 0.2);
const re2 = ws1.last('round_end');
ok(re2 && re2.winner === TEAM.T && re2.how === 'bomb', 'terrorists win when the bomb explodes');
ok(!c.alive, 'a CT standing next to the bomb dies in the blast');
ok(t.alive, 'a terrorist far away survives');

console.log('kit + halftime');
advance(g, ROUND.roundEndTime + ROUND.freezeTime + 0.3);
c.pos = [...g.spawnSpots(TEAM.CT)[0]];
c.money = 5000;
g.onMessage(c, { t: 'buy', item: 'kit' });
ok(c.kit && ws2.last('inv').kit, 'CT can buy a defuse kit');
g.onMessage(t, { t: 'buy', item: 'kit' });
ok(!t.kit, 'terrorists cannot buy a defuse kit');
g.roundNumber = ROUND.halftimeAfter;
const scoreBefore = { ...g.score };
g.endRound(TEAM.T, 'elim');
advance(g, ROUND.roundEndTime + 0.2);
ok(t.team === TEAM.CT && c.team === TEAM.T, 'teams swap sides at halftime');
ok(ws1.got('halftime').length === 1 && ws1.last('team').team === TEAM.CT, 'players are told about the swap');
ok(g.score[TEAM.CT] === scoreBefore[TEAM.T] + 1, 'each group keeps its score across the swap');
ok(t.money === ECONOMY.startMoney && c.money === ECONOMY.startMoney, 'money resets at halftime');
ok(c.c4, 'the new terrorist gets the C4');

console.log('match end + vote');
advance(g, ROUND.freezeTime + 0.1);
g.score[TEAM.T] = ROUND.roundsToWin - 1;
g.endRound(TEAM.T, 'elim');
advance(g, ROUND.roundEndTime + 0.2);
ok(g.phase === 'matchend' && ws1.got('match_end').length === 1, 'match ends at 8 rounds, vote opens');
g.onMessage(t, { t: 'vote', map: 'de_aq_aztec' });
g.onMessage(c, { t: 'vote', map: 'de_aq_aztec' });
ok(ws2.last('votes').tally.de_aq_aztec === 2, 'votes are tallied and broadcast');
advance(g, ROUND.voteTime + 0.2);
ok(g.map.id === 'de_aq_aztec' && ws1.last('map').mapId === 'de_aq_aztec', 'the voted map loads');
ok(g.phase === 'freeze' && g.roundNumber === 1 && g.score[TEAM.T] === 0, 'a fresh match starts on the new map');

console.log('bots');
const p2 = new Game('de_aq_inferno', { practice: true });
const ws3 = sock();
p2.addPlayer(ws3, 'Solo', { team: TEAM.CT });
for (let i = 0; i < 5; i++) p2.addBot(i % 2 ? TEAM.CT : TEAM.T, 'hard');
p2.checkMode();
ok(p2.phase === 'freeze' && [...p2.players.values()].filter((p) => p.bot).length === 5, 'practice room: human + 5 bots, match started');
// farthest each bot got from its spawn (a round can end and respawn them)
const far = new Map();
for (let s = 0; s < 60; s++) {
  advance(p2, 1);
  for (const p of p2.players.values()) if (p.bot) far.set(p.id, Math.max(far.get(p.id) || 0, Math.hypot(p.pos[0] - p2.spawnSpots(p.team)[0][0], p.pos[2] - p2.spawnSpots(p.team)[0][2])));
}
const moved = [...far.values()].filter((d) => d > 300).length;
ok(moved >= 3, `bots leave spawn (${moved}/5 are over 300 u away after a minute)`);
ok([...p2.players.values()].some((p) => p.bot && (p.money < 800 || p.armor > 0)), 'bots spend their pistol-round money');

console.log(failures.length ? `\nbomb: ${failures.length} FAILED` : '\nbomb: all checks passed');
process.exit(failures.length ? 1 : 0);
