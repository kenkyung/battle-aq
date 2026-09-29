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
import { BombView } from './bomb3d.js';
import { preloadModels, setAnisotropy } from './assets.js';
import { getMap, MAP_LIST } from '../shared/maps.js';
import { WEAPONS, TEAM, PLAYER, CROSSHAIR } from '../shared/constants.js';
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
let bombView = null;
let player = null;
let remotes = null;
let myId = null;
let myTeam = TEAM.T;
let running = false;
let leaving = false;
let round = { phase: 'warmup', endsAt: 0, buyEndsAt: -1, round: 0, practice: false };
let bomb = { state: 'none' };
const roster = new Map(); // id -> { id, name, team, alive, k, d, pos }
let spectating = null;    // id of the player we watch while dead
let scoresHeld = false;
let mode = store.get('baq_mode', 'online');
// ?cam=x,y,z,yaw,pitch pins the camera (screenshots / debugging)
const debugCam = params.get('cam') ? params.get('cam').split(',').map(Number) : null;

const sens = parseFloat(store.get('baq_sens', '2.2'));
input.sensitivity = sens / 1000;

// ------------------------------------------------------------------ menu + settings

const menu = $('menu');
const playBtn = $('playBtn');
const menuStatus = $('menuStatus');
$('playerName').value = params.get('name') || store.get('baq_name', '');
$('serverAddr').value = store.get('baq_server', '');

function bindSettings(sensId, valId, qualId) {
  $(sensId).value = input.sensitivity * 1000;
  $(valId).textContent = (input.sensitivity * 1000).toFixed(1);
  $(qualId).value = quality;
  $(sensId).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    $(valId).textContent = v.toFixed(1);
    input.sensitivity = v / 1000;
    store.set('baq_sens', String(v));
    for (const [a, b] of [['sens', 'sensVal'], ['pSens', 'pSensVal']]) { $(a).value = v; $(b).textContent = v.toFixed(1); }
  });
  $(qualId).addEventListener('change', (e) => {
    store.set('baq_quality', e.target.value);
    if (!running || confirm('Changing graphics reloads the page and leaves the match. Continue?')) location.reload();
    else $(qualId).value = quality;
  });
}
bindSettings('sens', 'sensVal', 'quality');
bindSettings('pSens', 'pSensVal', 'pQuality');

// practice options
for (const m of MAP_LIST) $('pMap').insertAdjacentHTML('beforeend', `<option value="${m.id}">${m.id.replace('de_aq_', '')}</option>`);
$('pMap').value = store.get('baq_pmap', 'de_aq_dust');
$('pTeam').value = store.get('baq_pteam', 'T');
$('pDiff').value = store.get('baq_pdiff', 'normal');
$('pBots').value = store.get('baq_pbots', '5');
$('pBotsVal').textContent = $('pBots').value;
$('pBots').addEventListener('input', (e) => { $('pBotsVal').textContent = e.target.value; });

function setMode(m) {
  mode = m;
  store.set('baq_mode', m);
  $('modeOnline').classList.toggle('on', m === 'online');
  $('modePractice').classList.toggle('on', m === 'practice');
  $('onlineOpts').classList.toggle('hidden', m !== 'online');
  $('practiceOpts').classList.toggle('hidden', m !== 'practice');
  playBtn.textContent = m === 'practice' ? 'START PRACTICE' : 'PLAY ONLINE';
  if (m === 'practice' && !running) useMap($('pMap').value);
}
$('modeOnline').addEventListener('click', () => setMode('online'));
$('modePractice').addEventListener('click', () => setMode('practice'));
$('pMap').addEventListener('change', (e) => { if (mode === 'practice' && !running) useMap(e.target.value); });

function setLoad(frac, text) {
  $('loadBar').style.width = Math.round(frac * 100) + '%';
  if (text) $('loadText').textContent = text;
}

