extends RefCounted
## The eight CS 1.6 weapons, as data. Every number here comes from
## CS16_REFERENCE.md §2 (damage / rate / mag / reload / price) and §3 (accuracy
## cones) — do not "balance" these by hand, edit the reference first.
##
## The brief calls for "8 weapons" but enumerates nine entries (Knife, Glock,
## USP, Deagle, MP5, AK, M4A1, AWP, Scout): the knife is index 0 and carries
## the melee specifics from §2 (back stab 100 with the 3x head multiplier
## already applied = 300, which is how 1.6 actually resolves a back stab).
##
## Gap-filling decisions (the reference does not state these — flagged so the
## orchestrator can override):
##   - arms damage = body * 0.7 (CS16_REFERENCE.md §4 hitbox table)
##   - legs damage = the table value verbatim (values disagree slightly with
##     §4's 0.65 factor; §2 is the weapon table and wins)
##   - max_range = the range_mod figure for every gun, i.e. damage is flat
##     beyond range_mod (1.6 pistols/SMGs effectively keep full damage; the
##     AWP entry is explicitly "at any practical range"). Only the knife uses
##     a shorter 2000 u practical range.
##   - per_shot_increment_deg spread evenly so 10 shots reach max_cone_deg,
##     per §3 "bullets 1-10 each add ~5-10% of the max-recoil increment;
##     bullet 11+ holds at the cap".
##   - recovery_per_second from §3's "Recovery" column (~0.3-0.5 s full decay).
##   - zoom_fov / zoom_time from §3's AWP note ("scopes in for 1.5 s") and the
##     1.6 default 90 deg base FOV; the AWP aims at 40, the Scout at 55.
##   - viewmodel_scene / worldmodel_scene are empty: no art in M4 (blockout
##     only, and no player/world model by rule 10). A later art PR fills them.

const WEAPON_IDS: PackedStringArray = [
	"knife", "glock", "usp", "deagle", "mp5", "ak47", "m4a1", "awp", "scout",
]

