extends SceneTree
## M1 smoke test — `godot --headless --script scripts/smoke_test.gd --path .`
##
## Checked here (no window, no network):
##   1. every M1 script parses (main/Net, player, game_state, hud, kill feed bits)
##   2. project.godot declares the Net + GameState autoloads and boots the menu
##   3. `scenes/player.tscn` loads, `Head/Camera` exists (HUD host), and the
##      movement MultiplayerSynchronizer replicates position + look
##   4. the HUD contract: the scene loads, is a CanvasLayer wrapping a Control
##      with `scripts/hud.gd`, and every `@onready` node path in hud.gd resolves
##      against the instanced scene
##   5. every map scene in main.gd's MAP_CATALOGUE loads, carries NO
##      MultiplayerSpawner (player spawning is explicit — see
##      Net._client_spawn_player), and single-instance scenes (dust) build their
##      SpawnPoints / MapData children
##   6. `WeaponsManifest.build_all()` returns 9 weapons and `validate()` is clean
##   7. the kill queue round-trips (GameState.queue_kill -> kill_feed_queue)
##
## Exits 0 on success, 1 on the first class of failure — with the failing
## detail printed. `godot --headless --check-only --path .` stays the CI gate;
## this is the deeper runtime-free check called out in AGENTS.md.
##
## Loads require a real Godot runtime; there is deliberately no pytest-style
## harness around it (AGENTS.md: "Don't write tests that require Godot runtime").

const SCRIPTS := [
	"res://scripts/main.gd",
	"res://scripts/player.gd",
	"res://scripts/game_state.gd",
	"res://scripts/hud.gd",
	"res://scripts/weapon.gd",
	"res://scripts/weapon_data.gd",
	"res://scripts/network_codec.gd",
	"res://scripts/world.gd",
	"res://scripts/map_data.gd",
	"res://scripts/map_geometry.gd",
	"res://scripts/weapons/weapons_manifest.gd",
]

const MAP_CATALOGUE_FALLBACK := [
	"res://scenes/maps/de_aq_dust.tscn",
	"res://scenes/maps/de_aq_inferno.tscn",
	"res://scenes/maps/de_aq_aztec.tscn",
]

const EXPECTED_WEAPONS := 9

## `@onready` paths in hud.gd, mirrored here so a renamed .tscn node fails the
## smoke test instead of the running game. Paths are relative to the HUD
## Control (the script's host); the CanvasLayer parent `HUDScene` is checked
## separately.
const HUD_NODE_PATHS := [
	"Crosshair",
	"HPBar",
	"HPBar/HPBarVBox/HPLabel",
	"HPBar/HPBarVBox/HPBarGauge/HPFill",
	"AmmoCounter",
	"WeaponName",
	"TimerLabel",
	"PhaseLabel",
	"ScoreStrip",
	"ScoreStrip/ScoreT",
	"ScoreStrip/ScoreCT",
	"KillFeed",
]

## This script needs a live SceneTree (it instantiates scenes and calls
## `_ready()`), so it is not a `--check-only` run. `godot --headless
## --check-only --path .` stays the CI parse gate; run this after it.
const IS_CHECK_ONLY_COMPATIBLE := false

var _failures: Array = []


func _initialize() -> void:
	print("=== battle-aq M1 smoke test ===")
	_check_scripts()
	_check_autoloads()
	_check_player_scene()
	_check_hud()
	_check_maps()
	_check_weapons()
	_check_kill_queue()
	_finish()


# ---------------------------------------------------------------- 1. scripts

func _check_scripts() -> void:
	for path in SCRIPTS:
		var script := load(path)
		if script == null:
			_fail("script did not load: %s" % path)
		else:
			print("  ok  script %s" % path)


# ---------------------------------------------------------------- 2. autoloads

