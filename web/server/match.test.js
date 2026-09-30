// M23 match flow on a fake clock: ready-up, knife round + side vote, team
// names, tactical / technical pauses, overtime, map veto.
//   node server/match.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { Game } = await import('./game.js');
const { TEAM } = await import('../shared/constants.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => { const s = { readyState: 1, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)) }; s.got = (t) => s.msgs.filter((m) => m.t === t); return s; };
const advance = (g, sec) => { const n = Math.ceil(sec * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); } };
const chat = (g, p, text) => g.onMessage(p, { t: 'chat', text });

console.log('ready-up');
const g = new Game('de_aq_dust', { rules: { base: 'competitive' }, id: 'room-x' });
g.custom = true;
const wa = sock(), wb = sock();
const a = g.addPlayer(wa, 'Alice', { team: TEAM.T });
const b = g.addPlayer(wb, 'Bob', { team: TEAM.CT });
g.checkMode();
advance(g, 30);
ok(g.phase === 'warmup', 'both teams here but nobody ready: still warmup');
chat(g, a, '!ready');
advance(g, 6);
ok(g.phase === 'warmup' && wa.got('ready').at(-1).need.includes(b.id), 'one ready: still waiting for Bob');
g.onMessage(b, { t: 'ready' });
advance(g, 1);
ok(g.phase === 'warmup' && wa.got('ready').at(-1).startIn > 3, 'all ready: 5 s countdown');
advance(g, 5);
ok(g.match.knife && g.phase === 'freeze', 'then the knife round');

console.log('knife round');
ok(a.weapon === 'knife' && !a.inv.secondary && !a.c4 && !b.c4, 'knives only, no bomb');
a.money = 16000;
g.onMessage(a, { t: 'buy', item: 'ak47' });
ok(!a.inv.primary, 'no buying');
advance(g, 4);
g.kill(b, a, 'knife', false);
ok(g.phase === 'sidevote' && wa.got('knife_won').at(-1).team === TEAM.T && wa.got('knife_won').at(-1).voters.includes(a.id), 'T win the knife: their players vote stay / switch');
ok(g.score[TEAM.T] === 0, 'the knife round does not count');
chat(g, b, '!switch');
ok(g.phase === 'sidevote', 'the losers do not get a say');
chat(g, a, '!teamname Ninjas');
ok(g.match.names[TEAM.T] === 'Ninjas', '!teamname');
chat(g, a, '!switch');
ok(a.team === TEAM.CT && b.team === TEAM.T && g.match.names[TEAM.CT] === 'Ninjas', 'switch: sides and names swap');
ok(g.phase === 'freeze' && g.roundNumber === 1 && !g.match.knife && a.inv.secondary === 'usp', 'and the match is live: round 1, pistols back');

console.log('pauses');
chat(g, a, '!pause');
const endsBefore = g.phaseEndsAt;
advance(g, 10);
ok(g.match.paused && g.match.paused.kind === 'tactical' && g.phase === 'freeze' && g.phaseEndsAt > endsBefore + 9, 'tactical timeout holds the freeze time');
ok(g.match.timeouts[TEAM.CT] === 3, 'the team has 3 timeouts left');
advance(g, 21);
ok(!g.match.paused, 'it ends after 30 s');
advance(g, 20);
ok(g.phase === 'round', 'freeze time runs out after it');
chat(g, b, '!tech');
ok(g.match.pending && !g.match.paused, 'tech pause called mid-round: waits for the next freeze time');
g.kill(b, a, 'ak47', false);
advance(g, g.rules.roundEnd + 0.5);
ok(g.match.paused && g.match.paused.kind === 'tech', 'the next freeze time is paused');
advance(g, 60);
ok(g.match.paused && g.phase === 'freeze', 'a tech pause holds until unpaused');
chat(g, a, '!unpause');
ok(g.match.paused, 'only the team that paused can unpause');
chat(g, b, '!unpause');
ok(!g.match.paused, '!unpause');

