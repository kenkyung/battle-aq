class_name Weapon
extends Node3D
## Runtime instance of a WeaponData archetype: magazine state, fire-rate gate,
## and burst bookkeeping. The node itself is the viewmodel root under
## Head/Camera/WeaponAnchor; `viewmodel_scene` is attached here once blockout
## gives way to art (see ARCHITECTURE.md §4 performance budgets).
##
## M1/M2 keeps this server-agnostic on purpose: `player.gd` owns ammo RPCs and
## the server validates. This class only models the numbers.

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


## Single fire gate: consumes a round, timestamps the shot, advances the burst
## counter. Returns false when the weapon could not actually fire.
func try_fire(now_ms: int) -> bool:
	if not can_fire(now_ms):
		return false
	ammo_in_mag -= 1
	last_fire_time_ms = now_ms
	burst_count += 1
	return true


## Decay the burst/cone state once the trigger is released. Returns the
## current cone in degrees for the caller's hit-scan sampling.
func update_recovery(delta: float, firing: bool) -> float:
	if firing:
		return data.cone_after_shot(burst_count)
	burst_count = 0
	return data.static_cone_deg
