// Server administration (M16): rcon commands from the in-game console
// (rcon_password + rcon <command>), IP bans, and a per-connection message
// rate limit.

import fs from 'node:fs';
import path from 'node:path';
import { TEAM } from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';

const BANS = process.env.BANS_FILE || path.join(process.cwd(), 'data', 'bans.json');
let bans = {};
try { bans = JSON.parse(fs.readFileSync(BANS, 'utf8')); } catch { bans = {}; }
const saveBans = () => { try { fs.mkdirSync(path.dirname(BANS), { recursive: true }); fs.writeFileSync(BANS, JSON.stringify(bans)); } catch { /* read-only */ } };

export function isBanned(ip) {
  const b = bans[ip];
  if (!b) return false;
  if (b.until && Date.now() > b.until) { delete bans[ip]; saveBans(); return false; }
  return true;
}

// token bucket: 240 messages/s sustained, bursts to 480; flooding kicks
export function rateLimiter() {
  let tokens = 480, last = Date.now(), dropped = 0, window = Date.now();
  return () => {
    const t = Date.now();
    tokens = Math.min(480, tokens + (t - last) * 0.24);
    last = t;
    if (t - window > 10000) { window = t; dropped = 0; }
    if (tokens < 1) { dropped++; return dropped > 2000 ? 'kick' : 'drop'; }
    tokens -= 1;
    return 'ok';
  };
}

// cvars rcon may change on a room, CS names -> rules fields (and units)
const CVARS = {
  mp_roundtime: ['roundtime', 60], mp_freezetime: ['freezetime', 1], mp_buytime: ['buytime', 60], mp_c4timer: ['c4timer', 1],
  mp_winlimit: ['winlimit', 1], mp_maxrounds: ['maxrounds', 1], mp_friendlyfire: ['friendlyfire', 'bool'],
  mp_timelimit: ['timelimit', 60], mp_fraglimit: ['fraglimit', 1],
  mp_afkkick: ['afkkick', 1], sv_timeout: ['timeout', 1],
};

// run one rcon command on `game` for `player`; returns the reply text
export function rcon(game, player, line, { ip } = {}) {
  const args = String(line).trim().split(/\s+/);
  const cmd = (args.shift() || '').toLowerCase();
  const find = (who) => {
    if (!who) return null;
    if (who.startsWith('#')) return game.players.get(parseInt(who.slice(1), 10)) || null;
    return [...game.players.values()].find((p) => p.name.toLowerCase() === who.toLowerCase()) || null;
  };
  switch (cmd) {
    case 'status':
      return [...game.players.values()].map((p) => `#${p.id} ${p.name} ${p.team === TEAM.T ? 'T' : 'CT'} ${p.kills}/${p.deaths} ${p.bot ? 'BOT' : (p.ping ?? '?') + 'ms ' + (p.ip || '')}`).join('\n') || 'nobody';
    case 'kick': {
      const p = find(args[0]);
      if (!p) return 'no such player';
      if (p.bot) { game.removePlayer(p.id); return `kicked bot ${p.name}`; }
      if (p.ws) { p.ws.send(JSON.stringify({ t: 'error', text: 'kicked by the admin' })); p.ws.close(); }
      return `kicked ${p.name}`;
    }
    case 'ban': {
      const p = find(args[0]);
      if (!p || !p.ip) return 'no such player (bots cannot be banned)';
      const mins = parseInt(args[1], 10) || 0;
      bans[p.ip] = { name: p.name, until: mins ? Date.now() + mins * 60000 : 0, by: player.name };
      saveBans();
      if (p.ws) { p.ws.send(JSON.stringify({ t: 'error', text: 'banned from this server' })); p.ws.close(); }
      return `banned ${p.name} (${p.ip}) ${mins ? `for ${mins} min` : 'permanently'}`;
    }
    case 'unban': { if (!bans[args[0]]) return 'not banned'; delete bans[args[0]]; saveBans(); return `unbanned ${args[0]}`; }
    case 'listbans': return Object.entries(bans).map(([k, v]) => `${k} ${v.name} ${v.until ? new Date(v.until).toISOString() : 'permanent'}`).join('\n') || 'no bans';
    case 'map': case 'changelevel': {
      if (!MAPS[args[0]]) return `unknown map. maps: ${Object.keys(MAPS).join(' ')}`;
      game.changeMap(args[0]);
      return `changing to ${args[0]}`;
    }
    case 'sv_restart': case 'restart': case 'mp_restartgame': game.startMatchIfReady(); return 'match restarted';
    case 'bot_add': case 'bot_add_t': case 'bot_add_ct': {
      const team = cmd === 'bot_add_ct' || /ct/i.test(args[0] || '') ? TEAM.CT : cmd === 'bot_add_t' || /^t$/i.test(args[0] || '') ? TEAM.T
        : (game.teamSize(TEAM.T) <= game.teamSize(TEAM.CT) ? TEAM.T : TEAM.CT);
      game.addBot(team, args[1] || game.botDifficulty || 'normal');
      game.checkMode();
      return 'bot added';
    }
    case 'kickidle': { game.kickIdle(player); return 'kicked every ghost / frozen player'; }
    case 'bot_kick': { for (const p of [...game.players.values()]) if (p.bot) game.removePlayer(p.id, true); return 'bots kicked'; }
    case 'say': game.broadcast({ t: 'chat', id: 0, name: 'Console', team: 0, text: args.join(' ').slice(0, 140) }); return 'ok';
    default:
      if (CVARS[cmd]) {
        const [field, unit] = CVARS[cmd];
        if (!args.length) return `${cmd} = ${game.rules[field]}`;
        const v = unit === 'bool' ? args[0] !== '0' : parseFloat(args[0]) * unit;
        if (unit !== 'bool' && !Number.isFinite(v)) return 'bad value';
        game.rules = { ...game.rules, [field]: v };        // a copy: never edit the shared preset
        if (field === 'halftime' || field === 'winlimit') game.halftimeRound = game.rules.halftime;
        game.broadcast({ t: 'chat', id: 0, name: 'Console', team: 0, text: `${cmd} set to ${args[0]}` });
        return `${cmd} = ${args[0]}`;
      }
      return 'rcon: status kick ban unban listbans map restart bot_add [t|ct] [difficulty] bot_kick say mp_roundtime mp_freezetime mp_buytime mp_c4timer mp_winlimit mp_maxrounds mp_friendlyfire mp_timelimit mp_fraglimit mp_afkkick sv_timeout kickidle';
  }
}
