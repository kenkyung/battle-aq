// CS 1.6 weapon model checks: damage by hit group, armour ratios, range
// falloff, spray pattern (KickBack) and spread growth.   node server/ballistics.test.js
import { WEAPONS } from '../shared/constants.js';
import { newRecoil, resetRecoil, shotSpread, kick, baseDamage, armorAbsorb, decayPunch } from '../shared/ballistics.js';
import { raycastPlayers, hitBox } from '../shared/physics.js';

const failures = [];
const ok = (c, l) => { if (c) console.log(`  ok   ${l}`); else { failures.push(l); console.log(`  FAIL ${l}`); } };
const near = (a, b, e = 0.6) => Math.abs(a - b) <= e;

console.log('damage');
ok(near(baseDamage('ak47', 'head', 0), 144), 'AK head at point blank: 36 x 4 = 144');
ok(near(baseDamage('ak47', 'stomach', 0), 45), 'AK stomach: 36 x 1.25');
ok(near(baseDamage('ak47', 'legs', 0), 27), 'AK legs: 36 x 0.75');
ok(near(baseDamage('ak47', 'chest', 1000), 36 * 0.98 ** 2), 'AK loses 2 % per 500 u');
ok(near(baseDamage('glock', 'chest', 1000), 25 * 0.75 ** 2), 'Glock falls off fast (0.75 per 500 u)');
const akArmor = armorAbsorb(36, 'chest', 100, false, WEAPONS.ak47.armorRatio);
ok(akArmor.hpDmg === Math.round(36 * 0.775) && akArmor.armorDmg > 0, `kevlar vs AK: ${akArmor.hpDmg} HP (armour ratio 1.55 lets 77.5 % through)`);
const uspArmor = armorAbsorb(34, 'chest', 100, false, WEAPONS.usp.armorRatio);
ok(uspArmor.hpDmg === 17, 'kevlar vs USP: half the damage');
ok(armorAbsorb(144, 'head', 100, false, 1.55).hpDmg === 144, 'no helmet: head shots ignore the vest');
ok(armorAbsorb(144, 'head', 100, true, 1.55).hpDmg < 144, 'helmet reduces head shots');
ok(armorAbsorb(27, 'legs', 100, true, 1.55).hpDmg === 27, 'armour never covers legs');
ok(baseDamage('awp', 'chest', 0) >= 100, 'AWP body shot kills an unarmoured player');
ok(baseDamage('deagle', 'head', 0) >= 200, 'Deagle headshot kills through a helmet too');

console.log('hit boxes');
const target = [{ id: 1, box: hitBox([0, 0, -200], false) }];
const shoot = (y, x = 0) => raycastPlayers([x, y, 0], [0, 0, -1], target, 1000, 0);
ok(shoot(68).part === 'head', 'aim at 68 u: head');
ok(shoot(50).part === 'chest', 'aim at 50 u: chest');
ok(shoot(38).part === 'stomach', 'aim at 38 u: stomach');
ok(shoot(20).part === 'legs', 'aim at 20 u: legs');
ok(shoot(68, 13) === null, 'beside the head (13 u off-centre) misses: the head is narrower than the body');

console.log('spray');
const r = newRecoil(); resetRecoil(r, 'ak47');
const ctx = { now: 0, onGround: true, speed: 0, ducking: false };
let t = 0; const spreads = [];
for (let i = 0; i < 30; i++) { t += WEAPONS.ak47.rof; spreads.push(shotSpread(r, 'ak47', { ...ctx, now: t })); kick(r, 'ak47', ctx, () => 0.5); decayPunch(r, WEAPONS.ak47.rof); }
ok(near(spreads[0], 0.0275 * (1 / 200 + 0.35), 0.001), 'first AK bullet: spread 0.0275 x accuracy');
ok(spreads[29] > spreads[0] * 3, `spread grows through the magazine (${spreads[0].toFixed(4)} -> ${spreads[29].toFixed(4)})`);
ok(r.punch[0] > 4.2 && r.punch[0] <= 5.75, `AK climbs to its 5.75° cap standing (${r.punch[0].toFixed(2)}° after this frame's decay)`);
ok(Math.abs(r.punch[1]) > 0.5, 'and drifts sideways');
const r2 = newRecoil(); resetRecoil(r2, 'ak47');
const s1 = shotSpread(r2, 'ak47', { ...ctx, now: 10 });
shotSpread(r2, 'ak47', { ...ctx, now: 10.1 });
const s3 = shotSpread(r2, 'ak47', { ...ctx, now: 11.0 });
ok(near(s3, s1, 0.0005), 'tapping (a pause between shots) resets accuracy');
const rm = newRecoil(); resetRecoil(rm, 'ak47');
ok(shotSpread(rm, 'ak47', { ...ctx, now: 5, speed: 250 }) > 0.04, 'running and gunning: 0.04 + 0.07 x accuracy');
const ra = newRecoil();
ok(shotSpread(ra, 'awp', { ...ctx, now: 5, zoomed: false }) > 0.07, 'AWP no-scope is wildly inaccurate');
const rz = newRecoil();
ok(shotSpread(rz, 'awp', { ...ctx, now: 5, zoomed: true }) < 0.002, 'AWP scoped and still: pinpoint');
const rp = newRecoil(); resetRecoil(rp, 'deagle');
const d1 = shotSpread(rp, 'deagle', { ...ctx, now: 1 });
const d2 = shotSpread(rp, 'deagle', { ...ctx, now: 1.23 });
ok(d2 > d1, 'Deagle: fast follow-up shots are less accurate');

console.log('new guns');
ok(WEAPONS.ump45 && WEAPONS.ump45.mag === 25 && WEAPONS.ump45.price === 1700, 'UMP45: 25 rounds, $1700');
ok(WEAPONS.m249 && WEAPONS.m249.mag === 100 && WEAPONS.m249.price === 5750 && WEAPONS.m249.speed === 220, 'M249 Para: 100 rounds, $5750, slow to carry');

console.log(failures.length ? `\nballistics: ${failures.length} FAILED` : '\nballistics: all checks passed');
process.exit(failures.length ? 1 : 0);
