// Server-side bots.
//
// A bot is an ordinary player (same inventory, money, damage, buy rules) whose
// input comes from this brain instead of a socket. It moves with the shared
// physics (movePlayer), fires through Game.handleFire, buys through
// Game.handleBuy and plants/defuses through the same calls a human's messages
// reach — so bots can never do anything a player cannot.
//
// Each tick: perceive (line of sight, field of view, reaction delay, noises,
// being shot) -> pick a goal from the objective (carry / plant / guard / retake
// / defuse) -> follow an A* path there -> fight whatever it can see.

import { movePlayer, norm, playerBox, raycast } from '../shared/physics.js';
import { PLAYER, WEAPONS, TEAM, BOMB } from '../shared/constants.js';
import { ECONOMY, inBuyZone } from '../shared/economy.js';
import { navFor } from './nav.js';
import { kick, decayPunch, aimWithPunch } from '../shared/ballistics.js';
import { smokeBlocks } from '../shared/grenades.js';

export const DIFFICULTY = {
  easy:   { comp: 0.25, reaction: 0.75, aimErr: 3.8, turn: 4.0, fov: 100, burst: [2, 3], strafe: 0.2, hsBias: 0.1, sight: 2600 },
  normal: { comp: 0.6, reaction: 0.42, aimErr: 1.9, turn: 7.5, fov: 120, burst: [3, 5], strafe: 0.55, hsBias: 0.35, sight: 3600 },
  hard:   { comp: 0.85, reaction: 0.22, aimErr: 0.8, turn: 12,  fov: 140, burst: [3, 6], strafe: 0.85, hsBias: 0.6, sight: 4500 },
};

export const BOT_NAMES = [
  'Moose', 'Viper', 'Dusty', 'Ghost', 'Bishop', 'Kilo', 'Rook', 'Sparrow', 'Hex', 'Tango',
  'Mako', 'Reaper', 'Fox', 'Wolf', 'Nomad', 'Echo', 'Jackal', 'Cobra', 'Blitz', 'Rabbit',
];

const TAU = Math.PI * 2;
const wrap = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
const rnd = (a, b) => a + Math.random() * (b - a);

export class BotBrain {
  constructor(game, p, difficulty = 'normal') {
    this.game = game;
    this.p = p;
    this.setDifficulty(difficulty);
    this.reset();
  }

  setDifficulty(d) {
    this.difficulty = DIFFICULTY[d] ? d : 'normal';
    this.skill = DIFFICULTY[this.difficulty];
  }

  // New round / respawn.
  reset() {
    this.state = { pos: this.p.pos, vel: [0, 0, 0], yaw: this.p.yaw, pitch: 0, onGround: true, crouching: false };
    this.path = null; this.pathIdx = 0; this.goal = null; this.goalKey = '';
    this.repathAt = 0;
    this.target = null; this.seenAt = 0; this.lastSeen = null; this.lastSeenAt = -99;
    this.heard = null; this.heardAt = -99;
    this.hurtBy = null; this.hurtAt = -99;
    this.burstLeft = 0; this.burstPauseUntil = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1; this.strafeSwap = 0;
    this.stuckT = 0; this.lastProgressPos = this.p.pos.slice(); this.jump = false;
    this.bought = false;
    this.site = null;       // which bombsite this bot plays this round
    this.guardSpots = {};   // anchor key -> chosen spot (stable for the round)
    this.nextPathAt = 0;    // A* is rate-limited per bot
    this.holdUntil = 0; this.lookYaw = this.p.yaw;
    this.perceiveT = Math.random() * 0.15;
    this.nadePlan = null;   // { kind, at, yaw, pitch }
    this.usedUtility = false;
  }

  // pick a grenade, aim it, throw it once it has been drawn (0.45 s)
  planNade(kind, target, now) {
    if (this.nadePlan || !(this.p.nades[kind] > 0)) return false;
    const d = [target[0] - this.p.pos[0], target[2] - this.p.pos[2]];
    const dist = Math.hypot(d[0], d[1]);
    // pitch that roughly lobs the grenade that far (throw leaves 10° high)
    const pitch = Math.max(-0.1, Math.min(0.75, (dist - 350) / 2600));
    this.nadePlan = { kind, at: now + 0.45, yaw: Math.atan2(-d[0], -d[1]), pitch };
    this.game.handleSwitch(this.p, kind);
    return true;
  }

