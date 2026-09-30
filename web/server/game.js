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
  PLAYER, WEAPONS, TEAM, ROUND, BOMB, HOSTAGE, DEFAULT_PISTOL, DRAW_TIME, MELEE_REACH,
} from '../shared/constants.js';
import {
  ECONOMY, itemInfo, lossBonus, inBuyZone, buyZoneCenter, ammoBox, AUTOBUY,
} from '../shared/economy.js';
import { newRecoil, resetRecoil, shotSpread, spreadDir, baseDamage, armorAbsorb, tagModifier } from '../shared/ballistics.js';
import {
  buildColliders, playerBox, aabbOverlap, hitBox, raycast, raycastPlayers, norm, len, sub, movePlayer, tag,
} from '../shared/physics.js';
import { navFor } from './nav.js';
import { radioText } from '../shared/radio.js';
import { MOVE } from '../shared/constants.js';
import { NADES, throwVelocity, newNade, stepNade, flashAmount } from '../shared/grenades.js';
import { BotBrain, BOT_NAMES } from './bot.js';

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

export class Game {
  constructor(mapId = 'de_aq_dust', { practice = false, id = 'public', fillTo = 0, botDifficulty = 'normal' } = {}) {
    this.id = id;
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
    this.phase = 'warmup';
    this.phaseEndsAt = 0;
    this.buyEndsAt = 0;
    this.score = { [TEAM.T]: 0, [TEAM.CT]: 0 };
    this.lossStreak = { [TEAM.T]: 0, [TEAM.CT]: 0 };
    this.roundNumber = 0;
    this.halftimeRound = ROUND.halftimeAfter;
    this.matchOver = false;
    this.bomb = { state: 'none', pos: null, carrier: null, plantedAt: 0, explodeAt: 0 };
    this.plantedThisRound = false;
    this.lastTick = now();
  }

  loadMap(mapId) {
    this.map = getMap(mapId);
    this.colliders = buildColliders(this.map);
    this.nav = navFor(this.map, this.colliders);
    this._spawnYaw = {};
    this._spawnSpots = {};
    this.resetHostages();
  }

