// DOM HUD. Pure view layer — main.js feeds it state; it owns no game logic
// beyond formatting. Includes the radar, buy menu and scoreboard.

import { WEAPONS, TEAM, SLOTS } from '../shared/constants.js';
import { BUY_MENU, itemInfo, buyZoneCenter, ECONOMY } from '../shared/economy.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const teamCls = (t) => (t === TEAM.CT ? 'ct' : 't');

export class HUD {
  constructor() {
    this.root = $('hud');
    this.crosshair = $('crosshair');
    this.el = {};
    for (const id of ['hp', 'armor', 'helmet', 'moneyVal', 'moneyDelta', 'buyzone', 'weaponName', 'mag', 'reserve',
      'reloadBar', 'timer', 'roundPhase', 'scoreT', 'scoreCT', 'aliveT', 'aliveCT', 'killfeed', 'chatlog', 'hint',
      'banner', 'center-msg', 'spectate', 'slots', 'hitmarker', 'dmgdir', 'flash', 'scope', 'radar',
      'buymenu', 'buyCols', 'buyMoney', 'buyTimer', 'buyStatus', 'scoreboard', 'sbT', 'sbCT', 'sbTbody', 'sbCTbody']) {
      this.el[id] = $(id);
    }
    this.cache = {};
    this.radarCtx = this.el.radar.getContext('2d');
    this.radarBg = null;
    this._slotTimer = 0;
  }

