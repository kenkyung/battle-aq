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
(maps: `de_aq_dust`, `de_aq_inferno`, `de_aq_aztec`).

## Test

```bash
cd web
npm run smoke      # boots the server, connects 2 bots, asserts join/sync/fire/kill
```

## Controls

WASD move · mouse look · Space jump · Ctrl crouch · Shift walk ·
LMB fire · R reload · 1-9 weapons · Y chat · click to lock the mouse

## Layout

```
web/
  server/    Node: static HTTP + WebSocket, authoritative game (game.js)
  shared/    modules imported by BOTH server and browser — constants
             (CS 1.6 movement/weapon values), map specs, AABB physics
  public/    browser client (three.js): index.html, js/, vendored three
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
- [x] M3 — round system basics, score, two-team spawns
- [x] M4 — three maps ported to the web (dust / inferno / aztec blockouts)
- [ ] M2 — buy menu, ammo economy, proper reload state
- [ ] M5 — bomb plant/defuse mode
- [ ] M6 — player models + animations, sounds

See `ROADMAP.md` for the ticket-sized backlog.

## License

MIT (see `LICENSE`).
