class_name MapData
extends Node
## Per-map presentation data. Every map scene carries exactly one of these as a
## direct child of its World root; `world.gd` reads it in `_ready()` and pushes
## the values into the `WorldEnvironment` (fog + sky) and the sun
## (ambient/sun energy). Authoring truth lives in MAPS.md.

@export var map_id: String
@export var display_name: String
@export var fog_color: Color = Color(0.7, 0.65, 0.55)
@export var ambient_light: float = 0.7
@export var sky_top_color: Color = Color(0.55, 0.65, 0.75)
@export var sky_bottom_color: Color = Color(0.85, 0.78, 0.65)
@export var fog_density: float = 0.001
@export var skybox_path: String = ""


## Number of 64-unit grid steps between a point's world position and the origin.
## Axes are evaluated independently (grid check, not Euclidean distance).
func grid_distance(a: Vector3, b: Vector3) -> int:
	return int(round(maxf(
		absf(a.x - b.x), maxf(absf(a.y - b.y), absf(a.z - b.z))
	) / 64.0))
