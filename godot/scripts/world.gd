extends Node3D
## World root. Two jobs:
##
##  1. Map presentation — `apply_map_data()` drives the WorldEnvironment (fog +
##     sky gradient from the map's two sky colours) and the sun from a MapData
##     node, so a map scene is pure data: geometry + markers + MapData.
##  2. Legacy scaffold fallback — when no MapData child exists, the original
##     M0 blockout (flat floor + crates + chokepoint) is built so the smoke
##     test still boots before a map is selected.

@onready var world_environment: WorldEnvironment = get_node_or_null("WorldEnvironment")
@onready var sun: DirectionalLight3D = get_node_or_null("DirectionalLight3D")

## Current map id, mirrored from MapData so other scripts can read it off the
## world root without walking the tree.
var map_id: String = ""


func _ready() -> void:
	var data := get_map_data()
	if data:
		apply_map_data(data)
	else:
		_build_legacy_blockout()


## The map's MapData child, or null for the legacy scaffold scene.
func get_map_data() -> MapData:
	for child in get_children():
		if child is MapData:
			return child
	return null


## Push a map's presentation data into the environment + sun. Safe to call
## more than once (e.g. on a map reload): it overwrites rather than
## accumulates.
func apply_map_data(map_data: MapData) -> void:
	if map_data == null:
		return
	map_id = map_data.map_id
	_apply_environment(map_data)
	_apply_sun(map_data)


func _apply_environment(map_data: MapData) -> void:
	if world_environment == null:
		world_environment = WorldEnvironment.new()
		world_environment.name = "WorldEnvironment"
		add_child(world_environment)

	# GL Compatibility: no SSAO, no SDFGI, no glow, no volumetric fog. Only fog
	# + a procedural sky gradient (ARCHITECTURE.md §7 mobile preset).
	var env := Environment.new()
	env.background_mode = Environment.BG_SKY
	env.sky = _make_sky(map_data)
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.ambient_light_sky_contribution = 1.0
	env.ambient_light_color = map_data.sky_bottom_color
	env.ambient_light_energy = map_data.ambient_light
	env.fog_enabled = true
	env.fog_light_color = map_data.fog_color
	env.fog_density = map_data.fog_density
	env.fog_sky_affect = 0.0
	env.ssao_enabled = false
	env.ssil_enabled = false
	env.sdfgi_enabled = false
	env.glow_enabled = false
	env.volumetric_fog_enabled = false
	world_environment.environment = env


func _make_sky(map_data: MapData) -> Sky:
	var sky := Sky.new()
	var material := ProceduralSkyMaterial.new()
	material.sky_top_color = map_data.sky_top_color
	material.sky_horizon_color = map_data.sky_bottom_color
	material.sky_curve = 0.15
	material.ground_bottom_color = map_data.sky_bottom_color
	material.ground_horizon_color = map_data.sky_bottom_color
	material.ground_curve = 0.02
	material.sun_angle_max = 0.0
	material.sun_curve = 0.0
	sky.sky_material = material
	return sky


func _apply_sun(map_data: MapData) -> void:
	if sun == null:
		sun = DirectionalLight3D.new()
		sun.name = "DirectionalLight3D"
		sun.transform = Transform3D(Basis(Vector3.RIGHT, deg_to_rad(-45.0)), Vector3(0, 64, 0))
		add_child(sun)
	# 1.6 maps are bright and flat: one strong sun, no second shadow-caster
	# (ARCHITECTURE.md §7 caps real-time shadows at 1).
	sun.light_energy = map_data.ambient_light
	sun.light_color = map_data.sky_top_color.lerp(Color.WHITE, 0.5)
	sun.shadow_enabled = true
	sun.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_2_SPLITS
	sun.shadow_bias = 0.05


# ------------------------------------------------------------ legacy scaffold

## Original M0 arena. Deterministic: seeded so the blockout is reproducible.
func _build_legacy_blockout() -> void:
	var floor_mesh := MeshInstance3D.new()
	floor_mesh.mesh = BoxMesh.new()
	(floor_mesh.mesh as BoxMesh).size = Vector3(60, 0.2, 60)
	floor_mesh.position = Vector3(0, -0.1, 0)
	add_child(floor_mesh)

	# A static body so the legacy floor is not a walk-through visual.
	var floor_body := StaticBody3D.new()
	var floor_shape := CollisionShape3D.new()
	var floor_box := BoxShape3D.new()
	floor_box.size = Vector3(60, 0.2, 60)
	floor_shape.shape = floor_box
	floor_body.position = Vector3(0, -0.1, 0)
	floor_body.add_child(floor_shape)
	add_child(floor_body)

	var rng := RandomNumberGenerator.new()
	rng.seed = 19990801  # cs 1.6 retail date; keeps the blockout reproducible
	for i in 12:
		var crate := MeshInstance3D.new()
		crate.mesh = BoxMesh.new()
		var s := 1.5 + rng.randf() * 1.5
		(crate.mesh as BoxMesh).size = Vector3(s, s, s)
		crate.position = Vector3(
			rng.randf_range(-20.0, 20.0), s * 0.5, rng.randf_range(-20.0, 20.0)
		)
		add_child(crate)

	var wall_a := MeshInstance3D.new()
	wall_a.mesh = BoxMesh.new()
	(wall_a.mesh as BoxMesh).size = Vector3(8, 4, 1)
	wall_a.position = Vector3(-6, 2, 4)
	add_child(wall_a)

	var wall_b := MeshInstance3D.new()
	wall_b.mesh = BoxMesh.new()
	(wall_b.mesh as BoxMesh).size = Vector3(8, 4, 1)
	wall_b.position = Vector3(6, 2, -4)
	add_child(wall_b)