let mapLoading = null;
async function useMap(id) {
  if (map && map.id === id && world) return;
  if (mapLoading) await mapLoading;
  if (map && map.id === id && world) return;
  mapLoading = (async () => {
    if (world) world.dispose();
    if (fx) fx.dispose();
    if (bombView) bombView.dispose();
    map = getMap(id);
    world = await loadWorld(scene, map);
    fx = new Effects(scene, map, world.colliders);
    bombView = new BombView(scene, fx);
    hud.setRadarMap(map, world.colliders);
    vm.baseHemi = 2.6 * map.ambient;
    vm.baseSun = 2.4 * map.sun;
    $('mapName').textContent = map.name;
    if (player) { player.colliders = world.colliders; player.fx = fx; }
    if (remotes) { remotes.clear(); remotes.fx = fx; remotes.world = world; }
  })();
  await mapLoading;
  mapLoading = null;
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
  const startMap = mode === 'practice' ? $('pMap').value : (info && info.map ? info.map : 'de_aq_dust');
  await useMap(startMap);
  $('online').textContent = info ? `${info.players} player${info.players === 1 ? '' : 's'}` : '—';
  setLoad(1, 'ready');
  $('loading').classList.add('hidden');
  menu.classList.remove('hidden');
  setMode(params.get('practice') ? 'practice' : mode);
  $('arcadeBtn').classList.toggle('hidden', location.pathname === '/' || location.pathname.endsWith('/index.html') && location.pathname.split('/').length <= 2);
  if (params.get('autojoin')) join();
}

