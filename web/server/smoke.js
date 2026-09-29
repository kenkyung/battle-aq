// Integration smoke test: boots the real server on a scratch port, connects
// two WebSocket clients, and asserts the core loop end to end:
//   join -> welcome -> state sync (both directions) -> fire -> hit -> kill.
// Exits 0 on success, 1 on the first failed assertion.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18931;

const failures = [];
function assert(cond, label) {
  if (cond) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}`); }
}

function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = {
    ws, name, id: null, pos: null,
    snapshots: [], hits: [], kills: [], welcomed: false,
    send: (o) => ws.send(JSON.stringify(o)),
  };
  ws.onopen = () => c.send({ t: 'join', name, size: 0 });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') {
      c.welcomed = true; c.id = m.id; c.pos = m.you.pos;
      c.stateTimer = setInterval(() =>
        c.send({ t: 'state', pos: c.pos, yaw: 0, pitch: 0, crouching: false, moving: false }), 50);
    }
    else if (m.t === 'state') c.snapshots.push(m);
    else if (m.t === 'hit') c.hits.push(m);
    else if (m.t === 'kill') c.kills.push(m);
    else if (m.t === 'round' && m.phase === 'round') c.roundLive = true;
  };
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('smoke: booting server on :' + PORT);
  const srv = spawn(process.execPath, [path.join(__dirname, 'index.js'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'pipe' });
  let booted = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('battle-aq web server')) booted = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !booted; i++) await sleep(100);
  assert(booted, 'server boots and prints banner');

  try {
    const a = client('Alpha');
    const b = client('Beta');
    for (let i = 0; i < 50 && !(a.welcomed && b.welcomed); i++) await sleep(100);
    assert(a.welcomed && b.welcomed, 'both clients receive welcome');
    assert(a.id !== b.id, 'distinct player ids');

    // both teams present -> round 1 starts with 5 s of freeze time (no shooting)
    for (let i = 0; i < 80 && !a.roundLive; i++) await sleep(100);
    assert(a.roundLive, 'freeze time ends, round goes live');
    await sleep(300);
    const aSnap = a.snapshots.at(-1);
    const bSnap = b.snapshots.at(-1);
    assert(a.snapshots.length > 3, 'alpha receives state snapshots');
    assert(aSnap && aSnap.players.length === 2, 'alpha snapshot has both players');
    assert(bSnap && bSnap.players.length === 2, 'beta snapshot has both players');

    // Beta repositions next to Alpha (position is client-authoritative, the
    // server relays it), waits for the server to see it, then fires until
    // Alpha dies (server-authoritative damage). Spawning on opposite teams
    // puts the clients ~3000u apart with walls between, so this matters.
    const aPos = b.snapshots.at(-1)?.players.find((p) => p.id === a.id)?.pos;
    assert(!!aPos, 'beta can read alpha position from snapshot');
    b.pos = [aPos[0] + 120, aPos[1], aPos[2]];
    await sleep(300);

    const eye = () => [b.pos[0], b.pos[1] + 64, b.pos[2]];
    for (let i = 0; i < 8; i++) {
      const tgt = b.snapshots.at(-1)?.players.find((p) => p.id === a.id)?.pos;
      if (!tgt) break;
      const e = eye();
      const d = [tgt[0] - e[0], tgt[1] + 40 - e[1], tgt[2] - e[2]];
      const L = Math.hypot(...d);
      b.send({ t: 'fire', origin: e, dir: d.map((v) => v / L), weapon: 'ak47' });
      await sleep(150);
    }
    await sleep(400);
    assert(a.hits.length > 0, 'alpha receives hit confirmations');
    assert(a.hits.at(-1)?.hp < 100, 'alpha hp reduced by server');
    assert(a.kills.some((k) => k.attacker === b.id && k.victim === a.id), 'kill attributed beta -> alpha');

    clearInterval(a.stateTimer); clearInterval(b.stateTimer);
    a.ws.close(); b.ws.close();
    await sleep(300);
  } finally {
    srv.kill();
  }

  console.log(failures.length ? `\nsmoke: ${failures.length} FAILED` : '\nsmoke: all checks passed');
  process.exit(failures.length ? 1 : 0);
}

main();
