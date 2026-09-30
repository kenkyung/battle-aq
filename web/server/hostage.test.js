// Hostage rescue (cs_ maps) on a fake clock: use (E) a hostage, it follows
// the CT along the nav mesh, rescue pays out, killing one costs money, all
// rescued ends the round for CT, and time running out is a T win.
//   node server/hostage.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { Game } = await import('./game.js');
const { TEAM, ROUND } = await import('../shared/constants.js');
const { ECONOMY } = await import('../shared/economy.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => { const s = { readyState: 1, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)) }; s.got = (t) => s.msgs.filter((m) => m.t === t); s.last = (t) => s.got(t).at(-1); return s; };
const advance = (g, seconds, until) => { const n = Math.ceil(seconds * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); if (until && until()) return true; } return false; };

for (const mapId of ['cs_aq_office', 'cs_aq_assault', 'cs_aq_italy']) {
  console.log(mapId);
  const g = new Game(mapId, { practice: true });
  const wsT = sock(), wsC = sock();
  const t = g.addPlayer(wsT, 'Terry', { team: TEAM.T });
  const c = g.addPlayer(wsC, 'Connie', { team: TEAM.CT });
  g.checkMode();
  advance(g, ROUND.freezeTime + 0.1);
  ok(g.phase === 'round' && g.hostages.length === 4, 'round live with 4 hostages');
  ok(!t.c4 && ![...g.players.values()].some((p) => p.c4), 'no C4 on a hostage map');
  g.onMessage(c, { t: 'buy', item: 'kit' });
  ok(!c.kit, 'defuse kits are not sold');

  // take hostage 0
  const h = g.hostages[0];
  const m0 = c.money;
  c.pos = [h.pos[0] + 40, h.pos[1], h.pos[2]];
  g.onMessage(c, { t: 'defuse', on: true });
  ok(h.leader === c.id && c.money === m0 + ECONOMY.hostageUse, `E takes the hostage (+$${ECONOMY.hostageUse})`);
  ok(wsC.last('hostage')?.kind === 'follow', 'the CT is told it follows');

  // walk the CT to the rescue zone along the nav path; the hostage follows
  const zone = g.rescueZones()[0];
  const path = g.nav.path(c.pos, [zone[0], 0, zone[2]]);
  ok(!!path, 'a route from the hostage to the rescue zone exists');
  let i = 0;
  const walked = advance(g, 90, () => {
    const wp = path[Math.min(i, path.length - 1)];
    const dx = wp[0] - c.pos[0], dz = wp[2] - c.pos[2], d = Math.hypot(dx, dz);
    const step = 200 / 30;                            // a CT walking at 200 u/s
    if (d <= step) { c.pos = [wp[0], wp[1], wp[2]]; i++; } else c.pos = [c.pos[0] + dx / d * step, wp[1], c.pos[2] + dz / d * step];
    return h.rescued;
  });
  ok(walked && h.rescued, 'the hostage followed the CT into the rescue zone');
  ok(c.money >= m0 + ECONOMY.hostageUse + ECONOMY.hostageRescue - 1, `rescue pays the CT $${ECONOMY.hostageRescue}`);
  ok(wsT.got('hostage').some((m) => m.kind === 'rescued' && m.left === 3), 'everyone hears a hostage was rescued (3 left)');

  // a T shoots a hostage: dead hostage, T pays for it
  const mT = t.money;
  g.damageHostage(g.hostages[1], t, 500);
  ok(!g.hostages[1].alive && t.money === Math.max(0, mT + ECONOMY.hostageKill), 'killing a hostage costs $1500');
  ok(g.phase === 'round', 'the round goes on while hostages remain');

  // the other two reach the zone -> CT win by rescue
  for (const hh of g.hostages.slice(2)) { hh.pos = [zone[0], 0, zone[2]]; hh.leader = c.id; c.pos = [zone[0] + 30, 0, zone[2]]; }
  advance(g, 0.5);
  ok(g.phase === 'end' && wsC.last('round_end')?.how === 'rescue' && wsC.last('round_end')?.winner === TEAM.CT, 'all living hostages rescued: CT win');

  // next round: nobody rescues anything -> T win on time
  advance(g, ROUND.roundEndTime + ROUND.freezeTime + 0.5);
  ok(g.phase === 'round' && g.hostages.every((x) => x.alive && !x.rescued), 'hostages reset for the next round');
  c.pos = g.spawnSpots(TEAM.CT)[0].slice(); t.pos = g.spawnSpots(TEAM.T)[0].slice();
  advance(g, ROUND.roundTime + 1, () => g.phase === 'end');
  ok(wsT.last('round_end')?.how === 'time' && wsT.last('round_end')?.winner === TEAM.T, 'time runs out: T win');
}

console.log(failures.length ? `\nhostage: ${failures.length} FAILED` : '\nhostage: all checks passed');
process.exit(failures.length ? 1 : 0);
