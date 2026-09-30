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
import { HostageView } from './hostages3d.js';
import { DropView } from './drops3d.js';
import { DynWorld } from './dynworld.js';
import { Voice } from './voice.js';
import { GameConsole, keyCode, keyName, ACTIONS, DEFAULT_BINDS } from './console.js';
import { NadeView } from './nades3d.js';
import { Sfx, surfaceOf } from './sfx.js';
import { preloadModels, setAnisotropy, handsReady } from './assets.js';
import { getMap, MAP_LIST } from '../shared/maps.js';
import { WEAPONS, TEAM, PLAYER, CROSSHAIR, HOSTAGE, SKINS, FINISHES } from '../shared/constants.js';
import { inBuyZone, BUY_MENU } from '../shared/economy.js';
import { raycast, tag } from '../shared/physics.js';
import { tagModifier } from '../shared/ballistics.js';
import { RADIO } from '../shared/radio.js';
import { Snow, underWater } from './weather.js';
import { swatchURL } from './finishes.js';

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
  lowest: { ratio: 0.5, aa: false },
  low:    { ratio: 0.75, aa: false },
  medium: { ratio: 1.0,  aa: true },
  high:   { ratio: 2.0,  aa: true },
};
let quality = params.get('quality') || store.get('baq_quality', 'medium');
if (!QUALITY[quality]) quality = 'medium';
const Q = QUALITY[quality];

const container = $('game');
const renderer = new THREE.WebGLRenderer({ antialias: Q.aa, powerPreference: 'high-performance', stencil: false });
const baseRatio = quality === 'low' || quality === 'lowest' ? Math.min(window.devicePixelRatio, 1) * Q.ratio : Math.min(window.devicePixelRatio, Q.ratio);
renderer.setPixelRatio(baseRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.autoClear = false;
renderer.info.autoReset = false;
container.appendChild(renderer.domElement);
setAnisotropy(Math.min(quality === 'lowest' ? 1 : quality === 'low' ? 2 : 8, renderer.capabilities.getMaxAnisotropy()));

// GPU time per frame (M18), where the browser exposes timer queries
const gpuTimer = (() => {
  const gl = renderer.getContext();
  const ext = gl.getExtension && gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const t = { ms: null, begin() {}, end() {} };
  if (!ext) return t;
  let q = null, pending = [];
  t.begin = () => { if (!netGraph || q) return; q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); };
  t.end = () => {
    if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q); q = null; }
    while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const p = pending.shift();
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) { const ms = gl.getQueryParameter(p, gl.QUERY_RESULT) / 1e6; t.ms = t.ms === null ? ms : t.ms + (ms - t.ms) * 0.1; }
      gl.deleteQuery(p);
    }
  };
  return t;
})();

// Dynamic resolution (M17): if frames take longer than the target (60 fps,
// or fps_max), render fewer pixels; give them back when there is headroom.
// Checked twice a second, so the canvas is not resized every frame.
const dyn = { on: true, min: 0.5, scale: 1, acc: 0, n: 0, t: 0 };
function dynamicResolution(frameMs) {
  if (!dyn.on) { if (dyn.scale !== 1) { dyn.scale = 1; renderer.setPixelRatio(baseRatio); } return; }
  dyn.acc += frameMs; dyn.n++;
  const now = performance.now();
  if (now - dyn.t < 500 || dyn.n < 10) return;
  const avg = dyn.acc / dyn.n;
  dyn.acc = 0; dyn.n = 0; dyn.t = now;
  const target = 1000 / (fpsMax > 0 ? fpsMax : 60);
  let s = dyn.scale;
  if (avg > target * 1.12) s = Math.max(dyn.min, s * 0.88);
  else if (avg < target * 0.8 && s < 1) s = Math.min(1, s * 1.06);
  if (Math.abs(s - dyn.scale) > 0.01) { dyn.scale = s; renderer.setPixelRatio(baseRatio * s); }
}

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
const sfx = new Sfx();
window.__sfx = sfx;
sfx.setVolume(parseFloat(store.get('baq_vol', '0.8')));
sfx.radioOn = store.get('baq_radio', '1') === '1';
// browsers start audio only after a gesture
const unlockAudio = () => { sfx.unlock(); if (map && !sfx.ambient) sfx.startAmbience(map.id); };
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

let map = null;
let world = null;
let fx = null;
let bombView = null;
let hostageView = null;
let dropView = null;
let dynWorld = null;
let useHint = '';
const hostageTally = { rescued: 0, killed: 0 };
function hostageCount() {
  const total = (map && map.hostages ? map.hostages.length : 0);
  return { total, rescued: hostageTally.rescued, killed: hostageTally.killed };
}
let nadeView = null;
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
    store.set('cvar_sensitivity', (input.sensitivity / (0.022 * Math.PI / 180)).toFixed(2));
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
for (const [vid, lid, rid] of [['vol', 'volVal', 'radioOn'], ['pVol', 'pVolVal', 'pRadioOn']]) {
  $(vid).value = sfx.volume; $(lid).textContent = Math.round(sfx.volume * 100) + '%';
  $(rid).checked = sfx.radioOn;
  $(vid).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    sfx.setVolume(v); store.set('baq_vol', String(v));
    for (const [a, b] of [['vol', 'volVal'], ['pVol', 'pVolVal']]) { $(a).value = v; $(b).textContent = Math.round(v * 100) + '%'; }
    sfx.play('hitmark', { volume: 0.8 });
  });
  $(rid).addEventListener('change', (e) => {
    sfx.radioOn = e.target.checked; store.set('baq_radio', e.target.checked ? '1' : '0');
    $('radioOn').checked = $('pRadioOn').checked = e.target.checked;
  });
}
let fsOn = store.get('baq_fs', '1') === '1';
$('fsOn').checked = fsOn;
$('fsOn').addEventListener('change', (e) => { fsOn = e.target.checked; store.set('baq_fs', fsOn ? '1' : '0'); });
// last line of defence when not fullscreen: Ctrl+W asks before closing the match
window.addEventListener('beforeunload', (e) => { if (running && !leaving) { e.preventDefault(); e.returnValue = ''; } });

function surfaceAt(pos) {
  if (!world) return 'sand';
  const hit = raycast([pos[0], pos[1] + 4, pos[2]], [0, -1, 0], world.colliders, 40);
  return hit ? surfaceOf(hit.box.mat, map.id) : 'sand';
}

// practice options
const mapLabel = (id) => id.replace(/^(de|cs)_aq_/, '').replace(/^fy_aq_/, 'fy_');
for (const m of MAP_LIST) $('pMap').insertAdjacentHTML('beforeend', `<option value="${m.id}">${mapLabel(m.id)}</option>`);
$('pMap').value = params.get('map') || store.get('baq_pmap', 'de_aq_dust');
$('gRules').value = params.get('rules') || store.get('baq_rules', 'casual');
$('pTeam').value = params.get('team') || store.get('baq_pteam', 'T');
$('pDiff').value = store.get('baq_pdiff', 'normal');
$('pBots').value = store.get('baq_pbots', '5');
$('oSize').value = store.get('baq_osize', '5');
$('pBotsVal').textContent = $('pBots').value;
$('pBots').addEventListener('input', (e) => { $('pBotsVal').textContent = e.target.value; });

function setMode(m) {
  mode = m;
  store.set('baq_mode', m);
  $('modeOnline').classList.toggle('on', m === 'online');
  $('modePractice').classList.toggle('on', m === 'practice');
  $('onlineOpts').classList.toggle('hidden', m !== 'online');
  $('oSizeWrap').classList.toggle('hidden', m !== 'online');
  $('sideOpts').classList.toggle('hidden', m !== 'practice');
  $('practiceOpts').classList.toggle('hidden', m !== 'practice');
  playBtn.textContent = m === 'practice' ? 'START PRACTICE' : 'PLAY ONLINE';
  if (!running) useMap($('pMap').value);
}
$('modeOnline').addEventListener('click', () => setMode('online'));
$('modePractice').addEventListener('click', () => setMode('practice'));
$('pMap').addEventListener('change', (e) => { store.set('baq_pmap', e.target.value); showOnline(); if (!running) useMap(e.target.value); });
let serverInfo = null;
function showOnline() {
  if (!serverInfo) { $('online').textContent = '—'; return; }
  const here = serverInfo.byMap ? serverInfo.byMap[$('pMap').value] || 0 : serverInfo.players;
  $('online').textContent = `${here} on this map · ${serverInfo.players} total`;
  for (const o of $('pMap').options) {
    const n = serverInfo.byMap ? serverInfo.byMap[o.value] || 0 : 0;
    o.textContent = mapLabel(o.value) + (n ? ` (${n} playing)` : '');
  }
}

function setLoad(frac, text) {
  $('loadBar').style.width = Math.round(frac * 100) + '%';
  if (text) $('loadText').textContent = text;
}

let mapLoading = null;
// ------------------------------------------------------------------ weapon finishes (M21)

let finPicks = {};
try { finPicks = JSON.parse(store.get('baq_fin', '{}')) || {}; } catch { finPicks = {}; }
function sendFinishes() { if (net && net.ws) net.send({ t: 'finishes', f: finPicks }); }
function setFinish(weapon, idx) {
  if (idx === null || idx === undefined || (weapon !== '*' && idx === -1)) delete finPicks[weapon];
  else finPicks[weapon] = idx;
  store.set('baq_fin', JSON.stringify(finPicks));
  sendFinishes();
  drawFinishes();
}
const FIN_WEAPONS = Object.entries(WEAPONS).filter(([, w]) => (w.slot === 'primary' || w.slot === 'secondary' || w.melee) && !w.bomb);
$('finWeapon').innerHTML = '<option value="*">All weapons</option>'
  + FIN_WEAPONS.map(([id, w]) => `<option value="${id}">${w.name || id}</option>`).join('');
function drawFinishes() {
  const wid = $('finWeapon').value;
  const cur = finPicks[wid] !== undefined ? finPicks[wid] : wid === '*' ? 0 : -1;
  const allIdx = finPicks['*'] || 0;
  $('finSwatches').innerHTML = (wid === '*' ? [] : [[-1, `Same as all (${FINISHES[allIdx].name})`]]).concat(FINISHES.map((f, i) => [i, f.name]))
    .map(([i, name]) => {
      const url = i >= 0 ? swatchURL(i) : null;
      const cls = `fsw${i === cur ? ' on' : ''}${i >= 0 && FINISHES[i].id === 'gold' ? ' gold' : ''}${i < 0 ? ' inherit' : ''}`;
      return `<button class="${cls}" data-i="${i}"><i${url ? ` style="background-image:url(${url})"` : ''}></i>${name}</button>`;
    }).join('');
  for (const b of $('finSwatches').querySelectorAll('.fsw')) b.addEventListener('click', () => setFinish(wid, parseInt(b.dataset.i, 10)));
}
$('finWeapon').addEventListener('change', drawFinishes);
$('finBox').addEventListener('toggle', () => { if ($('finBox').open) drawFinishes(); });

