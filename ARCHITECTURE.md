# Battle-AQ — Architecture

This document is the contract that every model and human contributor works
against. It defines module boundaries, the network model, the asset pipeline,
the multi-model workflow, and the non-negotiable performance budget.

If something is not specified here, the orchestrator (MiniMax-M3 / Claude
Sonnet-class) is the tiebreaker. Do not invent conventions in PRs.

---

## 1. Goals & constraints

| Goal | Target |
|---|---|
| Genre | Online multiplayer FPS, CS-inspired (round-based, two teams, buy + plant/defuse or TDM) |
| Engine | Godot 4.3+ GL Compatibility renderer |
| Frame budget | 60 fps at 1280×720 on Intel UHD 620 (2018-era iGPU) and Steam Deck |
| Network | Server-authoritative ENet, 16 players, ≤80 ms RTT p95 |
| Platforms (M6) | Linux, Windows, macOS, web (WebRTC transport fallback), Android |
| Total disk size | < 80 MB compressed |
| License | MIT |

The mobile-first renderer is the spine: **no per-pixel transparency, no MSAA, no
SDFGI, no volumetric fog, no SSAO on the player rig.** Everything else is fair
game but has to be opt-in and disabled on the low preset.

---

## 2. Top-level module layout

```
battle-aq/
├── project.godot                  # GL Compat, mobile-first preset
├── scripts/
│   ├── main.gd                    # Node: peer lifecycle, peer_id -> player map
│   ├── game_state.gd              # Node (autoload): round phase machine, score
│   ├── player.gd                  # CharacterBody3D: client-predicted look + movement
│   ├── weapon.gd                  # Resource-driven archetype (rifle/smg/pistol/knife)
│   ├── weapon_data.gd             # Resource: fire rate, damage, range, recoil, mag size
│   ├── hit_scan.gd                # Static helper for server-authoritative raycasts
│   ├── objective.gd               # Bomb plant/defuse state machine
│   ├── buy_menu.gd                # Control: round-time purchase UI
│   ├── hud.gd                     # Control: crosshair, HP, ammo, kill feed, timer
│   ├── scoreboard.gd              # Control: F3/Score panel
│   ├── network_codec.gd           # Centralised RPC + state-replication helpers
│   └── assets/
│       ├── blender_export.py      # Headless Blender GLTF exporter (CI-friendly)
│       ├── manifest_generator.gd  # Editor plugin: writes asset_manifest.json
│       └── shader_lint.gd          # CLI linter: GLSL syntax + perf hints
├── scenes/
│   ├── main.tscn                  # Root scene; holds peer + GameState
│   ├── main_menu.tscn             # Host / Join / Quit
│   ├── world.tscn                 # Current map + spawns + MultiplayerSpawner
│   ├── player.tscn                # Capsule + Head/Camera + WeaponAnchor + RayCast
│   ├── weapon.tscn                # Weapon visual root (viewmodel)
│   ├── buy_menu.tscn
│   ├── hud.tscn
│   └── maps/                      # Per-map .tscn files, one per scene
├── assets/
│   ├── materials/                 # .tres StandardMaterial3D files
│   ├── shaders/                   # .gdshader / .gdshaderinc
│   ├── sounds/                     # .ogg (Vorbis), <100 KB each
│   ├── maps/                      # Generated .glb imported to .tscn
│   ├── ui/                        # HUD textures + fonts
│   └── icon.svg
├── tools/
│   ├── blender/                   # .blend source files (gitignored)
│   └── asset_bake.py              # Entry point: glb -> .import + manifest entry
├── addons/
│   └── asset_manifest/            # Editor plugin source (committed)
├── ci/
│   └── godot_check.yml            # Headless syntax check
├── DESIGN.md                      # Token spec for designers (see design-md skill)
├── ARCHITECTURE.md                # ← this file
└── README.md
```

### Module rules

- `scripts/*` only depends on `scripts/` (no `addons/` imports from gameplay).
- `scripts/main.gd` is the **only** node that touches `multiplayer.multiplayer_peer`.
  Everything else receives the peer or game-state context as a parameter.
- All RPCs go through `network_codec.gd`. No raw `rpc()` / `rpc_id()` outside
  that file (enforced by a CI grep gate).
- Map files live in `scenes/maps/` and are loaded by `world.tscn` via
  `PackedScene.resource_path`. Server sends a single `start_round(map_id)`
  RPC and clients load it.

---

## 3. Network model

### Topology

- **Peer-to-peer with one authoritative peer** (the host) — Godot's `ENetMultiplayerPeer` on UDP/24816.
- The host runs physics, raycasts, scoring, objective state.
- Clients predict movement + look locally, send `intent` RPCs at most 30 Hz.
- State is replicated by `MultiplayerSynchronizer` (default sync rate 20 Hz).

