// battle-aq web server: one Node process serves the static client AND the
// WebSocket game connection on a single port, so players just open a URL.
//
//   node server/index.js --port 8080 --map de_aq_dust --host 0.0.0.0
//
//   http://192.168.1.113:8080   -> your MacBook, same LAN
//   http://100.104.64.0:8080    -> a friend, over Tailscale

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { Game, RESUME_GRACE } from './game.js';
import { MAPS } from '../shared/maps.js';
import { TICK_RATE, SNAPSHOT_RATE, TEAM } from '../shared/constants.js';
import { RULES } from '../shared/rules.js';
import { stats } from './stats.js';
import { rcon, isBanned, rateLimiter } from './admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SHARED_DIR = path.join(__dirname, '..', 'shared');

// The browser imports the SAME physics/maps/constants modules the server runs
// (single source of truth for movement, collision and the world), so those
// files are served read-only under /shared/.

// ------------------------------------------------------------------ cli args

function parseArgs() {
  const out = {
    port: parseInt(process.env.PORT || '8080', 10),
    map: process.env.MAP || 'de_aq_dust',
    host: process.env.HOST || '0.0.0.0',
  };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (k === 'port') out.port = parseInt(a[++i], 10);
    else if (k === 'map') out.map = a[++i];
    else if (k === 'host') out.host = a[++i];
    else if (k === 'help') { console.log('node server/index.js --port 8080 --map de_aq_dust --host 0.0.0.0'); process.exit(0); }
  }
  return out;
}
const args = parseArgs();
if (!MAPS[args.map]) {
  console.error(`unknown map '${args.map}'. Available: ${Object.keys(MAPS).join(', ')}`);
  process.exit(1);
}

// ------------------------------------------------------------------ static http

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg',
};

function send(res, code, body, type = 'text/plain', cache = 'no-cache') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(body);
}

// Cache busting. Everything the page loads lives under /v/<BUILD>/…, where
// BUILD is a hash of the files' sizes and times, so a deploy changes every
// URL at once and those files can be cached for a year (browsers and
// Cloudflare alike). Only index.html is served uncached.
function buildId() {
  const h = crypto.createHash('sha1');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else { const st = fs.statSync(f); h.update(f + st.size + st.mtimeMs); }
    }
  };
  walk(PUBLIC_DIR); walk(SHARED_DIR);
  return h.digest('hex').slice(0, 10);
}
const BUILD = buildId();
const IMMUTABLE = 'public, max-age=31536000, immutable';
const indexHtml = () => fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace('href="style.css"', `href="v/${BUILD}/style.css"`)
  .replace('src="js/main.js"', `src="v/${BUILD}/js/main.js"`)
  .replace('"./vendor/three.module.js"', `"./v/${BUILD}/vendor/three.module.js"`);

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let cache = 'no-cache';
  const v = urlPath.match(/^\/v\/[0-9a-f]+(\/.*)$/);
  if (v) { urlPath = v[1]; cache = IMMUTABLE; }
  let baseDir = PUBLIC_DIR;
  if (urlPath.startsWith('/shared/')) {
    baseDir = SHARED_DIR;
    urlPath = urlPath.slice('/shared'.length);
  }
  if (urlPath === '/info') return send(res, 200, JSON.stringify(roomsInfo()), 'application/json');
  if (urlPath === '/rooms') return send(res, 200, JSON.stringify(roomList()), 'application/json');
  if (urlPath === '/stats') return send(res, 200, JSON.stringify(stats.top(25)), 'application/json');
  if (urlPath === '/' || urlPath === '/index.html') return send(res, 200, indexHtml(), MIME['.html'], 'no-cache');
  // prevent path traversal
  const filePath = path.normalize(path.join(baseDir, urlPath));
  if (!filePath.startsWith(baseDir)) return send(res, 403, 'forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'not found: ' + urlPath);
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, MIME[ext] || 'application/octet-stream', cache);
  });
});

// ------------------------------------------------------------------ rooms

