// Latency / disconnect handling: resume after a drop, lag bursts, backpressure.
//   node server/netcode2.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { Game } = await import('./game.js');
const { TEAM, ROUND, WEAPONS } = await import('../shared/constants.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => { const s = { readyState: 1, bufferedAmount: 0, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)), ping() {}, close() {} }; s.got = (t) => s.msgs.filter((m) => m.t === t); return s; };
const advance = (g, sec) => { const n = Math.ceil(sec * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); } };

console.log('resume after a dropped connection');
{
  const g = new Game('de_aq_dust', { rules: 'casual' });
  const w1 = sock();
  const p = g.addPlayer(w1, 'Dropper', { team: TEAM.CT });
  const other = g.addPlayer(sock(), 'Other', { team: TEAM.T });
  g.checkMode();
  advance(g, ROUND.freezeTime + 0.5);
  const tok = w1.got('welcome')[0].token;
  ok(typeof tok === 'string' && tok.length >= 16 && w1.got('welcome')[0].room === g.id, 'welcome carries a resume token + room');
  p.money = 5000; p.inv.primary = 'm4a1'; p.ammo.m4a1 = { mag: 30, reserve: 90 }; p.kills = 7;
  g.detach(p);
  ok(g.players.has(p.id) && !p.alive && p.dc, 'dropped: kept, out of the round');
  const snap = g.snapshotFor(other);
  const e = snap.players.find((q) => q.id === p.id);
  ok(e.dc === 1 && e.hid === 1 && !e.pos, 'others see it as disconnected (no body to shoot)');
  ok(!g.findResumable('nope') && g.findResumable(tok) === p, 'only the right token resumes');
  // the round ends and a new one starts while it is away
  g.endRound(TEAM.T, 'elim');
  advance(g, g.rules.roundEnd + 0.5);
  ok(!p.alive && p.inv.primary === 'm4a1', 'a new round starts without it, its M4 kept');
  const w2 = sock();
  g.resume(p, w2);
  ok(!p.dc && p.ws === w2 && w2.got('welcome').length === 1 && w2.got('welcome')[0].id === p.id, 'resumed: same player id, fresh welcome');
  const inv = w2.got('inv').at(-1);
  ok(inv.money >= 5000 && inv.inv.primary === 'm4a1' && p.kills === 7, 'money, weapons and score are all still there');
  g.endRound(TEAM.T, 'elim');
  advance(g, g.rules.roundEnd + 0.5);
  ok(p.alive && p.inv.primary === 'm4a1', 'and it plays the next round with its gun');
}

console.log('lag burst');
{
  const g = new Game('de_aq_dust', { practice: true });
  const p = g.addPlayer(sock(), 'Laggy', { team: TEAM.T });
  g.checkMode();
  advance(g, ROUND.freezeTime + 0.5);
  let seq = 0;
  const cmd = () => ({ s: ++seq, dt: 1 / 60, k: 1, y: 0, p: 0 });
  g.onMessage(p, { t: 'cmd', c: [cmd()] });
  fake += 800;                                   // 0.8 s stall, then everything at once
  const before = p.pos.slice();
  g.onMessage(p, { t: 'cmd', c: Array.from({ length: 48 }, cmd) });
  ok(p.lastSeq === seq, 'a 0.8 s burst of queued commands is all accepted (no rubber band)');
  ok(Math.hypot(p.pos[0] - before[0], p.pos[2] - before[2]) > 100, 'and the movement happens');
  g.onMessage(p, { t: 'cmd', c: Array.from({ length: 64 }, cmd) });
  ok(p.lastSeq < seq, 'more than real time is still refused (speedhack guard)');
}

console.log('backpressure');
{
  const g = new Game('de_aq_dust', { practice: true });
  const w = sock();
  const p = g.addPlayer(w, 'Slow', { team: TEAM.T });
  g.checkMode();
  w.msgs.length = 0;
  w.bufferedAmount = 200 * 1024;
  g.broadcastSnapshots();
  ok(!w.got('state').length && p.choked === 1, 'a backed-up client is skipped');
  w.bufferedAmount = 0;
  g.broadcastSnapshots();
  ok(w.got('state').length === 1, 'and gets the next snapshot once it drains');
}

console.log(failures.length ? `\nnetcode2: ${failures.length} FAILED` : '\nnetcode2: all checks passed');
process.exit(failures.length ? 1 : 0);
