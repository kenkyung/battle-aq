# Battle-AQ — roadmap

A lightweight online multiplayer FPS, CS-inspired, runs on modest hardware
(Godot 4 GL Compatibility renderer). Each milestone is one PR-sized batch.

## M0 — Scaffold  [done]
Project, scenes, scripts, license, README, .gitignore.

## M1 — Core FPS loop
- [x] Real `Player.gd` movement + mouse look.
- [x] CS 1.6 physics tuning: gravity 32, crouch speed multiplier 0.4,
      head-bob disabled (CS16_REFERENCE.md §1).
- [x] Server-authoritative hit scan via `network_codec.gd`.
- [x] HUD: crosshair, HP bar, ammo counter, kill feed, round timer, score
      strip, phase label (see `scripts/hud.gd` + `scenes/hud.tscn`).
- [x] Smoke test (`scripts/smoke_test.gd`) — every script parses, every
      scene loads, weapons validate, map `_ready()` builds the contract
      SpawnPoints + MapData, kill queue round-trips.
- [x] Project loadability — fixed malformed `project.godot` (the GL Compat
      renderer key was rejected by Godot 4; moved into a proper
      `[rendering]` section with the quoted form of the value).
- [ ] MultiplayerSynchronizer config so position/rotation/HP replicate.
- [ ] Manual smoke test: host + 1 client, walk + shoot each other.

## M2 — Weapons + economy
- [x] Weapon archetypes via `WeaponData` Resource + `weapons_manifest.gd`
      (9 weapons: knife + glock + usp + deagle + mp5 + ak47 + m4a1 + awp +
      scout, every value from CS16_REFERENCE.md §2-§3).
- [ ] Weapon runtime: cone sampling, recoil, hit registration wired through
      `NetworkCodec.compute_damage` / `current_cone_deg` / `sample_shot_direction`.
- [x] Buy menu (buy-time only) — web build: `shared/economy.js`, `js/hud.js`.
- [x] Ammo + reload state — magazine + reserve, timed server-side reloads.
- [x] Money: start $800, kill/win/loss-streak bonuses, $16000 cap.
- [x] Armour: kevlar / kevlar + helmet (CS damage absorption).
- [x] Team-restricted weapons (AK-47 T, M4A1 CT) and default pistols.

## M3 — Round system
- [x] Round loop (warmup → buy → round → end), web build `server/game.js`.
- [x] Two-team spawns + auto-balance.
- [x] Scoreboard UI (Tab), spectating teammates while dead.

## M4 — First proper maps
- [x] Replace `world.gd` blockout with three real arena scenes
      (`scenes/maps/de_aq_{dust, inferno, aztec}.tscn`). All geometry
      built from spec tables via `scripts/map_geometry.gd`, snap to the
      CS 1.6 64-unit grid (CS16_REFERENCE.md §6).
- [x] Per-map `MapData` node driving WorldEnvironment (fog, sky gradient,
      ambient) — see `scripts/world.gd::apply_map_data`.
- [x] Map catalogue in `scripts/main.gd::MAP_CATALOGUE`.
- [ ] Lightmap bake settings for the mobile renderer.

## M5 — Server build
- [ ] Headless server export target.
- [ ] Command-line server boot: `battle-aq-server.exe --port 24816 --map de_aq`.

## M6 — Cross-platform exports
- [ ] Linux/Windows desktop, web (HTML5/WebRTC transport fallback).
- [ ] Steam SDK integration (later).

## Stretch
- [ ] Voice chat (via Mumble or WebRTC).
- [ ] Replay / demo recording.
- [ ] Spectator camera.
- [ ] Server-side lag compensation for fairer hit registration.
## Web build — done since M2
- [x] Bomb mode (C4 plant/defuse, kit, drop/pick-up, blast), freeze time,
      halftime side swap, match end + map vote / rotation.
- [x] Practice rooms vs bots: nav graph from the colliders (server/nav.js),
      bot brain (server/bot.js), headless match simulator (server/sim.js).
- [x] CS 1.6 ballistics (shared/ballistics.js): KickBack recoil, accuracy,
      spread, hit groups, armour ratios, range modifiers; UMP45 + M249.
- [x] Map fixes: sealed inferno T / aztec CT spawns opened, dust A reachable
      by two ramps; props + arches generated and route-validated.
- [x] Esc pause menu, fullscreen keyboard lock, CS 1.6 dynamic crosshair.

## Next
- [ ] M6 sounds (weapons, footsteps, bomb beeps, radio).
- [ ] Grenades (HE / flash / smoke).
