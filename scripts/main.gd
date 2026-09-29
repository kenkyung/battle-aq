extends Node
## Persistent network manager, registered as the `Net` autoload in
## project.godot.
##
## WHY AN AUTOLOAD: `get_tree().change_scene_to_file()` frees the current scene.
## When this code lived in the `Main` node of `scenes/main.tscn`, the first
## scene change (menu -> world) destroyed the peer, the peer->player map and
## every `peer_connected` / `peer_disconnected` handler with it. An autoload is
## never freed by a scene change, so the network layer now outlives both the
## menu and the map.
##
## Command line — everything after a bare `--` (see `parse_cli_args`):
##
##   Dedicated server (no local player, no window):
##     godot --headless --path . -- --server --map de_aq_dust --port 24816
##
##   Listen server (also plays locally):
##     godot --path . -- --host --map de_aq_dust
##
##   Client that connects on boot:
##     godot --path . -- --connect 100.104.64.0 --port 24816
##
##   No flags -> the interactive main menu (scenes/main_menu.tscn).
##
## AUTHORITY: the server owns spawning, HP/ammo, and the round clock. Clients
## only ask questions; see ARCHITECTURE.md §3.

const DEFAULT_PORT := 24816
const DEFAULT_MAX_PLAYERS := 16
const DEFAULT_MAP := "de_aq_dust"

## Node name the local player's HUD is added under (see `_attach_hud`).
const HUD_NODE_NAME := "HUD"

const SCENE_MAIN_MENU := "res://scenes/main_menu.tscn"
const SCENE_WORLD := "res://scenes/world.tscn"
const SCENE_PLAYER := "res://scenes/player.tscn"
const SCENE_HUD := "res://scenes/hud.tscn"

# Map catalogue. Keys are the public map_id (matches MapData.map_id and the
# loadable scene path under scenes/maps/). Adding a map = add an entry here and
# create scenes/maps/<id>.tscn plus its scripts/maps/<id>.gd.
const MAP_CATALOGUE := {
    "de_aq_dust": "res://scenes/maps/de_aq_dust.tscn",
    "de_aq_inferno": "res://scenes/maps/de_aq_inferno.tscn",
    "de_aq_aztec": "res://scenes/maps/de_aq_aztec.tscn",
}

# CLI flag names (without the leading `--`).
const CLI_SERVER := "server"
const CLI_HOST := "host"
const CLI_CONNECT := "connect"
const CLI_MAP := "map"
const CLI_PORT := "port"
const CLI_MAX_PLAYERS := "max-players"

# Tracks per-peer identity. Authoritative on the server.
var peer_id_to_player: Dictionary = {}
var player_scene: PackedScene = preload(SCENE_PLAYER)
var hud_scene: PackedScene = preload(SCENE_HUD)

## The map the server is running. Replicated to each client during the
## connect handshake so a joiner loads the same scene as everyone else.
var current_map_id: String = ""

## True once this process is running a dedicated (headless, non-playing)
## server. A listen server also hosts but keeps its own player + HUD.
var is_dedicated_server: bool = false


func _ready() -> void:
    multiplayer.peer_connected.connect(_on_peer_connected)
    multiplayer.peer_disconnected.connect(_on_peer_disconnected)
    multiplayer.connected_to_server.connect(_on_connected_to_server)
    multiplayer.connection_failed.connect(_on_connection_failed)
    multiplayer.server_disconnected.connect(_on_server_disconnected)

    # Deferred: an autoload's _ready() runs while the SceneTree is still being
    # assembled, and change_scene_to_file() inside that window trips
    # "Parent node is busy adding/removing children".
    _dispatch_cli.call_deferred()


# ---------------------------------------------------------------- cli

## Parse `--flag` and `--key value` (or `--key=value`) pairs out of
## `OS.get_cmdline_user_args()` — i.e. everything AFTER a bare `--` on the
## command line, so Godot's own flags are never confused with ours.
##
## Returns a Dictionary: bare flags map to `true`, key/value pairs to their
## String value. Unknown keys are passed through untouched.
static func parse_cli_args() -> Dictionary:
    var out: Dictionary = {}
    var args := OS.get_cmdline_user_args()
    var i := 0
    while i < args.size():
        var arg: String = args[i]
        if not arg.begins_with("--"):
            i += 1
            continue
        var key := arg.substr(2)
        var value := ""
        var has_value := false
        if key.contains("="):
            var parts := key.split("=", true, 1)
            key = parts[0]
            value = parts[1]
            has_value = true
        elif i + 1 < args.size() and not String(args[i + 1]).begins_with("--"):
            value = String(args[i + 1])
            has_value = true
            i += 1
        out[key] = value if has_value else true
        i += 1
    return out


