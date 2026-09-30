// Authoritative game state for one battle-aq room.
//
// The server owns: player identity, team assignment, HP, armour, money,
// inventory, ammo, reloads, damage, kills, the round timer, the bomb and
// respawns. Movement is client-predicted: clients send their position and the
// server relays it (bots are moved here, with the same shared physics).
// Damage is fully server-side — the server raycasts against the map and the
// other players, so wallhacks and aimbots that only lie about position do not
// score hits.
//
// Flow:
//   warmup     one team is empty. Deathmatch respawns, $16000, buy anywhere.
//   freeze     round start: buy in spawn, nobody moves (5 s)
//   round      1:55. T carry the C4 to a bombsite; CT stop them
//   planted    35 s bomb timer; CT must defuse
//   end        5 s result, money paid out
//   matchend   final score + 15 s map vote, then the next map
// Teams swap sides after round 7; first to 8 wins (15 rounds max).
//
// A room is public (the one everyone joins) or practice (one human plus bots,
// created on demand and discarded when the human leaves).

import { getMap, MAP_LIST } from '../shared/maps.js';
import {
  PLAYER, WEAPONS, TEAM, ROUND, BOMB, HOSTAGE, DEFAULT_PISTOL, DRAW_TIME, MELEE_REACH, FINISHES,
} from '../shared/constants.js';
import {
  ECONOMY, itemInfo, lossBonus, inBuyZone, buyZoneCenter, ammoBox, AUTOBUY,
} from '../shared/economy.js';
import { newRecoil, resetRecoil, shotSpread, spreadDir, baseDamage, armorAbsorb, tagModifier } from '../shared/ballistics.js';
import {
  buildColliders, doorBoxAt, playerBox, aabbOverlap, hitBox, raycast, raycastPlayers, norm, len, sub, movePlayer, tag, bodyBox, waterLevel,
} from '../shared/physics.js';
import { navFor } from './nav.js';
import { radioText } from '../shared/radio.js';
import { MOVE, weaponStats } from '../shared/constants.js';
import { rulesFor, FF_DAMAGE } from '../shared/rules.js';
import { traceBullet, materialClass } from '../shared/penetration.js';
import { themeFor } from '../shared/themes.js';
import { NADES, throwVelocity, newNade, stepNade, flashAmount } from '../shared/grenades.js';
import { BotBrain, BOT_NAMES } from './bot.js';
import { Tactics } from './tactics.js';
import { stats } from './stats.js';
import { randomBytes } from 'node:crypto';
import { installMatch, newMatchState } from './match.js';

// a dropped connection keeps its player (team, money, guns, score) this long
export const RESUME_GRACE = 45;

let nextId = 1;

const now = () => Date.now() / 1000;
const other = (team) => (team === TEAM.T ? TEAM.CT : TEAM.T);

// eye height above the feet: the client's reported view offset (mid-duck
// blend), else from the hull; bots carry it in their physics state
function eyeOf(p) {
  if (p.bot && p.bot.state && Number.isFinite(p.bot.state.eye)) return p.bot.state.eye;
  if (Number.isFinite(p.eye)) return p.crouching ? PLAYER.crouchEye : p.eye;
  return p.crouching ? PLAYER.crouchEye : PLAYER.standEye;
}

// snapshot precision: 0.1 u positions, 0.001 rad angles (bandwidth)
const r1 = (v) => [Math.round(v[0] * 10) / 10, Math.round(v[1] * 10) / 10, Math.round(v[2] * 10) / 10];
const r3 = (a) => Math.round((a || 0) * 1000) / 1000;

export class Game {
  constructor(mapId = 'de_aq_dust', { practice = false, id = 'public', fillTo = 0, botDifficulty = 'normal', rules = 'casual' } = {}) {
    this.id = id;
    // mp_* settings: a preset id, or a custom room's { base, ...overrides }
    this.rulesId = typeof rules === 'object' ? 'custom' : rules;
    this.rules = typeof rules === 'object' ? { ...rulesFor(rules.base), ...rules, name: rules.name || 'Custom' } : rulesFor(rules);
    this.practice = practice;
    this.fillTo = fillTo;               // public rooms: top each team up to this many with bots
    this.botDifficulty = botDifficulty;
    this.players = new Map(); // id -> player
    this.planting = new Map(); // playerId -> start time
    this.defusing = new Map(); // playerId -> start time
    this.votes = new Map();    // playerId -> mapId
    this.nades = [];           // grenades in flight
    this.smokes = [];          // active smoke clouds { pos, from, until, radius }
    this.nadeSeq = 0;
    this.hostages = [];
    this.rescuedCount = 0;
    this.loadMap(mapId);
    this.tactics = new Tactics(this);   // bots' team plans (M14)
    this.phase = 'warmup';
    this.phaseEndsAt = 0;
    this.buyEndsAt = 0;
    this.score = { [TEAM.T]: 0, [TEAM.CT]: 0 };
    this.lossStreak = { [TEAM.T]: 0, [TEAM.CT]: 0 };
    this.roundNumber = 0;
    this.halftimeRound = this.rules.halftime;
    this.matchOver = false;
    this.match = newMatchState();          // ready-up / knife / pauses / overtime / veto (match.js)
    this.bomb = { state: 'none', pos: null, carrier: null, plantedAt: 0, explodeAt: 0 };
    this.plantedThisRound = false;
    this.lastTick = now();
  }

  loadMap(mapId) {
    this.map = getMap(mapId);
    this._escape = null;
    this.colliders = buildColliders(this.map);
    // bots path through doors (they open them) but not through glass
    this.nav = navFor(this.map, this.colliders.filter((c) => !c.door));
    this.doorOpen = {};
    this.glassBroken = new Set();
    // penetration material per palette key, from the texture the theme uses
    const mats = (themeFor(this.map.id) || {}).mats || {};
    this._matClass = {};
    this.matOf = (box) => {
      const k = box && box.mat;
      if (!(k in this._matClass)) this._matClass[k] = materialClass((mats[k] && mats[k].tex) || k);
      return this._matClass[k];
    };
    this.drops = [];
    this.spawnFloorWeapons();
    this._spawnYaw = {};
    this._spawnSpots = {};
    this.resetHostages();
  }

  get competitive() { return this.phase !== 'warmup'; }
  get hostageMode() { return !this.rules.mode && (this.map.hostages || []).length > 0; }
  get dm() { return this.rules.mode === 'dm'; }
  // fy_ maps (M20): no objective and no buying, guns on the floor
  aliveCount(team) { let n = 0; for (const p of this.players.values()) if (p.alive && p.team === team) n++; return n; }
  get fy() { return !!this.map.fy && !this.rules.mode; }
  get freezeTime() { return this.fy ? Math.min(this.rules.freezetime, 3) : this.rules.freezetime; }
  get roundTime() { return this.fy ? Math.min(this.rules.roundtime, 105) : this.rules.roundtime; }

  // Lay the map's floor guns out (fy_ maps): every round, and in deathmatch /
  // warmup a taken one comes back after 20 s.
  spawnFloorWeapons(only = null) {
    const list = this.map.floorWeapons || [];
    this._floorGone = this._floorGone || {};
    list.forEach(([weapon, x, y, z], i) => {
      if (only && !only.includes(i)) return;
      const w = WEAPONS[weapon];
      if (!w) return;
      const hit = raycast([x, y + 40, z], [0, -1, 0], this.colliders, 400);
      this.dropSeq = (this.dropSeq || 0) + 1;
      this.drops.push({ id: this.dropSeq, weapon, pos: [x, hit ? hit.point[1] : y, z], yaw: (i * 2.39996) % (Math.PI * 2),
        ammo: { mag: w.mag, reserve: w.reserve }, by: 0, at: 0, spot: i });
      delete this._floorGone[i];
    });
  }

  tickFloorWeapons(t) {
    if (!this.map.floorWeapons || !(this.dm || this.phase === 'warmup') || t < (this._floorCheck || 0)) return;
    this._floorCheck = t + 1;
    const here = new Set(this.drops.filter((d) => d.spot !== undefined).map((d) => d.spot));
    const back = [];
    this.map.floorWeapons.forEach((_, i) => {
      if (here.has(i)) return;
      if (!this._floorGone[i]) this._floorGone[i] = t;
      else if (t - this._floorGone[i] > 20) back.push(i);
    });
    if (back.length) this.spawnFloorWeapons(back);
  }
  get vipMode() { return this.rules.mode === 'vip'; }

