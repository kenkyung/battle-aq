// Headless bot-vs-bot match on a fake clock: plays N minutes of game time in
// a few seconds and reports what happened. Used to sanity-check the bot AI
// and the round/bomb rules.   node server/sim.js [map] [minutes] [difficulty]

let fake = 1_000_000;
Date.now = () => fake;
const realSetTimeout = setTimeout;
const timers = [];
globalThis.setTimeout = (fn, ms) => { timers.push([fake + ms, fn]); return 0; };

const { Game } = await import('./game.js');
const { TEAM, TICK_RATE } = await import('../shared/constants.js');

const [map = 'de_aq_dust', minutes = '8', diff = 'normal'] = process.argv.slice(2);
const g = new Game(map, { practice: true, id: 'sim' });
{ const use = g.useHostage.bind(g); g.useHostage = (p) => { const r = use(p); if (r) events.uses = (events.uses || 0) + 1; return r; }; }
{ const nr = g.tactics.newRound.bind(g.tactics); g.tactics.newRound = () => { nr(); for (const t of [1, 2]) { const pl = g.tactics.plan(t); if (pl) { const k = (t === 1 ? 'T:' : 'CT:') + pl.economy + (t === 1 ? '/' + pl.style : ''); events.plans = { ...(events.plans || {}), [k]: ((events.plans || {})[k] || 0) + 1 }; } } }; }
const events = { kills: 0, headshots: 0, plants: 0, defuses: 0, explosions: 0, rounds: [], halftime: 0, matchEnd: null, byWeapon: {} };
const orig = g.broadcast.bind(g);
g.broadcast = (obj, ex) => {
  if (obj.t === 'kill') { events.kills++; if (obj.headshot) events.headshots++; events.byWeapon[obj.weapon] = (events.byWeapon[obj.weapon] || 0) + 1; }
  if (obj.t === 'bomb_event') { if (obj.kind === 'planted') events.plants++; if (obj.kind === 'defused') events.defuses++; if (obj.kind === 'exploded') events.explosions++; }
  if (obj.t === 'hostage' && ['rescued', 'killed'].includes(obj.kind)) events[obj.kind] = (events[obj.kind] || 0) + 1;
  if (obj.t === 'hostage' && obj.kind === 'follow') events.follows = (events.follows || 0) + 1;
  if (obj.t === 'round_end') {
    let note = '';
    if (obj.how === 'time') {
      const c = g.players.get(g.bomb.carrier);
      const sites = Object.values(g.map.bombsites);
      if (c) note = `/carrier ${c.alive ? 'alive' : 'dead'} site-dist ${Math.round(Math.min(...sites.map((s) => Math.hypot(c.pos[0] - s[0], c.pos[2] - s[2]))))} at ${c.pos.map(Math.round)} wp ${c.bot && c.bot.path && JSON.stringify(c.bot.path[c.bot.pathIdx])} goal ${c.bot && c.bot.goal && c.bot.goal.key} target ${c.bot && c.bot.target ? 'y' : 'n'}`;
      else note = `/bomb ${g.bomb.state}`;
    }
    if (obj.how === 'bomb') {
      const b = g.bomb.pos;
      note = '/CT ' + [...g.players.values()].filter((q) => q.team === TEAM.CT).map((q) => `${q.alive ? 'A' : 'd'}${Math.round(Math.hypot(q.pos[0] - b[0], q.pos[2] - b[2]))}${q.bot.goal ? ':' + q.bot.goal.key.split('@')[0] : ''}`).join(' ');
    }
    events.rounds.push(`${obj.winner === TEAM.T ? 'T' : 'CT'}:${obj.how}${note}`);
  }
  if (obj.t === 'halftime') events.halftime++;
  if (obj.t === 'nade') events.nades = (events.nades || 0) + 1;
  if (obj.t === 'nade_boom') events.booms = { ...(events.booms || {}), [obj.kind]: ((events.booms || {})[obj.kind] || 0) + 1 };
  if (obj.t === 'match_end') events.matchEnd = `${obj.scoreT}-${obj.scoreCT}`;
  orig(obj, ex);
};
for (let i = 0; i < 10; i++) g.addBot(i % 2 ? TEAM.CT : TEAM.T, diff);
g.checkMode();

