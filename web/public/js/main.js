// battle-aq web client. Boot, menu, connection, game loop, server messages.

import * as THREE from 'three';
import { Net } from './net.js';
import { Input } from './input.js';
import { loadWorld } from './world.js';
import { LocalPlayer } from './player.js';
import { Remotes } from './remotes.js';
import { HUD } from './hud.js';
import { Viewmodel } from './viewmodel.js';
import { Effects } from './fx.js';
import { preloadModels, setAnisotropy } from './assets.js';
import { getMap } from '../shared/maps.js';
import { WEAPONS, TEAM, PLAYER } from '../shared/constants.js';
import { inBuyZone } from '../shared/economy.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ------------------------------------------------------------------ renderer

// Quality tiers: resolution scale + antialiasing. The level is baked (no
// real-time lights or shadows), so even "low" looks like the real thing.
const QUALITY = {
  low:    { ratio: 0.75, aa: false },
  medium: { ratio: 1.0,  aa: true },
  high:   { ratio: 2.0,  aa: true },
};
let quality = params.get('quality') || store.get('baq_quality', 'medium');
if (!QUALITY[quality]) quality = 'medium';
const Q = QUALITY[quality];

const container = $('game');
const renderer = new THREE.WebGLRenderer({ antialias: Q.aa, powerPreference: 'high-performance', stencil: false });
renderer.setPixelRatio(quality === 'low' ? Math.min(window.devicePixelRatio, 1) * Q.ratio : Math.min(window.devicePixelRatio, Q.ratio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.autoClear = false;
container.appendChild(renderer.domElement);
setAnisotropy(Math.min(quality === 'low' ? 2 : 8, renderer.capabilities.getMaxAnisotropy()));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 2, 60000);
camera.rotation.order = 'YXZ';
scene.add(camera);
const vm = new Viewmodel(window.innerWidth / window.innerHeight);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  vm.setAspect(camera.aspect);
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------ state

const input = new Input();
input.attach(renderer.domElement);
const net = new Net();
const hud = new HUD();

let map = null;
let world = null;
let fx = null;
let player = null;
let remotes = null;
let myId = null;
let myTeam = TEAM.T;
let running = false;
let round = { phase: 'warmup', endsAt: 0, buyEndsAt: -1, round: 0 };
const roster = new Map(); // id -> { id, name, team, alive, k, d, pos }
let spectating = null;    // id of the player we watch while dead
let scoresHeld = false;
// ?cam=x,y,z,yaw,pitch pins the camera (screenshots / debugging)
const debugCam = params.get('cam') ? params.get('cam').split(',').map(Number) : null;

const sens = parseFloat(store.get('baq_sens', '2.2'));
input.sensitivity = sens / 1000;

// ------------------------------------------------------------------ loading + menu

const menu = $('menu');
const playBtn = $('playBtn');
const menuStatus = $('menuStatus');
$('playerName').value = params.get('name') || store.get('baq_name', '');
$('serverAddr').value = store.get('baq_server', '');
$('sens').value = sens;
$('sensVal').textContent = sens.toFixed(1);
$('quality').value = quality;
$('sens').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  $('sensVal').textContent = v.toFixed(1);
  input.sensitivity = v / 1000;
  store.set('baq_sens', String(v));
});
$('quality').addEventListener('change', (e) => {
  store.set('baq_quality', e.target.value);
  location.reload();
});

function setLoad(frac, text) {
  $('loadBar').style.width = Math.round(frac * 100) + '%';
  if (text) $('loadText').textContent = text;
}

async function useMap(id) {
  if (map && map.id === id && world) return;
  if (world) world.dispose();
  if (fx) fx.dispose();
  map = getMap(id);
  world = await loadWorld(scene, map);
  fx = new Effects(scene, map, world.colliders);
  hud.setRadarMap(map, world.colliders);
  vm.baseHemi = 2.6 * map.ambient;
  vm.baseSun = 2.4 * map.sun;
  $('mapName').textContent = map.name;
}

function serverHttpBase() {
  const addr = $('serverAddr').value.trim();
  return addr ? `${location.protocol}//${addr}/` : new URL('./', location.href).href;
}

async function boot() {
  setLoad(0.05, 'loading models…');
  try {
    await preloadModels((f) => setLoad(0.05 + f * 0.5, 'loading models…'));
  } catch (e) {
    console.warn('models failed to load', e);
  }
  let info = null;
  try { info = await (await fetch(new URL('info', serverHttpBase()))).json(); } catch { /* offline */ }
  setLoad(0.6, 'building the map…');
  await useMap(info && info.map ? info.map : 'de_aq_dust');
  $('online').textContent = info ? `${info.players} player${info.players === 1 ? '' : 's'}` : '—';
  setLoad(1, 'ready');
  $('loading').classList.add('hidden');
  menu.classList.remove('hidden');
  if (params.get('autojoin')) join();
}