// "Connection problem" (nothing from the server for a second, like CS's
// warning) and a lag badge when latency or jitter is high
let connWarnOn = false, lagOn = false;
function connIndicators() {
  const quiet = running && !reconnecting && !net.fake ? (performance.now() - net.lastMsgAt) / 1000 : 0;
  const warn = quiet > 1;
  if (warn !== connWarnOn) { connWarnOn = warn; $('connWarn').classList.toggle('hidden', !warn); }
  if (warn) $('connWarnT').textContent = quiet.toFixed(1) + ' s';
  const me = roster.get(myId);
  const ping = me && me.ping || 0;
  const lag = running && !net.fake && (ping > 150 || jitter > 0.03);
  if (lag !== lagOn) { lagOn = lag; $('lagIcon').classList.toggle('hidden', !lag); }
  if (lag) $('lagIcon').textContent = `LAG ${ping} ms · jitter ${Math.round(jitter * 1000)} ms`;
}

let snowFx = null, uwOn = false;
// weather + under-water tint, every frame before the scene renders
function envFx(dt) {
  if (snowFx) snowFx.update(dt, camera.position);
  const uw = underWater(map, camera.position);
  if (uw !== uwOn) { uwOn = uw; $('underwater').classList.toggle('hidden', !uw); if (sfx.setMuffle) sfx.setMuffle(uw); }
}

