extends Node3D
## Weapon instance skeleton. Holds the `WeaponData` archetype plus this
## instance's runtime ammo state. `try_fire()` / cone growth land in M2; this PR
## ships the class shape + ammo reload only.

class_name Weapon

var data: WeaponData
var ammo_in_mag: int
var last_fire_time_ms: int = 0
var burst_count: int = 0


func _init(d: WeaponData) -> void:
    data = d
    ammo_in_mag = d.magazine_size


func can_reload() -> bool:
    return data != null and ammo_in_mag < data.magazine_size


func finish_reload() -> void:
    ## Called by the reload timer in M2; resupplies to a full magazine.
    if data != null:
        ammo_in_mag = data.magazine_size


func consume_round() -> bool:
    if ammo_in_mag <= 0:
        return false
    ammo_in_mag -= 1
    return true