const stuck = new Map();
const t0 = process.hrtime.bigint();
const steps = Number(minutes) * 60 * TICK_RATE;
for (let i = 0; i < steps; i++) {
  fake += 1000 / TICK_RATE;
  for (let k = timers.length - 1; k >= 0; k--) if (timers[k][0] <= fake) { const [, fn] = timers.splice(k, 1)[0]; fn(); }
  g.update();
  if (process.env.TRACE && i % TICK_RATE === 0 && g.phase === 'round') {
    const c = g.players.get(g.bomb.carrier);
    if (c && c.bot && process.env.TRACE === '2') {
      const { playerBox, aabbOverlap } = await import('../shared/physics.js');
      const pb = playerBox([c.pos[0] + 4, c.pos[1] + 1, c.pos[2] + 2], c.crouching);
      const { movePlayer } = await import('../shared/physics.js');
      const cp = JSON.parse(JSON.stringify(c.bot.state));
      movePlayer(cp, { f: true }, 1 / 30, g.colliders);
      console.log('  copy-move ->', cp.pos.map((v) => +v.toFixed(2)), 'orig', c.bot.state.pos.map((v) => +v.toFixed(3)), 'vel', cp.vel.map(Math.round));
      console.log('  overlaps', g.colliders.filter((k) => aabbOverlap(pb, k)).map((k) => k.mat + JSON.stringify([k.min.map(Math.round), k.max.map(Math.round)])).join(' | '), 'crouch', c.crouching, 'state===p.pos', c.bot.state.pos === c.pos, 'pos===path0', c.bot.path && c.bot.path.some((w) => w === c.pos), 'pos===goal', c.bot.goal && c.bot.goal.pos === c.pos, 'lastSeen', c.bot.lastSeen === c.pos);
    }
    if (c && c.bot && process.env.TRACE === '3') {
      const near = [...g.players.values()].filter((q) => q !== c && q.alive && Math.hypot(q.pos[0] - c.pos[0], q.pos[2] - c.pos[2]) < 120).map((q) => `${q.name}/${q.team === c.team ? 'mate' : 'ENEMY'}@${q.pos.map(Math.round)}`);
      { const { movePlayer } = await import('../shared/physics.js'); const cp = JSON.parse(JSON.stringify(c.bot.state)); cp.pos = c.pos.slice();
        const before = cp.pos.slice(); movePlayer(cp, { f: true, maxSpeed: 250 }, 1 / 30, g.colliders);
        console.log('  state', JSON.stringify({ pos: before.map((v) => +v.toFixed(2)), vel: c.bot.state.vel.map(Math.round), onG: c.bot.state.onGround, crouch: c.bot.state.crouching, jumpHeld: c.bot.state.jumpHeld, fat: +(c.bot.state.fatigue || 0).toFixed(2) }), '-> f-move', cp.pos.map((v) => +v.toFixed(2))); }
      console.log('  near:', near.join(' '), 'target', c.bot.target && c.bot.target.name, 'unstick', !!c.bot.unstickUntil);
    }
    if (c && c.bot) console.log(Math.round(i / TICK_RATE), 'carrier', c.pos.map(Math.round), 'yaw', c.bot.state.yaw.toFixed(2), 'vel', c.bot.state.vel.map(Math.round), 'goal', c.bot.goal && c.bot.goal.key, 'wp', JSON.stringify(c.bot.path && c.bot.path[c.bot.pathIdx]), 'idx', c.bot.pathIdx, '/', c.bot.path && c.bot.path.length, 'weapon', c.weapon, 'planting', g.planting.has(c.id));
  }
  if (i % (TICK_RATE * 10) === 0 && g.phase === 'round') {
    for (const p of g.players.values()) {
      if (!p.alive) continue;
      const prev = stuck.get(p.id);
      const moved = prev ? Math.hypot(p.pos[0] - prev[0], p.pos[2] - prev[2]) : 999;
      stuck.set(p.id, p.pos.slice());
      if (moved < 30) events.stuckSamples = (events.stuckSamples || 0) + 1;
    }
  }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(JSON.stringify({ astar: g.nav.calls, map, minutes: Number(minutes), diff, cpuMs: Math.round(ms), msPerTick: +(ms / steps).toFixed(3), phase: g.phase, round: g.roundNumber, score: `${g.score[TEAM.T]}-${g.score[TEAM.CT]}`, ...events }, null, 0));
