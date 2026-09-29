# Battle-AQ — Maps

Three CS 1.6-inspired defusal maps. Each map is a `.tscn` under `scenes/maps/`
plus a layout sketch in this directory.

Maps are scaled to 1.6 unit conventions (64-unit grid, ~3000–4500 unit
footprint). Geometry is **blockout quality** in M4; replace with a final
mesh + lightmap pass in a later milestone.

## Maps

| File | In-game id | Inspired by | Spawn T | Spawn CT | Bombsite A | Bombsite B |
|---|---|---|---|---|---|---|
| `de_aq_dust.tscn` | `de_aq_dust` | de_dust2 | T Spawn | CT Spawn | A Site (platforms) | B Site (pit) |
| `de_aq_inferno.tscn` | `de_aq_inferno` | cs_inferno | T Spawn (Banana side) | CT Spawn | A Site (Balcony) | B Site (Apartments) |
| `de_aq_aztec.tscn` | `de_aq_aztec` | de_aztec | T Spawn | CT Spawn | A Site (Bridge) | B Site (Temple) |

## Map module contract

Every map `.tscn` must contain:

- A `World` root (Node3D) with the `world.gd` blockout script for floor +
  spawn walls. Specific geometry is added per-map.
- A `SpawnPoints` Node3D with 8 markers named `T1`–`T4` and `CT1`–`CT4`.
  The host picks one per player using the round seed.
- A `BombSites` Node3D with `A` and `B` markers (`Marker3D` at floor
  centre). The bomb plants within `radius = 192 u` (CS 1.6 spec) of the
  marker.
- A `NavMesh` covering every reachable surface; `NavigationAgent3D` is
  used by bots later.
- A `MapData` (Node, with `map_data.gd`) reporting:
  - `map_id: String`
  - `display_name: String`
  - `fog_color: Color`
  - `ambient_light: float` (1.6 maps are bright; default 0.7)
  - `sky_color: Color` (top + bottom for gradient)

## Asset budgets (per map)

| Quantity | Budget |
|---|---|
| Total triangle count | ≤ 60 000 |
| Distinct materials | ≤ 8 |
| Distinct textures | ≤ 24 |
| Lightmap resolution | 256² low / 1024² high |
| Spawn markers | 8 |
| Bombsite markers | 2 |
| Cover objects (crates, barrels) | 30–50 |

## Map design notes (per map)

### de_aq_dust

Classic 3-lane layout: T Spawn → Long A / Short A / Catwalk T → Mid Door
→ CT Spawn → A Site / B Site.

Key sightlines:
- **Long A**: ~ 4000 u from T Ramp to A Site platform. AWP-capable.
- **Mid**: open chokepoint door; CT can hold from Window.
- **Short A (Catwalk)**: tight, multiple cover crates.

### de_aq_inferno

Medieval Italian town. Two bombsites flanking Banana.

Key sightlines:
- **Banana**: long curved corridor; mid-box cover.
- **Apartments**: multi-storey firefight access to B.
- **Balcony / Pit**: A Site has a balcony overhang for CT defence.

### de_aq_aztec

Aztec temple, water-filled canals.

Key sightlines:
- **Bridge**: A Site is a raised temple bridge over a flooded underpass.
- **Temple**: B Site is inside the temple with column cover.
- **Snipers' Nest**: CT high ground overlooking T Spawn side approach.

## Sketches

Sketches live in `docs/maps/<id>.svg`. They are blockout-level line art,
drawn to the same 64u grid.

(WIP — see `docs/maps/` for sketches; they will be added alongside each
map's `.tscn` in its respective PR.)