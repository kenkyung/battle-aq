# Battle-AQ

A lightweight online multiplayer first-person shooter inspired by Counter-Strike 1.6.

**The game runs in the browser.** The server is a single Node process (HTTP +
WebSocket on one port); players join by opening a URL — nothing to install.
The original Godot 4 build is kept under [`godot/`](godot/) for reference.

## Run it

```bash
cd web
npm install        # once
npm start          # serves on 0.0.0.0:8080, de_aq_dust
```

The server prints the addresses to share:

```
remote players (Tailscale):  http://100.x.x.x:8080
LAN players:                 http://192.168.x.x:8080
```

Everyone (you included) opens one of those URLs, enters a name, hits PLAY.
Options: `node server/index.js --port 9000 --map de_aq_aztec --host 0.0.0.0`
(maps: `de_aq_dust`, `de_aq_inferno`, `de_aq_aztec`, `cs_aq_office`, `cs_aq_assault`, `cs_aq_italy`;
`PORT`/`HOST`/`MAP` env vars work too).

The client uses only relative URLs, so it also runs behind a reverse-proxy
path (the arcade serves it at `/battle/`).

Alone? Pick **Practice vs bots** in the menu: your own private match on any
map against 1–9 server-side bots (easy / normal / hard) that navigate the map,
buy, carry and plant the bomb, retake, defuse and control their spray.
`npm run sim -- de_aq_dust 10 hard` plays a whole bot-vs-bot match headless.

## Test

```bash
cd web
npm test           # CS 1.6 ballistics, smoke (join/sync/fire/kill), M2 economy,
                   # bomb + round flow (plant/defuse/blast, halftime, map vote),
                   # grenades, bot fill, collisions (wall fuzz, server move
                   # checks), hostage rescue on every cs_ map
```

## Controls

WASD move · mouse look · Space jump · C (or Ctrl) crouch · Shift walk ·
LMB fire · RMB scope (AWP/Scout) · R reload · 1/2/3 primary/pistol/knife ·
4 grenades (hold fire, release to throw) · 5 bomb (hold fire in a site to plant) ·
E defuse / take a hostage · G drop bomb · Q last weapon · wheel cycle · B buy menu
(mouse or number keys) · Z / X / V radio commands · Tab scores · Y chat · **Esc pause menu**

Play starts in fullscreen with Keyboard Lock (setting), so Ctrl combos and Esc
stay in the game; hold Esc to leave fullscreen. The buy menu keeps the mouse
captured and shows its own cursor.

## How a match works

- **Online** rooms are per map and fill up with bots to 5v5 (or 4v4 / 3v3 /
  none — menu setting); a joining player takes a bot's place.
- **Movement** is CS 1.6's (pm_shared): accelerate 5, air-accelerate 10 with
  the 30 u/s air wish cap, exact 45 u jumps (63 u duck-jumps) with landing
  fatigue, fall damage, 18 u steps on the ground only, edge friction, the
  0.4 s duck, slowdown when shot, ladders; players block each other.
- **Quick buy** (CS binds): F1 autobuy, F2 rebuy last round, `,` / `.` ammo
  boxes for primary / pistol, O equipment menu.