  runNadePlan(dt, now) {
    const plan = this.nadePlan;
    if (!plan) return false;
    this.turnTo(plan.yaw, plan.pitch, dt, 1.2);
    this.p.yaw = this.state.yaw; this.p.pitch = this.state.pitch;
    if (now >= plan.at) {
      this.game.throwNade(this.p, { vel: this.state.vel });
      this.nadePlan = null;
      this.usedUtility = true;
      const best = this.p.inv.primary || this.p.inv.secondary;
      if (best && this.p.weapon !== best) this.game.handleSwitch(this.p, best);
    }
    return true;
  }

  get nav() { return navFor(this.game.map, this.game.colliders); }

  // ------------------------------------------------------------ perception

  eye(p = this.p) {
    return [p.pos[0], p.pos[1] + (p.crouching ? PLAYER.crouchEye : PLAYER.standEye), p.pos[2]];
  }

  perceive(now) {
    const me = this.eye();
    if (now < this.p.blindUntil) { this.target = null; return; }   // flashed
    let best = null, bestD = Infinity;
    for (const q of this.game.players.values()) {
      if (!q.alive || q.team === this.p.team || q === this.p) continue;
      const chest = [q.pos[0], q.pos[1] + (q.crouching ? 30 : 48), q.pos[2]];
      const d = [chest[0] - me[0], chest[1] - me[1], chest[2] - me[2]];
      const dist = Math.hypot(d[0], d[1], d[2]);
      if (dist > this.skill.sight) continue;
      // inside the field of view, unless it is the one shooting us
      const ang = Math.abs(wrap(Math.atan2(-d[0], -d[2]) - this.state.yaw));
      const inFov = ang < (this.skill.fov * Math.PI / 360);
      const attacker = this.hurtBy === q.id && now - this.hurtAt < 2;
      if (!inFov && !attacker && dist > 180) continue;
      if (!this.nav.visible(me, chest)) continue;
      if (smokeBlocks(me, chest, this.game.smokes, now)) continue;
      if (dist < bestD) { bestD = dist; best = q; }
    }
    if (best) {
      if (!this.target || this.target.id !== best.id) {
        if (!this.target && now - (this.calloutAt || 0) > 8 && Math.random() < 0.5) { this.calloutAt = now; this.game.radio(this.p, 'c', 1); } // Enemy spotted
        this.target = best;
        // reaction time before the first shot (faster up close)
        this.seenAt = now + this.skill.reaction * (bestD < 400 ? 0.6 : 1) * rnd(0.8, 1.25);
      }
      this.lastSeen = best.pos.slice();
      this.lastSeenAt = now;
    } else {
      this.target = null;
    }
  }

  onHurt(attacker, now) {
    if (this.p.hp < 45 && now - (this.calloutAt || 0) > 10 && Math.random() < 0.4) { this.calloutAt = now; this.game.radio(this.p, 'c', 2); } // Need backup
    this.hurtBy = attacker.id; this.hurtAt = now; this.lastSeen = attacker.pos.slice(); this.lastSeenAt = now; }
  onNoise(pos, now) {
    if (now - this.heardAt < 1.5 && this.heard) return;
    this.heard = pos.slice(); this.heardAt = now;
  }

  // ------------------------------------------------------------ buying

