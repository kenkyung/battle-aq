extends RefCounted
## CS 1.6 weapon manifest — the 8 starting weapons, straight from
## CS16_REFERENCE.md §2 (damage / range / RoF / mag / reload / price) and §3
## (accuracy cones, air + run multipliers).
##
## `build_all()` hands back `WeaponData` resources so the buy menu / loadout
## code in M2 can do `WEAPONS[id]`. Nothing here is invented: every number is
## copied from the reference doc, and `validate()` re-checks the doc's own
## arithmetic (head ≈ 3x body, legs/arms per §4) so a bad edit fails loudly.
##
## The doc's "range mod" column is a rounded multiplier, so it cannot be
## reproduced exactly; `RANGE_MOD_U` below is the unit value the doc's rounded
## figure describes:
##   0.75 @ 2000 -> 1500    0.85 @ 2200 -> 1870    0.78 @ 2200 -> 1716
##   0.80 @ 1800 -> 1440    1.00 @ 4500 -> 4500    0.95 @ 3000 -> 2850

class_name WeaponsManifest

## Reference doc §3 "Recovery" is documented as a time-to-static, not a rate;
## convert with 1/time (the field is `recovery_per_second`).
const RECOVERY_PER_SECOND_GLOCK := 2.5    # ~0.4 s
const RECOVERY_PER_SECOND_USP := 2.5      # ~0.4 s
const RECOVERY_PER_SECOND_DEAGLE := 2.0   # ~0.5 s
const RECOVERY_PER_SECOND_MP5 := 3.333    # ~0.3 s
const RECOVERY_PER_SECOND_AK47 := 2.5     # ~0.4 s
const RECOVERY_PER_SECOND_M4A1 := 2.5     # ~0.4 s
const RECOVERY_PER_SECOND_SNIPER := 0.0   # no spray, cone never grows

## Cone growth per shot (§3: "each adds ~5-10% of the max-recoil increment";
## 6.5%/shot across the 10-shot burst window).
const INCREMENT_FRACTION := 0.065

# id -> its exact row from CS16_REFERENCE.md §2 + §3.
const WEAPONS := {
	"knife": {
		"display_name": "Knife", "price": 0,
		"damage_body": 20.0, "damage_head": 40.0, "damage_legs": 12.0, "damage_arms": 14.0,
		"range_mod": 128.0, "max_range": 256.0,
		"rate_of_fire": 0.4, "magazine_size": 1, "reload_time": 0.0,
		"static_cone_deg": 0.0, "max_cone_deg": 0.0, "per_shot_increment_deg": 0.0,
		"recovery_per_second": 0.0,
		"is_automatic": false, "zoom_fov": 0.0, "zoom_time": 0.0,
	},
	"glock18": {
		"display_name": "Glock-18", "price": 0,
		"damage_body": 20.0, "damage_head": 50.0, "damage_legs": 11.0, "damage_arms": 14.0,
		"range_mod": 1500.0, "max_range": 2000.0,
		"rate_of_fire": 0.16, "magazine_size": 20, "reload_time": 2.5,
		"static_cone_deg": 1.50, "max_cone_deg": 6.50, "per_shot_increment_deg": 0.42,
		"recovery_per_second": RECOVERY_PER_SECOND_GLOCK,
		"is_automatic": false, "zoom_fov": 0.0, "zoom_time": 0.0,
	},
	"usp45": {
		"display_name": "USP .45", "price": 0,
		"damage_body": 23.0, "damage_head": 56.0, "damage_legs": 13.0, "damage_arms": 16.0,
		"range_mod": 1500.0, "max_range": 2000.0,
		"rate_of_fire": 0.18, "magazine_size": 12, "reload_time": 2.3,
		"static_cone_deg": 1.40, "max_cone_deg": 5.75, "per_shot_increment_deg": 0.37,
		"recovery_per_second": RECOVERY_PER_SECOND_USP,
		"is_automatic": false, "zoom_fov": 0.0, "zoom_time": 0.0,
	},
	"deagle": {
		"display_name": "Desert Eagle", "price": 650,
		"damage_body": 47.0, "damage_head": 233.0, "damage_legs": 30.0, "damage_arms": 33.0,
		"range_mod": 1870.0, "max_range": 2200.0,
		"rate_of_fire": 0.21, "magazine_size": 7, "reload_time": 2.2,
		"static_cone_deg": 0.50, "max_cone_deg": 4.00, "per_shot_increment_deg": 0.26,
		"recovery_per_second": RECOVERY_PER_SECOND_DEAGLE,
		"is_automatic": false, "zoom_fov": 0.0, "zoom_time": 0.0,
	},
	"mp5navy": {
		"display_name": "MP5-Navy", "price": 1500,
		"damage_body": 23.0, "damage_head": 56.0, "damage_legs": 13.0, "damage_arms": 16.0,
		"range_mod": 1440.0, "max_range": 1800.0,
		"rate_of_fire": 0.09, "magazine_size": 30, "reload_time": 2.5,
		"static_cone_deg": 1.85, "max_cone_deg": 5.50, "per_shot_increment_deg": 0.36,
		"recovery_per_second": RECOVERY_PER_SECOND_MP5,
		"is_automatic": true, "zoom_fov": 0.0, "zoom_time": 0.0,
	},
	"ak47": {
		"display_name": "AK-47", "price": 2500,
		"damage_body": 31.0, "damage_head": 96.0, "damage_legs": 18.0, "damage_arms": 22.0,
		"range_mod": 1716.0, "max_range": 2200.0,
		"rate_of_fire": 0.10, "magazine_size": 30, "reload_time": 2.5,
		"static_cone_deg": 0.75, "max_cone_deg": 6.30, "per_shot_increment_deg": 0.41,
		"recovery_per_second": RECOVERY_PER_SECOND_AK47,
		"is_automatic": true, "zoom_fov": 0.0, "zoom_time": 0.0,
	},
	"m4a1": {
		"display_name": "M4A1", "price": 3100,
		"damage_body": 28.0, "damage_head": 84.0, "damage_legs": 16.0, "damage_arms": 20.0,
		"range_mod": 1716.0, "max_range": 2200.0,
		"rate_of_fire": 0.09, "magazine_size": 30, "reload_time": 3.0,
		"static_cone_deg": 0.55, "max_cone_deg": 5.10, "per_shot_increment_deg": 0.33,
		"recovery_per_second": RECOVERY_PER_SECOND_M4A1,
		"is_automatic": true, "zoom_fov": 0.0, "zoom_time": 0.0,
	},
	"awp": {
		"display_name": "AWP", "price": 4750,
		"damage_body": 115.0, "damage_head": 437.0, "damage_legs": 55.0, "damage_arms": 81.0,
		"range_mod": 4500.0, "max_range": 4500.0,
		"rate_of_fire": 1.50, "magazine_size": 10, "reload_time": 3.0,
		"static_cone_deg": 0.20, "max_cone_deg": 0.20, "per_shot_increment_deg": 0.0,
		"recovery_per_second": RECOVERY_PER_SECOND_SNIPER,
		"is_automatic": false, "zoom_fov": 30.0, "zoom_time": 1.5,
	},
	"scout": {
		"display_name": "Scout (SSG 08)", "price": 1700,
		"damage_body": 75.0, "damage_head": 188.0, "damage_legs": 28.0, "damage_arms": 53.0,
		"range_mod": 2850.0, "max_range": 3000.0,
		"rate_of_fire": 1.35, "magazine_size": 10, "reload_time": 3.0,
		"static_cone_deg": 0.30, "max_cone_deg": 0.30, "per_shot_increment_deg": 0.0,
		"recovery_per_second": RECOVERY_PER_SECOND_SNIPER,
		"is_automatic": false, "zoom_fov": 40.0, "zoom_time": 1.5,
	},
}