async function useMap(id) {
  if (map && map.id === id && world) return;
  if (mapLoading) await mapLoading;
  if (map && map.id === id && world) return;
  mapLoading = (async () => {
    if (world) world.dispose();
    if (fx) fx.dispose();
    if (bombView) bombView.dispose();
    if (hostageView) hostageView.dispose();
    if (dropView) dropView.dispose();
    if (dynWorld) dynWorld.dispose();
    map = getMap(id);
    if (player) player.map = map;
    if (snowFx) { snowFx.dispose(); snowFx = null; }
    if (map.snow) snowFx = new Snow(scene);
    world = await loadWorld(scene, map);
    fx = new Effects(scene, map, world.colliders);
    fx.sfx = sfx;
    fx.surfaceOf = (mat) => surfaceOf(mat, map.id);
    bombView = new BombView(scene, fx);
    hostageView = new HostageView(scene, world);
    dropView = new DropView(scene, world);
    dynWorld = new DynWorld(scene, map, world.colliders, world);
    if (map.rescueZones) hostageView.setZones(map.rescueZones);
    if (nadeView) nadeView.clear();
    nadeView = new NadeView(scene, fx, sfx, world.colliders);
    sfx.colliders = world.colliders;
    if (sfx.ctx) sfx.startAmbience(map.id);
    hud.setRadarMap(map, world.colliders);
    vm.baseHemi = 2.6 * map.ambient;
    vm.baseSun = 2.4 * map.sun;
    if (player) { player.colliders = world.colliders; player.fx = fx; }
    if (remotes) { remotes.clear(); remotes.fx = fx; remotes.world = world; }
    if (player) { player.fx = fx; }
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
  serverInfo = info;
  showOnline();
  await useMap($('pMap').value);
  setLoad(1, 'ready');
  $('loading').classList.add('hidden');
  menu.classList.remove('hidden');
  setMode(params.get('practice') ? 'practice' : mode);
  $('arcadeBtn').classList.toggle('hidden', location.pathname === '/' || location.pathname.endsWith('/index.html') && location.pathname.split('/').length <= 2);
  if (params.get('autojoin')) join();
}

playBtn.addEventListener('click', join);
$('playerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

function join(extra = {}) {
  // grab the mouse now, inside the click: browsers only allow pointer lock
  // from a user gesture, and it puts the focus straight on the game
  sfx.unlock();
  // fullscreen + keyboard lock: the only way Ctrl+W/T/N and Esc reach the game
  // instead of the browser (plain windowed pages can never block them)
  if (fsOn && !params.get('autojoin')) input.enterFullscreen().then(() => input.lock(), () => {});
  input.lock();
  renderer.domElement.focus();
  const name = $('playerName').value.trim() || params.get('autojoin') || 'Player';
  store.set('baq_name', name);
  store.set('baq_server', $('serverAddr').value.trim());
  store.set('baq_osize', $('oSize').value);
  store.set('baq_rules', $('gRules').value);
  const msg = { t: 'join', name, map: $('pMap').value, size: +$('oSize').value, rules: $('gRules').value };
  if (mode === 'practice') {
    Object.assign(msg, { mode: 'practice', map: $('pMap').value, team: $('pTeam').value, bots: +$('pBots').value, difficulty: $('pDiff').value });
    store.set('baq_pmap', msg.map); store.set('baq_pteam', msg.team); store.set('baq_pdiff', msg.difficulty); store.set('baq_pbots', String(msg.bots));
  }
  if (extra && typeof extra === 'object' && !(extra instanceof Event)) Object.assign(msg, extra);
  connect(msg);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ server browser + leaderboard (M16)

const httpBase = () => {
  const addr = $('serverAddr').value.trim();
  return addr ? `${location.protocol}//${addr}/` : new URL('.', location.href).href;
};
async function refreshRooms() {
  try {
    const list = await (await fetch(httpBase() + 'rooms')).json();
    $('roomList').innerHTML = list.length ? list.map((r) => `<button class="room" data-room="${r.id}" data-locked="${r.locked ? 1 : 0}">`
      + `<b>${esc(r.name)}</b> <span>${esc(r.map.replace(/^(de|cs)_aq_/, ''))} · ${esc(r.rules)}</span>`
      + `<em>${r.humans} + ${r.bots} bots${r.locked ? ' · 🔒' : ''}</em></button>`).join('') : '<div class="dim">no rooms yet — create one</div>';
    for (const b of document.querySelectorAll('#roomList .room')) {
      b.addEventListener('click', () => {
        const password = b.dataset.locked === '1' ? prompt('Room password?') || '' : '';
        join({ room: b.dataset.room, password });
      });
    }
  } catch { $('roomList').textContent = 'could not reach the server'; }
}
async function refreshStats() {
  try {
    const rows = await (await fetch(httpBase() + 'stats')).json();
    $('statsList').innerHTML = rows.length ? '<table class="lb"><tr><th></th><th>name</th><th>kills</th><th>K/D</th><th>HS%</th><th>wins</th></tr>'
      + rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.kills}</td><td>${r.kd}</td><td>${r.hsp}</td><td>${r.wins}</td></tr>`).join('') + '</table>'
      : '<div class="dim">no stats yet</div>';
  } catch { $('statsList').textContent = 'could not reach the server'; }
}
$('browserBox').addEventListener('toggle', (e) => { if (e.target.open) refreshRooms(); });
$('statsBox').addEventListener('toggle', (e) => { if (e.target.open) refreshStats(); });
$('roomsRefresh').addEventListener('click', refreshRooms);
$('crGo').addEventListener('click', () => join({ create: {
  name: $('crName').value.trim() || `${$('playerName').value.trim() || 'Player'}'s room`, map: $('pMap').value, rules: $('gRules').value,
  fill: +$('oSize').value, roundtime: +$('crRound').value, winlimit: +$('crWin').value, ff: $('crFF').checked, password: $('crPass').value,
  difficulty: $('pDiff').value,
} }));

let lastJoin = null, resumeInfo = null, kicked = false, reconnecting = null;
function serverWsUrl() {
  const addr = $('serverAddr').value.trim();
  return addr
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${addr}/ws`
    : new URL('ws', location.href).href.replace(/^http/, 'ws');
}
// leaving on purpose: tell the server so it does not hold a resume slot
function leave() { leaving = true; net.send({ t: 'bye' }); net.close(); }
window.addEventListener('pagehide', () => { if (running) net.send({ t: 'bye' }); });

// ------------------------------------------------------------------ reconnect
//
// A dropped connection is not the end: the server holds our player for 45 s
// (team, money, guns, score). Retry every couple of seconds with the resume
// token; the game stays on screen behind a "reconnecting" notice.
const RESUME_WINDOW = 45;
function startReconnect() {
  const t0 = performance.now();
  let attempt = 0;
  reconnecting = { t0 };
  $('reconnect').classList.remove('hidden');
  input.capture = false;
  if (document.pointerLockElement) document.exitPointerLock();
  const tick = async () => {
    if (!reconnecting) return;
    const left = RESUME_WINDOW - (performance.now() - t0) / 1000;
    if (left <= 0) { giveUp(); return; }
    attempt++;
    $('reconnectText').textContent = `Connection lost — reconnecting (attempt ${attempt}, ${Math.ceil(left)} s left)…`;
    try {
      await net.connect(serverWsUrl());
      net.send({ ...lastJoin, resume: resumeInfo.token, room: resumeInfo.room });
      // the welcome ends it (onWelcome); if it never comes the socket closes and we retry
      reconnecting.timer = setTimeout(() => { if (reconnecting) { net.close(); } }, 6000);
    } catch {
      reconnecting.timer = setTimeout(tick, Math.min(4000, 800 + attempt * 600));
    }
  };
  reconnecting.retry = tick;
  tick();
}
function giveUp() {
  reconnecting = null;
  $('reconnect').classList.add('hidden');
  teardown('lost connection to the server');
}
$('reconnectLeave').addEventListener('click', () => { if (reconnecting) { clearTimeout(reconnecting.timer); reconnecting = null; $('reconnect').classList.add('hidden'); leaving = true; net.close(); teardown(''); } });

async function connect(joinMsg) {
  playBtn.disabled = true;
  leaving = false;
  kicked = false;
  lastJoin = joinMsg;
  menuStatus.textContent = 'connecting…';
  const url = serverWsUrl();
  net.on('welcome', onWelcome);
  try {
    await net.connect(url);
    net.send(joinMsg);
  } catch {
    menuStatus.textContent = 'could not connect to the game server';
    playBtn.disabled = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

let lastWelcome = null;
async function onWelcome(welcome) {
  lastWelcome = welcome;
  if (welcome.token && !net.fake) resumeInfo = { token: welcome.token, room: welcome.room };
  if (reconnecting) {
    clearTimeout(reconnecting.timer);
    reconnecting = null;
    $('reconnect').classList.add('hidden');
    input.capture = true;
    input.lock();
    hud.centerMsg('reconnected'); setTimeout(() => hud.centerMsg(''), 1500);
  }
  myId = welcome.id;
  await useMap(welcome.mapId);
  if (remotes) remotes.clear();
  remotes = new Remotes(scene, fx, world);
  remotes.renderTime = viewTime;
  remotes.sfx = sfx;
  remotes.listenerNear = (p, d) => Math.hypot(p[0] - camera.position.x, p[2] - camera.position.z) < d;
  remotes.surfaceAt = surfaceAt;
  player = new LocalPlayer(camera, world.colliders, net, vm, fx);
  player.map = map;
  player.hostageMode = round.mode === 'hostage';
  player.viewTime = viewTime;
  player.others = () => remotes.targets().concat(hostageView ? hostageView.targets() : []);
  player.bodies = () => remotes.bodies();
  player.surfaceAt = surfaceAt;
  player.sound = (name, opts = {}) => {
    if (name === 'step') name = `step_${opts.surface || 'sand'}_${Math.floor(Math.random() * 4)}`;
    sfx.play(name, opts);
  };

  roster.clear();
  for (const p of welcome.players) {
    roster.set(p.id, { id: p.id, name: p.name, team: p.team, alive: p.alive, k: p.kills || 0, d: p.deaths || 0, pos: p.pos, bot: p.bot });
    if (p.id !== myId) remotes.setTarget(p);
  }
  setTeam(welcome.you.team);
  if (savedSkin(welcome.you.team) >= 0) sendSkin(welcome.you.team, savedSkin(welcome.you.team));
  sendFinishes();
  mySkin = welcome.you.skin || 0;
  applyMySkin();
  remotes.minModels = minModels;
  const me = welcome.you;
  if (me.alive) player.spawnAt(me.pos, me.yaw);
  else { player.state.pos = [...me.pos]; player.alive = false; }
  applyRound(welcome.round);
  bomb = welcome.bomb || { state: 'none' };
  for (const s of welcome.smokes || []) nadeView.addSmoke(s.pos, s.left);

  menu.classList.add('hidden');
  hud.show();
  hud.hideMatchEnd();
  running = true;
  showMotd(welcome.motd);
  if (dynWorld) {
    for (const [id, open] of Object.entries(welcome.doors || {})) dynWorld.setDoor(id, open, true);
    for (const id of welcome.glassBroken || []) dynWorld.breakGlass(id);
  }
  input.capture = true;
  input.lock();
  // ?buy=ak47,assault buys on join (warmup lets you buy anywhere) — for testing
  if (params.get('buy')) for (const item of params.get('buy').split(',')) net.send({ t: 'buy', item });
  window.__baq = { scene, camera, renderer, player, remotes, world, fx, vm, hud, net, roster, sfx, get bomb() { return bomb; }, get round() { return round; }, get myId() { return myId; } };
}

function setTeam(team) {
  myTeam = team;
  if (remotes) remotes.myTeam = team;
  vm.setTeam(team);
}

// ------------------------------------------------------------------ server messages

const nameOf = (id) => (roster.get(id) || { name: `#${id}`, team: 0 });

// net_graph: fps, latency, rates, bandwidth — once a second
const netStats = { snaps: 0, frames: 0, t: performance.now(), lastIn: 0, lastOut: 0, text: '', cpu: 0 };
let netGraph = store.get('baq_netgraph', '0') === '1';
$('ngOn').checked = netGraph;
$('ngOn').addEventListener('change', (e) => { netGraph = e.target.checked; store.set('baq_netgraph', netGraph ? '1' : '0'); });
function updateNetGraph() {
  netStats.frames++;
  const nowMs = performance.now();
  if (nowMs - netStats.t < 1000) return;
  const s = (nowMs - netStats.t) / 1000;
  const me = roster.get(myId);
  const ri = { calls: netStats.calls || 0, triangles: netStats.tris || 0 };
  netStats.text = `fps ${Math.round(netStats.frames / s)}  ping ${me && me.ping !== undefined ? me.ping : '?'} ms  cpu ${netStats.cpu.toFixed(1)} ms\n`
    + `draws ${ri.calls}  tris ${(ri.triangles / 1000).toFixed(0)}k  res ${Math.round(dyn.scale * 100)}%${gpuTimer.ms !== null ? `  gpu ${gpuTimer.ms.toFixed(1)} ms` : ''}\n`
    + `in ${((net.bytesIn - netStats.lastIn) / s / 1024).toFixed(1)} k/s  out ${((net.bytesOut - netStats.lastOut) / s / 1024).toFixed(1)} k/s\n`
    + `updaterate ${Math.round(netStats.snaps / s)}/${round.updaterate || '?'}  tickrate ${round.tickrate || '?'}  interp ${Math.round(interp * 1000)} ms  jitter ${Math.round(jitter * 1000)} ms  pending ${player ? player.pending.length : 0}`;
  netStats.snaps = 0; netStats.frames = 0; netStats.t = nowMs;
  netStats.lastIn = net.bytesIn; netStats.lastOut = net.bytesOut;
  const el = document.getElementById('netgraph');
  if (el) { el.classList.toggle('hidden', !netGraph); el.textContent = netStats.text; }
}

// server clock: the snapshot timeline, offset from ours by the smallest
// observed delay (a max filter that slowly forgets, so drift is followed)
let clockOffset = null;
let interp = 0.1;                                    // cl_interp (adaptive)
let jitter = 0, lastSnapAt = 0;                      // snapshot arrival jitter (s)
const serverNow = () => performance.now() / 1000 + (clockOffset || 0);
const viewTime = () => serverNow() - interp;
net.on('state', (msg) => {
  if (!remotes) return;
  if (Number.isFinite(msg.ts)) {
    const sample = msg.ts - performance.now() / 1000;
    clockOffset = clockOffset === null ? sample : Math.max(sample, clockOffset - 0.002);
    netStats.snaps++;
    // adaptive interpolation: the buffer must cover the gaps the network
    // actually has — grow quickly when snapshots arrive unevenly, shrink
    // slowly back toward two update intervals when it calms down
    const nowS = performance.now() / 1000, rate = round.updaterate || 30;
    if (lastSnapAt) jitter += (Math.min(0.5, Math.abs(nowS - lastSnapAt - 1 / rate)) - jitter) * 0.08;
    lastSnapAt = nowS;
    const target = Math.max(0.05, Math.min(0.25, 2 / rate + 0.015 + jitter * 2.5));
    interp += (target - interp) * (target > interp ? 0.25 : 0.015);
  }
  const seen = new Set();
  for (const p of msg.players) {
    seen.add(p.id);
    const r = roster.get(p.id) || { id: p.id, name: `#${p.id}` };
    if (p.hid) {
      // out of sight and far (server PVS): keep the roster entry, hide the model
      Object.assign(r, { team: p.team, alive: p.alive !== false, dc: p.dc });
      if (p.k !== undefined) Object.assign(r, { k: p.k, d: p.d, ping: p.ping, bot: p.bot, afk: p.afk });
      roster.set(p.id, r);
      if (remotes.players.has(p.id)) remotes.hide(p.id);
      continue;
    }
    Object.assign(r, { team: p.team, alive: p.alive, pos: p.pos, c4: p.c4, vip: p.vip, dc: undefined });
    if (p.k !== undefined) Object.assign(r, { k: p.k, d: p.d, ping: p.ping, bot: p.bot, afk: p.afk });   // only in full snapshots
    if (r.k === undefined) { r.k = 0; r.d = 0; }
    roster.set(p.id, r);
    if (p.id === myId) continue;
    remotes.setTarget({ ...p, name: r.name }, msg.ts);
  }
  for (const id of [...remotes.players.keys()]) if (!seen.has(id)) remotes.remove(id);
  for (const id of [...roster.keys()]) if (!seen.has(id)) roster.delete(id);
  if (hostageView) hostageView.sync(msg.hostages || []);
  if (dropView) dropView.sync(msg.drops || []);
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

// the server refused a step (through a wall / into a player): back to where it has us
net.on('correct', (msg) => {
  if (!player || !player.alive || !Array.isArray(msg.pos)) return;
  player.state.pos = msg.pos.slice();
  player.state.vel = [0, Math.min(0, player.state.vel[1]), 0];
});

net.on('hit', (msg) => {
  if (!player) return;
  if (msg.attacker === myId && msg.victim !== myId) { hud.hitMarker(msg.part === 'head'); sfx.play('hitmark', { volume: 0.5 }); }
  if (msg.weapon !== 'c4') {
    if (msg.part === 'head' && msg.helmet) sfx.playAt('helmet', msg.point, { volume: 0.9, ref: 200, max: 3000 });
    else if (msg.victim !== myId) sfx.playAt(msg.weapon === 'knife' ? 'knife_hit' : 'hit_flesh', msg.point, { volume: 0.7, ref: 120, max: 1800 });
  }
  // friendly fire: CS prints who attacked a teammate
  if (msg.team && msg.attacker !== msg.victim && msg.weapon !== 'hegrenade') {
    const a = roster.get(msg.attacker);
    if (a && (!teamAttackAt[a.id] || performance.now() - teamAttackAt[a.id] > 3000)) { teamAttackAt[a.id] = performance.now(); hud.addChat('*', a.team, `${a.name} attacked a teammate`); }
  }
  if (msg.victim === myId) {
    player.hp = msg.hp;
    player.armor = msg.armor;
    const dx = msg.from[0] - player.state.pos[0], dz = msg.from[2] - player.state.pos[2];
    const ang = Math.atan2(-dx, -dz) - player.state.yaw;
    hud.damageFrom(-ang);
    if (!(msg.part === 'head' && msg.helmet)) sfx.play(msg.weapon === 'knife' ? 'knife_hit' : 'hit_flesh', { volume: 0.9 });
    player.flinch(Math.min(4, 0.6 + msg.dmg / 25)); // CS view punch on damage
    if (msg.attacker !== myId) tag(player.state, tagModifier(msg.weapon, msg.part, player.state.crouching));
  }
});

const teamAttackAt = {};
net.on('kill', (msg) => {
  const k = nameOf(msg.attacker), v = nameOf(msg.victim);
  hud.addKill(k, v, msg.weapon, msg.headshot, msg.attacker === myId || msg.victim === myId, msg.wallbang);
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

let lastInv = null;
net.on('inv', (msg) => {
  lastInv = msg;
  if (!player) return;
  const had = player.weapon;
  const hadC4 = player.c4;
  player.applyInv(msg);
  if (msg.delta) {
    hud.moneyDelta(msg.delta, msg.reason);
    if (msg.delta < 0) sfx.play('buy', { volume: 0.6 });
    else if (msg.reason === 'kill') sfx.play('money', { volume: 0.35 });
  }
  if (hud.buyOpen()) hud.refreshBuy(buyContext());
  if (msg.weapon !== had) hud.showSlots(player.inv, player.weapon);
  if (msg.c4 && !hadC4) { hud.centerMsg('you have the bomb — press 5, then hold fire in a bombsite'); setTimeout(() => hud.centerMsg(''), 3500); }
});

net.on('ammo', (msg) => { if (player) player.applyAmmo(msg); });
net.on('mode', (msg) => {
  if (!player) return;
  player.applyMode(msg);
  const label = { silenced: 'silencer on', burst: 'switched to burst-fire mode' }[msg.mode]
    || (WEAPONS[msg.weapon].alt === 'burst' ? 'switched to ' + (WEAPONS[msg.weapon].auto ? 'full auto' : 'semi-automatic') : 'silencer off');
  hud.centerMsg(label); setTimeout(() => hud.centerMsg(''), 1200);
});
net.on('pmode', (msg) => { const r = remotes && remotes.players.get(msg.id); if (r) remotes.setWeapon(r, msg.weapon, msg.mode); });
net.on('pickup', (msg) => { sfx.play('deploy', { volume: 0.6 }); hud.addChat('*', 0, `picked up: ${WEAPONS[msg.weapon].name}`); });
net.on('reload', () => {});
net.on('buy_fail', (msg) => { hud.buyFail(msg.reason); if (!hud.buyOpen()) { hud.centerMsg(msg.reason); setTimeout(() => hud.centerMsg(''), 1800); } });
net.on('error', (msg) => { menuStatus.textContent = msg.text; kicked = true; });   // kicked / banned / full: no reconnect

let keyTimer = null;
function keypad(on, time = 3, alt = false) {
  clearInterval(keyTimer); keyTimer = null;
  if (!on) return;
  let i = 0;
  keyTimer = setInterval(() => {
    sfx.play(alt ? 'defuse_tick' : (i++ % 2 ? 'key2' : 'key'), { volume: 0.6 });
  }, alt ? 500 : Math.max(200, (time * 1000) / 7));
}
net.on('plant', (msg) => {
  if (msg.state === 'start') hud.progress('PLANTING THE BOMB', msg.time);
  else hud.hideProgress();
  keypad(msg.state === 'start', msg.time);
  if (msg.state === 'no_site') { hud.centerMsg('the bomb must be planted at a bombsite'); setTimeout(() => hud.centerMsg(''), 1800); }
});
net.on('defuse', (msg) => {
  if (msg.state === 'start') hud.progress(msg.time < 10 ? 'DEFUSING (KIT)' : 'DEFUSING', msg.time);
  else hud.hideProgress();
  keypad(msg.state === 'start', msg.time, true);
});

net.on('bomb_event', (msg) => {
  const who = nameOf(msg.by).name;
  if (msg.kind === 'planted') {
    hud.hideProgress();
    hud.banner(`BOMB PLANTED AT ${msg.site || 'SITE'}`, TEAM.T, 3000);
    bomb = { state: 'planted', pos: msg.pos, site: msg.site, left: msg.time, localLeft: msg.time };
    keypad(false);
    sfx.playAt('armed', msg.pos, { volume: 0.8, ref: 200 });
    sfx.radio('Bomb has been planted');
  } else if (msg.kind === 'defused') {
    hud.hideProgress();
    hud.banner('BOMB DEFUSED', TEAM.CT, 3500);
    bomb = { state: 'defused' };
    keypad(false);
    sfx.radio('Bomb has been defused');
  } else if (msg.kind === 'exploded') {
    if (bombView) bombView.explode(msg.pos);
    sfx.playAt('explosion', msg.pos, { volume: 1, ref: 1400, max: 20000, occlude: false, jitter: 0 });
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
  round.mode = r.mode || 'bomb';
  round.rulesName = r.rulesName || '';
  round.rules = r.rules;
  round.c4timer = r.c4timer;
  round.maxRounds = r.maxRounds;
  round.friendlyfire = !!r.friendlyfire;
  // cl_interp starts at two update intervals plus slack; it then adapts to
  // the measured jitter (see the 'state' handler)
  if (r.updaterate && !round.updaterate) interp = Math.max(0.05, Math.min(0.1, 2 / r.updaterate + 0.015));
  round.tickrate = r.tickrate; round.updaterate = r.updaterate;
  if (r.phase === 'freeze' || r.phase === 'warmup') { hostageTally.rescued = 0; hostageTally.killed = 0; }
  if (player) player.hostageMode = round.mode === 'hostage';
  if (r.rescueZones && hostageView) hostageView.setZones(r.rescueZones);
  if (r.escape && hostageView) hostageView.setZones([r.escape]);           // VIP escape zone ring
  round.vip = r.vip;
  hud.setHostages(round.mode === 'hostage' ? hostageCount() : null);
  hud.setPhase(r.phase, r.round);
  hud.setScore(r.scoreT, r.scoreCT);
  if (r.phase === 'warmup') hud.centerMsg('WARMUP — the match starts when both teams have a player');
  else if (r.phase === 'freeze') {
    hud.centerMsg(round.mode === 'hostage' && myTeam === TEAM.CT ? 'buy your gear (B), then rescue the hostages: walk up and press E'
      : round.mode === 'hostage' ? 'buy your gear (B), then guard the hostages' : 'buy your gear: press B');
    bomb = { state: 'none' };
    if (nadeView) nadeView.clear();
  }
  else if (prev === 'freeze' || prev === 'warmup') hud.centerMsg('');
  if (prev === 'freeze' && r.phase === 'round') sfx.radio(Math.random() < 0.5 ? 'Go go go' : "Let's move out");
  if (r.phase !== 'matchend') hud.hideMatchEnd();
}

net.on('round', applyRound);
net.on('ping', (msg) => net.send({ t: 'pong', ts: msg.ts }));
net.on('shieldhit', (msg) => {
  if (fx && msg.point) fx.impact(msg.point, [0, 1, 0], 'metal');
  if (msg.point) sfx.playAt('step_metal_0', msg.point, { volume: 0.9, ref: 150, max: 2500, rate: 1.6 });
});
net.on('vip', () => { hud.centerMsg('YOU ARE THE VIP — reach the escape zone (green ring on the radar)'); sfx.radio('Protect the VIP'); setTimeout(() => hud.centerMsg(''), 4000); });
net.on('door', (msg) => {
  const e = dynWorld && dynWorld.setDoor(msg.id, msg.open);
  if (e) sfx.playAt('door_move', e.base, { volume: 0.8, ref: 200, max: 2500 });
});
net.on('glass', (msg) => {
  const pane = dynWorld && dynWorld.breakGlass(msg.id);
  if (!pane) return;
  const p = msg.point || [0, 1, 2].map((i) => (pane.min[i] + pane.max[i]) / 2);
  sfx.playAt('glass_break', p, { volume: 0.9, ref: 200, max: 3000 });
  if (fx) for (let i = 0; i < 4; i++) fx.impact([p[0] + (Math.random() - 0.5) * 30, p[1] + (Math.random() - 0.5) * 30, p[2]], [0, 1, 0], 'metal');
});
net.on('glass_reset', () => { if (dynWorld) dynWorld.resetGlass(); });
net.on('you', (msg) => { if (player) player.reconcile(msg); });

// hostage events: follow / stay (to the CT who used it), rescued, hurt, killed
net.on('hostage', (msg) => {
  if (msg.kind === 'follow') { hud.centerMsg('the hostage is following you'); sfx.say(['Okay, let\'s go!', 'Let\'s get out of here!', 'Yes, I\'ll go with you.'][Math.floor(Math.random() * 3)]); setTimeout(() => hud.centerMsg(''), 1500); }
  else if (msg.kind === 'stay') { hud.centerMsg('the hostage will wait here'); sfx.say('I\'ll stay here.'); setTimeout(() => hud.centerMsg(''), 1500); }
  else if (msg.kind === 'rescued') {
    hostageTally.rescued++;
    const who = msg.by === myId ? 'You' : (roster.get(msg.by) || {}).name || 'A CT';
    hud.addChat('*', TEAM.CT, `${who} rescued a hostage (${msg.left} left)`);
    sfx.radio('Hostage has been rescued');
  } else if (msg.kind === 'killed') {
    hostageTally.killed++;
    const who = msg.by === myId ? 'You' : (roster.get(msg.by) || {}).name || 'Someone';
    hud.addChat('*', 0, `${who} killed a hostage!`);
    if (msg.by === myId) { hud.centerMsg('you killed a hostage: -$1500'); setTimeout(() => hud.centerMsg(''), 2500); }
  } else if (msg.kind === 'hurt' && msg.by === myId) {
    hud.centerMsg("don't shoot the hostages!"); setTimeout(() => hud.centerMsg(''), 1500);
  }
  if (round.mode === 'hostage') hud.setHostages(hostageCount());
});
net.on('match_start', () => {
  hud.banner(round.practice ? 'PRACTICE MATCH' : 'MATCH START', null, 2500);
  hud.hideMatchEnd();
  if (player) { player.kills = 0; player.deaths = 0; }
});
net.on('team', (msg) => {
  setTeam(msg.team);
  applyMySkin();
  if (skinAfterTeam) { skinAfterTeam = false; openSkinMenu(msg.team); }
  else if (savedSkin(msg.team) >= 0) sendSkin(msg.team, savedSkin(msg.team));
});
net.on('halftime', () => hud.banner('HALFTIME — SWITCHING SIDES', null, 4000));

net.on('round_end', (msg) => {
  hud.setScore(msg.scoreT, msg.scoreCT);
  const how = { bomb: 'THE BOMB EXPLODED', defuse: 'THE BOMB WAS DEFUSED', rescue: 'ALL HOSTAGES HAVE BEEN RESCUED',
    escape: 'THE VIP HAS ESCAPED', vip: 'THE VIP HAS BEEN ASSASSINATED',
    time: round.mode === 'hostage' ? 'HOSTAGES HAVE NOT BEEN RESCUED' : round.mode === 'vip' ? 'THE VIP HAS FAILED TO ESCAPE' : 'TIME RAN OUT', elim: '' }[msg.how] || '';
  keypad(false);
  setTimeout(() => sfx.radio(msg.winner === TEAM.T ? 'Terrorists win' : 'Counter-terrorists win'), msg.how === 'bomb' ? 1800 : 300);
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
  hud.banner('LOADING ' + msg.mapId.replace(/^(de|cs)_aq_/, '').toUpperCase(), null, 3000);
  await useMap(msg.mapId);
  if (remotes) remotes.clear();
  bomb = { state: 'none' };
});

net.on('chat', (msg) => hud.addChat(msg.name, msg.team, msg.text));

net.on('nade', (msg) => {
  if (nadeView) nadeView.thrown(msg);
  const r = roster.get(msg.owner);
  if (r && r.team === myTeam) sfx.radio('Fire in the hole!');
});
net.on('nade_boom', (msg) => { if (nadeView) nadeView.boom(msg, player && player.state.pos); });

// flashbang: white-out that holds, then fades; ears ring
let flashT = 0, flashHold = 0, flashLen = 0, flashAmt = 0;
net.on('flashed', (msg) => {
  flashAmt = Math.max(flashAmt, msg.amount);
  flashLen = Math.max(flashLen - flashT, msg.seconds); flashT = 0;
  flashHold = msg.seconds * 0.45;
  sfx.play('ring', { volume: 0.35 + 0.5 * msg.amount });
  if (sfx.master) { sfx.master.gain.cancelScheduledValues(0); sfx.master.gain.setValueAtTime(sfx.volume * 0.25, sfx.ctx.currentTime); sfx.master.gain.linearRampToValueAtTime(sfx.volume, sfx.ctx.currentTime + msg.seconds); }
});
function updateFlash(dt) {
  const el = $('flash');
  if (flashLen <= 0) return;
  flashT += dt;
  const a = flashT < flashHold ? flashAmt : flashAmt * Math.max(0, 1 - (flashT - flashHold) / Math.max(0.1, flashLen - flashHold));
  el.style.transition = 'none';
  el.style.background = `rgba(255,255,255,${a.toFixed(3)})`;
  if (flashT >= flashLen) { flashLen = 0; flashAmt = 0; el.style.background = 'rgba(255,255,255,0)'; el.style.transition = ''; }
}

net.onClose = () => {
  if (reconnecting) {                        // an attempt failed: try again shortly
    clearTimeout(reconnecting.timer);
    reconnecting.timer = setTimeout(reconnecting.retry, 1500);
    return;
  }
  if (running && !leaving && !kicked && resumeInfo && !net.fake) { startReconnect(); return; }
  teardown(leaving ? '' : 'disconnected from server');
};

function teardown(status) {
  voice.closeAll();
  toggleNightvision(false);
  running = false;
  input.capture = false;
  hud.hide();
  hud.closeBuy();
  hud.hideMatchEnd();
  $('pause').classList.add('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  menu.classList.remove('hidden');
  playBtn.disabled = false;
  menuStatus.textContent = status;
  resumeInfo = null;
  if (remotes) remotes.clear();
  bomb = { state: 'none' };
}

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
input.onCursor = (dx, dy) => hud.moveCursor(dx, dy);
input.onCursorClick = () => hud.cursorClick();
input.onLockChange = (locked) => {
  hud.showCursor(locked && hud.buyOpen());
  if (!running) return;
  if (locked) showPause(false);
  else if (!hud.buyOpen() && !input.typing && !hud.matchEndOpen()) showPause(true);
};
$('resumeBtn').addEventListener('click', () => { showPause(false); input.lock(); });
$('fullscreenBtn').addEventListener('click', async () => { try { await input.toggleFullscreen(); } catch { /* denied */ } input.lock(); });
$('leaveBtn').addEventListener('click', () => { showPause(false); leave(); });
document.addEventListener('fullscreenchange', () => {
  $('fullscreenBtn').textContent = document.fullscreenElement ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
});

// ------------------------------------------------------------------ console (~)

const con = new GameConsole({ input, store, onClose: () => { if (running) input.lock(); } });
window.__con = con;
try { const b = store.get('baq_binds', null); if (b) input.binds = JSON.parse(b); } catch { /* defaults */ }
const saveBinds = () => store.set('baq_binds', JSON.stringify(input.binds));
let fpsMax = 0;
const xhairCfg = { scale: 1, dynamic: true };
const DEG = Math.PI / 180;
con.cvar('sensitivity', (input.sensitivity / (0.022 * DEG)).toFixed(2), 'mouse sensitivity (CS scale: m_yaw 0.022 x this)', (v) => {
  const f = parseFloat(v); if (!(f > 0)) return;
  input.sensitivity = f * 0.022 * DEG;
  const sv = input.sensitivity * 1000;
  store.set('baq_sens', String(sv));
  for (const [a, b] of [['sens', 'sensVal'], ['pSens', 'pSensVal']]) { $(a).value = sv; $(b).textContent = sv.toFixed(1); }
});
con.cvar('m_pitch', '0.022', 'vertical mouse factor; negative inverts', (v) => { input.pitchSign = parseFloat(v) < 0 ? -1 : 1; });
con.cvar('zoom_sensitivity_ratio', '1.2', 'sensitivity scale while zoomed (x zoom fov ratio)', () => {});
con.cvar('volume', String(sfx.volume), 'master volume 0..1', (v) => { const f = Math.max(0, Math.min(1, parseFloat(v) || 0)); sfx.setVolume(f); store.set('baq_vol', String(f)); });
con.cvar('fps_max', '0', 'frame rate cap (0 = display rate)', (v) => { fpsMax = Math.max(0, parseInt(v, 10) || 0); });
con.cvar('r_dynamic', '1', 'dynamic resolution: fewer pixels when frames run slow', (v) => { dyn.on = v !== '0'; });
con.cvar('r_dynamic_min', '0.5', 'lowest dynamic resolution scale', (v) => { dyn.min = Math.max(0.3, Math.min(1, parseFloat(v) || 0.5)); });
con.cvar('net_graph', netGraph ? '1' : '0', 'show fps / ping / rates', (v) => { netGraph = v !== '0'; store.set('baq_netgraph', netGraph ? '1' : '0'); $('ngOn').checked = netGraph; const el = $('netgraph'); if (el) el.classList.toggle('hidden', !netGraph); });
con.cvar('cl_crosshair_color', '50 250 50', 'crosshair colour "r g b"', (v) => {
  const c = String(v).split(/\s+/).map((x) => Math.max(0, Math.min(255, parseInt(x, 10) || 0)));
  document.getElementById('crosshair').style.setProperty('--xhc', `rgb(${c[0]},${c[1]},${c[2]})`);
});
con.cvar('cl_crosshair_size', 'auto', 'auto | small | medium | large', (v) => { xhairCfg.scale = { small: 0.75, medium: 1, large: 1.35 }[v] || 1; });
con.cvar('cl_crosshair_translucent', '1', 'translucent crosshair', (v) => { document.getElementById('crosshair').style.opacity = v === '0' ? '1' : '0.75'; });
con.cvar('cl_dynamiccrosshair', '1', 'crosshair opens with movement and shots', (v) => { xhairCfg.dynamic = v !== '0'; });
con.cvar('hud_fastswitch', '1', 'weapon keys switch at once (always on here)', () => {});
con.cvar('name', store.get('baq_name', 'Player'), 'your name (next join)', (v, init) => { if (!init) { store.set('baq_name', v); $('playerName').value = v; } });
con.cmd('help', 'list commands', () => { for (const [n, c] of Object.entries(con.cmds).sort()) con.print(`${n.padEnd(22)}${c.help}`, 'dim'); con.print('cvars: type "cvarlist"', 'dim'); });
con.cmd('cvarlist', 'list variables', () => { for (const [n, d] of Object.entries(con.defs).sort()) con.print(`${n.padEnd(26)}"${con.cvars[n]}"  ${d.help}`, 'dim'); });
con.cmd('bind', 'bind <key> <action>: e.g. bind f +duck (no action: show)', (a) => {
  const code = keyCode(a[0] || '');
  if (!code) return con.print('bind <key> <action>');
  if (a.length < 2) return con.print(`"${a[0]}" = "${input.binds[code] || ''}"`);
  if (!ACTIONS.includes(a[1])) return con.print(`unknown action "${a[1]}". actions: ${ACTIONS.join(' ')}`);
  input.binds[code] = a[1]; saveBinds();
});
con.cmd('unbind', 'unbind <key>', (a) => { const code = keyCode(a[0] || ''); if (code) { delete input.binds[code]; saveBinds(); } });
con.cmd('unbindall', 'remove every binding', () => { input.binds = {}; saveBinds(); });
con.cmd('resetbinds', 'restore the default keys', () => { input.binds = { ...DEFAULT_BINDS }; saveBinds(); });
con.cmd('binds', 'list key bindings', () => { for (const [k, v] of Object.entries(input.binds).sort((x, y) => x[1].localeCompare(y[1]))) con.print(`${keyName(k).padEnd(12)}${v}`, 'dim'); });
con.cmd('clear', 'clear the console', () => { con.log.innerHTML = ''; });
con.cmd('echo', 'print text', (a) => con.print(a.join(' ')));
con.cmd('kill', 'suicide (-1 frag)', () => net.send({ t: 'suicide' }));
con.cmd('say', 'say <text>', (a) => net.send({ t: 'chat', text: a.join(' ') }));
con.cmd('jointeam', 'jointeam 1 | 2 | 5 (auto)', (a) => net.send({ t: 'jointeam', team: { 1: 'T', 2: 'CT' }[a[0]] || 'auto' }));
con.cmd('chooseteam', 'open the team menu', () => { con.toggle(false); openTeamMenu(true); });
con.cmd('finish', 'finish <weapon|all> <name|index> — weapon finish (e.g. finish ak47 gold)', (a) => {
  const w = a[0] === 'all' ? '*' : a[0];
  if (!w || (w !== '*' && !WEAPONS[w])) return con.print('usage: finish <weapon|all> <' + FINISHES.map((f) => f.id).join('|') + '>');
  const i = /^\d+$/.test(a[1] || '') ? parseInt(a[1], 10) : FINISHES.findIndex((f) => f.id === a[1]);
  if (i < 0 || i >= FINISHES.length) return con.print('finishes: ' + FINISHES.map((f, k) => `${k} ${f.id}`).join(', '));
  setFinish(w, i);
  con.print(`${w === '*' ? 'all weapons' : w}: ${FINISHES[i].name}`);
});
con.cmd('kickidle', 'kick players whose game froze or disconnected (and AFK ones)', () => kickIdle());
con.cmd('chooseappearance', 'pick your player model', () => { con.toggle(false); openSkinMenu(myTeam); });
let minModels = store.get('baq_minmodels', '0') === '1';
con.cvar('cl_minmodels', minModels ? '1' : '0', 'show every player as their team\'s default model', (v) => {
  minModels = v === '1' || v === 'true';
  store.set('baq_minmodels', minModels ? '1' : '0');
  if (remotes) remotes.minModels = minModels;
});
con.cmd('status', 'players, scores and latency', () => {
  con.print(`map ${map ? map.id : '?'} · ${round.rulesName || ''} · tick ${round.tickrate || '?'}`, 'dim');
  for (const r of roster.values()) con.print(`#${String(r.id).padEnd(4)}${(r.name || '').padEnd(18)}${r.team === TEAM.T ? 'T ' : 'CT'} ${String(r.k).padStart(3)} ${String(r.d).padStart(3)}  ${r.bot ? 'BOT' : (r.ping ?? '?') + ' ms'}`, 'dim');
});
con.cmd('disconnect', 'leave the server', () => { if (running) leave(); });
con.cmd('retry', 'reconnect', () => location.reload());
con.cmd('quit', 'leave the server', () => { if (running) leave(); });
for (const c of ['autobuy', 'rebuy']) con.cmd(c, c, () => net.send({ t: c }));
con.cmd('buyammo1', 'one box of primary ammo', () => net.send({ t: 'buy', item: 'ammo1' }));
con.cmd('buyammo2', 'one box of pistol ammo', () => net.send({ t: 'buy', item: 'ammo2' }));
con.cmd('buy', 'buy <item> (e.g. buy ak47)', (a) => net.send({ t: 'buy', item: a[0] }));
let rconPw = '';
con.cmd('rcon_password', 'rcon_password <password>', (a) => { rconPw = a.join(' '); con.print('rcon password set', 'dim'); });
con.cmd('rcon', 'rcon <command>: server admin (status, kick, ban, map, restart, bot_add, mp_* …)', (a) => net.send({ t: 'rcon', pw: rconPw, cmd: a.join(' ') }));
net.on('rcon_reply', (msg) => { for (const line of String(msg.text).split('\n')) con.print(line, 'dim'); if (!con.isOpen()) con.toggle(true); });
con.cmd('version', 'build id', () => con.print(`Battle-AQ ${document.querySelector('script[type=module]')?.src.match(/v\/([^/]+)/)?.[1] || 'dev'}`));

// ------------------------------------------------------------------ voice (K)

const speaking = new Map();   // id -> until
const voice = new Voice(net, {
  myId: () => myId,
  teammates: () => [...roster.values()].filter((r) => r.id !== myId && !r.bot && r.team === myTeam).map((r) => r.id),
  onSpeaking: (id, on, err) => { if (err) { hud.centerMsg(err); setTimeout(() => hud.centerMsg(''), 1500); } setSpeaking(id, on); },
});
voice.setEnabled(store.get('baq_voice', '1') === '1');
net.on('rtc', (msg) => voice.handle(msg));
net.on('talk', (msg) => setSpeaking(msg.id, msg.on));
function setSpeaking(id, on) {
  if (on) speaking.set(id, true); else speaking.delete(id);
  const el = document.getElementById('voiceList');
  if (el) el.innerHTML = [...speaking.keys()].map((i) => `<div>🔊 ${esc(i === myId ? 'you' : (roster.get(i) || {}).name || '#' + i)}</div>`).join('');
}
setInterval(() => { if (running) voice.sync(); }, 2000);
$('voiceOn').checked = store.get('baq_voice', '1') === '1';
$('voiceOn').addEventListener('change', (e) => { store.set('baq_voice', e.target.checked ? '1' : '0'); voice.setEnabled(e.target.checked); });

// ------------------------------------------------------------------ demos (M18)
//
// record <name>: every message from the server, plus our view angles, into a
// file; playdemo: feed a file back through the same handlers (the server's
// `you` messages carry our position), watched through our old eyes.

const demo = { rec: null, playing: null, speed: 1, paused: false };
function demoPose() {
  const r = demo.rec;
  const t = (performance.now() - r.t0) / 1000;
  if (t - r.lastPose < 0.05) return;
  r.lastPose = t;
  r.msgs.push([+t.toFixed(3), { t: '_pose', y: +player.state.yaw.toFixed(4), p: +player.state.pitch.toFixed(4) }]);
}
con.cmd('record', 'record <name>: record a demo of this match', (a) => {
  if (!running || !lastWelcome) return con.print('join a game first');
  const name = (a[0] || 'demo').replace(/[^\w-]/g, '').slice(0, 32) || 'demo';
  const t0 = performance.now();
  demo.rec = { name, t0, lastPose: -1, msgs: [], header: { version: 1, name, welcome: { ...lastWelcome, round: { ...round, ...lastWelcome.round, phase: round.phase } }, inv: player && { ...lastInv }, when: new Date().toISOString() } };
  net.tap = (m) => { if (m.t !== 'ping') demo.rec.msgs.push([+((performance.now() - t0) / 1000).toFixed(3), m]); };
  con.print(`recording ${name}… ("stop" to save it)`);
});
con.cmd('stop', 'stop recording and save the demo file', () => {
  if (!demo.rec) return con.print('not recording');
  net.tap = null;
  const d = demo.rec; demo.rec = null;
  const blob = new Blob([JSON.stringify({ header: d.header, msgs: d.msgs })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${d.name}.dem.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  con.print(`saved ${d.name}.dem.json (${d.msgs.length} messages, ${d.msgs.length ? d.msgs[d.msgs.length - 1][0].toFixed(0) : 0} s)`);
});
con.cmd('playdemo', 'playdemo: pick a .dem.json file to watch', () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    try { startDemo(JSON.parse(await inp.files[0].text())); } catch (e) { con.print('not a demo file: ' + e.message); }
  };
  inp.click();
});
con.cmd('demo_pause', 'pause / resume demo playback', () => { demo.paused = !demo.paused; });
con.cmd('demo_speed', 'demo_speed <x>: playback speed (0.25 .. 4)', (a) => { demo.speed = Math.max(0.25, Math.min(4, parseFloat(a[0]) || 1)); });
con.cmd('stopdemo', 'stop demo playback', () => endDemo());

async function startDemo(d) {
  if (!d || !d.header || !Array.isArray(d.msgs)) throw new Error('missing header');
  if (running) { leave(); await new Promise((r) => setTimeout(r, 400)); }
  net.fake = true;
  await onWelcome(d.header.welcome);
  if (d.header.inv) player.applyInv(d.header.inv);
  demo.playing = { msgs: d.msgs, i: 0, t: 0 };
  demo.paused = false;
  hud.banner('DEMO — ' + (d.header.name || ''), null, 3000);
  con.toggle(false);
}
function demoTick(dt) {
  const p = demo.playing;
  if (!demo.paused) p.t += dt * demo.speed;
  while (p.i < p.msgs.length && p.msgs[p.i][0] <= p.t) {
    const m = p.msgs[p.i++][1];
    if (m.t === '_pose') { player.state.yaw = m.y; player.state.pitch = m.p; continue; }
    if (m.t === 'you') { if (m.st) { player.pending = []; Object.assign(player.state, { pos: m.st.pos.slice(), crouching: m.st.crouching, eye: m.st.eye }); } continue; }
    net.inject(m);
  }
  if (p.i >= p.msgs.length) endDemo();
}
function endDemo() {
  if (!demo.playing) return;
  demo.playing = null;
  net.fake = false;
  teardown('demo finished');
}

// ------------------------------------------------------------------ nightvision (N)

let nvOn = false;
function toggleNightvision(force) {
  const want = force === undefined ? !nvOn : force;
  if (want && !(player && player.nvg && player.alive)) { if (force === undefined) { hud.centerMsg('you have no nightvision (buy it: B, 8)'); setTimeout(() => hud.centerMsg(''), 1500); } return; }
  nvOn = want;
  renderer.domElement.style.filter = nvOn ? 'brightness(2.4) contrast(1.15) grayscale(1) sepia(1) hue-rotate(58deg) saturate(3.2)' : '';
  document.getElementById('nvgNoise').classList.toggle('hidden', !nvOn);
  sfx.play('hitmark', { volume: 0.35, rate: nvOn ? 0.6 : 0.45 });
}

// ------------------------------------------------------------------ team menu (M)

function openTeamMenu(on) {
  $('teammenu').classList.toggle('hidden', !on);
  input.menuOpen = on;
  if (on) {
    let t = 0, ct = 0;
    for (const r of roster.values()) { if (r.team === TEAM.T) t++; else if (r.team === TEAM.CT) ct++; }
    $('tmT').textContent = `${t} player${t === 1 ? '' : 's'}`;
    $('tmCT').textContent = `${ct} player${ct === 1 ? '' : 's'}`;
    if (document.pointerLockElement) document.exitPointerLock();
  } else if (running) input.lock();
}
function teamMenuOpen() { return !$('teammenu').classList.contains('hidden'); }
function pickTeam(team) {
  if (team === (myTeam === TEAM.CT ? 'CT' : myTeam === TEAM.T ? 'T' : '')) {
    openTeamMenu(false);         // same side: just change the look
    return openSkinMenu(myTeam);
  }
  net.send({ t: 'jointeam', team });
  openTeamMenu(false);
  skinAfterTeam = true;          // the appearance menu opens once the server confirms
}
for (const b of document.querySelectorAll('#teammenu .tm')) b.addEventListener('click', () => pickTeam(b.dataset.team));

// ------------------------------------------------------------------ appearance (M19)

let skinAfterTeam = false, skinMenuTeam = 0, mySkin = 0;
// first-person gloves / sleeves follow the skin you wear
function applyMySkin() {
  const list = SKINS[myTeam];
  if (list) vm.setSkin((list[mySkin] || list[0]).id);
}
net.on('myskin', (msg) => { mySkin = msg.i || 0; applyMySkin(); });
handsReady.then((ok) => { if (ok && vm.skinId) vm.setSkin(vm.skinId, true); });
const savedSkin = (team) => { const v = store.get('baq_skin_' + team, ''); return v === '' ? -1 : parseInt(v, 10); };
function sendSkin(team, i) {
  if (i >= 0) store.set('baq_skin_' + team, String(i));
  net.send({ t: 'skin', i });
}
function openSkinMenu(team) {
  skinMenuTeam = team || 0;
  const on = !!skinMenuTeam && !!SKINS[team];
  $('skinmenu').classList.toggle('hidden', !on);
  input.menuOpen = on || teamMenuOpen();
  if (!on) { if (running && !teamMenuOpen()) input.lock(); return; }
  const cls = team === TEAM.CT ? 'ct' : 't', cur = savedSkin(team);
  $('skinTitle').textContent = team === TEAM.CT ? 'COUNTER-TERRORIST APPEARANCE' : 'TERRORIST APPEARANCE';
  $('skinOpts').innerHTML = SKINS[team].map((s, i) =>
    `<button class="sk ${cls}${i === cur ? ' cur' : ''}" data-i="${i}"><img src="assets/ui/skins/${s.id}.jpg" alt=""><b>${i + 1}</b>${s.name}<small>${s.desc}</small></button>`).join('')
    + `<button class="sk auto" data-i="-1"><b>5</b>AUTO-SELECT<small>a random look each time</small></button>`;
  for (const b of $('skinOpts').querySelectorAll('.sk')) b.addEventListener('click', () => chooseSkin(parseInt(b.dataset.i, 10)));
  if (document.pointerLockElement) document.exitPointerLock();
}
function chooseSkin(i) {
  if (i < 0) store.set('baq_skin_' + skinMenuTeam, '');
  sendSkin(skinMenuTeam, i);
  openSkinMenu(0);
}
function skinMenuOpen() { return !$('skinmenu').classList.contains('hidden'); }
// ghosts / frozen players: the server decides who really is (M: team menu, console kickidle)
function kickIdle() { net.send({ t: 'kickidle' }); }
$('kickIdle').addEventListener('click', () => { kickIdle(); openTeamMenu(false); });
net.on('notice', (msg) => { hud.centerMsg(msg.text); setTimeout(() => hud.centerMsg(''), 3000); con.print(msg.text); });
net.on('team_fail', (msg) => { hud.centerMsg(msg.reason); setTimeout(() => hud.centerMsg(''), 2000); });

// ------------------------------------------------------------------ MOTD

function showMotd(text) {
  if (!text || sessionStorage.getItem('baq_motd_seen') === text) return;
  sessionStorage.setItem('baq_motd_seen', text);
  $('motdText').textContent = text;
  $('motd').classList.remove('hidden');
  // it never takes the mouse away from the game: any key or 8 s dismisses it
  clearTimeout(showMotd.t);
  showMotd.t = setTimeout(() => $('motd').classList.add('hidden'), 8000);
}
$('motdOk').addEventListener('click', () => $('motd').classList.add('hidden'));
window.addEventListener('keydown', () => { if (!$('motd').classList.contains('hidden')) $('motd').classList.add('hidden'); });

// ------------------------------------------------------------------ UI keys

function canBuy() {
  if (!player || !player.alive || !map) return false;
  if (round.phase === 'warmup' || round.phase === 'dm') return true;
  if (map.fy) return false;                  // fy_: the guns are on the floor
  if (round.phase === 'end' || round.phase === 'matchend') return false;
  return performance.now() / 1000 < round.buyEndsAt && inBuyZone(map, myTeam, player.state.pos);
}

function buyContext() {
  return {
    money: player.money, team: myTeam, inv: player.inv, armor: player.armor, helmet: player.helmet, kit: player.kit, nvg: player.nvg, shield: player.shield,
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

// ------------------------------------------------------------------ radio (Z / X / C)

let radioMenu = null;
function openRadio(menu) {
  if (radioMenu === menu) { closeRadio(); return; }
  radioMenu = menu;
  input.radioOpen = true;
  const title = { z: 'RADIO COMMANDS (Z)', x: 'GROUP RADIO COMMANDS (X)', c: 'RADIO RESPONSES/REPORTS (V)' }[menu];
  $('radioMenu').innerHTML = `<h5>${title}</h5>` + RADIO[menu].map((t, i) => `<div><b>${i + 1}</b>${t}</div>`).join('') + '<div><b>0</b>Exit</div>';
  $('radioMenu').classList.remove('hidden');
}
function closeRadio() { radioMenu = null; input.radioOpen = false; $('radioMenu').classList.add('hidden'); }
net.on('radio', (msg) => {
  hud.addChat('(RADIO) ' + msg.name, msg.team || myTeam, msg.text);
  const last = document.getElementById('chatlog').lastChild; if (last) last.classList.add('radio');
  sfx.radio(msg.text.replace(/[!.]/g, ''));
  if (msg.menu === 'c' && msg.i === 1) radarPings.push({ pos: msg.pos, until: performance.now() / 1000 + 4 });
});
const radarPings = [];

input.onKey = (code, e, down) => {
  if (code === 'Backquote') { if (down) { e.preventDefault(); con.toggle(); } return; }
  if (!running) return;
  if (teamMenuOpen() && down) {
    if (code === 'Escape' || code === 'Digit0') { openTeamMenu(false); return; }
    const pick = { Digit1: 'T', Digit2: 'CT', Digit5: 'auto' }[code];
    if (pick) pickTeam(pick);
    return;
  }
  if (skinMenuOpen() && down) {
    if (code === 'Escape' || code === 'Digit0') { openSkinMenu(0); return; }
    const i = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: -1 }[code];
    if (i !== undefined) chooseSkin(i);
    return;
  }
  if (code === 'KeyM' && down && !input.typing) { openTeamMenu(true); return; }
  if (code === 'KeyN' && down && !input.typing) { toggleNightvision(); return; }
  if (code === 'KeyK') { if (!input.typing) voice.talk(down); return; }
  if (code === 'Tab') { scoresHeld = down; return; }
  if (!down) return;
  if (radioMenu && code.startsWith('Digit')) {
    const n = parseInt(code.slice(5), 10);
    if (n > 0 && RADIO[radioMenu][n - 1]) net.send({ t: 'radio', menu: radioMenu, i: n - 1 });
    closeRadio();
    return;
  }
  // radio on Z / X / V (C is crouch): menus keep CS's z / x / c names
  if (code === 'KeyZ' || code === 'KeyX' || code === 'KeyV') { if (!input.typing && !hud.buyOpen() && player && player.alive) openRadio({ KeyZ: 'z', KeyX: 'x', KeyV: 'c' }[code]); return; }
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
      hud._input = input; input.buyOpen = true;
      // the mouse stays captured: an in-game cursor points at the items
      hud.showCursor(input.locked);
    } else { hud.centerMsg(round.phase === 'end' ? 'the round is over' : 'you can only buy in your spawn during buy time'); setTimeout(() => hud.centerMsg(''), 1800); }
  } else if (code === 'F1' || code === 'F2' || code === 'Comma' || code === 'Period') {
    // CS 1.6 quick-buy binds: F1 autobuy, F2 rebuy, "," primary ammo, "." pistol ammo
    if (input.typing) return;
    if (!canBuy()) { hud.centerMsg(round.phase === 'end' ? 'the round is over' : 'you can only buy in your spawn during buy time'); setTimeout(() => hud.centerMsg(''), 1800); return; }
    if (code === 'F1') net.send({ t: 'autobuy' });
    else if (code === 'F2') net.send({ t: 'rebuy' });
    else net.send({ t: 'buy', item: code === 'Comma' ? 'ammo1' : 'ammo2' });
  } else if (code === 'KeyO') {
    // O: the equipment menu (CS buyequip) = the buy menu opened on Gear
    if (input.typing || hud.buyOpen()) return;
    if (canBuy()) {
      hud.openBuy(buyContext(), (item) => net.send({ t: 'buy', item }));
      hud._input = input; input.buyOpen = true;
      hud.showCursor(input.locked);
      hud.buyKey(BUY_MENU.findIndex((c) => c.key === 'gear') + 1);
    }
  } else if (code === 'Escape') {
    // Esc just closes the buy menu (no pause screen); a click takes the mouse back
    // In fullscreen (keyboard lock) the browser hands Esc to us and keeps the
    // mouse, so Esc behaves like CS: close whatever is open, else pause.
    if (radioMenu) closeRadio();
    else if (hud.buyOpen()) { hud.closeBuy(); if (!input.locked) hud.setHint('click to resume'); }
    else if (input.locked) document.exitPointerLock();
  } else if (hud.buyOpen() && /^Digit[1-9]$/.test(code)) {
    hud.buyKey(parseInt(code.slice(5), 10));
  }
};

// ------------------------------------------------------------------ spectating

// mp_forcecamera: competitive = your team only, casual = anyone
function spectateTargets() {
  const any = round.rules !== 'competitive';
  return [...remotes.players.values()].filter((r) => r.alive && !r.hidden && (any || r.team === myTeam));
}

// Dead / spectating, CS style: JUMP cycles first person -> chase cam ->
// free look; FIRE picks the next player; the mouse orbits the chase cam
// and steers free look (WASD flies).
const SPEC_MODES = ['first', 'chase', 'free', 'overview'];
const spec = { mode: 'first', yaw: 0, pitch: -0.2, jumpWas: false, pos: null };
function updateSpectate(dt) {
  const list = spectateTargets();
  const jump = input.keys.has('Space');
  if (jump && !spec.jumpWas) {
    spec.mode = SPEC_MODES[(SPEC_MODES.indexOf(spec.mode) + 1) % SPEC_MODES.length];
    if (spec.mode === 'free') spec.pos = [camera.position.x, camera.position.y, camera.position.z];
  }
  spec.jumpWas = jump;
  const [dx, dy] = input.consumeLook();
  spec.yaw -= dx;
  spec.pitch = Math.max(-1.45, Math.min(1.45, spec.pitch - dy));
  if (input.consumeFirePressed() || !list.find((r) => r.id === spectating)) {
    if (list.length) {
      const i = list.findIndex((r) => r.id === spectating);
      spectating = list[(i + 1) % list.length].id;
    } else spectating = null;
  }
  $('overview').classList.toggle('hidden', spec.mode !== 'overview');
  if (spec.mode === 'overview') {
    // the whole map from above (CS spectator overview), players as dots
    remotes.hiddenId = null;
    drawOverview();
    overview(dt, 0.04);
    hud.setSpectate('overview  ·  jump: first person');
    return;
  }
  if (spec.mode === 'free') {
    remotes.hiddenId = null;
    const k = input.moveKeys();
    const sp = (k.walk ? 250 : 600) * dt;
    const cp = Math.cos(spec.pitch);
    const f = [-Math.sin(spec.yaw) * cp, Math.sin(spec.pitch), -Math.cos(spec.yaw) * cp];
    const rgt = [Math.cos(spec.yaw), 0, -Math.sin(spec.yaw)];
    const mv = (k.f ? 1 : 0) - (k.b ? 1 : 0), st = (k.r ? 1 : 0) - (k.l ? 1 : 0);
    for (let i = 0; i < 3; i++) spec.pos[i] += (f[i] * mv + rgt[i] * st) * sp;
    camera.position.set(...spec.pos);
    camera.rotation.set(spec.pitch, spec.yaw, 0);
    hud.setSpectate('free look  ·  WASD fly  ·  jump: first person');
    return;
  }
  const r = spectating != null ? remotes.players.get(spectating) : null;
  if (r && spec.mode === 'first') {
    remotes.hiddenId = r.id;
    const eye = r.icrouch ?? r.tgt.crouching ? PLAYER.crouchEye : PLAYER.standEye;
    camera.position.set(r.cur.pos[0], r.cur.pos[1] + eye, r.cur.pos[2]);
    camera.rotation.set(r.cur.pitch, r.cur.yaw, 0);
    hud.setSpectate(`${r.name}  ·  click: next player  ·  jump: chase cam`);
  } else if (r) {
    // chase cam: orbit the player at 110 u, pulled in before walls
    remotes.hiddenId = null;
    const c = [r.cur.pos[0], r.cur.pos[1] + 52, r.cur.pos[2]];
    const cp = Math.cos(spec.pitch);
    const back = [Math.sin(spec.yaw) * cp, -Math.sin(spec.pitch), Math.cos(spec.yaw) * cp];
    const hit = raycast(c, back, world.colliders, 110);
    const d = hit ? Math.max(20, hit.t - 8) : 110;
    camera.position.set(c[0] + back[0] * d, c[1] + back[1] * d, c[2] + back[2] * d);
    camera.lookAt(c[0], c[1], c[2]);
    hud.setSpectate(`${r.name}  ·  chase cam  ·  click: next player  ·  jump: free look`);
  } else {
    remotes.hiddenId = null;
    overview(dt, 0.08);
    hud.setSpectate(round.phase === 'warmup' ? '' : 'waiting for the next round');
  }
}

function drawOverview() {
  const cv = $('overview');
  const bg = hud.radarBg;
  if (!bg) return;
  const H = Math.min(window.innerHeight * 0.78, window.innerWidth * 0.9);
  const W = H * bg.canvas.width / bg.canvas.height;
  if (cv.width !== Math.round(W)) { cv.width = Math.round(W); cv.height = Math.round(H); }
  const ctx = cv.getContext('2d');
  const k = cv.width / bg.canvas.width;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.globalAlpha = 0.92; ctx.drawImage(bg.canvas, 0, 0, cv.width, cv.height); ctx.globalAlpha = 1;
  const at = (p) => [(p[0] - bg.b.x0) * bg.s * k, (p[2] - bg.b.z0) * bg.s * k];
  for (const r of remotes.players.values()) {
    if (!r.alive || r.hidden) continue;
    const [x, y] = at(r.cur.pos);
    ctx.fillStyle = r.team === TEAM.CT ? '#7fb2e8' : '#e0b25c';
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - Math.sin(r.cur.yaw) * 14, y - Math.cos(r.cur.yaw) * 14); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '11px sans-serif'; ctx.fillText(r.name, x + 8, y - 6);
  }
  if (bomb && bomb.pos) { const [x, y] = at(bomb.pos); ctx.fillStyle = bomb.state === 'planted' ? '#ff4030' : '#ffb020'; ctx.fillRect(x - 6, y - 5, 12, 10); }
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
  if (!xhairCfg.dynamic) xhair.dist = base;                  // cl_dynamiccrosshair 0
  const scale = Math.max(1, Math.min(2.4, window.innerHeight / 480)) * xhairCfg.scale;
  const bar = ((xhair.dist - base) * 0.5 + 5) * scale;
  return { gap: xhair.dist * scale, len: bar };
}

// ------------------------------------------------------------------ game loop

let last = performance.now();
let radarT = 0;
let fpsT = 0, fpsN = 0;

function frame(now) {
  requestAnimationFrame(frame);
  if (fpsMax > 0 && now - last < 1000 / fpsMax - 0.5) return;       // fps_max
  dynamicResolution(now - last);
  renderer.info.reset();                 // count the whole frame (world + viewmodel)
  const cpu0 = performance.now();
  if (running) updateNetGraph();
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
  if (demo.playing) { demoTick(dt); player.applyCamera(dt); }
  else player.update(dt, input, { canAct: !menuOpen && input.locked && !input.typing });
  if (demo.rec) demoPose();
  remotes.update(dt, camera);
  if (bomb.state === 'planted' && bomb.localLeft !== undefined) bomb.localLeft -= dt;
  if (bombView) bombView.update(bomb, dt);
  if (dynWorld) {
    dynWorld.update(dt);
    // E opens doors: say so when one is in reach
    if (player && player.alive && dynWorld.doors.size) {
      const d = dynWorld.nearDoor(player.state.pos);
      const txt = d ? 'E: open / close the door' : '';
      if (txt !== useHint && (txt || useHint.startsWith('E: open'))) { useHint = txt; hud.setHint(txt); }
    }
  }
  if (hostageView) {
    hostageView.update(dt);
    // CT next to a hostage: say how to take it (CS: "Press USE to...")
    if (round.mode === 'hostage' && player && player.alive && myTeam === TEAM.CT && round.phase === 'round') {
      const p = player.state.pos;
      const near = hostageView.alive().find((e) => Math.hypot(e.cur.pos[0] - p[0], e.cur.pos[2] - p[2]) < HOSTAGE.useReach);
      const txt = near ? (near.leader === myId ? 'E: tell the hostage to stay' : 'E: take the hostage (lead it to a rescue zone)') : '';
      if (txt !== useHint) { useHint = txt; hud.setHint(txt); }
    } else if (useHint) { useHint = ''; hud.setHint(''); }
  }
  if (nadeView) nadeView.update(dt);
  updateFlash(dt);
  bombBeep(dt);
  sfx.setListener(camera);

  if (!player.alive) updateSpectate(dt);
  else if (spec.mode === 'overview') $('overview').classList.add('hidden');
  else { hud.setSpectate(''); remotes.hiddenId = null; }
  if (debugCam) { camera.position.set(debugCam[0], debugCam[1], debugCam[2]); camera.rotation.set(debugCam[4] || 0, debugCam[3] || 0, 0); }
  if (nadeView && nadeView.shake > 0) {
    camera.position.x += (Math.random() - 0.5) * 8 * nadeView.shake;
    camera.position.y += (Math.random() - 0.5) * 8 * nadeView.shake;
  }
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
  hud.setWeapon(player.weapon, player.mag(), player.reserve(), rf, player.mode());
  hud.setTimer(round.phase === 'planted' ? 0 : round.endsAt - tNow, round.phase);
  const scoped = player.alive && player.scoped();
  // zoomed: sensitivity follows the zoom (x zoom_sensitivity_ratio, CS)
  input.fovScale = player.alive && player.zoom > 0 ? (camera.fov / 78) * (parseFloat(con.cvars.zoom_sensitivity_ratio) || 1.2) : 1;
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
  if (scoresHeld) hud.showScores(true, [...roster.values()], myId, { map: map ? map.id : '', rules: round.rulesName, round: round.round, maxRounds: round.maxRounds });
  else hud.showScores(false);

  radarT -= dt;
  if (radarT <= 0) {
    radarT = 0.05;
    const mates = [...remotes.players.values()].filter((r) => r.alive && r.team === myTeam)
      .map((r) => ({ pos: r.cur.pos, team: r.team, c4: bomb.state === 'carried' && bomb.carrier === r.id }));
    const src = player.alive ? player.state.pos : [camera.position.x, 0, camera.position.z];
    const tp = performance.now() / 1000;
    while (radarPings.length && radarPings[0].until < tp) radarPings.shift();
    for (const p of radarPings) if (Math.floor(tp * 4) % 2) mates.push({ pos: p.pos, team: myTeam === TEAM.T ? TEAM.CT : TEAM.T });
    const hs = (round.mode === 'hostage' || round.mode === 'vip') && hostageView ? { zones: myTeam === TEAM.CT ? hostageView.rings.map((g) => [g.position.x, 0, g.position.z, g.geometry.parameters.outerRadius]) : [], list: hostageView.alive().map((e) => e.cur.pos) } : null;
    hud.drawRadar(src, player.alive ? player.state.yaw : camera.rotation.y, mates, bomb, hs);
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
  netStats.cpu += ((performance.now() - cpu0) - netStats.cpu) * 0.05;     // script time per frame
  envFx(dt);
  connIndicators();
  gpuTimer.begin();
  renderer.render(scene, camera);
  vm.render(renderer);
  gpuTimer.end();
  if (nvOn && !player.alive) toggleNightvision(false);
  netStats.calls = renderer.info.render.calls; netStats.tris = renderer.info.render.triangles;
}

// the planted C4 beeps faster and faster, in step with its LED
let beepT = 0;
function bombBeep(dt) {
  if (bomb.state !== 'planted' || !bomb.pos) { beepT = 0; return; }
  // CS C4: the gap between beeps shrinks faster as it runs down (from about
  // 1.4 s to 0.1 s), the tone climbs a step each fifth of the fuse, and the
  // last second and a half is a rapid burst
  const left = Math.max(0, bomb.localLeft ?? 0);
  const total = round.c4timer || 35;
  const f = Math.min(1, left / total);
  const interval = left < 1.5 ? 0.07 : 0.1 + 1.3 * Math.pow(f, 1.6);
  const stage = Math.min(4, Math.floor((1 - f) * 5));
  beepT += dt;
  if (beepT >= interval) { beepT = 0; sfx.playAt('beep', bomb.pos, { volume: 0.9, ref: 220, max: 4000, jitter: 0, rate: 1 + stage * 0.07 + (left < 1.5 ? 0.15 : 0) }); }
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

// installable app (PWA): the service worker lives next to index.html
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register(new URL('../sw.js', import.meta.url).href.replace(/\/v\/[0-9a-f]+\//, '/'), { scope: './' }).catch(() => {});
