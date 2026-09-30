// M16 modes on a fake clock: deathmatch (respawns, free buying, frag score,
// time limit) and VIP (escape, assassination, the VIP's loadout).
//   node server/modes.test.js

let fake = 1_000_000;
Date.now = () => fake;
const timers = [];
globalThis.setTimeout = (fn, ms) => { timers.push([fake + ms, fn]); return 0; };
const runTimers = () => { for (let i = timers.length - 1; i >= 0; i--) if (timers[i][0] <= fake) { const [, fn] = timers.splice(i, 1)[0]; fn(); } };

const { Game } = await import('./game.js');
const { TEAM, WEAPONS } = await import('../shared/constants.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => { const s = { readyState: 1, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)) }; s.last = (t) => s.msgs.filter((m) => m.t === t).at(-1); return s; };
const advance = (g, sec) => { const n = Math.ceil(sec * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); runTimers(); } };

console.log('deathmatch');
{
  const g = new Game('de_aq_dust', { practice: true, rules: 'deathmatch' });
  const wa = sock();
  const a = g.addPlayer(wa, 'A', { team: TEAM.T });
  const b = g.addPlayer(sock(), 'B', { team: TEAM.CT });
  g.checkMode();
  ok(g.phase === 'dm' && a.alive && b.alive && a.money === 16000, 'match starts straight into deathmatch, $16000');
  g.onMessage(a, { t: 'buy', item: 'ak47' });
  ok(a.inv.primary === 'ak47', 'buy anywhere, any time');
  b.hp = 1; g.applyDamage(a, { id: b.id, part: 'chest', point: b.pos, t: 10 }, WEAPONS.ak47, 50);
  ok(!b.alive && g.score[TEAM.T] === 1, 'a kill scores for the team');
  advance(g, 2.2);
  ok(b.alive && g.phase === 'dm', 'the dead respawn after 2 s, the round goes on');
  g.phaseEndsAt = fake / 1000;
  advance(g, 0.1);
  ok(g.phase === 'matchend', 'time limit: match over, map vote');
}

console.log('vip');
{
  const g = new Game('de_aq_dust2', { practice: true, rules: 'vip' });
  const wt = sock(), wc = sock();
  const t = g.addPlayer(wt, 'T', { team: TEAM.T });
  const c = g.addPlayer(wc, 'VIP', { team: TEAM.CT });
  g.checkMode();
  ok(c.vip && c.armor === 200 && !c.inv.primary && c.weapon === 'usp' && !t.c4, 'a CT is the VIP: USP, 200 armour; no bomb');
  c.money = 5000; g.onMessage(c, { t: 'buy', item: 'm4a1' });
  ok(!c.inv.primary, 'the VIP cannot buy');
  advance(g, g.rules.freezetime + 0.2);
  const z = g.vipEscape();
  c.pos = [z[0], z[1], z[2]];
  advance(g, 0.1);
  ok(wc.last('round_end')?.how === 'escape' && wc.last('round_end')?.winner === TEAM.CT, 'the VIP reaches the escape zone: CT win');
  advance(g, g.rules.roundEnd + g.rules.freezetime + 0.3);
  const v = [...g.players.values()].find((p) => p.vip);
  const m0 = t.money;
  v.hp = 1; g.applyDamage(t, { id: v.id, part: 'chest', point: v.pos, t: 10 }, WEAPONS.ak47, 50);
  ok(wt.last('round_end')?.how === 'vip' && wt.last('round_end')?.winner === TEAM.T && t.money >= Math.min(16000, m0 + 2500), 'VIP killed: T win, the killer gets $2500');
}

console.log(failures.length ? `\nmodes: ${failures.length} FAILED` : '\nmodes: all checks passed');
process.exit(failures.length ? 1 : 0);
