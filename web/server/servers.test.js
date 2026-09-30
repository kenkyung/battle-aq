// M16 servers: room browser, custom rooms, rcon, flood kick, stats.
// Boots the real server on a scratch port.   node server/servers.test.js

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18977;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baq-'));
const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => fetch(`http://127.0.0.1:${PORT}/${p}`).then((r) => r.json());

function client(join) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, msgs: [], closed: false, send: (o) => ws.send(JSON.stringify(o)) };
  c.last = (t) => c.msgs.filter((m) => m.t === t).at(-1);
  ws.onopen = () => c.send({ t: 'join', name: 'Tester', ...join });
  ws.onmessage = (ev) => c.msgs.push(JSON.parse(ev.data));
  ws.onclose = () => { c.closed = true; };
  return c;
}

const srv = spawn(process.execPath, [path.join(__dirname, 'index.js'), '--port', String(PORT), '--host', '127.0.0.1'], {
  stdio: 'pipe', env: { ...process.env, RCON_PASSWORD: 'sekrit', STATS_FILE: path.join(TMP, 's.json'), BANS_FILE: path.join(TMP, 'b.json') },
});
try {
  for (let i = 0; i < 50; i++) { try { await get('info'); break; } catch { await sleep(100); } }

  console.log('rooms');
  let rooms = await get('rooms');
  ok(rooms.length >= 1, `the browser lists rooms (${rooms.length})`);
  const a = client({ create: { name: 'Clan match', map: 'de_aq_dust2', rules: 'competitive', fill: 0, roundtime: 120, winlimit: 5, ff: true, password: 'pw' } });
  for (let i = 0; i < 30 && !a.last('welcome'); i++) await sleep(100);
  rooms = await get('rooms');
  const mine = rooms.find((r) => r.name === 'Clan match');
  ok(mine && mine.map === 'de_aq_dust2' && mine.locked, 'a created room shows up (name, map, locked)');
  ok(a.last('welcome')?.round?.rulesName === 'Clan match' && a.last('welcome').round.winlimit === 5, 'with its custom rules');
  const b = client({ room: mine.id, password: 'nope' });
  for (let i = 0; i < 20 && !b.closed; i++) await sleep(100);
  ok(b.closed && b.last('error')?.text.includes('password'), 'a wrong room password is refused');
  const c = client({ room: mine.id, password: 'pw' });
  for (let i = 0; i < 30 && !c.last('welcome'); i++) await sleep(100);
  ok(c.last('welcome')?.mapId === 'de_aq_dust2', 'the right password joins the room');

  console.log('rcon');
  a.send({ t: 'rcon', pw: 'wrong', cmd: 'status' });
  await sleep(200);
  ok(a.last('rcon_reply')?.text === 'bad rcon_password', 'bad password refused');
  a.send({ t: 'rcon', pw: 'sekrit', cmd: 'status' });
  await sleep(200);
  ok(a.last('rcon_reply')?.text.includes('Tester'), 'rcon status lists the players');
  a.send({ t: 'rcon', pw: 'sekrit', cmd: 'bot_add ct hard' });
  await sleep(200);
  a.send({ t: 'rcon', pw: 'sekrit', cmd: 'mp_roundtime 3' });
  await sleep(200);
  ok(a.last('rcon_reply')?.text.includes('mp_roundtime'), 'mp_roundtime changed');
  rooms = await get('rooms');
  ok(rooms.find((r) => r.id === mine.id).bots === 1, 'bot_add adds a bot');
  a.send({ t: 'rcon', pw: 'sekrit', cmd: 'kick Tester' });
  await sleep(300);
  ok(a.closed || c.closed, 'kick disconnects the player');

  console.log('flood');
  const f = client({});
  for (let i = 0; i < 30 && !f.last('welcome'); i++) await sleep(100);
  for (let i = 0; i < 3500; i++) f.send({ t: 'pong', ts: 0 });
  for (let i = 0; i < 20 && !f.closed; i++) await sleep(100);
  ok(f.closed, 'flooding the server gets you kicked');
} finally {
  srv.kill();
}

console.log('stats');
{
  process.env.STATS_FILE = path.join(TMP, 's2.json');
  const { stats } = await import('./stats.js');
  const A = { name: 'Alice' }, B = { name: 'Bob' };
  for (let i = 0; i < 6; i++) stats.kill(A, B, i % 2 === 0);
  stats.round([A], [B]);
  const top = stats.top(5);
  ok(top[0].name === 'Alice' && top[0].kills === 6 && top[0].hsp === 50 && top[0].wins === 1, 'kills, headshot % and wins recorded');
  stats.flush();
  ok(JSON.parse(fs.readFileSync(process.env.STATS_FILE, 'utf8')).alice.kills === 6, 'and saved to disk');
}

console.log(failures.length ? `\nservers: ${failures.length} FAILED` : '\nservers: all checks passed');
process.exit(failures.length ? 1 : 0);
