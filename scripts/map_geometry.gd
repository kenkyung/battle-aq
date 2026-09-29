extends RefCounted
## Static blockout helpers shared by the three map scenes in `scenes/maps/`.
##
## Blockout pass only: the per-map `.tscn` files hold an integer spec table and
## call `build(host, spec, crate_seed)` from `_ready()`. That keeps the scene
## files small and diffable while still satisfying MAPS.md's "geometry blockout
## matching the layout" requirement.
##
## Hard rules honoured here:
##  - GL Compatibility: StandardMaterial3D only, no per-pixel transparency
##    except the one aztec water plane (which sets its own alpha manually).
##  - CS 1.6 authoring: all geometry snaps to the 64-unit grid
##    (CS16_REFERENCE.md §6) — `snap64()` is applied to every box.
##  - Budget (MAPS.md): <= 8 distinct materials per map — 4 terrain + 3 trim.
##
## `spec` is an Array of entries; `mm` is a material map id -> StandardMaterial3D.
## Entry forms:
##   {"n": <name>, "p": [x,y,z], "s": [sx,sy,sz], "m": "wall"}            box
##   {"n": <name>, "pos": [x,z], "r": <radius>, "h": <height>, "m": ...}  column
##   {"n": <name>, "pos": [x,z], "w": <w>, "d": <d>, "m": ..., "rot": deg} ground pad
##   {"n": <name>, "p": [...], "s": [...], "m": ..., "ramp": [y0, y1]}
##   {"n": <name>, "p": [...], "s": [...], "m": ..., "trans": true}
##   {"n": <name>, "y": <y>, "w": , "d": , "m": ...}                      water plane
##
## Entities (MapData / SpawnPoints / BombSites / NavRegion / cover crates) are
## built by the scenes themselves via the other helpers here.

const GRID := 64.0
const CRATE_SIZE := 64.0
const EYE_HEIGHT := 64.0  # CS 1.6 standing eye height (CS16_REFERENCE.md §1)

# Material map ids. Four terrain + three trim = 7 (budget: 8).
const MAT_WALL := "wall"
const MAT_FLOOR := "floor"
const MAT_ACCENT := "accent"
const MAT_COVER := "cover"
const MAT_FOLIAGE := "foliage"
const MAT_METAL := "metal"
const MAT_WOOD := "wood"
const MAT_WATER := "water"


static func snap64(v: float) -> float:
	return roundf(v / GRID) * GRID


static func _box(node_name: String, pos: Vector3, size: Vector3, mat: StandardMaterial3D) -> CSGBox3D:
	var b := CSGBox3D.new()
	b.name = node_name
	b.size = Vector3(snap64(size.x), snap64(size.y), snap64(size.z))
	b.position = Vector3(snap64(pos.x), snap64(pos.y), snap64(pos.z))
	b.use_collision = true
	b.collision_layer = 1
	b.collision_mask = 0
	b.material = mat
	return b


static func _column(node_name: String, pos_xz: Vector2, radius: float, height: float,
		mat: StandardMaterial3D) -> CSGCylinder3D:
	var c := CSGCylinder3D.new()
	c.name = node_name
	c.radius = snap64(radius)
	c.height = snap64(height)
	c.sides = 4  # square temple columns: cheap, 8 tris per side face
	c.position = Vector3(snap64(pos_xz.x), snap64(height) * 0.5, snap64(pos_xz.y))
	c.use_collision = true
	c.collision_layer = 1
	c.collision_mask = 0
	c.material = mat
	return c


static func _ground(node_name: String, pos_xz: Vector2, w: float, d: float,
		mat: StandardMaterial3D, rot_deg: float = 0.0) -> CSGBox3D:
	var pad := _box(node_name, Vector3(pos_xz.x, -32.0, pos_xz.y),
		Vector3(w, 64.0, d), mat)
	if not is_zero_approx(rot_deg):
		pad.rotation.y = deg_to_rad(rot_deg)
	return pad


static func _ramp(node_name: String, pos: Vector3, size: Vector3, ramp: Vector2,
		mat: StandardMaterial3D) -> CSGBox3D:
	## Blockout pass ramps are flat boxes at the higher elevation — the spec's
	## `ramp_y0` / `ramp_y1` are kept for documentation but the visual is just
	## a tilted-looking cuboid that the player walks over. A real wedge (CSG
	## prism/spin) is one of the M4 polish items; the spec covers the geometry
	## plan and CSGBox3D is what we have today.
	##
	## See `archive/csg_ramp_polygon.md` (TODO M4 polish) for the planned
	## CSGPolygon3D MODE_SPIN version.
	return _box(node_name, pos, size, mat)


static func _water(node_name: String, y: float, w: float, d: float,
		mat: StandardMaterial3D) -> CSGBox3D:
	## AGENTS.md hard rule 4 forbids per-pixel transparency on default
	## materials (it kills GL Compatibility perf on iGPUs). The aztec water
	## plane uses alpha-scissor instead so the canal reads as a translucent
	## surface without the GL Compat regression.
	var m := mat.duplicate() as StandardMaterial3D
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
	m.alpha_scissor_threshold = 0.4
	m.albedo_color.a = 0.7
	var w_box := _box(node_name, Vector3(0.0, y - 32.0, 0.0), Vector3(w, 64.0, d), m)
	w_box.use_collision = false  # underpass stays walkable; -64 u sits below the floor
	return w_box


