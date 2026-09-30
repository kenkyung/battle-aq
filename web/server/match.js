// Competitive match flow (M23), mixed into Game:
//
//   map veto (custom rooms)  ->  ready-up warmup  ->  knife round (winners pick
//   sides)  ->  the match (tactical timeouts / technical pauses at freeze time,
//   team names)  ->  overtime (MR3 at $10000) while it stays tied.
//
// Everything is driven by rules flags: readyup, kniferound, overtime, veto,
// timeouts. Casual / deathmatch / practice rooms never see any of it.

import { TEAM } from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';

const now = () => Date.now() / 1000;
const other = (t) => (t === TEAM.T ? TEAM.CT : TEAM.T);
const VETO_POOL = ['de_aq_dust', 'de_aq_dust2', 'de_aq_inferno', 'de_aq_aztec', 'de_aq_nuke', 'de_aq_train'];
const DEFAULT_NAMES = { [TEAM.T]: 'Terrorists', [TEAM.CT]: 'Counter-Terrorists' };
const HELP = '!ready / !unready (F3) · !pause (30 s tactical timeout) · !tech (technical pause) · !unpause · '
  + '!teamname <name> · !stay / !switch (knife winners) · !ban <map> (veto captains) · !veto (start the veto)';

export function newMatchState() {
  return {
    names: { ...DEFAULT_NAMES },
    maxRound: 0, winTarget: 0, ot: 0, otStart: false,
    knife: false, knifeDone: false, sideVote: null,
    startAt: 0, warmupSince: now(),
    timeouts: { [TEAM.T]: 0, [TEAM.CT]: 0 }, pending: null, paused: null,
    veto: null, vetoDone: false, vetoChangeAt: 0,
  };
}