  buy() {
    this.bought = true;
    const g = this.game, p = this.p;
    if (!inBuyZone(g.map, p.team, p.pos) && g.phase !== 'warmup') return;
    const money = () => p.money;
    const pistolRound = g.roundNumber === 1 || (g.roundNumber === g.halftimeRound + 1);
    const rifle = p.team === TEAM.T ? 'ak47' : 'm4a1';
    if (!p.inv.primary) {
      if (money() >= WEAPONS.awp.price + 1000 && Math.random() < 0.18) g.handleBuy(p, 'awp');
      else if (money() >= WEAPONS[rifle].price + 650) g.handleBuy(p, rifle);
      else if (money() >= WEAPONS.m249.price + 1000 && Math.random() < 0.06) g.handleBuy(p, 'm249');
      else if (!pistolRound && money() >= WEAPONS.ump45.price + 650 && money() < 2600 && Math.random() < 0.6) g.handleBuy(p, Math.random() < 0.5 ? 'mp5' : 'ump45');
      else if (!pistolRound && money() >= WEAPONS.scout.price && money() < WEAPONS[rifle].price && Math.random() < 0.25) g.handleBuy(p, 'scout');
    }
    if (money() >= 1000 && p.armor < 100) g.handleBuy(p, 'assault');
    else if (money() >= 650 && p.armor < 100) g.handleBuy(p, 'kevlar');
    if (p.team === TEAM.CT && !p.kit && money() >= 200) g.handleBuy(p, 'kit');
    if (!p.inv.primary && p.inv.secondary !== 'deagle' && money() >= 650 && Math.random() < 0.6) g.handleBuy(p, 'deagle');
    // utility with what is left
    if (money() >= 300 && Math.random() < 0.6) g.handleBuy(p, 'hegrenade');
    if (money() >= 200 && Math.random() < 0.45) g.handleBuy(p, 'flashbang');
    if (money() >= 300 && Math.random() < 0.3) g.handleBuy(p, 'smokegrenade');
    const best = p.inv.primary || p.inv.secondary;
    if (best) g.handleSwitch(p, best);
  }

  // ------------------------------------------------------------ objectives

  sites() { return Object.entries(this.game.map.bombsites || {}); }

  chooseGoal(now) {
    const g = this.game, p = this.p, bomb = g.bomb;
    // recent contact beats the plan
    if (!this.target && this.lastSeen && now - this.lastSeenAt < 4) return { key: 'hunt', pos: this.lastSeen };
    if (!this.target && this.heard && now - this.heardAt < 3 && g.phase !== 'planted') return { key: 'noise', pos: this.heard };

    if (g.phase === 'warmup') {
      if (!this.goal || this.reached(this.goal.pos, 64)) {
        const n = this.nav.randomNode();
        return { key: 'roam' + n.i, pos: [n.x, n.y, n.z] };
      }
      return this.goal;
    }
    if (!this.site) {
      const s = this.sites();
      this.site = s.length ? s[(p.id + g.roundNumber) % s.length] : null;
    }
    // a planted bomb about to blow: get out of the blast
    if (bomb.state === 'planted') {
      const left = bomb.explodeAt - now;
      const needed = (p.kit ? 5 : 10) + 1.5;
      const near = Math.hypot(p.pos[0] - bomb.pos[0], p.pos[2] - bomb.pos[2]) < BOMB.blastRadius;
      const defusingNow = g.defusing.has(p.id);
      if (near && !defusingNow && (p.team === TEAM.T ? left < 9 : left < needed)) return this.flee(bomb.pos);
    }
    if (p.team === TEAM.T) {
      if (bomb.state === 'dropped') return { key: 'pickup', pos: bomb.pos };
      if (bomb.state === 'planted') return this.guard(bomb.pos, 'guard', 650);
      if (bomb.carrier === p.id && this.site) {
        // head for the chosen site; plant on arrival
        return { key: 'plant-' + this.site[0], pos: this.site[1] };
      }
      // escort: go to the carrier's site, or our own if nobody carries it
      const carrier = g.players.get(bomb.carrier);
      if (carrier && carrier.alive && carrier.bot && carrier.bot.site) return this.guard(carrier.bot.site[1], 'push-' + carrier.bot.site[0], 300);
      if (this.site) return this.guard(this.site[1], 'push-' + this.site[0], 300);
    } else {
      if (bomb.state === 'planted') return { key: 'defuse', pos: bomb.pos };
      if (this.site) return this.guard(this.site[1], 'hold-' + this.site[0], 380);
    }
    return this.goal;
  }