## Turn the parsed CLI into an action. With no recognised flag we do nothing:
## the main scene (main_menu.tscn) is already loading and owns the UI.
func _dispatch_cli() -> void:
    var opts := parse_cli_args()
    var port := int(opts.get(CLI_PORT, DEFAULT_PORT))
    var map_id := String(opts.get(CLI_MAP, DEFAULT_MAP))
    var max_clients := int(opts.get(CLI_MAX_PLAYERS, DEFAULT_MAX_PLAYERS))

    if opts.has(CLI_SERVER):
        start_dedicated_server(map_id, port, max_clients)
    elif opts.has(CLI_HOST):
        host_game(port, max_clients, map_id)
    elif opts.has(CLI_CONNECT):
        join_game(String(opts[CLI_CONNECT]), port)


# ---------------------------------------------------------------- networking

func _create_server_peer(port: int, max_clients: int) -> Error:
    var peer := ENetMultiplayerPeer.new()
    var err := peer.create_server(port, max_clients)
    if err != OK:
        push_error("Failed to host on UDP %d: %s" % [port, error_string(err)])
        return err
    multiplayer.multiplayer_peer = peer
    return OK


## Listen server: hosts AND plays. The host is always peer id 1 in ENet.
## `map_id` empty -> DEFAULT_MAP.
func host_game(port: int = DEFAULT_PORT, max_clients: int = DEFAULT_MAX_PLAYERS,
        map_id: String = "") -> Error:
    var err := _create_server_peer(port, max_clients)
    if err != OK:
        return err
    is_dedicated_server = false
    print("[net] Listen server on UDP %d (max %d clients)" % [port, max_clients])
    _log_join_info(port)
    _start_world(map_id if not map_id.is_empty() else DEFAULT_MAP, true)
    return OK


## Dedicated server: hosts a map but never spawns a local player, so there is
## no camera, no HUD and no input to service. Runs cleanly under `--headless`
## (Godot substitutes dummy display/audio drivers).
func start_dedicated_server(map_id: String = DEFAULT_MAP, port: int = DEFAULT_PORT,
        max_clients: int = DEFAULT_MAX_PLAYERS) -> Error:
    var err := _create_server_peer(port, max_clients)
    if err != OK:
        return err
    is_dedicated_server = true
    print("[net] Dedicated server on UDP %d (max %d clients, map %s)"
        % [port, max_clients, map_id])
    _log_join_info(port)
    _start_world(map_id, false)
    return OK


func join_game(address: String, port: int = DEFAULT_PORT) -> Error:
    var peer := ENetMultiplayerPeer.new()
    var err := peer.create_client(address, port)
    if err != OK:
        push_error("Failed to connect to %s:%d: %s" % [address, port, error_string(err)])
        return err
    multiplayer.multiplayer_peer = peer
    is_dedicated_server = false
    print("[net] Connecting to %s:%d ..." % [address, port])
    return OK


func disconnect_from_game() -> void:
    if multiplayer.multiplayer_peer:
        multiplayer.multiplayer_peer.close()
        multiplayer.multiplayer_peer = null
    peer_id_to_player.clear()
    get_tree().change_scene_to_file(SCENE_MAIN_MENU)


## Print every address a player can use to reach this server: Tailscale first
## (works from anywhere), then plain LAN. Tailscale hands out addresses in the
## 100.64.0.0/10 CGNAT range, which is what we key on.
func _log_join_info(port: int) -> void:
    var remote: Array[String] = []
    var lan: Array[String] = []
    for addr: String in IP.get_local_addresses():
        if addr.contains(":") or addr.begins_with("127."):
            continue  # IPv6 / loopback
        if addr.begins_with("100."):
            remote.append(addr)
        else:
            lan.append(addr)
    print("[net] ----------------------------------------------------------")
    print("[net] Battle-AQ server listening on UDP %d" % port)
    for a in remote:
        print("[net]   remote players (Tailscale):  %s:%d" % [a, port])
    for a in lan:
        print("[net]   LAN players:                %s:%d" % [a, port])
    print("[net] ----------------------------------------------------------")


# ---------------------------------------------------------------- lifecycle

## Load the map and, on a listen server, place the host's own player in it.
## `change_scene_to_file` is deferred to the end of the frame, so we wait two
## frames before touching `current_scene`.
func _start_world(map_id: String, spawn_local_player: bool) -> void:
    current_map_id = map_id if not map_id.is_empty() else DEFAULT_MAP
    _load_world_scene(current_map_id)
    await get_tree().process_frame
    await get_tree().process_frame
    if spawn_local_player:
        _spawn_player(1)  # ENet's server peer id is always 1
    _ensure_round_started()