  get competitive() { return this.phase !== 'warmup'; }
  get hostageMode() { return (this.map.hostages || []).length > 0; }

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
    if (bothTeams && !this.competitive) this.startMatch();
    else if (!bothTeams && this.competitive) this.enterWarmup();
  }

  enterWarmup() {
    this.matchOver = false;
    this.clearBomb();
    this.setPhase('warmup', 0);
    for (const p of this.players.values()) {
      p.money = ECONOMY.warmupMoney;
      if (!p.alive) this.respawn(p, true);
      else this.sendInv(p);
    }
  }

  startMatch() {
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
    this.broadcast({ t: 'match_start', map: this.map.id });
    this.startRound();
  }

  startRound() {
    // halftime: swap sides, keep each group's score, reset the economy
    if (this.roundNumber === this.halftimeRound) {
      for (const p of this.players.values()) {
        p.team = other(p.team);
        p.money = ECONOMY.startMoney;
        p.alive = false;
        this.resetLoadout(p);
        this.send(p, { t: 'team', team: p.team });
      }
      this.score = { [TEAM.T]: this.score[TEAM.CT], [TEAM.CT]: this.score[TEAM.T] };
      this.lossStreak = { [TEAM.T]: 0, [TEAM.CT]: 0 };
      this.broadcast({ t: 'halftime', scoreT: this.score[TEAM.T], scoreCT: this.score[TEAM.CT] });
    }
    this.roundNumber++;
    this.plantedThisRound = false;
    this.nades = []; this.smokes = [];
    this.planting.clear(); this.defusing.clear();
    this.buyEndsAt = now() + ROUND.freezeTime + ECONOMY.buyTimeIntoRound;
    this.setPhase('freeze', ROUND.freezeTime);
    // what each player bought last round becomes their F2 rebuy
    for (const p of this.players.values()) {
      if (p.roundBuys && p.roundBuys.length) p.lastBuys = p.roundBuys;
      p.roundBuys = [];
    }
    // Survivors keep their weapons and armour; the dead start over.
    for (const p of this.players.values()) {
      if (!p.alive) this.resetLoadout(p);
      this.respawn(p, true);
    }
    this.resetHostages();
    if (!this.hostageMode) this.giveBomb();
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
      round: this.roundNumber, maxRounds: ROUND.maxRounds, halftime: this.halftimeRound,
      map: this.map.id, practice: this.practice, mode: this.hostageMode ? 'hostage' : 'bomb',
      rescueZones: this.hostageMode ? this.rescueZones() : undefined,
    };
  }

  // Called on the server tick.
  update() {
    const t = now();
    const dt = Math.min(0.1, t - this.lastTick);
    this.lastTick = t;
    for (const p of this.players.values()) {
      if (p.reloadUntil && t >= p.reloadUntil) this.finishReload(p);
    }
    for (const p of this.players.values()) if (p.bot) p.bot.think(dt, t);
    this.updateBomb(t);
    this.updateNades(dt, t);
    this.updateHostages(dt, t);
    if (this.phase === 'warmup' || t < this.phaseEndsAt) return;
    if (this.phase === 'freeze') this.setPhase('round', ROUND.roundTime);
    // time: the bomb was never planted (CT win) / hostages not rescued (T win)
    else if (this.phase === 'round') this.endRound(this.hostageMode ? TEAM.T : TEAM.CT, 'time');
    else if (this.phase === 'planted') this.explode();
    else if (this.phase === 'end') {
      if (this.matchOver) this.startVote();
      else this.startRound();
    } else if (this.phase === 'matchend') this.finishVote();
  }

  endRound(winner, how) {
    if (!['round', 'freeze', 'planted'].includes(this.phase)) return;
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
    const lossPay = lossBonus(this.lossStreak[loser]);
    for (const p of this.players.values()) {
      if (p.team === winner) this.addMoney(p, winBonus, 'round win');
      else {
        let pay = lossPay;
        if (loser === TEAM.T && this.plantedThisRound) pay += ECONOMY.plantBonus;
        this.addMoney(p, pay, 'round loss');
      }
    }
    const lastRound = this.roundNumber >= ROUND.maxRounds;
    this.matchOver = this.score[winner] >= ROUND.roundsToWin || lastRound;
    this.broadcast({
      t: 'round_end', winner, how,
      scoreT: this.score[TEAM.T], scoreCT: this.score[TEAM.CT],
      matchOver: this.matchOver, halftime: this.roundNumber === this.halftimeRound,
    });
    this.setPhase('end', ROUND.roundEndTime);
  }

  checkWinCondition() {
    if (!['round', 'freeze', 'planted'].includes(this.phase)) return;
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

  changeMap(mapId) {
    if (mapId !== this.map.id) this.loadMap(mapId);
    this.broadcast({ t: 'map', mapId: this.map.id });
    this.phase = 'warmup';
    for (const p of this.players.values()) { p.alive = false; if (p.bot) p.bot.reset(); }
    const both = this.teamSize(TEAM.T) > 0 && this.teamSize(TEAM.CT) > 0;
    if (both) this.startMatch();
    else this.enterWarmup();
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
    this.bomb = { state: 'planted', pos, carrier: null, plantedAt: now(), explodeAt: now() + ROUND.bombTime, site: this.inSite(pos) };
    this.plantedThisRound = true;
    this.addMoney(p, ECONOMY.planterReward, 'bomb planted');
    this.sendInv(p);
    this.phase = 'planted';
    this.phaseEndsAt = this.bomb.explodeAt;
    this.broadcast({ t: 'bomb_event', kind: 'planted', by: p.id, pos, site: this.bomb.site, time: ROUND.bombTime });
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

    this.send(p, {
      t: 'welcome',
      id,
      mapId: this.map.id,
      you: this.publicPlayer(p),
      players: [...this.players.values()].map((q) => this.publicPlayer(q)),
      round: this.roundInfo(),
      bomb: this.bombInfo(p),
      smokes: this.smokes.map((s2) => ({ pos: s2.pos, left: s2.until - now() })),
    });
    this.sendInv(p);
    this.broadcast({ t: 'spawn', player: this.publicPlayer(p) }, id);
    this.balanceBots();
    this.checkMode();
    return p;
  }

  humanCount(team) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team && !p.bot) n++;
    return n;
  }

  // Public rooms: keep each team at `fillTo` players with bots. A joining
  // human takes a bot's place; an empty room has no bots.
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
      nextFire: 0, lastFire: 0, burst: 0, reloadUntil: 0, recoil: newRecoil(), speed: 0,
      kills: 0, deaths: 0,
    };
    this.resetLoadout(p);
    return p;
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
    p.ammo = {
      [pistol]: { mag: WEAPONS[pistol].mag, reserve: WEAPONS[pistol].reserve },
      knife: { mag: 1, reserve: 0 },
    };
    p.weapon = pistol;
    p.armor = 0; p.helmet = false; p.kit = false;
    p.nades = {};
    p.reloadUntil = 0; p.burst = 0;
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
    const spots = this.spawnSpots(p.team);
    const taken = new Set([...this.players.values()].filter((q) => q !== p && q.alive && q.team === p.team).map((q) => q.spawnIdx));
    let idx = spots.findIndex((_, i) => !taken.has(i));
    if (idx < 0) idx = Math.floor(Math.random() * spots.length);
    p.spawnIdx = idx;
    const spot = spots[idx];
    p.pos = [spot[0], spot[1], spot[2]];
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
    switch (msg.t) {
      case 'state':
        if (!p.alive) break;
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
      case 'dev_tp':
        if (process.env.BAQ_DEV === '1' && p.alive && this.phase !== 'freeze' && Array.isArray(msg.pos)) { p.pos = msg.pos.map(Number); p.moveT = now(); }
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
        if (msg.on && this.hostageMode) { this.useHostage(p); break; }
        this.setDefusing(p, !!msg.on);
        break;
      case 'fall': {
        // client-reported landing speed (movement is client-predicted); CS
        // 1.6: damage above 580 u/s, fatal at 1024
        const v = Number(msg.speed);
        if (!p.alive || !Number.isFinite(v) || v <= MOVE.fallSafe) break;
        const dmg = Math.min(200, Math.round((v - MOVE.fallSafe) * (100 / (MOVE.fallFatal - MOVE.fallSafe))));
        p.hp -= dmg;
        this.broadcast({ t: 'hit', victim: p.id, attacker: p.id, part: 'legs', dmg, hp: Math.max(0, p.hp), armor: p.armor, weapon: 'fall', point: p.pos, from: p.pos });
        if (p.hp <= 0) this.kill(p, null, 'fall', false);
        break;
      }
      case 'radio':
        this.radio(p, String(msg.menu || ''), Number(msg.i));
        break;
      case 'throw':
        this.throwNade(p, msg);
        break;
      case 'drop':
        if (p.alive && p.c4 && this.phase !== 'freeze') { p.dropCooldown = now() + 1.5; this.dropBomb(p, true); }
        break;
      case 'vote':
        if (this.phase === 'matchend' && MAP_LIST.some((m) => m.id === msg.map)) {
          this.votes.set(p.id, msg.map);
          this.broadcast({ t: 'votes', tally: this.tally() });
        }
        break;
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 140);
        if (text) this.broadcast({ t: 'chat', id: p.id, name: p.name, team: p.team, text });
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
        // no friendly fire, but you can hurt yourself
        if (owner && q !== owner && q.team === n.team && this.competitive) continue;
        const raw = spec.damage * (1 - d / spec.radius);
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
    p.burst = 0;
    p.nextFire = now() + DRAW_TIME;
    this.planting.delete(p.id);
    this.sendAmmo(p);
  }

  handleFire(p, msg) {
    if (!p.alive || this.phase === 'freeze' || this.phase === 'matchend') return;
    const w = WEAPONS[p.weapon];
    if (w.bomb || w.grenade) return; // C4: see 'plant'; grenades: see 'throw'
    const t = now();
    const ammo = p.ammo[p.weapon];
    // Tolerance: packets bunch up in transit, so allow a slightly early shot.
    const early = Math.min(0.05, w.rof * 0.4);
    if (p.reloadUntil || t < p.nextFire - early || (!w.melee && (!ammo || ammo.mag <= 0))) {
      this.sendAmmo(p); // resync the client's prediction
      return;
    }

    p.lastFire = t;
    p.nextFire = t + w.rof;
    if (!w.melee) ammo.mag--;

    // CS 1.6 spread: from the shooter's stance and accuracy (shots in the
    // burst for automatics, time between shots for pistols). The client's
    // direction already includes its view punch, i.e. the spray pattern.
    const spread = shotSpread(p.recoil, p.weapon, {
      now: t, onGround: this.isGrounded(p), speed: p.moving ? (p.speed || 200) : 0,
      ducking: p.crouching, zoomed: !!msg.zoomed,
    });
    const dir = norm(Array.isArray(msg.dir) && msg.dir.every(Number.isFinite) ? msg.dir : [0, 0, -1]);
    const shotDir = spreadDir(dir, spread);
    // trust the client's eye origin only if it is where we think the player is
    const eye = [p.pos[0], p.pos[1] + eyeOf(p), p.pos[2]];
    let origin = Array.isArray(msg.origin) && msg.origin.every(Number.isFinite) ? msg.origin : eye;
    if (len(sub(origin, eye)) > 96) origin = eye;

    // tracer / effects for everyone else (even if it hits nothing)
    this.broadcast({ t: 'shoot', id: p.id, origin, dir: shotDir, weapon: p.weapon }, p.id);
    if (!w.melee) this.noise(p);

    const maxDist = w.melee ? MELEE_REACH : 8192;
    const world = raycast(origin, shotDir, this.colliders, maxDist);
    const others = [...this.players.values()]
      .filter((q) => q.alive && q.id !== p.id)
      .map((q) => ({ id: q.id, box: hitBox(q.pos, q.crouching) }));
    if (this.hostageMode) for (const h of this.hostages) if (h.alive && !h.rescued) others.push({ id: h.id, box: hitBox(h.pos, false) });
    const phit = raycastPlayers(origin, shotDir, others, maxDist, p.id);

    if (phit && (!world || phit.t < world.t)) {
      const h = phit.id >= 1000 && this.hostages && this.hostages.find((x) => x.id === phit.id);
      if (h) this.damageHostage(h, p, Math.round(baseDamage(p.weapon, phit.part, phit.t)));
      else this.applyDamage(p, phit, w);
    }
    if (!w.melee && ammo.mag === 0 && ammo.reserve > 0) this.handleReload(p); // auto-reload
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
  noise(p) {
    const t = now();
    for (const q of this.players.values()) {
      if (q.bot && q.alive && q.team !== p.team && Math.hypot(q.pos[0] - p.pos[0], q.pos[2] - p.pos[2]) < 1800) q.bot.onNoise(p.pos, t);
    }
  }

  isGrounded(p) {
    const probe = playerBox([p.pos[0], p.pos[1] - 2, p.pos[2]], p.crouching);
    return this.colliders.some((c) =>
      probe.min[0] < c.max[0] && probe.max[0] > c.min[0] &&
      probe.min[1] < c.max[1] && probe.max[1] > c.min[1] &&
      probe.min[2] < c.max[2] && probe.max[2] > c.min[2]);
  }

  applyDamage(attacker, phit, w) {
    const victim = this.players.get(phit.id);
    if (!victim || !victim.alive) return;
    if (victim.team === attacker.team && this.competitive) return; // no friendly fire
    let dmg = baseDamage(attacker.weapon, phit.part, phit.t);
    if (w.melee) {
      // backstab: from behind the victim the knife does triple damage
      const fx = -Math.sin(victim.yaw), fz = -Math.cos(victim.yaw);
      const ax = attacker.pos[0] - victim.pos[0], az = attacker.pos[2] - victim.pos[2];
      const al = Math.hypot(ax, az) || 1;
      if ((fx * ax + fz * az) / al < -0.5) dmg *= 3;
    }
    const { hpDmg, armorDmg } = armorAbsorb(dmg, phit.part, victim.armor, victim.helmet, w.armorRatio);
    victim.armor = Math.max(0, victim.armor - armorDmg);
    victim.hp -= hpDmg;
    if (victim.bot) victim.bot.onHurt(attacker, now());
    if (victim.bot) tag(victim.bot.state, tagModifier(attacker.weapon, phit.part, victim.crouching));

    this.broadcast({
      t: 'hit', victim: victim.id, attacker: attacker.id,
      part: phit.part, dmg: hpDmg, hp: Math.max(0, victim.hp), armor: victim.armor, helmet: !!victim.helmet,
      weapon: attacker.weapon, point: phit.point,
      from: [attacker.pos[0], attacker.pos[1], attacker.pos[2]],
    });

    if (victim.hp <= 0) this.kill(victim, attacker, attacker.weapon, phit.part === 'head');
  }

  kill(victim, attacker, weapon, headshot) {
    victim.alive = false;
    victim.reloadUntil = 0;
    victim.deaths++;
    this.planting.delete(victim.id);
    this.defusing.delete(victim.id);
    if (victim.c4) this.dropBomb(victim);
    if (attacker && attacker !== victim) {
      attacker.kills++;
      if (attacker.bot && Math.random() < 0.3) setTimeout(() => this.radio(attacker, 'c', 8), 400);   // Enemy down
      const reward = WEAPONS[weapon] && WEAPONS[weapon].melee ? ECONOMY.knifeKillReward : ECONOMY.killReward;
      if (victim.team !== attacker.team) this.addMoney(attacker, reward, 'kill');
    }
    const by = attacker ? attacker.id : victim.id;
    this.broadcast({ t: 'kill', attacker: by, victim: victim.id, weapon, headshot });
    this.broadcast({ t: 'die', id: victim.id, by, weapon });
    if (!this.competitive) {
      this.resetLoadout(victim);
      this.respawn(victim, false);
    }
    this.checkWinCondition();
  }

  handleReload(p) {
    const w = WEAPONS[p.weapon];
    const a = p.ammo[p.weapon];
    if (!p.alive || w.melee || w.bomb || !a || p.reloadUntil) return;
    if (a.mag >= w.mag || a.reserve <= 0) return;
    p.reloadUntil = now() + w.reload;
    p.burst = 0;
    this.send(p, { t: 'reload', weapon: p.weapon, time: w.reload });
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
    if (this.phase === 'warmup') return null;
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
      if (p.money < price) return fail('not enough money');
      const old = p.inv[w.slot];
      if (old) delete p.ammo[old];
      p.inv[w.slot] = item;
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
      inv: { ...p.inv, c4: p.c4 ? 'c4' : null, grenade: this.currentNade(p) }, nades: { ...p.nades },
      weapon: p.weapon, ammo, reloading: !!p.reloadUntil,
    };
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

  snapshotFor(viewer) {
    return {
      t: 'state',
      ts: now(),
      bomb: this.bombInfo(viewer),
      hostages: this.hostageMode ? this.hostages.map((h) => ({ id: h.id, pos: h.pos, yaw: h.yaw, alive: h.alive, rescued: h.rescued, leader: h.leader, moving: !!h.moving })) : undefined,
      players: [...this.players.values()].map((p) => ({
        id: p.id, team: p.team, pos: p.pos, yaw: p.yaw, pitch: p.pitch,
        alive: p.alive, crouching: p.crouching, moving: p.moving,
        weapon: p.weapon, reloading: !!p.reloadUntil,
        k: p.kills, d: p.deaths,
        planting: this.planting.has(p.id), defusing: this.defusing.has(p.id),
      })),
    };
  }

  // snapshots differ per team only in the bomb field; build two and reuse
  broadcastSnapshots() {
    const byTeam = {};
    for (const p of this.players.values()) {
      if (!p.ws || p.ws.readyState !== 1) continue;
      const key = p.team;
      if (!byTeam[key]) byTeam[key] = JSON.stringify(this.snapshotFor(p));
      p.ws.send(byTeam[key]);
    }
  }

  publicPlayer(p) {
    return {
      id: p.id, name: p.name, team: p.team, pos: p.pos, yaw: p.yaw,
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
