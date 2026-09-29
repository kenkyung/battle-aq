class_name WeaponData
extends Resource
## One weapon archetype. Values are CS 1.6 numbers straight from
## CS16_REFERENCE.md §2 (damage, rate, mag, reload, price) and §3 (accuracy
## cones). Nothing here is CS:GO / CS2 derived — the 1.6 model is discrete:
## the cone grows per shot, holds at max_cone_deg, and only decays once fire
## stops (see `recovery_per_second`).

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


## Cone (degrees) after `shots_fired` consecutive shots, before movement
## multipliers. Shots 1..10 each add `per_shot_increment_deg`; shot 11+ holds
## at `max_cone_deg`. CS 1.6 has no per-shot reset while the trigger is held.
func cone_after_shot(shots_fired: int) -> float:
	var steps := mini(maxi(shots_fired, 0), 10)
	return minf(static_cone_deg + float(steps) * per_shot_increment_deg, max_cone_deg)


## `max_range` when the reference table specified one, otherwise the table's
## "practical range" (2000 u for melee) so a melee WeaponData is still valid.
func effective_max_range() -> float:
	return max_range if max_range > 0.0 else 2000.0
