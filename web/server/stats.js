// Persistent player stats (M16): kills, deaths, headshots, rounds won /
// lost, per player name, kept in a JSON file (STATS_FILE, default
// data/stats.json) and written at most every 20 s.

import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.STATS_FILE || path.join(process.cwd(), 'data', 'stats.json');
let data = {};
try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = {}; }
let dirty = false;

const key = (name) => String(name || '').trim().toLowerCase().slice(0, 24);
function row(name) {
  const k = key(name);
  if (!k) return null;
  return (data[k] ||= { name: String(name).slice(0, 24), kills: 0, deaths: 0, hs: 0, wins: 0, losses: 0, since: Date.now() });
}

export const stats = {
  enabled: process.env.STATS !== '0',
  kill(killer, victim, headshot) {
    if (!this.enabled) return;
    if (killer && !killer.bot) { const r = row(killer.name); if (r) { r.kills++; if (headshot) r.hs++; dirty = true; } }
    if (victim && !victim.bot) { const r = row(victim.name); if (r) { r.deaths++; dirty = true; } }
  },
  round(winners, losers) {
    if (!this.enabled) return;
    for (const p of winners) if (!p.bot) { const r = row(p.name); if (r) { r.wins++; dirty = true; } }
    for (const p of losers) if (!p.bot) { const r = row(p.name); if (r) { r.losses++; dirty = true; } }
  },
  top(limit = 20) {
    return Object.values(data)
      .filter((r) => r.kills + r.deaths >= 5)
      .map((r) => ({ ...r, kd: r.deaths ? +(r.kills / r.deaths).toFixed(2) : r.kills, hsp: r.kills ? Math.round(100 * r.hs / r.kills) : 0 }))
      .sort((a, b) => b.kills - a.kills)
      .slice(0, limit);
  },
  flush() {
    if (!dirty) return;
    dirty = false;
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data)); } catch (e) { console.warn('stats: could not write', e.message); }
  },
};
setInterval(() => stats.flush(), 20000).unref();
process.on('exit', () => stats.flush());
