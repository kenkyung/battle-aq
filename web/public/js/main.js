// battle-aq web client. Boot, menu, connection, game loop, server messages.

import * as THREE from 'three';
import { Net } from './net.js';
import { Input } from './input.js';
import { buildWorld } from './world.js';
import { LocalPlayer } from './player.js';
import { Remotes } from './remotes.js';
import { HUD } from './hud.js';
import { getMap } from '/shared/maps.js';
import { WEAPONS, TEAM, PLAYER } from '/shared/constants.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ three setup

const container = $('game');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 12000);
scene.add(camera);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------ state

const input = new Input();
input.attach(renderer.domElement);
const net = new Net();
const hud = new HUD();

let world = null;        // { colliders, group }
let player = null;       // LocalPlayer
let remotes = null;      // Remotes
let myId = null;
let running = false;
let reloadingUntil = 0;
let names = new Map();   // id -> name (for killfeed/chat)

// ------------------------------------------------------------------ menu

const menu = $('menu');
const playBtn = $('playBtn');
const menuStatus = $('menuStatus');
$('serverAddr').value = location.host;
$('playerName').value = localStorage.getItem('baq_name') || '';

playBtn.addEventListener('click', () => {
  const addr = $('serverAddr').value.trim() || location.host;
  const name = $('playerName').value.trim() || 'Player';
  localStorage.setItem('baq_name', name);
  connect(addr, name);
});
$('playerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') playBtn.click(); });

async function connect(addr, name) {
  playBtn.disabled = true;
  menuStatus.textContent = `connecting to ${addr}…`;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Register the welcome handler BEFORE opening the socket: the server sends
  // `welcome` in reply to `join`, so the handler must exist when it arrives.
  net.on('welcome', onWelcome);
  try {
    await net.connect(`${proto}://${addr}/ws`);
    net.send({ t: 'join', name });
  } catch (e) {
    menuStatus.textContent = `could not connect — is the server running at ${addr}?`;
    playBtn.disabled = false;
  }
}

function onWelcome(welcome) {
  myId = welcome.id;
  const map = getMap(welcome.mapId);
  $('mapName').textContent = map.name;

  world = buildWorld(scene, map);
  player = new LocalPlayer(camera, world.colliders, net, scene);
  remotes = new Remotes(scene);

  // seed existing players
  names.clear();
  for (const p of welcome.players) {
    names.set(p.id, p.name);
    if (p.id !== myId) remotes.setTarget(p);
  }
  if (welcome.you) {
    player.spawnAt(welcome.you.pos);
    player.weapon = welcome.you.weapon || 'ak47';
    names.set(myId, welcome.you.name);
    hud.setWeapon(WEAPONS[player.weapon].name);
  }

  if (welcome.round) {
    hud.setPhase(welcome.round.phase);
    hud.setScore(welcome.round.scoreT, welcome.round.scoreCT);
    roundEndsAt = performance.now() / 1000 + (welcome.round.timer || 0);
  }

  menu.classList.add('hidden');
  hud.show();
  hud.setHint('click to play');
  running = true;

  // debug handle for automated testing / introspection (harmless in prod)
  window.__baq = { scene, camera, renderer, player, remotes, mapId: welcome.mapId, myId, net };
}

// ------------------------------------------------------------------ server messages

let roundEndsAt = 0;

net.on('state', (msg) => {
  if (!remotes) return;
  const seen = new Set();
  for (const p of msg.players) {
    seen.add(p.id);
    if (p.id === myId) continue;
    remotes.setTarget(p);
  }
  // prune players that vanished without a despawn (safety)
  for (const id of [...remotes.players.keys()]) if (!seen.has(id)) remotes.remove(id);
});

net.on('spawn', (msg) => {
  names.set(msg.player.id, msg.player.name);
  if (msg.player.id !== myId && remotes) remotes.setTarget(msg.player);
});

net.on('despawn', (msg) => { names.delete(msg.id); if (remotes) remotes.remove(msg.id); });

net.on('shoot', (msg) => {
  if (!player || msg.id === myId) return;
  const from = msg.origin;
  const to = [from[0] + msg.dir[0] * 4000, from[1] + msg.dir[1] * 4000, from[2] + msg.dir[2] * 4000];
  player.spawnTracerBetween(from, to);
});

net.on('hit', (msg) => {
  if (msg.victim === myId && player) {
    player.hp = msg.hp;
    hud.setHp(msg.hp);
    flashDamage();
  }
});

net.on('kill', (msg) => {
  hud.addKill(names.get(msg.attacker) || `#${msg.attacker}`,
    names.get(msg.victim) || `#${msg.victim}`, msg.weapon);
});

net.on('die', (msg) => {
  if (msg.id === myId && player) {
    player.alive = false;
    player.deaths++;
    hud.showDeath(names.get(msg.by) || `#${msg.by}`);
    if (document.pointerLockElement) document.exitPointerLock();
  }
});

net.on('respawn', (msg) => {
  if (!player) return;
  player.spawnAt(msg.pos);
  hud.setHp(msg.hp);
  hud.setAmmo(msg.ammo, WEAPONS[player.weapon].mag, false);
  hud.hideDeath();
  hud.setHint('');
});

net.on('weapon', (msg) => {
  if (player) { hud.setWeapon(WEAPONS[msg.id].name); hud.setAmmo(msg.ammo, WEAPONS[msg.id].mag, false); }
});

net.on('reload', (msg) => { reloadingUntil = performance.now() / 1000 + msg.time; });

net.on('round', (msg) => {
  hud.setPhase(msg.phase);
  hud.setScore(msg.scoreT, msg.scoreCT);
  roundEndsAt = performance.now() / 1000 + (msg.timer || 0);
});

net.on('round_end', (msg) => {
  hud.setScore(msg.scoreT, msg.scoreCT);
  hud.setHint(msg.winner === TEAM.T ? 'Terrorists win the round' : 'Counter-Terrorists win the round');
  setTimeout(() => hud.setHint(''), 4000);
});

net.on('chat', (msg) => hud.addChat(msg.name, msg.text));

net.onClose = () => {
  running = false;
  hud.hide();
  menu.classList.remove('hidden');
  playBtn.disabled = false;
  menuStatus.textContent = 'disconnected from server';
};

// ------------------------------------------------------------------ damage flash

let flashEl = null;
function flashDamage() {
  if (!flashEl) {
    flashEl = document.createElement('div');
    flashEl.style.cssText = 'position:absolute;inset:0;background:rgba(200,30,30,0);pointer-events:none;z-index:18;transition:background .1s';
    document.body.appendChild(flashEl);
  }
  flashEl.style.background = 'rgba(200,30,30,0.28)';
  setTimeout(() => { flashEl.style.background = 'rgba(200,30,30,0)'; }, 90);
}

// ------------------------------------------------------------------ game loop

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!running || !player) { renderer.render(scene, camera); return; }

  player.update(dt, input);
  remotes.update(dt);

  // HUD
  hud.setHp(player.hp);
  const w = WEAPONS[player.weapon];
  hud.setAmmo(player.ammo, w.mag, performance.now() / 1000 < reloadingUntil);
  hud.setTimer(roundEndsAt - performance.now() / 1000);
  if (!input.locked) hud.setHint('click to play');
  else if (hud.hint.textContent === 'click to play') hud.setHint('');

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
