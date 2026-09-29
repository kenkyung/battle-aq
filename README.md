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
(maps: `de_aq_dust`, `de_aq_inferno`, `de_aq_aztec`; `PORT`/`HOST`/`MAP` env vars work too).

The client uses only relative URLs, so it also runs behind a reverse-proxy
path (the arcade serves it at `/battle/`).

Alone? `node tools/bots.mjs --url ws://127.0.0.1:8080/ws --count 3` adds
wandering bots, which also starts a real match.

## Test

```bash
cd web
npm test           # smoke (join/sync/fire/kill) + M2 economy (money, buy zone,
                   # armour, ammo/reload, round bonuses) against a real server
```

## Controls

WASD move · mouse look · Space jump · Ctrl crouch · Shift walk ·
LMB fire · RMB scope (AWP/Scout) · R reload · 1/2/3 primary/pistol/knife ·
Q last weapon · wheel cycle · B buy menu · Tab scores · Y chat

## How a match works

- **Warmup** while one team is empty: respawn on death, $16000, buy anywhere.
- **Match** as soon as both teams have a player: CS 1.6 rounds (15 s buy
  time, 1:55 round, first to 8). The dead stay dead until the next round and
  spectate a teammate. Survivors keep their weapons.
- **Economy**: $800 start, $300 per kill ($1500 knife), $3250 round win
  ($3500 CT elimination), loss bonus $1400 → $3400 on a losing streak,
  $16000 cap. Buy in your spawn during buy time + 20 s.
- **Weapons** carry a magazine and a reserve; reloads take the real reload
  time and can be cancelled by switching. Kevlar halves body damage (helmet
  covers the head).

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
- [ ] M5 — bomb plant/defuse mode
- [ ] M6 — sounds (models and animations are done)

See `ROADMAP.md` for the ticket-sized backlog.

## Deploy

`deploy/install.sh` installs the server on a VPS as the `battle-aq` systemd
service on `127.0.0.1:8095`, behind the arcade's nginx at `/battle/`. The
target comes from `deploy/deploy.conf` (gitignored; see `deploy.conf.example`).

## License

MIT (see `LICENSE`).
