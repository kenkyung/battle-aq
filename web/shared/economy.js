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
  buyTimeIntoRound: 54,   // buying stays open for the first minute (freeze + 54 s)
  ammoPrice: 100,         // refills every reserve you carry
  plantBonus: 800,        // every T, when the bomb was planted but T lost
  planterReward: 300,
  defuserReward: 300,
  winBonusBomb: 3500,     // T win by detonation
  winBonusDefuse: 3500,   // CT win by defusing
  hostageUse: 150,        // first time a CT gets a hostage to follow
  hostageRescue: 1000,    // to the CT who brings one home
  hostageRescueTeam: 850, // to every CT, per hostage rescued
  hostageKill: -1500,     // whoever kills a hostage
  winBonusRescue: 3500,   // CT win by rescuing them all
};

export const EQUIPMENT = {
  kevlar:  { name: 'Kevlar Vest',     price: 650 },
  assault: { name: 'Kevlar + Helmet', price: 1000 },
  ammo:    { name: 'Ammo refill',     price: ECONOMY.ammoPrice },
  kit:     { name: 'Defuse kit',      price: 200, team: 2 },
  ammo1:   { name: 'Primary ammo',    price: 0 },   // one box for the primary (CS buyammo1: ",")
  ammo2:   { name: 'Secondary ammo',  price: 0 },   // one box for the pistol   (CS buyammo2: ".")
};

// CS 1.6 ammo boxes by calibre: [price, rounds per box]
export const AMMO_BOX = {
  '762nato': [80, 30], '556nato': [60, 30], '556natobox': [60, 30], '338magnum': [125, 10],
  '9mm': [20, 30], '45acp': [25, 12], '50ae': [40, 7], '357sig': [50, 13], '57mm': [50, 50], 'buckshot': [65, 8],
};
export function ammoBox(weaponId) { return AMMO_BOX[(WEAPONS[weaponId] || {}).caliber] || [50, 30]; }

// CS 1.6's default cl_autobuy (F1): the first affordable primary you are
// allowed, then ammo, then a kit and armour. Ids not in the game are skipped.
export const AUTOBUY = ['m4a1', 'ak47', 'famas', 'galil', 'p90', 'mp5', 'primammo', 'secammo', 'kit', 'assault', 'kevlar'];

// Buy menu layout: categories in display order. Weapon ids refer to WEAPONS.
// Buy menu in CS 1.6's layout and numbering (team-only guns sit in the same
// place for each side, so the number keys match CS's).
export const BUY_MENU = [
  { key: 'pistols',  title: 'Handguns',  items: ['glock', 'usp', 'p228', 'deagle', 'elites', 'fiveseven'] },
  { key: 'shotguns', title: 'Shotguns',  items: ['m3', 'xm1014'] },
  { key: 'smgs',     title: 'SMGs',      items: ['mp5', 'tmp', 'mac10', 'ump45', 'p90'] },
  { key: 'rifles',   title: 'Rifles',    items: ['galil', 'famas', 'ak47', 'm4a1', 'scout', 'sg552', 'aug', 'awp', 'g3sg1', 'sg550'] },
  { key: 'heavy',    title: 'Machine gun', items: ['m249'] },
  { key: 'ammo1',    title: 'Prim. ammo', items: ['ammo1'], direct: true },
  { key: 'ammo2',    title: 'Sec. ammo',  items: ['ammo2'], direct: true },
  { key: 'gear',     title: 'Equipment', items: ['kevlar', 'assault', 'flashbang', 'hegrenade', 'smokegrenade', 'kit'] },
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