export const MatchFlow = {
  // ------------------------------------------------------------ start of play

  get realHumans() { return [...this.players.values()].filter((p) => !p.bot && !p.dc); },

  // warmup with both teams present: veto, then ready-up, then go
  tryStart() {
    const m = this.match;
    if (!(this.teamSize(TEAM.T) > 0 && this.teamSize(TEAM.CT) > 0)) return;
    if (this.practice) { this.startMatch(); return; }
    if (this.rules.veto && !m.vetoDone) {
      const humansBoth = [TEAM.T, TEAM.CT].every((t) => this.realHumans.some((p) => p.team === t));
      if (!m.veto && humansBoth) this.startVeto();
      return;
    }
    if (this.rules.readyup) { this.broadcastReady(); return; }
    this.startMatch();
  },

  broadcastReady() {
    const hs = this.realHumans;
    const m = this.match;
    const all = hs.length > 0 && hs.every((p) => p.ready);
    const both = this.teamSize(TEAM.T) > 0 && this.teamSize(TEAM.CT) > 0;
    if (all && both && !m.startAt) m.startAt = now() + 5;
    if ((!all || !both) && m.startAt) m.startAt = 0;
    this.broadcast({
      t: 'ready', ready: hs.filter((p) => p.ready).map((p) => p.id), need: hs.filter((p) => !p.ready).map((p) => p.id),
      startIn: m.startAt ? Math.max(0, m.startAt - now()) : null,
      autoIn: this.rules.readyMax && !this.custom ? Math.max(0, m.warmupSince + this.rules.readyMax - now()) : null,
    });
  },

  setReady(p, on) {
    if (!this.rules.readyup || this.practice) return this.send(p, { t: 'notice', text: 'no ready-up in this room: the match starts by itself' });
    if (this.phase !== 'warmup') return this.send(p, { t: 'notice', text: 'the match is already live' });
    p.ready = !!on;
    this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: `${p.name} is ${on ? 'READY' : 'not ready'}` });
    this.broadcastReady();
  },

  // ------------------------------------------------------------ knife round

  startKnife() {
    const m = this.match;
    m.knife = true;
    this.roundNumber = 0;
    this.clearBomb();
    this.nades = []; this.smokes = [];
    this.drops = [];
    this.resetWorld();
    this.planting.clear(); this.defusing.clear();
    this.buyEndsAt = 0;
    for (const p of this.players.values()) {
      p.alive = false;
      this.respawn(p, true);
      this.knifeOnly(p);
    }
    this.setPhase('freeze', 3);
    this.broadcast({ t: 'knife_round' });
    this.tactics.newRound();
  },

  knifeOnly(p) {
    p.inv = { primary: null, secondary: null, melee: 'knife' };
    p.ammo = { knife: { mag: 1, reserve: 0 } };
    p.weapon = 'knife';
    p.nades = {}; p.armor = 0; p.helmet = false; p.shield = false; p.c4 = false;
    this.sendInv(p);
  },

  knifeTimeWinner() {
    const a = this.countAlive(TEAM.T), b = this.countAlive(TEAM.CT);
    return a === b ? (Math.random() < 0.5 ? TEAM.T : TEAM.CT) : a > b ? TEAM.T : TEAM.CT;
  },

  endKnife(winner) {
    const m = this.match;
    m.knife = false;
    m.knifeDone = true;
    this.planting.clear(); this.defusing.clear();
    const voters = this.realHumans.filter((p) => p.team === winner).map((p) => p.id);
    m.sideVote = { team: winner, votes: new Map(), until: now() + (voters.length ? 15 : 2), voters };
    this.setPhase('sidevote', voters.length ? 15 : 2);
    this.broadcast({ t: 'knife_won', team: winner, name: m.names[winner], voters, left: voters.length ? 15 : 2 });
  },

  voteSide(p, sw) {
    const v = this.match.sideVote;
    if (!v || !v.voters.includes(p.id)) return this.send(p, { t: 'notice', text: 'only the knife-round winners choose sides' });
    v.votes.set(p.id, !!sw);
    this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: `${p.name} votes to ${sw ? 'SWITCH' : 'STAY'}` });
    if (v.voters.every((id) => v.votes.has(id))) this.finishSideVote();
  },

  finishSideVote() {
    const m = this.match, v = m.sideVote;
    if (!v) return;
    m.sideVote = null;
    let sw = 0, st = 0;
    for (const x of v.votes.values()) if (x) sw++; else st++;
    const swap = sw > st;
    if (swap) {
      for (const p of this.players.values()) { p.team = other(p.team); this.send(p, { t: 'team', team: p.team }); }
      m.names = { [TEAM.T]: m.names[TEAM.CT], [TEAM.CT]: m.names[TEAM.T] };
    }
    this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: `${m.names[swap ? other(v.team) : v.team]} ${swap ? 'switch sides' : 'stay'} — LIVE ON THE NEXT RESTART` });
    this.startMatch();
  },

  // ------------------------------------------------------------ pauses

  requestPause(p, kind) {
    const m = this.match;
    if (this.practice || this.phase === 'warmup' || this.dm) return this.send(p, { t: 'notice', text: 'pauses are for live matches' });
    if (m.paused || m.pending) return this.send(p, { t: 'notice', text: 'a pause is already on or coming' });
    if (kind === 'tactical') {
      if (!this.rules.timeouts) return this.send(p, { t: 'notice', text: 'no tactical timeouts in this room' });
      if (m.timeouts[p.team] <= 0) return this.send(p, { t: 'notice', text: 'your team has no timeouts left' });
      m.timeouts[p.team]--;
    } else if (!this.rules.readyup) return this.send(p, { t: 'notice', text: 'no technical pauses in this room' });
    m.pending = { kind, team: p.team, by: p.name };
    const label = kind === 'tactical' ? `tactical timeout (${m.timeouts[p.team]} left)` : 'technical pause';
    this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: `${p.name} (${m.names[p.team]}) called a ${label}${this.phase === 'freeze' ? '' : ' — it starts at the next freeze time'}` });
    if (this.phase === 'freeze') this.startPause();
  },

  startPause() {
    const m = this.match;
    if (!m.pending) return;
    const len = m.pending.kind === 'tactical' ? (this.rules.timeoutLen || 30) : 300;
    m.paused = { ...m.pending, until: now() + len };
    m.pending = null;
    this.broadcast({ t: 'pause', kind: m.paused.kind, team: m.paused.team, name: m.names[m.paused.team], left: len });
  },

  unpause(p) {
    const m = this.match;
    if (m.pending && m.pending.team === p.team) { m.pending = null; this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: 'pause cancelled' }); return; }
    if (!m.paused) return this.send(p, { t: 'notice', text: 'the game is not paused' });
    if (m.paused.team !== p.team && !p.admin) return this.send(p, { t: 'notice', text: 'only the team that paused can unpause' });
    this.endPause();
  },

  endPause() {
    this.match.paused = null;
    this.broadcast({ t: 'pause', off: 1 });
    this.broadcast({ t: 'round', ...this.roundInfo() });
  },

  // ------------------------------------------------------------ team names

  setTeamName(p, name) {
    const clean = String(name || '').replace(/[^\w .\-!#&@']/g, '').trim().slice(0, 16);
    if (!clean) return this.send(p, { t: 'notice', text: 'usage: !teamname <name>' });
    this.match.names[p.team] = clean;
    this.broadcast({ t: 'teamnames', names: this.match.names });
    this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: `${p.name} named their team "${clean}"` });
  },

  // ------------------------------------------------------------ map veto

  vetoCaptain(team) {
    const hs = this.realHumans.filter((p) => p.team === team).sort((a, b) => a.id - b.id);
    return hs[0] || null;
  },

  startVeto() {
    const m = this.match;
    const pool = VETO_POOL.filter((id) => MAPS[id]);
    m.veto = { pool, banned: [], turn: TEAM.CT, until: now() + 20 };
    this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: 'MAP VETO: captains take turns banning maps, the last one left is played' });
    this.broadcastVeto();
  },

  broadcastVeto() {
    const v = this.match.veto;
    if (!v) return;
    const cap = { [TEAM.T]: this.vetoCaptain(TEAM.T), [TEAM.CT]: this.vetoCaptain(TEAM.CT) };
    this.broadcast({
      t: 'veto', pool: v.pool, banned: v.banned, turn: v.turn, names: this.match.names,
      captains: { [TEAM.T]: cap[TEAM.T] && cap[TEAM.T].id, [TEAM.CT]: cap[TEAM.CT] && cap[TEAM.CT].id },
      left: Math.max(0, v.until - now()), done: v.done || null,
    });
  },

  vetoBan(p, mapId) {
    const v = this.match.veto;
    if (!v || v.done) return this.send(p, { t: 'notice', text: 'no map veto running' });
    const cap = this.vetoCaptain(v.turn);
    if (p && (!cap || cap.id !== p.id)) return this.send(p, { t: 'notice', text: `it is the ${this.match.names[v.turn]} captain's turn` });
    const id = v.pool.find((m) => m === mapId || m.replace(/^de_aq_/, '') === mapId);
    if (!id || v.banned.some((b) => b.map === id)) return p && this.send(p, { t: 'notice', text: 'pick a map that is still in the pool' });
    v.banned.push({ map: id, team: v.turn });
    const left = v.pool.filter((m) => !v.banned.some((b) => b.map === m));
    if (left.length === 1) {
      v.done = left[0];
      this.match.vetoDone = true;
      this.match.vetoChangeAt = now() + 4;
      this.broadcast({ t: 'chat', id: 0, name: '*', team: 0, text: `MAP VETO: ${left[0]} will be played` });
    } else {
      v.turn = other(v.turn);
      v.until = now() + 20;
    }
    this.broadcastVeto();
  },

  // ------------------------------------------------------------ chat commands

  chatCommand(p, text) {
    const [cmd, ...rest] = text.slice(1).trim().split(/\s+/);
    switch ((cmd || '').toLowerCase()) {
      case 'ready': case 'r': case 'rdy': return this.setReady(p, true);
      case 'unready': case 'notready': case 'ur': return this.setReady(p, false);
      case 'pause': case 'tac': case 'timeout': return this.requestPause(p, 'tactical');
      case 'tech': return this.requestPause(p, 'tech');
      case 'unpause': case 'resume': return this.unpause(p);
      case 'teamname': case 'name': return this.setTeamName(p, rest.join(' '));
      case 'stay': return this.voteSide(p, false);
      case 'switch': case 'swap': return this.voteSide(p, true);
      case 'ban': return this.vetoBan(p, rest[0]);
      case 'veto':
        if (!this.rules.veto || this.match.vetoDone || this.match.veto || this.phase !== 'warmup') return this.send(p, { t: 'notice', text: 'no map veto to start' });
        return this.startVeto();
      case 'help': case 'commands': return this.send(p, { t: 'notice', text: HELP });
      default: return null;
    }
  },

  // ------------------------------------------------------------ per tick

  tickMatch(t, dt) {
    const m = this.match;
    // a pause holds the freeze-time clock (and the buy time) where it is
    if (m.paused) {
      if (this.phase === 'freeze') { this.phaseEndsAt += dt; this.buyEndsAt += dt; }
      if (t >= m.paused.until) this.endPause();
    }
    if (this.phase === 'warmup') {
      if (m.startAt && t >= m.startAt) { m.startAt = 0; this.startMatch(); return; }
      // public competitive rooms: an AFK player cannot hold the match hostage
      if (this.rules.readyup && this.rules.readyMax && !this.custom && !this.practice && t - m.warmupSince > this.rules.readyMax
        && this.teamSize(TEAM.T) > 0 && this.teamSize(TEAM.CT) > 0 && !m.veto) { this.startMatch(); return; }
      if (m.veto && !m.veto.done) {
        const cap = this.vetoCaptain(m.veto.turn);
        if (t >= m.veto.until || (!cap && t >= m.veto.until - 18.5)) {
          const left = m.veto.pool.filter((x) => !m.veto.banned.some((b) => b.map === x));
          this.vetoBan(null, left[Math.floor(Math.random() * left.length)]);
        }
      }
      if (m.vetoChangeAt && t >= m.vetoChangeAt) {
        const map = m.veto && m.veto.done;
        m.vetoChangeAt = 0; m.veto = null;
        if (map) this.changeMap(map);
      }
      if (this.rules.readyup && t >= (m.readyPing || 0)) { m.readyPing = t + 5; if (!m.veto) this.broadcastReady(); }
    }
    if (this.phase === 'sidevote' && m.sideVote && t >= m.sideVote.until) this.finishSideVote();
  },
};

export function installMatch(Game) {
  for (const k of Object.getOwnPropertyNames(MatchFlow)) {
    Object.defineProperty(Game.prototype, k, Object.getOwnPropertyDescriptor(MatchFlow, k));
  }
}
