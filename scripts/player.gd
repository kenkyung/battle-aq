extends CharacterBody3D
## First-person player. Movement + look are client-driven (predicted locally and
## synced via MultiplayerSynchronizer); shooting is RPC'd to the server, which
## raycasts authoritatively and broadcasts damage. HP and ammo are server-owned.

class_name Player

const MOUSE_SENSITIVITY := 0.0025
const WALK_SPEED := 6.0
const JUMP_VELOCITY := 7.5
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

    # Gravity.
    if not is_on_floor():
        velocity.y -= 24.0 * delta

    # Jump.
    if Input.is_action_just_pressed("jump") and is_on_floor():
        velocity.y = JUMP_VELOCITY

    velocity.x = direction.x * WALK_SPEED
    velocity.z = direction.z * WALK_SPEED
    move_and_slide()

    # Apply look to rig. Position is already replicated.
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
    # Ask the server to validate + apply.
    rpc_id(1, "_server_fire_weapon", fire_ray.global_position, fire_ray.global_transform.basis.z)


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