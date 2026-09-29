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

import { movePlayer, norm } from '../shared/physics.js';
import { PLAYER, WEAPONS, TEAM, BOMB } from '../shared/constants.js';
import { ECONOMY, inBuyZone } from '../shared/economy.js';
import { navFor } from './nav.js';
import { kick, decayPunch, aimWithPunch } from '../shared/ballistics.js';

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
  }

  get nav() { return navFor(this.game.map, this.game.colliders); }

  // ------------------------------------------------------------ perception

  eye(p = this.p) {
    return [p.pos[0], p.pos[1] + (p.crouching ? PLAYER.crouchEye : PLAYER.standEye), p.pos[2]];
  }

  perceive(now) {
    const me = this.eye();
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
      if (dist < bestD) { bestD = dist; best = q; }
    }
    if (best) {
      if (!this.target || this.target.id !== best.id) {
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

  onHurt(attacker, now) { this.hurtBy = attacker.id; this.hurtAt = now; this.lastSeen = attacker.pos.slice(); this.lastSeenAt = now; }
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
    if (p.weapon === 'c4' || p.weapon === 'knife') {
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

  move(dt, goal, now, { face = true, strafe = 0, crouch = false } = {}) {
    const p = this.p;
    let wish = [0, 0, 0];
    const wp = goal && this.game.phase !== 'freeze' ? this.followPath(now) : null;
    if (wp) {
      const d = [wp[0] - p.pos[0], 0, wp[2] - p.pos[2]];
      const L = Math.hypot(d[0], d[2]) || 1;
      wish = [d[0] / L, 0, d[2] / L];
      if (face) this.turnTo(Math.atan2(-wish[0], -wish[2]), 0, dt, 0.7);
    } else if (face) {
      this.idleLook(dt, now);
    }
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
    movePlayer(this.state, keys, dt, this.game.colliders);
    p.pos = this.state.pos;
    p.crouching = this.state.crouching;
    p.moving = Math.hypot(this.state.vel[0], this.state.vel[2]) > 12;
    p.yaw = this.state.yaw;
    p.pitch = this.state.pitch;

    // stuck? hop, then pick a new path
    const moving = keys.f || keys.b || keys.l || keys.r;
    if (moving) {
      this.stuckT += dt;
      if (Math.hypot(p.pos[0] - this.lastProgressPos[0], p.pos[2] - this.lastProgressPos[2]) > 24) {
        this.stuckT = 0; this.lastProgressPos = p.pos.slice();
      } else if (this.stuckT > 0.8 && this.stuckT < 0.85) this.jump = true;
      else if (this.stuckT > 2 && this.stuckT < 2.05) { this.path = null; this.repathAt = 0; }
      else if (this.stuckT > 3.5) {
        // last resort: step onto the nearest node centre (always clear of walls)
        const n = this.nav.nearest(p.pos);
        if (n && Math.hypot(n.x - p.pos[0], n.z - p.pos[2]) < 48) { p.pos = [n.x, n.y + 0.5, n.z]; this.state.pos = p.pos; }
        this.stuckT = 0; this.path = null; this.repathAt = 0; this.lastProgressPos = p.pos.slice();
      }
    }
    if (p.pos[1] < -500) this.game.respawnStuck(p);
  }

  idleLook(dt, now) {
    if (now > this.holdUntil) {
      this.holdUntil = now + rnd(1.2, 3);
      this.lookYaw = this.state.yaw + rnd(-1.2, 1.2);
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
    this.move(dt, chase, now, { face: false, strafe: this.burstLeft > 0 ? strafe * 0.4 : strafe, crouch });

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
