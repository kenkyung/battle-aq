// M2 integration test: money, buy menu rules, ammo + reload, armour, round
// economy. Boots the real server and drives it with two WebSocket clients.
// Run: node server/m2.test.js  (exits 1 on the first failure)

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEAPONS, TEAM } from '../shared/constants.js';
import { ECONOMY } from '../shared/economy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18932;
const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { for (let t = 0; t < ms; t += 50) { if (fn()) return true; await sleep(50); } return false; };

function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, name, id: null, team: 0, pos: null, inv: null, ammo: null, msgs: [], last: {} };
  c.send = (o) => ws.send(JSON.stringify(o));
  c.got = (t) => c.msgs.filter((m) => m.t === t);
  ws.onopen = () => c.send({ t: 'join', name, size: 0 });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    c.msgs.push(m); c.last[m.t] = m;
    if (m.t === 'welcome') { c.id = m.id; c.team = m.you.team; c.pos = m.you.pos; }
    if (m.t === 'respawn') c.pos = m.pos;
    if (m.t === 'inv') c.inv = m;
    if (m.t === 'ammo') c.ammo = m;
  };
  // positions jump around the map here: the test-only teleport (BAQ_DEV) sets them
  c.state = () => { c.send({ t: 'dev_tp', pos: c.pos }); c.send({ t: 'state', pos: c.pos, yaw: 0, pitch: 0, crouching: false, moving: false }); };
  c.timer = setInterval(() => { if (c.pos) c.state(); }, 50);
  return c;
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'index.js'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'pipe', env: { ...process.env, BAQ_DEV: '1' } });
  let booted = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('battle-aq web server')) booted = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await until(() => booted, 5000);
  const clients = [];
  try {
    console.log('warmup (one player)');
    const a = client('Alpha'); clients.push(a);
    await until(() => a.inv);
    ok(a.last.welcome.round.phase === 'warmup', 'solo player lands in warmup');
    ok(a.inv.money === ECONOMY.warmupMoney, 'warmup money is $16000');
    ok(a.inv.inv.secondary === 'glock' && a.inv.inv.primary === null && a.inv.inv.melee === 'knife', 'T spawns with knife + Glock');
    a.pos = [0, 0, 0]; await sleep(150); // far from spawn: warmup buys anywhere
    a.send({ t: 'buy', item: 'ak47' });
    await until(() => a.inv.inv.primary === 'ak47');
    ok(a.inv.inv.primary === 'ak47' && a.inv.weapon === 'ak47', 'warmup: bought AK-47 away from spawn');
    ok(a.inv.money === ECONOMY.warmupMoney - WEAPONS.ak47.price, 'AK-47 price deducted');
    a.send({ t: 'buy', item: 'm4a1' });
    await until(() => a.last.buy_fail);
    ok(a.last.buy_fail && /team/.test(a.last.buy_fail.reason), 'T cannot buy the M4A1');

    console.log('match start (second player)');
    const b = client('Beta'); clients.push(b);
    await until(() => b.inv && a.got('match_start').length);
    ok(a.got('match_start').length === 1, 'match starts when both teams have a player');
    ok(b.team === TEAM.CT && b.inv.inv.secondary === 'usp', 'second player is CT with a USP');
    await until(() => a.inv.money === ECONOMY.startMoney);
    ok(a.inv.money === ECONOMY.startMoney && b.inv.money === ECONOMY.startMoney, 'money reset to $800');
    ok(a.inv.inv.primary === null, 'warmup purchases are cleared at match start');
    ok(a.last.round.phase === 'freeze', 'round 1 opens with freeze time');

    console.log('buy zone + armour');
    // b stays at its spawn (pos from respawn)
    await sleep(200);
    b.send({ t: 'buy', item: 'kevlar' });
    await until(() => b.inv.armor === 100);
    ok(b.inv.armor === 100 && b.inv.money === 800 - 650, 'kevlar bought in the CT buy zone');
    b.send({ t: 'buy', item: 'deagle' });
    await until(() => b.last.buy_fail && b.last.buy_fail.item === 'deagle');
    ok(/money/.test(b.last.buy_fail.reason), 'cannot afford a Deagle with $150');
    // freeze time holds everyone on the spawn; buying stays open 20 s into the round
    const aSpawn = a.pos;
    a.pos = [0, 0, 0]; await sleep(200);
    a.send({ t: 'buy', item: 'kevlar' });
    await sleep(200);
    ok(a.inv.armor === 100, 'during freeze time the server keeps you on the spawn (buy still works)');
    await until(() => a.got('round').some((m) => m.phase === 'round'), 7000);
    ok(a.got('round').some((m) => m.phase === 'round'), 'freeze time ends and the round goes live');
    a.pos = [0, 0, 0]; await sleep(200);
    a.send({ t: 'buy', item: 'deagle' });
    await until(() => a.last.buy_fail && a.last.buy_fail.item === 'deagle');
    ok(/buy zone/.test(a.last.buy_fail.reason), 'buying outside the buy zone is refused');
    a.pos = aSpawn; await sleep(200);

    console.log('ammo + reload');
    const fire = (c, n, gap = 200) => (async () => { for (let i = 0; i < n; i++) { c.send({ t: 'fire', origin: [c.pos[0], c.pos[1] + 64, c.pos[2]], dir: [0, 1, 0] }); await sleep(gap); } })();
    await sleep(400); // draw time after spawn
    await fire(a, 5);
    a.send({ t: 'weapon', id: 'knife' });
    await sleep(100);
    a.send({ t: 'weapon', id: 'glock' });
    await until(() => a.ammo && a.ammo.weapon === 'glock');
    ok(a.ammo.mag === WEAPONS.glock.mag - 5, `switching weapons keeps the magazine (${a.ammo.mag}/${WEAPONS.glock.mag})`);
    a.send({ t: 'reload' });
    await until(() => a.last.reload);
    ok(a.last.reload && a.last.reload.time === WEAPONS.glock.reload, 'reload starts with the weapon reload time');
    a.send({ t: 'fire', origin: [a.pos[0], a.pos[1] + 64, a.pos[2]], dir: [0, 1, 0] });
    await sleep(150);
    ok(a.ammo.reloading === true, 'firing mid-reload is refused (server resyncs ammo)');
    await sleep(WEAPONS.glock.reload * 1000 + 200);
    ok(a.ammo.mag === WEAPONS.glock.mag && a.ammo.reserve === WEAPONS.glock.reserve - 5 && !a.ammo.reloading,
      `reload fills the mag from reserve (${a.ammo.mag}/${a.ammo.reserve})`);

    console.log('kill money + round economy');
    // a walks up to b and shoots it (b has kevlar: body damage halved)
    const bp = b.pos;
    a.pos = [bp[0] - Math.sign(bp[0]) * 100, bp[1], bp[2]]; // step toward the map centre, never into a wall
    await sleep(300);
    const t0 = a.msgs.length;
    for (let i = 0; i < 30 && !a.got('kill').length; i++) {
      const eye = [a.pos[0], a.pos[1] + 64, a.pos[2]];
      const d = [bp[0] - eye[0], bp[1] + 40 - eye[1], bp[2] - eye[2]];
      const L = Math.hypot(...d);
      a.send({ t: 'fire', origin: eye, dir: d.map((v) => v / L) });
      await sleep(180);
      if (a.ammo && a.ammo.mag === 0) { a.send({ t: 'reload' }); await sleep(2700); }
    }
    const hits = a.msgs.slice(t0).filter((m) => m.t === 'hit');
    if (process.env.DEBUG) console.log('DEBUG', { bp, apos: a.pos, hits: hits.length, ammo: a.ammo, shoots: a.msgs.slice(t0).map((m) => m.t).join(',').slice(0, 300) });
    ok(hits.some((h) => (h.part === 'chest' || h.part === 'stomach') && h.armor < 100), 'kevlar absorbs chest/stomach damage');
    ok(a.got('kill').length === 1, 'CT killed by T');
    await until(() => a.got('round_end').length);
    const re = a.last.round_end;
    ok(re && re.winner === TEAM.T && re.how === 'elim', 'eliminating the last CT ends the round for T');
    await sleep(200);
    const aMoney = a.msgs.filter((m) => m.t === 'inv' && m.reason === 'kill');
    ok(aMoney.length === 1 && aMoney[0].delta === ECONOMY.killReward, 'kill reward $300');
    const win = a.msgs.filter((m) => m.t === 'inv' && m.reason === 'round win');
    const loss = b.msgs.filter((m) => m.t === 'inv' && m.reason === 'round loss');
    ok(win.length === 1 && win[0].delta === ECONOMY.winBonus, 'round win bonus (elimination $3000)');
    ok(loss.length === 1 && loss[0].delta === ECONOMY.lossBonus[0], 'first loss bonus $1400');
    const bRespawnsBefore = b.got('respawn').length;
    await sleep(1800);
    ok(b.got('respawn').length === bRespawnsBefore, 'the dead stay dead until the next round');

    console.log('next round');
    await until(() => a.got('round').some((m) => m.round === 2), 7000);
    await until(() => b.got('respawn').length > bRespawnsBefore, 2000);
    ok(b.got('respawn').length > bRespawnsBefore, 'dead player respawns for round 2');
    await until(() => b.inv && b.inv.armor === 0, 1000);
    ok(b.inv.armor === 0 && b.inv.inv.secondary === 'usp', 'the dead lose their gear');
    ok(a.inv.c4 || b.inv.c4 || a.got('inv').some((m) => m.c4), 'a terrorist carries the C4');
    ok(a.inv.inv.secondary === 'glock', 'survivors keep their loadout');
  } finally {
    for (const c of clients) { clearInterval(c.timer); c.ws.close(); }
    srv.kill();
  }
  console.log(failures.length ? `\nm2: ${failures.length} FAILED` : '\nm2: all checks passed');
  process.exit(failures.length ? 1 : 0);
}

main();
