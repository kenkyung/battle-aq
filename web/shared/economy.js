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
};

export const EQUIPMENT = {
  kevlar:  { name: 'Kevlar Vest',     price: 650 },
  assault: { name: 'Kevlar + Helmet', price: 1000 },
  ammo:    { name: 'Ammo refill',     price: ECONOMY.ammoPrice },
};

// Buy menu layout: categories in display order. Weapon ids refer to WEAPONS.
export const BUY_MENU = [
  { key: 'pistols', title: 'Pistols', items: ['glock', 'usp', 'deagle'] },
  { key: 'smgs',    title: 'SMGs',    items: ['mp5'] },
  { key: 'rifles',  title: 'Rifles',  items: ['ak47', 'm4a1'] },
  { key: 'snipers', title: 'Snipers', items: ['scout', 'awp'] },
  { key: 'gear',    title: 'Gear',    items: ['kevlar', 'assault', 'ammo'] },
];

export function itemInfo(id) {
  if (WEAPONS[id]) return { id, name: WEAPONS[id].name, price: WEAPONS[id].price, weapon: true, team: WEAPONS[id].team || 0 };
  if (EQUIPMENT[id]) return { id, name: EQUIPMENT[id].name, price: EQUIPMENT[id].price, weapon: false, team: 0 };
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

// CS-style armour. Kevlar halves the damage to body/arms (and the head too with
// a helmet); the armour itself soaks half of what it stopped. When the vest
// runs out, whatever it could not absorb goes through to health.
export function applyArmor(dmg, part, armor, helmet) {
  const covered = armor > 0 && (part === 'body' || part === 'arms' || (part === 'head' && helmet));
  if (!covered) return { hpDmg: dmg, armorDmg: 0 };
  let hpDmg = dmg * 0.5;
  let armorDmg = (dmg - hpDmg) * 0.5;
  if (armorDmg > armor) {
    armorDmg = armor;
    hpDmg = dmg - armor * 2;
  }
  return { hpDmg: Math.max(1, Math.round(hpDmg)), armorDmg: Math.round(armorDmg) };
}
