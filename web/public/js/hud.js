// DOM HUD. Pure view layer — main.js feeds it state; it owns no game logic
// beyond formatting. Includes the radar, buy menu and scoreboard.

import { WEAPONS, TEAM, SLOTS } from '../shared/constants.js';
import { BUY_MENU, itemInfo, buyZoneCenter, ECONOMY, ammoBox } from '../shared/economy.js';
import { assetUrl } from './assets.js';

// kill-feed icon atlas (art/blender/build_killicons.py)
let KILLICONS = null;
fetch(assetUrl('ui/killicons.json')).then((r) => r.json()).then((j) => { KILLICONS = j; }).catch(() => {});

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

  setWeapon(id, mag, reserve, reloadFrac, mode = null) {
    const w = WEAPONS[id];
    this.set('wname', id + (mode || ''), () => { this.el.weaponName.textContent = w.name + (mode === 'silenced' ? ' · silenced' : mode === 'burst' ? ' · burst' : ''); });
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
  // hostage maps: one figure per hostage (white = to rescue, green = rescued,
  // red = dead); null hides it
  setHostages(c) {
    if (!this._hEl) {
      this._hEl = document.createElement('div');
      this._hEl.id = 'hostages';
      document.getElementById('hud').appendChild(this._hEl);
    }
    this._hEl.classList.toggle('hidden', !c);
    if (!c) return;
    const icons = [];
    for (let i = 0; i < c.total; i++) icons.push(i < c.rescued ? 'r' : i < c.rescued + c.killed ? 'k' : '');
    this._hEl.innerHTML = '<span>HOSTAGES</span>' + icons.map((k) => `<i class="${k}"></i>`).join('');
  }

  setHint(text) { this.set('hint', text, (v) => { this.el.hint.textContent = v; }); }

  setSpectate(text) {
    this.set('spec', text, (v) => {
      this.el.spectate.textContent = v;
      this.el.spectate.classList.toggle('hidden', !v);
    });
  }

  // CS kill feed: killer, weapon icon (Blender-rendered silhouettes), headshot
  addKill(killer, victim, weapon, headshot, involvesMe, wallbang = false) {
    const div = document.createElement('div');
    div.className = 'kf' + (involvesMe ? ' me' : '');
    const icon = KILLICONS && KILLICONS.icons[weapon];
    let w;
    if (icon) {
      const k = 22 / icon[3];
      w = `<i class="ki" title="${esc(WEAPONS[weapon] ? WEAPONS[weapon].name : weapon)}" style="width:${Math.round(icon[2] * k)}px;`
        + `background-image:url(${assetUrl('ui/killicons.png')});background-size:${KILLICONS.size[0] * k}px ${KILLICONS.size[1] * k}px;`
        + `background-position:${-icon[0] * k}px ${-icon[1] * k}px"></i>`;
    } else w = `<span class="w">${esc(WEAPONS[weapon] ? WEAPONS[weapon].name : weapon)}</span>`;
    div.innerHTML = `<span class="${teamCls(killer.team)}">${esc(killer.name)}</span>`
      + w
      + (wallbang ? '<span class="wbi">WB</span>' : '')
      + (headshot ? '<span class="hsi">HS</span>' : '')
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

  drawRadar(me, yaw, mates, bomb, hostages = null) {
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
    if (hostages) {
      // rescue zones (green rings) and the hostages still to save (white)
      ctx.lineWidth = 3;
      for (const z of hostages.zones || []) {
        ctx.strokeStyle = 'rgba(120,220,140,0.9)';
        ctx.beginPath(); ctx.arc((z[0] - b.x0) * s, (z[2] - b.z0) * s, Math.max(8, (z[3] || 280) * s), 0, Math.PI * 2); ctx.stroke();
      }
      for (const h of hostages.list) {
        ctx.fillStyle = '#f4f4f0';
        ctx.fillRect((h[0] - b.x0) * s - 4, (h[2] - b.z0) * s - 4, 8, 8);
      }
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
      if (!cats[n - 1]) return;
      // 6 / 7: ammo is bought straight away, as in CS
      if (BUY_MENU[n - 1] && BUY_MENU[n - 1].direct) { if (this._onBuy) this._onBuy(cats[n - 1][0]); return; }
      this._buyCat = n - 1; this.highlightBuy();
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

  closeBuy() { this.el.buymenu.classList.add('hidden'); this._buyCat = null; if (this._input) this._input.buyOpen = false; this.showCursor(false); }

  // In-game cursor for the buy menu while the mouse stays pointer-locked (so
  // closing the menu never drops you out of the game).
  showCursor(on) {
    if (!this._cursor) {
      this._cursor = document.createElement('div');
      this._cursor.id = 'vcursor';
      this._cursor.className = 'hidden';
      document.body.appendChild(this._cursor);
    }
    if (on && this._cursor.classList.contains('hidden')) { this._cx = innerWidth / 2; this._cy = innerHeight * 0.55; }
    this._cursor.classList.toggle('hidden', !on);
    if (on) this.moveCursor(0, 0);
    else if (this._hover) { this._hover.classList.remove('hover'); this._hover = null; }
  }

  moveCursor(dx, dy) {
    this._cx = Math.max(0, Math.min(innerWidth - 2, this._cx + dx));
    this._cy = Math.max(0, Math.min(innerHeight - 2, this._cy + dy));
    this._cursor.style.transform = `translate(${this._cx}px, ${this._cy}px)`;
    const btn = this._under();
    if (btn !== this._hover) {
      if (this._hover) this._hover.classList.remove('hover');
      this._hover = btn;
      if (btn) btn.classList.add('hover');
    }
  }

  _under() {
    const el = document.elementFromPoint(this._cx, this._cy);
    return el && el.closest ? el.closest('#buymenu button') : null;
  }

  cursorClick() { const b = this._under(); if (b) b.click(); }

  refreshBuy({ money, team, inv, armor, helmet, kit, buyLeft, nvg, shield }) {
    this.el.buyMoney.textContent = '$' + money;
    this.el.buyTimer.textContent = buyLeft < 0 ? 'warmup: buy anywhere' : `${Math.ceil(buyLeft)}s left to buy`;
    this._buyCats = BUY_MENU.map((cat) => cat.items.filter((id) => { const it = itemInfo(id); return !it.team || it.team === team; }));
    this.el.buyCols.innerHTML = BUY_MENU.map((cat, ci) => `<div class="bcol"><h4><b>${ci + 1}</b> ${cat.title}</h4>${this._buyCats[ci].map((id, ii) => {
      const it = itemInfo(id);
      let price = it.price;
      if (id === 'assault' && armor >= 100 && !helmet) price = 350;
      let none = false;
      if (id === 'ammo1' || id === 'ammo2') { const g = inv[id === 'ammo1' ? 'primary' : 'secondary']; price = g ? ammoBox(g)[0] : 0; none = !g; }
      const own = it.weapon ? Object.values(inv).includes(id)
        : (id === 'kevlar' ? armor >= 100 : id === 'assault' ? armor >= 100 && helmet : id === 'kit' ? !!kit : id === 'nvg' ? !!nvg : id === 'shield' ? !!shield : false);
      const cls = ['bitem', money < price || none ? 'no' : '', own ? 'own' : ''].join(' ');
      // VGUI-style: the weapon's silhouette on its button
      const ic = KILLICONS && KILLICONS.icons[id];
      const art = ic ? `<i class="bart" style="width:${Math.round(ic[2] * 16 / ic[3])}px;background-image:url(${assetUrl('ui/killicons.png')});background-size:${KILLICONS.size[0] * 16 / ic[3]}px ${KILLICONS.size[1] * 16 / ic[3]}px;background-position:${-ic[0] * 16 / ic[3]}px ${-ic[1] * 16 / ic[3]}px"></i>` : '';
      return `<button class="${cls}" data-item="${id}">${art}<i class="k">${ii + 1}</i>${esc(it.name)}<span class="p">${none ? '—' : '$' + price}</span></button>`;
    }).join('')}</div>`).join('');
    for (const btn of this.el.buyCols.querySelectorAll('.bitem')) {
      btn.onclick = () => this._onBuy && this._onBuy(btn.dataset.item);
    }
  }

  buyFail(reason) { this.el.buyStatus.textContent = reason; }

  // ------------------------------------------------------------ scoreboard

  // CS 1.6 scoreboard: name, status (DEAD / BOMB), score, deaths, latency
  showScores(on, rows, myId, info = {}) {
    this.el.scoreboard.classList.toggle('hidden', !on);
    if (!on) return;
    const render = (team) => {
      const list = rows.filter((r) => r.team === team).sort((a, b) => b.k - a.k || a.d - b.d);
      return '<tr class="head"><td class="n">NAME</td><td class="s"></td><td class="k">SCORE</td><td class="d">DEATHS</td><td class="l">LATENCY</td></tr>'
        + list.map((r) => `<tr class="${r.alive ? '' : 'dead'} ${r.id === myId ? 'me' : ''}"><td class="n">${esc(r.name)}</td>`
          + `<td class="s ${r.c4 ? 'bomb' : ''}">${r.afk ? 'AFK' : !r.alive ? 'DEAD' : r.vip ? 'VIP' : r.c4 ? 'BOMB' : ''}</td>`
          + `<td class="k">${r.k}</td><td class="d">${r.d}</td><td class="l">${r.bot ? 'BOT' : r.ping ?? ''}</td></tr>`).join('');
    };
    this.el.sbTbody.innerHTML = render(TEAM.T);
    this.el.sbCTbody.innerHTML = render(TEAM.CT);
    const count = (team) => { const l = rows.filter((r) => r.team === team); return `${l.length} player${l.length === 1 ? '' : 's'} · ${l.filter((r) => r.alive).length} alive`; };
    document.getElementById('sbTn').textContent = count(TEAM.T);
    document.getElementById('sbCTn').textContent = count(TEAM.CT);
    document.getElementById('sbHead').innerHTML = `<span>${esc(info.map || '')}</span><span>${esc(info.rules || '')}${info.round ? ` · round ${info.round} of ${info.maxRounds}` : ''}</span>`;
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
    box.innerHTML = this._voteMaps.map((id) => `<button data-map="${id}" class="${this._voteMine === id ? 'mine' : ''}">${esc(id.replace(/^(de|cs)_aq_/, ''))}<b>${tally[id] || 0}</b><small>${id === this._voteCurrent ? 'played last' : ''}</small></button>`).join('');
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
