// Authoritative game state for one battle-aq room.
//
// The server owns: player identity, team assignment, HP, ammo, damage, kills,
// the round timer and respawns. Movement is client-predicted (like the Godot
// build): clients send their position and the server relays it. Damage is
// fully server-side — the server raycasts against the map and other players,
// so wallhacks and aimbots that only lie about position do not score hits.
//
// One Game instance == one room == one map == one port.

import { getMap } from '../shared/maps.js';
import {
  PLAYER, WEAPONS, START_WEAPON, TEAM, ROUND,
  CONE_SHOTS_TO_MAX, CONE_RECOVERY_PER_SEC, AIR_CONE_MUL, RUN_CONE_MUL,
} from '../shared/constants.js';
import {
  buildColliders, playerBox, raycast, raycastPlayers, norm, sub, len,
} from '../shared/physics.js';

let nextId = 1;

const now = () => Date.now() / 1000;

export class Game {
  constructor(mapId = 'de_aq_dust') {
    this.map = getMap(mapId);
    this.colliders = buildColliders(this.map);
    this.players = new Map(); // id -> player
    this.phase = 'waiting';
    this.phaseEndsAt = 0;
    this.score = { [TEAM.T]: 0, [TEAM.CT]: 0 };
    this.roundNumber = 0;
    this._nextTeam = TEAM.T;
    this.startRound();
  }

  // ------------------------------------------------------------- lifecycle

  startRound() {
    this.roundNumber++;
    this.setPhase('buy', ROUND.buyTime);
    // respawn everyone, reset HP/ammo
    for (const p of this.players.values()) this.respawn(p, true);
  }

  setPhase(phase, seconds) {
    this.phase = phase;
    this.phaseEndsAt = now() + seconds;
    this.broadcast({
      t: 'round', phase, timer: seconds,
      scoreT: this.score[TEAM.T], scoreCT: this.score[TEAM.CT],
      round: this.roundNumber,
    });
  }

  // Called on the server tick.
  update() {
    if (this.phase !== 'waiting' && now() >= this.phaseEndsAt) {
      if (this.phase === 'buy') this.setPhase('round', ROUND.roundTime);
      else if (this.phase === 'round') this.endRound(TEAM.CT); // CT wins on time
      else if (this.phase === 'end') this.startRound();
    }
  }

  endRound(winner) {
    this.score[winner]++;
    this.broadcast({
      t: 'round_end', winner,
      scoreT: this.score[TEAM.T], scoreCT: this.score[TEAM.CT],
    });
    this.setPhase('end', ROUND.roundEndTime);
  }

  checkWinCondition() {
    const aliveT = this.countAlive(TEAM.T);
    const aliveCT = this.countAlive(TEAM.CT);
    if (this.phase === 'round') {
      if (aliveT === 0 && aliveCT > 0) this.endRound(TEAM.CT);
      else if (aliveCT === 0 && aliveT > 0) this.endRound(TEAM.T);
    }
  }

