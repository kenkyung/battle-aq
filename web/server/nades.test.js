// Grenade rules on a fake clock: buying limits, throwing, HE damage (and
// walls stopping it), flash blinding by facing, smoke blocking bot vision.
let fake = 2_000_000;
Date.now = () => fake;
globalThis.setTimeout = () => 0;
const { Game } = await import('./game.js');
const { TEAM, ROUND } = await import('../shared/constants.js');
const { smokeBlocks } = await import('../shared/grenades.js');

const failures = [];
const ok = (c, l) => { if (c) console.log(`  ok   ${l}`); else { failures.push(l); console.log(`  FAIL ${l}`); } };
const sock = () => { const s = { readyState: 1, msgs: [], send: (m) => s.msgs.push(JSON.parse(m)) }; s.got = (t) => s.msgs.filter((m) => m.t === t); s.last = (t) => s.got(t).at(-1); return s; };
const advance = (g, sec) => { for (let i = 0; i < Math.ceil(sec * 30); i++) { fake += 1000 / 30; g.update(); } };

const g = new Game('de_aq_dust', { practice: true });
const w1 = sock(), w2 = sock();
const t = g.addPlayer(w1, 'Tom', { team: TEAM.T });
const c = g.addPlayer(w2, 'Cat', { team: TEAM.CT });
t.money = c.money = 16000;
for (let i = 0; i < 3; i++) g.onMessage(t, { t: 'buy', item: 'flashbang' });
ok(t.nades.flashbang === 2, 'at most two flashbangs');
g.onMessage(t, { t: 'buy', item: 'hegrenade' }); g.onMessage(t, { t: 'buy', item: 'hegrenade' });
ok(t.nades.hegrenade === 1, 'one HE grenade');
g.onMessage(t, { t: 'buy', item: 'smokegrenade' });
ok(w1.last('inv').inv.grenade && w1.last('inv').nades.smokegrenade === 1, 'inventory reports grenades');
advance(g, ROUND.freezeTime + 0.2);

console.log('HE');
// open ground in the middle of the map, two players 150 u apart
t.pos = [0, 0, -400]; t.yaw = 0; t.pitch = -0.6; c.pos = [0, 0, -560]; c.armor = 0;
g.onMessage(t, { t: 'weapon', id: 'hegrenade' });
advance(g, 0.5);
g.onMessage(t, { t: 'throw', vel: [0, 0, 0] });
ok(w2.got('nade').length === 1, 'everyone sees the throw');
ok(t.nades.hegrenade === 0 && t.weapon !== 'hegrenade', 'last grenade thrown -> back to the gun');
const hpBefore = c.hp;
advance(g, 1.7);
ok(w2.got('nade_boom').some((m) => m.kind === 'hegrenade'), 'HE goes off after its fuse');
ok(c.hp < hpBefore, `nearby enemy is hurt (${hpBefore} -> ${c.hp})`);

console.log('flash');
g.onMessage(t, { t: 'weapon', id: 'flashbang' }); advance(g, 0.5);
t.pos = [0, 0, -400]; t.yaw = 0; t.pitch = -0.6;   // flash lands just in front of the thrower
c.pos = [0, 0, -250]; c.yaw = Math.PI; c.pitch = 0; // CT behind the thrower, looking away (+z)
g.onMessage(t, { t: 'throw', vel: [0, 0, 0] });
advance(g, 1.7);
const fl = w2.last('flashed');
ok(fl && fl.amount > 0, 'CT near the flash is blinded');
g.onMessage(t, { t: 'weapon', id: 'flashbang' }); advance(g, 0.5);
t.pos = [0, 0, -400]; t.yaw = 0; t.pitch = -0.6;
c.yaw = 0; // now looking toward the flash (-z)
w2.msgs.length = 0;
g.onMessage(t, { t: 'throw', vel: [0, 0, 0] });
advance(g, 1.7);
const fl2 = w2.last('flashed');
ok(fl2 && fl2.amount > (fl ? fl.amount : 0), `facing the flash blinds more (${fl && fl.amount.toFixed(2)} -> ${fl2 && fl2.amount.toFixed(2)})`);

console.log('smoke');
g.onMessage(t, { t: 'weapon', id: 'smokegrenade' }); advance(g, 0.5);
g.onMessage(t, { t: 'throw', vel: [0, 0, 0] });
advance(g, 4);
ok(g.smokes.length === 1, 'smoke cloud is up');
const sp = g.smokes[0].pos;
ok(smokeBlocks([sp[0] - 400, sp[1], sp[2]], [sp[0] + 400, sp[1], sp[2]], g.smokes, fake / 1000), 'a line through the cloud is blocked');
ok(!smokeBlocks([sp[0] - 400, sp[1] + 400, sp[2]], [sp[0] + 400, sp[1] + 400, sp[2]], g.smokes, fake / 1000), 'a line above it is not');
advance(g, 20);
ok(g.smokes.length === 0, 'smoke clears after ~18 s');

console.log(failures.length ? `\nnades: ${failures.length} FAILED` : '\nnades: all checks passed');
process.exit(failures.length ? 1 : 0);