  // a spot near `pos`, stable for a while, so a group spreads out
  guard(pos, key, radius) {
    const k = key + '@' + pos.map(Math.round).join(',');
    if (!this.guardSpots[k]) {
      let n = null;
      for (let i = 0; i < 6 && !(n && n.main); i++) {
        const a = Math.random() * TAU, r = Math.random() * radius;
        n = this.nav.nearest([pos[0] + Math.cos(a) * r, pos[1], pos[2] + Math.sin(a) * r]);
      }
      if (!n || !n.main) n = this.nav.nearest(pos);
      this.guardSpots[k] = { key: k, pos: n ? [n.x, n.y, n.z] : pos };
    }
    return this.guardSpots[k];
  }

  flee(from) {
    if (this.goal && this.goal.key === 'flee') return this.goal;
    let best = null, bestD = 0;
    for (let i = 0; i < 40; i++) {
      const n = this.nav.randomNode();
      const d = Math.hypot(n.x - from[0], n.z - from[2]);
      const mine = Math.hypot(n.x - this.p.pos[0], n.z - this.p.pos[2]);
      if (d > BOMB.blastRadius + 150 && (!best || mine < bestD)) { best = n; bestD = mine; }
    }
    return best ? { key: 'flee', pos: [best.x, best.y, best.z] } : this.goal;
  }

  reached(pos, r = 40) {
    return Math.hypot(this.p.pos[0] - pos[0], this.p.pos[2] - pos[2]) < r && Math.abs(this.p.pos[1] - pos[1]) < 60;
  }

  // ------------------------------------------------------------ tick

  think(dt, now) {
    const g = this.game, p = this.p;
    if (!p.alive) return;
    decayPunch(p.recoil, dt);
    if (g.phase === 'matchend' || g.phase === 'end' && !this.target) { this.move(dt, null, now); return; }
    if (!this.bought && (g.phase === 'freeze' || g.phase === 'warmup' || (g.phase === 'round' && g.canBuy(p) === null))) this.buy();
    if (g.phase === 'freeze') { this.move(dt, null, now); return; }

    this.perceiveT -= dt;
    if (this.perceiveT <= 0) { this.perceiveT = 0.12; this.perceive(now); }

    // weapon housekeeping
    const w = WEAPONS[p.weapon];
    const a = p.ammo[p.weapon];
    if (this.runNadePlan(dt, now)) { this.move(dt, null, now, { face: false }); return; }
    if (WEAPONS[p.weapon].grenade) g.handleSwitch(p, p.inv.primary || p.inv.secondary || 'knife');
    else if (p.weapon === 'c4' || p.weapon === 'knife') {
      if (!(p.weapon === 'c4' && g.planting.has(p.id))) g.handleSwitch(p, p.inv.primary || p.inv.secondary || 'knife');
    } else if (a && a.mag === 0 && a.reserve === 0) {
      const alt = [p.inv.primary, p.inv.secondary, 'knife'].find((id) => id && id !== p.weapon && (id === 'knife' || (p.ammo[id] && p.ammo[id].mag + p.ammo[id].reserve > 0)));
      if (alt) g.handleSwitch(p, alt);
    } else if (a && !this.target && a.mag < w.mag * 0.35 && a.reserve > 0 && !p.reloadUntil) {
      g.handleReload(p);
    }

    // objective actions: plant / defuse / pick up
    const goal = this.chooseGoal(now);
    if (goal && goal.key !== (this.goal && this.goal.key)) { this.goal = goal; this.repathAt = 0; }
    else if (goal) this.goal = goal;
    const bomb = g.bomb;
    if (p.team === TEAM.T && bomb.carrier === p.id && g.phase === 'round' && !this.target && g.inSite(p.pos)) {
      if (p.weapon !== 'c4') g.handleSwitch(p, 'c4');
      g.setPlanting(p, true);
      this.state.vel = [0, 0, 0];
      this.idleLook(dt, now);
      return;
    }
    if (p.team === TEAM.CT && bomb.state === 'planted' && !this.target && g.canDefuse(p)) {
      g.setDefusing(p, true);
      this.state.vel = [0, 0, 0];
      this.state.crouching = true;
      this.idleLook(dt, now);
      return;
    }
    if (g.defusing.get(p.id) && this.target) g.setDefusing(p, false);

    if (!this.target && !this.usedUtility && g.phase === 'round' && this.site && Math.random() < 0.02) {
      const sd = Math.hypot(p.pos[0] - this.site[1][0], p.pos[2] - this.site[1][2]);
      if (sd > 450 && sd < 900 && this.nav.visible(this.eye(), [this.site[1][0], this.site[1][1] + 60, this.site[1][2]])) {
        const kind = p.team === TEAM.T ? (p.nades.flashbang ? 'flashbang' : 'smokegrenade') : 'smokegrenade';
        if (this.planNade(kind, this.site[1], now)) return;
      }
    }
    if (this.target) this.fight(dt, now);
    else this.move(dt, this.goal, now);
  }

