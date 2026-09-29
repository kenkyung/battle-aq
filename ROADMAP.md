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
- [ ] HUD: crosshair, HP bar, ammo counter, kill feed.
- [ ] MultiplayerSynchronizer config so position/rotation/HP replicate.
- [ ] Manual smoke test: host + 1 client, walk + shoot each other.

## M2 — Weapons + economy
- [x] Weapon archetypes via `WeaponData` Resource + `weapons_manifest.gd`
      (9 weapons: knife + glock + usp + deagle + mp5 + ak47 + m4a1 + awp +
      scout, every value from CS16_REFERENCE.md §2-§3).
- [ ] Weapon runtime: cone sampling, recoil, hit registration wired through
      `NetworkCodec.compute_damage` / `current_cone_deg` / `sample_shot_direction`.
- [ ] Buy menu (buy-time only).
- [ ] Ammo + reload state.

## M3 — Round system
- [ ] `GameState` round loop (buy → round → end → loop).
- [ ] Two-team spawn selection (`team` already on Player).
- [ ] Scoreboard UI.

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