playBtn.addEventListener('click', join);
$('playerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

function join() {
  const name = $('playerName').value.trim() || params.get('autojoin') || 'Player';
  store.set('baq_name', name);
  store.set('baq_server', $('serverAddr').value.trim());
  connect(name);
}

async function connect(name) {
  playBtn.disabled = true;
  menuStatus.textContent = 'connecting…';
  const addr = $('serverAddr').value.trim();
  const url = addr
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${addr}/ws`
    : new URL('ws', location.href).href.replace(/^http/, 'ws');
  net.on('welcome', onWelcome);
  try {
    await net.connect(url);
    net.send({ t: 'join', name });
  } catch {
    menuStatus.textContent = 'could not connect to the game server';
    playBtn.disabled = false;
  }
}

async function onWelcome(welcome) {
  myId = welcome.id;
  await useMap(welcome.mapId);
  remotes = new Remotes(scene, fx, world);
  player = new LocalPlayer(camera, world.colliders, net, vm, fx);
  player.others = () => remotes.targets();

  roster.clear();
  for (const p of welcome.players) {
    roster.set(p.id, { id: p.id, name: p.name, team: p.team, alive: p.alive, k: p.kills || 0, d: p.deaths || 0, pos: p.pos });
    if (p.id !== myId) remotes.setTarget(p);
  }
  const me = welcome.you;
  myTeam = me.team;
  remotes.myTeam = myTeam;
  vm.setTeam(myTeam);
  if (me.alive) player.spawnAt(me.pos, me.yaw);
  else { player.state.pos = [...me.pos]; player.alive = false; }
  applyRound(welcome.round);

  menu.classList.add('hidden');
  hud.show();
  running = true;
  // ?buy=ak47,assault buys on join (warmup lets you buy anywhere) — for testing
  if (params.get('buy')) for (const item of params.get('buy').split(',')) net.send({ t: 'buy', item });
  window.__baq = { scene, camera, renderer, player, remotes, world, fx, vm, hud, net, roster, get myId() { return myId; } };
}

// ------------------------------------------------------------------ server messages

const nameOf = (id) => (roster.get(id) || { name: `#${id}`, team: 0 });

net.on('state', (msg) => {
  if (!remotes) return;
  const seen = new Set();
  for (const p of msg.players) {
    seen.add(p.id);
    const r = roster.get(p.id) || { id: p.id, name: `#${p.id}` };
    Object.assign(r, { team: p.team, alive: p.alive, k: p.k, d: p.d, pos: p.pos });
    roster.set(p.id, r);
    if (p.id === myId) continue;
    remotes.setTarget({ ...p, name: r.name });
  }
  for (const id of [...remotes.players.keys()]) if (!seen.has(id)) remotes.remove(id);
  for (const id of [...roster.keys()]) if (!seen.has(id)) roster.delete(id);
});

net.on('spawn', (msg) => {
  const p = msg.player;
  roster.set(p.id, { id: p.id, name: p.name, team: p.team, alive: p.alive, k: 0, d: 0, pos: p.pos });
  if (p.id !== myId && remotes) remotes.setTarget(p);
  if (running) hud.addChat('*', 0, `${p.name} joined ${p.team === TEAM.CT ? 'the Counter-Terrorists' : 'the Terrorists'}`);
});

net.on('despawn', (msg) => { roster.delete(msg.id); if (remotes) remotes.remove(msg.id); });

net.on('shoot', (msg) => { if (remotes && fx && msg.id !== myId) remotes.onShoot(msg, [{ id: myId, pos: player.state.pos, crouching: player.state.crouching }, ...remotes.targets()]); });

net.on('hit', (msg) => {
  if (!player) return;
  if (msg.attacker === myId && msg.victim !== myId) hud.hitMarker(msg.part === 'head');
  if (msg.victim === myId) {
    player.hp = msg.hp;
    player.armor = msg.armor;
    const dx = msg.from[0] - player.state.pos[0], dz = msg.from[2] - player.state.pos[2];
    const ang = Math.atan2(-dx, -dz) - player.state.yaw;
    hud.damageFrom(-ang);
    player.punch += 0.02; // flinch
  }
});

net.on('kill', (msg) => {
  const k = nameOf(msg.attacker), v = nameOf(msg.victim);
  hud.addKill(k, v, msg.weapon, msg.headshot, msg.attacker === myId || msg.victim === myId);
  if (msg.attacker === myId && msg.victim !== myId) player.kills++;
});

net.on('die', (msg) => {
  const r = roster.get(msg.id);
  if (r) r.alive = false;
  if (msg.id === myId && player) {
    player.alive = false;
    player.deaths++;
    player.setZoom(0);
    spectating = null;
    hud.closeBuy();
    hud.centerMsg(`killed by ${nameOf(msg.by).name}`);
    setTimeout(() => hud.centerMsg(''), 3000);
  }
});

net.on('respawn', (msg) => {
  if (!player) return;
  player.spawnAt(msg.pos, msg.yaw);
  spectating = null;
  remotes.hiddenId = null;
  hud.centerMsg('');
});

net.on('inv', (msg) => {
  if (!player) return;
  const had = player.weapon;
  player.applyInv(msg);
  if (msg.delta) hud.moneyDelta(msg.delta, msg.reason);
  if (hud.buyOpen()) hud.refreshBuy(buyContext());
  if (msg.weapon !== had) hud.showSlots(player.inv, player.weapon);
});

net.on('ammo', (msg) => { if (player) player.applyAmmo(msg); });
net.on('reload', () => {});
net.on('buy_fail', (msg) => { hud.buyFail(msg.reason); if (!hud.buyOpen()) hud.centerMsg(msg.reason); });

function applyRound(r) {
  const now = performance.now() / 1000;
  round.phase = r.phase;
  round.round = r.round;
  round.endsAt = now + (r.timer || 0);
  round.buyEndsAt = r.buyTime < 0 ? -1 : now + r.buyTime;
  hud.setPhase(r.phase, r.round);
  hud.setScore(r.scoreT, r.scoreCT);
  if (r.phase === 'warmup') hud.centerMsg('WARMUP — the match starts when both teams have a player');
  else if (r.phase === 'buy') hud.centerMsg('');
}

net.on('round', applyRound);
net.on('match_start', () => { hud.banner('MATCH START', null, 2500); if (player) { player.kills = 0; player.deaths = 0; } });

net.on('round_end', (msg) => {
  hud.setScore(msg.scoreT, msg.scoreCT);
  const who = msg.winner === TEAM.T ? 'TERRORISTS WIN' : 'COUNTER-TERRORISTS WIN';
  hud.banner(msg.matchOver ? (msg.winner === TEAM.T ? 'TERRORISTS WIN THE MATCH' : 'COUNTER-TERRORISTS WIN THE MATCH') : who, msg.winner, 4500);
});

net.on('chat', (msg) => hud.addChat(msg.name, msg.team, msg.text));

net.onClose = () => {
  running = false;
  hud.hide();
  hud.closeBuy();
  if (document.pointerLockElement) document.exitPointerLock();
  menu.classList.remove('hidden');
  playBtn.disabled = false;
  menuStatus.textContent = 'disconnected from server';
  if (remotes) remotes.clear();
};

// ------------------------------------------------------------------ UI keys

function canBuy() {
  if (!player || !player.alive || !map) return false;
  if (round.phase === 'warmup') return true;
  if (round.phase === 'end') return false;
  return performance.now() / 1000 < round.buyEndsAt && inBuyZone(map, myTeam, player.state.pos);
}

function buyContext() {
  return {
    money: player.money, team: myTeam, inv: player.inv, armor: player.armor, helmet: player.helmet,
    buyLeft: round.buyEndsAt < 0 ? -1 : round.buyEndsAt - performance.now() / 1000,
  };
}

const chatInput = $('chatInput');
chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const text = chatInput.value.trim();
    if (text) net.send({ t: 'chat', text });
    closeChat();
  } else if (e.key === 'Escape') closeChat();
});
function closeChat() {
  chatInput.value = '';
  chatInput.classList.add('hidden');
  chatInput.blur();
  input.typing = false;
}