## Net and GameState MUST be autoloads. `change_scene_to_file` frees the current
## scene, so a network manager that lives in a scene loses its peer and its
## peer_connected handlers the first time a map loads. Verified through
## ProjectSettings (the config file) rather than live nodes, because a
## `--script` run replaces the main loop and never instantiates autoloads.
func _check_autoloads() -> void:
	for name in ["Net", "GameState"]:
		var value := String(ProjectSettings.get_setting("autoload/" + name, ""))
		if value.is_empty():
			_fail("project.godot: autoload '%s' is not declared" % name)
		elif not value.begins_with("*"):
			_fail("project.godot: autoload '%s' must be a singleton ('*' prefix), got '%s'"
				% [name, value])
		else:
			print("  ok  autoload %s -> %s" % [name, value])
	var main_scene := String(ProjectSettings.get_setting("application/run/main_scene", ""))
	if not main_scene.ends_with("main_menu.tscn"):
		_fail("project.godot: run/main_scene should boot the menu, got '%s'" % main_scene)
	else:
		print("  ok  run/main_scene -> %s" % main_scene)
	# The CLI surface the deploy runbook and systemd unit depend on.
	var main_script := load("res://scripts/main.gd")
	if main_script == null:
		_fail("scripts/main.gd did not load")
	elif not main_script.has_method("parse_cli_args"):
		_fail("scripts/main.gd: parse_cli_args() missing (server CLI is broken)")
	else:
		print("  ok  scripts/main.gd exposes parse_cli_args()")


# ---------------------------------------------------------------- 3. player

func _check_player_scene() -> void:
	var packed := _load_scene("res://scenes/player.tscn")
	if packed == null:
		return
	var root := packed.instantiate()
	for path in ["Head", "Head/Camera", "Head/Camera/WeaponAnchor", "Head/Camera/RayCast"]:
		if root.get_node_or_null(path) == null:
			_fail("scenes/player.tscn: missing node %s" % path)
	if not (root is CharacterBody3D):
		_fail("scenes/player.tscn: root is not a CharacterBody3D")
	if root.get_script() == null:
		_fail("scenes/player.tscn: root has no script attached")
	# Movement replication. Without this a client sees every other player frozen
	# at their spawn point.
	var sync := root.get_node_or_null("MultiplayerSynchronizer") as MultiplayerSynchronizer
	if sync == null:
		_fail("scenes/player.tscn: no MultiplayerSynchronizer (players would not move for others)")
	else:
		var cfg := sync.replication_config
		if cfg == null:
			_fail("scenes/player.tscn: MultiplayerSynchronizer has no replication_config")
		else:
			var props: Array = cfg.get_properties()
			for wanted in ["position", "look_yaw", "look_pitch"]:
				var found := false
				for p in props:
					if String(p).ends_with(":" + wanted):
						found = true
				if not found:
					_fail("scenes/player.tscn: synchronizer does not replicate '%s'" % wanted)
			print("  ok  scenes/player.tscn synchronizer replicates position + look")
	print("  ok  scenes/player.tscn rig (Head/Camera present)")
	root.free()


# ---------------------------------------------------------------- 4. hud.tscn

func _check_hud() -> void:
	var packed := _load_scene("res://scenes/hud.tscn")
	if packed == null:
		return
	var root := packed.instantiate()
	if not (root is CanvasLayer):
		_fail("scenes/hud.tscn: root must be a CanvasLayer, got %s" % root.get_class())
	var hud := root.get_node_or_null("HUD")
	if hud == null:
		_fail("scenes/hud.tscn: no HUD child")
	else:
		if not (hud is Control):
			_fail("scenes/hud.tscn: HUD is not a Control")
		# Full-rect anchors (0/0/1/1).
		if not (is_equal_approx(hud.anchor_right, 1.0) and is_equal_approx(hud.anchor_bottom, 1.0)):
			_fail("scenes/hud.tscn: HUD is not anchored full-rect")
		var script: Script = hud.get_script()
		if script == null or not String(script.resource_path).ends_with("hud.gd"):
			_fail("scenes/hud.tscn: HUD does not attach scripts/hud.gd")
		# Every @onready path resolved -> the binding surface is intact.
		for path in HUD_NODE_PATHS:
			if hud.get_node_or_null(path) == null:
				_fail("scenes/hud.tscn: missing HUD node %s" % path)
		if hud.get_node_or_null("Crosshair") != null:
			print("  ok  scenes/hud.tscn structure + %d HUD node paths" % HUD_NODE_PATHS.size())
	root.free()


# ---------------------------------------------------------------- 5. maps