### Authority table

| State | Owner | Synced? | Notes |
|---|---|---|---|
| Player position | Client (predicted) | Yes (sync) | Server reconciles on out-of-bounds |
| Player look yaw/pitch | Client | Yes (sync) | |
| Player HP | Server | Yes (sync) | Damage RPC = server only |
| Player ammo | Server | Yes (sync) | Reload RPC = server only |
| Player weapon_id | Server | Yes (sync) | |
| Projectile transform | Server | Yes (sync) | Spawn = server only |
| Round phase + timer | Server | RPC on change | |
| Score | Server | RPC on change | |
| Buy-menu purchase | Client → Server RPC | Single round-trip | |
| Chat | Client → Server RPC → broadcast | | |

### RPC surface (`network_codec.gd`)

```gdscript
# Intent (client → server, unreliable, rate-limited 30 Hz)
@rpc("any_peer", "unreliable_ordered") func intent_move(direction: Vector3, ts_ms: int)
@rpc("any_peer", "unreliable_ordered") func intent_look(yaw: float, pitch: float)

# Actions (client → server, reliable)
@rpc("any_peer", "call_remote", "reliable") func intent_fire()
@rpc("any_peer", "call_remote", "reliable") func intent_reload()
@rpc("any_peer", "call_remote", "reliable") func intent_buy(item_id: String)
@rpc("any_peer", "call_remote", "reliable") func chat(text: String)

# State (server → all, reliable)
@rpc("authority", "call_local", "reliable") func round_state(phase: int, timer: float, score_t: int, score_ct: int)
@rpc("authority", "call_local", "reliable") func kill_feed(killer_id: int, victim_id: int, weapon_id: String)
```

### Lag compensation (stretch, M6+)

M1 ships with no lag comp — server hits at the victim's current position,
honest "favour the defender" model. Lag comp lives in `hit_scan.gd` behind a
feature flag, off by default.

---

## 4. Asset pipeline

Source-of-truth art lives as `.blend` files in `tools/blender/`. CI bakes them
to `.glb` and Godot imports them into `.scn` companions in `assets/maps/`.

### Pipeline

```
.blend  →  tools/asset_bake.py  →  .glb  →  Godot import  →  .scn (companion)
                                                              ↓
                                                  addons/asset_manifest/
                                                  writes asset_manifest.json
```

### Tooling ownership

- **`tools/blender/*.blend`**: created by humans or generated by Kimi K2 from
  description prompts. The Blender Python script `assets/blender_export.py`
  is what Kimi *writes* (DeepSeek can also write it — both are coding tasks,
  not visual tasks).
- **GLSL shaders / `StandardMaterial3D` .tres**: Kimi K2 writes.
- **`scripts/` gameplay code**: DeepSeek writes, reviewed by orchestrator.
- **Map layout / level design**: orchestrator (me) blocks out; Kimi K2 reviews
  line-of-sight + readability; DeepSeek wires spawns + cover points.

### Performance budgets per asset

| Asset class | Vertex cap | Material rule | Texture size | Notes |
|---|---|---|---|---|
| Player viewmodel | 2 000 | 1 mat, no alpha | 256² | Always seen up close |
| Player worldmodel (other players) | 4 000 | 1 mat | 512² | LOD0; LOD1 ≤ 1 000 @ 256² |
| Weapon worldmodel | 1 500 | 1 mat | 256² | |
| Crate / prop | 500 | 1 mat, no alpha | 128² | InstancedMesh where possible |
| Map chunk (per 16 m³) | 8 000 | 1 shared mat | 512² + 1 lightmap | Lightmaps: 256² low, 1024² high |
| Skybox | 1 000 | 1 mat, backface | 1024² equirect | |
| Particle (bullet impact) | n/a | 1 mat, additive | 64² | Lifetime < 200 ms |

A CI step (`tools/asset_bake.py --verify`) loads every `.glb` and asserts the
budgets. Fail the PR.

### Asset manifest

`addons/asset_manifest/` writes `asset_manifest.json` at editor open + at every
material/mesh change:

```json
{
  "version": 1,
  "assets": [
    {
      "id": "weapon.rifle.ak.viewmodel",
      "path": "res://assets/maps/weapons/ak.glb",
      "vertex_count": 1834,
      "material": "weapon.metal.dark",
      "textures": ["albedo.png@256", "normal.png@256"]
    }
  ]
}
```

`weapon_data.gd` and `hud.gd` resolve IDs through the manifest, not paths.

---