- **Grenades**: HE (100 dmg / 350 u, walls stop it), flashbang (blinds by
  distance and facing), smoke (18 s, blocks bots' sight). Max 1 / 2 / 1.
- **Warmup** while one team is empty: respawn on death, $16000, buy anywhere.
- **Match** as soon as both teams have a player: CS 1.6 rounds — 5 s freeze
  time, 1:55 round, first to 8 of 15, sides swap at halftime. The dead stay
  dead until the next round and spectate a teammate. Survivors keep their
  weapons. At the end everyone votes for the next map.
- **Bomb**: one terrorist carries the C4; plant it (3 s) at bombsite A or B,
  then CT have 35 s to defuse (10 s, 5 s with a $200 kit). T win by
  elimination or detonation, CT by elimination, defuse or the clock.
- **Hostages** (cs_ maps): four hostages start with the terrorists. A CT
  presses E next to one (+$150) and it follows; walking it into a rescue
  zone (green ring) pays $1000 (+$850 to the team). All living hostages out
  = CT win; the clock running out = T win. Killing a hostage costs $1500.
- **Economy** (cstrike's rewards): $800 start, $300 per kill (any weapon),
  -$3300 for a team kill, $3000 elimination win, $3500 detonation, $3250
  defuse or time win, loss bonus $1400 → $2000 → $2500 → $3000, $16000 cap.
- **Rules**: Casual (2:30 rounds, first to 8) or Competitive MR15 (30 rounds,
  first to 16, 1:45, friendly fire at 35 %), picked in the menu.
- **Weapons** are CS 1.6's (`shared/ballistics.js`): the same KickBack view
  punch per stance (the spray pattern), accuracy that decays with shots fired
  (automatics) or recovers between shots (pistols), FireBullets3 spread, hit
  groups (head x4, stomach x1.25, legs x0.75, narrow head box), range falloff,
  per-weapon armour penetration and run speed. The full CS 1.6 arsenal:
  Glock (burst), USP (silencer), P228, Desert Eagle, Dual Berettas,
  Five-SeveN, M3 / XM1014 (pellets, shell reloads), MP5, TMP, MAC-10, UMP45,
  P90, Galil, FAMAS (burst), AK-47, M4A1 (silencer), SG 552 / AUG (zoom),
  Scout, AWP, SG 550 / G3/SG-1, M249, knife (slash / stab). Bullets go
  through thin walls and players (penetration by calibre and material).
  Right click = zoom / silencer / burst / stab; G drops your gun, walk over a
  gun to pick it up.

## Graphics

Maps, characters, weapons and textures are built in **Blender** by scripts in
[`art/`](art/README.md) (`art/build.sh`). Levels have baked Cycles lightmaps
drawn with unlit materials, like GoldSrc BSPs, so it runs on older laptops.
The menu has Low / Medium / High quality.

## Layout

```
web/
  server/    Node: static HTTP + WebSocket, authoritative game (game.js),
             smoke.js + m2.test.js
  shared/    modules imported by BOTH server and browser — constants
             (CS 1.6 movement/weapon values), economy, map specs + themes,
             AABB physics
  public/    browser client (three.js): index.html, js/, vendored three,
             assets/ (Blender build output)
  tools/     export-maps.mjs (colliders -> Blender), bots.mjs
art/         Blender build scripts for every asset (see art/README.md)
deploy/      VPS installer (systemd service behind the arcade's nginx)
godot/       archived Godot 4 build (specs the web version was ported from)
docs/        design references (CS 1.6 numbers, map notes)
```

## Network model

- One Node process, one port. Static files over HTTP, game over WebSocket
  (`/ws`, JSON messages).
- **Movement is client-predicted** using the shared physics module; the server
  relays positions in 20 Hz snapshots.
- **Damage is server-authoritative**: clients send `fire` intent (origin +
  direction), the server raycasts against the map and players, then broadcasts
  `hit`/`kill` events. The client never decides a hit.
- Three.js is vendored (`public/vendor/three.module.js`) — no CDN, so it works
  over Tailscale/LAN with no internet.

## Roadmap

- [x] M1 — movement, shooting, raycast hits, HP, respawn (web build)
- [x] M2 — buy menu, money, ammo + reserve, timed reloads, armour, team weapons
- [x] M3 — round system: warmup → buy → round → end, elimination, spectating
- [x] M4 — three maps ported to the web (dust / inferno / aztec)
- [x] Graphics — Blender-built maps with baked lightmaps, rigged + animated
      soldiers, modelled weapons + first-person arms, effects, CS-style HUD
- [x] M5 — bomb plant/defuse mode, halftime swap, match end + map vote
- [x] Practice mode vs bots (nav graph + bot AI)
- [x] M6 — sounds: synthesized at load (Web Audio, no files), 3D HRTF with wall
      muffling, per-weapon gunshots, surface footsteps, bomb beeps, radio voice
- [x] Grenades, CS 1.6 movement, bot fill, server-checked collisions, new
      soldier models + locomotion
- [x] M7 — hostage rescue: cs_aq_office, cs_aq_assault, cs_aq_italy
- [ ] M8 → M17 — CS 1.6 parity in iterations: movement, full arsenal +
      penetration, rules / economy, netcode (usercmds, lag compensation), HUD,
      audio, ZBot-level bots, classic map layouts, modes, performance

See `ROADMAP.md` for the ticket-sized backlog.

## Deploy

`deploy/install.sh` installs the server on a VPS as the `battle-aq` systemd
service on `127.0.0.1:8095`, behind the arcade's nginx at `/battle/`. The
target comes from `deploy/deploy.conf` (gitignored; see `deploy.conf.example`).

## License

MIT (see `LICENSE`).