  // ------------------------------------------------------------ movement

  followPath(now) {
    if (!this.goal) return null;
    if ((!this.path || now > this.repathAt) && now >= this.nextPathAt) {
      this.nextPathAt = now + 0.8;
      const path = this.nav.path(this.p.pos, this.goal.pos);
      this.repathAt = now + 4 + Math.random() * 2;
      if (path) { this.path = path; this.pathIdx = 0; this.pathGoal = this.goal.key; }
      else if (this.pathGoal !== this.goal.key) this.path = null;
    }
    if (!this.path) return null;
    while (this.pathIdx < this.path.length && this.reached(this.path[this.pathIdx], 28)) this.pathIdx++;
    if (this.pathIdx >= this.path.length) return null;
    return this.path[this.pathIdx];
  }

  move(dt, goal, now, { face = true, strafe = 0, crouch = false, still = false } = {}) {
    const p = this.p;
    let wish = [0, 0, 0];
    const wp = goal && !still && this.game.phase !== 'freeze' ? this.followPath(now) : null;
    if (wp) {
      const d = [wp[0] - p.pos[0], 0, wp[2] - p.pos[2]];
      const L = Math.hypot(d[0], d[2]) || 1;
      wish = [d[0] / L, 0, d[2] / L];
      if (face) this.turnTo(Math.atan2(-wish[0], -wish[2]), 0, dt, 0.7);
    } else if (face) {
      this.idleLook(dt, now);
    }
    // unsticking: sidestep away from whatever is in the way
    if (this.unstickUntil && now < this.unstickUntil) strafe = this.unstickDir;
    // strafe (perpendicular to the view) while fighting
    if (strafe) {
      const y = this.state.yaw;
      wish = [wish[0] * 0.3 + Math.cos(y) * strafe, 0, wish[2] * 0.3 - Math.sin(y) * strafe];
    }
    // convert the world direction into keys relative to where we look
    const y = this.state.yaw;
    const f = -Math.sin(y) * wish[0] - Math.cos(y) * wish[2];
    const r = Math.cos(y) * wish[0] - Math.sin(y) * wish[2];
    const keys = {
      f: f > 0.38, b: f < -0.38, r: r > 0.38, l: r < -0.38,
      jump: this.jump, crouch, walk: false, maxSpeed: WEAPONS[p.weapon].speed,
    };
    this.jump = false;
    this.state.pos = p.pos;
    this.state.crouching = crouch;
    // other players are solid for bots too
    const bodies = [];
    for (const q of this.game.players.values()) {
      // enemies are solid; teammates are not (bots would otherwise queue in
      // every doorway out of spawn)
      if (q !== p && q.alive && q.team !== p.team && Math.abs(q.pos[0] - p.pos[0]) < 200 && Math.abs(q.pos[2] - p.pos[2]) < 200) bodies.push(playerBox(q.pos, q.crouching));
    }
    movePlayer(this.state, keys, dt, bodies.length ? this.game.colliders.concat(bodies) : this.game.colliders);
    p.pos = this.state.pos;
    p.crouching = this.state.crouching;
    p.moving = Math.hypot(this.state.vel[0], this.state.vel[2]) > 12;
    p.yaw = this.state.yaw;
    p.pitch = this.state.pitch;

    // stuck (a corner, a teammate in the doorway)? back off sideways and hop,
    // then find another way; after a while give up on this spot entirely
    const moving = keys.f || keys.b || keys.l || keys.r;
    if (moving) {
      this.stuckT += dt;
      if (Math.hypot(p.pos[0] - this.lastProgressPos[0], p.pos[2] - this.lastProgressPos[2]) > 24) {
        this.stuckT = 0; this.lastProgressPos = p.pos.slice();
      } else if (this.stuckT > 0.7 && !this.unstickUntil) {
        // sidestep toward whichever side has more room; hop only if that
        // did not work last time (a low obstacle)
        this.unstickUntil = now + 0.4;
        const y = this.state.yaw, o = [p.pos[0], p.pos[1] + 20, p.pos[2]];
        const right = [Math.cos(y), 0, -Math.sin(y)];
        const rh = raycast(o, right, this.game.colliders, 120), lh = raycast(o, right.map((v) => -v), this.game.colliders, 120);
        this.unstickDir = (rh ? rh.t : 120) >= (lh ? lh.t : 120) ? 1 : -1;
        if ((this.stuckCount || 0) >= 1) this.jump = true;
      }
      if (this.stuckT > 1.6) { this.path = null; this.repathAt = 0; this.nextPathAt = 0; this.stuckT = 0.8; this.stuckCount = (this.stuckCount || 0) + 1; }
      if ((this.stuckCount || 0) >= 3) { this.guardSpots = {}; this.goal = null; this.stuckCount = 0; }
    }
    if (this.unstickUntil && now > this.unstickUntil) this.unstickUntil = 0;
    if (p.pos[1] < -500) this.game.respawnStuck(p);
  }