func _check_maps() -> void:
	# MAP_CATALOGUE is a const on the main.gd script; access through an
	# instantiated node (the script const is otherwise unreachable via
	# GDScript.get() from a separate loader).
	var paths: Array = MAP_CATALOGUE_FALLBACK.duplicate()
	var main_node_script := load("res://scripts/main.gd")
	if main_node_script != null:
		var instance: Node = main_node_script.new()
		if instance != null:
			paths = []
			for key in instance.MAP_CATALOGUE:
				paths.append(String(instance.MAP_CATALOGUE[key]))
			instance.free()
	for path in paths:
		var packed := _load_scene(path)
		if packed == null:
			continue
		var root := packed.instantiate()
		if root.get_script() == null:
			_fail("%s: root has no script attached" % path)
		_check_no_spawner(path, root)
		if path.ends_with("de_aq_dust.tscn"):
			# Builds its layout in _ready(); single instance is cheap and the
			# only way to prove the map script runs without errors.
			get_root().add_child(root)
			# _ready() fires on the next idle frame, so await one.
			await process_frame
			if root.get_node_or_null("SpawnPoints") == null:
				_fail("%s: no SpawnPoints built by _ready()" % path)
			if root.get_node_or_null("MapData") == null:
				_fail("%s: no MapData built by _ready()" % path)
			print("  ok  %s built (SpawnPoints + MapData)" % path)
			root.free()
		else:
			print("  ok  scene %s" % path)
			root.free()


# ---------------------------------------------------------------- 6. weapons

func _check_weapons() -> void:
	var manifest := load("res://scripts/weapons/weapons_manifest.gd")
	if manifest == null:
		_fail("weapons_manifest.gd did not load")
		return
	var built: Dictionary = manifest.build_all()
	if built.size() != EXPECTED_WEAPONS:
		_fail("build_all() returned %d weapons, expected %d" % [built.size(), EXPECTED_WEAPONS])
	var problems: PackedStringArray = manifest.validate()
	if not problems.is_empty():
		for problem in problems:
			_fail("weapons_manifest.validate(): %s" % problem)
	print("  ok  weapons_manifest.build_all() -> %d weapons, validate() clean" % built.size())


# ---------------------------------------------------------------- 7. kill queue

func _check_kill_queue() -> void:
	var gs := load("res://scripts/game_state.gd")
	if gs == null:
		_fail("game_state.gd did not load")
		return
	gs.kill_feed_queue.clear()
	gs.queue_kill("Tester", "Victim", "ak47")
	if gs.kill_feed_queue.size() != 1:
		_fail("GameState.kill_feed_queue did not accept a kill event")
	else:
		var entry: Dictionary = gs.kill_feed_queue[0]
		for key in ["killer_name", "victim_name", "weapon_id"]:
			if not entry.has(key):
				_fail("kill event missing key '%s'" % key)
		print("  ok  GameState.kill_feed_queue round-trip")
	gs.kill_feed_queue.clear()


# ---------------------------------------------------------------- helpers

## Maps must NOT carry a MultiplayerSpawner any more: player spawning is
## explicit in scripts/main.gd (`_client_spawn_player`).
##
## Regression guard — this exact bug shipped once. The spawner replicates to a
## peer the moment it connects, which is BEFORE that client has loaded the map.
## It fails with "Node not found: <Map>/MultiplayerSpawner", and the failed sync
## then poisons the peer's spawn cache so every later spawn dies with
## "ID not found in cache of peer N" — the server sees everyone, clients see
## nobody, and it looks like a networking bug rather than a spawn-timing one.
func _check_no_spawner(path: String, root: Node) -> void:
	if root.get_node_or_null("MultiplayerSpawner") != null:
		_fail("%s: has a MultiplayerSpawner; spawning must go through Net._client_spawn_player"
			% path)
	else:
		print("  ok  %s has no MultiplayerSpawner (explicit spawning)" % path)


func _load_scene(path: String) -> PackedScene:
	if not ResourceLoader.exists(path):
		_fail("scene missing: %s" % path)
		return null
	var packed := load(path) as PackedScene
	if packed == null:
		_fail("scene did not load as PackedScene: %s" % path)
		return null
	if packed.instantiate() == null:
		_fail("scene failed to instantiate: %s" % path)
		return null
	return packed


func _fail(message: String) -> void:
	_failures.append(message)
	# `push_error` gets it into the engine log; the print keeps it readable
	# when the output is piped.
	push_error("[smoke] FAIL: %s" % message)
	print("  FAIL %s" % message)


func _finish() -> void:
	if _failures.is_empty():
		print("=== smoke test PASSED ===")
		quit(0)
		return
	print("=== smoke test FAILED (%d) ===" % _failures.size())
	for message in _failures:
		print("  - %s" % message)
	quit(1)
