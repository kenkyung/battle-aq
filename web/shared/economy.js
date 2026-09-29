// Money, armour and the buy menu (M2). Shared by the server (which enforces
// every purchase) and the client (which only draws the menu), so prices and
// rules cannot drift apart. Values from CS16_REFERENCE.md §5.

import { WEAPONS, TEAM } from './constants.js';

export const ECONOMY = {
  startMoney: 800,
  maxMoney: 16000,
  warmupMoney: 16000,     // warmup is for trying things, so everything is affordable
  killReward: 300,
  knifeKillReward: 1500,
  winBonus: 3250,
  winBonusElimCT: 3500,   // CT wins by eliminating the terrorists
  lossBonus: [1400, 1900, 2400, 2900, 3400], // by consecutive losses (5+ = last)
  buyZoneRadius: 720,     // u from the centre of your team's spawn
  buyTimeIntoRound: 20,   // s after the freeze/buy phase ends that buying stays open
  ammoPrice: 100,         // refills every reserve you carry
  plantBonus: 800,        // every T, when the bomb was planted but T lost
  planterReward: 300,
  defuserReward: 300,
  winBonusBomb: 3500,     // T win by detonation
  winBonusDefuse: 3500,   // CT win by defusing
};

export const EQUIPMENT = {
  kevlar:  { name: 'Kevlar Vest',     price: 650 },
  assault: { name: 'Kevlar + Helmet', price: 1000 },
  ammo:    { name: 'Ammo refill',     price: ECONOMY.ammoPrice },
  kit:     { name: 'Defuse kit',      price: 200, team: 2 },
};

// Buy menu layout: categories in display order. Weapon ids refer to WEAPONS.
export const BUY_MENU = [
  { key: 'pistols', title: 'Pistols', items: ['glock', 'usp', 'deagle'] },
  { key: 'smgs',    title: 'SMGs',    items: ['mp5', 'ump45'] },
  { key: 'rifles',  title: 'Rifles',  items: ['ak47', 'm4a1'] },
  { key: 'snipers', title: 'Snipers', items: ['scout', 'awp'] },
  { key: 'heavy',   title: 'Machine gun', items: ['m249'] },
  { key: 'gear',    title: 'Gear',    items: ['kevlar', 'assault', 'kit', 'ammo'] },
];

export function itemInfo(id) {
  if (WEAPONS[id]) return { id, name: WEAPONS[id].name, price: WEAPONS[id].price, weapon: true, team: WEAPONS[id].team || 0 };
  if (EQUIPMENT[id]) return { id, name: EQUIPMENT[id].name, price: EQUIPMENT[id].price, weapon: false, team: EQUIPMENT[id].team || 0 };
  return null;
}

export function lossBonus(streak) {
  const b = ECONOMY.lossBonus;
  return b[Math.max(0, Math.min(b.length - 1, streak - 1))];
}

// Centre of a team's spawn cluster, on the ground plane.
export function buyZoneCenter(map, team) {
  const spots = map.spawns[team] || map.spawns[TEAM.T];
  let x = 0, z = 0;
  for (const s of spots) { x += s[0]; z += s[2]; }
  return [x / spots.length, z / spots.length];
}

export function inBuyZone(map, team, pos) {
  const [cx, cz] = buyZoneCenter(map, team);
  return Math.hypot(pos[0] - cx, pos[2] - cz) <= ECONOMY.buyZoneRadius;
}

// (Armour absorption lives in ballistics.js: armorAbsorb, with CS weapon armour ratios.)
