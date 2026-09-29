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
    const melee = !!w.melee || !!w.bomb;
    this.set('mag', melee ? '—' : mag, (v) => {
      this.el.mag.textContent = v;
      this.el.mag.classList.toggle('low', !melee && mag <= Math.ceil(w.mag * 0.2));
    });
    this.set('res', melee || w.grenade ? '' : reserve, (v) => { this.el.reserve.textContent = v; });
    this.set('rl', reloadFrac < 0 ? -1 : Math.round(reloadFrac * 50), (v) => {
      this.el.reloadBar.style.visibility = v < 0 ? 'hidden' : 'visible';
      if (v >= 0) this.el.reloadBar.firstElementChild.style.width = (v * 2) + '%';
    });
  }

  showSlots(inv, current) {
    this.el.slots.innerHTML = SLOTS.map((s, i) => s && inv[s]
      ? `<div class="${inv[s] === current ? 'on' : ''}"><b>${i + 1}</b>${esc(WEAPONS[inv[s]].name)}</div>` : '').join('');
    this.el.slots.classList.add('show');
    clearTimeout(this._slotT);
    this._slotT = setTimeout(() => this.el.slots.classList.remove('show'), 1400);
  }

  setCrosshair(gapPx, lenPx, visible) {
    this.set('chgap', Math.round(gapPx), (v) => this.crosshair.style.setProperty('--gap', v + 'px'));
    this.set('chlen', Math.round(lenPx), (v) => this.crosshair.style.setProperty('--len', v + 'px'));
    this.set('chvis', visible, (v) => this.crosshair.style.visibility = v ? 'visible' : 'hidden');
  }

  progress(label, seconds) {
    const el = document.getElementById('progress');
    document.getElementById('progressLabel').textContent = label;
    const fill = document.getElementById('progressFill');
    fill.style.transition = 'none';
    fill.style.width = '0%';
    el.classList.remove('hidden');
    void fill.offsetWidth;
    fill.style.transition = `width ${seconds}s linear`;
    fill.style.width = '100%';
  }

  hideProgress() { document.getElementById('progress').classList.add('hidden'); }

  // C4 status: 'carry' (you have it), 'planted' (with blink), or null
  setBomb(state, text = '', blink = false) {
    const el = document.getElementById('bombIcon');
    this.set('bomb', state + '|' + text + '|' + blink, () => {
      el.classList.toggle('hidden', !state);
      el.classList.toggle('planted', state === 'planted');
      el.classList.toggle('blink', !!blink);
      document.getElementById('bombText').textContent = text;
    });
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
    this.set('timerlow', !warm && (phase === 'round' && s <= 10 || phase === 'planted'), (v) => this.el.timer.classList.toggle('low', v));
  }

  setPhase(phase, round) {
    const label = {
      warmup: 'WARMUP', freeze: 'ROUND ' + round + ' · BUY', round: 'ROUND ' + round, planted: 'BOMB PLANTED',
      end: 'ROUND OVER', matchend: 'MATCH OVER',
    }[phase] || phase;
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

  drawRadar(me, yaw, mates, bomb) {
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
      if (m.c4) { ctx.strokeStyle = '#ff5a45'; ctx.lineWidth = 3; ctx.stroke(); }
    }
    if (bomb && bomb.pos) {
      const x = (bomb.pos[0] - b.x0) * s, y = (bomb.pos[2] - b.z0) * s;
      ctx.fillStyle = bomb.state === 'planted' ? '#ff4030' : '#ffb020';
      ctx.fillRect(x - 7, y - 5, 14, 10);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.strokeRect(x - 7, y - 5, 14, 10);
    }
    ctx.restore();
    // me: arrow at centre, pointing up
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(W / 2, W / 2 - 8); ctx.lineTo(W / 2 + 5, W / 2 + 6); ctx.lineTo(W / 2 - 5, W / 2 + 6); ctx.closePath(); ctx.fill();
  }

  // ------------------------------------------------------------ buy menu

  buyOpen() { return !this.el.buymenu.classList.contains('hidden'); }

  // CS-style keys: a number picks a category, then a number buys from it
  buyKey(n) {
    const cats = this._buyCats || [];
    if (this._buyCat === null || this._buyCat === undefined) {
      if (cats[n - 1]) { this._buyCat = n - 1; this.highlightBuy(); }
      return;
    }
    const items = cats[this._buyCat] || [];
    if (items[n - 1] && this._onBuy) this._onBuy(items[n - 1]);
    this._buyCat = null;
    this.highlightBuy();
  }

  highlightBuy() {
    const cols = this.el.buyCols.querySelectorAll('.bcol');
    cols.forEach((c, i) => c.classList.toggle('pick', i === this._buyCat));
  }

  openBuy(ctx, onBuy) {
    this._buyCat = null;
    this.el.buymenu.classList.remove('hidden');
    this.el.buyStatus.textContent = '';
    this._onBuy = onBuy;
    this.refreshBuy(ctx);
  }

  closeBuy() { this.el.buymenu.classList.add('hidden'); this._buyCat = null; if (this._input) this._input.buyOpen = false; }

  refreshBuy({ money, team, inv, armor, helmet, kit, buyLeft }) {
    this.el.buyMoney.textContent = '$' + money;
    this.el.buyTimer.textContent = buyLeft < 0 ? 'warmup: buy anywhere' : `${Math.ceil(buyLeft)}s left to buy`;
    this._buyCats = BUY_MENU.map((cat) => cat.items.filter((id) => { const it = itemInfo(id); return !it.team || it.team === team; }));
    this.el.buyCols.innerHTML = BUY_MENU.map((cat, ci) => `<div class="bcol"><h4><b>${ci + 1}</b> ${cat.title}</h4>${this._buyCats[ci].map((id, ii) => {
      const it = itemInfo(id);
      let price = it.price;
      if (id === 'assault' && armor >= 100 && !helmet) price = 350;
      const own = it.weapon ? Object.values(inv).includes(id)
        : (id === 'kevlar' ? armor >= 100 : id === 'assault' ? armor >= 100 && helmet : id === 'kit' ? !!kit : false);
      const cls = ['bitem', money < price ? 'no' : '', own ? 'own' : ''].join(' ');
      return `<button class="${cls}" data-item="${id}"><i class="k">${ii + 1}</i>${esc(it.name)}<span class="p">$${price}</span></button>`;
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

  // ------------------------------------------------------------ match end + vote

  showMatchEnd(msg, myId, onVote) {
    const el = document.getElementById('matchend');
    el.classList.remove('hidden');
    const title = document.getElementById('endTitle');
    title.textContent = msg.winner === TEAM.T ? 'TERRORISTS WIN' : msg.winner === TEAM.CT ? 'COUNTER-TERRORISTS WIN' : 'DRAW';
    title.className = 'endtitle ' + (msg.winner ? teamCls(msg.winner) : '');
    document.getElementById('endScore').innerHTML = `<span style="color:var(--t)">${msg.scoreT}</span> : <span style="color:var(--ct)">${msg.scoreCT}</span>`;
    const rows = [...msg.players].sort((a, b) => b.k - a.k || a.d - b.d);
    document.getElementById('endPlayers').innerHTML = rows.map((r) =>
      `<div class="${teamCls(r.team)}"><span>${r.id === myId ? '<b>' : ''}${esc(r.name)}${r.id === myId ? '</b>' : ''}</span><span>${r.k} / ${r.d}</span></div>`).join('');
    this._voteEnds = performance.now() / 1000 + msg.voteTime;
    this._voteMine = null;
    this._voteMaps = msg.maps;
    this._onVote = onVote;
    this.renderVotes({}, msg.current);
  }

  renderVotes(tally, current) {
    if (current) this._voteCurrent = current;
    const box = document.getElementById('voteMaps');
    box.innerHTML = this._voteMaps.map((id) => `<button data-map="${id}" class="${this._voteMine === id ? 'mine' : ''}">${esc(id.replace('de_aq_', ''))}<b>${tally[id] || 0}</b><small>${id === this._voteCurrent ? 'played last' : ''}</small></button>`).join('');
    for (const b of box.querySelectorAll('button')) {
      b.onclick = () => { this._voteMine = b.dataset.map; this._onVote(b.dataset.map); this.renderVotes(this._lastTally || {}); };
    }
    this._lastTally = tally;
  }

  tickVote() {
    const t = document.getElementById('voteTimer');
    if (t && this._voteEnds) t.textContent = `· ${Math.max(0, Math.ceil(this._voteEnds - performance.now() / 1000))}s`;
  }

  hideMatchEnd() { document.getElementById('matchend').classList.add('hidden'); this._voteEnds = 0; }
  matchEndOpen() { return !document.getElementById('matchend').classList.contains('hidden'); }
}
