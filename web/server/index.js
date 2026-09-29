// battle-aq web server: one Node process serves the static client AND the
// WebSocket game connection on a single port, so players just open a URL.
//
//   node server/index.js --port 8080 --map de_aq_dust --host 0.0.0.0
//
//   http://192.168.1.113:8080   -> your MacBook, same LAN
//   http://100.104.64.0:8080    -> a friend, over Tailscale

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import { MAPS } from '../shared/maps.js';
import { TICK_RATE, SNAPSHOT_RATE, TEAM } from '../shared/constants.js';

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

// Baked assets and the vendored three.js change only on deploy; let browsers
// keep them for a day instead of re-downloading ~6 MB on every visit.
const LONG_CACHE = /^\/(assets|vendor)\//;

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let baseDir = PUBLIC_DIR;
  if (urlPath.startsWith('/shared/')) {
    baseDir = SHARED_DIR;
    urlPath = urlPath.slice('/shared'.length);
  }
  if (urlPath === '/info') {
    return send(res, 200, JSON.stringify({
      map: publicGame.map.id, players: publicGame.humans.length, phase: publicGame.phase,
      maps: Object.keys(MAPS), practiceGames: rooms.size - 1,
    }), 'application/json');
  }
  if (urlPath === '/') urlPath = '/index.html';
  // prevent path traversal
  const filePath = path.normalize(path.join(baseDir, urlPath));
  if (!filePath.startsWith(baseDir)) return send(res, 403, 'forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'not found: ' + urlPath);
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, MIME[ext] || 'application/octet-stream',
      baseDir === PUBLIC_DIR && LONG_CACHE.test(urlPath) ? 'public, max-age=86400' : 'no-cache');
  });
});

// ------------------------------------------------------------------ rooms

// One public room (everyone who clicks PLAY) plus practice rooms: one human
// against bots, created on demand and thrown away when the human leaves.
const publicGame = new Game(args.map, { id: 'public' });
const rooms = new Map([['public', publicGame]]);
let practiceSeq = 0;
const MAX_PRACTICE_ROOMS = 24;

function practiceRoom(msg) {
  const mapId = MAPS[msg.map] ? msg.map : args.map;
  const id = 'practice-' + (++practiceSeq);
  const game = new Game(mapId, { id, practice: true });
  rooms.set(id, game);
  return game;
}

function fillBots(game, human, msg) {
  const total = Math.max(1, Math.min(9, parseInt(msg.bots, 10) || 5));
  const diff = ['easy', 'normal', 'hard'].includes(msg.difficulty) ? msg.difficulty : 'normal';
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

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let player = null;
  let game = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (!player) {
      if (msg.t !== 'join') return;
      const team = msg.team === 'CT' ? TEAM.CT : msg.team === 'T' ? TEAM.T : 0;
      if (msg.mode === 'practice') {
        const practices = [...rooms.values()].filter((g) => g.practice).length;
        if (practices >= MAX_PRACTICE_ROOMS) { ws.send(JSON.stringify({ t: 'error', text: 'server is full of practice games, try again soon' })); ws.close(); return; }
        game = practiceRoom(msg);
        player = game.addPlayer(ws, msg.name, { team: team || TEAM.T });
        fillBots(game, player, msg);
        log(`practice ${game.id} "${player.name}" map=${game.map.id} bots=${game.players.size - 1}`);
      } else {
        game = publicGame;
        player = game.addPlayer(ws, msg.name, { team });
        log(`join  #${player.id} "${player.name}" team=${player.team} (${publicGame.players.size} online)`);
      }
      return;
    }
    game.onMessage(player, msg);
  });

  ws.on('close', () => {
    if (!player) return;
    game.removePlayer(player.id);
    if (game.practice) {
      if (!game.humans.length) rooms.delete(game.id);
      log(`practice ${game.id} closed`);
    } else log(`left  #${player.id} "${player.name}" (${publicGame.players.size} online)`);
  });

  ws.on('error', () => {});
});

// ------------------------------------------------------------------ loops

const simInterval = setInterval(() => {
  for (const g of rooms.values()) g.update();
}, 1000 / TICK_RATE);
const snapInterval = setInterval(() => {
  for (const g of rooms.values()) if (g.players.size > 0) g.broadcastSnapshots();
}, 1000 / SNAPSHOT_RATE);

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
  clearInterval(snapInterval);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