  show() { this.root.classList.remove('hidden'); this.crosshair.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); this.crosshair.classList.add('hidden'); this.el.scope.classList.add('hidden'); }

  set(key, value, fn) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    fn(value);
  }

  // ------------------------------------------------------------ vitals / ammo

  setVitals(hp, armor, helmet) {
    this.set('hp', Math.max(0, Math.round(hp)), (v) => {
      this.el.hp.textContent = v;
      this.el.hp.parentElement.classList.toggle('low', v <= 25);
    });
    this.set('armor', Math.round(armor), (v) => { this.el.armor.textContent = v; });
    this.set('helmet', !!helmet, (v) => this.el.helmet.classList.toggle('hidden', !v));
  }

  setMoney(m, canBuy) {
    this.set('money', m, (v) => { this.el.moneyVal.textContent = v; this.el.buyMoney.textContent = '$' + v; });
    this.set('buyzone', !!canBuy, (v) => this.el.buyzone.classList.toggle('hidden', !v));
  }

  moneyDelta(d, reason) {
    const el = this.el.moneyDelta;
    el.textContent = (d > 0 ? '+$' : '-$') + Math.abs(d) + (reason && d > 0 ? '  ' + reason : '');
    el.classList.toggle('neg', d < 0);
    el.classList.add('show');
    clearTimeout(this._mdT);
    this._mdT = setTimeout(() => el.classList.remove('show'), 1800);
  }

  setWeapon(id, mag, reserve, reloadFrac) {
    const w = WEAPONS[id];
    this.set('wname', id, () => { this.el.weaponName.textContent = w.name; });
    const melee = !!w.melee;
    this.set('mag', melee ? '—' : mag, (v) => {
      this.el.mag.textContent = v;
      this.el.mag.classList.toggle('low', !melee && mag <= Math.ceil(w.mag * 0.2));
    });
    this.set('res', melee ? '' : reserve, (v) => { this.el.reserve.textContent = v; });
    this.set('rl', reloadFrac < 0 ? -1 : Math.round(reloadFrac * 50), (v) => {
      this.el.reloadBar.style.visibility = v < 0 ? 'hidden' : 'visible';
      if (v >= 0) this.el.reloadBar.firstElementChild.style.width = (v * 2) + '%';
    });
  }

  showSlots(inv, current) {
    this.el.slots.innerHTML = SLOTS.map((s, i) => inv[s]
      ? `<div class="${inv[s] === current ? 'on' : ''}"><b>${i + 1}</b>${esc(WEAPONS[inv[s]].name)}</div>` : '').join('');
    this.el.slots.classList.add('show');
    clearTimeout(this._slotT);
    this._slotT = setTimeout(() => this.el.slots.classList.remove('show'), 1400);
  }

  setCrosshair(gapPx, visible) {
    this.set('chgap', Math.round(gapPx), (v) => this.crosshair.style.setProperty('--gap', v + 'px'));
    this.set('chvis', visible, (v) => this.crosshair.style.visibility = v ? 'visible' : 'hidden');
  }

  setScope(on) { this.set('scope', on, (v) => this.el.scope.classList.toggle('hidden', !v)); }

  hitMarker(head) {
    const h = this.el.hitmarker;
    h.classList.toggle('head', !!head);
    h.classList.add('on');
    clearTimeout(this._hmT);
    this._hmT = setTimeout(() => h.classList.remove('on'), 90);
  }

  damageFrom(angle) {
    const i = document.createElement('i');
    i.style.transform = `rotate(${angle}rad)`;
    this.el.dmgdir.appendChild(i);
    setTimeout(() => { i.style.opacity = '0'; }, 400);
    setTimeout(() => i.remove(), 1100);
    this.el.flash.style.background = 'rgba(190,20,10,.28)';
    clearTimeout(this._flT);
    this._flT = setTimeout(() => { this.el.flash.style.background = 'rgba(190,20,10,0)'; }, 120);
  }

  // ------------------------------------------------------------ round

  setTimer(seconds, phase) {
    const warm = phase === 'warmup';
    const s = Math.max(0, Math.ceil(seconds));
    const txt = warm ? '—:—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    this.set('timer', txt, (v) => { this.el.timer.textContent = v; });
    this.set('timerlow', !warm && phase === 'round' && s <= 10, (v) => this.el.timer.classList.toggle('low', v));
  }

  setPhase(phase, round) {
    const label = { warmup: 'WARMUP', buy: 'BUY TIME', round: 'ROUND ' + round, end: 'ROUND OVER' }[phase] || phase;
    this.set('phase', label, (v) => { this.el.roundPhase.textContent = v; });
  }

  setScore(t, ct) {
    this.el.scoreT.textContent = t; this.el.scoreCT.textContent = ct;
    this.el.sbT.textContent = t; this.el.sbCT.textContent = ct;
  }

  setAlive(tAlive, tTotal, ctAlive, ctTotal) {
    const pips = (a, n) => Array.from({ length: n }, (_, i) => `<i class="${i < a ? '' : 'dead'}"></i>`).join('');
    this.set('aliveT', `${tAlive}/${tTotal}`, () => { this.el.aliveT.innerHTML = pips(tAlive, tTotal); });
    this.set('aliveCT', `${ctAlive}/${ctTotal}`, () => { this.el.aliveCT.innerHTML = pips(ctAlive, ctTotal); });
  }

  banner(text, team, ms = 4000) {
    const b = this.el.banner;
    b.textContent = text;
    b.className = team ? teamCls(team) : '';
    clearTimeout(this._bnT);
    this._bnT = setTimeout(() => b.classList.add('hidden'), ms);
  }

  centerMsg(text) { this.set('cmsg', text, (v) => { this.el['center-msg'].textContent = v; }); }
  setHint(text) { this.set('hint', text, (v) => { this.el.hint.textContent = v; }); }

  setSpectate(text) {
    this.set('spec', text, (v) => {
      this.el.spectate.textContent = v;
      this.el.spectate.classList.toggle('hidden', !v);
    });
  }

  addKill(killer, victim, weapon, headshot, involvesMe) {
    const div = document.createElement('div');
    div.className = 'kf' + (involvesMe ? ' me' : '');
    div.innerHTML = `<span class="${teamCls(killer.team)}">${esc(killer.name)}</span>`
      + `<span class="w">${esc(WEAPONS[weapon] ? WEAPONS[weapon].name : weapon)}</span>`
      + (headshot ? '<span class="hs">HS</span>' : '')
      + `<span class="${teamCls(victim.team)}">${esc(victim.name)}</span>`;
    this.el.killfeed.prepend(div);
    while (this.el.killfeed.children.length > 6) this.el.killfeed.lastChild.remove();
    setTimeout(() => { div.style.opacity = '0'; setTimeout(() => div.remove(), 400); }, 7000);
  }

  addChat(name, team, text) {
    const div = document.createElement('div');
    div.className = 'chat';
    div.innerHTML = `<span class="n ${teamCls(team)}">${esc(name)}:</span> ${esc(text)}`;
    this.el.chatlog.appendChild(div);
    while (this.el.chatlog.children.length > 7) this.el.chatlog.firstChild.remove();
    setTimeout(() => div.remove(), 12000);
  }

  // ------------------------------------------------------------ radar

  setRadarMap(map, colliders) {
    const b = map.bounds;
    const size = 400;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const span = Math.max(b.x1 - b.x0, b.z1 - b.z0);
    const s = size / span;
    ctx.fillStyle = 'rgba(40,44,48,0.7)';
    ctx.fillRect(0, 0, size, size);
    const sorted = [...colliders].sort((a, c2) => a.max[1] - c2.max[1]);
    for (const col of sorted) {
      if (col.min[1] < -1) continue; // floor slab
      const h = col.max[1];
      const shade = Math.min(230, 110 + h * 0.5);
      ctx.fillStyle = `rgb(${shade},${shade * 0.95},${shade * 0.86})`;
      ctx.fillRect((col.min[0] - b.x0) * s, (col.min[2] - b.z0) * s, (col.max[0] - col.min[0]) * s, (col.max[2] - col.min[2]) * s);
    }
    for (const [label, pos] of Object.entries(map.bombsites || {})) {
      ctx.fillStyle = 'rgba(200,50,40,0.9)';
      ctx.font = 'bold 28px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, (pos[0] - b.x0) * s, (pos[2] - b.z0) * s);
    }
    for (const team of [TEAM.T, TEAM.CT]) {
      const [x, z] = buyZoneCenter(map, team);
      ctx.strokeStyle = team === TEAM.T ? 'rgba(224,178,92,.6)' : 'rgba(127,178,232,.6)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc((x - b.x0) * s, (z - b.z0) * s, ECONOMY.buyZoneRadius * s, 0, Math.PI * 2); ctx.stroke();
    }
    this.radarBg = { canvas: c, b, s };
  }

  drawRadar(me, yaw, mates) {
    if (!this.radarBg) return;
    const ctx = this.radarCtx;
    const W = this.el.radar.width;
    const { canvas, b, s } = this.radarBg;
    const zoom = 2.2;  // radar px per background px
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath(); ctx.arc(W / 2, W / 2, W / 2, 0, Math.PI * 2); ctx.clip();
    ctx.translate(W / 2, W / 2);
    ctx.rotate(yaw);
    ctx.scale(zoom * W / 400, zoom * W / 400);
    ctx.translate(-(me[0] - b.x0) * s, -(me[2] - b.z0) * s);
    ctx.drawImage(canvas, 0, 0);
    for (const m of mates) {
      ctx.fillStyle = m.team === TEAM.CT ? '#7fb2e8' : '#e0b25c';
      ctx.beginPath(); ctx.arc((m.pos[0] - b.x0) * s, (m.pos[2] - b.z0) * s, 5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // me: arrow at centre, pointing up
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(W / 2, W / 2 - 8); ctx.lineTo(W / 2 + 5, W / 2 + 6); ctx.lineTo(W / 2 - 5, W / 2 + 6); ctx.closePath(); ctx.fill();
  }

  // ------------------------------------------------------------ buy menu

  buyOpen() { return !this.el.buymenu.classList.contains('hidden'); }

  openBuy(ctx, onBuy) {
    this.el.buymenu.classList.remove('hidden');
    this.el.buyStatus.textContent = '';
    this._onBuy = onBuy;
    this.refreshBuy(ctx);
  }

  closeBuy() { this.el.buymenu.classList.add('hidden'); }

  refreshBuy({ money, team, inv, armor, helmet, buyLeft }) {
    this.el.buyMoney.textContent = '$' + money;
    this.el.buyTimer.textContent = buyLeft < 0 ? 'warmup: buy anywhere' : `${Math.ceil(buyLeft)}s left to buy`;
    this.el.buyCols.innerHTML = BUY_MENU.map((cat) => `<div class="bcol"><h4>${cat.title}</h4>${cat.items.map((id) => {
      const it = itemInfo(id);
      if (it.team && it.team !== team) return '';
      let price = it.price;
      if (id === 'assault' && armor >= 100 && !helmet) price = 350;
      const own = it.weapon ? Object.values(inv).includes(id) : (id === 'kevlar' ? armor >= 100 : id === 'assault' ? armor >= 100 && helmet : false);
      const cls = ['bitem', money < price ? 'no' : '', own ? 'own' : ''].join(' ');
      return `<button class="${cls}" data-item="${id}">${esc(it.name)}<span class="p">$${price}</span></button>`;
    }).join('')}</div>`).join('');
    for (const btn of this.el.buyCols.querySelectorAll('.bitem')) {
      btn.onclick = () => this._onBuy && this._onBuy(btn.dataset.item);
    }
  }

  buyFail(reason) { this.el.buyStatus.textContent = reason; }

  // ------------------------------------------------------------ scoreboard

  showScores(on, rows, myId) {
    this.el.scoreboard.classList.toggle('hidden', !on);
    if (!on) return;
    const render = (team) => {
      const list = rows.filter((r) => r.team === team).sort((a, b) => b.k - a.k || a.d - b.d);
      return '<tr class="head"><td class="n">PLAYER</td><td class="k">K</td><td class="d">D</td></tr>'
        + list.map((r) => `<tr class="${r.alive ? '' : 'dead'} ${r.id === myId ? 'me' : ''}"><td class="n">${esc(r.name)}</td><td class="k">${r.k}</td><td class="d">${r.d}</td></tr>`).join('');
    };
    this.el.sbTbody.innerHTML = render(TEAM.T);
    this.el.sbCTbody.innerHTML = render(TEAM.CT);
  }
}
