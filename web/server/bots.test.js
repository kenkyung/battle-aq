// M14 bot tactics: nav spots, team economy, plans, intel-driven rotation
// and saving.   node server/bots.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { Game } = await import('./game.js');
const { TEAM, ROUND } = await import('../shared/constants.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => ({ readyState: 1, send() {} });

const g = new Game('de_aq_dust', { practice: true });
g.addPlayer(sock(), 'Human', { team: TEAM.CT });
for (let i = 0; i < 4; i++) g.addBot(TEAM.T, 'hard');
for (let i = 0; i < 3; i++) g.addBot(TEAM.CT, 'hard');
g.checkMode();

console.log('nav spots');
const spots = g.nav.spots();
ok(spots.hiding.length > 10, `hiding spots found (${spots.hiding.length})`);
const A = g.map.bombsites.A;
const sn = g.nav.sniperSpot(A);
ok(sn && g.nav.visible([sn.x, sn.y + 60, sn.z], [A[0], A[1] + 40, A[2]]), 'a sniper spot with a clear line to A');

console.log('economy + plans');
const bots = (team) => [...g.players.values()].filter((p) => p.bot && p.team === team);
g.roundNumber = 1; g.tactics.newRound();
ok(g.tactics.plan(TEAM.T).economy === 'pistol', 'round 1 is a pistol round');
g.roundNumber = 3; g.lossStreak[TEAM.T] = 1;
for (const p of bots(TEAM.T)) p.money = 1200;
g.tactics.newRound();
ok(g.tactics.plan(TEAM.T).economy === 'eco', 'poor team after one loss: eco');
for (const p of bots(TEAM.T)) p.money = 6000;
g.tactics.newRound();
ok(g.tactics.plan(TEAM.T).economy === 'full', 'rich team: full buy');
for (const p of bots(TEAM.T)) p.money = 2000;
g.lossStreak[TEAM.T] = 3;
g.tactics.newRound();
ok(g.tactics.plan(TEAM.T).economy === 'force', 'third loss in a row: force buy');
const styles = new Set();
for (let i = 0; i < 40; i++) { g.tactics.newRound(); styles.add(g.tactics.plan(TEAM.T).style); }
ok(['rush', 'split', 'default'].every((x) => styles.has(x)), `T plans vary: ${[...styles].join(', ')}`);
const ct = g.tactics.plan(TEAM.CT);
ok(new Set(Object.values(ct.groups).map((s) => s && s[0])).size === 2, 'CT bots spread over both sites');

console.log('eco buying');
g.phase = 'freeze'; g.lossStreak[TEAM.T] = 1;
for (const p of bots(TEAM.T)) { p.money = 1200; p.inv.primary = null; }
g.tactics.newRound();
for (const p of bots(TEAM.T)) { p.bot.bought = false; p.pos = g.spawnSpots(TEAM.T)[0].slice(); p.bot.buy(); }
ok(bots(TEAM.T).every((p) => !p.inv.primary && p.money >= 900), 'on an eco round nobody buys a gun');

console.log('intel + rotation + save');
const now = fake / 1000;
g.tactics.report(TEAM.CT, [A[0] + 100, 0, A[2]], now);
g.tactics.report(TEAM.CT, [A[0] - 100, 0, A[2]], now + 0.5);
ok(g.tactics.hotSite(TEAM.CT, now + 1) === 'A', 'two sightings near A: A is hot');
const t = bots(TEAM.T)[0];
t.inv.primary = 'ak47';
for (const p of bots(TEAM.T).slice(1)) p.alive = false;
g.phase = 'round'; g.phaseEndsAt = now + 10;
ok(g.tactics.shouldSave(t, now), 'last T alive vs 4 with 10 s left: save the AK');

console.log(failures.length ? `\nbots: ${failures.length} FAILED` : '\nbots: all checks passed');
process.exit(failures.length ? 1 : 0);