// Public rooms (one per map, created when someone picks that map; another
// opens if one fills up) plus practice rooms: one human against bots,
// created on demand and thrown away when the human leaves.
const rooms = new Map();
let roomSeq = 0;
const MAX_PRACTICE_ROOMS = 24;
const PUBLIC_ROOM_SIZE = 20;

// bots top each team up to `size` (3-5; 0 = humans only)
const DEFAULT_FILL = Math.max(0, Math.min(5, parseInt(process.env.BOT_FILL || '5', 10)));
function publicRoom(mapId, size = DEFAULT_FILL, rules = 'casual') {
  const want = MAPS[mapId] ? mapId : args.map;
  const fill = [0, 3, 4, 5].includes(size) ? size : DEFAULT_FILL;
  const r = RULES[rules] ? rules : 'casual';
  for (const g of rooms.values()) {
    if (!g.practice && g.map.id === want && g.fillTo === fill && g.rulesId === r && g.humans.length < PUBLIC_ROOM_SIZE) return g;
  }
  const id = 'public-' + (++roomSeq);
  const g = new Game(want, { id, fillTo: fill, rules: r });
  rooms.set(id, g);
  return g;
}
publicRoom(args.map); // the default map is always open

function roomsInfo() {
  const byMap = {};
  for (const id of Object.keys(MAPS)) byMap[id] = 0;
  let practice = 0;
  for (const g of rooms.values()) {
    if (g.practice) practice++;
    else byMap[g.map.id] = (byMap[g.map.id] || 0) + g.humans.length;
  }
  const players = Object.values(byMap).reduce((a, b) => a + b, 0);
  return { map: args.map, players, byMap, maps: Object.keys(MAPS), practiceGames: practice, build: BUILD };
}

// server browser (M16): every public / custom room
function roomList() {
  return [...rooms.values()].filter((g) => !g.practice).map((g) => ({
    id: g.id, name: g.roomName || `${g.map.id} · ${g.rules.name}`, map: g.map.id, rules: g.rules.name,
    humans: g.humans.length, bots: [...g.players.values()].filter((p) => p.bot).length, max: PUBLIC_ROOM_SIZE,
    locked: !!g.password, phase: g.phase, score: `${g.score[TEAM.T]}:${g.score[TEAM.CT]}`, round: g.roundNumber,
  }));
}

// a custom room from the browser's "create" form
function customRoom(c) {
  const id = 'room-' + (++roomSeq);
  const base = RULES[c.rules] ? c.rules : 'casual';
  const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d);
  const winlimit = clamp(c.winlimit, 1, 30, RULES[base].winlimit);
  const rules = {
    base, name: String(c.name || 'Custom').slice(0, 32),
    roundtime: clamp(c.roundtime, 60, 600, RULES[base].roundtime),
    winlimit, maxrounds: winlimit * 2 - 1, halftime: winlimit - 1,
    friendlyfire: c.ff === undefined ? RULES[base].friendlyfire : !!c.ff,
  };
  const g = new Game(MAPS[c.map] ? c.map : args.map, { id, fillTo: [0, 3, 4, 5].includes(+c.fill) ? +c.fill : 5, rules, botDifficulty: ['easy', 'normal', 'hard', 'expert'].includes(c.difficulty) ? c.difficulty : 'normal' });
  g.roomName = rules.name;
  g.password = c.password ? String(c.password).slice(0, 32) : '';
  g.custom = true;
  rooms.set(id, g);
  log(`room ${id} "${g.roomName}" created on ${g.map.id}`);
  return g;
}

function practiceRoom(msg) {
  const mapId = MAPS[msg.map] ? msg.map : args.map;
  const id = 'practice-' + (++roomSeq);
  const game = new Game(mapId, { id, practice: true, rules: RULES[msg.rules] ? msg.rules : 'casual' });
  rooms.set(id, game);
  return game;
}

