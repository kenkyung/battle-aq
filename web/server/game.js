// Authoritative game state for one battle-aq room.
//
// The server owns: player identity, team assignment, HP, armour, money,
// inventory, ammo, reloads, damage, kills, the round timer and respawns.
// Movement is client-predicted (like the Godot build): clients send their
// position and the server relays it. Damage is fully server-side — the server
// raycasts against the map and other players, so wallhacks and aimbots that
// only lie about position do not score hits.
//
// Modes:
//   warmup       one team is empty. Deathmatch respawns, $16000, buy anywhere.
//   competitive  both teams have players. CS rounds: buy -> round -> end; the
//                dead stay dead until the next round; money carries over.
//
// One Game instance == one room == one map == one port.

import { getMap } from '../shared/maps.js';
import {
  PLAYER, WEAPONS, TEAM, ROUND, DEFAULT_PISTOL, DRAW_TIME, MELEE_REACH, NOSCOPE_CONE,
  CONE_SHOTS_TO_MAX, CONE_RECOVERY_PER_SEC, AIR_CONE_MUL, RUN_CONE_MUL,
} from '../shared/constants.js';
import {
  ECONOMY, itemInfo, lossBonus, inBuyZone, applyArmor,
} from '../shared/economy.js';
import {
  buildColliders, playerBox, hitBox, raycast, raycastPlayers, norm, len, sub,
} from '../shared/physics.js';

let nextId = 1;

const now = () => Date.now() / 1000;
const other = (team) => (team === TEAM.T ? TEAM.CT : TEAM.T);

export class Game {
  constructor(mapId = 'de_aq_dust') {
    this.map = getMap(mapId);
    this.colliders = buildColliders(this.map);
    this.players = new Map(); // id -> player
    this.phase = 'warmup';
    this.phaseEndsAt = 0;
    this.buyEndsAt = 0;
    this.score = { [TEAM.T]: 0, [TEAM.CT]: 0 };
    this.lossStreak = { [TEAM.T]: 0, [TEAM.CT]: 0 };
    this.roundNumber = 0;
    this.matchOver = false;
  }

  get competitive() { return this.phase !== 'warmup'; }

  // ------------------------------------------------------------- lifecycle

  // Both teams populated -> start a fresh match; a team emptied -> warmup.
  checkMode() {
    const bothTeams = this.teamSize(TEAM.T) > 0 && this.teamSize(TEAM.CT) > 0;
    if (bothTeams && !this.competitive) this.startMatch();
    else if (!bothTeams && this.competitive) this.enterWarmup();
  }

  enterWarmup() {
    this.matchOver = false;
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
    for (const p of this.players.values()) {
      p.money = ECONOMY.startMoney;
      p.kills = 0; p.deaths = 0;
      this.resetLoadout(p);
      p.alive = false; // everyone respawns fresh for round 1
    }
    this.broadcast({ t: 'match_start' });
    this.startRound();
  }

