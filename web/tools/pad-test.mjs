// Controller test: a fake Onikuma Iruka (Chrome on Windows sees an XInput
// "Xbox 360" pad whose printed A is the RIGHT face button) plays Battle-AQ
// against a local server with peaceful bots.
//
//   . ~/tools/pw/env.sh && node web/tools/pad-test.mjs [--headed]
// (render=0 skips the 3D draw so a busy machine still runs the game loop fast)
//
// Proves: menus (main, settings, buy, radio, pause, team) work with D-pad +
// A + B, the Iruka's A jumps and B crouches, ZR fires, the right stick turns
// the view, the left stick moves, − shows scores, hints show pad names, no
// pointer lock is needed, and the keyboard still works.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const HOME = process.env.HOME;
const { chromium } = require(path.join(HOME, 'tools/pw/node_modules/playwright-core'));
const { installFakePad, RAW, hold, release, stick, press: padPress } = await import(path.join(HOME, 'arcade/pad/test/fakepad.mjs'));

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8000 + Math.floor(Math.random() * 800) + 100;
const procs = [];
// the server's log goes to a temp file (printed path) for when a check fails
const LOG = path.join(os.tmpdir(), `baq-pad-test-${PORT}.log`);
const logFd = fs.openSync(LOG, 'w');
const run = (args, env = {}) => { const p = spawn('node', args, { cwd: WEB, env: { ...process.env, ...env }, stdio: ['ignore', logFd, logFd] }); procs.push(p); return p; };
const cleanup = () => { for (const p of procs) try { p.kill(); } catch { /* gone */ } };
process.on('exit', cleanup);

run(['server/index.js'], { PORT: String(PORT), HOST: '127.0.0.1', BOT_FILL: '0' });
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/info`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 250));
}
// one peaceful bot now; the test player fills the other team, which starts a
// fresh match with everybody spawned (joining a live round means waiting dead)
const bots = (n) => run(['tools/bots.mjs', '--url', `ws://127.0.0.1:${PORT}/ws`, '--count', String(n), '--peaceful', '1']);
bots(1);

const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await installFakePad(ctx);
await ctx.addInitScript(() => {
  // a controller press is not a user gesture, so Chrome refuses pointer lock:
  // play the way a pad player really starts, without it
  Element.prototype.requestPointerLock = function () { return Promise.reject(new DOMException('no gesture', 'NotAllowedError')); };
  try { localStorage.setItem('baq_osize', '0'); localStorage.setItem('baq_fs', '0'); localStorage.setItem('baq_mode', 'online'); } catch { /* */ }
});
const p = await ctx.newPage();
p.on('pageerror', (e) => { fails++; console.log('  [pageerror]', e.message); });
const q = (f, a) => p.evaluate(f, a);
const wait = (ms) => p.waitForTimeout(ms);
// headless swiftshader runs at a few fps: hold presses for 300+ ms
// (fakepad's press also waits until the page has polled the pad; both the game
// loop and CapyPad.nav poll, so ask for a few extra polls)
// D-pad taps stay short: CapyPad.nav auto-repeats a direction held for 380 ms
const press = (i, ms, after = 260) => padPress(p, i, ms ?? (i >= 12 && i <= 15 ? 120 : 340), after, 8);
const focused = () => q(() => { const e = document.querySelector('.cp-focus'); return e ? (e.id || e.dataset.item || e.dataset.i || e.tagName.toLowerCase() + '.' + e.className.replace(/\s*cp-focus/, '')) : null; });
const focusEl = (sel) => q((s) => { const e = document.querySelector('.cp-focus'); return !!(e && e.matches(s)); }, sel);
async function navTo(sel, dir, max = 30) {
  for (let i = 0; i < max; i++) { if (await focusEl(sel)) return true; await press(dir, 120, 200); }
  return focusEl(sel);
}