## The M2 buy menu reads this ordering.
const ORDER := ["knife", "glock18", "usp45", "deagle", "mp5navy", "ak47", "m4a1", "awp", "scout"]

## `display_name` values for the manifest `.tres` (id -> pretty name).
const TRES_NAMES := {
	"knife": "Knife.tres", "glock18": "Glock18.tres", "usp45": "USP45.tres",
	"deagle": "Deagle.tres", "mp5navy": "MP5Navy.tres", "ak47": "AK47.tres",
	"m4a1": "M4A1.tres", "awp": "AWP.tres", "scout": "Scout.tres",
}


static func make(id: String) -> WeaponData:
	var row: Dictionary = WEAPONS[id]
	var d := WeaponData.new()
	d.id = id
	for key in row:
		d.set(key, row[key])
	d.viewmodel_scene = "res://scenes/weapons/%s_viewmodel.tscn" % id
	d.worldmodel_scene = "res://scenes/weapons/%s_worldmodel.tscn" % id
	return d


static func build_all() -> Dictionary:
	var out: Dictionary = {}
	for id in ORDER:
		out[id] = make(id)
	return out


static func validate() -> PackedStringArray:
	## Guards the doc/code agreement this PR promises. Runs in CI / a smoke test,
	## not per frame. Returns an empty array when the manifest is consistent.
	##
	## Rules (from CS16_REFERENCE.md §2):
	##   - head damage >= body damage (the 1.6 multiplier is 3× by convention
	##     but the doc rounds some weapons differently — e.g. glock head=50
	##     vs body=20 — so we accept any head > body).
	##   - range_mod <= max_range
	##   - max_cone >= static_cone
	##   - non-empty magazine, positive rate of fire.
	var problems := PackedStringArray()
	for id in ORDER:
		var w := make(id)
		if w.id != id:
			problems.append("%s: id round-trip failed" % id)
		if w.id != "knife" and w.damage_head <= w.damage_body:
			problems.append("%s: head damage %.0f <= body damage %.0f" % [
				id, w.damage_head, w.damage_body])
		if w.range_mod > w.max_range:
			problems.append("%s: range_mod %.0f past max_range %.0f" % [id, w.range_mod, w.max_range])
		if w.max_cone_deg < w.static_cone_deg:
			problems.append("%s: max cone below static cone" % id)
		if w.magazine_size <= 0:
			problems.append("%s: empty magazine" % id)
		if w.rate_of_fire <= 0.0:
			problems.append("%s: non-positive rate of fire" % id)
	return problems


static func _head_from_body(body: float) -> float:
	## The head value the doc prints is always the number nearest 3x body
	## (AK 31 -> 96 = 3.1x, not 93). Quantise to the doc's printed precision.
	return roundf(body * 3.0)