function fillBots(game, human, msg) {
  const total = Math.max(1, Math.min(9, parseInt(msg.bots, 10) || 5));
  const diff = ['easy', 'normal', 'hard', 'expert'].includes(msg.difficulty) ? msg.difficulty : 'normal';
  // split everyone as evenly as possible, the human's side filled first
  const size = { [TEAM.T]: 0, [TEAM.CT]: 0 };
  size[human.team] = 1;
  for (let i = 0; i < total; i++) {
    const team = size[TEAM.T] <= size[TEAM.CT] ? TEAM.T : TEAM.CT;
    size[team]++;
    game.addBot(team, diff);
  }
  game.checkMode();
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

const RCON = process.env.RCON_PASSWORD || '';
wss.on('connection', (ws, req) => {
  let player = null;
  let game = null;
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (isBanned(ip)) { ws.send(JSON.stringify({ t: 'error', text: 'you are banned from this server' })); ws.close(); return; }
  const limit = rateLimiter();
  let rconFails = 0;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    const r = limit();
    if (r === 'drop') return;
    if (r === 'kick') { log(`flood: kicked ${ip}`); ws.close(); return; }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    // one bad message must never take the whole server (every room) down
    try { handle(msg); } catch (e) { log(`error handling ${msg && msg.t}: ${e && e.stack || e}`); }
  });

  function handle(msg) {

    if (!player) {
      if (msg.t !== 'join') return;
      // coming back after a dropped connection: same player, same everything
      if (msg.resume && msg.room) {
        const g = rooms.get(String(msg.room));
        const p = g && g.findResumable(String(msg.resume));
        if (p) {
          clearTimeout(p.graceTimer);
          game = g;
          player = g.resume(p, ws);
          player.ip = ip;
          log(`resume #${player.id} "${player.name}" ${game.id}`);
          return;
        }
      }
      const team = msg.team === 'CT' ? TEAM.CT : msg.team === 'T' ? TEAM.T : 0;
      if (msg.mode === 'practice') {
        const practices = [...rooms.values()].filter((g) => g.practice).length;
        if (practices >= MAX_PRACTICE_ROOMS) { ws.send(JSON.stringify({ t: 'error', text: 'server is full of practice games, try again soon' })); ws.close(); return; }
        game = practiceRoom(msg);
        player = game.addPlayer(ws, msg.name, { team: team || TEAM.T });
        fillBots(game, player, msg);
        log(`practice ${game.id} "${player.name}" map=${game.map.id} bots=${game.players.size - 1}`);
      } else if (msg.create) {
        game = customRoom(msg.create);
        player = game.addPlayer(ws, msg.name, { team });
      } else if (msg.room) {
        game = rooms.get(String(msg.room));
        if (!game || game.practice) { ws.send(JSON.stringify({ t: 'error', text: 'that room is gone' })); ws.close(); return; }
        if (game.password && game.password !== String(msg.password || '')) { ws.send(JSON.stringify({ t: 'error', text: 'wrong room password' })); ws.close(); return; }
        if (game.humans.length >= PUBLIC_ROOM_SIZE) { ws.send(JSON.stringify({ t: 'error', text: 'that room is full' })); ws.close(); return; }
        player = game.addPlayer(ws, msg.name, { team });
      } else {
        game = publicRoom(msg.map, parseInt(msg.size, 10), String(msg.rules || 'casual'));
        player = game.addPlayer(ws, msg.name, { team });
      }
      player.ip = ip;
      log(`join  #${player.id} "${player.name}" ${game.id} map=${game.map.id} team=${player.team} (${game.humans.length} here)`);
      return;
    }
    if (msg.t === 'bye') { ws.bye = true; return; }       // leaving on purpose: no resume slot
    if (msg.t === 'rcon') {
      let text;
      if (!RCON) text = 'rcon is disabled on this server (set RCON_PASSWORD)';
      else if (String(msg.pw || '') !== RCON) {
        text = 'bad rcon_password';
        if (++rconFails >= 5) { log(`rcon: too many bad passwords from ${ip}`); ws.close(); }
      } else { text = rcon(game, player, String(msg.cmd || '')); log(`rcon ${player.name}: ${msg.cmd}`); }
      ws.send(JSON.stringify({ t: 'rcon_reply', text }));
      return;
    }
    game.onMessage(player, msg);
  }

  ws.on('close', () => {
    if (!player) return;
    if (player.ws && player.ws !== ws) return;         // this player already resumed on a new socket
    // dropped (not a goodbye, not a kick): hold the slot for a reconnect
    if (!ws.bye && game.players.has(player.id) && !player.dc) {
      game.detach(player);
      log(`drop  #${player.id} "${player.name}" ${game.id} (holding ${RESUME_GRACE} s)`);
      const p = player, g = game;
      p.graceTimer = setTimeout(() => { if (p.dc && g.players.has(p.id)) gone(g, p); }, RESUME_GRACE * 1000);
      return;
    }
    gone(game, player);
  });

  ws.on('error', () => {});
});