## Resolve a map_id into a scene path and load it. Empty map_id = the M0
## scaffold scene. Unknown map_id pushes an error and falls back to the
## scaffold rather than leaving the player on a blank screen.
func _load_world_scene(map_id: String) -> void:
    if map_id.is_empty():
        get_tree().change_scene_to_file(SCENE_WORLD)
        return
    var path: String = MAP_CATALOGUE.get(map_id, "")
    if path.is_empty():
        push_error("Unknown map_id '%s' — falling back to scaffold" % map_id)
        get_tree().change_scene_to_file(SCENE_WORLD)
        return
    get_tree().change_scene_to_file(path)


func _ensure_round_started() -> void:
    # GameState is an autoload (project.godot); reach it by path so this file
    # stays loadable in isolation.
    var gs := get_node_or_null("/root/GameState")
    if gs and gs.has_method("start_round"):
        gs.start_round()


func _spawn_player(peer_id: int) -> void:
    if not multiplayer.is_server():
        return
    if peer_id_to_player.has(peer_id) and is_instance_valid(peer_id_to_player[peer_id]):
        return  # already spawned (duplicate ready notification)
    var world := get_tree().current_scene
    if world == null:
        push_error("No world scene to spawn into")
        return
    var spawn := _find_spawn_point(world)
    var player := _build_player(peer_id, spawn)
    world.add_child(player, true)
    peer_id_to_player[peer_id] = player
    print("[net] Spawned player '%s' for peer %d at %s" % [player.name, peer_id, spawn])
    if peer_id == _local_peer_id():
        _attach_hud(player, world)
    # Mirror on every client, including its owner: the owning client needs a
    # local avatar to look through. See `_client_spawn_player` for why this is
    # done by hand rather than with a MultiplayerSpawner.
    for other in multiplayer.get_peers():
        NetworkCodec.spawn_player_on(self, other, peer_id, spawn)


## Build a player node with `peer_id` as its multiplayer authority.
##
## The authority being the OWNER (not the server) is what makes player.gd's
## `_physics_process` run on that client: movement is client-predicted and
## replicated out by the player's MultiplayerSynchronizer.
func _build_player(peer_id: int, pos: Vector3) -> Node3D:
    var player := player_scene.instantiate() as Node3D
    player.name = str(peer_id)
    player.position = pos
    player.set_multiplayer_authority(peer_id)
    return player


## Free `peer_id`'s player locally and tell every client to do the same.
func _despawn_player(peer_id: int) -> void:
    var player: Node = peer_id_to_player.get(peer_id)
    if player and is_instance_valid(player):
        _remove_hud(player)
        player.queue_free()
    peer_id_to_player.erase(peer_id)
    if multiplayer.is_server():
        for other in multiplayer.get_peers():
            NetworkCodec.despawn_player_on(self, other, peer_id)


## Instantiates `scenes/hud.tscn` under the local player. The HUD resolves its
## Player by walking up the tree from its own parent.
func _attach_hud(player: Node, world: Node) -> void:
    if hud_scene == null:
        push_error("HUD scene missing (%s)" % SCENE_HUD)
        return
    var existing := player.get_node_or_null(HUD_NODE_NAME)
    if existing != null:
        existing.queue_free()
    var hud := hud_scene.instantiate()
    hud.name = HUD_NODE_NAME
    player.add_child(hud)
    # Hand the HUD its player + world up front (same result as the tree walk,
    # but it also carries the world handle for kill-feed name resolution).
    if hud.has_method("bind_player"):
        hud.bind_player(player, world)


## Detach + free the HUD that belongs to `player`.
func _remove_hud(player: Node) -> void:
    if player == null or not is_instance_valid(player):
        return
    for child in player.get_children():
        if child is CanvasLayer:
            child.queue_free()


## The peer id this process plays as. `multiplayer.get_unique_id()` only reports
## the real id once the peer exists; before that a host is peer 1 (ENet's server
## id) and an unconnected client is 0.
func _local_peer_id() -> int:
    if multiplayer.multiplayer_peer != null:
        var uid := multiplayer.get_unique_id()
        if uid != 0:
            return uid
    return 1 if multiplayer.is_server() else 0


func _find_spawn_point(world: Node) -> Vector3:
    var points := world.get_node_or_null("SpawnPoints")
    if points and points.get_child_count() > 0:
        return points.get_child(randi() % points.get_child_count()).global_position
    return Vector3.ZERO


# ---------------------------------------------------------------- rpcs

## Client -> server: "which map are you running?"
##
## NOTE: this request path is currently unused — the server pushes the map
## proactively in `_on_peer_connected` instead, because a client-initiated RPC
## sent immediately after `connected_to_server` races ENet's peer registration
## and is silently dropped. Kept as the documented fallback for a client that
## needs to re-sync after a map change.
@rpc("any_peer", "call_remote", "reliable")
func _server_send_map() -> void:
    if not multiplayer.is_server():
        return
    NetworkCodec.send_map_to(self, multiplayer.get_remote_sender_id(), current_map_id)


