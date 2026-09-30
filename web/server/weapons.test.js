// M9 arsenal on a fake clock: shotgun pellets + falloff + shell reloads,
// bursts, silencers, knife stab / backstab, wallbangs, the autosniper model,
// dropped guns (G, death, buying over one) and pick-ups.
//   node server/weapons.test.js

let fake = 1_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;

const { Game } = await import('./game.js');
const { TEAM, WEAPONS, ROUND } = await import('../shared/constants.js');
const { newRecoil, shotSpread } = await import('../shared/ballistics.js');

const failures = [];
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { failures.push(label); console.log(`  FAIL ${label}`); } };
const sock = () => { const s = { readyState: 1, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)) }; s.got = (t) => s.msgs.filter((m) => m.t === t); s.last = (t) => s.got(t).at(-1); return s; };
const advance = (g, seconds) => { const n = Math.ceil(seconds * 30); for (let i = 0; i < n; i++) { fake += 1000 / 30; g.update(); } };

function setup() {
  const g = new Game('de_aq_dust', { practice: true });
  const wa = sock(), wb = sock();
  const a = g.addPlayer(wa, 'Shooter', { team: TEAM.T });
  const b = g.addPlayer(wb, 'Target', { team: TEAM.CT });
  g.checkMode();
  advance(g, ROUND.freezeTime + 0.2);
  // an open strip of dust: both players on the T spawn floor
  const s = g.spawnSpots(TEAM.T)[0];
  a.pos = [s[0], s[1], s[2]]; a.yaw = 0;
  return { g, a, b, wa, wb, s };
}
const give = (g, p, id) => { const w = WEAPONS[id]; p.inv[w.slot] = id; p.ammo[id] = { mag: w.mag, reserve: w.reserve }; p.weapon = id; p.nextFire = 0; p.modes = {}; };
const shootAt = (g, a, target, extra = {}) => {
  const eye = [a.pos[0], a.pos[1] + 53, a.pos[2]];
  const aim = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const L = Math.hypot(...aim);
  g.onMessage(a, { t: 'fire', origin: eye, dir: aim.map((v) => v / L), ...extra });
};

console.log('shotguns');
{
  const { g, a, b } = setup();
  give(g, a, 'm3');
  b.pos = [a.pos[0], a.pos[1], a.pos[2] - 120]; b.armor = 0; b.hp = 100;
  shootAt(g, a, [b.pos[0], b.pos[1] + 40, b.pos[2]]);
  ok(b.hp < 20, `M3 at 120 u: nine pellets tear through (hp ${b.hp})`);
  const near = 100 - Math.max(0, b.hp);
  b.alive = true; b.hp = 1000; b.pos = [a.pos[0], a.pos[1], a.pos[2] - 1500];
  a.nextFire = 0; shootAt(g, a, [b.pos[0], b.pos[1] + 40, b.pos[2]]);
  ok(1000 - b.hp < near * 0.6, `at 1500 u the pellets spread and fade (${1000 - b.hp} dmg)`);
  // shell by shell
  a.ammo.m3.mag = 3; a.ammo.m3.reserve = 10; a.nextFire = 0;
  g.onMessage(a, { t: 'reload' });
  advance(g, 0.55 + 0.45 * 2 + 0.05);
  ok(a.ammo.m3.mag === 6 && a.ammo.m3.reserve === 7, `shells go in one at a time (${a.ammo.m3.mag} after ~1.4 s)`);
  shootAt(g, a, [b.pos[0], b.pos[1] + 40, b.pos[2]]);
  ok(a.ammo.m3.mag === 5 && !a.shellAt, 'firing interrupts the shell reload');
}

console.log('burst + silencer');
{
  const { g, a, b, wa } = setup();
  give(g, a, 'glock');
  g.onMessage(a, { t: 'alt' });
  ok(a.modes.glock === 'burst' && wa.last('mode')?.mode === 'burst', 'right click: Glock burst mode');
  b.pos = [a.pos[0], a.pos[1], a.pos[2] - 3000]; b.hp = 10000;
  let fired = 0;
  for (let i = 0; i < 12; i++) { const m = a.ammo.glock.mag; shootAt(g, a, [b.pos[0], 40, b.pos[2]]); if (a.ammo.glock.mag < m) fired++; fake += 34; }
  ok(fired >= 3 && fired <= 4, `bursts: 3 rounds 0.1 s apart, then a 0.5 s pause (${fired} in 0.4 s)`);
  give(g, a, 'm4a1');
  g.onMessage(a, { t: 'alt' });
  ok(a.modes.m4a1 === 'silenced' && a.nextFire > fake / 1000 + 1.5, 'M4A1 silencer goes on (2 s)');
  advance(g, 2.1);
  b.pos = [a.pos[0], a.pos[1], a.pos[2] - 120]; b.hp = 100; b.armor = 0;
  shootAt(g, a, [b.pos[0], b.pos[1] + 52, b.pos[2]]);
  ok(100 - b.hp >= 30 && 100 - b.hp <= 33, `silenced M4A1 chest hit: ${100 - b.hp} (33 base)`);
}

