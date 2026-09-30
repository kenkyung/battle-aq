// Team tactics for bots (M14), the ZBot way: a plan per team per round, made
// at freeze time, plus shared intel while the round runs.
//
//   economy   eco / force / full, from the team's money and losing streak
//   T plan    rush (all to one site), split (two groups, two routes, same
//             site), default (take map control, then execute ~35 s in)
//   CT plan   spread over the sites (2-3 each), a sniper on a sniper spot,
//             rotate to where the enemy was seen, everyone to a planted bomb
//   save      a lost cause late in a round: hide and keep the gun

import { TEAM, WEAPONS } from '../shared/constants.js';

const pickW = (items) => {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of items) { r -= w; if (r <= 0) return v; }
  return items[0][0];
};

export class Tactics {
  constructor(game) {
    this.game = game;
    this.plans = {};
    this.intel = { [TEAM.T]: [], [TEAM.CT]: [] };   // { pos, t, site }
  }

  sites() { return Object.entries(this.game.map.bombsites || {}); }

  // freeze time: decide both teams' round
  newRound() {
    const g = this.game;
    this.intel = { [TEAM.T]: [], [TEAM.CT]: [] };
    for (const team of [TEAM.T, TEAM.CT]) {
      const bots = [...g.players.values()].filter((p) => p.team === team && p.bot);
      if (!bots.length) { this.plans[team] = null; continue; }
      const money = bots.reduce((a, p) => a + p.money, 0) / bots.length;
      const pistol = g.roundNumber === 1 || g.roundNumber === g.halftimeRound + 1;
      const streak = g.lossStreak[team] || 0;
      const lastRound = g.score[team === TEAM.T ? TEAM.CT : TEAM.T] >= g.rules.winlimit - 1;
      const full = team === TEAM.T ? 3700 : 4300;
      let economy = 'full';
      if (pistol) economy = 'pistol';
      else if (money >= full) economy = 'full';
      else if (streak >= 3 || lastRound || money >= 2800) economy = 'force';
      else economy = 'eco';
      const sites = this.sites();
      const site = sites.length ? sites[Math.floor(Math.random() * sites.length)] : null;
      let style = 'hold';
      if (team === TEAM.T) style = economy === 'eco' ? pickW([['rush', 3], ['default', 2]]) : pickW([['rush', 25], ['split', 30], ['default', 45]]);
      this.plans[team] = { economy, style, site, execAt: 0, groups: {} };
      // split: half the team takes a detour through a point off the direct route
      if (style === 'split' && site) {
        const nav = g.nav;
        const start = g.spawnSpots(team)[0];
        const mid = [(start[0] + site[1][0]) / 2, 0, (start[2] + site[1][2]) / 2];
        let via = null;
        for (let i = 0; i < 20 && !via; i++) {
          const n = nav.randomNode();
          const off = Math.hypot(n.x - mid[0], n.z - mid[2]);
          if (off > 500 && off < 1400 && nav.path(start, [n.x, n.y, n.z]) && nav.path([n.x, n.y, n.z], site[1])) via = [n.x, n.y, n.z];
        }
        bots.forEach((p, i) => { this.plans[team].groups[p.id] = i % 2 && via ? via : null; });
      }
      // CT: two sites -> spread; one sniper spot per site for a scoped rifle
      if (team === TEAM.CT) {
        bots.forEach((p, i) => { this.plans[team].groups[p.id] = sites.length ? sites[i % sites.length] : null; });
      }
    }
  }

  plan(team) { return this.plans[team] || null; }

  // a bot saw an enemy: its team knows where (and near which site)
  report(team, pos, now) {
    let site = null;
    for (const [label, s] of this.sites()) if (Math.hypot(pos[0] - s[0], pos[2] - s[2]) < 1000) site = label;
    const list = this.intel[team];
    list.push({ pos: pos.slice(), t: now, site });
    while (list.length > 12 || (list.length && now - list[0].t > 20)) list.shift();
  }

  // where the enemy has been showing up lately (site label), if anywhere
  hotSite(team, now) {
    const count = {};
    for (const e of this.intel[team]) if (e.site && now - e.t < 10) count[e.site] = (count[e.site] || 0) + 1;
    let best = null, n = 0;
    for (const [k, v] of Object.entries(count)) if (v > n) { best = k; n = v; }
    return n >= 2 ? best : null;
  }

  // is this a lost round worth saving the gun?
  shouldSave(p, now) {
    const g = this.game;
    const mates = [...g.players.values()].filter((q) => q.team === p.team && q.alive).length;
    const foes = [...g.players.values()].filter((q) => q.team !== p.team && q.alive).length;
    const left = g.phaseEndsAt - now;
    const weapon = WEAPONS[p.inv.primary] ? WEAPONS[p.inv.primary].price : 0;
    if (weapon < 2000) return false;
    if (p.team === TEAM.CT && g.phase === 'planted') return mates === 1 && foes >= 3 && !p.kit;
    if (p.team === TEAM.T && g.phase === 'round') return mates === 1 && foes >= 3 && left < 25;
    return false;
  }
}
