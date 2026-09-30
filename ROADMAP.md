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
## Web build — done
- [x] Bomb mode (C4 plant/defuse, kit, drop/pick-up, blast), freeze time,
      halftime side swap, match end + map vote / rotation.
- [x] Practice rooms vs bots: nav graph from the colliders (server/nav.js),
      bot brain (server/bot.js), headless match simulator (server/sim.js).
- [x] CS 1.6 ballistics (shared/ballistics.js): KickBack recoil, accuracy,
      spread, hit groups, armour ratios, range modifiers; UMP45 + M249.
- [x] Map fixes: sealed inferno T / aztec CT spawns opened, dust A reachable
      by two ramps; props + arches generated and route-validated.
- [x] Esc pause menu, fullscreen keyboard lock, CS 1.6 dynamic crosshair.
- [x] Sound (M6): synthesized gunfire, footsteps, bomb, radio voice, 3D audio.
- [x] Grenades (HE / flash / smoke), CS 1.6 movement (pm_shared accel,
      friction, air strafing, jump fatigue, fall damage), radio Z / X / V.
- [x] Bot fill for online rooms (3v3 - 5v5), smarter bots.
- [x] Solid collisions: server-checked movement (no walking through walls
      or players), players block each other, floating geometry grounded.
- [x] New soldier models (normal-mapped gear) and locomotion: stride-matched
      gait, CS gait yaw (legs follow movement, backpedal), no leaning.
- [x] **M7 — Hostage rescue**: cs_aq_office / cs_aq_assault / cs_aq_italy,
      hostage model, E to lead, rescue zones, CS money rules, bots that
      fetch and escort hostages, `server/hostage.test.js`.

# Toward CS 1.6 parity (web build)

The goal is gameplay that is indistinguishable from CS 1.6, reached in
iterations. Each phase is one deployable batch with tests; numbers come from
the HLSDK / cstrike sources and CS16_REFERENCE.md, never from memory alone.
Every phase ends with: tests + sims green, deploy, a short play-test note.

## M8 — Movement parity II
- [ ] Ducking as in pm_shared: 0.4 s duck transition, view height 28 -> 12
      offset, duck-jump (hull shrink in the air = +18 u clearance), no
      instant crouch-peek.
- [ ] Velocity modifier on being hit (CS "tagging": slowed to ~50 % and
      recovering over ~0.5 s), landing slow-down after long falls.
- [ ] Edge friction (x2 near drops), stepsize 18 on every surface, ramps
      that slide above 45 degrees.
- [ ] Ladders (climb speed 200, jump-off), with ladder volumes in the map data.
- [ ] Water: swim, wade speed, fall damage absorbed.
- [ ] A movement test bench: strafe-jump / bhop / counter-strafe traces
      compared against recorded CS 1.6 numbers.

## M9 — Weapon parity II (full arsenal)
- [ ] Every CS 1.6 weapon: P228, Five-SeveN, Dual Elites, Galil, FAMAS
      (burst), AUG / SG552 (scope), SG550 / G3SG1, M3 / XM1014 (pellets,
      shell-by-shell reload), MAC-10, TMP, P90.
- [ ] Silencers (M4A1, USP: damage / recoil / sound changes), Glock burst,
      FAMAS burst, knife primary / secondary + backstab.
- [ ] Bullet penetration (wallbangs): per-weapon penetration power and
      distance, material modifiers (wood / metal / concrete).
- [ ] Deploy times, scope-in delays, sniper movement inaccuracy, scoped
      speed penalties, weapon weights -> run speeds.
- [ ] Dropped weapons on the ground (G drop, pick up by walking over, death
      drops), buy restrictions per team exactly as CS.

## M10 — Round, economy and rules parity
- [ ] Money table from the source: loss bonus streak (1400 -> 3400), kill
      rewards, team-kill penalty, hostage values, bomb plant bonus to T.
- [ ] mp_* settings: freezetime, buytime, roundtime, maxrounds / MR15,
      friendly fire (with team damage and team-kill penalties), c4timer.
- [ ] Spawn-protection-free, CS-style spawn order; auto team balance.
- [ ] Scoreboard as CS (score, deaths, latency, DEAD / BOMB markers).

## M11 — Netcode parity
- [ ] Input-command movement (usercmds) simulated on the server with client
      prediction + reconciliation (replaces checked client positions).
- [ ] Lag compensation: rewind hit boxes to the shooter's view time.
- [ ] Interpolation buffer (~100 ms), tickrate options (33 / 66 / 100),
      ping + net_graph overlay, packet-loss tolerance.

## M12 — HUD and UX parity
- [ ] CS 1.6 HUD layout and fonts, weapon icons in the kill feed (headshot
      and wallbang markers), damage direction indicators.
- [ ] VGUI-style buy and team menus (M key), weapon selection bar with
      slots, "Press USE" hints, message of the day.
- [ ] Spectator: free look, chase cam, first-person, overview map.
- [ ] Console with cvars (sensitivity, crosshair colour / size, fps_max,
      volume) and key bindings.

## M13 — Audio parity
- [ ] Surface footsteps incl. metal / grate / ladder / water; land sounds.
- [ ] Distance-filtered gunshots, shell casings, reload sounds per weapon.
- [ ] Full radio set (3 menus) and hostage voices; bomb beep cadence exact.

## M14 — Bot parity (CS ZBot)
- [ ] Nav mesh with hiding / sniper / approach spots per map.
- [ ] Difficulty profiles (reaction time, aim, attention), buy strategies
      (eco / force / full), team plans (rush / split / rotate / save).
- [ ] Better hostage play: escort groups, T hostage-room holds.

## M15 — Map parity
- [ ] Faithful-scale layouts of the classic maps (dust2-, nuke-, train-
      style) with doors, breakable glass / vents, ladders, water, skyboxes.
- [ ] Map pipeline: author maps in a simple editor format, validate routes,
      bake in Blender (existing art/blender/build_maps.py).

## M16 — Modes and servers
- [ ] VIP (as_) mode, deathmatch / warmup DM, custom room settings.
- [ ] Server browser, persistent stats, admin kick / ban, anti-cheat
      (rate limits, PVS-lite so hidden enemies are not sent).

## M17 — Performance
- [ ] Model LOD + instancing, texture atlases, 144 fps on integrated GPUs,
      quality presets verified on older hardware.