  startRound() {
    this.roundNumber++;
    this.buyEndsAt = now() + ROUND.buyTime + ECONOMY.buyTimeIntoRound;
    this.setPhase('buy', ROUND.buyTime);
    // Survivors keep their weapons and armour; the dead start over.
    for (const p of this.players.values()) {
      if (!p.alive) this.resetLoadout(p);
      this.respawn(p, true);
    }
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
      round: this.roundNumber,
    };
  }

  // Called on the server tick.
  update() {
    const t = now();
    for (const p of this.players.values()) {
      if (p.reloadUntil && t >= p.reloadUntil) this.finishReload(p);
    }
    if (this.phase === 'warmup' || t < this.phaseEndsAt) return;
    if (this.phase === 'buy') this.setPhase('round', ROUND.roundTime);
    else if (this.phase === 'round') this.endRound(TEAM.CT, 'time'); // CT wins on time
    else if (this.phase === 'end') {
      if (this.matchOver) this.startMatch();
      else this.startRound();
    }
  }

  endRound(winner, how) {
    if (this.phase !== 'round' && this.phase !== 'buy') return;
    const loser = other(winner);
    this.score[winner]++;
    this.lossStreak[winner] = 0;
    this.lossStreak[loser]++;
    const winBonus = (winner === TEAM.CT && how === 'elim') ? ECONOMY.winBonusElimCT : ECONOMY.winBonus;
    const lossPay = lossBonus(this.lossStreak[loser]);
    for (const p of this.players.values()) {
      if (p.team === winner) this.addMoney(p, winBonus, 'round win');
      else this.addMoney(p, lossPay, 'round loss');
    }
    this.matchOver = this.score[winner] >= ROUND.roundsToWin
      || this.roundNumber >= ROUND.maxRounds;
    this.broadcast({
      t: 'round_end', winner, how,
      scoreT: this.score[TEAM.T], scoreCT: this.score[TEAM.CT],
      matchOver: this.matchOver,
    });
    this.setPhase('end', this.matchOver ? ROUND.roundEndTime * 2 : ROUND.roundEndTime);
  }

  checkWinCondition() {
    if (this.phase !== 'round' && this.phase !== 'buy') return;
    const aliveT = this.countAlive(TEAM.T);
    const aliveCT = this.countAlive(TEAM.CT);
    if (aliveT === 0 && aliveCT > 0) this.endRound(TEAM.CT, 'elim');
    else if (aliveCT === 0 && aliveT > 0) this.endRound(TEAM.T, 'elim');
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

  // ------------------------------------------------------------- players

  addPlayer(ws, name) {
    const id = nextId++;
    // auto-balance: join the smaller team (T on a tie)
    const team = this.teamSize(TEAM.T) <= this.teamSize(TEAM.CT) ? TEAM.T : TEAM.CT;
    const p = {
      id, ws, name: (String(name || '').trim() || `Player ${id}`).slice(0, 24),
      team,
      pos: [0, 0, 0], yaw: 0, pitch: 0, crouching: false, moving: false,
      hp: PLAYER.maxHp, armor: 0, helmet: false, alive: false,
      money: this.competitive ? ECONOMY.startMoney : ECONOMY.warmupMoney,
      inv: {}, ammo: {}, weapon: 'knife',
      nextFire: 0, lastFire: 0, burst: 0, reloadUntil: 0,
      kills: 0, deaths: 0,
    };
    this.resetLoadout(p);
    this.players.set(id, p);

    // Mid-round joiners sit out until the next round, like CS.
    const canSpawn = this.phase === 'warmup' || this.phase === 'buy';
    if (canSpawn) this.respawn(p, true, false);
    else p.pos = [...this.map.spawns[p.team][0]];

    // Tell the new player about the world and everyone in it.
    this.send(p, {
      t: 'welcome',
      id,
      mapId: this.map.id,
      you: this.publicPlayer(p),
      players: [...this.players.values()].map((q) => this.publicPlayer(q)),
      round: this.roundInfo(),
    });
    this.sendInv(p);
    // Tell everyone else.
    this.broadcast({ t: 'spawn', player: this.publicPlayer(p) }, id);
    this.checkMode();
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.broadcast({ t: 'despawn', id });
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
    p.armor = 0; p.helmet = false;
    p.reloadUntil = 0; p.burst = 0;
  }

  respawn(p, instant = false, notify = true) {
    const spots = this.map.spawns[p.team] || this.map.spawns[TEAM.T];
    const spot = spots[Math.floor(Math.random() * spots.length)];
    p.pos = [spot[0], spot[1], spot[2]];
    p.yaw = this.spawnYaw(p.team);
    p.hp = PLAYER.maxHp;
    p.burst = 0;
    p.reloadUntil = 0;
    p.nextFire = 0;
    const go = () => {
      if (!this.players.has(p.id)) return;
      p.alive = true;
      if (notify) {
        this.send(p, { t: 'respawn', pos: p.pos, yaw: p.yaw, hp: p.hp });
        this.sendInv(p);
      }
    };
    if (instant) go();
    else setTimeout(go, 1500); // warmup death cam
  }

  // Face the way out of the spawn: of 16 headings, the one with the longest
  // clear line of sight at eye height (ties broken toward the map centre).
  spawnYaw(team) {
    if (!this._spawnYaw) this._spawnYaw = {};
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

  // ------------------------------------------------------------- messages

  onMessage(p, msg) {
    switch (msg.t) {
      case 'state':
        if (!p.alive) break;
        if (Array.isArray(msg.pos) && msg.pos.length === 3 && msg.pos.every(Number.isFinite)) p.pos = msg.pos;
        if (Number.isFinite(msg.yaw)) p.yaw = msg.yaw;
        if (Number.isFinite(msg.pitch)) p.pitch = msg.pitch;
        p.crouching = !!msg.crouching;
        p.moving = !!msg.moving;
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
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 140);
        if (text) this.broadcast({ t: 'chat', id: p.id, name: p.name, team: p.team, text });
        break;
      }
    }
  }

  // ------------------------------------------------------------- weapons

  owns(p, id) {
    return p.inv.primary === id || p.inv.secondary === id || p.inv.melee === id;
  }

  handleSwitch(p, id) {
    if (!p.alive || !WEAPONS[id] || !this.owns(p, id) || p.weapon === id) return;
    p.weapon = id;
    p.reloadUntil = 0;          // switching cancels a reload (CS)
    p.burst = 0;
    p.nextFire = now() + DRAW_TIME;
    this.sendAmmo(p);
  }

  handleFire(p, msg) {
    if (!p.alive) return;
    const w = WEAPONS[p.weapon];
    const t = now();
    const ammo = p.ammo[p.weapon];
    // Tolerance: packets bunch up in transit, so allow a slightly early shot.
    const early = Math.min(0.05, w.rof * 0.4);
    if (p.reloadUntil || t < p.nextFire - early || (!w.melee && (!ammo || ammo.mag <= 0))) {
      this.sendAmmo(p); // resync the client's prediction
      return;
    }

    // cone recovers while not firing, then grows with each shot in the burst
    p.burst = Math.max(0, p.burst - (t - p.lastFire) * CONE_RECOVERY_PER_SEC * CONE_SHOTS_TO_MAX);
    p.lastFire = t;
    p.nextFire = t + w.rof;
    if (!w.melee) ammo.mag--;
    p.burst = Math.min(p.burst + 1, CONE_SHOTS_TO_MAX);

    let cone = w.cone + (w.maxCone - w.cone) * ((Math.ceil(p.burst) - 1) / Math.max(1, CONE_SHOTS_TO_MAX - 1));
    const airborne = !this.isGrounded(p);
    if (airborne) cone *= AIR_CONE_MUL;
    else if (p.moving && !p.crouching) cone *= RUN_CONE_MUL;
    cone = Math.min(cone, w.maxCone * (airborne ? AIR_CONE_MUL : RUN_CONE_MUL));
    if (w.zoomFov && !msg.zoomed) cone = Math.max(cone, NOSCOPE_CONE);

    // sample a direction inside the cone around the client's dir
    const dir = norm(Array.isArray(msg.dir) && msg.dir.every(Number.isFinite) ? msg.dir : [0, 0, -1]);
    const shotDir = this.applyCone(dir, cone);
    // trust the client's eye origin only if it is where we think the player is
    const eye = [p.pos[0], p.pos[1] + (p.crouching ? PLAYER.crouchEye : PLAYER.standEye), p.pos[2]];
    let origin = Array.isArray(msg.origin) && msg.origin.every(Number.isFinite) ? msg.origin : eye;
    if (len(sub(origin, eye)) > 96) origin = eye;

    // tracer / effects for everyone else (even if it hits nothing)
    this.broadcast({ t: 'shoot', id: p.id, origin, dir: shotDir, weapon: p.weapon }, p.id);

    const maxDist = w.melee ? MELEE_REACH : w.maxRange * 2;
    const world = raycast(origin, shotDir, this.colliders, maxDist);
    const others = [...this.players.values()]
      .filter((q) => q.alive && q.id !== p.id)
      .map((q) => ({ id: q.id, box: hitBox(q.pos, q.crouching) }));
    const phit = raycastPlayers(origin, shotDir, others, maxDist, p.id);

    if (phit && (!world || phit.t < world.t)) {
      this.applyDamage(p, phit, w);
    }
    if (!w.melee && ammo.mag === 0 && ammo.reserve > 0) this.handleReload(p); // auto-reload
  }

  applyCone(dir, coneDeg) {
    if (coneDeg <= 0) return dir;
    const rad = (coneDeg * Math.PI) / 180;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * rad;
    const up = Math.abs(dir[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    const right = norm([dir[2] * up[1] - dir[1] * up[2], dir[0] * up[2] - dir[2] * up[0], dir[1] * up[0] - dir[0] * up[1]]);
    const up2 = norm([right[1] * dir[2] - right[2] * dir[1], right[2] * dir[0] - right[0] * dir[2], right[0] * dir[1] - right[1] * dir[0]]);
    const s = Math.sin(phi), c = Math.cos(phi);
    return norm([
      dir[0] * c + (right[0] * Math.cos(theta) + up2[0] * Math.sin(theta)) * s,
      dir[1] * c + (right[1] * Math.cos(theta) + up2[1] * Math.sin(theta)) * s,
      dir[2] * c + (right[2] * Math.cos(theta) + up2[2] * Math.sin(theta)) * s,
    ]);
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
    const dist = phit.t;
    let base = w.dmgBody;
    if (phit.part === 'head') base = w.dmgHead;
    else if (phit.part === 'legs') base = w.dmgLegs;

    // range falloff: flat to rangeMod, linear to 0 at maxRange (not for melee)
    let dmg = base;
    if (!w.melee && dist > w.rangeMod) {
      const f = Math.min(1, (dist - w.rangeMod) / Math.max(1, w.maxRange - w.rangeMod));
      dmg = base * (1 - f);
    }
    dmg = Math.max(1, Math.round(dmg));
    const { hpDmg, armorDmg } = applyArmor(dmg, phit.part, victim.armor, victim.helmet);
    victim.armor = Math.max(0, victim.armor - armorDmg);
    victim.hp -= hpDmg;

    this.broadcast({
      t: 'hit', victim: victim.id, attacker: attacker.id,
      part: phit.part, dmg: hpDmg, hp: Math.max(0, victim.hp), armor: victim.armor,
      weapon: attacker.weapon, point: phit.point,
      from: [attacker.pos[0], attacker.pos[1], attacker.pos[2]],
    });

    if (victim.hp <= 0) {
      victim.alive = false;
      victim.reloadUntil = 0;
      victim.deaths++;
      attacker.kills++;
      const reward = w.melee ? ECONOMY.knifeKillReward : ECONOMY.killReward;
      if (victim.team !== attacker.team) this.addMoney(attacker, reward, 'kill');
      this.broadcast({
        t: 'kill', attacker: attacker.id, victim: victim.id, weapon: attacker.weapon,
        headshot: phit.part === 'head',
      });
      this.broadcast({ t: 'die', id: victim.id, by: attacker.id, weapon: attacker.weapon });
      if (!this.competitive) {
        this.resetLoadout(victim);
        this.respawn(victim, false);
      }
      this.checkWinCondition();
    }
  }

  handleReload(p) {
    const w = WEAPONS[p.weapon];
    const a = p.ammo[p.weapon];
    if (!p.alive || w.melee || !a || p.reloadUntil) return;
    if (a.mag >= w.mag || a.reserve <= 0) return;
    p.reloadUntil = now() + w.reload;
    p.burst = 0;
    this.send(p, { t: 'reload', weapon: p.weapon, time: w.reload });
  }

  finishReload(p) {
    p.reloadUntil = 0;
    const w = WEAPONS[p.weapon];
    const a = p.ammo[p.weapon];
    if (!a || w.melee) return;
    const take = Math.min(w.mag - a.mag, a.reserve);
    a.mag += take;
    a.reserve -= take;
    this.sendAmmo(p);
  }

  // ------------------------------------------------------------- economy

  canBuy(p) {
    if (!p.alive) return 'you are dead';
    if (this.phase === 'warmup') return null;
    if (this.phase === 'end') return 'the round is over';
    if (now() > this.buyEndsAt) return 'buy time is over';
    if (!inBuyZone(this.map, p.team, p.pos)) return 'you are not in a buy zone';
    return null;
  }

  handleBuy(p, item) {
    const info = itemInfo(item);
    const fail = (reason) => this.send(p, { t: 'buy_fail', item, reason });
    if (!info) return fail('unknown item');
    const blocked = this.canBuy(p);
    if (blocked) return fail(blocked);
    if (info.team && info.team !== p.team) return fail('not available to your team');
    let price = info.price;

    if (info.weapon) {
      const w = WEAPONS[item];
      if (p.inv[w.slot] === item) return fail('you already have one');
      if (p.money < price) return fail('not enough money');
      const old = p.inv[w.slot];
      if (old) delete p.ammo[old];
      p.inv[w.slot] = item;
      p.ammo[item] = { mag: w.mag, reserve: w.reserve };
      p.weapon = item;
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
  }

  addMoney(p, amount, reason) {
    const before = p.money;
    p.money = Math.min(ECONOMY.maxMoney, p.money + amount);
    if (p.money !== before) this.sendInv(p, p.money - before, reason);
  }

  // ------------------------------------------------------------- net

  inventory(p) {
    const ammo = {};
    for (const [id, a] of Object.entries(p.ammo)) ammo[id] = [a.mag, a.reserve];
    return {
      money: p.money, armor: p.armor, helmet: p.helmet, hp: p.hp,
      inv: { ...p.inv }, weapon: p.weapon, ammo, reloading: !!p.reloadUntil,
    };
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

  snapshot() {
    return {
      t: 'state',
      ts: now(),
      players: [...this.players.values()].map((p) => ({
        id: p.id, team: p.team, pos: p.pos, yaw: p.yaw, pitch: p.pitch,
        alive: p.alive, crouching: p.crouching, moving: p.moving,
        weapon: p.weapon, reloading: !!p.reloadUntil,
        k: p.kills, d: p.deaths,
      })),
    };
  }

  publicPlayer(p) {
    return {
      id: p.id, name: p.name, team: p.team, pos: p.pos, yaw: p.yaw,
      hp: p.hp, alive: p.alive, weapon: p.weapon,
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
}