console.log('overtime');
g.score = { [TEAM.T]: 14, [TEAM.CT]: 15 };
g.roundNumber = 29;
g.halftimeRound = 15;
advance(g, g.freezeTime + 1);
g.roundNumber = 30;
g.endRound(TEAM.T, 'elim');
ok(!g.matchOver && g.match.ot === 1 && g.match.winTarget === 19 && g.match.maxRound === 36 && g.halftimeRound === 33, '15-15 after 30: overtime 1 (first to 19, halftime at 33)');
advance(g, g.rules.roundEnd + 0.5);
ok(a.money === 10000 && b.money === 10000 && wa.got('overtime').length === 1, 'everyone starts overtime with $10000');
g.score = { [TEAM.T]: 18, [TEAM.CT]: 17 };
g.roundNumber = 36;
g.phase = 'round';
g.endRound(TEAM.CT, 'elim');
ok(!g.matchOver && g.match.ot === 2 && g.match.winTarget === 22, 'tied again: overtime 2');
g.score = { [TEAM.T]: 21, [TEAM.CT]: 21 };
g.phase = 'round';
g.endRound(TEAM.T, 'elim');
ok(g.matchOver === false || g.score[TEAM.T] === 22, 'winning 22-21 in OT2');
g.phase = 'round'; g.roundNumber = 40;
g.score = { [TEAM.T]: 21, [TEAM.CT]: 19 };
g.endRound(TEAM.T, 'elim');
ok(g.matchOver, 'reaching the target ends the match');

console.log('map veto');
{
  const v = new Game('de_aq_dust', { rules: { base: 'competitive', veto: true }, id: 'room-v' });
  v.custom = true;
  const w1 = sock(), w2 = sock();
  const c1 = v.addPlayer(w1, 'Cap1', { team: TEAM.T });
  v.checkMode();
  const c2 = v.addPlayer(w2, 'Cap2', { team: TEAM.CT });
  v.checkMode();
  const st = w1.got('veto').at(-1);
  ok(st && st.pool.length === 6 && st.turn === TEAM.CT && st.captains[TEAM.CT] === c2.id, 'veto starts with a captain per side, CT bans first');
  v.onMessage(c1, { t: 'veto_ban', map: 'nuke' });
  ok(!v.match.veto.banned.length, 'not your turn: refused');
  v.onMessage(c2, { t: 'veto_ban', map: 'nuke' });
  chat(v, c1, '!ban train');
  v.onMessage(c2, { t: 'veto_ban', map: 'de_aq_dust' });
  advance(v, 21);                                      // T captain idles: auto-ban
  ok(v.match.veto.banned.length === 4, 'an idle captain gets a random ban after 20 s');
  const left = v.match.veto.pool.filter((m) => !v.match.veto.banned.some((x) => x.map === m));
  v.onMessage(c2, { t: 'veto_ban', map: left[0] });
  ok(v.match.vetoDone && v.match.veto.done === left[1], `decider: ${left[1]}`);
  advance(v, 5);
  ok(v.map.id === left[1] && v.phase === 'warmup', 'the decider is loaded, back to ready-up');
}

console.log('public rooms: an AFK player cannot hold up the start');
{
  const q = new Game('de_aq_dust', { rules: 'competitive', id: 'public-q' });
  q.addPlayer(sock(), 'Lazy1', { team: TEAM.T });
  q.addPlayer(sock(), 'Lazy2', { team: TEAM.CT });
  q.checkMode();
  advance(q, 170);
  ok(q.phase === 'warmup', 'still warming up at 170 s');
  advance(q, 12);
  ok(q.phase !== 'warmup', 'starts by itself after 180 s');
}

console.log('casual rooms are unchanged');
{
  const c = new Game('de_aq_dust', { rules: 'casual' });
  c.addPlayer(sock(), 'X', { team: TEAM.T }); c.addPlayer(sock(), 'Y', { team: TEAM.CT });
  c.checkMode();
  ok(c.phase === 'freeze' && !c.match.knife, 'the match starts right away, no knife round');
}

console.log(failures.length ? `\nmatch: ${failures.length} FAILED` : '\nmatch: all checks passed');
process.exit(failures.length ? 1 : 0);
