extends Node
## Main entry point. Owns the network peer, the main scene tree's active world,
## and round lifecycle. Acts as the authoritative server when hosting.

const DEFAULT_PORT := 24816
const DEFAULT_MAX_PLAYERS := 16

const SCENE_MAIN_MENU := "res://scenes/main_menu.tscn"
const SCENE_WORLD := "res://scenes/world.tscn"
const SCENE_PLAYER := "res://scenes/player.tscn"

# Tracks per-peer identity. Authoritative on the server.
var peer_id_to_player: Dictionary = {}
var player_scene: PackedScene = preload(SCENE_PLAYER)


func _ready() -> void:
    multiplayer.peer_connected.connect(_on_peer_connected)
    multiplayer.peer_disconnected.connect(_on_peer_disconnected)
    multiplayer.connected_to_server.connect(_on_connected_to_server)
    multiplayer.connection_failed.connect(_on_connection_failed)
    multiplayer.server_disconnected.connect(_on_server_disconnected)

    get_tree().change_scene_to_file(SCENE_MAIN_MENU)


# ---------------------------------------------------------------- networking

func host_game(port: int = DEFAULT_PORT, max_clients: int = DEFAULT_MAX_PLAYERS) -> Error:
    var peer := ENetMultiplayerPeer.new()
    var err := peer.create_server(port, max_clients)
    if err != OK:
        push_error("Failed to host on port %d: %s" % [port, error_string(err)])
        return err
    multiplayer.multiplayer_peer = peer
    print("[net] Hosting on port %d (max %d clients)" % [port, max_clients])
    _enter_world_as_server()
    return OK


func join_game(address: String, port: int = DEFAULT_PORT) -> Error:
    var peer := ENetMultiplayerPeer.new()
    var err := peer.create_client(address, port)
    if err != OK:
        push_error("Failed to connect to %s:%d: %s" % [address, port, error_string(err)])
        return err
    multiplayer.multiplayer_peer = peer
    print("[net] Connecting to %s:%d" % [address, port])
    return OK


func disconnect_from_game() -> void:
    if multiplayer.multiplayer_peer:
        multiplayer.multiplayer_peer.close()
        multiplayer.multiplayer_peer = null
    get_tree().change_scene_to_file(SCENE_MAIN_MENU)


# ---------------------------------------------------------------- lifecycle

func _enter_world_as_server() -> void:
    var world := get_tree().change_scene_to_file(SCENE_WORLD)
    # Wait a frame for the scene to be ready, then spawn the host's own player.
    await get_tree().process_frame
    _spawn_player(1)  # server peer id is always 1 in ENet
    GameState.start_round()


func _spawn_player(peer_id: int) -> void:
    var world := get_tree().current_scene
    if not world:
        push_error("No world scene to spawn into")
        return
    var spawn := _find_spawn_point(world)
    var player := player_scene.instantiate()
    player.name = str(peer_id)
    player.position = spawn
    # Set authority BEFORE adding to tree so MultiplayerSpawner captures it.
    player.set_multiplayer_authority(peer_id)
    world.add_child(player, true)
    peer_id_to_player[peer_id] = player


func _find_spawn_point(world: Node) -> Vector3:
    var points := world.get_node_or_null("SpawnPoints")
    if points and points.get_child_count() > 0:
        var i := randi() % points.get_child_count()
        return points.get_child(i).global_position
    return Vector3.ZERO


# ---------------------------------------------------------------- peer callbacks

func _on_peer_connected(peer_id: int) -> void:
    print("[net] Peer connected: %d" % peer_id)
    if multiplayer.is_server():
        _spawn_player(peer_id)


func _on_peer_disconnected(peer_id: int) -> void:
    print("[net] Peer disconnected: %d" % peer_id)
    var player: Node = peer_id_to_player.get(peer_id)
    if player and is_instance_valid(player):
        player.queue_free()
    peer_id_to_player.erase(peer_id)


func _on_connected_to_server() -> void:
    print("[net] Connected to server")
    get_tree().change_scene_to_file(SCENE_WORLD)


func _on_connection_failed() -> void:
    print("[net] Connection failed")
    disconnect_from_game()


func _on_server_disconnected() -> void:
    print("[net] Server disconnected")
    disconnect_from_game()