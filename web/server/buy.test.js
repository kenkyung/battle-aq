// CS 1.6 quick-buy binds on a fake clock: F1 autobuy, F2 rebuy, "," / "."
// ammo boxes at calibre prices.   node server/buy.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { Game } = await import('./game.js');
const { TEAM, ROUND, WEAPONS } = await import('../shared/constants.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => { const s = { readyState: 1, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)) }; s.last = (t) => s.msgs.filter((m) => m.t === t).at(-1); return s; };
const advance = (g, seconds) => { const n = Math.ceil(seconds * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); } };

const g = new Game('de_aq_dust', { practice: true });
const wsC = sock(), wsT = sock();
const c = g.addPlayer(wsC, 'Connie', { team: TEAM.CT });
const t = g.addPlayer(wsT, 'Terry', { team: TEAM.T });
g.checkMode();
advance(g, 0.5);   // freeze, in spawn

console.log('autobuy');
c.money = 5000;
g.onMessage(c, { t: 'autobuy' });
ok(c.inv.primary === 'm4a1', 'CT autobuy takes the M4A1 first');
ok(c.ammo.m4a1.reserve === WEAPONS.m4a1.reserve, 'primary ammo filled');
ok(c.kit && c.armor === 100, 'kit and armour when money allows');
ok(c.money === 5000 - 3100 - 200 - (c.helmet ? 1000 : 650), `money charged correctly ($${c.money} left)`);
t.money = 2600;
g.onMessage(t, { t: 'autobuy' });
ok(t.inv.primary === 'ak47', 'T autobuy takes the AK-47');
ok(!t.kit, 'no kit for terrorists');
t.money = 400; t.inv.primary = null; delete t.ammo.ak47;
g.onMessage(t, { t: 'autobuy' });
ok(!t.inv.primary && t.money <= 400, 'autobuy with no money buys what it can (nothing big)');

console.log('ammo boxes');
c.ammo.m4a1.reserve = 0;
const m0 = c.money = 1000;
g.onMessage(c, { t: 'buy', item: 'ammo1' });
ok(c.ammo.m4a1.reserve === 30 && c.money === m0 - 60, '"," buys one 5.56 box: 30 rounds for $60');
c.ammo.usp.reserve = 0;
g.onMessage(c, { t: 'buy', item: 'ammo2' });
ok(c.ammo.usp.reserve === 12 && c.money === m0 - 60 - 25, '"." buys one .45 box: 12 rounds for $25');

console.log('rebuy');
g.onMessage(c, { t: 'buy', item: 'flashbang' });
g.onMessage(c, { t: 'buy', item: 'flashbang' });
// next round: CT died, loadout gone
c.alive = false;
g.endRound(TEAM.T, 'elim');
advance(g, ROUND.roundEndTime + 0.3);
ok(g.phase === 'freeze' && !c.inv.primary, 'new round, the dead CT lost everything');
c.money = 8000;
g.onMessage(c, { t: 'rebuy' });
ok(c.inv.primary === 'm4a1' && c.kit && c.armor === 100 && c.nades.flashbang === 2, 'F2 rebuys M4A1, armour, kit and both flashbangs');
ok(c.ammo.m4a1.reserve === WEAPONS.m4a1.reserve, 'and fills the ammo');

console.log(failures.length ? `\nbuy: ${failures.length} FAILED` : '\nbuy: all checks passed');
process.exit(failures.length ? 1 : 0);