console.log('knife');
{
  const { g, a, b } = setup();
  give(g, a, 'knife');
  b.pos = [a.pos[0], a.pos[1], a.pos[2] - 40]; b.hp = 100; b.armor = 0; b.yaw = 0;     // facing away from a
  shootAt(g, a, [b.pos[0], b.pos[1] + 45, b.pos[2]], { alt: true });
  ok(!b.alive, 'stab in the back (65 x 3): dead');
  b.alive = true; b.hp = 100; b.yaw = Math.PI; a.nextFire = 0;                            // facing a
  shootAt(g, a, [b.pos[0], b.pos[1] + 45, b.pos[2]], { alt: true });
  ok(b.hp === 35, `stab from the front: 65 (${100 - b.hp})`);
  b.hp = 100; a.nextFire = 0; b.pos[2] = a.pos[2] - 90;
  shootAt(g, a, [b.pos[0], b.pos[1] + 45, b.pos[2]], { alt: true });
  ok(b.hp === 100, 'stab reach is short (32 u)');
}

console.log('wallbang');
{
  const { g, a, b } = setup();
  const wall = { min: [a.pos[0] - 100, a.pos[1], a.pos[2] - 70], max: [a.pos[0] + 100, a.pos[1] + 200, a.pos[2] - 60], mat: 'wood' };
  g.colliders.push(wall);
  g._matClass.wood = 'wood';
  b.pos = [a.pos[0], a.pos[1], a.pos[2] - 130]; b.hp = 100; b.armor = 0;
  give(g, a, 'ak47');
  shootAt(g, a, [b.pos[0], b.pos[1] + 45, b.pos[2]]);
  ok(b.hp < 100 && b.hp > 60, `AK-47 through 10 u of wood: ${100 - b.hp} dmg`);
  wall.min[2] = a.pos[2] - 110;   // now 50 u thick
  b.hp = 100; a.nextFire = 0;
  shootAt(g, a, [b.pos[0], b.pos[1] + 45, b.pos[2]]);
  ok(b.hp === 100, 'but not through 50 u');
}

console.log('autosniper');
{
  const r = newRecoil();
  const ctx = (t) => ({ now: t, onGround: true, speed: 0, ducking: false, zoomed: true });
  const s1 = shotSpread(r, 'g3sg1', ctx(10));
  const s2 = shotSpread(r, 'g3sg1', ctx(10.25));
  const s3 = shotSpread(r, 'g3sg1', ctx(12));
  ok(s2 > s1 * 2 && s3 < s2, `G3SG1: spamming spreads (${s1.toFixed(4)} -> ${s2.toFixed(4)}), waiting recovers (${s3.toFixed(4)})`);
}

console.log('dropped guns');
{
  const { g, a, b } = setup();
  give(g, a, 'ak47');
  g.onMessage(a, { t: 'drop' });
  ok(!a.inv.primary && g.drops.length === 1 && g.drops[0].weapon === 'ak47', 'G drops the AK on the floor');
  const d = g.drops[0];
  b.inv.primary = null; b.pos = [d.pos[0], d.pos[1], d.pos[2]];
  advance(g, 0.2);
  ok(b.inv.primary === 'ak47' && b.ammo.ak47 && g.drops.length === 0, 'an enemy walking over it picks it up (with its ammo)');
  // buying over a primary drops the old one
  b.money = 5000; b.pos = g.spawnSpots(TEAM.CT)[0].slice(); g.phase = 'round'; g.buyEndsAt = fake / 1000 + 30;
  g.onMessage(b, { t: 'buy', item: 'm4a1' });
  ok(b.inv.primary === 'm4a1' && g.drops.some((x) => x.weapon === 'ak47'), 'buying the M4A1 drops the AK');
  // the dead drop their gun
  const n = g.drops.length;
  b.hp = 1; g.applyDamage(a, { id: b.id, part: 'chest', point: b.pos, t: 10 }, WEAPONS.ak47, 50);
  ok(!b.alive && g.drops.length === n + 1 && g.drops.at(-1).weapon === 'm4a1', 'a dead player leaves their M4A1 behind');
}

console.log(failures.length ? `\nweapons: ${failures.length} FAILED` : '\nweapons: all checks passed');
process.exit(failures.length ? 1 : 0);
