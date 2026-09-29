# Battle-AQ — Kimi K3 Implementation Brief

This is the brief the orchestrator hands to **Kimi K3** (or any Kimi-class
model) when delegating M1's CS 1.6 physics pass and M4's three-map build.

The brief is deliberately Kimi-flavoured:

- it tells the model to read the existing truth files (`ARCHITECTURE.md`,
  `AGENTS.md`, `CS16_REFERENCE.md`, `MAPS.md`, `ROADMAP.md`) instead of
  re-deriving conventions
- it gives exact world coordinates for every spawn, bombsite, and
  landmark so geometry is reproducible
- it gives exact weapon numbers from `CS16_REFERENCE.md` so values
  don't drift
- it instructs the model to **not commit** — the orchestrator reviews
  the diff and merges, so a bad model run can't push directly to `main`

If you want to run this brief yourself, paste its contents as the user
message to Kimi. The doc lives at
`docs/kimi-k3-brief.md` so the orchestrator can version-control changes
to it.

---

The actual brief is below. It is large on purpose — Kimi K3 has a long
context and we want it to have everything it needs without round-trips.

---

You are Kimi K3, working as the **implementer** on a Godot 4 multiplayer FPS
project called "battle-aq". Your job is to take the existing scaffold at
the repo root and build out the gameplay, the three maps, the CS 1.6
physics, and the weapon system. The orchestrator (MiniMax-M3) owns the
spec — you execute.

# Battle-AQ — Implementation Brief for Kimi K3

## 1. What this game is

Online multiplayer first-person shooter in the lineage of Counter-Strike 1.6.
Two teams (T and CT), defusal objective (plant/defuse), round-based economy,
buy menu, 30-round match with halftime. Inspired by de_dust2, cs_inferno,
de_aztec — those three are the first maps.

Engine: **Godot 4.3+ with the GL Compatibility renderer**. Target: 60 fps at
1280x720 on Intel UHD 620 (2018 iGPU) and Steam Deck.

## 2. Where to find the truth (read these FIRST)

These files are already committed in the repo. Read them before writing any code:

- `ARCHITECTURE.md` — module layout, RPC surface, asset pipeline, perf budget
- `AGENTS.md` — hard rules every coding agent in this repo must follow
- `CS16_REFERENCE.md` — the exact CS 1.6 numbers (movement, weapons, recoil,
  accuracy, round structure, map conventions) you must match
- `MAPS.md` — the per-map module contract and design notes for each of the
  three maps
- `ROADMAP.md` — milestones M0–M6; you're working on M1 (CS 1.6 physics)
  and M4 (the three maps) in this batch

The scaffold is already there: `scripts/main.gd`, `scripts/player.gd`,
`scripts/game_state.gd`, `scripts/world.gd`, `scripts/main_menu.gd`,
`scenes/main.tscn`, `scenes/main_menu.tscn`, `scenes/world.tscn`,
`scenes/player.tscn`.

## 3. What you must build in this batch

### 3.1 Map data module

Create `scripts/map_data.gd`:

```gdscript
class_name MapData
extends Node

@export var map_id: String
@export var display_name: String
@export var fog_color: Color = Color(0.7, 0.65, 0.55)
@export var ambient_light: float = 0.7
@export var sky_top_color: Color = Color(0.55, 0.65, 0.75)
@export var sky_bottom_color: Color = Color(0.85, 0.78, 0.65)
@export var fog_density: float = 0.001
@export var skybox_path: String = ""
```

### 3.2 Three map scenes

For each of de_aq_dust, de_aq_inferno, de_aq_aztec, create
`scenes/maps/<id>.tscn` containing:

1. Root `Node3D` with `scripts/world.gd` attached
2. A `MapData` child node (script above) with the values specified below
3. A `SpawnPoints` `Node3D` with 8 markers: `T1`–`T4` and `CT1`–`CT4`
4. A `BombSites` `Node3D` with two `Marker3D` children named `A` and `B`
5. A `NavigationRegion3D` for navmesh (placeholder is fine for blockout)
6. Blockout geometry using `CSGBox3D` (cleaner than MeshInstance3D +
   CollisionShape3D pairs at blockout quality) with `CollisionShape3D`
   children on each

Use these coordinates. **They are 1.6-unit grid coordinates, mapped 1:1 to
Godot units. Snap geometry to 64-unit grid steps.**

#### de_aq_dust — inspired by de_dust2

3-lane layout, ~4500 x 3500 unit footprint.

