extends Node3D
## Blockout world root. Two jobs:
##
##  1. Legacy arena blockout (M0 scaffold) — `_build_legacy_blockout()` keeps the
##     original flat floor + crates + chokepoint so the pre-M4 smoke test still
##     has geometry. It only runs when the scene has no MapData child.
##  2. Map presentation — `apply_map_data()` drives the WorldEnvironment (fog +
##     sky gradient from the map's two sky colours) and the sun from a MapData
##     node, so a map scene is pure data: geometry + markers + MapData.
##
## All map scenes under scenes/maps/ attach this script. Geometry is authored as
## CSGBox3D + CollisionShape3D at blockout quality (MAPS.md), snapped to the
## 64-unit grid.

const LEGACY_FLOOR_SIZE := 60.0
const LEGACY_CRATE_COUNT := 12

@onready var world_environment: WorldEnvironment = get_node_or_null("WorldEnvironment")
@onready var sun: DirectionalLight3D = get_node_or_null("DirectionalLight3D")


func _ready() -> void:
	var data := get_map_data()
	if data:
		apply_map_data(data)
	else:
		_build_legacy_blockout()


# ------------------------------------------------------------ data-driven map

## The map's MapData child, or null for the legacy scaffold scene.
func get_map_data() -> MapData:
	for child in get_children():
		if child is MapData:
			return child
	return null


## Push a map's presentation data into the environment + sun. Safe to call more
## than once (e.g. on a map reload): it overwrites rather than accumulates.
func apply_map_data(map_data: MapData) -> void:
	if map_data == null:
		return
	map_id = map_data.map_id
	_apply_environment(map_data)
	_apply_sun(map_data)


## Current map id, mirrored from MapData so other scripts can read it off the
## world root without walking the tree.
var map_id: String = ""


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
	# Exponential depth fog; 1.6 maps read as hazy at range, not foggy up close.
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
	# The sun (below) is the only light; the sky does not add its own.
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


# -------------------------------------------------------- blockout primitives

## Adds a collision-backed block. `size` is the full extent, `centre` the world
## centre of the box, so a 64-unit-tall pad sitting on the ground is
## `add_block(Vector3(512, 64, 512), Vector3(x, 32, z), material)`.
func add_block(size: Vector3, centre: Vector3, material: Material = null) -> CSGBox3D:
	var box := CSGBox3D.new()
	box.size = size
	box.position = centre
	box.material = material
	box.collision_layer = 1
	box.collision_mask = 1
	box.use_collision = true
	add_child(box)
	return box


## Convenience wrapper: builds a StandardMaterial3D for the blockout palette
## (sand/stone, wood, metal) without a texture — blockout only, no textures in
## M4. `alpha_scissor` switches a material to discard-based transparency, which
## is the only transparency GL Compatibility allows on default materials.
func make_material(
	name: String,
	albedo: Color,
	roughness: float = 0.9,
	metallic: float = 0.0,
	alpha_scissor: bool = false
) -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.resource_name = name
	mat.albedo_color = albedo
	mat.roughness = roughness
	mat.metallic = metallic
	if alpha_scissor:
		mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
		mat.alpha_scissor_threshold = 0.5
	return mat


# ------------------------------------------------------------ legacy scaffold

## Original M0 arena: flat floor, a dozen crates, and the two-wall chokepoint.
## Kept verbatim in spirit so `scenes/world.tscn` still boots before a map is
## selected. Deterministic: seeded locally so the blockout is reproducible.
func _build_legacy_blockout() -> void:
	var floor_mesh := MeshInstance3D.new()
	floor_mesh.mesh = BoxMesh.new()
	(floor_mesh.mesh as BoxMesh).size = Vector3(LEGACY_FLOOR_SIZE, 0.2, LEGACY_FLOOR_SIZE)
	floor_mesh.position = Vector3(0, -0.1, 0)
	add_child(floor_mesh)

	# A static body so the legacy floor is not a walk-through visual.
	var floor_body := StaticBody3D.new()
	var floor_shape := CollisionShape3D.new()
	var floor_box := BoxShape3D.new()
	floor_box.size = Vector3(LEGACY_FLOOR_SIZE, 0.2, LEGACY_FLOOR_SIZE)
	floor_shape.shape = floor_box
	floor_body.position = Vector3(0, -0.1, 0)
	floor_body.add_child(floor_shape)
	add_child(floor_body)

	var rng := RandomNumberGenerator.new()
	rng.seed = 19990801  # cs 1.6 retail date; keeps the blockout reproducible
	for i in LEGACY_CRATE_COUNT:
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