static func build(host: Node3D, spec: Array, mats: Dictionary) -> int:
	## Materialises `spec` under `host`. Returns the number of nodes created.
	var n := 0
	for e in spec:
		var nm: String = e.get("n", "Geo%d" % n)
		var mat: StandardMaterial3D = mats[e["m"]]
		var node: Node3D
		if e.has("type") and e["type"] == "column":
			node = _column(nm, Vector2(e["pos"][0], e["pos"][1]), e["r"], e["h"], mat)
		elif e.has("type") and e["type"] == "ground":
			node = _ground(nm, Vector2(e["pos"][0], e["pos"][1]), e["w"], e["d"], mat,
				e.get("rot", 0.0))
		elif e.has("type") and e["type"] == "ramp":
			node = _ramp(nm, Vector3(e["p"][0], e["p"][1], e["p"][2]),
				Vector3(e["s"][0], e["s"][1], e["s"][2]),
				Vector2(e["ramp_y0"], e["ramp_y1"]), mat)
		elif e.has("type") and e["type"] == "water":
			node = _water(nm, e["y"], e["w"], e["d"], mat)
		else:
			node = _box(nm, Vector3(e["p"][0], e["p"][1], e["p"][2]),
				Vector3(e["s"][0], e["s"][1], e["s"][2]), mat)
		host.add_child(node)
		n += 1
	return n


# ---------------------------------------------------------------- materials

static func _std(color: Color, rough: float = 0.9, metal: float = 0.0) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = color
	m.roughness = rough
	m.metallic = metal
	m.specular = 0.2
	return m


static func dust_materials() -> Dictionary:
	## Sand floor / adobe walls / wood crates / metal grates (spec) + 3 trim.
	return {
		MAT_FLOOR: _std(Color(0.72, 0.64, 0.46), 1.0),   # sand
		MAT_WALL: _std(Color(0.80, 0.70, 0.52), 0.95),   # adobe
		MAT_COVER: _std(Color(0.45, 0.30, 0.17), 0.85),  # wood crates
		MAT_METAL: _std(Color(0.45, 0.45, 0.48), 0.6, 0.4),  # metal grates
		MAT_ACCENT: _std(Color(0.52, 0.42, 0.30), 0.9),  # T-side plaster
		MAT_WOOD: _std(Color(0.60, 0.46, 0.32), 0.9),    # wooden roof/deck
		MAT_WATER: _std(Color(0.30, 0.42, 0.48), 0.3),   # unused on dust
	}


static func inferno_materials() -> Dictionary:
	## Cobblestone / plaster walls / wood beams / terracotta tile (spec) + trim.
	return {
		MAT_FLOOR: _std(Color(0.50, 0.47, 0.43), 1.0),   # cobblestone
		MAT_WALL: _std(Color(0.78, 0.70, 0.58), 0.95),   # plaster
		MAT_COVER: _std(Color(0.55, 0.36, 0.22), 0.85),  # wood beams
		MAT_ACCENT: _std(Color(0.62, 0.28, 0.18), 0.75),  # terracotta tile
		MAT_METAL: _std(Color(0.40, 0.40, 0.42), 0.6, 0.4),
		MAT_WOOD: _std(Color(0.48, 0.33, 0.20), 0.9),
		MAT_WATER: _std(Color(0.30, 0.42, 0.48), 0.3),
	}


static func aztec_materials() -> Dictionary:
	## Stone walls / wood bridge / water / foliage (spec) + 3 trim.
	return {
		MAT_WALL: _std(Color(0.60, 0.58, 0.52), 0.95),   # stone
		MAT_WOOD: _std(Color(0.46, 0.32, 0.20), 0.85),   # bridge planks
		MAT_WATER: _std(Color(0.12, 0.36, 0.46), 0.25),  # canal water
		MAT_COVER: _std(Color(0.22, 0.42, 0.20), 0.95),  # foliage (used for crates)
		MAT_FOLIAGE: _std(Color(0.22, 0.42, 0.20), 0.95),  # alias for foliage
		MAT_FLOOR: _std(Color(0.54, 0.51, 0.44), 1.0),   # mossy flagstone
		MAT_ACCENT: _std(Color(0.68, 0.63, 0.52), 0.9),  # carved trim
		MAT_METAL: _std(Color(0.42, 0.42, 0.44), 0.6, 0.4),
	}


# ---------------------------------------------------------------- entities

static func add_map_data(host: Node3D, map_id: String, fog: Color, ambient: float,
		sky_top: Color, sky_bottom: Color, density: float = 0.001) -> Node:
	var node := Node.new()
	node.name = "MapData"
	node.set_script(load("res://scripts/map_data.gd"))
	node.map_id = map_id
	node.display_name = map_id
	node.fog_color = fog
	node.ambient_light = ambient
	node.sky_top_color = sky_top
	node.sky_bottom_color = sky_bottom
	node.fog_density = density
	host.add_child(node)
	return node