  countAlive(team) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team && p.alive) n++;
    return n;
  }

  // ------------------------------------------------------------- players

  addPlayer(ws, name) {
    const id = nextId++;
    const team = this._nextTeam;
    this._nextTeam = this._nextTeam === TEAM.T ? TEAM.CT : TEAM.T;
    const p = {
      id, ws, name: (name || `Player ${id}`).slice(0, 24),
      team,
      pos: [0, 0, 0], yaw: 0, pitch: 0, crouching: false, moving: false,
      hp: PLAYER.maxHp, alive: true,
      weapon: START_WEAPON, ammo: WEAPONS[START_WEAPON].mag,
      lastFire: 0, burst: 0, reloadUntil: 0,
      kills: 0, deaths: 0,
    };
    this.players.set(id, p);
    this.respawn(p, true);

    // Tell the new player about the world and everyone in it.
    this.send(p, {
      t: 'welcome',
      id,
      mapId: this.map.id,
      map: this.map,
      you: this.publicPlayer(p),
      players: [...this.players.values()].map((q) => this.publicPlayer(q)),
      round: {
        phase: this.phase, timer: Math.max(0, this.phaseEndsAt - now()),
        scoreT: this.score[TEAM.T], scoreCT: this.score[TEAM.CT], round: this.roundNumber,
      },
    });
    // Tell everyone else.
    this.broadcast({ t: 'spawn', player: this.publicPlayer(p) }, id);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.broadcast({ t: 'despawn', id });
    this.checkWinCondition();
  }

  respawn(p, instant = false) {
    const spots = this.map.spawns[p.team] || this.map.spawns[TEAM.T];
    const spot = spots[Math.floor(Math.random() * spots.length)];
    p.pos = [spot[0], spot[1], spot[2]];
    p.hp = PLAYER.maxHp;
    p.alive = true;
    p.ammo = WEAPONS[p.weapon].mag;
    p.burst = 0;
    p.reloadUntil = 0;
    if (instant) {
      this.send(p, { t: 'respawn', pos: p.pos, hp: p.hp, ammo: p.ammo });
    } else {
      // brief death cam before coming back
      setTimeout(() => {
        if (this.players.has(p.id)) this.send(p, { t: 'respawn', pos: p.pos, hp: p.hp, ammo: p.ammo });
      }, 1200);
    }
  }

  // ------------------------------------------------------------- messages

  onMessage(p, msg) {
    switch (msg.t) {
      case 'state':
        if (!p.alive) break;
        if (Array.isArray(msg.pos) && msg.pos.length === 3) p.pos = msg.pos;
        if (typeof msg.yaw === 'number') p.yaw = msg.yaw;
        if (typeof msg.pitch === 'number') p.pitch = msg.pitch;
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
        if (WEAPONS[msg.id]) {
          p.weapon = msg.id;
          p.ammo = WEAPONS[msg.id].mag;
          p.burst = 0;
          this.send(p, { t: 'weapon', id: msg.id, ammo: p.ammo });
        }
        break;
      case 'chat':
        this.broadcast({ t: 'chat', id: p.id, name: p.name, text: String(msg.text).slice(0, 140) });
        break;
    }
  }

  handleFire(p, msg) {
    if (!p.alive) return;
    const w = WEAPONS[p.weapon];
    const t = now();
    if (t < p.reloadUntil) return;                 // mid-reload
    if (t - p.lastFire < w.rof) return;            // rate limit
    if (p.ammo <= 0) { this.handleReload(p); return; }

    p.lastFire = t;
    p.ammo--;
    p.burst = Math.min(p.burst + 1, CONE_SHOTS_TO_MAX);

    // compute cone with movement multipliers
    let cone = w.cone + (w.maxCone - w.cone) * ((p.burst - 1) / Math.max(1, CONE_SHOTS_TO_MAX - 1));
    const airborne = !this.isGrounded(p);
    if (airborne) cone *= AIR_CONE_MUL;
    else if (p.moving) cone *= RUN_CONE_MUL;
    cone = Math.min(cone, w.maxCone * (airborne ? AIR_CONE_MUL : RUN_CONE_MUL));

    // sample a direction inside the cone around the client's dir
    const dir = norm(Array.isArray(msg.dir) ? msg.dir : [0, 0, -1]);
    const shotDir = this.applyCone(dir, cone);
    const origin = Array.isArray(msg.origin) ? msg.origin : p.pos;

    // tracer for everyone (even if it hits nothing)
    this.broadcast({ t: 'shoot', id: p.id, origin, dir: shotDir, weapon: p.weapon }, p.id);

    const maxDist = w.maxRange * 2;
    const world = raycast(origin, shotDir, this.colliders, maxDist);
    const others = [...this.players.values()]
      .filter((q) => q.alive)
      .map((q) => ({ id: q.id, box: playerBox(q.pos, q.crouching) }));
    const phit = raycastPlayers(origin, shotDir, others, maxDist, p.id);

    if (phit && (!world || phit.t < world.t)) {
      this.applyDamage(p, phit, w, origin);
    }
  }

  applyCone(dir, coneDeg) {
    if (coneDeg <= 0) return dir;
    const rad = (coneDeg * Math.PI) / 180;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * rad;
    const up = Math.abs(dir[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    let right = norm([dir[2] * up[1] - dir[1] * up[2], dir[0] * up[2] - dir[2] * up[0], dir[1] * up[0] - dir[0] * up[1]]);
    const local = [
      (right[0] * Math.cos(theta) + up[0] * Math.sin(theta)) * Math.sin(phi),
      (right[1] * Math.cos(theta) + up[1] * Math.sin(theta)) * Math.sin(phi),
      (right[2] * Math.cos(theta) + up[2] * Math.sin(theta)) * Math.sin(phi),
    ];
    return norm([
      dir[0] * Math.cos(phi) + local[0],
      dir[1] * Math.cos(phi) + local[1],
      dir[2] * Math.cos(phi) + local[2],
    ]);
  }

  isGrounded(p) {
    const probe = playerBox([p.pos[0], p.pos[1] - 2, p.pos[2]], p.crouching);
    return this.colliders.some((c) =>
      probe.min[0] < c.max[0] && probe.max[0] > c.min[0] &&
      probe.min[1] < c.max[1] && probe.max[1] > c.min[1] &&
      probe.min[2] < c.max[2] && probe.max[2] > c.min[2]);
  }

  applyDamage(attacker, phit, w, origin) {
    const victim = this.players.get(phit.id);
    if (!victim || !victim.alive) return;
    const dist = phit.t;
    let base = w.dmgBody;
    if (phit.part === 'head') base = w.dmgHead;
    else if (phit.part === 'legs') base = w.dmgLegs;

    // range falloff: flat to rangeMod, linear to 0 at maxRange
    let dmg = base;
    if (dist > w.rangeMod) {
      const t = Math.min(1, (dist - w.rangeMod) / Math.max(1, w.maxRange - w.rangeMod));
      dmg = base * (1 - t);
    }
    dmg = Math.max(1, Math.round(dmg));

    victim.hp -= dmg;
    this.broadcast({
      t: 'hit', victim: victim.id, attacker: attacker.id,
      part: phit.part, dmg, hp: Math.max(0, victim.hp), weapon: attacker.weapon,
    });

    if (victim.hp <= 0) {
      victim.alive = false;
      victim.deaths++;
      attacker.kills++;
      this.broadcast({ t: 'kill', attacker: attacker.id, victim: victim.id, weapon: attacker.weapon });
      this.broadcast({ t: 'die', id: victim.id, by: attacker.id, weapon: attacker.weapon });
      this.respawn(victim, false);
      this.checkWinCondition();
    }
  }

  handleReload(p) {
    const w = WEAPONS[p.weapon];
    if (p.ammo >= w.mag || !p.alive) return;
    p.reloadUntil = now() + w.reload;
    p.ammo = w.mag; // simple model: ammo refills when the timer elapses (checked on fire)
    this.send(p, { t: 'reload', weapon: p.weapon, time: w.reload });
  }

  // ------------------------------------------------------------- net

  snapshot() {
    return {
      t: 'state',
      ts: now(),
      players: [...this.players.values()].map((p) => ({
        id: p.id, pos: p.pos, yaw: p.yaw, pitch: p.pitch,
        hp: p.hp, alive: p.alive, crouching: p.crouching, moving: p.moving,
        weapon: p.weapon,
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