  // VIP escape zone: the map's, else the spot farthest from the CT spawn
  // that is still well away from the T spawn
  vipEscape() {
    if (this._escape) return this._escape;
    if (this.map.vipEscape) return (this._escape = this.map.vipEscape);
    const ct = this.map.spawns[TEAM.CT][0], tt = this.map.spawns[TEAM.T][0];
    let best = null, bd = -1;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 400; i++) {
      const n = this.nav.randomNode(rnd);
      const dT = Math.hypot(n.x - tt[0], n.z - tt[2]), dCT = Math.hypot(n.x - ct[0], n.z - ct[2]);
      if (dT < 900) continue;
      if (dCT > bd && this.nav.path(ct, [n.x, n.y, n.z])) { bd = dCT; best = [n.x, n.y, n.z, 200]; }
    }
    return (this._escape = best || [tt[0], tt[1], tt[2], 200]);
  }

  // ------------------------------------------------------------- hostages

  resetHostages() {
    this.hostages = (this.map.hostages || []).map((pos, i) => ({
      id: 1000 + i, pos: pos.slice(), yaw: Math.random() * Math.PI * 2, hp: HOSTAGE.hp,
      alive: true, rescued: false, leader: null, used: false, path: null, pathAt: 0,
      state: { pos: pos.slice(), vel: [0, 0, 0], yaw: 0, pitch: 0, onGround: true, crouching: false },
    }));
    this.rescuedCount = 0;
  }

  rescueZones() {
    const zones = this.map.rescueZones || [];
    return zones.length ? zones : [[...this.spawnSpots(TEAM.CT)[0], HOSTAGE.rescueRadius]];
  }

  inRescueZone(pos) {
    return this.rescueZones().some((z) => Math.hypot(pos[0] - z[0], pos[2] - z[2]) <= (z[3] || HOSTAGE.rescueRadius));
  }

  // E on a hostage: a CT takes or releases it
  useHostage(p) {
    if (!p.alive || p.team !== TEAM.CT || !this.hostageMode || this.phase !== 'round') return false;
    let best = null, bd = HOSTAGE.useReach;
    for (const h of this.hostages) {
      if (!h.alive || h.rescued) continue;
      const d = Math.hypot(h.pos[0] - p.pos[0], h.pos[2] - p.pos[2]);
      if (d < bd && Math.abs(h.pos[1] - p.pos[1]) < 64) { bd = d; best = h; }
    }
    if (!best) return false;
    if (best.leader === p.id) { best.leader = null; this.send(p, { t: 'hostage', kind: 'stay', id: best.id }); return true; }
    best.leader = p.id;
    best.path = null;
    if (!best.used) { best.used = true; this.addMoney(p, ECONOMY.hostageUse, 'hostage'); }
    this.send(p, { t: 'hostage', kind: 'follow', id: best.id });
    return true;
  }

  updateHostages(dt, t) {
    if (!this.hostageMode || !this.hostages) return;
    for (const h of this.hostages) {
      if (!h.alive || h.rescued) continue;
      const leader = h.leader && this.players.get(h.leader);
      if (leader && (!leader.alive || leader.team !== TEAM.CT)) h.leader = null;
      let keys = { f: 0, b: 0, l: 0, r: 0, maxSpeed: HOSTAGE.speed };
      if (h.leader && leader) {
        const d = Math.hypot(leader.pos[0] - h.pos[0], leader.pos[2] - h.pos[2]);
        if (d > HOSTAGE.followGap) {
          if (!h.path || t > h.pathAt) { h.path = this.nav.path(h.pos, leader.pos); h.pathAt = t + 0.6; h.pathIdx = 0; }
          let wp = null;
          if (h.path) {
            while (h.pathIdx < h.path.length - 1 && Math.hypot(h.path[h.pathIdx][0] - h.pos[0], h.path[h.pathIdx][2] - h.pos[2]) < 28) h.pathIdx++;
            wp = h.path[Math.min(h.pathIdx, h.path.length - 1)];
          }
          const target = wp || leader.pos;
          h.state.yaw = Math.atan2(-(target[0] - h.pos[0]), -(target[2] - h.pos[2]));
          keys.f = 1;
          if (d > 300) keys.maxSpeed = HOSTAGE.speed + 20;   // catch up
        }
      }
      h.state.pos = h.pos;
      movePlayer(h.state, keys, dt, this.colliders);
      h.pos = h.state.pos;
      h.yaw = h.state.yaw;
      h.moving = keys.f === 1;
      if (h.leader && this.phase === 'round' && this.inRescueZone(h.pos)) this.rescueHostage(h, this.players.get(h.leader));
    }
  }

  rescueHostage(h, by) {
    h.rescued = true; h.leader = null;
    this.rescuedCount++;
    if (by) this.addMoney(by, ECONOMY.hostageRescue, 'hostage rescued');
    for (const p of this.players.values()) if (p.team === TEAM.CT && p !== by) this.addMoney(p, ECONOMY.hostageRescueTeam, 'hostage rescued');
    this.broadcast({ t: 'hostage', kind: 'rescued', id: h.id, by: by ? by.id : null, left: this.hostagesLeft() });
    this.checkHostageWin();
  }

  hostagesLeft() { return (this.hostages || []).filter((h) => h.alive && !h.rescued).length; }

  checkHostageWin() {
    if (!this.hostageMode || this.phase !== 'round') return;
    // CT win once every hostage still alive is out (and at least one was saved)
    if (this.hostagesLeft() === 0 && this.rescuedCount > 0) this.endRound(TEAM.CT, 'rescue');
  }

  damageHostage(h, attacker, dmg) {
    h.hp -= dmg;
    this.broadcast({ t: 'hostage', kind: 'hurt', id: h.id, hp: Math.max(0, h.hp), by: attacker ? attacker.id : null });
    if (h.hp > 0) return;
    h.alive = false; h.leader = null;
    if (attacker) this.addMoney(attacker, ECONOMY.hostageKill, 'killed a hostage');
    this.broadcast({ t: 'hostage', kind: 'killed', id: h.id, by: attacker ? attacker.id : null, left: this.hostagesLeft() });
    this.checkHostageWin();
  }
  get humans() { return [...this.players.values()].filter((p) => !p.bot); }

  // ------------------------------------------------------------- lifecycle

  // Both teams populated -> start a fresh match; a team emptied -> warmup.
  checkMode() {
    if (this.phase === 'matchend') return;
    const bothTeams = this.teamSize(TEAM.T) > 0 && this.teamSize(TEAM.CT) > 0;
    if (bothTeams && !this.competitive) this.tryStart();
    else if (!bothTeams && this.competitive && this.phase !== 'sidevote') this.enterWarmup();
  }

  enterWarmup() {
    this.matchOver = false;
    this.match.knife = false; this.match.sideVote = null; this.match.paused = null; this.match.pending = null;
    this.match.warmupSince = now();
    this.clearBomb();
    this.setPhase('warmup', 0);
    for (const p of this.players.values()) {
      p.money = ECONOMY.warmupMoney;
      if (!p.alive) this.respawn(p, true);
      else this.sendInv(p);
    }
  }

  startMatch() {
    const m = this.match;
    m.startAt = 0;
    m.maxRound = this.rules.maxrounds; m.winTarget = this.rules.winlimit; m.ot = 0; m.otStart = false;
    m.paused = null; m.pending = null;
    m.timeouts = { [TEAM.T]: this.rules.timeouts || 0, [TEAM.CT]: this.rules.timeouts || 0 };
    this.halftimeRound = this.rules.halftime;
    this.score = { [TEAM.T]: 0, [TEAM.CT]: 0 };
    this.lossStreak = { [TEAM.T]: 0, [TEAM.CT]: 0 };
    this.roundNumber = 0;
    this.matchOver = false;
    this.votes.clear();
    for (const p of this.players.values()) {
      p.money = ECONOMY.startMoney;
      p.kills = 0; p.deaths = 0;
      this.resetLoadout(p);
      p.alive = false; // everyone respawns fresh for round 1
    }
    if (this.dm) { this.broadcast({ t: 'match_start', map: this.map.id }); this.startDeathmatch(); return; }
    if (this.rules.kniferound && !this.practice && !m.knifeDone) { this.startKnife(); return; }
    this.broadcast({ t: 'match_start', map: this.map.id });
    this.startRound();
  }

  startDeathmatch() {
    this.clearBomb();
    this.drops = [];
    this.spawnFloorWeapons();
    this.setPhase('dm', this.rules.timelimit);
    for (const p of this.players.values()) { p.money = ECONOMY.warmupMoney; this.respawn(p, true); }
    this.broadcast({ t: 'round', ...this.roundInfo() });
  }

  // CSDM spawn: of a handful of random spots, the one farthest from the enemy
  dmSpot(p) {
    let best = null, bd = -1;
    for (let i = 0; i < 24; i++) {
      const n = this.nav.randomNode();
      let dmin = 4000;
      for (const q of this.players.values()) if (q.alive && q.team !== p.team) dmin = Math.min(dmin, Math.hypot(q.pos[0] - n.x, q.pos[2] - n.z));
      if (dmin > bd) { bd = dmin; best = [n.x, n.y, n.z]; }
    }
    return best;
  }

  startRound() {
    // halftime: swap sides, keep each group's score, reset the economy
    if (this.roundNumber === this.halftimeRound) {
      for (const p of this.players.values()) {
        p.team = other(p.team);
        p.money = this.match.ot ? (this.rules.otMoney || 10000) : ECONOMY.startMoney;
        p.alive = false;
        this.resetLoadout(p);
        this.send(p, { t: 'team', team: p.team });
      }
      this.score = { [TEAM.T]: this.score[TEAM.CT], [TEAM.CT]: this.score[TEAM.T] };
      this.lossStreak = { [TEAM.T]: 0, [TEAM.CT]: 0 };
      this.match.names = { [TEAM.T]: this.match.names[TEAM.CT], [TEAM.CT]: this.match.names[TEAM.T] };
      this.match.timeouts = { [TEAM.T]: this.match.timeouts[TEAM.CT], [TEAM.CT]: this.match.timeouts[TEAM.T] };
      this.broadcast({ t: 'halftime', scoreT: this.score[TEAM.T], scoreCT: this.score[TEAM.CT] });
      this.broadcast({ t: 'teamnames', names: this.match.names });
    }
    // overtime begins: everyone gets the overtime money (same sides, guns kept)
    if (this.match.otStart) {
      this.match.otStart = false;
      for (const p of this.players.values()) p.money = this.rules.otMoney || 10000;
      this.lossStreak = { [TEAM.T]: 0, [TEAM.CT]: 0 };
      this.broadcast({ t: 'overtime', n: this.match.ot, money: this.rules.otMoney || 10000 });
    }
    this.roundNumber++;
    this.plantedThisRound = false;
    this.nades = []; this.smokes = [];
    this.drops = [];              // guns on the floor are cleared each round (CS)
    this.spawnFloorWeapons();
    this.resetWorld();
    this.planting.clear(); this.defusing.clear();
    this.buyEndsAt = now() + this.freezeTime + this.rules.buytime;
    this.setPhase('freeze', this.freezeTime);
    // what each player bought last round becomes their F2 rebuy
    for (const p of this.players.values()) {
      if (p.roundBuys && p.roundBuys.length) p.lastBuys = p.roundBuys;
      p.roundBuys = [];
    }
    // Survivors keep their weapons and armour; the dead start over.
    for (const p of this.players.values()) {
      if (!p.alive && !p.keepLoadout) this.resetLoadout(p);
      if (p.dc) continue;                   // disconnected: sits out until it is back
      p.keepLoadout = false;
      this.respawn(p, true);
    }
    this.resetHostages();
    if (this.vipMode) this.pickVip();
    else if (!this.hostageMode) this.giveBomb();
    this.tactics.newRound();
    if (this.match.pending) this.startPause();
  }

  setPhase(phase, seconds) {
    this.phase = phase;
    this.phaseEndsAt = now() + seconds;
    this.broadcast({ t: 'round', ...this.roundInfo() });
  }

  roundInfo() {
    return {
      phase: this.phase,
      timer: this.phase === 'warmup' ? 0 : Math.max(0, this.phaseEndsAt - now()),
      buyTime: this.phase === 'warmup' ? -1 : Math.max(0, this.buyEndsAt - now()),
      scoreT: this.score[TEAM.T], scoreCT: this.score[TEAM.CT],
      round: this.roundNumber, maxRounds: this.match.maxRound || this.rules.maxrounds, halftime: this.halftimeRound,
      rules: this.rulesId, rulesName: this.rules.name, winlimit: this.match.winTarget || this.rules.winlimit, friendlyfire: this.rules.friendlyfire,
      teamNames: this.match.names, overtime: this.match.ot || undefined, knife: this.match.knife || undefined,
      readyup: this.rules.readyup && !this.practice ? 1 : undefined, paused: this.match.paused ? 1 : undefined,
      tickrate: this.rules.tickrate, updaterate: this.rules.updaterate, c4timer: this.rules.c4timer,
      map: this.map.id, practice: this.practice, mode: this.rules.mode || (this.hostageMode ? 'hostage' : 'bomb'),
      rescueZones: this.hostageMode ? this.rescueZones() : undefined,
      escape: this.vipMode ? this.vipEscape() : undefined, vip: this.vipMode ? this.vipId : undefined,
      gameMode: this.rules.mode || undefined, fraglimit: this.dm ? this.rules.fraglimit : undefined, timelimit: this.dm ? this.rules.timelimit : undefined,
    };
  }

  // Called on the server tick.
  update() {
    const t = now();
    const dt = Math.min(0.1, t - this.lastTick);
    this.lastTick = t;
    for (const p of this.players.values()) {
      if (p.reloadUntil && t >= p.reloadUntil) this.finishReload(p);
      if (p.shellAt && t >= p.shellAt) this.insertShell(p, t);
      if (p.alive && this.drops.length) this.checkPickup(p, t);
    }
    for (const p of this.players.values()) if (p.bot) p.bot.think(dt, t);
    this.recordHistory(t);
    this.updateBomb(t);
    this.updateNades(dt, t);
    this.updateHostages(dt, t);
    this.checkVipEscape();
    this.tickFloorWeapons(t);
    this.checkIdle(t);
    this.tickMatch(t, dt);
    if (this.phase === 'warmup' || t < this.phaseEndsAt) return;
    if (this.phase === 'freeze') this.setPhase('round', this.roundTime);
    // time: the bomb was never planted (CT win) / hostages not rescued (T win);
    // fy_: the side with more players alive, a tie to the CTs
    else if (this.phase === 'round') this.endRound(this.match.knife ? this.knifeTimeWinner() : this.hostageMode || this.vipMode ? TEAM.T : this.fy && this.aliveCount(TEAM.T) > this.aliveCount(TEAM.CT) ? TEAM.T : TEAM.CT, 'time');
    else if (this.phase === 'planted') this.explode();
    else if (this.phase === 'end') {
      if (this.matchOver) this.startVote();
      else this.startRound();
    } else if (this.phase === 'matchend') this.finishVote();
    else if (this.phase === 'dm') { this.matchOver = true; this.startVote(); }
  }

  endRound(winner, how) {
    if (!['round', 'freeze', 'planted'].includes(this.phase)) return;
    if (this.match.knife) return this.endKnife(winner);
    const loser = other(winner);
    this.planting.clear(); this.defusing.clear();
    this.score[winner]++;
    this.lossStreak[winner] = 0;
    this.lossStreak[loser]++;
    let winBonus = ECONOMY.winBonus;
    if (how === 'bomb') winBonus = ECONOMY.winBonusBomb;
    else if (how === 'defuse') winBonus = ECONOMY.winBonusDefuse;
    else if (winner === TEAM.CT && how === 'elim') winBonus = ECONOMY.winBonusElimCT;
    else if (how === 'rescue') winBonus = ECONOMY.winBonusRescue;
    else if (how === 'time') winBonus = ECONOMY.winBonusTime;
    else if (how === 'escape') winBonus = ECONOMY.winBonusEscape;
    else if (how === 'vip') winBonus = ECONOMY.winBonusVipKilled;
    const lossPay = lossBonus(this.lossStreak[loser]);
    for (const p of this.players.values()) {
      if (p.team === winner) this.addMoney(p, winBonus, 'round win');
      else {
        let pay = lossPay;
        if (loser === TEAM.T && this.plantedThisRound) pay += ECONOMY.plantBonus;
        this.addMoney(p, pay, 'round loss');
      }
    }
    stats.round([...this.players.values()].filter((p) => p.team === winner), [...this.players.values()].filter((p) => p.team === loser));
    const m = this.match;
    const lastRound = this.roundNumber >= (m.maxRound || this.rules.maxrounds);
    this.matchOver = this.score[winner] >= (m.winTarget || this.rules.winlimit) || lastRound;
    // tied at the end: overtime, MR3 (first to 4 of 6) at $10000, as often as it takes
    let overtime = 0;
    if (this.matchOver && lastRound && this.rules.overtime && this.score[TEAM.T] === this.score[TEAM.CT]) {
      const n = this.rules.otMaxrounds || 6;
      m.ot++;
      m.maxRound = this.roundNumber + n;
      m.winTarget = this.score[TEAM.T] + n / 2 + 1;
      this.halftimeRound = this.roundNumber + n / 2;
      m.otStart = true;
      this.matchOver = false;
      overtime = m.ot;
    }
    this.broadcast({
      t: 'round_end', winner, how, name: m.names[winner],
      scoreT: this.score[TEAM.T], scoreCT: this.score[TEAM.CT],
      matchOver: this.matchOver, halftime: this.roundNumber === this.halftimeRound, overtime: overtime || undefined,
    });
    this.setPhase('end', this.rules.roundEnd);
  }

  checkWinCondition() {
    if (!['round', 'freeze', 'planted'].includes(this.phase)) return;
    if (this.dm) return;
    const aliveT = this.countAlive(TEAM.T);
    const aliveCT = this.countAlive(TEAM.CT);
    if (aliveCT === 0 && aliveT > 0) this.endRound(TEAM.T, 'elim');
    // after the plant, killing every T is not enough: the bomb still has to go
    else if (aliveT === 0 && aliveCT > 0 && this.phase !== 'planted') this.endRound(TEAM.CT, 'elim');
    else if (aliveCT === 0 && aliveT === 0 && this.phase === 'planted') { /* the bomb decides */ }
  }

  countAlive(team) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team && p.alive) n++;
    return n;
  }

  teamSize(team) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
  }

  // ------------------------------------------------------------- map vote

  startVote() {
    this.votes.clear();
    const winner = this.score[TEAM.T] === this.score[TEAM.CT] ? 0
      : (this.score[TEAM.T] > this.score[TEAM.CT] ? TEAM.T : TEAM.CT);
    this.clearBomb();
    this.setPhase('matchend', ROUND.voteTime);
    this.broadcast({
      t: 'match_end', winner, scoreT: this.score[TEAM.T], scoreCT: this.score[TEAM.CT],
      maps: MAP_LIST.map((m) => m.id), current: this.map.id, voteTime: ROUND.voteTime,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, k: p.kills, d: p.deaths })),
    });
  }

  tally() {
    const t = {};
    for (const m of MAP_LIST) t[m.id] = 0;
    for (const m of this.votes.values()) if (m in t) t[m]++;
    return t;
  }

  finishVote() {
    const tally = this.tally();
    const top = Math.max(...Object.values(tally));
    let next;
    if (top === 0) {
      const ids = MAP_LIST.map((m) => m.id);
      next = ids[(ids.indexOf(this.map.id) + 1) % ids.length]; // nobody voted: rotate
    } else {
      const best = Object.keys(tally).filter((k) => tally[k] === top);
      next = best[Math.floor(Math.random() * best.length)];
    }
    this.changeMap(next);
  }

  // rcon restart: a fresh match if both teams are here, else warmup
  startMatchIfReady() {
    this.match.knifeDone = false;
    if (this.teamSize(TEAM.T) > 0 && this.teamSize(TEAM.CT) > 0) this.startMatch();
    else this.enterWarmup();
  }

  changeMap(mapId) {
    if (mapId !== this.map.id) this.loadMap(mapId);
    this.broadcast({ t: 'map', mapId: this.map.id });
    this.phase = 'warmup';
    for (const p of this.players.values()) { p.alive = false; p.ready = false; if (p.bot) p.bot.reset(); }
    this.match.knifeDone = false; this.match.startAt = 0;
    this.enterWarmup();
    this.tryStart();
  }

  // ------------------------------------------------------------- the bomb

  clearBomb() {
    this.bomb = { state: 'none', pos: null, carrier: null, plantedAt: 0, explodeAt: 0 };
    for (const p of this.players.values()) p.c4 = false;
    this.planting.clear(); this.defusing.clear();
  }

  giveBomb() {
    this.clearBomb();
    const ts = [...this.players.values()].filter((p) => p.team === TEAM.T && p.alive);
    if (!ts.length || !Object.keys(this.map.bombsites || {}).length) return;
    // humans get it first, as in CS the carrier is random; prefer a human in practice
    const humans = ts.filter((p) => !p.bot);
    const pool = this.practice && humans.length ? humans : ts;
    const c = pool[Math.floor(Math.random() * pool.length)];
    c.c4 = true;
    this.bomb = { state: 'carried', pos: null, carrier: c.id, plantedAt: 0, explodeAt: 0 };
    this.sendInv(c);
  }

  dropBomb(p, thrown = false) {
    if (!p.c4) return;
    p.c4 = false;
    if (p.weapon === 'c4') p.weapon = p.inv.primary || p.inv.secondary || 'knife';
    this.planting.delete(p.id);
    const fwd = thrown ? [-Math.sin(p.yaw) * 80, 0, -Math.cos(p.yaw) * 80] : [0, 0, 0];
    const pos = [p.pos[0] + fwd[0], p.pos[1], p.pos[2] + fwd[2]];
    // drop onto the ground below
    const hit = raycast([pos[0], pos[1] + 40, pos[2]], [0, -1, 0], this.colliders, 2000);
    if (hit) pos[1] = hit.point[1];
    this.bomb = { state: 'dropped', pos, carrier: null, plantedAt: 0, explodeAt: 0 };
    this.sendInv(p);
    this.broadcastTeam(TEAM.T, { t: 'bomb_event', kind: 'dropped', by: p.id });
  }

  inSite(pos) {
    for (const [label, s] of Object.entries(this.map.bombsites || {})) {
      if (Math.hypot(pos[0] - s[0], pos[2] - s[2]) <= BOMB.siteRadius && Math.abs(pos[1] - s[1]) < 96) return label;
    }
    return null;
  }

  canDefuse(p) {
    return p.alive && p.team === TEAM.CT && this.bomb.state === 'planted'
      && Math.hypot(p.pos[0] - this.bomb.pos[0], p.pos[2] - this.bomb.pos[2]) <= BOMB.defuseReach
      && Math.abs(p.pos[1] - this.bomb.pos[1]) < 64;
  }

  setPlanting(p, on) {
    if (!on) { if (this.planting.delete(p.id)) this.send(p, { t: 'plant', state: 'cancel' }); return; }
    if (this.planting.has(p.id)) return;
    if (!p.alive || !p.c4 || p.weapon !== 'c4' || this.phase !== 'round') return;
    if (!this.inSite(p.pos)) { this.send(p, { t: 'plant', state: 'no_site' }); return; }
    this.planting.set(p.id, { at: now(), pos: p.pos.slice() });
    this.send(p, { t: 'plant', state: 'start', time: ROUND.plantTime });
  }

  setDefusing(p, on) {
    if (!on) { if (this.defusing.delete(p.id)) this.send(p, { t: 'defuse', state: 'cancel' }); return; }
    if (this.defusing.has(p.id) || !this.canDefuse(p)) return;
    const time = p.kit ? ROUND.defuseKitTime : ROUND.defuseTime;
    this.defusing.set(p.id, { at: now(), time, pos: p.pos.slice() });
    this.send(p, { t: 'defuse', state: 'start', time });
    this.broadcast({ t: 'bomb_event', kind: 'defusing', by: p.id, kit: !!p.kit });
  }

  updateBomb(t) {
    // planting
    for (const [id, st] of this.planting) {
      const p = this.players.get(id);
      if (!p || !p.alive || !p.c4 || p.weapon !== 'c4' || this.phase !== 'round'
        || Math.hypot(p.pos[0] - st.pos[0], p.pos[2] - st.pos[2]) > 12) { this.setPlanting(p || { id }, false); continue; }
      if (t - st.at >= ROUND.plantTime) this.plant(p);
    }
    // defusing
    for (const [id, st] of this.defusing) {
      const p = this.players.get(id);
      if (!p || !this.canDefuse(p) || Math.hypot(p.pos[0] - st.pos[0], p.pos[2] - st.pos[2]) > 24) { this.setDefusing(p || { id }, false); continue; }
      if (t - st.at >= st.time) { this.defuse(p); break; }
    }
    // pick up a dropped bomb by walking over it
    if (this.bomb.state === 'dropped' && ['round', 'freeze'].includes(this.phase)) {
      for (const p of this.players.values()) {
        if (p.alive && p.team === TEAM.T && Math.hypot(p.pos[0] - this.bomb.pos[0], p.pos[2] - this.bomb.pos[2]) < BOMB.pickupReach
          && Math.abs(p.pos[1] - this.bomb.pos[1]) < 60 && t > (p.dropCooldown || 0)) {
          p.c4 = true;
          this.bomb = { state: 'carried', pos: null, carrier: p.id, plantedAt: 0, explodeAt: 0 };
          this.sendInv(p);
          this.broadcastTeam(TEAM.T, { t: 'bomb_event', kind: 'picked', by: p.id });
          break;
        }
      }
    }
  }

  plant(p) {
    this.planting.delete(p.id);
    p.c4 = false;
    p.weapon = p.inv.primary || p.inv.secondary || 'knife';
    const pos = p.pos.slice();
    this.bomb = { state: 'planted', pos, carrier: null, plantedAt: now(), explodeAt: now() + this.rules.c4timer, site: this.inSite(pos) };
    this.plantedThisRound = true;
    this.addMoney(p, ECONOMY.planterReward, 'bomb planted');
    this.sendInv(p);
    this.phase = 'planted';
    this.phaseEndsAt = this.bomb.explodeAt;
    this.broadcast({ t: 'bomb_event', kind: 'planted', by: p.id, pos, site: this.bomb.site, time: this.rules.c4timer });
    this.broadcast({ t: 'round', ...this.roundInfo() });
    for (const q of this.players.values()) if (q.bot) q.bot.goal = null;
  }

  defuse(p) {
    this.defusing.clear();
    this.bomb.state = 'defused';
    this.addMoney(p, ECONOMY.defuserReward, 'bomb defused');
    this.broadcast({ t: 'bomb_event', kind: 'defused', by: p.id });
    this.endRound(TEAM.CT, 'defuse');
  }

  explode() {
    const pos = this.bomb.pos;
    this.bomb.state = 'exploded';
    this.defusing.clear();
    this.phase = 'exploding'; // deaths from the blast must not end the round as an elimination
    this.broadcast({ t: 'bomb_event', kind: 'exploded', pos });
    // the blast ignores armour and walls (CS 1.6 did the same within its radius)
    for (const q of this.players.values()) {
      if (!q.alive) continue;
      const d = Math.hypot(q.pos[0] - pos[0], q.pos[1] - pos[1], q.pos[2] - pos[2]);
      if (d >= BOMB.blastRadius) continue;
      const dmg = Math.round(BOMB.blastDamage * (1 - d / BOMB.blastRadius));
      if (dmg <= 0) continue;
      q.hp -= dmg;
      this.broadcast({ t: 'hit', victim: q.id, attacker: q.id, part: 'body', dmg, hp: Math.max(0, q.hp), armor: q.armor, weapon: 'c4', point: [q.pos[0], q.pos[1] + 40, q.pos[2]], from: pos });
      if (q.hp <= 0) this.kill(q, null, 'c4', false);
    }
    this.phase = 'planted';
    this.endRound(TEAM.T, 'bomb');
  }

  // ------------------------------------------------------------- players

  addPlayer(ws, name, { team: wantTeam = 0 } = {}) {
    const id = nextId++;
    // auto-balance by HUMANS (bots make way), then by total; T on a tie
    const hT = this.humanCount(TEAM.T), hCT = this.humanCount(TEAM.CT);
    let team = hT !== hCT ? (hT < hCT ? TEAM.T : TEAM.CT)
      : (this.teamSize(TEAM.T) <= this.teamSize(TEAM.CT) ? TEAM.T : TEAM.CT);
    if (wantTeam === TEAM.T || wantTeam === TEAM.CT) team = wantTeam;
    const p = this.makePlayer(id, ws, (String(name || '').trim() || `Player ${id}`).slice(0, 24), team);
    this.players.set(id, p);

    // Mid-round joiners sit out until the next round, like CS.
    const canSpawn = this.phase === 'warmup' || this.phase === 'freeze';
    if (canSpawn) this.respawn(p, true, false);
    else p.pos = [...this.spawnSpots(p.team)[0]];

    p.token = randomBytes(12).toString('hex');       // lets this player resume after a drop
    this.sendWelcome(p);
    this.broadcast({ t: 'spawn', player: this.publicPlayer(p) }, id);
    this.balanceBots();
    this.checkMode();
    return p;
  }

  sendWelcome(p) {
    this.send(p, {
      t: 'welcome',
      id: p.id, token: p.token, room: this.id,
      mapId: this.map.id,
      you: this.publicPlayer(p),
      players: [...this.players.values()].map((q) => this.publicPlayer(q)),
      round: this.roundInfo(),
      bomb: this.bombInfo(p),
      smokes: this.smokes.map((s2) => ({ pos: s2.pos, left: s2.until - now() })),
      motd: this.motd(),
      doors: this.doorOpen, glassBroken: [...this.glassBroken],
    });
    this.sendInv(p);
  }

  // ------------------------------------------------------------- dropped connections
  //
  // The socket died without a goodbye: keep the player for RESUME_GRACE s so a
  // reconnect (same token) picks up where it left off. Meanwhile it is out of
  // the round (no frozen body to shoot, the bomb drops) but keeps its guns.
  detach(p) {
    if (!this.players.has(p.id) || p.dc) return;
    p.ws = null;
    p.dc = now();
    if (p.alive) {
      if (p.c4) this.dropBomb(p);
      this.planting.delete(p.id); this.defusing.delete(p.id);
      p.alive = false;
      p.keepLoadout = true;                 // it did not die: keep what it had
    }
    this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: `${p.name} lost connection — waiting ${RESUME_GRACE} s for them to come back` });
    this.checkWinCondition();
  }

  resume(p, ws) {
    p.ws = ws;
    p.dc = null;
    p.lastMsgAt = p.lastCmdAt = now();
    p.heard = !!(ws && typeof ws.ping === 'function');
    p.lastSeq = 0; p.move = null;          // a fresh client: its command numbers start over
    if (this.phase === 'warmup' || this.phase === 'dm') this.respawn(p, true);
    this.sendWelcome(p);
    this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: `${p.name} reconnected` });
    return p;
  }

  findResumable(token) {
    if (!token) return null;
    for (const p of this.players.values()) if (p.dc && p.token === token) return p;
    return null;
  }

  humanCount(team) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team && !p.bot) n++;
    return n;
  }

  // Public rooms: keep each team at `fillTo` players with bots. A joining
  // human takes a bot's place; an empty room has no bots.
  // message of the day (MOTD env var, else a short how-to for this room)
  motd() {
    if (process.env.MOTD) return process.env.MOTD;
    const r = this.rules;
    return `${this.map.id} · ${r.name}\n`
      + `${Math.floor(this.roundTime / 60)}:${String(this.roundTime % 60).padStart(2, '0')} rounds, first to ${r.winlimit} of ${r.maxrounds}, `
      + `friendly fire ${r.friendlyfire ? 'ON (35 %)' : 'off'}, tickrate ${r.tickrate}.\n\n`
      + `B buy · F1 autobuy · F2 rebuy · M team · Z/X/V radio · ~ console · Tab scores\n`
      + (this.dm ? 'Deathmatch: instant respawns, most frags wins.'
        : this.fy ? 'fy_: no buying — grab a gun off the floor. Last side standing wins the round.'
        : this.vipMode ? 'CT: escort the VIP to the escape zone. T: take the VIP out.'
        : this.hostageMode ? 'CT: walk up to a hostage and press E, lead it to a rescue zone.' : 'T: plant the C4 at A or B. CT: stop them or defuse it.');
  }

  // M: change sides. Alive mid-round, that kills you (CS); mp_limitteams 2
  // keeps humans within two of each other.
  joinTeam(p, want) {
    let team = want === 'T' ? TEAM.T : want === 'CT' ? TEAM.CT : 0;
    if (!team) {
      const hT = this.humanCount(TEAM.T), hCT = this.humanCount(TEAM.CT);
      team = hT !== hCT ? (hT < hCT ? TEAM.T : TEAM.CT) : (this.teamSize(TEAM.T) <= this.teamSize(TEAM.CT) ? TEAM.T : TEAM.CT);
    }
    if (team === p.team) return this.send(p, { t: 'team_fail', reason: 'you are already on that team' });
    if (!p.bot && this.humanCount(team) + 1 - (this.humanCount(other(team)) - 1) > 2) {
      return this.send(p, { t: 'team_fail', reason: 'too many players on that team' });
    }
    if (p.alive && this.competitive) {
      this.kill(p, null, 'world', false);
      p.deaths = Math.max(0, p.deaths - 1);        // a team change is not a death
    }
    if (p.c4) this.dropBomb(p);
    p.team = team;
    this.resetLoadout(p);
    p.money = Math.max(p.money, 0);
    this.send(p, { t: 'team', team });
    this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: `${p.name} is joining the ${team === TEAM.T ? 'Terrorist' : 'Counter-Terrorist'} force` });
    if (!this.competitive) this.respawn(p, true);
    else if (this.phase === 'freeze') this.respawn(p, true);
    this.sendInv(p);
    this.balanceBots();
    this.checkMode();
    this.checkWinCondition();
  }

  balanceBots() {
    if (!this.fillTo || this.practice) return;
    const anyHuman = this.humans.length > 0;
    for (const team of [TEAM.T, TEAM.CT]) {
      const bots = [...this.players.values()].filter((p) => p.bot && p.team === team);
      const want = anyHuman ? Math.max(0, this.fillTo - this.humanCount(team)) : 0;
      for (let i = bots.length; i < want; i++) this.addBot(team, this.botDifficulty);
      if (bots.length > want) {
        bots.sort((a, b) => (a.alive - b.alive) || (b.id - a.id)); // dead ones first
        for (const b of bots.slice(0, bots.length - want)) this.removePlayer(b.id, true);
      }
    }
  }

  addBot(team, difficulty = 'normal') {
    const used = new Set([...this.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${nextId}`;
    const p = this.makePlayer(nextId++, null, name, team);
    p.bot = new BotBrain(this, p, difficulty);
    if (Math.random() < 0.4) p.finPref = { '*': 1 + Math.floor(Math.random() * (FINISHES.length - 1)) };   // some bots like a flashy gun
    this.players.set(p.id, p);
    const canSpawn = this.phase === 'warmup' || this.phase === 'freeze';
    if (canSpawn) this.respawn(p, true, false);
    else p.pos = [...this.spawnSpots(p.team)[0]];
    this.broadcast({ t: 'spawn', player: this.publicPlayer(p) });
    return p;
  }

  makePlayer(id, ws, name, team) {
    const p = {
      id, ws, name, team, bot: null,
      pos: [0, 0, 0], yaw: 0, pitch: 0, crouching: false, moving: false,
      hp: PLAYER.maxHp, armor: 0, helmet: false, kit: false, c4: false, alive: false,
      money: this.competitive ? ECONOMY.startMoney : ECONOMY.warmupMoney,
      inv: {}, ammo: {}, weapon: 'knife', nades: {}, blindUntil: 0,
      nextFire: 0, lastFire: 0, burst: 0, reloadUntil: 0, recoil: newRecoil(), speed: 0, modes: {}, burstIdx: 0, shellAt: 0,
      kills: 0, deaths: 0, skin: Math.floor(Math.random() * 4), lastMsgAt: now(), lastCmdAt: now(),
      heard: !!(ws && typeof ws.ping === 'function'),   // idle checks: real WebSockets only (test sockets are plain objects)
      fin: {}, finPref: {},                // weapon finishes: per gun in hand / the player's picks
    };
    this.resetLoadout(p);
    return p;
  }

  // ------------------------------------------------------------- ghosts / AFK
  //
  // A ghost: the game stopped talking to us (closed laptop, dropped Wi-Fi,
  // crashed tab) but the socket never closed. A frozen player: connected,
  // alive in a live round, but no input (tabbed out, walked away).

  get liveRound() { return ['round', 'freeze', 'planted', 'dm'].includes(this.phase); }

  unresponsive(p, t = now()) { return !p.bot && !!p.heard && t - (p.lastMsgAt || t) > 8; }
  frozen(p, t = now()) { return !p.bot && !!p.heard && p.alive && this.liveRound && t - (p.lastCmdAt || t) > 15; }

  kickPlayer(p, reason) {
    if (!this.players.has(p.id)) return;
    try { this.send(p, { t: 'error', text: reason }); } catch {}
    this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: `${p.name} was kicked (${reason})` }, p.id);
    this.removePlayer(p.id);
    if (p.ws) { try { p.ws.close(); } catch {} setTimeout(() => { try { p.ws.terminate && p.ws.terminate(); } catch {} }, 2000); }
  }

  // anyone may ask; only players the server sees as ghosts / frozen go
  kickIdle(by) {
    const t = now();
    if (t - (by.kickIdleAt || 0) < 5) return this.send(by, { t: 'notice', text: 'wait a moment before trying again' });
    by.kickIdleAt = t;
    const gone = [];
    for (const q of [...this.players.values()]) {
      if (q === by || q.bot || q.dc) continue;
      if (this.unresponsive(q, t)) { this.kickPlayer(q, 'not responding'); gone.push(q.name); }
      else if (this.frozen(q, t)) { this.kickPlayer(q, 'AFK / frozen'); gone.push(q.name); }
    }
    this.send(by, { t: 'notice', text: gone.length ? `kicked: ${gone.join(', ')}` : 'nobody is frozen or disconnected' });
  }

  checkIdle(t) {
    if (t < (this._idleCheck || 0)) return;
    this._idleCheck = t + 1;
    for (const p of [...this.players.values()]) {
      if (p.bot || !p.heard || p.dc) continue;
      if (this.rules.timeout && t - (p.lastMsgAt || t) > this.rules.timeout) { this.kickPlayer(p, 'timed out'); continue; }
      if (this.practice || !this.rules.afkkick || !this.frozen(p, t)) continue;
      const idle = t - p.lastCmdAt;
      if (idle > this.rules.afkkick) this.kickPlayer(p, 'AFK');
      else if (idle > this.rules.afkkick - 20 && !p.afkWarned) {
        p.afkWarned = true;
        this.send(p, { t: 'notice', text: 'you will be kicked for being AFK in 20 s — move!' });
      }
    }
  }

  removePlayer(id, fromBalance = false) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.c4 && p.alive) this.dropBomb(p);
    this.players.delete(id);
    this.planting.delete(id); this.defusing.delete(id); this.votes.delete(id);
    this.broadcast({ t: 'despawn', id });
    if (!fromBalance) this.balanceBots();
    this.checkMode();
    this.checkWinCondition();
  }

  resetLoadout(p) {
    const pistol = DEFAULT_PISTOL[p.team];
    p.inv = { primary: null, secondary: pistol, melee: 'knife' };
    p.fin = {};
    p.ammo = {
      [pistol]: { mag: WEAPONS[pistol].mag, reserve: WEAPONS[pistol].reserve },
      knife: { mag: 1, reserve: 0 },
    };
    p.weapon = pistol;
    p.armor = 0; p.helmet = false; p.kit = false;
    p.nades = {};
    p.modes = {};
    p.nvg = false; p.shield = false;
    p.reloadUntil = 0; p.burst = 0; p.shellAt = 0; p.burstIdx = 0;
  }

  // Up to 10 spots per team: the map's spawn cluster, then nav nodes around it.
  spawnSpots(team) {
    if (this._spawnSpots[team]) return this._spawnSpots[team];
    const base = (this.map.spawns[team] || this.map.spawns[TEAM.T]).map((s) => s.slice());
    const [cx, cz] = buyZoneCenter(this.map, team);
    const cand = this.nav.nodes
      .filter((n) => n.main && Math.hypot(n.x - cx, n.z - cz) < 420 && Math.abs(n.y - base[0][1]) < 30
        && this.nav.visible([cx, base[0][1] + 40, cz], [n.x, n.y + 40, n.z]))  // same room as the spawn
      .sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz));
    const spots = base;
    for (const n of cand) {
      if (spots.length >= 10) break;
      if (spots.every((s) => Math.hypot(s[0] - n.x, s[2] - n.z) >= 56)) spots.push([n.x, n.y, n.z]);
    }
    return (this._spawnSpots[team] = spots);
  }

  respawn(p, instant = false, notify = true) {
    if (p.dc) return;                       // disconnected: back when it reconnects
    if (this.dm && this.phase === 'dm') {
      const spot = this.dmSpot(p) || this.spawnSpots(p.team)[0];
      p.pos = spot.slice(); this.resetMove(p);
      p.yaw = Math.random() * Math.PI * 2; p.hp = PLAYER.maxHp; p.money = ECONOMY.warmupMoney;
      p.reloadUntil = 0; p.nextFire = 0; resetRecoil(p.recoil, p.weapon);
      const go = () => {
        if (!this.players.has(p.id) || this.phase !== 'dm') return;
        p.alive = true;
        if (p.bot) { p.bot.reset(); p.bot.buy(); }
        if (notify) { this.send(p, { t: 'respawn', pos: p.pos, yaw: p.yaw, hp: p.hp }); this.sendInv(p); }
      };
      if (instant) go(); else setTimeout(go, 2000);
      return;
    }
    const spots = this.spawnSpots(p.team);
    const taken = new Set([...this.players.values()].filter((q) => q !== p && q.alive && q.team === p.team).map((q) => q.spawnIdx));
    let idx = spots.findIndex((_, i) => !taken.has(i));
    if (idx < 0) idx = Math.floor(Math.random() * spots.length);
    p.spawnIdx = idx;
    const spot = spots[idx];
    p.pos = [spot[0], spot[1], spot[2]];
    this.resetMove(p);
    p.yaw = this.spawnYaw(p.team);
    p.hp = PLAYER.maxHp;
    p.burst = 0;
    resetRecoil(p.recoil, p.weapon);
    p.reloadUntil = 0;
    p.nextFire = 0;
    const go = () => {
      if (!this.players.has(p.id)) return;
      p.alive = true;
      if (p.bot) p.bot.reset();
      if (notify) {
        this.send(p, { t: 'respawn', pos: p.pos, yaw: p.yaw, hp: p.hp });
        this.sendInv(p);
      }
    };
    if (instant) go();
    else setTimeout(go, 1500); // warmup death cam
  }

  respawnStuck(p) { this.respawn(p, true); }

  // Face the way out of the spawn: of 16 headings, the one with the longest
  // clear line of sight at eye height (ties broken toward the map centre).
  spawnYaw(team) {
    if (this._spawnYaw[team] !== undefined) return this._spawnYaw[team];
    const s = this.map.spawns[team][0];
    const b = this.map.bounds;
    const toMid = Math.atan2(-((b.x0 + b.x1) / 2 - s[0]), -((b.z0 + b.z1) / 2 - s[2]));
    let best = toMid, bestScore = -1;
    for (let i = 0; i < 16; i++) {
      const yaw = (i / 16) * Math.PI * 2;
      const dir = [-Math.sin(yaw), 0, -Math.cos(yaw)];
      const hit = raycast([s[0], s[1] + PLAYER.standEye, s[2]], dir, this.colliders, 4000);
      const dist = hit ? hit.t : 4000;
      const score = dist + Math.cos(yaw - toMid) * 200;
      if (score > bestScore) { bestScore = score; best = yaw; }
    }
    return (this._spawnYaw[team] = best);
  }

  // ------------------------------------------------------------- VIP (M16)

  pickVip() {
    for (const p of this.players.values()) p.vip = false;
    const cts = [...this.players.values()].filter((p) => p.team === TEAM.CT && p.alive);
    if (!cts.length) return;
    const humans = cts.filter((p) => !p.bot);
    const pool = humans.length && Math.random() < 0.7 ? humans : cts;
    const v = pool[Math.floor(Math.random() * pool.length)];
    v.vip = true;
    // the VIP: a USP, 200 armour with helmet, nothing else
    v.inv = { primary: null, secondary: 'usp', melee: 'knife' };
    v.ammo = { usp: { mag: WEAPONS.usp.mag, reserve: WEAPONS.usp.reserve }, knife: { mag: 1, reserve: 0 } };
    v.weapon = 'usp'; v.nades = {}; v.armor = 200; v.helmet = true;
    this.vipId = v.id;
    this.sendInv(v);
    this.send(v, { t: 'vip' });
  }

  checkVipEscape() {
    if (!this.vipMode || this.phase !== 'round') return;
    const v = this.players.get(this.vipId);
    if (!v || !v.alive || !v.vip) return;
    const z = this.vipEscape();
    if (Math.hypot(v.pos[0] - z[0], v.pos[2] - z[2]) <= z[3]) this.endRound(TEAM.CT, 'escape');
  }

  // ------------------------------------------------------------- doors + glass (M15)

  // E next to a door opens / closes it (func_door); true if one was used
  useDoor(p) {
    const eye = [p.pos[0], p.pos[1] + 40, p.pos[2]];
    let best = null, bd = 96;
    for (const c of this.colliders) {
      if (!c.door) continue;
      const q = [0, 1, 2].map((i) => Math.max(c.min[i], Math.min(c.max[i], eye[i])));
      const d = Math.hypot(q[0] - eye[0], q[2] - eye[2]);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) return false;
    const t = now();
    if (t < (this._doorAt?.[best.door] || 0)) return true;          // still moving
    (this._doorAt ||= {})[best.door] = t + 0.6;
    this.setDoor(best.door, !this.doorOpen[best.door]);
    return true;
  }

  setDoor(id, open) {
    const d = (this.map.doors || []).find((x) => x.id === id);
    const c = this.colliders.find((x) => x.door === id);
    if (!d || !c) return;
    this.doorOpen[id] = open;
    const b = doorBoxAt(d, open);
    c.min = b.min; c.max = b.max;
    this.broadcast({ t: 'door', id, open });
  }

  // a bullet hit a pane: it breaks for everyone until the next round
  breakGlass(box, point) {
    if (this.glassBroken.has(box.glass)) return;
    this.glassBroken.add(box.glass);
    const i = this.colliders.indexOf(box);
    if (i >= 0) this.colliders.splice(i, 1);
    this.broadcast({ t: 'glass', id: box.glass, point });
  }

  // new round: doors shut, glass restored (CS restores breakables)
  resetWorld() {
    for (const d of this.map.doors || []) if (this.doorOpen[d.id]) this.setDoor(d.id, false);
    if (this.glassBroken.size) {
      for (const g of this.map.glass || []) {
        if (this.glassBroken.has(g.id)) this.colliders.push({ min: g.min.slice(), max: g.max.slice(), mat: 'glass', glass: g.id });
      }
      this.glassBroken.clear();
      this.broadcast({ t: 'glass_reset' });
    }
  }

  // ------------------------------------------------------------- usercmds (M11)
  //
  // Clients send their inputs — keys, view angles and frame time, with a
  // sequence number — and the server runs the same shared physics on them:
  // it owns the position. Each snapshot is followed by a `you` message with
  // the last command applied and the resulting physics state, from which the
  // client re-predicts (replays the commands the server has not seen yet).
  // A time budget (real time elapsed) stops a client from simulating faster
  // than the clock (speed hacks).

  resetMove(p) {
    p.move = { pos: p.pos.slice(), vel: [0, 0, 0], yaw: p.yaw || 0, pitch: 0, onGround: true, crouching: false };
    p.hist = [];
  }

  runCmds(p, cmds) {
    const t = now();
    if (!p.move) this.resetMove(p);
    p.usesCmds = true;
    // real time banked for movement: a lag spike delivers a burst of queued
    // commands, and up to 1 s of them is still honoured (no rubber band);
    // faster than real time on average is never possible (speedhacks)
    p.cmdBudget = Math.min(1.0, (p.cmdBudget ?? 0.2) + (t - (p.cmdClock || t)));
    p.cmdClock = t;
    const others = [];
    for (const q of this.players.values()) if (q !== p && q.alive) others.push(bodyBox(q.pos, q.crouching));
    const solids = others.length ? this.colliders.concat(others) : this.colliders;
    const w = WEAPONS[p.weapon] || WEAPONS.knife;
    for (const c of cmds.slice(0, 64)) {
      if (!c || !Number.isInteger(c.s) || c.s <= (p.lastSeq || 0)) continue;
      const dt = Math.max(0.001, Math.min(0.05, Number(c.dt) || 0));
      if (p.cmdBudget < dt - 0.05) break;               // faster than real time: dropped
      p.cmdBudget -= dt;
      p.lastSeq = c.s;
      if (Number.isFinite(c.y)) p.yaw = p.move.yaw = c.y;
      if (Number.isFinite(c.p)) p.pitch = p.move.pitch = Math.max(-1.6, Math.min(1.6, c.p));
      if (!p.alive) continue;
      const k = c.k | 0;
      const rooted = this.phase === 'freeze' || this.planting.has(p.id) || this.defusing.has(p.id);
      const keys = {
        f: rooted ? 0 : k & 1, b: rooted ? 0 : k & 2, l: rooted ? 0 : k & 4, r: rooted ? 0 : k & 8,
        jump: rooted ? 0 : k & 16, crouch: (k & 32) || this.defusing.has(p.id), walk: k & 64,
        maxSpeed: (c.z && w.zoomSpeed ? w.zoomSpeed : w.speed) * (p.shield ? 0.9 : 1), ladders: this.map.ladders, water: this.map.water,
      };
      movePlayer(p.move, keys, dt, solids);
      // drowning: 12 s of air, then 10 damage a second (CS)
      if (this.map.water && this.map.water.length && waterLevel(this.map, [p.move.pos[0], p.move.pos[1] + 12, p.move.pos[2]], p.move.crouching) >= 3) {
        p.underwater = (p.underwater || 0) + dt;
        if (p.underwater > 12 && Math.floor(p.underwater) !== Math.floor(p.underwater - dt)) {
          p.hp -= 10;
          this.broadcast({ t: 'hit', victim: p.id, attacker: p.id, part: 'chest', dmg: 10, hp: Math.max(0, p.hp), armor: p.armor, weapon: 'drown', point: p.pos, from: p.pos });
          if (p.hp <= 0) { this.kill(p, null, 'drown', false); break; }
        }
      } else p.underwater = 0;
      if (p.move.landSpeed) {
        const v = p.move.landSpeed;
        p.move.landSpeed = 0;
        if (!waterLevel(this.map, p.move.pos, p.move.crouching)) this.fallDamage(p, v);
        if (!p.alive) break;
      }
    }
    p.pos = p.move.pos;
    p.crouching = !!p.move.crouching;
    p.eye = p.move.eye;
    const sp = Math.hypot(p.move.vel[0], p.move.vel[2]);
    p.moving = sp > 12;
    p.speed = sp;
  }

  // CS 1.6: damage above 580 u/s of fall speed, fatal at 1024
  fallDamage(p, v) {
    if (!p.alive || !Number.isFinite(v) || v <= MOVE.fallSafe) return;
    const dmg = Math.min(200, Math.round((v - MOVE.fallSafe) * (100 / (MOVE.fallFatal - MOVE.fallSafe))));
    p.hp -= dmg;
    this.broadcast({ t: 'hit', victim: p.id, attacker: p.id, part: 'legs', dmg, hp: Math.max(0, p.hp), armor: p.armor, weapon: 'fall', point: p.pos, from: p.pos });
    if (p.hp <= 0) this.kill(p, null, 'fall', false);
  }

  // what the owner needs to re-predict from
  youMsg(p) {
    const m = p.move;
    return {
      t: 'you', s: p.lastSeq || 0,
      st: { pos: m.pos, vel: m.vel, onGround: m.onGround, crouching: m.crouching, inDuck: !!m.inDuck, duckT: m.duckT || 0,
        eye: m.eye, velMod: m.velMod, tagAcc: m.tagAcc, fatigue: m.fatigue, jumpHeld: !!m.jumpHeld, offLadder: m.offLadder || 0 },
    };
  }

  // Lag compensation: where every player was at server time `at`, from the
  // position history (interpolated), for up to sv_maxunlag = 0.5 s back.
  hitboxesAt(at, exclude) {
    const out = [];
    for (const q of this.players.values()) {
      if (!q.alive || q.id === exclude) continue;
      let pos = q.pos, crouch = q.crouching;
      const h = q.hist;
      if (at !== null && h && h.length) {
        let i = h.length - 1;
        while (i > 0 && h[i].t > at) i--;
        const a = h[i], b = h[Math.min(h.length - 1, i + 1)];
        if (a.t <= at && b !== a && b.t > a.t) {
          const f = Math.min(1, (at - a.t) / (b.t - a.t));
          pos = [0, 1, 2].map((k) => a.pos[k] + (b.pos[k] - a.pos[k]) * f);
          crouch = f < 0.5 ? a.crouching : b.crouching;
        } else if (a.t <= at) { pos = a.pos; crouch = a.crouching; }
        else { pos = h[0].pos; crouch = h[0].crouching; }
      }
      out.push({ id: q.id, box: hitBox(pos, crouch) });
    }
    return out;
  }

  recordHistory(t) {
    for (const p of this.players.values()) {
      if (!p.alive) { p.hist = []; continue; }
      const h = p.hist || (p.hist = []);
      h.push({ t, pos: p.pos.slice(), crouching: !!p.crouching });
      while (h.length && h[0].t < t - 1) h.shift();
    }
  }

  // ------------------------------------------------------------- movement check

  // Movement is client-predicted, so the server checks each reported step:
  // it may not pass through world geometry, cover more ground than running
  // could, or push into another player. A rejected step leaves the player
  // where they were and snaps their client back.
  acceptMove(p, pos, crouching) {
    const t = now();
    const elapsed = Math.min(1, Math.max(0.05, t - (p.moveT || t)));
    p.moveT = t;
    const from = p.pos;
    const d = Math.hypot(pos[0] - from[0], pos[2] - from[2]);
    let bad = d > 320 * elapsed + 48 || pos[1] > from[1] + 80 + 300 * elapsed;
    if (!bad) {
      // sweep a slightly slimmer, step-height-raised hull along the path
      const h = crouching ? PLAYER.crouchHeight : PLAYER.standHeight;
      const hw = PLAYER.halfWidth - 1;
      const hull = (x, y, z) => {
        const box = { min: [x - hw, y + PLAYER.stepHeight + 1, z - hw], max: [x + hw, y + h - 2, z + hw] };
        if (box.max[1] <= box.min[1]) box.max[1] = box.min[1] + 1;
        return box;
      };
      // solids the step starts in are ignored, so stepping out is always allowed
      const start = hull(from[0], from[1], from[2]);
      const solids = this.colliders.filter((c) => !aabbOverlap(start, c));
      const clear = (a, b) => {
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 8));
        for (let i = 1; i <= n; i++) {
          const f = i / n;
          const box = hull(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
          for (const c of solids) if (aabbOverlap(box, c)) return false;
        }
        return true;
      };
      // straight, or as an L (up then over: a (duck-)jump onto a ledge; over
      // then down: walking off one) — any clear route is a legal step
      const up = [from[0], pos[1], from[2]], over = [pos[0], from[1], pos[2]];
      bad = !(clear(from, pos) || (clear(from, up) && clear(up, pos)) || (clear(from, over) && clear(over, pos)));
    }
    if (!bad) {
      // walking into another player (overlaps deeper than lag can explain)
      for (const q of this.players.values()) {
        if (q === p || !q.alive) continue;
        const dx = Math.abs(pos[0] - q.pos[0]), dz = Math.abs(pos[2] - q.pos[2]);
        const reach = PLAYER.halfWidth * 2 - 8;
        if (dx < reach && dz < reach && Math.abs(pos[1] - q.pos[1]) < PLAYER.standHeight - 8
          && Math.hypot(pos[0] - q.pos[0], pos[2] - q.pos[2]) < Math.hypot(from[0] - q.pos[0], from[2] - q.pos[2]) - 0.5) { bad = true; break; }
      }
    }
    if (!bad) { p.pos = pos; return true; }
    if (!p.ws) return false;
    if (t - (p.correctT || 0) > 0.2) {
      p.correctT = t;
      this.send(p, { t: 'correct', pos: p.pos });
    }
    return false;
  }

  // ------------------------------------------------------------- messages

  onMessage(p, msg) {
    const t0 = now();
    p.lastMsgAt = t0;
    if (msg.t === 'cmd' || msg.t === 'state') { p.lastCmdAt = t0; p.afkWarned = false; }
    switch (msg.t) {
      case 'kickidle':
        this.kickIdle(p);
        break;
      case 'ready': this.setReady(p, msg.on !== false); break;
      case 'sidevote': this.voteSide(p, !!msg.switch); break;
      case 'veto_ban': this.vetoBan(p, String(msg.map || '')); break;
      case 'pause': this.requestPause(p, msg.kind === 'tech' ? 'tech' : 'tactical'); break;
      case 'unpause': this.unpause(p); break;
      case 'teamname': this.setTeamName(p, msg.name); break;
      case 'state':
        if (!p.alive || p.usesCmds) break;     // usercmd clients move by their commands
        // frozen at round start: look around, but stay on the spawn
        if (this.phase !== 'freeze' && Array.isArray(msg.pos) && msg.pos.length === 3 && msg.pos.every(Number.isFinite)) this.acceptMove(p, msg.pos, !!msg.crouching);
        if (Number.isFinite(msg.yaw)) p.yaw = msg.yaw;
        if (Number.isFinite(msg.pitch)) p.pitch = msg.pitch;
        // view height mid-duck (0.4 s blend): shots leave from where the player sees
        p.eye = Number.isFinite(msg.eye) ? Math.max(PLAYER.crouchEye, Math.min(PLAYER.standEye, msg.eye)) : undefined;
        p.crouching = !!msg.crouching;
        p.moving = !!msg.moving;
        p.speed = Number.isFinite(msg.speed) ? Math.min(400, msg.speed) : (p.moving ? 200 : 0);
        break;
      case 'dev_give': {
        // test-only (BAQ_DEV): hand a gun over, full ammo, and hold it
        const w = WEAPONS[msg.id];
        if (process.env.BAQ_DEV !== '1' || !w || !p.alive || (w.slot !== 'primary' && w.slot !== 'secondary')) break;
        p.inv[w.slot] = msg.id; p.ammo[msg.id] = { mag: w.mag, reserve: w.reserve }; p.weapon = msg.id; p.nextFire = 0;
        this.sendInv(p);
        break;
      }
      case 'dev_tp':
        if (process.env.BAQ_DEV === '1' && p.alive && this.phase !== 'freeze' && Array.isArray(msg.pos)) { p.pos = msg.pos.map(Number); p.moveT = now(); if (p.move) p.move.pos = p.pos.slice(); }
        break;
      case 'fire':
        this.handleFire(p, msg);
        break;
      case 'reload':
        this.handleReload(p);
        break;
      case 'weapon':
        this.handleSwitch(p, msg.id);
        break;
      case 'buy':
        this.handleBuy(p, String(msg.item || ''));
        break;
      case 'alt':
        this.handleAlt(p);
        break;
      case 'jointeam':
        this.joinTeam(p, String(msg.team || 'auto'));
        if (Number.isInteger(msg.skin)) p.skin = Math.max(0, Math.min(3, msg.skin));
        break;
      case 'finishes': {
        // the player's picks (M21): { weaponId | '*': finish index }
        const f = {};
        for (const [k, v] of Object.entries(msg.f || {}).slice(0, 48)) {
          if ((k === '*' || WEAPONS[k]) && Number.isInteger(v) && v >= 0 && v < FINISHES.length) f[k] = v;
        }
        p.finPref = f;
        this.sendInv(p);
        break;
      }
      case 'skin':
        // appearance (M19): 0-3, anything else = random (CS auto-select)
        p.skin = Number.isInteger(msg.i) && msg.i >= 0 && msg.i <= 3 ? msg.i : Math.floor(Math.random() * 4);
        this.send(p, { t: 'myskin', i: p.skin });
        break;
      case 'suicide':
        // console "kill": -1 frag, as in CS
        if (p.alive && this.phase !== 'freeze') { p.kills--; this.kill(p, null, 'world', false); }
        break;
      case 'autobuy':
        this.autobuy(p);
        break;
      case 'rebuy':
        this.rebuy(p);
        break;
      case 'plant':
        this.setPlanting(p, !!msg.on);
        break;
      case 'defuse':
        // E: a door within reach first (unless the bomb is right here)
        if (msg.on && p.alive && !this.canDefuse(p) && this.useDoor(p)) break;
        if (msg.on && this.hostageMode) { this.useHostage(p); break; }
        this.setDefusing(p, !!msg.on);
        break;
      case 'fall':
        // legacy clients report their landings; usercmd clients are
        // simulated here and take fall damage in runCmds
        if (!p.usesCmds) this.fallDamage(p, Number(msg.speed));
        break;
      case 'cmd':
        if (Array.isArray(msg.c)) this.runCmds(p, msg.c);
        break;
      case 'radio':
        this.radio(p, String(msg.menu || ''), Number(msg.i));
        break;
      case 'throw':
        this.throwNade(p, msg);
        break;
      case 'drop':
        if (!p.alive) break;
        // G drops what you hold: the bomb, or a gun (never the knife or grenades)
        if (p.weapon === 'c4') { if (p.c4 && this.phase !== 'freeze') { p.dropCooldown = now() + 1.5; this.dropBomb(p, true); } }
        else this.dropWeapon(p, p.weapon, true);
        break;
      case 'vote':
        if (this.phase === 'matchend' && MAP_LIST.some((m) => m.id === msg.map)) {
          this.votes.set(p.id, msg.map);
          this.broadcast({ t: 'votes', tally: this.tally() });
        }
        break;
      // voice: relay the WebRTC handshake to a teammate; who is talking
      case 'rtc': {
        const q = this.players.get(Number(msg.to));
        if (q && q.team === p.team && !q.bot && JSON.stringify(msg.data || {}).length < 16000) this.send(q, { t: 'rtc', from: p.id, data: msg.data });
        break;
      }
      case 'talk':
        this.broadcastTeam(p.team, { t: 'talk', id: p.id, on: !!msg.on });
        break;
      case 'pong':
        if (Number.isFinite(msg.ts)) p.ping = Math.max(0, Math.min(999, Math.round((now() - msg.ts) * 1000)));
        break;
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 140);
        if (text) this.broadcast({ t: 'chat', id: p.id, name: p.name, team: p.team, text });
        if (text.startsWith('!')) this.chatCommand(p, text);
        break;
      }
    }
  }

  // ------------------------------------------------------------- weapons

  owns(p, id) {
    if (WEAPONS[id] && WEAPONS[id].grenade) return (p.nades[id] || 0) > 0;
    return p.inv.primary === id || p.inv.secondary === id || p.inv.melee === id || (id === 'c4' && p.c4);
  }

  // ------------------------------------------------------------- grenades

  throwNade(p, msg = {}) {
    const w = WEAPONS[p.weapon];
    const t = now();
    if (!p.alive || !w || !w.grenade || !(p.nades[p.weapon] > 0) || t < p.nextFire - 0.05) return;
    if (this.phase === 'freeze' || this.phase === 'matchend') return;
    const kind = p.weapon;
    const v = Array.isArray(msg.vel) && msg.vel.every(Number.isFinite) ? msg.vel.map((x) => Math.max(-400, Math.min(400, x))) : [0, 0, 0];
    const { vel, fwd } = throwVelocity(p.yaw, p.pitch, v);
    const eye = [p.pos[0], p.pos[1] + eyeOf(p), p.pos[2]];
    // start 16 u in front of the eye, unless that is inside a wall
    let origin = [eye[0] + fwd[0] * 16, eye[1] + fwd[1] * 16, eye[2] + fwd[2] * 16];
    if (raycast(eye, fwd, this.colliders, 18)) origin = eye;
    const n = { id: ++this.nadeSeq, owner: p.id, team: p.team, ...newNade(kind, origin, vel) };
    this.nades.push(n);
    p.nades[kind]--;
    p.nextFire = t + 0.6;
    this.broadcast({ t: 'nade', id: n.id, kind, pos: origin, vel, owner: p.id });
    // CS: after the last one, back to your gun
    if (!(p.nades[kind] > 0)) {
      p.weapon = p.inv.primary || p.inv.secondary || 'knife';
      resetRecoil(p.recoil, p.weapon);
    }
    this.sendInv(p);
  }

  updateNades(dt, t) {
    for (let i = this.nades.length - 1; i >= 0; i--) {
      const n = this.nades[i];
      stepNade(n, dt, this.colliders);
      const spec = NADES[n.kind];
      const due = spec.settle ? (n.rest && n.age >= spec.fuse) || n.age > 3.5 : n.age >= spec.fuse;
      if (!due) continue;
      this.nades.splice(i, 1);
      this.detonate(n, t);
    }
    this.smokes = this.smokes.filter((s) => t < s.until);
  }

  detonate(n, t) {
    const pos = n.pos;
    const spec = NADES[n.kind];
    const owner = this.players.get(n.owner);
    this.broadcast({ t: 'nade_boom', id: n.id, kind: n.kind, pos, duration: spec.duration || 0 });
    if (n.kind === 'smokegrenade') {
      this.smokes.push({ pos: [pos[0], pos[1] + 40, pos[2]], from: t, until: t + spec.duration, radius: spec.radius });
      return;
    }
    const blastFrom = [pos[0], pos[1] + 8, pos[2]];
    const visible = (to) => {
      const d = [to[0] - blastFrom[0], to[1] - blastFrom[1], to[2] - blastFrom[2]];
      const L = Math.hypot(...d);
      return L < 1 || !raycast(blastFrom, d.map((x) => x / L), this.colliders, L - 2);
    };
    for (const q of this.players.values()) {
      if (!q.alive) continue;
      if (n.kind === 'hegrenade') {
        const chest = [q.pos[0], q.pos[1] + 36, q.pos[2]];
        const d = Math.hypot(chest[0] - pos[0], chest[1] - pos[1], chest[2] - pos[2]);
        if (d >= spec.radius || !visible(chest)) continue;
        // you can always hurt yourself; teammates only with friendly fire (at 35 %)
        const mate = owner && q !== owner && q.team === n.team && this.competitive;
        if (mate && !this.rules.friendlyfire) continue;
        const raw = spec.damage * (1 - d / spec.radius) * (mate ? FF_DAMAGE : 1);
        const { hpDmg, armorDmg } = armorAbsorb(raw, 'chest', q.armor, q.helmet, 1.0);
        q.armor = Math.max(0, q.armor - armorDmg);
        q.hp -= hpDmg;
        if (q.bot && owner) q.bot.onHurt(owner, t);
        this.broadcast({ t: 'hit', victim: q.id, attacker: n.owner, part: 'chest', dmg: hpDmg, hp: Math.max(0, q.hp), armor: q.armor, helmet: !!q.helmet, weapon: 'hegrenade', point: chest, from: pos });
        if (q.hp <= 0) this.kill(q, owner && owner !== q ? owner : null, 'hegrenade', false);
      } else if (n.kind === 'flashbang') {
        const eye = [q.pos[0], q.pos[1] + eyeOf(q), q.pos[2]];
        if (!visible(eye)) continue;
        const f = flashAmount(eye, q.yaw, q.pitch, pos);
        if (f.amount <= 0.02) continue;
        q.blindUntil = t + f.seconds * Math.min(1, f.amount + 0.2);
        this.send(q, { t: 'flashed', amount: f.amount, seconds: f.seconds, pos });
      }
    }
  }

  handleSwitch(p, id) {
    if (!p.alive || !WEAPONS[id] || !this.owns(p, id) || p.weapon === id) return;
    p.weapon = id;
    resetRecoil(p.recoil, id);
    p.reloadUntil = 0;          // switching cancels a reload (CS)
    p.shellAt = 0;
    p.burst = 0; p.burstIdx = 0;
    p.nextFire = now() + (WEAPONS[id].deploy || DRAW_TIME);
    this.planting.delete(p.id);
    this.sendAmmo(p);
  }

  handleFire(p, msg) {
    if (!p.alive || this.phase === 'freeze' || this.phase === 'matchend') return;
    const base = WEAPONS[p.weapon];
    if (base.bomb || base.grenade) return; // C4: see 'plant'; grenades: see 'throw'
    const mode = base.alt === 'stab' ? (msg.alt ? 'stab' : null) : p.modes[p.weapon] || null;
    const w = weaponStats(p.weapon, mode);
    const t = now();
    const ammo = p.ammo[p.weapon];
    const zoomed = !!msg.zoomed && !!w.zoomFov;
    // a shell reload is interrupted by firing
    if (p.shellAt && ammo && ammo.mag > 0) p.shellAt = 0;
    // Tolerance: packets bunch up in transit, so allow a slightly early shot.
    const rof = zoomed && w.zoomRof ? w.zoomRof : w.rof;
    const early = Math.min(0.05, rof * 0.4);
    if (p.reloadUntil || p.shellAt || t < p.nextFire - early || (!w.melee && (!ammo || ammo.mag <= 0))) {
      this.sendAmmo(p); // resync the client's prediction
      return;
    }

    p.lastFire = t;
    if (mode === 'burst') {
      // three rounds a gap apart, then the burst cycle (Glock 18 / FAMAS)
      if (t - p.burstAt > w.cycle * 0.8) p.burstIdx = 0;
      if (p.burstIdx === 0) p.burstAt = t;
      p.burstIdx++;
      p.nextFire = p.burstIdx < w.count ? t + w.gap : p.burstAt + w.cycle;
      if (p.burstIdx >= w.count) p.burstIdx = 0;
    } else p.nextFire = t + rof;
    if (!w.melee) ammo.mag--;

    // CS 1.6 spread: from the shooter's stance and accuracy (shots in the
    // burst for automatics, time between shots for pistols). The client's
    // direction already includes its view punch, i.e. the spray pattern.
    const spread = shotSpread(p.recoil, p.weapon, {
      now: t, onGround: this.isGrounded(p), speed: p.moving ? (p.speed || 200) : 0,
      ducking: p.crouching, zoomed, mode,
    });
    const dir = norm(Array.isArray(msg.dir) && msg.dir.every(Number.isFinite) ? msg.dir : [0, 0, -1]);
    // trust the client's eye origin only if it is where we think the player is
    const eye = [p.pos[0], p.pos[1] + eyeOf(p), p.pos[2]];
    let origin = Array.isArray(msg.origin) && msg.origin.every(Number.isFinite) ? msg.origin : eye;
    if (len(sub(origin, eye)) > 96) origin = eye;

    // lag compensation: hit boxes where the shooter saw them (the view time
    // the client reports, at most 0.5 s back)
    const vt = Number(msg.vt);
    const at = p.usesCmds && Number.isFinite(vt) ? Math.max(t - 0.5, Math.min(t, vt)) : null;
    const others = this.hitboxesAt(at, p.id);
    if (this.hostageMode) for (const h of this.hostages) if (h.alive && !h.rescued) others.push({ id: h.id, box: hitBox(h.pos, false) });

    if (!w.melee) this.noise(p, mode === 'silenced');
    const pellets = w.pellets || 1;
    const dirs = [];
    const total = new Map();           // victim id -> { dmg, part, point, pen } (pellets add up)
    let pens = [];
    for (let k = 0; k < pellets; k++) {
      const shotDir = spreadDir(dir, spread);
      dirs.push(shotDir);
      if (w.melee) {
        const reach = w.reach || MELEE_REACH;
        const world = raycast(origin, shotDir, this.colliders, reach);
        const ph = raycastPlayers(origin, shotDir, others, reach, p.id);
        if (ph && (!world || ph.t < world.t)) this.addHit(total, ph.id, baseDamage(p.weapon, ph.part, ph.t, mode), ph, false);
        continue;
      }
      if (w.pellets) {
        const world = raycast(origin, shotDir, this.colliders, w.range);
        if (world && world.box.glass) { this.breakGlass(world.box, world.point); continue; }
        const ph = raycastPlayers(origin, shotDir, others, w.range, p.id);
        if (ph && (!world || ph.t < world.t)) this.addHit(total, ph.id, baseDamage(p.weapon, ph.part, ph.t, mode), ph, false);
        continue;
      }
      const tr = traceBullet({ origin, dir: shotDir, colliders: this.colliders, targets: others, exclude: p.id, w, matOf: this.matOf, onGlass: (b, pt) => this.breakGlass(b, pt) });
      for (const h of tr.hits) this.addHit(total, h.id, h.dmg, h, h.pen);
      pens = tr.exits;
    }

    // tracer / effects for everyone else (even if it hits nothing)
    this.broadcast({ t: 'shoot', id: p.id, origin, dir: dirs[0], dirs: pellets > 1 ? dirs : undefined, weapon: p.weapon, mode, exits: pens.length ? pens : undefined }, p.id);

    for (const [id, h] of total) {
      const hostage = id >= 1000 && this.hostages && this.hostages.find((x) => x.id === id);
      if (hostage) this.damageHostage(hostage, p, Math.round(h.dmg));
      else this.applyDamage(p, h, w, h.dmg, h.pen);
    }
    if (!w.melee && ammo.mag === 0 && ammo.reserve > 0) this.handleReload(p); // auto-reload
  }

  addHit(total, id, dmg, h, pen) {
    const cur = total.get(id);
    if (cur) { cur.dmg += dmg; cur.pen = cur.pen || pen; if (h.part === 'head') cur.part = 'head'; }
    else total.set(id, { id, dmg, part: h.part, point: h.point, t: h.t || h.dist || 0, pen });
  }

  radio(p, menu, i) {
    const text = radioText(menu, i);
    const t = now();
    if (!text || !p.alive || t < (p.radioAt || 0)) return;
    p.radioAt = t + 1.2;                       // no spamming
    this.broadcastTeam(p.team, { t: 'radio', id: p.id, name: p.name, menu, i, text, pos: p.pos });
    // bots answer a few calls
    if (menu === 'x' && i === 5) {             // report in
      let k = 0;
      for (const q of this.players.values()) if (q.bot && q.alive && q.team === p.team && k++ < 3) setTimeout(() => this.radio(q, 'c', 5), 600 + k * 500);
    }
  }

  // gunfire is heard by bots within ~1800 u
  noise(p, quiet = false) {
    const t = now();
    const r = quiet ? 500 : 1800;       // a silenced shot carries a short way
    for (const q of this.players.values()) {
      if (q.bot && q.alive && q.team !== p.team && Math.hypot(q.pos[0] - p.pos[0], q.pos[2] - p.pos[2]) < r) q.bot.onNoise(p.pos, t);
    }
  }

  isGrounded(p) {
    const probe = playerBox([p.pos[0], p.pos[1] - 2, p.pos[2]], p.crouching);
    return this.colliders.some((c) =>
      probe.min[0] < c.max[0] && probe.max[0] > c.min[0] &&
      probe.min[1] < c.max[1] && probe.max[1] > c.min[1] &&
      probe.min[2] < c.max[2] && probe.max[2] > c.min[2]);
  }

  applyDamage(attacker, phit, w, dmgIn, pen = false) {
    const victim = this.players.get(phit.id);
    if (!victim || !victim.alive) return;
    const team = victim.team === attacker.team && victim !== attacker;
    if (team && this.competitive && !this.rules.friendlyfire) return;    // mp_friendlyfire 0
    // tactical shield: frontal hits on the body are stopped, unless the
    // holder has just fired (the shield comes down to shoot)
    if (victim.shield && phit.part !== 'legs' && !w.melee && now() - (victim.lastFire || 0) > 0.3) {
      const fx = -Math.sin(victim.yaw), fz = -Math.cos(victim.yaw);
      const ax = attacker.pos[0] - victim.pos[0], az = attacker.pos[2] - victim.pos[2];
      const al = Math.hypot(ax, az) || 1;
      if ((fx * ax + fz * az) / al > 0.5) { this.broadcast({ t: 'shieldhit', victim: victim.id, point: phit.point }); return; }
    }
    let dmg = dmgIn !== undefined ? dmgIn : baseDamage(attacker.weapon, phit.part, phit.t);
    if (team && this.competitive) dmg *= FF_DAMAGE;                     // CS: teammates take 35 %
    if (w.melee && w.backstab) {
      // knife stab from behind the victim: triple damage
      const fx = -Math.sin(victim.yaw), fz = -Math.cos(victim.yaw);
      const ax = attacker.pos[0] - victim.pos[0], az = attacker.pos[2] - victim.pos[2];
      const al = Math.hypot(ax, az) || 1;
      if ((fx * ax + fz * az) / al < -0.5) dmg *= w.backstab;
    }
    const { hpDmg, armorDmg } = armorAbsorb(dmg, phit.part, victim.armor, victim.helmet, w.armorRatio);
    victim.armor = Math.max(0, victim.armor - armorDmg);
    victim.hp -= hpDmg;
    if (victim.bot) victim.bot.onHurt(attacker, now());
    if (victim.bot) tag(victim.bot.state, tagModifier(attacker.weapon, phit.part, victim.crouching));
    else if (victim.move) tag(victim.move, tagModifier(attacker.weapon, phit.part, victim.crouching));

    this.broadcast({
      t: 'hit', victim: victim.id, attacker: attacker.id,
      part: phit.part, dmg: hpDmg, hp: Math.max(0, victim.hp), armor: victim.armor, helmet: !!victim.helmet,
      weapon: attacker.weapon, point: phit.point, pen, team: team || undefined,
      from: [attacker.pos[0], attacker.pos[1], attacker.pos[2]],
    });

    if (victim.hp <= 0) this.kill(victim, attacker, attacker.weapon, phit.part === 'head', pen);
  }

  kill(victim, attacker, weapon, headshot, wallbang = false) {
    victim.alive = false;
    victim.reloadUntil = 0; victim.shellAt = 0;
    // the dead drop their best gun (primary, else pistol) where they fall
    if (this.competitive) this.dropWeapon(victim, victim.inv.primary || victim.inv.secondary, false);
    victim.deaths++;
    this.planting.delete(victim.id);
    this.defusing.delete(victim.id);
    if (victim.c4) this.dropBomb(victim);
    if (attacker && attacker !== victim) {
      attacker.kills++;
      if (attacker.bot && Math.random() < 0.3) setTimeout(() => this.radio(attacker, 'c', 8), 400);   // Enemy down
      const reward = WEAPONS[weapon] && WEAPONS[weapon].melee ? ECONOMY.knifeKillReward : ECONOMY.killReward;
      if (victim.team !== attacker.team) this.addMoney(attacker, reward, 'kill');
      else if (this.competitive) {
        // team kill: -$3300 and the frag back off (CS)
        attacker.kills -= 2;
        this.addMoney(attacker, ECONOMY.teamKill, 'killed a teammate');
        this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: `${attacker.name} killed a teammate` });
      }
    }
    const by = attacker ? attacker.id : victim.id;
    if (this.competitive && attacker && attacker !== victim && attacker.team !== victim.team) stats.kill(attacker, victim, headshot);
    else if (this.competitive && !attacker) stats.kill(null, victim, false);
    this.broadcast({ t: 'kill', attacker: by, victim: victim.id, weapon, headshot, wallbang });
    this.broadcast({ t: 'die', id: victim.id, by, weapon });
    if (!this.competitive || this.phase === 'dm') {
      this.resetLoadout(victim);
      this.respawn(victim, false);
    }
    if (this.phase === 'dm' && attacker && attacker !== victim && attacker.team !== victim.team) {
      this.score[attacker.team]++;
      this.broadcast({ t: 'round', ...this.roundInfo() });
      if (this.score[attacker.team] >= this.rules.fraglimit) this.phaseEndsAt = now();   // frag limit: over
    }
    // VIP down: the terrorists win the round
    if (victim.vip && this.vipMode && ['round', 'planted'].includes(this.phase)) {
      if (attacker && attacker.team === TEAM.T) this.addMoney(attacker, ECONOMY.vipKillReward, 'killed the VIP');
      this.endRound(TEAM.T, 'vip');
      return;
    }
    this.checkWinCondition();
  }

  handleReload(p) {
    const w = WEAPONS[p.weapon];
    const a = p.ammo[p.weapon];
    if (!p.alive || w.melee || w.bomb || !a || p.reloadUntil || p.shellAt) return;
    if (a.mag >= w.mag || a.reserve <= 0) return;
    if (w.shell) {
      // shotguns load shell by shell and can fire in between (CS)
      p.shellAt = now() + w.shell.start;
      this.send(p, { t: 'reload', weapon: p.weapon, time: w.shell.start + w.shell.each * Math.min(w.mag - a.mag, a.reserve), shell: true });
      return;
    }
    p.reloadUntil = now() + w.reload;
    p.burst = 0;
    this.send(p, { t: 'reload', weapon: p.weapon, time: w.reload });
  }

  insertShell(p, t) {
    const w = WEAPONS[p.weapon], a = p.ammo[p.weapon];
    if (!p.alive || !w.shell || !a) { p.shellAt = 0; return; }
    if (a.mag < w.mag && a.reserve > 0) { a.mag++; a.reserve--; this.sendAmmo(p); }
    p.shellAt = a.mag < w.mag && a.reserve > 0 ? t + w.shell.each : 0;
  }

  // Right click: silencer on / off (M4A1, USP), burst mode (Glock, FAMAS).
  // Zoom is the client's business; the knife's stab rides on the fire message.
  handleAlt(p) {
    const w = WEAPONS[p.weapon];
    if (!p.alive || !w || !w.alt || w.alt === 'stab') return;
    const t = now();
    if (w.alt === 'silencer') {
      if (t < p.nextFire || p.reloadUntil) return;
      p.modes[p.weapon] = p.modes[p.weapon] === 'silenced' ? null : 'silenced';
      p.nextFire = t + w.silencerTime;           // screwing it on / off takes a while
    } else if (w.alt === 'burst') {
      p.modes[p.weapon] = p.modes[p.weapon] === 'burst' ? null : 'burst';
    }
    p.burstIdx = 0;
    this.send(p, { t: 'mode', weapon: p.weapon, mode: p.modes[p.weapon] || null });
    this.broadcast({ t: 'pmode', id: p.id, weapon: p.weapon, mode: p.modes[p.weapon] || null }, p.id);
  }

  // ------------------------------------------------------------- dropped weapons

  // Put a gun on the ground in front of the player (G, buying over it, death).
  dropWeapon(p, id, toss = true) {
    const w = WEAPONS[id];
    if (!w || (w.slot !== 'primary' && w.slot !== 'secondary') || p.inv[w.slot] !== id) return null;
    const a = p.ammo[id] || { mag: 0, reserve: 0 };
    p.inv[w.slot] = null;
    delete p.ammo[id];
    const mode = p.modes[id] || null;
    delete p.modes[id];
    const fin = this.finOf(p, id);           // the finish goes with the gun
    delete p.fin[id];
    if (p.weapon === id) {
      p.weapon = p.inv.primary || p.inv.secondary || 'knife';
      p.reloadUntil = 0; p.shellAt = 0;
      resetRecoil(p.recoil, p.weapon);
      p.nextFire = now() + (WEAPONS[p.weapon].deploy || DRAW_TIME);
    }
    const out = toss ? 64 : 0;
    const pos = [p.pos[0] - Math.sin(p.yaw) * out, p.pos[1], p.pos[2] - Math.cos(p.yaw) * out];
    // not through a wall: stop short of it
    const eye = [p.pos[0], p.pos[1] + 40, p.pos[2]];
    const fwd = [pos[0] - p.pos[0], 0, pos[2] - p.pos[2]];
    const fl = Math.hypot(fwd[0], fwd[2]);
    if (fl > 0) {
      const wall = raycast(eye, [fwd[0] / fl, 0, fwd[2] / fl], this.colliders, fl);
      if (wall) { const k = Math.max(0, wall.t - 20) / fl; pos[0] = p.pos[0] + fwd[0] * k; pos[2] = p.pos[2] + fwd[2] * k; }
    }
    const hit = raycast([pos[0], pos[1] + 40, pos[2]], [0, -1, 0], this.colliders, 4000);
    if (hit) pos[1] = hit.point[1];
    this.dropSeq = (this.dropSeq || 0) + 1;
    const d = { id: this.dropSeq, weapon: id, pos, yaw: p.yaw + (Math.random() - 0.5), ammo: { mag: a.mag, reserve: a.reserve }, mode, fin, by: p.id, at: now() };
    this.drops.push(d);
    if (this.drops.length > 40) this.drops.shift();
    this.sendInv(p);
    return d;
  }

  // Walking over a gun picks it up if that slot is free (CS 1.6); your own
  // drop only after a moment, so G does not just hand it back.
  checkPickup(p, t) {
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      const w = WEAPONS[d.weapon];
      if (p.inv[w.slot]) continue;
      if (d.by === p.id && t - d.at < 1.2) continue;
      if (Math.hypot(d.pos[0] - p.pos[0], d.pos[2] - p.pos[2]) > 36 || Math.abs(d.pos[1] - p.pos[1]) > 48) continue;
      p.inv[w.slot] = d.weapon;
      p.fin[d.weapon] = d.fin || 0;
      p.ammo[d.weapon] = { mag: d.ammo.mag, reserve: d.ammo.reserve };
      if (d.mode) p.modes[d.weapon] = d.mode;
      this.drops.splice(i, 1);
      this.send(p, { t: 'pickup', weapon: d.weapon });
      this.sendInv(p);
      return;
    }
  }

  finishReload(p) {
    p.reloadUntil = 0;
    const w = WEAPONS[p.weapon];
    const a = p.ammo[p.weapon];
    if (!a || w.melee || w.bomb) return;
    const take = Math.min(w.mag - a.mag, a.reserve);
    a.mag += take;
    a.reserve -= take;
    this.sendAmmo(p);
  }

  // ------------------------------------------------------------- economy

  canBuy(p) {
    if (!p.alive) return 'you are dead';
    if (p.vip && this.vipMode) return 'the VIP cannot buy';
    if (this.phase === 'warmup' || this.phase === 'dm') return null;
    if (this.fy) return 'no buying on fy_ maps: grab a gun off the floor';
    if (this.match.knife) return 'knife round: knives only';
    if (this.phase === 'end' || this.phase === 'matchend') return 'the round is over';
    if (now() > this.buyEndsAt) return 'buy time is over';
    if (!inBuyZone(this.map, p.team, p.pos)) return 'you are not in a buy zone';
    return null;
  }

  handleBuy(p, item, quiet = false) {
    const info = itemInfo(item);
    const fail = (reason) => { if (!quiet) this.send(p, { t: 'buy_fail', item, reason }); return false; };
    if (!info || WEAPONS[item]?.bomb) return fail('unknown item');
    const blocked = this.canBuy(p);
    if (blocked) return fail(blocked);
    if (info.team && info.team !== p.team) return fail('not available to your team');
    let price = info.price;

    if (info.weapon && WEAPONS[item].grenade) {
      const w = WEAPONS[item];
      if ((p.nades[item] || 0) >= w.max) return fail(`you can't carry any more`);
      if (p.money < price) return fail('not enough money');
      p.nades[item] = (p.nades[item] || 0) + 1;
    } else if (info.weapon) {
      const w = WEAPONS[item];
      if (p.inv[w.slot] === item) return fail('you already have one');
      if (w.slot === 'primary' && p.shield) p.shield = false;          // a rifle replaces the shield
      if (p.money < price) return fail('not enough money');
      const old = p.inv[w.slot];
      if (old) this.dropWeapon(p, old, true);          // CS: the old gun lands on the floor
      p.inv[w.slot] = item;
      delete p.modes[item];
      delete p.fin[item];                          // a new gun wears the buyer's pick
      p.ammo[item] = { mag: w.mag, reserve: w.reserve };
      p.weapon = item;
      resetRecoil(p.recoil, item);
      p.reloadUntil = 0;
      p.burst = 0;
      p.nextFire = now() + DRAW_TIME;
    } else if (item === 'kevlar') {
      if (p.armor >= 100) return fail('your armour is full');
      if (p.money < price) return fail('not enough money');
      p.armor = 100;
    } else if (item === 'assault') {
      if (p.armor >= 100 && p.helmet) return fail('your armour is full');
      if (p.armor >= 100) price = 350; // CS charges only for the helmet
      if (p.money < price) return fail('not enough money');
      p.armor = 100; p.helmet = true;
    } else if (item === 'kit') {
      if (this.hostageMode) return fail('there is no bomb on this map');
      if (p.kit) return fail('you already have a defuse kit');
      if (p.money < price) return fail('not enough money');
      p.kit = true;
    } else if (item === 'nvg') {
      if (p.nvg) return fail('you already have nightvision');
      if (p.money < price) return fail('not enough money');
      p.nvg = true;
    } else if (item === 'shield') {
      // the tactical shield takes the primary slot (CS: shield + pistol)
      if (p.shield) return fail('you already have a shield');
      if (p.money < price) return fail('not enough money');
      if (p.inv.primary) this.dropWeapon(p, p.inv.primary, true);
      p.shield = true;
      if (!WEAPONS[p.weapon] || WEAPONS[p.weapon].slot !== 'secondary') p.weapon = p.inv.secondary || 'knife';
    } else if (item === 'ammo1' || item === 'ammo2') {
      // one box of the gun's calibre, as CS's buyammo1 / buyammo2
      const gun = p.inv[item === 'ammo1' ? 'primary' : 'secondary'];
      if (!gun) return fail(item === 'ammo1' ? 'you have no primary weapon' : 'you have no pistol');
      const a = p.ammo[gun], full = WEAPONS[gun].reserve;
      if (!a || a.reserve >= full) return fail('your ammo is already full');
      const [boxPrice, rounds] = ammoBox(gun);
      price = boxPrice;
      if (p.money < price) return fail('not enough money');
      a.reserve = Math.min(full, a.reserve + rounds);
    } else if (item === 'ammo') {
      if (p.money < price) return fail('not enough money');
      let changed = false;
      for (const [id, a] of Object.entries(p.ammo)) {
        const full = WEAPONS[id].reserve;
        if (a.reserve < full) { a.reserve = full; changed = true; }
      }
      if (!changed) return fail('your ammo is already full');
    }
    p.money -= price;
    this.sendInv(p, -price, info.name);
    // remembered for F2 rebuy (ammo boxes are topped up by rebuy anyway)
    if (!item.startsWith('ammo')) (p.roundBuys = p.roundBuys || []).push(item);
    return true;
  }

  // Fill an ammo slot completely, box by box (autobuy's primammo / secammo).
  fillAmmo(p, item) { let n = 0; while (n < 12 && this.handleBuy(p, item, true)) n++; return n > 0; }

  // F1: CS autobuy — first affordable primary from the list (only if you have
  // none), full ammo, then kit / armour.
  autobuy(p) {
    const blocked = this.canBuy(p);
    if (blocked) return this.send(p, { t: 'buy_fail', item: 'autobuy', reason: blocked });
    let bought = false;
    for (const id of AUTOBUY) {
      if (id === 'primammo') { bought = this.fillAmmo(p, 'ammo1') || bought; continue; }
      if (id === 'secammo') { bought = this.fillAmmo(p, 'ammo2') || bought; continue; }
      const info = itemInfo(id);
      if (!info) continue;
      if (info.weapon && p.inv.primary) continue;
      if (id === 'kevlar' && p.armor >= 100) continue;
      if (id === 'assault' && p.armor >= 100 && p.helmet) continue;
      if (id === 'kit' && (p.kit || this.hostageMode || p.team !== TEAM.CT)) continue;
      bought = this.handleBuy(p, id, true) || bought;
    }
    if (!bought) this.send(p, { t: 'buy_fail', item: 'autobuy', reason: 'nothing to buy' });
  }

  // F2: CS rebuy — what you bought last round, skipping what you still have
  rebuy(p) {
    const blocked = this.canBuy(p);
    if (blocked) return this.send(p, { t: 'buy_fail', item: 'rebuy', reason: blocked });
    const list = p.lastBuys || [];
    if (!list.length) return this.send(p, { t: 'buy_fail', item: 'rebuy', reason: 'nothing bought last round' });
    const nadeCount = {};
    for (const id of list) {
      const w = WEAPONS[id];
      if (w && w.grenade) {
        nadeCount[id] = (nadeCount[id] || 0) + 1;
        if ((p.nades[id] || 0) >= nadeCount[id]) continue;   // already carrying that many
      } else if (w && p.inv[w.slot] === id) continue;
      else if ((id === 'kevlar' && p.armor >= 100) || (id === 'assault' && p.armor >= 100 && p.helmet) || (id === 'kit' && p.kit)) continue;
      this.handleBuy(p, id, true);
    }
    this.fillAmmo(p, 'ammo1');
    this.fillAmmo(p, 'ammo2');
  }

  addMoney(p, amount, reason) {
    const before = p.money;
    p.money = Math.max(0, Math.min(ECONOMY.maxMoney, p.money + amount));   // CS: never below $0
    if (p.money !== before) this.sendInv(p, p.money - before, reason);
  }

  // ------------------------------------------------------------- net

  inventory(p) {
    const ammo = {};
    for (const [id, a] of Object.entries(p.ammo)) ammo[id] = [a.mag, a.reserve];
    return {
      money: p.money, armor: p.armor, helmet: p.helmet, kit: p.kit, c4: p.c4, hp: p.hp,
      inv: { ...p.inv, c4: p.c4 ? 'c4' : null, grenade: this.currentNade(p) }, nades: { ...p.nades }, nvg: !!p.nvg, shield: !!p.shield,
      weapon: p.weapon, ammo, reloading: !!p.reloadUntil, modes: { ...p.modes },
      fin: Object.fromEntries(['knife', p.inv.primary, p.inv.secondary].filter(Boolean).map((id) => [id, this.finOf(p, id)])),
    };
  }

  // a gun's finish: the one it came with (picked up), else the player's pick
  finOf(p, id) {
    if (p.fin && p.fin[id] !== undefined) return p.fin[id];
    const pref = p.finPref || {};
    return pref[id] !== undefined ? pref[id] : pref['*'] || 0;
  }

  currentNade(p) {
    if (WEAPONS[p.weapon] && WEAPONS[p.weapon].grenade && p.nades[p.weapon] > 0) return p.weapon;
    return ['hegrenade', 'flashbang', 'smokegrenade'].find((k) => p.nades[k] > 0) || null;
  }

  sendInv(p, delta = 0, reason = '') {
    this.send(p, { t: 'inv', ...this.inventory(p), delta, reason });
  }

  sendAmmo(p) {
    const a = p.ammo[p.weapon];
    this.send(p, {
      t: 'ammo', weapon: p.weapon, mag: a ? a.mag : 0, reserve: a ? a.reserve : 0,
      reloading: !!p.reloadUntil,
    });
  }

  // What a player may know about the bomb: everyone sees it planted; only
  // terrorists see who carries it and where it was dropped (as in CS).
  bombInfo(viewer) {
    const b = this.bomb;
    if (b.state === 'planted') {
      const d = [...this.defusing.values()][0];
      return { state: 'planted', pos: b.pos, site: b.site, left: Math.max(0, b.explodeAt - now()), defusing: !!d };
    }
    if (viewer.team !== TEAM.T) return { state: b.state === 'defused' || b.state === 'exploded' ? b.state : 'hidden' };
    if (b.state === 'dropped') return { state: 'dropped', pos: b.pos };
    if (b.state === 'carried') return { state: 'carried', carrier: b.carrier };
    return { state: b.state };
  }

  // PVS-lite (anti-wallhack): a live enemy the viewer cannot see, that is
  // far away and has not fired lately, is sent without a position
  hiddenFrom(viewer, q, t) {
    if (!viewer || !viewer.alive || !this.competitive || q.team === viewer.team || !q.alive || viewer.bot) return false;
    if (Math.hypot(q.pos[0] - viewer.pos[0], q.pos[2] - viewer.pos[2]) < 900) return false;
    if (t - (q.lastFire || 0) < 1.5) return false;
    const eye = [viewer.pos[0], viewer.pos[1] + (viewer.eye || PLAYER.standEye), viewer.pos[2]];
    for (const h of [70, 40, 8]) if (this.nav.visible(eye, [q.pos[0], q.pos[1] + h, q.pos[2]])) return false;
    return true;
  }

  snapshotFor(viewer, full = true) {
    const t = now();
    return {
      t: 'state',
      ts: now(),
      bomb: this.bombInfo(viewer),
      drops: this.drops.map((d) => ({ id: d.id, w: d.weapon, pos: r1(d.pos), yaw: r3(d.yaw), mode: d.mode || undefined, fin: d.fin || undefined })),
      hostages: this.hostageMode ? this.hostages.map((h) => ({ id: h.id, pos: r1(h.pos), yaw: r3(h.yaw), alive: h.alive, rescued: h.rescued, leader: h.leader, moving: !!h.moving })) : undefined,
      // false flags are left out; score / deaths / ping only in every 15th
      // snapshot (the client keeps the last values) — bandwidth
      players: [...this.players.values()].map((p) => (p.dc || this.hiddenFrom(viewer, p, t) ? { id: p.id, team: p.team, alive: !p.dc, hid: 1, dc: p.dc ? 1 : undefined,
        ...(full ? { k: p.kills, d: p.deaths, ping: p.bot ? undefined : (p.ping || 0), bot: p.bot ? 1 : undefined, afk: this.frozen(p, t) || this.unresponsive(p, t) ? 1 : undefined } : {}) } : {
        id: p.id, team: p.team, pos: r1(p.pos), yaw: r3(p.yaw), pitch: r3(p.pitch), skin: p.skin || undefined,
        alive: p.alive, crouching: p.crouching || undefined, moving: p.moving || undefined, shield: p.shield ? 1 : undefined,
        weapon: p.weapon, mode: p.modes[p.weapon] || undefined, fin: this.finOf(p, p.weapon) || undefined, reloading: (!!p.reloadUntil || !!p.shellAt) || undefined,
        ...(full ? { k: p.kills, d: p.deaths, ping: p.bot ? undefined : (p.ping || 0), bot: p.bot ? 1 : undefined, afk: this.frozen(p, t) || this.unresponsive(p, t) ? 1 : undefined } : {}),
        c4: viewer.team === TEAM.T && p.c4 ? 1 : undefined, vip: this.vipMode && p.vip ? 1 : undefined,
        planting: this.planting.has(p.id) || undefined, defusing: this.defusing.has(p.id) || undefined,
      })),
    };
  }

  // snapshots differ per team only in the bomb field; build two and reuse
  broadcastSnapshots() {
    // latency: a ping every 2 s, the client echoes it (scoreboard / net_graph)
    const t = now();
    if (t - (this._pingAt || 0) > 2) {
      this._pingAt = t;
      for (const p of this.players.values()) if (p.ws) this.send(p, { t: 'ping', ts: t });
    }
    const byTeam = {};
    this._snapN = (this._snapN || 0) + 1;
    const full = this._snapN % 15 === 1;
    for (const p of this.players.values()) {
      if (!p.ws || p.ws.readyState !== 1) continue;
      // a client whose connection is backed up: skip (every snapshot is
      // absolute, so the next one that fits brings it fully up to date)
      // instead of queueing seconds of stale state in front of it
      if (p.ws.bufferedAmount > 48 * 1024) { p.choked = (p.choked || 0) + 1; continue; }
      // per viewer while PVS culling can differ, else shared per team
      const key = this.competitive && p.alive ? 'p' + p.id : 't' + p.team;
      if (!byTeam[key]) byTeam[key] = JSON.stringify(this.snapshotFor(p, full));
      p.ws.send(byTeam[key]);
      if (p.usesCmds && p.move) this.send(p, this.youMsg(p));
    }
  }

  publicPlayer(p) {
    return {
      id: p.id, name: p.name, team: p.team, pos: p.pos, yaw: p.yaw, skin: p.skin,
      hp: p.hp, alive: p.alive, weapon: p.weapon, bot: !!p.bot,
      kills: p.kills, deaths: p.deaths,
    };
  }

  send(p, obj) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj));
  }

  broadcast(obj, exceptId = null) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (exceptId !== null && p.id === exceptId) continue;
      if (p.ws && p.ws.readyState === 1) p.ws.send(s);
    }
  }

  broadcastTeam(team, obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) if (p.team === team && p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
}

installMatch(Game);