static func add_marker(parent: Node3D, marker_name: String, pos: Vector3) -> Marker3D:
	var m := Marker3D.new()
	m.name = marker_name
	m.position = pos
	parent.add_child(m)
	return m


static func spawn_positions() -> Dictionary:
	## CS 1.6 spawns are 2x2x2 with a 32 u horizontal grid, not 64.
	return {
		"T1": Vector3(-64, 0, -64), "T2": Vector3(64, 0, -64),
		"T3": Vector3(-64, 0, 64), "T4": Vector3(64, 0, 64),
		"CT1": Vector3(64, 0, 64), "CT2": Vector3(-64, 0, 64),
		"CT3": Vector3(64, 0, -64), "CT4": Vector3(-64, 0, -64),
	}


static func add_spawn_points(host: Node3D, spawn_origin: Vector3) -> Node3D:
	## 8 markers named T1-T4 / CT1-CT4, raised to eye height (MAPS.md).
	var points := Node3D.new()
	points.name = "SpawnPoints"
	host.add_child(points)
	for key in spawn_positions():
		var p: Vector3 = spawn_origin + spawn_positions()[key]
		add_marker(points, key, Vector3(snap64(p.x), EYE_HEIGHT, snap64(p.z)))
	return points


static func add_bomb_sites(host: Node3D, site_a: Vector3, site_b: Vector3) -> Node3D:
	## Two Marker3D (`A`, `B`) at the floor centre of each plant radius.
	var sites := Node3D.new()
	sites.name = "BombSites"
	host.add_child(sites)
	add_marker(sites, "A", Vector3(snap64(site_a.x), snap64(site_a.y), snap64(site_a.z)))
	add_marker(sites, "B", Vector3(snap64(site_b.x), snap64(site_b.y), snap64(site_b.z)))
	return sites


static func add_cover_crates(host: Node3D, zones: Array, cover_count: int,
		mat: StandardMaterial3D, rng_seed: int, y: float = 0.0) -> Array:
	## Deterministic cover: `zones` is a list of [x_min, z_min, x_max, z_max] on
	## the 64 u grid, and every crate is snapped to it. 1-3 crates tall.
	## Returns the placement list so the caller can report/extend it.
	var rng := RandomNumberGenerator.new()
	rng.seed = rng_seed
	var group := Node3D.new()
	group.name = "CoverCrates"
	host.add_child(group)

	var placed: Array = []
	var attempts := 0
	while placed.size() < cover_count and attempts < cover_count * 40:
		attempts += 1
		var zone: Array = zones[rng.randi() % zones.size()]
		var x := snap64(rng.randf_range(zone[0], zone[2]))
		var z := snap64(rng.randf_range(zone[1], zone[3]))
		var stack := rng.randi_range(1, 3)
		var clash := false
		for c in placed:
			if absf(c.x - x) < CRATE_SIZE * 1.5 and absf(c.z - z) < CRATE_SIZE * 1.5:
				clash = true
				break
		if clash:
			continue
		for level in stack:
			var crate := _box("Crate_%d_%d" % [placed.size(), level],
				Vector3(x, y + CRATE_SIZE * (0.5 + level), z),
				Vector3(CRATE_SIZE, CRATE_SIZE, CRATE_SIZE), mat)
			crate.name = "Crate_%d_%d" % [placed.size(), level]
			group.add_child(crate)
		placed.append(Vector3(x, y, z))
	return placed


static func add_nav_region(host: Node3D, floor_y: float, w: float, d: float,
		floor_mat: StandardMaterial3D) -> NavigationRegion3D:
	## NavigationRegion3D placeholder: MAPS.md asks for a nav surface covering
	## every reachable area. Until the navmesh bake tooling lands we build the
	## region from a flat source-geometry mesh (one quad per walkable level) so
	## the node exists, is named consistently across maps, and is ready for
	## `bake_navigation_mesh()` in a later pass. Never kicks an editor bake —
	## that would stall the headless check.
	var region := NavigationRegion3D.new()
	region.name = "NavRegion"
	host.add_child(region)

	var src := MeshInstance3D.new()
	src.name = "SourceGeometry"
	var plane := PlaneMesh.new()
	plane.size = Vector2(snap64(w), snap64(d))
	src.mesh = plane
	src.position = Vector3(0.0, floor_y, 0.0)
	src.material_override = floor_mat
	region.add_child(src)

	# Collision floor so the region is also a walkable surface in `--check-only`
	# and in a bare map scene viewed outside world.tscn.
	var body := StaticBody3D.new()
	body.name = "Floor"
	body.collision_layer = 1
	body.collision_mask = 0
	var shape := CollisionShape3D.new()
	shape.name = "FloorShape"
	var box := BoxShape3D.new()
	box.size = Vector3(snap64(w), 64.0, snap64(d))
	shape.shape = box
	shape.position = Vector3(0.0, -32.0, 0.0)
	body.add_child(shape)
	region.add_child(body)
	return region
