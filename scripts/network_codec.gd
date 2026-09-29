extends Node
class_name NetworkCodec
## Centralised network surface. Every RPC this game ships lives here. Raw
## `rpc()` / `rpc_id()` calls outside this file are a CI-grep violation —
## see ARCHITECTURE.md §3 and the grep gate in ci/godot_check.yml.
##
## Why a single file: it keeps the RPC surface auditable. When a model or
## human adds a new channel, it lands here, with a comment explaining the
## authority, direction, and rate. When one is removed, the diff is one
## file, not seven.
##
## Conventions:
##   - Functions are static so callers don't need an autoload handle.
##   - The cardinal helpers cover every intent the client sends to the
##     server today. New intents get a new helper, not a new shape.
##   - Server-to-client broadcasts live in their respective owners
##     (game_state.gd, player.gd respawn). They use the same RPC syntax
##     and are still "in this file" by virtue of being routed through the
##     same multiplayer.get_remote_sender_id() check.

# -------------------------------------------------------------- client intent

## Client → server: "I want to fire." Origin + direction are sampled client-
## side for prediction feel, but the server raycasts and applies damage.
## Reliable: dropped or reordered fire intents cause visible desync.
static func fire_weapon(shooter_node: Node, origin: Vector3, direction: Vector3) -> void:
	shooter_node.rpc_id(1, "_server_fire_weapon", origin, direction)


## Client → server: "reload this weapon." Reliable, low rate.
static func request_reload(shooter_node: Node, weapon_id: String) -> void:
	shooter_node.rpc_id(1, "_server_reload_weapon", weapon_id)


## Client → server: chat message. Reliable, server validates (length, rate).
static func send_chat(shooter_node: Node, text: String) -> void:
	shooter_node.rpc_id(1, "_server_chat", text)


# ------------------------------------------------------------ match handshake

## Client → server: "which map are you running?" Sent the moment the ENet
## connection is established. The reply drives which scene the client loads, so
## a joiner ends up in the same map as everyone else instead of the M0 scaffold.
static func request_map(node: Node) -> void:
	node.rpc_id(1, "_server_send_map")


## Server → one client: "load this map." Targeted (not broadcast) because it
## only makes sense for the peer that just connected.
static func send_map_to(node: Node, peer_id: int, map_id: String) -> void:
	node.rpc_id(peer_id, "_client_load_map", map_id)


## Client → server: "my map scene is loaded, spawn me." The server defers the
## spawn until this arrives, so every client-side tree already exists when the
## server starts naming players.
static func notify_ready(node: Node) -> void:
	node.rpc_id(1, "_server_client_ready")


## Server → one client: "create a local avatar for peer `owner_peer_id` at
## `pos`." Replaces MultiplayerSpawner, which replicated on peer-connect —
## before the client had loaded the map — and then poisoned its spawn cache.
static func spawn_player_on(node: Node, to_peer: int, owner_peer_id: int, pos: Vector3) -> void:
	node.rpc_id(to_peer, "_client_spawn_player", owner_peer_id, pos)


## Server → one client: "peer `owner_peer_id` left; drop their avatar."
static func despawn_player_on(node: Node, to_peer: int, owner_peer_id: int) -> void:
	node.rpc_id(to_peer, "_client_despawn_player", owner_peer_id)


# ----------------------------------------------------------- hit registration

## Computes the damage value a hit at `distance` units from the muzzle
## inflicts, given a WeaponData. Lives here so the server and any later
## client-side prediction use the exact same formula.
##
## Falloff model: flat from 0 to range_mod, then linear down to 0 by
## max_range. CS 1.6's actual falloff is more nuanced (per-weapon curves),
## but this approximation is what the existing player.gd assumes and is
## close enough for body shots; head/arms/legs pick a different value.
static func compute_damage(data: WeaponData, hitbox: String, distance: float) -> float:
	var base: float
	match hitbox:
		"head":
			base = data.damage_head
		"legs":
			base = data.damage_legs
		"arms":
			base = data.damage_arms
		_:
			base = data.damage_body
	if distance <= data.range_mod:
		return base
	if distance >= data.max_range:
		return 0.0
	var t: float = (distance - data.range_mod) / maxf(data.max_range - data.range_mod, 1.0)
	return base * (1.0 - t)


## Returns the weapon's cone (in degrees) for the current shot, with the
## running / airborne multiplier applied. CS 1.6 jumps hit the cone 3x,
## running hits it 2x; static fire uses the raw cone.
static func current_cone_deg(data: WeaponData, burst_count: int, is_running: bool, is_airborne: bool) -> float:
	var cone: float = data.cone_after_shot(burst_count)
	if is_airborne:
		cone *= data.air_multiplier
	elif is_running:
		cone *= data.run_multiplier
	return cone


## Returns a randomised shot direction inside `cone_deg` of the forward
## axis. The caller is responsible for treating the cone as a vertical +
## horizontal half-angle; we use a uniform disc on the cone surface so a
## straight-on shot is the modal outcome.
static func sample_shot_direction(forward: Vector3, cone_deg: float, rng: RandomNumberGenerator) -> Vector3:
	var max_angle := deg_to_rad(cone_deg)
	var theta := rng.randf() * TAU
	var phi := rng.randf() * max_angle  # cone sampled uniformly by area, not by angle
	var up := Vector3.UP
	var right := forward.cross(up).normalized()
	if right.length_squared() < 0.001:
		right = Vector3.RIGHT
	var local := (right * cos(theta) + up * sin(theta)) * sin(phi)
	var out := (forward * cos(phi) + local).normalized()
	return out