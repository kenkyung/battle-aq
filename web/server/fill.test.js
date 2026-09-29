// Public rooms fill with bots: 5v5 by default, a human replaces a bot, an
// empty room has none.   node server/fill.test.js
let fake = 3_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;
const { Game } = await import('./game.js');
const { TEAM } = await import('../shared/constants.js');
const failures = [];
const ok = (c, l) => { if (c) console.log(`  ok   ${l}`); else { failures.push(l); console.log(`  FAIL ${l}`); } };
const sock = () => ({ readyState: 1, send() {} });
const count = (g, team, bot) => [...g.players.values()].filter((p) => p.team === team && !!p.bot === bot).length;

const g = new Game('de_aq_dust', { fillTo: 5 });
ok(g.players.size === 0, 'an empty room has no bots');
const a = g.addPlayer(sock(), 'Ann');
ok(count(g, TEAM.T, false) + count(g, TEAM.T, true) === 5 && count(g, TEAM.CT, true) === 5, 'one human -> 5 v 5 with bots');
ok(g.phase !== 'warmup', 'the match starts straight away');
const b = g.addPlayer(sock(), 'Ben');
ok(b.team !== a.team, 'second human goes to the other side');
ok(count(g, TEAM.T, false) + count(g, TEAM.T, true) === 5 && count(g, TEAM.CT, false) + count(g, TEAM.CT, true) === 5, 'still 5 v 5: a bot made room');
g.removePlayer(a.id);
ok(count(g, a.team, true) + count(g, a.team, false) === 5, 'a leaving human is replaced by a bot');
g.removePlayer(b.id);
ok(g.players.size === 0, 'everyone gone -> bots gone');
const s = new Game('de_aq_dust', { fillTo: 3 });
s.addPlayer(sock(), 'Cy');
ok(s.players.size === 6, '3 v 3 setting');
console.log(failures.length ? `\nfill: ${failures.length} FAILED` : '\nfill: all checks passed');
process.exit(failures.length ? 1 : 0);