## data[id] -> Dictionary of raw fields. Read via `make(id)` / `get_data(id)`.
const DATA: Dictionary = {
	"knife": {
		"id": "knife",
		"display_name": "Knife",
		"price": 0,
		"damage_body": 20.0,
		"damage_head": 60.0,
		"damage_legs": 14.0,
		"damage_arms": 14.0,
		"range_mod": 2000.0,
		"max_range": 2000.0,
		"rate_of_fire": 0.4,
		"magazine_size": 0,
		"reload_time": 0.0,
		"static_cone_deg": 0.0,
		"max_cone_deg": 0.0,
		"per_shot_increment_deg": 0.0,
		"recovery_per_second": 0.0,
		"air_multiplier": 1.0,
		"run_multiplier": 1.0,
		"is_automatic": false,
		"zoom_fov": 0.0,
		"zoom_time": 0.0,
		"viewmodel_scene": "",
		"worldmodel_scene": "",
	},
	"glock": {
		"id": "glock",
		"display_name": "Glock-18",
		"price": 0,
		"damage_body": 20.0,
		"damage_head": 50.0,
		"damage_legs": 11.0,
		"damage_arms": 14.0,
		"range_mod": 2000.0,
		"max_range": 2000.0,
		"rate_of_fire": 0.16,
		"magazine_size": 20,
		"reload_time": 2.5,
		"static_cone_deg": 1.50,
		"max_cone_deg": 6.50,
		"per_shot_increment_deg": 0.50,
		"recovery_per_second": 16.25,
		"air_multiplier": 3.0,
		"run_multiplier": 2.0,
		"is_automatic": false,
		"zoom_fov": 0.0,
		"zoom_time": 0.0,
		"viewmodel_scene": "",
		"worldmodel_scene": "",
	},
	"usp": {
		"id": "usp",
		"display_name": "USP .45",
		"price": 0,
		"damage_body": 23.0,
		"damage_head": 56.0,
		"damage_legs": 13.0,
		"damage_arms": 16.1,
		"range_mod": 2000.0,
		"max_range": 2000.0,
		"rate_of_fire": 0.18,
		"magazine_size": 12,
		"reload_time": 2.3,
		"static_cone_deg": 1.40,
		"max_cone_deg": 5.75,
		"per_shot_increment_deg": 0.44,
		"recovery_per_second": 14.375,
		"air_multiplier": 3.0,
		"run_multiplier": 2.0,
		"is_automatic": false,
		"zoom_fov": 0.0,
		"zoom_time": 0.0,
		"viewmodel_scene": "",
		"worldmodel_scene": "",
	},
	"deagle": {
		"id": "deagle",
		"display_name": "Desert Eagle",
		"price": 650,
		"damage_body": 47.0,
		"damage_head": 233.0,
		"damage_legs": 30.0,
		"damage_arms": 32.9,
		"range_mod": 2200.0,
		"max_range": 2200.0,
		"rate_of_fire": 0.21,
		"magazine_size": 7,
		"reload_time": 2.2,
		"static_cone_deg": 0.50,
		"max_cone_deg": 4.00,
		"per_shot_increment_deg": 0.35,
		"recovery_per_second": 8.0,
		"air_multiplier": 3.0,
		"run_multiplier": 2.0,
		"is_automatic": false,
		"zoom_fov": 0.0,
		"zoom_time": 0.0,
		"viewmodel_scene": "",
		"worldmodel_scene": "",
	},
	"mp5": {
		"id": "mp5",
		"display_name": "MP5-Navy",
		"price": 1500,
		"damage_body": 23.0,
		"damage_head": 56.0,
		"damage_legs": 13.0,
		"damage_arms": 16.1,
		"range_mod": 1800.0,
		"max_range": 1800.0,
		"rate_of_fire": 0.09,
		"magazine_size": 30,
		"reload_time": 2.5,
		"static_cone_deg": 1.85,
		"max_cone_deg": 5.50,
		"per_shot_increment_deg": 0.365,
		"recovery_per_second": 18.33,
		"air_multiplier": 3.0,
		"run_multiplier": 2.0,
		"is_automatic": true,
		"zoom_fov": 0.0,
		"zoom_time": 0.0,
		"viewmodel_scene": "",
		"worldmodel_scene": "",
	},
	"ak47": {
		"id": "ak47",
		"display_name": "AK-47",
		"price": 2500,
		"damage_body": 31.0,
		"damage_head": 96.0,
		"damage_legs": 18.0,
		"damage_arms": 21.7,
		"range_mod": 2200.0,
		"max_range": 2200.0,
		"rate_of_fire": 0.10,
		"magazine_size": 30,
		"reload_time": 2.5,
		"static_cone_deg": 0.75,
		"max_cone_deg": 6.30,
		"per_shot_increment_deg": 0.555,
		"recovery_per_second": 15.0,
		"air_multiplier": 3.0,
		"run_multiplier": 2.0,
		"is_automatic": true,
		"zoom_fov": 0.0,
		"zoom_time": 0.0,
		"viewmodel_scene": "",
		"worldmodel_scene": "",
	},
	"m4a1": {
		"id": "m4a1",
		"display_name": "M4A1",
		"price": 3100,
		"damage_body": 28.0,
		"damage_head": 84.0,
		"damage_legs": 16.0,
		"damage_arms": 19.6,
		"range_mod": 2200.0,
		"max_range": 2200.0,
		"rate_of_fire": 0.09,
		"magazine_size": 30,
		"reload_time": 3.0,
		"static_cone_deg": 0.55,
		"max_cone_deg": 5.10,
		"per_shot_increment_deg": 0.455,
		"recovery_per_second": 15.0,
		"air_multiplier": 3.0,
		"run_multiplier": 2.0,
		"is_automatic": true,
		"zoom_fov": 0.0,
		"zoom_time": 0.0,
		"viewmodel_scene": "",
		"worldmodel_scene": "",
	},
	"awp": {
		"id": "awp",
		"display_name": "AWP",
		"price": 4750,
		"damage_body": 115.0,
		"damage_head": 437.0,
		"damage_legs": 55.0,
		"damage_arms": 80.5,
		"range_mod": 4500.0,
		"max_range": 4500.0,
		"rate_of_fire": 1.50,
		"magazine_size": 10,
		"reload_time": 3.0,
		"static_cone_deg": 0.20,
		"max_cone_deg": 0.20,
		"per_shot_increment_deg": 0.0,
		"recovery_per_second": 0.0,
		"air_multiplier": 3.0,
		"run_multiplier": 2.0,
		"is_automatic": false,
		"zoom_fov": 40.0,
		"zoom_time": 1.5,
		"viewmodel_scene": "",
		"worldmodel_scene": "",
	},
	"scout": {
		"id": "scout",
		"display_name": "Scout",
		"price": 1700,
		"damage_body": 75.0,
		"damage_head": 188.0,
		"damage_legs": 28.0,
		"damage_arms": 52.5,
		"range_mod": 3000.0,
		"max_range": 3000.0,
		"rate_of_fire": 1.35,
		"magazine_size": 10,
		"reload_time": 3.0,
		"static_cone_deg": 0.30,
		"max_cone_deg": 0.30,
		"per_shot_increment_deg": 0.0,
		"recovery_per_second": 0.0,
		"air_multiplier": 3.0,
		"run_multiplier": 2.0,
		"is_automatic": false,
		"zoom_fov": 55.0,
		"zoom_time": 1.0,
		"viewmodel_scene": "",
		"worldmodel_scene": "",
	},
}


## Build a fresh WeaponData for `id`. Returns null (and pushes an error) for an
## unknown id so callers can fail loudly instead of shipping a default gun.
static func make(id: String) -> WeaponData:
	var raw: Dictionary = DATA.get(id, {})
	if raw.is_empty():
		push_error("weapons_manifest: unknown weapon id '%s'" % id)
		return null
	var d := WeaponData.new()
	for field: String in raw.keys():
		d.set(field, raw[field])
	return d


## All eight+nine archetypes, knife first. Fresh resources, no shared state.
static func make_all() -> Array[WeaponData]:
	var out: Array[WeaponData] = []
	for id: String in WEAPON_IDS:
		out.append(make(id))
	return out


## The same table as DATA, but keyed by display order for the buy menu.
static func price(weapon_id: String) -> int:
	return int(DATA.get(weapon_id, {}).get("price", 0))
