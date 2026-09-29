// Test bots: connect N players that wander, crouch and shoot, so you can
// see other soldiers (and the round system) without a second person.
//   node tools/bots.mjs [--url ws://127.0.0.1:8080/ws] [--count 3] [--near x,z] [--radius 300]
//                       [--peaceful 1] [--crouch always|never]

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) =>
  (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const url = args.url || 'ws://127.0.0.1:8080/ws';
const count = parseInt(args.count || '3', 10);
const near = args.near ? args.near.split(',').map(Number) : null;
const radius = parseFloat(args.radius || '300');

for (let i = 0; i < count; i++) {
  const ws = new WebSocket(url);
  const bot = { pos: null, yaw: 0, t: Math.random() * 10, crouch: false, center: null, alive: true };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: `Bot ${i + 1}` }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome' || m.t === 'respawn') {
      bot.pos = (m.you ? m.you.pos : m.pos).slice();
      bot.center = near ? [near[0], bot.pos[1], near[1]] : bot.pos.slice();
      bot.alive = true;
    }
    if (m.t === 'die' && m.id === bot.id) bot.alive = false;
    if (m.t === 'welcome') bot.id = m.id;
  };
  setInterval(() => {
    if (!bot.pos || ws.readyState !== 1 || !bot.alive) return;
    bot.t += 0.05;
    const a = bot.t * 0.6 + i * 2.1;
    const r = radius * (0.5 + 0.5 * Math.sin(bot.t * 0.23 + i));
    const nx = bot.center[0] + Math.cos(a) * r, nz = bot.center[2] + Math.sin(a) * r;
    const dx = nx - bot.pos[0], dz = nz - bot.pos[2];
    bot.yaw = Math.atan2(-dx, -dz);
    bot.pos = [nx, bot.center[1], nz];
    bot.crouch = args.crouch === 'always' ? true : args.crouch === 'never' ? false : Math.sin(bot.t * 0.4 + i) > 0.7;
    ws.send(JSON.stringify({ t: 'state', pos: bot.pos, yaw: bot.yaw, pitch: Math.sin(bot.t) * 0.2, crouching: bot.crouch, moving: true }));
    if (!args.peaceful && Math.random() < 0.02) {
      ws.send(JSON.stringify({ t: 'fire', origin: [bot.pos[0], bot.pos[1] + 64, bot.pos[2]], dir: [-Math.sin(bot.yaw), 0.05, -Math.cos(bot.yaw)] }));
    }
  }, 50);
}
console.log(`${count} bots -> ${url}`);