## 5. Multi-model workflow

### Routing rules

| Task type | Model | Why |
|---|---|---|
| Gameplay `.gd` code | **DeepSeek** | Cheaper, strong at structured imperative code |
| Network code / RPC surface | **DeepSeek** | Same |
| Asset pipeline (Blender Python, importer scripts) | **DeepSeek** | Plain Python tooling |
| GLSL shaders / `StandardMaterial3D` presets | **Kimi K2** | Visual reasoning |
| Map design review (line-of-sight, sightlines, flow) | **Kimi K2** | Visual reasoning |
| Asset *concepts* and texture prompt drafts | **Kimi K2** | Visual reasoning |
| Code review (final gate before merge) | **Orchestrator (me)** | Tiebreak + ownership of ARCHITECTURE.md |
| Spec / architecture / orchestration | **Orchestrator (me)** | Single source of truth |
| 3D modeling `.blend` files (when generated) | Either — Kimi preferred for form/lighting, DeepSeek acceptable for prop LODs |

### How I delegate

For each work item:

1. I write a **task brief** that includes:
   - Module(s) affected + paths
   - Exact acceptance criteria (from ARCHITECTURE.md or ROADMAP.md)
   - "Do not touch" list (other modules, shared types, RPC surface)
   - Required output (file paths, no orphan code)
2. I pick the model per the routing table above.
3. I delegate to the corresponding CLI:
   - DeepSeek coding: `hermes -p "..." --provider deepseek --model deepseek-coder` (or via a codex/claude fallback if DeepSeek rate-limits)
   - Kimi K2 shaders: `hermes -p "..." --provider kimi-coding --model kimi-k2`
   - Heavy code work: spawn `claude -p` or `codex` for multi-turn review
4. I **verify the file landed** (`git status`, `wc -l`, syntax check via the
   editor's headless mode if available). A child claiming success is not
   verified success.

### Parallelism & isolation

- Independent work items → parallel `delegate_task` calls in one assistant turn.
- Code-touching tasks → spawned in a git worktree (`-w` flag) so they don't
  collide with each other. I merge in priority order.
- Asset work runs in `tools/blender/` (gitignored) until baked.

---

## 6. Controls

Traditional FPS. Bindings are defined in `project.godot` and **must not** be
changed by gameplay code.

| Action | Key | Mouse |
|---|---|---|
| Move forward / back / left / right | W / S / A / D | |
| Jump | Space | |
| Crouch (M3) | Ctrl | |
| Fire | | Left |
| Aim (M2) | | Right |
| Reload | R | |
| Weapon 1 / 2 / 3 / 4 | 1 / 2 / 3 / 4 | |
| Buy menu (M2) | B | |
| Scoreboard | Tab | |
| Chat | Y | |
| Pause / Settings | Esc | |
| Toggle console (dev) | ` | |

Mouse capture is owned by `player.gd` (sets `MOUSE_MODE_CAPTURED` on first
mouse motion, restores to `VISIBLE` on Esc). The menu scene restores visible
on exit.

---

## 7. Performance budget

| Frame budget | 16.6 ms (60 fps) |
| CPU cap (gameplay + render) | 10 ms |
| GPU cap (GL Compat) | 6 ms |
| Network sync | 1 ms |
| Margin | 1 ms |

### Hard caps

- Max dynamic lights per frame: 4 (excluding baked)
- Max real-time shadows: 1 (player only); all other shadows baked into lightmap
- Max simultaneous projectiles: 32
- Max particles per system: 64; max systems per frame: 8
- MultiplayerSynchronizer replication rate cap: 20 Hz

### Mobile preset (default)

```
rendering/renderer = "opengl3"
anti_aliasing/quality/msaa_3d = 0
anti_aliasing/quality/screen_space_aa = 0
scaling_3d/scale = 1.0
textures/default_filters/anisotropic_filtering_level = 0
```

---

## 8. Definition of done (per PR)

- [ ] Module listed in §2 only; no orphan files
- [ ] RPC surface unchanged, or change is reflected in `network_codec.gd` +
      ARCHITECTURE.md §3
- [ ] Performance budget (§7) respected; CI `asset_bake.py --verify` passes
- [ ] Headless `godot --check-only` passes
- [ ] One ticket per PR (ROADMAP.md)
- [ ] Commit message follows Conventional Commits
- [ ] Reviewer is **not** the author

---

## 9. Open questions (parking lot)

- Web transport: pure WebRTC peer (vs. WebSocket relay). Decide before M6.
- Voice chat: WebRTC datachannel or external Mumble. Decide before M5.
- Replays: ECS-style snapshot stream vs. demo file. Decide before M6.