input.onKey = (code, e, down) => {
  if (!running) return;
  if (code === 'Tab') { scoresHeld = down; return; }
  if (!down) return;
  if (code === 'KeyY' && !hud.buyOpen()) {
    e.preventDefault();
    input.typing = true;
    input.keys.clear();
    chatInput.classList.remove('hidden');
    setTimeout(() => chatInput.focus(), 0);
  } else if (code === 'KeyB') {
    if (hud.buyOpen()) { hud.closeBuy(); input.lock(); }
    else if (canBuy()) {
      hud.openBuy(buyContext(), (item) => net.send({ t: 'buy', item }));
      if (document.pointerLockElement) document.exitPointerLock();
    } else hud.centerMsg(round.phase === 'end' ? 'the round is over' : 'you can only buy in your spawn during buy time'), setTimeout(() => hud.centerMsg(''), 1800);
  } else if (code === 'Escape' && hud.buyOpen()) {
    hud.closeBuy();
  }
};

// ------------------------------------------------------------------ spectating

function spectateTargets() {
  return [...remotes.players.values()].filter((r) => r.alive && r.team === myTeam);
}

function updateSpectate(dt) {
  const list = spectateTargets();
  if (input.consumeFirePressed() || !list.find((r) => r.id === spectating)) {
    if (list.length) {
      const i = list.findIndex((r) => r.id === spectating);
      spectating = list[(i + 1) % list.length].id;
    } else spectating = null;
  }
  const r = spectating != null ? remotes.players.get(spectating) : null;
  remotes.hiddenId = r ? r.id : null;
  if (r) {
    const eye = r.tgt.crouching ? PLAYER.crouchEye : PLAYER.standEye;
    camera.position.set(r.cur.pos[0], r.cur.pos[1] + eye, r.cur.pos[2]);
    camera.rotation.set(r.cur.pitch, r.cur.yaw, 0);
    hud.setSpectate(`spectating ${r.name}  ·  click for next`);
  } else {
    overview(dt, 0.08);
    hud.setSpectate(round.phase === 'warmup' ? '' : 'waiting for the next round');
  }
}

