extends CharacterBody3D
## First-person player. Movement + look are client-driven (predicted locally and
## synced via MultiplayerSynchronizer); shooting is RPC'd to the server, which
## raycasts authoritatively and broadcasts damage. HP and ammo are server-owned.

class_name Player

const MOUSE_SENSITIVITY := 0.0025
# CS 1.6 movement (CS16_REFERENCE.md §1). Engine units are a scaled 1.6 unit,
# not metres, so these are relative values: WALK_SPEED is the 250 u/s run
# speed, JUMP_VELOCITY the ~270 u/s jump.
const WALK_SPEED := 6.0
const JUMP_VELOCITY := 7.5
# Tuned so the jump arc matches CS 1.6 feel (~0.47 s apex).
const GRAVITY := 32.0
# Duck speed is 0.4x run in 1.6 (~100 u/s). Flag + constant only in this
# batch: `_is_crouching` is wired to the crouch action and drives the speed
# multiplier; full collider/eye-height transition lands in M2.
const CROUCH_SPEED_MULTIPLIER := 0.4
# Head-bob is off by design: the 1.6 camera is dead-stable while moving. The
# camera stays a plain child of Head with no positional offset applied.
const HEAD_BOB_ENABLED := false
const MOUSE_FREE_PITCH_LIMIT := 1.4

const TEAM_T := 1
const TEAM_CT := 2

@export var max_hp: int = 100
@export var team: int = TEAM_T

# Server-owned state (replicated to all clients).
@export var hp: int = 100
@export var ammo: int = 30
@export var weapon_id: String = "rifle"

# Client-predicted look state (also synced).
@export var look_yaw: float = 0.0
@export var look_pitch: float = 0.0

# Client-predicted movement state. Crouch is flag-only in this batch: the
# speed multiplier is live, the collider/eye height are not.
var _is_crouching: bool = false

@onready var head: Node3D = $Head
@onready var camera: Camera3D = $Head/Camera
@onready var weapon_anchor: Node3D = $Head/Camera/WeaponAnchor
@onready var fire_ray: RayCast3D = $Head/Camera/RayCast


func _ready() -> void:
    if is_multiplayer_authority():
        Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
        hp = max_hp
        ammo = 30


func _unhandled_input(event: InputEvent) -> void:
    if not is_multiplayer_authority():
        return
    if event is InputEventMouseMotion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
        var mm := event as InputEventMouseMotion
        look_yaw -= mm.relative.x * MOUSE_SENSITIVITY
        look_pitch -= mm.relative.y * MOUSE_SENSITIVITY
        look_pitch = clamp(look_pitch, -MOUSE_FREE_PITCH_LIMIT, MOUSE_FREE_PITCH_LIMIT)
    elif event.is_action_pressed("ui_cancel"):
        Input.mouse_mode = Input.MOUSE_MODE_VISIBLE


func _physics_process(delta: float) -> void:
    if not is_multiplayer_authority():
        return
    # Movement input.
    var input_vec := Vector2(
        Input.get_action_strength("move_right") - Input.get_action_strength("move_left"),
        Input.get_action_strength("move_backward") - Input.get_action_strength("move_forward")
    )
    var direction := (transform.basis * Vector3(input_vec.x, 0, input_vec.y)).normalized()

    	# Crouch is a speed state only in this batch (CS16_REFERENCE.md §1: duck
    	# multiplier 0.4). Guard with has_action so a rebind/removal can't crash.
    	_is_crouching = InputMap.has_action("crouch") and Input.is_action_pressed("crouch")
    	var speed := WALK_SPEED * (CROUCH_SPEED_MULTIPLIER if _is_crouching else 1.0)

    	# Gravity (CS 1.6 fall is fast; see GRAVITY above).
    	if not is_on_floor():
    		velocity.y -= GRAVITY * delta

    	# Jump.
    	if Input.is_action_just_pressed("jump") and is_on_floor():
    		velocity.y = JUMP_VELOCITY

    	# Flat, instantaneous run speed with no acceleration curve — that is the
    	# 1.6 model. Ground friction comes from move_and_slide's own damping; the
    	# "sticky" 1.6 feel is a playtest item, not a code item yet.
    	velocity.x = direction.x * speed
    	velocity.z = direction.z * speed
    	move_and_slide()

    	# Apply look to rig. Position is already replicated. No head-bob: the
    	# camera stays exactly where Head puts it (HEAD_BOB_ENABLED == false).
    	rotation.y = look_yaw
    	head.rotation.x = look_pitch


func _process(_delta: float) -> void:
    if not is_multiplayer_authority():
        return
    if Input.is_action_pressed("fire"):
        _try_fire()


func _try_fire() -> void:
	if ammo <= 0:
		return
	# Always consume locally so prediction feels snappy.
	ammo -= 1
	# Route through the network surface (ARCHITECTURE.md §3 / AGENTS.md hard
	# rule 2). The server raycasts authoritatively and broadcasts damage.
	NetworkCodec.fire_weapon(
		self,
		fire_ray.global_position,
		fire_ray.global_transform.basis.z
	)


@rpc("any_peer", "call_local", "reliable")
func _server_fire_weapon(_origin: Vector3, _direction: Vector3) -> void:
    if not multiplayer.is_server():
        return
    var shooter_id := multiplayer.get_remote_sender_id()
    # Server-side rate limit / ammo check lives here. We re-broadcast HP/ammo
    # via the synchronizer; clients trust that.
    var shooter := get_node_or_null("/root/Main/World/%d" % shooter_id)
    if not shooter:
        return
    shooter.ammo = max(0, shooter.ammo - 1)

    # Authoritative hit scan.
    var space := get_world_3d().direct_space_state
    var query := PhysicsRayQueryParameters3D.create(
        _origin, _origin + _direction * 200.0,
        collision_mask
    )
    var hit := space.intersect_ray(query)
    if hit.is_empty():
        return
    var victim := hit.collider
    if victim is Player and victim.team != shooter.team:
        victim.hp -= 34
        if victim.hp <= 0:
            victim.respawn.rpc()


@rpc("authority", "call_local", "reliable")
func respawn() -> void:
    hp = max_hp
    ammo = 30
    # Reposition via the world's spawn-point logic (see main.gd).
    var world := get_tree().current_scene
    var points := world.get_node_or_null("SpawnPoints")
    if points and points.get_child_count() > 0:
        global_position = points.get_child(randi() % points.get_child_count()).global_position