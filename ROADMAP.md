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

## M8 — Movement parity II  [done]
- [x] Quick-buy binds: F1 autobuy (CS default list), F2 rebuy, `,` / `.`
      ammo boxes at calibre prices, O equipment menu.
- [x] Ducking as cstrike PM_Duck: 0.4 s spline view blend with the hull
      still standing (no instant crouch-peek), instant duck in the air that
      lifts the feet 18 u (duck-jump), instant stand-up if there is room,
      x0.333 while the key is held. View offsets VEC_VIEW 17 / VEC_DUCK_VIEW
      12 (eye 53 / 30 above the feet); the server shoots from the reported
      mid-duck eye.
- [x] Exact jump arc (half gravity before and after the move): 45 u jump,
      63 u duck-jump; no stepping up while airborne (PM_StepMove is ground
      only), so 64 u crates are out of reach as in CS.
- [x] Being shot slows you (m_flVelocityModifier 0.5 / 0.65 large flinch,
      +0.01 per 10 ms), for players and bots.
- [x] Edge friction x2 when the ground ends 16 u ahead.
- [x] Ladders (PM_LadderMove: 200 u/s, look-down to descend, strafe along,
      jump-off 270), first one on cs_aq_assault's catwalk.
- [x] Water level: splash footsteps, no fall damage when landing in water.
- [x] `server/movement.test.js`: speeds, jump heights, crates, duck timing,
      counter-strafe, air-strafe gain, edge friction, tagging, ladders, water.
- [ ] Later: swimming for deep water (no deep water in the maps yet),
      ladders on more maps (with M15 layouts).

## M9 — Weapon parity II (full arsenal)  [done]
- [x] Every CS 1.6 gun: P228, Five-SeveN, Dual Berettas, M3, XM1014, TMP,
      MAC-10, P90, Galil, FAMAS, AUG, SG 552, SG 550, G3/SG-1 (+ the ten we
      had), with cstrike values: damage, range modifier, armour ratio, fire
      rate, magazine, run speed, spread / accuracy model, KickBack.
- [x] Right click as CS: M4A1 / USP silencer (2 s / 3.1 s, different
      damage + spread, quiet shot, no flash, short hearing range for bots),
      Glock / FAMAS burst, AUG / SG552 zoom (55, faster fire rate unzoomed),
      2-level zoom on autosnipers, knife stab (65, 32 u, x3 from behind).
- [x] Shotguns: 9 / 6 pellets, fixed cone, linear falloff to the gun's
      range, shell-by-shell reloads that firing interrupts, random kick.
- [x] Autosniper accuracy (recovers with time between shots), bolt-action
      scope drop, scoped run speeds, CS zoom magnification.
- [x] Bullet penetration (FireBullets3): calibre power / range, weapon
      penetration count, material classes (metal / concrete / tile / wood),
      damage per material, players passed through; wallbang marker (WB) in
      the kill feed and exit marks.
- [x] Deploy times (0.75 s, Scout 1.25 s, AWP 1.45 s).
- [x] Dropped weapons: G drops the gun in hand, the dead drop their best
      gun, buying over a gun drops the old one, walk over to pick up (with
      its ammo and silencer state); cleared each round.
- [x] Buy menu in CS 1.6 layout and numbering (1-8, 6/7 buy ammo directly).
- [x] Blender models for every new gun (+ suppressed M4A1 / USP), sounds,
      crosshairs; bots buy the whole arsenal.
- [x] `server/weapons.test.js`.
- [ ] Later: per-weapon viewmodel animations (pump / bolt / silencer screw),
      night vision, tactical shield.

## M10 — Round, economy and rules parity  [done]
- [x] Money from cstrike's REWARD_* table: $300 per kill (knife too),
      team kill -$3300 (and -1 frag), elimination win $3000, detonation
      $3500, defuse $3250, time win $3250 (bomb saved / hostages kept), all
      hostages rescued $2500 (+$750 per rescue to the team), plant bonus
      $800, loss bonus 1400 -> 2000 -> 2500 -> 3000.
- [x] Rules presets as mp_* cvars (shared/rules.js), chosen per room from
      the menu: Casual (2:30, first to 8) and Competitive MR15 (30 rounds,
      first to 16, 1:45 rounds, 15 s freeze, 15 s buy, c4timer 35,
      friendly fire).
- [x] Friendly fire at CS's 35 % for bullets and HE, "attacked a
      teammate" messages; bots hold fire when a teammate is in the way.
- [x] CS scoreboard: score / deaths / latency, DEAD and BOMB markers,
      players and alive per team, map + rules + round; ping measured.
- [x] `server/rules.test.js`.

## M11 — Netcode parity  [done]
- [x] Usercmds: the client sends its inputs (keys, view angles, frame time,
      sequence number) every frame; the server runs the shared physics on
      them and owns the position (fall damage, tagging, ladders included).
      A real-time budget drops commands sent faster than the clock.
- [x] Client prediction + reconciliation: each snapshot is followed by
      `you` (last command applied + physics state); unacknowledged commands
      are replayed on top, small errors blended out on the camera.
- [x] Interpolation buffer: remote players are drawn at view time (server
      time - cl_interp 50..100 ms) between the two snapshots around it.