let orbitT = 0;
function overview(dt, speed = 0.05) {
  orbitT += dt * speed;
  const b = map.bounds;
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const R = Math.min(b.x1 - b.x0, b.z1 - b.z0) * 0.42;
  camera.position.set(cx + Math.sin(orbitT) * R, 950, cz + Math.cos(orbitT) * R);
  camera.lookAt(cx, 0, cz);
}

// ------------------------------------------------------------------ game loop

let last = performance.now();
let radarT = 0;
let fpsT = 0, fpsN = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  fpsN++; fpsT += dt;
  if (fpsT >= 1) { window.__fps = fpsN / fpsT; fpsN = 0; fpsT = 0; }

  if (world) world.update(t);
  if (fx) fx.update(dt);

  if (!running || !player) {
    if (map) overview(dt);
    renderer.clear();
    renderer.render(scene, camera);
    return;
  }

  const menuOpen = hud.buyOpen();
  player.update(dt, input, { canAct: !menuOpen && input.locked && !input.typing });
  remotes.update(dt, camera.position);

  if (!player.alive) updateSpectate(dt);
  else { hud.setSpectate(''); remotes.hiddenId = null; }
  if (debugCam) { camera.position.set(debugCam[0], debugCam[1], debugCam[2]); camera.rotation.set(debugCam[4] || 0, debugCam[3] || 0, 0); }

  // ---- HUD
  const w = WEAPONS[player.weapon];
  const tNow = performance.now() / 1000;
  hud.setVitals(player.alive ? player.hp : 0, player.armor, player.helmet);
  const buyable = canBuy();
  hud.setMoney(player.money, buyable);
  const rf = player.reloading(tNow) ? (tNow - player.reloadStart) / w.reload : -1;
  hud.setWeapon(player.weapon, player.mag(), player.reserve(), rf);
  hud.setTimer(round.endsAt - tNow, round.phase);
  const scoped = player.alive && player.zoom > 0;
  hud.setScope(scoped);
  const gap = 4 + player.cone(tNow) * 3.2 + Math.min(12, player.speed() / 25);
  hud.setCrosshair(gap, player.alive && !scoped && !w.zoomFov);
  if (menuOpen && !buyable) hud.closeBuy();
  if (!input.locked && !menuOpen && !input.typing) hud.setHint('click to play');
  else hud.setHint('');

  let tA = 0, tN = 0, cA = 0, cN = 0;
  for (const r of roster.values()) {
    if (r.team === TEAM.T) { tN++; if (r.alive) tA++; } else if (r.team === TEAM.CT) { cN++; if (r.alive) cA++; }
  }
  hud.setAlive(tA, tN, cA, cN);
  if (scoresHeld) hud.showScores(true, [...roster.values()], myId);
  else hud.showScores(false);

  radarT -= dt;
  if (radarT <= 0) {
    radarT = 0.05;
    const mates = [...remotes.players.values()].filter((r) => r.alive && r.team === myTeam).map((r) => ({ pos: r.cur.pos, team: r.team }));
    const src = player.alive ? player.state.pos : [camera.position.x, 0, camera.position.z];
    hud.drawRadar(src, player.alive ? player.state.yaw : camera.rotation.y, mates);
  }

  // ---- render: world, then the viewmodel on top
  vm.visible = player.alive && !scoped;
  vm.update(dt, {
    speed: player.speed(), onGround: player.state.onGround,
    lookDX: input.lastLookX, lookDY: input.lastLookY,
    tint: world.sampleLightCached ? world.sampleLightCached : 1,
  });
  lightProbe(dt);
  renderer.clear();
  renderer.render(scene, camera);
  vm.render(renderer);
}

// the viewmodel is lit like the ground you stand on (sampled a few times/s)
let probeT = 0;
function lightProbe(dt) {
  probeT -= dt;
  if (probeT > 0 || !player.alive) return;
  probeT = 0.2;
  world.sampleLightCached = world.sampleLight(player.state.pos);
}

requestAnimationFrame(frame);
boot();
