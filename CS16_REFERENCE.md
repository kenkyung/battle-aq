# CS 1.6 Reference — Battle-AQ

Every number on this page is from Counter-Strike 1.6 (HL1 engine, 1999/2004
re-release). It is the single source of truth that gameplay code, AI
behavior, and asset budgets compare themselves against.

When the spec says "tune to feel like 1.6", tune to these numbers, not to
memory or to modern CS:GO values.

If a number is missing here, the delegated agent must look it up before
inventing a value. Do **not** substitute CS:GO / CS2 numbers; the physics
model is different (no inaccuracy cones per-spray, no movement inaccuracy,
no recoil reset curve — 1.6 is discrete and harsher).

---

## 1. Movement

| Quantity | Value | Notes |
|---|---|---|
| Max run speed | 250 u/s | Flat; no acceleration curve in 1.6 |
| Run speed (carrying bomb / heavy weapon) | 215 u/s | |
| Walk speed (hold +speed, default Shift) | 75 u/s | |
| Jump vertical velocity | ~270 u/s | Apex ~ 0.72 s; player can clear a 56-unit knee-high wall |
| Gravity | 800 u/s² | HL1 gravity; players fall fast |
| Air acceleration | none | You commit to your jump arc |
| Ground friction | ~4.0 | Instant direction changes are *possible* but visibly sticky |
| Stamina penalty | none | CS 1.6 removed stamina between 1.0 and 1.6 |
| Bunny-hop | not possible | The game lands you; you can't chain jumps for speed |
| Duck (crouch) speed multiplier | 0.4 | Crouch walking ≈ 100 u/s |
| Duck height | 36 u | Half standing height |
| Standing eye height | 64 u | |

**Godot tuning note**: Godot 4 uses metric units with default gravity 24
(its 3D scale, not real m/s²). We use the **relative** values, not literal
m/s². Engine tuning in `scripts/player.gd`:

```gdscript
const WALK_SPEED := 6.0     # ~250 u/s equivalent after engine scale
const JUMP_VELOCITY := 7.5  # ~270 u/s equivalent
const GRAVITY := 24.0       # tuned so fall matches 1.6 arc (~0.72 s apex)
```

These will need a touch of playtest — adjust until jump clears the same
height of crate as 1.6 does on its blockout.

---

## 2. Weapons (CS 1.6 numbers — what we ship in M2)

| Weapon | Damage (chest) | Damage (head) | Damage (legs) | Range mod | Rate of fire | Mag | Reload | Price |
|---|---|---|---|---|---|---|---|---|
| Knife | 20 (back: 100, slashes 18) | 2× | — | melee | — | — | — | $0 |
| Glock-18 | 20 | 50 | 11 | 0.75 @ 2000 u | 0.16 s/burst step | 20 | 2.5 s | $0 |
| USP .45 (CT) | 23 | 56 | 13 | 0.75 @ 2000 u | 0.18 s | 12 | 2.3 s | $0 |
| Desert Eagle | 47 | 233 | 30 | 0.85 @ 2200 u | 0.21 s | 7 | 2.2 s | $650 |
| MP5-Navy | 23 | 56 | 13 | 0.80 @ 1800 u | 0.09 s | 30 | 2.5 s | $1500 |
| AK-47 (T) | 31 | 96 | 18 | 0.78 @ 2200 u | 0.10 s | 30 | 2.5 s | $2500 |
| M4A1 (CT) | 28 | 84 | 16 | 0.78 @ 2200 u | 0.09 s | 30 | 3.0 s | $3100 |
| AWP | 115 | 437 | 55 | 1.00 @ 4500 u | 1.50 s | 10 | 3.0 s | $4750 |
| Scout (SSG 08) | 75 | 188 | 28 | 0.95 @ 3000 u | 1.35 s | 10 | 3.0 s | $1700 |

Headshot multiplier is ≈ 3× body in 1.6 (AK 31 chest → 96 head = 3.1×).
Damage falls off *linearly* between `0` and `range_mod` units; flat beyond.

The sniper rifles are special:
- AWP: kill in 1 to chest/head at any practical range; leg shot does 55.
- Scout: same multiplier pattern, but leg shots don't kill in one hit past close range.

---

## 3. Recoil & accuracy (the most-imitated part of CS 1.6)

1.6 has **two** accuracy states:
- **Static**: weapons have a tight cone; the cone grows with each shot until a
  cap, then snaps back to static when the player stops firing.
- **Moving**: cone is huge; jumping is worse; running is worse than walking.

Per-shot recoil is **deterministic, model-attached**. Memorising the spray
pattern is the skill.