  // Which way would enemies come from? A point ~600 u back along the route
  // from their spawn to here (cached per spot). Holding that angle is what
  // makes a defender dangerous.
  threatYaw() {
    const key = Math.round(this.p.pos[0] / 64) + ',' + Math.round(this.p.pos[2] / 64);
    if (this._threatKey !== key) {
      this._threatKey = key;
      this._threatYaw = null;
      const enemySpawn = this.game.map.spawns[this.p.team === TEAM.T ? TEAM.CT : TEAM.T][0];
      const path = this.nav.path(this.p.pos, enemySpawn);
      if (path && path.length > 1) {
        let acc = 0, prev = this.p.pos, pt = path[path.length - 1];
        for (const w of path) { acc += Math.hypot(w[0] - prev[0], w[2] - prev[2]); prev = w; if (acc > 600) { pt = w; break; } }
        this._threatYaw = Math.atan2(-(pt[0] - this.p.pos[0]), -(pt[2] - this.p.pos[2]));
      }
    }
    return this._threatYaw;
  }

  idleLook(dt, now) {
    if (now > this.holdUntil) {
      this.holdUntil = now + rnd(1.2, 3);
      const threat = this.game.phase === 'warmup' ? null : this.threatYaw();
      this.lookYaw = threat !== null ? threat + rnd(-0.35, 0.35) : this.state.yaw + rnd(-1.2, 1.2);
      if (this.heard && now - this.heardAt < 3) this.lookYaw = Math.atan2(-(this.heard[0] - this.p.pos[0]), -(this.heard[2] - this.p.pos[2]));
    }
    this.turnTo(this.lookYaw, 0, dt, 0.35);
  }

  turnTo(yaw, pitch, dt, speedMul = 1) {
    const max = this.skill.turn * speedMul * dt;
    const dy = wrap(yaw - this.state.yaw);
    this.state.yaw = wrap(this.state.yaw + Math.max(-max, Math.min(max, dy)));
    const dp = pitch - this.state.pitch;
    this.state.pitch += Math.max(-max, Math.min(max, dp));
    return Math.abs(dy) + Math.abs(dp);
  }

