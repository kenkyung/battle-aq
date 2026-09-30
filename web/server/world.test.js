// M15 world: doors (E toggles, collision moves, bots open them), breakable
// glass (bullets shatter it and carry on, restored next round), and the
// carved classic map.   node server/world.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { Game } = await import('./game.js');
const { TEAM, WEAPONS, ROUND } = await import('../shared/constants.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => { const s = { readyState: 1, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)) }; s.last = (t) => s.msgs.filter((m) => m.t === t).at(-1); return s; };
const advance = (g, seconds) => { const n = Math.ceil(seconds * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); } };

console.log('doors');
{
  const g = new Game('cs_aq_office', { practice: true });
  const ws = sock();
  const p = g.addPlayer(ws, 'Opener', { team: TEAM.CT });
  g.addPlayer(sock(), 'Other', { team: TEAM.T });
  g.checkMode(); advance(g, ROUND.freezeTime + 0.2);
  const door = g.colliders.find((c) => c.door === 'office4');
  const x0 = door.min[0];
  p.pos = [1008, 2, -470];
  g.onMessage(p, { t: 'defuse', on: true });
  ok(g.doorOpen.office4 && door.min[0] === x0 + 124 && ws.last('door')?.open, 'E next to the door slides it open (collision too)');
  advance(g, 0.7);
  g.onMessage(p, { t: 'defuse', on: true });
  ok(!g.doorOpen.office4 && door.min[0] === x0, 'E again closes it');
  // a bot walking through the doorway opens it
  const bot = g.addBot(TEAM.CT, 'normal') || [...g.players.values()].find((q) => q.bot);
  const b = [...g.players.values()].find((q) => q.bot);
  advance(g, 0.7);
  b.alive = true; b.pos = [1008, 2, -460]; b.bot.doorCheck = 0; advance(g, 0.4);
  ok(g.doorOpen.office4, 'a bot at the door opens it');
  void bot;
}

console.log('glass');
{
  const g = new Game('cs_aq_office', { practice: true });
  const wa = sock();
  const a = g.addPlayer(wa, 'Shooter', { team: TEAM.T });
  const c = g.addPlayer(sock(), 'Target', { team: TEAM.CT });
  g.checkMode(); advance(g, ROUND.freezeTime + 0.2);
  // shoot through the west lobby window at someone inside
  a.pos = [-800, 0, 700]; c.pos = [-800, 2, 250]; c.hp = 100; c.armor = 0;   // outside on the snow (y 0), the target on the carpet (y 2)
  a.weapon = 'deagle'; a.ammo.deagle = { mag: 7, reserve: 35 }; a.nextFire = 0;
  const eye = [a.pos[0], a.pos[1] + 53, a.pos[2]];
  const aim = [c.pos[0] - eye[0], c.pos[1] + 50 - eye[1], c.pos[2] - eye[2]]; const L = Math.hypot(...aim);
  g.onMessage(a, { t: 'fire', origin: eye, dir: aim.map((v) => v / L) });
  ok(g.glassBroken.has('lobbyW') && !g.colliders.some((x) => x.glass === 'lobbyW'), 'the bullet shatters the window');
  for (let i = 0; i < 3 && c.hp === 100; i++) { fake += 1500; a.nextFire = 0; g.onMessage(a, { t: 'fire', origin: eye, dir: aim.map((v) => v / L) }); }
  ok(c.hp < 100, `bullets reach the player behind it (${100 - c.hp})`);
  g.endRound(TEAM.T, 'elim'); advance(g, g.rules.roundEnd + 0.3);
  ok(!g.glassBroken.size && g.colliders.some((x) => x.glass === 'lobbyW'), 'the window is back next round');
}

console.log('carved map');
{
  const g = new Game('de_aq_dust2', { practice: true });
  ok(g.colliders.length < 300 && g.nav.path(g.map.spawns[TEAM.T][0], g.map.bombsites.A) && g.nav.path(g.map.spawns[TEAM.T][0], g.map.bombsites.B), 'de_aq_dust2: carved from areas, both sites reachable');
}

console.log(failures.length ? `\nworld: ${failures.length} FAILED` : '\nworld: all checks passed');
process.exit(failures.length ? 1 : 0);