## Server -> one client: "load this map."
##
## The `await` is deliberate: the client must finish loading BEFORE telling the
## server it is ready, because MultiplayerSpawner can only replicate a spawn
## into a node tree that already contains the spawner.
@rpc("authority", "call_remote", "reliable")
func _client_load_map(map_id: String) -> void:
    if multiplayer.is_server():
        return
    print("[net] Server says the map is '%s' — loading" % map_id)
    current_map_id = map_id
    _load_world_scene(map_id)
    await get_tree().process_frame
    await get_tree().process_frame
    print("[net] Map ready — asking the server to spawn me")
    NetworkCodec.notify_ready(self)


## Client -> server: "map loaded, spawn me."
##
## Spawning happens here rather than in `_on_peer_connected` precisely because
## the client's tree is only ready at this point.
@rpc("any_peer", "call_remote", "reliable")
func _server_client_ready() -> void:
    if not multiplayer.is_server():
        return
    var peer_id := multiplayer.get_remote_sender_id()
    print("[net] Peer %d reports map-ready — bringing it into the world" % peer_id)
    # 1. Catch the joiner up on everyone already in the world.
    for existing_id in peer_id_to_player.keys():
        var existing: Node = peer_id_to_player[existing_id]
        if existing != null and is_instance_valid(existing):
            NetworkCodec.spawn_player_on(self, peer_id, int(existing_id),
                (existing as Node3D).position)
    # 2. Spawn the joiner's own player, which also announces it to the others.
    _spawn_player(peer_id)


## Server -> one client: "materialise peer `owner_peer_id` at this position."
##
## This replaces MultiplayerSpawner deliberately. The spawner replicates to a
## peer the moment it connects, which fired BEFORE that client had loaded the
## map ("Node not found: DeAqDust/MultiplayerSpawner"); the failed sync then
## poisoned the peer's spawn cache, so every later spawn failed with "ID not
## found in cache". Driving it by hand lets the server speak only after a client
## has confirmed its scene is up via `_server_client_ready`.
@rpc("authority", "call_remote", "reliable")
func _client_spawn_player(owner_peer_id: int, pos: Vector3) -> void:
    if multiplayer.is_server():
        return
    if peer_id_to_player.has(owner_peer_id) and is_instance_valid(peer_id_to_player[owner_peer_id]):
        return
    var world := get_tree().current_scene
    if world == null:
        push_error("Client: no world scene to spawn into")
        return
    var player := _build_player(owner_peer_id, pos)
    world.add_child(player, true)
    peer_id_to_player[owner_peer_id] = player
    var mine := owner_peer_id == _local_peer_id()
    print("[net] Mirrored player '%s' (owner %d, %s)"
        % [player.name, owner_peer_id, "me" if mine else "remote"])
    if mine:
        _attach_hud(player, world)


## Server -> one client: "peer `owner_peer_id` left the game."
@rpc("authority", "call_remote", "reliable")
func _client_despawn_player(owner_peer_id: int) -> void:
    if multiplayer.is_server():
        return
    var player: Node = peer_id_to_player.get(owner_peer_id)
    if player and is_instance_valid(player):
        _remove_hud(player)
        player.queue_free()
    peer_id_to_player.erase(owner_peer_id)
    print("[net] Removed player for departed peer %d" % owner_peer_id)


# ---------------------------------------------------------------- peer callbacks

func _on_peer_connected(peer_id: int) -> void:
    print("[net] Peer connected: %d" % peer_id)
    if multiplayer.is_server():
        # Server-initiated map push. Doing it here (rather than waiting for the
        # client to ask) removes a round trip AND the race where the client's
        # first RPC is sent before ENet has finished registering the peer.
        # Deferred so the peer's RPC channel is fully wired before we speak.
        _push_map_to.call_deferred(peer_id)


## Tell one peer which map to load. Split out so the connection handler stays a
## one-liner and this can be retried/triggered elsewhere if needed.
func _push_map_to(peer_id: int) -> void:
    print("[net]   -> pushing map '%s' to peer %d" % [current_map_id, peer_id])
    NetworkCodec.send_map_to(self, peer_id, current_map_id)


func _on_peer_disconnected(peer_id: int) -> void:
    print("[net] Peer disconnected: %d" % peer_id)
    _despawn_player(peer_id)


func _on_connected_to_server() -> void:
    print("[net] Connected — waiting for the server to push the map")


func _on_connection_failed() -> void:
    print("[net] Connection failed")
    disconnect_from_game()


func _on_server_disconnected() -> void:
    print("[net] Server disconnected")
    disconnect_from_game()