| Weapon | Static cone (deg) | Max recoil cone (deg) | Recovery | Notes |
|---|---|---|---|---|
| Glock | 1.50 | 6.50 | ~0.4 s | |
| USP | 1.40 | 5.75 | ~0.4 s | |
| Desert Eagle | 0.50 | 4.00 | ~0.5 s | First shot is pinpoint |
| MP5 | 1.85 | 5.50 | ~0.3 s | |
| AK-47 | 0.75 | 6.30 | ~0.4 s | Famous 10-bullet "up-then-left-then-right" pattern |
| M4A1 | 0.55 | 5.10 | ~0.4 s | |
| AWP | 0.20 | 0.20 | n/a | No spray; scopes in for 1.5 s |
| Scout | 0.30 | 0.30 | n/a | No spray |

**Cone growth per shot**: bullets 1–10 in a burst each add ~5–10% of the
max-recoil increment; bullet 11+ holds at the cap. CS 1.6 has no
*reset* — recovery only happens after fire stops.

**In-air multiplier**: ~3× cone.
**Running multiplier**: ~2× cone.

In `weapon_data.gd`, model this as:

```gdscript
var static_cone_deg: float      # at shot 1
var per_shot_increment: float   # additive cone per shot, capped at max
var max_cone_deg: float
var air_multiplier: float = 3.0
var run_multiplier: float = 2.0
var recovery_per_second: float  # cone decays toward static once fire stops
```

---

## 4. Hit registration (server-side)

- Server raycasts; the cone is sampled server-side, not client-predicted.
- Hits register at the victim's *current* server position — no lag
  compensation in 1.6. We keep this for M1 (favour-the-defender model).
- Bullets penetrate thin wood and sheet metal with damage falloff:
  - Wood: ×0.7
  - Metal: ×0.5
  - Concrete: ×0 (full block)
- Hitboxes: head (×3.0), chest (×1.0), stomach (×0.95), arms (×0.7), legs (×0.65).
  CS 1.6 arms shot multiplier is sometimes listed as 0.85; we use 0.7 to
  keep arms as a viable cover element (subject to playtest).

---

## 5. Round structure (CS 1.6 defaults)

| Quantity | Value |
|---|---|
| Freeze time (buy time) | 15 s |
| Round time | 1 m 55 s |
| Bomb timer | 35 s |
| Bomb defuse time (no kit) | 10 s |
| Bomb defuse time (with kit) | 5 s |
| Max rounds | 30 |
| Half time at round | 13 |
| Team money cap | $16000 |
| Loss bonus per round lost (1/2/3/4/5+) | $1400 / $1900 / $2400 / $2900 / $3400 |
| Start money | $800 |
| Win bonus (T) | $3250 |
| Win bonus (CT) | $3250 (defuse) / $3500 (kill all) |

These constants live in `scripts/game_state.gd` and `scripts/economy.gd`.

---

## 6. Map authoring conventions (CS 1.6)

CS 1.6 maps have a distinctive grid + vertex-edited geometry. We will not
match that editor workflow (it's Hammer for Half-Life). We **will** match:

- **64-unit grid**. All map geometry snaps to 64u in M4.
- **Two-storeys are common**: catwalks, heaven, ladder rooms, pits.
- **Mid + two bombsites + two spawns** is the standard topology for
  defusal maps.
- **Tunnels and doorways** create rotations and ambush points; every map
  should have at least one.
- **Skybox dimensions**: large enough that snipers feel the range
  (de_dust2's Long A is ~ 4000 units of sightline).

### Map dimensions to aim for (rough)

- de_dust2: ~ 4500 × 3500 u footprint
- cs_inferno: ~ 3800 × 3000 u
- de_aztec: ~ 4200 × 3200 u

We scale to fit these dimensions in 1.6 units, then adjust in Godot.

---

## 7. Visuals ("de_" + CS 1.6 look)

- **Beige / tan / adobe** palettes, bright natural lighting.
- **No bloom**, no SSAO, no dynamic GI. Lightmaps only. This is what makes
  1.6 readable on a potato.
- **Animated textures** (water, fans, signs) at 5–10 fps, not 30+.
- **No decals** except bullet holes (sparse).

---

## 8. Source notes

Values cross-referenced from:
- `https://counterstrike.fandom.com/wiki/Weapons_and_equipment_(Counter-Strike)`
- `https://www.unknownworlds.com/cs/weapons.html` (archived)
- `https://steamcommunity.com/sharedfiles/filedetails/?id=2754698141`
  (1.6 reference table)
- Halflife-provided `sk_func_*` entity source for movement constants

When this document disagrees with intuition, the document wins. Re-derive
from gameplay if you think a number is wrong, then update this file in the
same PR.