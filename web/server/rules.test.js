// M10 rules + economy parity on a fake clock: competitive (MR15) timings,
// friendly fire at 35 %, team-kill penalty, cstrike round rewards and the
// loss bonus ladder.   node server/rules.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { Game } = await import('./game.js');
const { TEAM, WEAPONS } = await import('../shared/constants.js');
const { ECONOMY, lossBonus } = await import('../shared/economy.js');
const { RULES } = await import('../shared/rules.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => { const s = { readyState: 1, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)) }; s.got = (t) => s.msgs.filter((m) => m.t === t); s.last = (t) => s.got(t).at(-1); return s; };
const advance = (g, seconds) => { const n = Math.ceil(seconds * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); } };

console.log('economy table');
ok([1, 2, 3, 4, 5].map(lossBonus).join() === '1400,2000,2500,3000,3000', 'loss bonus 1400 -> 2000 -> 2500 -> 3000 (cap)');
ok(ECONOMY.killReward === 300 && ECONOMY.knifeKillReward === 300, 'every kill pays $300 (knife too)');
ok(ECONOMY.winBonus === 3000 && ECONOMY.winBonusBomb === 3500 && ECONOMY.winBonusDefuse === 3250 && ECONOMY.winBonusTime === 3250, 'win: elim 3000, bomb 3500, defuse 3250, time 3250');

console.log('competitive room');
const g = new Game('de_aq_dust', { practice: true, rules: 'competitive' });
const w1 = sock(), w2 = sock(), w3 = sock();
const t1 = g.addPlayer(w1, 'T1', { team: TEAM.T });
const t2 = g.addPlayer(w2, 'T2', { team: TEAM.T });
const c1 = g.addPlayer(w3, 'C1', { team: TEAM.CT });
g.checkMode();
const r = w1.last('round');
ok(r.phase === 'freeze' && Math.round(r.timer) === 15 && r.maxRounds === 30 && r.winlimit === 16 && r.friendlyfire, 'MR15: 15 s freeze, 30 rounds, first to 16, friendly fire');
advance(g, 15.2);
ok(g.phase === 'round' && Math.round(g.phaseEndsAt - fake / 1000) === 105, 'round time 1:45');
// friendly fire
t2.hp = 100; t2.armor = 0;
g.applyDamage(t1, { id: t2.id, part: 'chest', point: t2.pos, t: 10 }, WEAPONS.ak47, 36);
ok(t2.hp === 100 - Math.round(36 * 0.35), `team damage is 35 % (${100 - t2.hp} of 36)`);
ok(w3.got('hit').some((m) => m.team), 'hit marked as a team attack');
const m0 = t1.money;
t2.hp = 1; g.applyDamage(t1, { id: t2.id, part: 'chest', point: t2.pos, t: 10 }, WEAPONS.ak47, 50);
ok(!t2.alive && t1.money === Math.max(0, m0 - 3300) && t1.kills === -1, `team kill: -$3300 and -1 frag (money ${t1.money}, kills ${t1.kills})`);
// the clock runs out on a bomb map: CT $3250, T loss bonus
const cm = c1.money, tm = t1.money;
advance(g, 106);
const re = w3.last('round_end');
ok(re && re.how === 'time' && re.winner === TEAM.CT, 'time runs out: CT win');
ok(c1.money === Math.min(16000, cm + 3250) && t1.money === tm + 1400, `CT +$3250, T +$1400 (${c1.money - cm} / ${t1.money - tm})`);

console.log('casual room');
const h = new Game('de_aq_dust', { practice: true });
ok(h.rules === RULES.casual && !h.rules.friendlyfire && h.rules.winlimit === 8, 'casual: no friendly fire, first to 8');

console.log(failures.length ? `\nrules: ${failures.length} FAILED` : '\nrules: all checks passed');
process.exit(failures.length ? 1 : 0);