playBtn.addEventListener('click', join);
$('playerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

function join() {
  const name = $('playerName').value.trim() || params.get('autojoin') || 'Player';
  store.set('baq_name', name);
  store.set('baq_server', $('serverAddr').value.trim());
  const msg = { t: 'join', name };
  if (mode === 'practice') {
    Object.assign(msg, { mode: 'practice', map: $('pMap').value, team: $('pTeam').value, bots: +$('pBots').value, difficulty: $('pDiff').value });
    store.set('baq_pmap', msg.map); store.set('baq_pteam', msg.team); store.set('baq_pdiff', msg.difficulty); store.set('baq_pbots', String(msg.bots));
  }
  connect(msg);
}

async function connect(joinMsg) {
  playBtn.disabled = true;
  leaving = false;
  menuStatus.textContent = 'connecting…';
  const addr = $('serverAddr').value.trim();
  const url = addr
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${addr}/ws`
    : new URL('ws', location.href).href.replace(/^http/, 'ws');
  net.on('welcome', onWelcome);
  try {
    await net.connect(url);
    net.send(joinMsg);
  } catch {
    menuStatus.textContent = 'could not connect to the game server';
    playBtn.disabled = false;
  }
}

async function onWelcome(welcome) {
  myId = welcome.id;
  await useMap(welcome.mapId);
  if (remotes) remotes.clear();
  remotes = new Remotes(scene, fx, world);
  player = new LocalPlayer(camera, world.colliders, net, vm, fx);
  player.others = () => remotes.targets();

  roster.clear();
  for (const p of welcome.players) {
    roster.set(p.id, { id: p.id, name: p.name, team: p.team, alive: p.alive, k: p.kills || 0, d: p.deaths || 0, pos: p.pos, bot: p.bot });
    if (p.id !== myId) remotes.setTarget(p);
  }
  setTeam(welcome.you.team);
  const me = welcome.you;
  if (me.alive) player.spawnAt(me.pos, me.yaw);
  else { player.state.pos = [...me.pos]; player.alive = false; }
  applyRound(welcome.round);
  bomb = welcome.bomb || { state: 'none' };

  menu.classList.add('hidden');
  hud.show();
  hud.hideMatchEnd();
  running = true;
  input.capture = true;
  input.lock();
  // ?buy=ak47,assault buys on join (warmup lets you buy anywhere) — for testing
  if (params.get('buy')) for (const item of params.get('buy').split(',')) net.send({ t: 'buy', item });
  window.__baq = { scene, camera, renderer, player, remotes, world, fx, vm, hud, net, roster, get bomb() { return bomb; }, get round() { return round; }, get myId() { return myId; } };
}

function setTeam(team) {
  myTeam = team;
  if (remotes) remotes.myTeam = team;
  vm.setTeam(team);
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
  if (msg.bomb) {
    const was = bomb.state;
    bomb = msg.bomb;
    if (bomb.state === 'planted') bomb.localLeft = bomb.left;
    if (was !== bomb.state && bomb.state !== 'planted') hud.hideProgress();
  }
});

net.on('spawn', (msg) => {
  const p = msg.player;
  roster.set(p.id, { id: p.id, name: p.name, team: p.team, alive: p.alive, k: 0, d: 0, pos: p.pos, bot: p.bot });
  if (p.id !== myId && remotes) remotes.setTarget(p);
  if (running && !p.bot) hud.addChat('*', 0, `${p.name} joined ${p.team === TEAM.CT ? 'the Counter-Terrorists' : 'the Terrorists'}`);
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
    player.flinch(Math.min(4, 0.6 + msg.dmg / 25)); // CS view punch on damage
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
    player.planting = player.defusing = false;
    spectating = null;
    hud.closeBuy();
    hud.hideProgress();
    hud.centerMsg(msg.weapon === 'c4' ? 'caught in the blast' : `killed by ${nameOf(msg.by).name}`);
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
  const hadC4 = player.c4;
  player.applyInv(msg);
  if (msg.delta) hud.moneyDelta(msg.delta, msg.reason);
  if (hud.buyOpen()) hud.refreshBuy(buyContext());
  if (msg.weapon !== had) hud.showSlots(player.inv, player.weapon);
  if (msg.c4 && !hadC4) { hud.centerMsg('you have the bomb — press 5, then hold fire in a bombsite'); setTimeout(() => hud.centerMsg(''), 3500); }
});

net.on('ammo', (msg) => { if (player) player.applyAmmo(msg); });
net.on('reload', () => {});
net.on('buy_fail', (msg) => { hud.buyFail(msg.reason); if (!hud.buyOpen()) { hud.centerMsg(msg.reason); setTimeout(() => hud.centerMsg(''), 1800); } });
net.on('error', (msg) => { menuStatus.textContent = msg.text; });

net.on('plant', (msg) => {
  if (msg.state === 'start') hud.progress('PLANTING THE BOMB', msg.time);
  else hud.hideProgress();
  if (msg.state === 'no_site') { hud.centerMsg('the bomb must be planted at a bombsite'); setTimeout(() => hud.centerMsg(''), 1800); }
});
net.on('defuse', (msg) => {
  if (msg.state === 'start') hud.progress(msg.time < 10 ? 'DEFUSING (KIT)' : 'DEFUSING', msg.time);
  else hud.hideProgress();
});

net.on('bomb_event', (msg) => {
  const who = nameOf(msg.by).name;
  if (msg.kind === 'planted') {
    hud.hideProgress();
    hud.banner(`BOMB PLANTED AT ${msg.site || 'SITE'}`, TEAM.T, 3000);
    bomb = { state: 'planted', pos: msg.pos, site: msg.site, left: msg.time, localLeft: msg.time };
  } else if (msg.kind === 'defused') {
    hud.hideProgress();
    hud.banner('BOMB DEFUSED', TEAM.CT, 3500);
    bomb = { state: 'defused' };
  } else if (msg.kind === 'exploded') {
    if (bombView) bombView.explode(msg.pos);
    bomb = { state: 'exploded' };
  } else if (msg.kind === 'dropped') hud.addChat('*', TEAM.T, `${who} dropped the bomb`);
  else if (msg.kind === 'picked') hud.addChat('*', TEAM.T, `${who} picked up the bomb`);
  else if (msg.kind === 'defusing' && msg.by !== myId) hud.addChat('*', TEAM.CT, `${who} is defusing${msg.kit ? ' with a kit' : ''}`);
});

function applyRound(r) {
  const now = performance.now() / 1000;
  const prev = round.phase;
  round.phase = r.phase;
  round.round = r.round;
  round.practice = !!r.practice;
  round.endsAt = now + (r.timer || 0);
  round.buyEndsAt = r.buyTime < 0 ? -1 : now + r.buyTime;
  hud.setPhase(r.phase, r.round);
  hud.setScore(r.scoreT, r.scoreCT);
  if (r.phase === 'warmup') hud.centerMsg('WARMUP — the match starts when both teams have a player');
  else if (r.phase === 'freeze') { hud.centerMsg('buy your gear: press B'); bomb = { state: 'none' }; }
  else if (prev === 'freeze' || prev === 'warmup') hud.centerMsg('');
  if (r.phase !== 'matchend') hud.hideMatchEnd();
}

net.on('round', applyRound);
net.on('match_start', () => {
  hud.banner(round.practice ? 'PRACTICE MATCH' : 'MATCH START', null, 2500);
  hud.hideMatchEnd();
  if (player) { player.kills = 0; player.deaths = 0; }
});
net.on('team', (msg) => setTeam(msg.team));
net.on('halftime', () => hud.banner('HALFTIME — SWITCHING SIDES', null, 4000));

net.on('round_end', (msg) => {
  hud.setScore(msg.scoreT, msg.scoreCT);
  const how = { bomb: 'THE BOMB EXPLODED', defuse: 'THE BOMB WAS DEFUSED', time: 'TIME RAN OUT', elim: '' }[msg.how] || '';
  const who = msg.winner === TEAM.T ? 'TERRORISTS WIN' : 'COUNTER-TERRORISTS WIN';
  hud.banner(msg.matchOver ? (msg.winner === TEAM.T ? 'TERRORISTS WIN THE MATCH' : 'COUNTER-TERRORISTS WIN THE MATCH') : who, msg.winner, 4500);
  if (how) { hud.centerMsg(how); setTimeout(() => hud.centerMsg(''), 4000); }
  hud.hideProgress();
});

net.on('match_end', (msg) => {
  if (document.pointerLockElement) document.exitPointerLock();
  hud.closeBuy();
  hud.showMatchEnd(msg, myId, (mapId) => net.send({ t: 'vote', map: mapId }));
});
net.on('votes', (msg) => hud.renderVotes(msg.tally));
net.on('map', async (msg) => {
  hud.hideMatchEnd();
  hud.banner('LOADING ' + msg.mapId.replace('de_aq_', '').toUpperCase(), null, 3000);
  await useMap(msg.mapId);
  if (remotes) remotes.clear();
  bomb = { state: 'none' };
});

net.on('chat', (msg) => hud.addChat(msg.name, msg.team, msg.text));

net.onClose = () => {
  running = false;
  input.capture = false;
  hud.hide();
  hud.closeBuy();
  hud.hideMatchEnd();
  $('pause').classList.add('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  menu.classList.remove('hidden');
  playBtn.disabled = false;
  menuStatus.textContent = leaving ? '' : 'disconnected from server';
  if (remotes) remotes.clear();
  bomb = { state: 'none' };
};

// ------------------------------------------------------------------ pause (Esc)

// Browsers always release the mouse on Esc; that is our pause key.
function pauseVisible() { return !$('pause').classList.contains('hidden'); }
function showPause(on) {
  $('pause').classList.toggle('hidden', !on);
  if (on) {
    $('pauseSub').textContent = round.practice ? 'practice vs bots' : `${roster.size} player${roster.size === 1 ? '' : 's'} online`;
    if (player && (player.planting || player.defusing)) {
      if (player.planting) net.send({ t: 'plant', on: false });
      if (player.defusing) net.send({ t: 'defuse', on: false });
      player.planting = player.defusing = false;
    }
  }
}
input.onLockChange = (locked) => {
  if (!running) return;
  if (locked) showPause(false);
  else if (!hud.buyOpen() && !input.typing && !hud.matchEndOpen()) showPause(true);
};
$('resumeBtn').addEventListener('click', () => { showPause(false); input.lock(); });
$('fullscreenBtn').addEventListener('click', async () => { try { await input.toggleFullscreen(); } catch { /* denied */ } input.lock(); });
$('leaveBtn').addEventListener('click', () => { leaving = true; showPause(false); net.close(); });
document.addEventListener('fullscreenchange', () => {
  $('fullscreenBtn').textContent = document.fullscreenElement ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
});

// ------------------------------------------------------------------ UI keys

function canBuy() {
  if (!player || !player.alive || !map) return false;
  if (round.phase === 'warmup') return true;
  if (round.phase === 'end' || round.phase === 'matchend') return false;
  return performance.now() / 1000 < round.buyEndsAt && inBuyZone(map, myTeam, player.state.pos);
}

function buyContext() {
  return {
    money: player.money, team: myTeam, inv: player.inv, armor: player.armor, helmet: player.helmet, kit: player.kit,
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
    } else { hud.centerMsg(round.phase === 'end' ? 'the round is over' : 'you can only buy in your spawn during buy time'); setTimeout(() => hud.centerMsg(''), 1800); }
  } else if (code === 'Escape') {
    if (hud.buyOpen()) { hud.closeBuy(); showPause(true); }
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

// ------------------------------------------------------------------ CS 1.6 crosshair

// cl_dll ammo.cpp: each weapon has a base gap and a per-shot kick; the gap
// grows while moving (x1.5), in the air (x2), shrinks crouched (x0.8), and
// the arms lengthen as it opens. Scaled from 640x480 to the screen.
const xhair = { dist: 4, lastShots: 0 };
function crosshair(dt) {
  const [base, delta] = CROSSHAIR[player.weapon] || [4, 3];
  let target = base;
  if (!player.state.onGround) target *= 2;
  else if (player.speed() > 140) target *= 1.5;
  if (player.state.crouching) target *= 0.8;
  if (player.shotCount !== xhair.lastShots) {
    xhair.dist = Math.min(15, xhair.dist + delta * (player.shotCount - xhair.lastShots));
    xhair.lastShots = player.shotCount;
  }
  if (xhair.dist < target) xhair.dist = target;
  else xhair.dist = Math.max(target, xhair.dist - dt * (1.2 * xhair.dist + 3));
  const scale = Math.max(1, Math.min(2.4, window.innerHeight / 480));
  const bar = ((xhair.dist - base) * 0.5 + 5) * scale;
  return { gap: xhair.dist * scale, len: bar };
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

  const menuOpen = hud.buyOpen() || pauseVisible() || hud.matchEndOpen();
  player.frozen = round.phase === 'freeze' || round.phase === 'matchend';
  player.update(dt, input, { canAct: !menuOpen && input.locked && !input.typing });
  remotes.update(dt, camera.position);
  if (bomb.state === 'planted' && bomb.localLeft !== undefined) bomb.localLeft -= dt;
  if (bombView) bombView.update(bomb, dt);

  if (!player.alive) updateSpectate(dt);
  else { hud.setSpectate(''); remotes.hiddenId = null; }
  if (debugCam) { camera.position.set(debugCam[0], debugCam[1], debugCam[2]); camera.rotation.set(debugCam[4] || 0, debugCam[3] || 0, 0); }
  // explosion shake
  if (bombView && bombView.shake > 0) {
    bombView.shake = Math.max(0, bombView.shake - dt * 1.2);
    camera.position.x += (Math.random() - 0.5) * 14 * bombView.shake;
    camera.position.y += (Math.random() - 0.5) * 14 * bombView.shake;
  }

  // ---- HUD
  const w = WEAPONS[player.weapon];
  const tNow = performance.now() / 1000;
  hud.setVitals(player.alive ? player.hp : 0, player.armor, player.helmet);
  const buyable = canBuy();
  hud.setMoney(player.money, buyable);
  const rf = player.reloading(tNow) ? (tNow - player.reloadStart) / w.reload : -1;
  hud.setWeapon(player.weapon, player.mag(), player.reserve(), rf);
  hud.setTimer(round.phase === 'planted' ? 0 : round.endsAt - tNow, round.phase);
  const scoped = player.alive && player.zoom > 0;
  hud.setScope(scoped);
  const xh = crosshair(dt);
  hud.setCrosshair(xh.gap, xh.len, player.alive && !scoped);
  if (hud.buyOpen() && !buyable) hud.closeBuy();
  hud.setHint(!input.locked && !menuOpen && !input.typing ? 'click to play' : '');
  tickBombHud();
  if (hud.matchEndOpen()) hud.tickVote();

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
    const mates = [...remotes.players.values()].filter((r) => r.alive && r.team === myTeam)
      .map((r) => ({ pos: r.cur.pos, team: r.team, c4: bomb.state === 'carried' && bomb.carrier === r.id }));
    const src = player.alive ? player.state.pos : [camera.position.x, 0, camera.position.z];
    hud.drawRadar(src, player.alive ? player.state.yaw : camera.rotation.y, mates, bomb);
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

function tickBombHud() {
  if (bomb.state === 'planted') {
    const left = Math.max(0, bomb.localLeft ?? 0);
    const interval = Math.max(0.1, Math.min(1, left / 30));
    hud.setBomb('planted', `BOMB ${bomb.site || ''}`, (performance.now() / 1000) % interval > interval * 0.5);
  } else if (player.c4) {
    hud.setBomb('carry', inSiteNow() ? 'PLANT HERE' : 'C4');
  } else hud.setBomb(null);
}

function inSiteNow() {
  if (!map || !player.alive) return false;
  return Object.values(map.bombsites || {}).some((s) => Math.hypot(player.state.pos[0] - s[0], player.state.pos[2] - s[2]) <= 240);
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