try {
  await p.goto(`http://127.0.0.1:${PORT}/?quality=lowest&render=0&name=PadTest&map=de_aq_dust`);
  await p.waitForSelector('#menu:not(.hidden)', { timeout: 120000 });
  await wait(800);

  console.log('menus');
  ok(await q(() => window.CapyPad && window.CapyPad.layout() === 'nintendo' && window.CapyPad.label(0) === 'A'), 'Iruka gets the nintendo layout (A on the right)');
  await press(RAW.DOWN);
  ok(!!(await focused()), `D-pad highlights a main-menu control (${await focused()})`);
  ok(await p.waitForFunction(() => document.body.classList.contains('pad'), null, { timeout: 5000 }).then(() => true, () => false), 'pad mode switches the hints to controller names');
  ok(/R-stick|right stick/.test(await q(() => document.querySelector('#menuCard .controls.padhint').textContent)), 'main menu lists the controller map');
  // settings: open it, nudge the controller look speed, fold it with B
  ok(await navTo('#settings > summary', RAW.DOWN), 'D-pad reaches Settings');
  await press(RAW.A);
  ok(await q(() => document.getElementById('settings').open), 'A opens Settings');
  ok(await navTo('#padSens', RAW.DOWN), 'D-pad reaches the controller look speed slider');
  const s0 = await q(() => +document.getElementById('padSens').value);
  await press(RAW.RIGHT);
  const s1 = await q(() => +document.getElementById('padSens').value);
  ok(s1 > s0 && (await q(() => window.__pad.sens)) === s1, `▶ raises controller look speed (${s0} -> ${s1})`);
  await press(RAW.LEFT);
  await press(RAW.B);
  ok(await q(() => !document.getElementById('settings').open), 'B folds Settings back up');
  ok(await navTo('#playBtn', RAW.UP), `D-pad reaches PLAY (${await focused()})`);
  await press(RAW.A, 340, 400);
  await p.waitForFunction(() => window.__baq && window.__baq.player && !document.getElementById('hud').classList.contains('hidden'), null, { timeout: 60000 });
  ok(true, 'A on PLAY joins the server');
  bots(1);
  const ready = await p.waitForFunction(() => window.__baq.player.alive && !['freeze', 'matchend'].includes(window.__baq.round.phase), null, { timeout: 60000 }).then(() => true, () => false);
  if (!ready) console.log('  state:', JSON.stringify(await q(() => ({ alive: window.__baq.player.alive, phase: window.__baq.round.phase, pause: !document.getElementById('pause').classList.contains('hidden'), root: window.__pad.h.menuRoot()?.id, players: window.__baq.roster.size }))));
  await wait(1500);
  ok(await q(() => !document.pointerLockElement), 'playing without pointer lock');
  ok(await q(() => document.getElementById('hint').textContent !== 'click to play'), 'no "click to play" while the pad drives');

  console.log('gameplay');
  // A jumps (the button PRINTED A: raw index 1 on the Iruka)
  const y0 = await q(() => window.__baq.player.state.pos[1]);
  await hold(p, RAW.A);
  let y1 = y0;
  for (let i = 0; i < 8; i++) { await wait(60); y1 = Math.max(y1, await q(() => window.__baq.player.state.pos[1])); }
  await release(p, RAW.A);
  ok(y1 > y0 + 4, `Iruka A jumps (y ${y0.toFixed(1)} -> peak ${y1.toFixed(1)})`);
  await wait(1200);
  // B crouches while held
  await hold(p, RAW.B); await wait(700);
  const crouched = await q(() => window.__baq.player.state.crouching);
  await release(p, RAW.B); await wait(900);
  const stood = await q(() => !window.__baq.player.state.crouching);
  ok(crouched && stood, `Iruka B crouches while held (crouched ${crouched}, stands after ${stood})`);
  // ZR fires
  const sh0 = await q(() => window.__baq.player.shotCount);
  await press(RAW.ZR, 400, 500);
  const sh1 = await q(() => window.__baq.player.shotCount);
  ok(sh1 > sh0, `ZR fires (shots ${sh0} -> ${sh1})`);
  // right stick turns the view
  const yaw0 = await q(() => window.__baq.player.state.yaw);
  await stick(p, 2, 1); await wait(700); await stick(p, 2, 0); await wait(200);
  const yaw1 = await q(() => window.__baq.player.state.yaw);
  ok(yaw1 < yaw0 - 0.15, `right stick → turns right (yaw ${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)})`);
  const pit0 = await q(() => window.__baq.player.state.pitch);
  await stick(p, 3, -1); await wait(500); await stick(p, 3, 0); await wait(200);
  const pit1 = await q(() => window.__baq.player.state.pitch);
  ok(pit1 > pit0 + 0.05, `right stick ↑ looks up (pitch ${pit0.toFixed(2)} -> ${pit1.toFixed(2)})`);
  // inside the deadzone: no drift
  const yaw2 = await q(() => window.__baq.player.state.yaw);
  await stick(p, 2, 0.08); await wait(500); await stick(p, 2, 0); await wait(150);
  ok(Math.abs((await q(() => window.__baq.player.state.yaw)) - yaw2) < 1e-6, 'small stick noise inside the deadzone does not turn');
  // left stick moves
  const pos0 = await q(() => window.__baq.player.state.pos.slice());
  await stick(p, 1, -1); await wait(900); await stick(p, 1, 0); await wait(300);
  const pos1 = await q(() => window.__baq.player.state.pos.slice());
  ok(Math.hypot(pos1[0] - pos0[0], pos1[2] - pos0[2]) > 20, `left stick moves (${Math.hypot(pos1[0] - pos0[0], pos1[2] - pos0[2]).toFixed(0)} u)`);
  // − holds the scoreboard
  await hold(p, RAW.MINUS); await wait(500);
  ok(await q(() => !document.getElementById('scoreboard').classList.contains('hidden')), '− shows the scoreboard while held');
  await release(p, RAW.MINUS); await wait(500);
  ok(await q(() => document.getElementById('scoreboard').classList.contains('hidden')), 'releasing − hides it');
  // Y: next weapon
  const w0 = await q(() => window.__baq.player.weapon);
  await press(RAW.Y, 300, 600);
  const w1 = await q(() => window.__baq.player.weapon);
  ok(w0 !== w1, `Y switches weapon (${w0} -> ${w1})`);
  await press(RAW.LEFT, 120, 600);                      // ◀ = pistol slot
  ok((await q(() => window.__baq.player.weapon)) === 'glock' || (await q(() => window.__baq.player.weapon)) === 'usp', `◀ picks the pistol (${await q(() => window.__baq.player.weapon)})`);

  console.log('buy menu');
  await press(RAW.DOWN, 120, 500);                       // ▼ = buy
  ok(await q(() => !document.getElementById('buymenu').classList.contains('hidden')), '▼ opens the buy menu');
  ok(await q(() => !!document.querySelector('#buymenu .cp-focus')), 'buy menu has a controller highlight straight away');
  ok(/A buy · B close/.test(await q(() => document.querySelector('#buymenu .close.padhint').textContent)), 'buy menu hint shows Iruka names');
  const money0 = await q(() => window.__baq.player.money);
  // walk the grid to something we can afford and do not own
  let target = null;
  for (let i = 0; i < 24 && !target; i++) {
    target = await q(() => { const e = document.querySelector('#buymenu .cp-focus'); return e && e.classList.contains('bitem') && !e.classList.contains('no') && !e.classList.contains('own') && !/^ammo/.test(e.dataset.item) ? e.dataset.item : null; });
    if (!target) await press(i % 6 === 5 ? RAW.RIGHT : RAW.DOWN, 120, 200);
  }
  ok(!!target, `D-pad walks the buy grid to an item (${target})`);
  await press(RAW.A, 340, 900);
  const money1 = await q(() => window.__baq.player.money);
  ok(money1 < money0, `A buys it ($${money0} -> $${money1})`);
  await press(RAW.B, 340, 500);
  ok(await q(() => document.getElementById('buymenu').classList.contains('hidden')), 'B closes the buy menu');
  ok(await q(() => !window.__baq.player.state.crouching), 'the B that closed the menu does not crouch afterwards');

  console.log('radio');
  await press(RAW.R3, 340, 400);
  ok(await q(() => !document.getElementById('radioMenu').classList.contains('hidden')), 'R3 opens the radio menu');
  await press(RAW.R3, 340, 400);
  ok(/GROUP/.test(await q(() => document.querySelector('#radioMenu h5').textContent)), 'R3 again flips to the next radio menu');
  const chat0 = await q(() => document.getElementById('chatlog').textContent);
  await press(RAW.A, 340, 900);
  ok(await q(() => document.getElementById('radioMenu').classList.contains('hidden')), 'A sends the highlighted radio command and closes the menu');
  ok((await q(() => document.getElementById('chatlog').textContent)) !== chat0, 'the radio message arrives in the chat log');
  await press(RAW.R3, 340, 300); await press(RAW.B, 340, 300);
  ok(await q(() => document.getElementById('radioMenu').classList.contains('hidden')), 'B closes the radio menu');

  console.log('pause + team');
  await press(RAW.PLUS, 340, 500);
  ok(await q(() => !document.getElementById('pause').classList.contains('hidden')), '+ opens the pause menu');
  ok(await q(() => !document.getElementById('pause').classList.contains('hidden')), 'the + that opened it does not close it again');
  ok(await navTo('#teamBtn', RAW.DOWN, 10), 'D-pad reaches CHOOSE TEAM');
  await press(RAW.A, 340, 500);
  ok(await q(() => !document.getElementById('teammenu').classList.contains('hidden')), 'A opens the team menu');
  ok(await q(() => !!document.querySelector('#teammenu .cp-focus')), 'team menu is highlighted');
  await press(RAW.B, 340, 500);
  ok(await q(() => document.getElementById('teammenu').classList.contains('hidden')), 'B leaves the team menu');
  await press(RAW.PLUS, 340, 500);
  await press(RAW.B, 340, 500);
  ok(await q(() => document.getElementById('pause').classList.contains('hidden')), 'B resumes from the pause menu');
  await press(RAW.PLUS, 340, 500);
  await press(RAW.PLUS, 340, 500);
  ok(await q(() => document.getElementById('pause').classList.contains('hidden')), '+ toggles the pause menu off again');

  console.log('keyboard still works');
  await p.keyboard.down('KeyC'); await wait(600);
  const kc = await q(() => window.__baq.player.state.crouching);
  await p.keyboard.up('KeyC'); await wait(700);
  ok(kc && await q(() => !window.__baq.player.state.crouching), 'C crouches');
  ok(await q(() => !document.body.classList.contains('pad')), 'a key press switches hints back to the keyboard');
  await p.keyboard.press('KeyB'); await wait(500);
  ok(await q(() => !document.getElementById('buymenu').classList.contains('hidden')), 'B key opens the buy menu');
  await p.keyboard.press('Escape'); await wait(500);
  ok(await q(() => document.getElementById('buymenu').classList.contains('hidden') && document.getElementById('pause').classList.contains('hidden')), 'Esc closes it without pausing');
} catch (e) {
  fails++;
  console.log('  ✗ test aborted:', e.message);
}
await browser.close();
cleanup();
if (fails) console.log(`server log: ${LOG}`);
console.log(fails ? `\n${fails} FAILED` : '\nall controller checks passed');
process.exit(fails ? 1 : 0);
