// DOM HUD. Pure view layer — reads state set by main.js, owns no game logic.

export class HUD {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.root = $('hud');
    this.crosshair = $('crosshair');
    this.hplabel = $('hplabel');
    this.hpfill = $('hpfill');
    this.weaponName = $('weaponName');
    this.ammoCount = $('ammoCount');
    this.timer = $('timer');
    this.phase = $('roundPhase');
    this.scoreT = $('scoreT');
    this.scoreCT = $('scoreCT');
    this.killfeed = $('killfeed');
    this.chatlog = $('chatlog');
    this.hint = $('hint');
    this.death = $('death');
    this.deathText = $('deathText');
    this._hp = 100;
  }

  show() { this.root.classList.remove('hidden'); this.crosshair.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); this.crosshair.classList.add('hidden'); }

  setHp(hp) {
    hp = Math.max(0, Math.round(hp));
    if (hp === this._hp) return;
    this._hp = hp;
    this.hplabel.textContent = hp;
    const frac = hp / 100;
    this.hpfill.style.width = (frac * 100) + '%';
    this.hpfill.style.background = frac > 0.5 ? '#37c95c' : frac > 0.25 ? '#d8b53a' : '#d84a3a';
  }

  setAmmo(inMag, mag, reloading) {
    this.ammoCount.textContent = reloading ? 'reloading…' : `${inMag} / ${mag}`;
  }

  setWeapon(name) { this.weaponName.textContent = name; }

  setTimer(seconds) {
    seconds = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(seconds / 60), s = seconds % 60;
    this.timer.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }

  setPhase(txt) { this.phase.textContent = txt.toUpperCase(); }

  setScore(t, ct) { this.scoreT.textContent = t; this.scoreCT.textContent = ct; }

  addKill(killerName, victimName, weapon) {
    const div = document.createElement('div');
    div.className = 'kf';
    div.innerHTML = `<span class="k">${esc(killerName)}</span> <span class="w">[${esc(weapon)}]</span> <span class="v">${esc(victimName)}</span>`;
    this.killfeed.prepend(div);
    while (this.killfeed.children.length > 5) this.killfeed.removeChild(this.killfeed.lastChild);
    setTimeout(() => { div.style.opacity = '0'; setTimeout(() => div.remove(), 400); }, 6000);
  }

  addChat(name, text) {
    const div = document.createElement('div');
    div.className = 'chat';
    div.innerHTML = `<span class="n">${esc(name)}:</span> ${esc(text)}`;
    this.chatlog.appendChild(div);
    while (this.chatlog.children.length > 6) this.chatlog.removeChild(this.chatlog.firstChild);
    setTimeout(() => div.remove(), 9000);
  }

  setHint(text) { this.hint.textContent = text; }

  showDeath(killerName) {
    this.deathText.textContent = killerName ? `Killed by ${killerName}` : 'You died';
    this.death.classList.remove('hidden');
  }
  hideDeath() { this.death.classList.add('hidden'); }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
