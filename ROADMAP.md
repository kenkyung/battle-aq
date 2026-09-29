# Battle-AQ — roadmap

A lightweight online multiplayer FPS, CS-inspired, runs on modest hardware
(Godot 4 GL Compatibility renderer). Each milestone is one PR-sized batch.

## M0 — Scaffold  [done]
Project, scenes, scripts, license, README, .gitignore.

## M1 — Core FPS loop
- [ ] Real `Player.gd` movement + mouse look (already scaffolded).
- [ ] Server-authoritative hit scan (already wired).
- [ ] HUD: crosshair, HP bar, ammo counter, kill feed.
- [ ] MultiplayerSynchronizer config so position/rotation/HP replicate.
- [ ] Manual smoke test: host + 1 client, walk + shoot each other.

## M2 — Weapons + economy
- [ ] Weapon archetypes (rifle, smg, pistol, knife) via a `WeaponData` Resource.
- [ ] Buy menu (buy-time only).
- [ ] Ammo + reload state.

## M3 — Round system
- [ ] `GameState` round loop (buy → round → end → loop).
- [ ] Two-team spawn selection (`team` already on Player).
- [ ] Scoreboard UI.

## M4 — First proper map
- [ ] Replace `world.gd` blockout with a real arena scene.
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