- T Spawn: (-2200, 0, -1500)
- CT Spawn: (2200, 0, 1500)
- Bombsite A: (1900, 0, -1100), platform raised 64u
- Bombsite B: (-1100, 0, 1100), ground-level pit
- Mid Door: (0, 0, 0), 128u wide chokepoint
- Long A: corridor from T Ramp (-2200, 0, 800) running north to A Site
- Short A / Catwalk: upper route from T Spawn to A
- ~30 cover crates scattered between spawns and bombsites
- Two floor levels: ground at y=0, A Site platform at y=64
- Materials: 4 distinct StandardMaterial3D (sand floor, adobe walls,
  wood crates, metal grates)
- MapData colours: fog=(0.78, 0.72, 0.55), sky_top=(0.55, 0.65, 0.75),
  sky_bottom=(0.85, 0.78, 0.65), ambient=0.75

#### de_aq_inferno — inspired by cs_inferno

Medieval Italian town, Banana curve, Apartments. ~3800 x 3000 footprint.

- T Spawn: (-1600, 0, -1200)
- CT Spawn: (1500, 0, 1100)
- Bombsite A: (1500, 0, -800), has balcony overhang
- Bombsite B: (-1200, 0, 1000), accessed via Apartments multi-storey
- Banana corridor: curved path from T Spawn to mid, ~200u wide
- Two-storey building at (-400, 0, 400): ground + 64u upper level
- Balcony at A Site spanning x=1300..1700, y=128..192
- Materials: 4 distinct (cobblestone, plaster walls, wood beams, terracotta)
- MapData colours: fog=(0.55, 0.5, 0.45), sky_top=(0.45, 0.5, 0.6),
  sky_bottom=(0.65, 0.55, 0.45), ambient=0.6

#### de_aq_aztec — inspired by de_aztec

Aztec temple, water-filled canals. ~4200 x 3200 footprint.

- T Spawn: (-1900, 0, -1400)
- CT Spawn: (1900, 0, 1400)
- Bombsite A: temple bridge at (1400, 64, -800), 256u wide span over
  flooded underpass
- Water plane at y=-64 (underpass), translucent blue material
- Bombsite B: temple interior at (-1100, 0, 800), 4 columns
- Snipers' Nest: CT elevated at (1700, 128, 0), overlooks bridge approach
- Materials: 4 distinct (stone walls, wood bridge, water, foliage)
- MapData colours: fog=(0.45, 0.55, 0.55), sky_top=(0.5, 0.6, 0.7),
  sky_bottom=(0.6, 0.7, 0.6), ambient=0.7

### 3.3 Update world.tscn + scripts/world.gd

- Add a `WorldEnvironment` node if not already there. Add a
  `DirectionalLight3D` that respects the ambient light value.
- Make `scripts/world.gd` data-driven: a `apply_map_data(map_data: MapData)`
  function that configures fog colour, sky gradient, and ambient light.
- Reuse the existing geometry helper functions in world.gd; don't remove them.

### 3.4 CS 1.6 player physics tuning

Update `scripts/player.gd` to match `CS16_REFERENCE.md` §1:

- Keep `WALK_SPEED = 6.0`
- Set gravity to `32.0` so jump arc matches CS 1.6 feel (~0.47s apex)
- Add a `_is_crouching` boolean and `crouch_speed` constant (full
  implementation in next PR; this batch just adds the flags)
- Disable head-bob: camera is dead-stable in 1.6
- Keep `move_and_slide()` — works with the new gravity

### 3.5 Weapon system skeleton

Create `scripts/weapon_data.gd`:

```gdscript
class_name WeaponData
extends Resource

@export var id: String
@export var display_name: String
@export var price: int
@export var damage_body: float
@export var damage_head: float   # already includes the headshot multiplier
@export var damage_legs: float
@export var damage_arms: float
@export var range_mod: float      # units where damage = base
@export var max_range: float      # units; flat beyond range_mod up to here
@export var rate_of_fire: float   # seconds between shots
@export var magazine_size: int
@export var reload_time: float
@export var static_cone_deg: float
@export var max_cone_deg: float
@export var per_shot_increment_deg: float
@export var recovery_per_second: float
@export var air_multiplier: float = 3.0
@export var run_multiplier: float = 2.0
@export var is_automatic: bool = false
@export var zoom_fov: float = 0.0
@export var zoom_time: float = 0.0
@export var viewmodel_scene: String
@export var worldmodel_scene: String
```

Create `scripts/weapon.gd`:

```gdscript
class_name Weapon
extends Node3D

var data: WeaponData
var ammo_in_mag: int
var last_fire_time_ms: int = 0
var burst_count: int = 0

func _init(d: WeaponData) -> void:
    data = d
    ammo_in_mag = d.magazine_size

func can_fire(now_ms: int) -> bool:
    return ammo_in_mag > 0 and (now_ms - last_fire_time_ms) >= int(data.rate_of_fire * 1000.0)

func reload() -> void:
    ammo_in_mag = data.magazine_size
```

Create `scripts/weapons/weapons_manifest.gd` with the 8 weapons from
`CS16_REFERENCE.md` §2. Use those exact values — don't invent. The 8
weapons are: Knife, Glock-18, USP .45, Desert Eagle, MP5-Navy, AK-47,
M4A1, AWP, Scout. Define each as a const dictionary (or as a method that
returns a WeaponData) with every field populated from the reference table.

### 3.6 Update README and ROADMAP

Mark M4 done in `ROADMAP.md`. Add a "CS 1.6 physics tuning" sub-entry
under M1 marked complete.

## 4. Hard rules (you MUST follow these)

1. **All gameplay code in `scripts/`.** All maps in `scenes/maps/`. All
   docs in repo root. Nothing outside those locations.
2. **All RPCs go through `scripts/network_codec.gd`.** Don't add new RPCs
   in this batch. If you think one is needed, write a TODO comment and
   move on.
3. **GL Compatibility renderer.** StandardMaterial3D only. No MSAA, no
   SSAO, no SDFGI, no volumetric fog. Per-pixel transparency is forbidden
   on default materials — use alpha-test/discard instead.
4. **Server-authoritative networking.** Don't change `player.gd`'s
   raycast direction or its RPC structure.
5. **One ticket per PR** (this is the PR). Conventional Commits:
   `feat:`, `fix:`, `refactor:`, `perf:`, `test:`, `docs:`, `build:`.
   Lowercase. No emoji.
6. **Performance budget:** 16.6 ms/frame on UHD 620. ≤60 000 tris per
   map. ≤8 distinct materials per map. ≤24 distinct textures per map.
7. **Don't modify `ARCHITECTURE.md`, `AGENTS.md`, `CS16_REFERENCE.md`,
   `MAPS.md`** unless you find a real bug in them. If you do, fix the
   gameplay first, then the doc in the same change.
8. **Don't change `project.godot` input bindings.** They're already CS-style.
9. **No bot/AI.** Don't add one.
10. **No player model.** The capsule stays.
11. **No particles, no sounds, no textures.** Blockout only.

## 5. Process

1. Read `ARCHITECTURE.md`, `AGENTS.md`, `CS16_REFERENCE.md`, `MAPS.md`,
   `ROADMAP.md`, and the existing scripts/scenes. Plan internally.
2. Implement in this order:
   a. `scripts/map_data.gd`
   b. `scripts/weapon_data.gd` + `scripts/weapon.gd` +
      `scripts/weapons/weapons_manifest.gd`
   c. CS 1.6 player physics tweaks in `scripts/player.gd`
   d. Update `scripts/world.gd` to be data-driven; update
      `scenes/world.tscn` to include a `WorldEnvironment` and `DirectionalLight3D`
   e. Build `scenes/maps/de_aq_dust.tscn`
   f. Build `scenes/maps/de_aq_inferno.tscn`
   g. Build `scenes/maps/de_aq_aztec.tscn`
   h. Update `ROADMAP.md` and `README.md`
3. Self-verify:
   - Every file listed in §3.1–§3.6 exists
   - Spawn markers exist at the listed coordinates (read each .tscn to confirm)
   - Bombsite markers A and B exist on each map
   - Weapon values match CS16_REFERENCE.md §2 (diff them)
   - No raw `rpc()` outside `scripts/network_codec.gd`
   - No `MSAA`, `SSAO`, `SDFGI`, `volumetric` in any new or changed config
4. **Do not commit.** The orchestrator reviews the diff and commits.
   Just leave the files on disk.

## 6. Output

When done, print:

- A bullet list of every file you created or modified (absolute path +
  one-line description)
- The SHA you started from and the final SHA (`git rev-parse HEAD`)
- The output of `git status`
- A self-verify checklist with each item ✅ or ❌
- Any TODO items you left behind (where, why)

That's it. Don't ask questions in your final response — if something is
genuinely ambiguous, write a TODO comment in the relevant file and tell
the orchestrator in the output.