// a player is gone for good: out of the room, and empty rooms close
function gone(game, player) {
  game.removePlayer(player.id);
  if (game.practice) {
    if (!game.humans.length) rooms.delete(game.id);
    log(`practice ${game.id} closed`);
  } else {
    log(`left  #${player.id} "${player.name}" ${game.id} (${game.humans.length} here)`);
    // empty public rooms go away, except one on the default map
    const keep = !game.custom && [...rooms.values()].filter((g) => !g.practice && g.map.id === args.map).length <= 1 && game.map.id === args.map;
    if (!game.humans.length && !keep) rooms.delete(game.id);
  }
}

// Heartbeat: a protocol ping every 10 s; a connection that did not answer the
// last one is dead (sleeping laptop, dropped Wi-Fi, half-open TCP) and is
// terminated, which removes its player instead of leaving a ghost behind.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 10000).unref();

// ------------------------------------------------------------------ loops

// Each room runs at its own tickrate and sends snapshots at its own update
// rate (rules: Casual 33 / 30 Hz, Competitive 66 / 60 Hz); one 4 ms timer
// drives them all from per-room accumulators.
let lastLoop = performance.now();
const simInterval = setInterval(() => {
  const nowMs = performance.now();
  const el = Math.min(250, nowMs - lastLoop);
  lastLoop = nowMs;
  for (const g of rooms.values()) {
    const tick = 1000 / (g.rules.tickrate || TICK_RATE), snap = 1000 / (g.rules.updaterate || SNAPSHOT_RATE);
    g._tickAcc = (g._tickAcc || 0) + el;
    g._snapAcc = (g._snapAcc || 0) + el;
    let n = 0;
    while (g._tickAcc >= tick && n++ < 4) { g._tickAcc -= tick; guard(g, () => g.update()); }
    if (g._tickAcc > tick * 4) g._tickAcc = 0;               // fell behind: skip, don't spiral
    if (g._snapAcc >= snap) { g._snapAcc %= snap; if (g.players.size > 0) guard(g, () => g.broadcastSnapshots()); }
  }
}, 4);
const snapInterval = null;

// a bug in one room is logged (once a minute at most) instead of killing the process
const lastError = new Map();
function guard(g, fn) {
  try { fn(); } catch (e) {
    const now = Date.now();
    if (now - (lastError.get(g.id) || 0) > 60000) { lastError.set(g.id, now); log(`error in ${g.id}: ${e && e.stack || e}`); }
  }
}

// ------------------------------------------------------------------ boot

function localAddresses() {
  const out = { tailscale: [], lan: [] };
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('100.')) out.tailscale.push(a.address);
      else out.lan.push(a.address);
    }
  }
  return out;
}

function log(...m) { console.log(new Date().toISOString().slice(11, 19), ...m); }

server.listen(args.port, args.host, () => {
  const addrs = localAddresses();
  console.log('----------------------------------------------------------');
  console.log(`battle-aq web server  map=${args.map}  (node ${process.version})`);
  console.log('----------------------------------------------------------');
  for (const a of addrs.tailscale) console.log(`  remote players (Tailscale):  http://${a}:${args.port}`);
  for (const a of addrs.lan) console.log(`  LAN players:                http://${a}:${args.port}`);
  if (!addrs.tailscale.length && !addrs.lan.length) console.log(`  local:                      http://127.0.0.1:${args.port}`);
  console.log('----------------------------------------------------------');
});

function shutdown() {
  clearInterval(simInterval);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
