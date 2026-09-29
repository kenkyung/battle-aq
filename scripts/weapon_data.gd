extends Resource
## Weapon archetype data. Values come from CS16_REFERENCE.md §2 (damage, mag,
## reload, price) and §3 (recoil cone model). One `.tres` per weapon lives in
## `scripts/weapons/`.
##
## This resource is pure data — no behaviour. `weapon.gd` consumes it.

class_name WeaponData

@export var id: String
@export var display_name: String
@export var price: int

## Damage per hit, already rolled up: damage_head includes the ~3x headshot
## multiplier from CS16_REFERENCE.md §2.
@export var damage_body: float
@export var damage_head: float
@export var damage_legs: float
@export var damage_arms: float

## Range model (CS16_REFERENCE.md §2): damage falls off linearly between 0 and
## `range_mod` units, then stays flat out to `max_range`.
@export var range_mod: float
@export var max_range: float

@export var rate_of_fire: float       # seconds between shots
@export var magazine_size: int
@export var reload_time: float

## Accuracy cones, degrees. Grows additively per shot, capped at max_cone_deg,
## decays back toward static_cone_deg at recovery_per_second once fire stops.
@export var static_cone_deg: float
@export var max_cone_deg: float
@export var per_shot_increment_deg: float
@export var recovery_per_second: float

@export var air_multiplier: float = 3.0
@export var run_multiplier: float = 2.0
@export var kills_bullets_per_kill: int = 1  # most are 1, AWP is 1

@export var is_automatic: bool = false
@export var zoom_fov: float = 0.0            # 0 = no scope
@export var zoom_time: float = 0.0

@export var viewmodel_scene: String
@export var worldmodel_scene: String