- [x] Lag compensation: 1 s of position history per player; shots are
      tested against hit boxes rewound to the shooter's view time (capped at
      sv_maxunlag 0.5 s).
- [x] Tickrate / updaterate per room: Casual 33 / 30 Hz, Competitive
      66 / 60 Hz; leaner snapshots (~27 KB/s for a 3v3).
- [x] net_graph overlay (fps, ping, in/out rate, updaterate, tickrate,
      interp, pending commands) — Settings.
- [x] `server/netcode.test.js`.

## M12 — HUD and UX parity  [done]
- [x] CS 1.6 HUD layout and colours: orange digits, health / armour
      bottom-left, round clock bottom-centre, money + ammo bottom-right.
- [x] Kill feed with weapon icons (silhouettes rendered from the weapon
      models in Blender: art/blender/build_killicons.py), HS / WB tags.
- [x] Team menu (M): Terrorists / Counter-Terrorists / auto-select,
      mp_limitteams 2, switching while alive kills you (no death counted).
- [x] Message of the day on joining (MOTD env var or a room summary);
      never takes the mouse away from the game.
- [x] Spectating: first person / chase cam / free look (JUMP cycles,
      FIRE next player); mp_forcecamera: team-only in competitive.
- [x] Console (`~`): sensitivity (CS scale), m_pitch, zoom_sensitivity_ratio
      (zoomed sensitivity now scales), volume, fps_max, net_graph,
      cl_crosshair_color / _size / _translucent, cl_dynamiccrosshair, name;
      bind / unbind / binds / resetbinds, status, kill, say, jointeam,
      buy / autobuy / rebuy / buyammo1 / buyammo2, disconnect, retry.
      Settings persist (config).
- [x] Key bindings: every action rebindable (bind f +duck …); the game
      listens to actions, not keys.
- [ ] Later: spectator overview map, VGUI buy menu art, custom HUD fonts.

## M13 — Audio parity  [done]
- [x] Footsteps by surface from each map's textures: sand, stone, metal,
      wood, water, and new snow / carpet / tile; ladder rungs; landings.
- [x] Air absorption: gunfire loses its top end with distance (distant
      shots thud), on top of HRTF panning and wall muffling.
- [x] Spent casings on the floor after each shot (brass / shotgun hulls),
      heard from nearby players too; AWP / Scout bolt cycle after a shot.
- [x] Reloads by weapon family: pistol slide, rifle bolt, M249 box + belt,
      shotgun shells one by one; draw sounds (knife shing, pistol slide).
- [x] Hostage voices when they follow / stay; full CS radio set (Z / X / V).
- [x] C4: beep gap shrinking from ~1.4 s to 0.1 s, tone rising each fifth
      of the fuse, a rapid burst in the last 1.5 s.

## M14 — Bot parity (CS ZBot)  [done]
- [x] Nav spots per map: hiding spots (lowest exposure from sampled
      viewpoints) and sniper spots (long clear lines to a target).
- [x] Difficulty profiles Easy / Normal / Hard / Expert: reaction time,
      aim error + turn speed, attention (fov, sight), aggression (chase
      contacts or hold), teamwork (follow the plan or freelance).
- [x] Team economy decided at freeze time: pistol / eco (save, maybe a
      pistol or flash) / force (spend it all) / full buy.
- [x] T plans: rush, split (half the team through a detour, same site),
      default (take map control from hiding spots, execute after ~35 s).
- [x] CT: spread over the sites, scoped rifles hold sniper spots facing the
      site, shared intel -> rotate to the site enemies keep showing up at
      (one anchor stays), everyone to a planted bomb.
- [x] Saving: last player alive against 3+ late in the round hides and
      keeps the rifle (radio "Team, fall back!").
- [x] `server/bots.test.js`; sims report plans / economy per round.

## M15 — Map parity  [done]
- [x] Map author format: open areas (x/z extents, floor height, optional
      roof) carved out of solid by shared/mapgen.js into merged wall,
      raised-floor and roof boxes — classic-scale layouts in a few dozen
      lines.
- [x] de_aq_dust2: dust2-style flow (long A through the long doors, short A
      up the catwalk, mid doors, roofed upper / lower tunnels to B, CT spawn
      between the sites), lit tunnels, props, baked in Blender.
- [x] Doors (func_door): E slides them, collision moves on server and
      client, bots open doors on their route; reset each round.
- [x] Breakable glass (func_breakable): bullets shatter it and carry on,
      restored each round; cs_aq_office's lobby windows are glass now.
- [x] tools/validate-maps.mjs in the test suite: routes to every
      objective, spawns / hostages clear of geometry, collider budget.
- [ ] Later: nuke / train-style layouts, vents, more ladders.

## M16 — Modes and servers
- [ ] VIP (as_) mode, deathmatch / warmup DM, custom room settings.
- [ ] Server browser, persistent stats, admin kick / ban, anti-cheat
      (rate limits, PVS-lite so hidden enemies are not sent).

## M17 — Performance
- [ ] Model LOD + instancing, texture atlases, 144 fps on integrated GPUs,
      quality presets verified on older hardware.