  // ------------------------------------------------------------ combat

  fight(dt, now) {
    const p = this.p, q = this.target, w = WEAPONS[p.weapon];
    const me = this.eye();
    // aim point: head or chest, with a skill-dependent error that shrinks while tracking
    if (!this.aimOff || now > this.aimOffUntil) {
      const e = this.skill.aimErr * Math.PI / 180;
      this.aimOff = [rnd(-e, e), rnd(-e, e) * 0.7];
      this.aimOffUntil = now + rnd(0.25, 0.6);
      this.aimHead = Math.random() < this.skill.hsBias;
    }
    const h = q.crouching ? (this.aimHead ? 44 : 30) : (this.aimHead ? 64 : 46);
    const t = [q.pos[0], q.pos[1] + h, q.pos[2]];
    const d = [t[0] - me[0], t[1] - me[1], t[2] - me[2]];
    const dist = Math.hypot(d[0], d[2]);
    const yaw = Math.atan2(-d[0], -d[2]) + this.aimOff[0];
    const pitch = Math.atan2(d[1], dist) + this.aimOff[1];
    const off = this.turnTo(yaw, pitch, dt, 1);

    // footwork: strafe mid/long range with rifles and pistols; hold still with snipers
    const sniper = !!w.zoomFov;
    let strafe = 0;
    if (!sniper && Math.random() < this.skill.strafe && dist > 250) {
      if (now > this.strafeSwap) { this.strafeSwap = now + rnd(0.35, 0.9); this.strafeDir *= -1; }
      strafe = this.strafeDir;
    }
    const crouch = !sniper && w.auto && dist > 900 && this.difficulty !== 'easy';
    // close in with a knife / short weapons, otherwise keep position
    const chase = w.melee || dist > this.skill.sight * 0.8 ? { key: 'chase', pos: q.pos } : null;
    // CS: moving ruins accuracy, so stop to shoot (counter-strafe) unless it
    // is a close-range brawl; strafe between bursts
    const shooting = now >= this.seenAt && (this.burstLeft > 0 || now >= this.burstPauseUntil - 0.05);
    const standStill = !w.melee && dist > 280 && shooting && this.difficulty !== 'easy';
    this.move(dt, chase, now, { face: false, strafe: standStill ? 0 : strafe, crouch, still: standStill });

    if (now >= this.seenAt && dist > 450 && dist < 1300 && p.nades.hegrenade && Math.random() < 0.01) {
      if (this.planNade('hegrenade', q.pos, now)) return;
    }
    if (now < this.seenAt || p.reloadUntil) return;
    const a = p.ammo[p.weapon];
    if (!w.melee && (!a || a.mag === 0)) { this.game.handleReload(p); return; }
    if (w.melee && dist > 80) return;
    if (off > (sniper ? 0.02 : 0.09)) return;               // not on target yet
    if (now < this.burstPauseUntil || now < p.nextFire) return;
    if (w.auto) {
      if (this.burstLeft <= 0) this.burstLeft = Math.round(rnd(...this.skill.burst)) + (dist < 500 ? 3 : 0);
      this.burstLeft--;
      if (this.burstLeft <= 0) this.burstPauseUntil = now + rnd(0.18, 0.4) * (dist > 1200 ? 1.6 : 1);
    } else {
      this.burstPauseUntil = now + (sniper ? rnd(0.1, 0.3) : rnd(0.05, 0.25));
    }
    // recoil: the spray climbs like anyone's; better bots pull it down more
    const c = 1 - this.skill.comp;
    const dir = norm(aimWithPunch(this.state.yaw, this.state.pitch, [p.recoil.punch[0] * c, p.recoil.punch[1] * c]));
    this.game.handleFire(p, { origin: me, dir, zoomed: sniper });
    kick(p.recoil, p.weapon, { onGround: this.state.onGround, speed: Math.hypot(this.state.vel[0], this.state.vel[2]), ducking: p.crouching });
  }
}
