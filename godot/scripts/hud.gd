extends Control
## Local player HUD — crosshair, HP bar, ammo counter, round timer, score strip
## and kill feed. Attached to the local Player by `main.gd` and reads that
## Player plus the `GameState` / `World` singletons.
##
## Hard rules honoured here (AGENTS.md / ARCHITECTURE.md):
##  - No RPCs. RPCS only live in `network_codec.gd`; the HUD polls GameState
##    instead (round state is already replicated by `_set_phase` /
##    `_round_wins`, and kill events ride GameState.kill_feed_queue).
##  - GL Compatibility: Label / Panel / PanelContainer / ColorRect only, no
##    custom shaders, no per-pixel material transparency.
##  - 20 Hz UI tick (ARCHITECTURE §7) and a 0.5 s kill-feed drain, so the HUD
##    never costs more than a couple of hundredths of a millisecond per frame.

# ---------------------------------------------------------------- constants

## UI tick. 20 Hz mirrors the MultiplayerSynchronizer cap (ARCHITECTURE §7):
## anything faster would repaint stale replicated state.
const UPDATE_INTERVAL := 1.0 / 20.0
## Kill-feed drain interval — at most 2 Hz.
const KILL_POLL_INTERVAL := 0.5
## Kill-feed lines on screen at once; newest at the top.
const KILL_FEED_MAX := 5
## Seconds a line stays before it starts dimming / disappears.
const KILL_FEED_TTL := 6.0
## GameState's phase constants (kept inline so the HUD does not depend on the
## GameState singleton existing at parse time — see `_resolve_game_state`).
const PHASE_WAITING := 0
const PHASE_BUY_TIME := 1
const PHASE_ROUND_TIME := 2
const PHASE_ROUND_END := 3
const PHASE_NAMES := {
    PHASE_WAITING: "WAITING",
    PHASE_BUY_TIME: "BUY",
    PHASE_ROUND_TIME: "ROUND",
    PHASE_ROUND_END: "ROUND END",
}

# CS 1.6 HUD palette (CS16_REFERENCE.md §7 "beige/tan, readable on a potato").
const COLOR_HUD := Color(0.94, 0.94, 0.94, 0.92)
const COLOR_HP_HIGH := Color(0.25, 0.85, 0.35, 0.95)
const COLOR_HP_MID := Color(0.95, 0.80, 0.20, 0.95)
const COLOR_HP_LOW := Color(0.90, 0.20, 0.15, 0.95)
const COLOR_TEAM_T := Color(0.85, 0.75, 0.35, 1.0)
const COLOR_TEAM_CT := Color(0.42, 0.62, 0.85, 1.0)
const COLOR_DEATH := Color(0.55, 0.55, 0.55, 1.0)

## Crosshair geometry: 4 lines with a small centre gap (never expands — cone
## growth is CS:GO, not 1.6).
const CROSSHAIR_GAP := 5.0
const CROSSHAIR_LENGTH := 10.0
const CROSSHAIR_THICKNESS := 2.0

## Weapon ids in display order, for the ammo "mag / reserve" lookup. The slot
## id (1..9) matches `WeaponsManifest.ORDER` in M2's buy menu; until that lands
## the id is passed through verbatim.
const WEAPON_ORDER := [
    "knife", "glock18", "usp45", "deagle", "mp5navy", "ak47", "m4a1", "awp", "scout",
]

# ---------------------------------------------------------------- exported

## HP readout. When `max_hp` is unset on the Player we fall back to the
## Player's own `max_hp` (it is exported there) and finally to 100.
@export var hp_max_fallback: int = 100

# ---------------------------------------------------------------- state

## The player this HUD belongs to (set by `main.gd` via `bind_player`, or
## discovered from the tree in `_ready`).
var player: Player = null
var _world: Node = null

var _game_state: Node = null
var _hp_max: int = 100
var _hp: int = 100
var _ammo_in_mag: int = 0
var _mag_size: int = 0
var _weapon_id: String = ""

var _update_accum: float = 0.0
var _kill_accum: float = 0.0
## Active kill-feed rows: [{ "row": VBoxContainer, "label": Label, "age": float }]
var _kill_rows: Array = []
## Last observed GameState.phase — drives the one-shot kill-feed reset on a
## new round. -1 means "not observed yet".
var _last_phase: int = -1

# ---------------------------------------------------------------- nodes

@onready var crosshair: Control = $Crosshair
@onready var hp_bar: PanelContainer = $HPBar
@onready var hp_label: Label = $HPBar/HPBarVBox/HPLabel
@onready var hp_fill: ColorRect = $HPBar/HPBarVBox/HPBarGauge/HPFill
@onready var ammo_label: Label = $AmmoCounter
@onready var weapon_label: Label = $WeaponName
@onready var timer_label: Label = $TimerLabel
@onready var phase_label: Label = $PhaseLabel
@onready var score_strip: HBoxContainer = $ScoreStrip
@onready var score_t_label: Label = $ScoreStrip/ScoreT
@onready var score_ct_label: Label = $ScoreStrip/ScoreCT
@onready var kill_feed: VBoxContainer = $KillFeed


# ---------------------------------------------------------------- lifecycle

func _ready() -> void:
    # Labels created in the .tscn are already empty, but clear them here too so
    # a HUD that is created from code (no .tscn overrides) still starts clean.
    if crosshair.get_child_count() == 0:
        _build_crosshair()

    _resolve_game_state()
    if player == null:
        player = _find_local_player()
    if _game_state != null:
        # Server-authoritative state arrives via RPC; repaint the moment a
        # round event lands rather than waiting up to 50 ms for the tick.
        if not _game_state.phase_changed.is_connected(_on_phase_changed):
            _game_state.phase_changed.connect(_on_phase_changed)
        if not _game_state.score_changed.is_connected(_on_score_changed):
            _game_state.score_changed.connect(_on_score_changed)
        _last_phase = _game_state.phase
        _on_phase_changed(_game_state.phase)

    visible = true
    _refresh()


func _process(delta: float) -> void:
    _update_accum += delta
    if _update_accum < UPDATE_INTERVAL:
        return
    _update_accum = 0.0

    _refresh()

    _kill_accum += UPDATE_INTERVAL
    if _kill_accum >= KILL_POLL_INTERVAL:
        _kill_accum = 0.0
        _drain_kill_queue()


## Locate the GameState singleton. It is an autoload (project.godot), so it
## lives at `/root/GameState`; the `/root/Main/GameState` probe is kept as a
## fallback for a hand-built test scene that parents it explicitly.
func _resolve_game_state() -> bool:
    if _game_state != null and is_instance_valid(_game_state):
        return true
    _game_state = get_node_or_null("/root/Main/GameState")
    if _game_state == null:
        _game_state = get_node_or_null("/root/GameState")
    return _game_state != null


# ---------------------------------------------------------------- public API

## `main.gd` calls this with the freshly spawned local player. Pass the world
## too when it is known — the HUD uses it to resolve killer/victim ids into
## names for the kill feed.
func bind_player(local_player: Player, world: Node = null) -> void:
    player = local_player
    _world = world
    if is_node_ready():
        _refresh()


## Hard-clear the HUD (round restart, map change, player freed).
func clear() -> void:
    _clear_kill_feed()
    _hp = 0
    _ammo_in_mag = 0
    _weapon_id = ""
    if is_node_ready():
        _refresh()


# ---------------------------------------------------------------- refresh

func _refresh() -> void:
    # The player can be freed mid-round (disconnect). Treat that as a dead
    # readout instead of crashing on a dangling reference.
    if player != null and not is_instance_valid(player):
        player = null

    var gs: Node = _game_state
    if gs != null and is_instance_valid(gs):
        var phase: int = gs.phase
        if phase != _last_phase:
            _last_phase = phase
            _on_phase_changed(phase)
        _update_timer(gs)
        _update_phase(gs)
        _update_score(gs)
    else:
        _update_phase(null)
        _update_score(null)

    _update_hp()
    _update_ammo()
    _update_weapon()


func _update_hp() -> void:
    var hp := 0
    var maximum := hp_max_fallback
    if player != null and is_instance_valid(player):
        hp = int(player.hp)
        if "max_hp" in player:
            maximum = int(player.max_hp)
    maximum = maxi(maximum, 1)
    hp = clampi(hp, 0, maximum)
    _hp_max = maximum
    _hp = hp
    if hp_label != null:
        hp_label.text = str(hp)
    if hp_fill != null:
        hp_fill.size_flags_stretch_ratio = float(hp) / float(maximum)
        hp_fill.color = _hp_color(hp, maximum)


func _update_ammo() -> void:
    if player == null or not is_instance_valid(player):
        _ammo_in_mag = 0
        if ammo_label != null:
            ammo_label.text = "- / -"
        return
    var mag_size := _magazine_size(String(player.weapon_id))
    var in_mag := clampi(int(player.ammo), 0, mag_size)
    _ammo_in_mag = in_mag
    _mag_size = mag_size
    if ammo_label != null:
        ammo_label.text = "%d / %d" % [in_mag, mag_size]


## Weapon readout ("AK-47"). Cosmetic: an unknown or not-yet-assigned id leaves
## the ammo counter as the only weapon feedback rather than erroring.
func _update_weapon() -> void:
    _weapon_id = "" if player == null or not is_instance_valid(player) else String(player.weapon_id)
    var slot := _weapon_slot(_weapon_id)
    if weapon_label != null:
        weapon_label.text = "" if slot < 0 else "%s  %d" % [_weapon_display_name(_weapon_id), slot]


func _update_timer(gs: Node) -> void:
    if timer_label == null:
        return
    var phase: int = gs.phase
    if phase == PHASE_WAITING:
        timer_label.text = ""
        timer_label.visible = false
        return
    timer_label.visible = true
    timer_label.text = _format_time(gs.timer)


func _update_phase(gs: Node) -> void:
    if phase_label == null:
        return
    if gs == null:
        phase_label.text = ""
        return
    phase_label.text = str(PHASE_NAMES.get(int(gs.phase), "WAITING"))


func _update_score(gs: Node) -> void:
    if gs == null:
        return
    if score_t_label != null:
        score_t_label.text = "T  %d" % int(gs.score_t)
    if score_ct_label != null:
        score_ct_label.text = "%d  CT" % int(gs.score_ct)


func _format_time(seconds: float) -> String:
    var total := maxi(0, int(ceilf(seconds)))
    return "%02d:%02d" % [total / 60, total % 60]


func _hp_color(hp: int, maximum: int) -> Color:
    var fraction := float(hp) / float(maxi(maximum, 1))
    if fraction > 0.5:
        return COLOR_HP_HIGH
    if fraction > 0.25:
        return COLOR_HP_MID
    return COLOR_HP_LOW


# ---------------------------------------------------------------- kill feed

## Drain the GameState kill queue. The server appends one Dictionary per kill
## (see `player.gd::_server_fire_weapon`) and this HUD — like every client's —
## reads it; GameState.kill_feed_queue is a static, so it is per-process state,
## which is exactly what a local HUD wants.
func _drain_kill_queue() -> void:
    if _game_state == null or not is_instance_valid(_game_state):
        _age_kill_rows(KILL_POLL_INTERVAL)
        return
    var queue: Array = _game_state.get("kill_feed_queue")
    if queue == null or queue.is_empty():
        _age_kill_rows(KILL_POLL_INTERVAL)
        return
    # Copy + clear in one step so a kill recorded while we were iterating is
    # picked up on the next drain instead of being dropped.
    var pending: Array = queue.duplicate()
    queue.clear()
    for entry in pending:
        if entry is Dictionary:
            _push_kill(entry)
    _age_kill_rows(KILL_POLL_INTERVAL)


func _push_kill(entry: Dictionary) -> void:
    var killer := str(entry.get("killer_name", entry.get("killer", "?")))
    var victim := str(entry.get("victim_name", entry.get("victim", "?")))
    var weapon := str(entry.get("weapon_id", entry.get("weapon", "?")))
    _add_kill_row(killer, victim, weapon)


func _add_kill_row(killer: String, victim: String, weapon: String) -> void:
    if kill_feed == null:
        return
    # At most 5 rows: drop the oldest (bottom) first.
    while _kill_rows.size() >= KILL_FEED_MAX:
        _remove_kill_row(_kill_rows.size() - 1)

    var row := VBoxContainer.new()
    row.name = "KillRow"
    row.mouse_filter = Control.MOUSE_FILTER_IGNORE
    row.alignment = BoxContainer.ALIGNMENT_BEGIN

    var line := Label.new()
    line.name = "Line"
    line.text = "%s >> %s (%s)" % [killer, victim, weapon]
    line.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
    line.mouse_filter = Control.MOUSE_FILTER_IGNORE
    row.add_child(line)

    # Newest at the top.
    kill_feed.add_child(row)
    kill_feed.move_child(row, 0)
    _kill_rows.append({"row": row, "label": line, "age": 0.0})
    _apply_kill_fade()


func _age_kill_rows(delta: float) -> void:
    if _kill_rows.is_empty():
        return
    var i := _kill_rows.size() - 1
    while i >= 0:
        var record: Dictionary = _kill_rows[i]
        record["age"] = float(record["age"]) + delta
        if float(record["age"]) >= KILL_FEED_TTL:
            _remove_kill_row(i)
        i -= 1
    _apply_kill_fade()


func _apply_kill_fade() -> void:
    for record in _kill_rows:
        var label: Label = record["label"]
        if label == null or not is_instance_valid(label):
            continue
        var t := clampf(float(record["age"]) / KILL_FEED_TTL, 0.0, 1.0)
        # Hold full opacity for the first half of the line's life, then fade.
        var alpha := 1.0 if t < 0.5 else 1.0 - (t - 0.5) * 2.0
        label.modulate = Color(1.0, 1.0, 1.0, alpha)


func _remove_kill_row(index: int) -> void:
    if index < 0 or index >= _kill_rows.size():
        return
    var record: Dictionary = _kill_rows[index]
    var row: Node = record["row"]
    _kill_rows.remove_at(index)
    if row != null and is_instance_valid(row):
        row.queue_free()


func _clear_kill_feed() -> void:
    for record in _kill_rows:
        var row: Node = record["row"]
        if row != null and is_instance_valid(row):
            row.queue_free()
    _kill_rows.clear()


# ---------------------------------------------------------------- crosshair

## 4 lines around a small centre gap, built in code so `scenes/hud.tscn` stays
## plain (no sub-resources, nothing for the GL-Compat budget to regress on).
## Static by design: CS 1.6 does not expand the crosshair while firing.
func _build_crosshair() -> void:
    var center := Vector2(0.5, 0.5)
    var specs := [
        # [anchor_x, anchor_y, half_w, half_h, offset_x, offset_y]
        [1.0, 0.0, 0.5, 0.0, 0.0, -(CROSSHAIR_GAP + CROSSHAIR_LENGTH)],  # top
        [1.0, 0.0, 0.5, 0.0, 0.0, CROSSHAIR_GAP + CROSSHAIR_LENGTH],     # bottom
        [0.0, 1.0, 0.0, 0.5, -(CROSSHAIR_GAP + CROSSHAIR_LENGTH), 0.0],  # left
        [0.0, 1.0, 0.0, 0.5, CROSSHAIR_GAP + CROSSHAIR_LENGTH, 0.0],     # right
    ]
    var names := ["Top", "Bottom", "Left", "Right"]
    for i in specs.size():
        var s: Array = specs[i]
        var line := ColorRect.new()
        line.name = names[i]
        line.mouse_filter = Control.MOUSE_FILTER_IGNORE
        line.color = COLOR_HUD
        line.anchor_left = center.x
        line.anchor_top = center.y
        line.anchor_right = center.x
        line.anchor_bottom = center.y
        var half_w: float = s[2]
        var half_h: float = s[3]
        if half_w > 0.0:
            line.offset_left = -half_w
            line.offset_right = half_w
            line.offset_top = s[5] - CROSSHAIR_THICKNESS
            line.offset_bottom = s[5] + CROSSHAIR_THICKNESS
        else:
            line.offset_top = -half_h
            line.offset_bottom = half_h
            line.offset_left = s[4] - CROSSHAIR_THICKNESS
            line.offset_right = s[4] + CROSSHAIR_THICKNESS
        crosshair.add_child(line)


# ---------------------------------------------------------------- helpers

func _magazine_size(weapon_id: String) -> int:
    if weapon_id.is_empty():
        return 0
    var manifest := load("res://scripts/weapons/weapons_manifest.gd")
    if manifest == null:
        return 0
    var table: Dictionary = manifest.WEAPONS
    if not table.has(weapon_id):
        return 0
    return int(table[weapon_id]["magazine_size"])


## Pretty name from the manifest (`display_name`), falling back to the raw id.
func _weapon_display_name(weapon_id: String) -> String:
    var manifest := load("res://scripts/weapons/weapons_manifest.gd")
    if manifest == null:
        return weapon_id
    var table: Dictionary = manifest.WEAPONS
    if not table.has(weapon_id):
        return weapon_id
    return String(table[weapon_id].get("display_name", weapon_id))


## Server-authoritative slot id (1..9) for a weapon id, matching the buy-menu
## order in `WeaponsManifest.ORDER` (ARCHITECTURE §4 weapon slots). -1 when the
## id is not in the table.
func _weapon_slot(weapon_id: String) -> int:
    var index := WEAPON_ORDER.find(weapon_id)
    return index + 1 if index >= 0 else -1


func _find_local_player() -> Player:
    ## Walk up from the HUD to a player node (the HUD is parented to the local
    ## player, see the `.tscn` comment in `scenes/hud.tscn`), then fall back to
    ## a unique-name lookup for the case where a parent re-parents the HUD.
    var node: Node = get_parent()
    while node != null:
        if node is Player:
            return node as Player
        node = node.get_parent()
    var candidate := get_tree().get_first_node_in_group("local_player") if is_inside_tree() else null
    if candidate is Player:
        return candidate as Player
    return null


func _display_name(peer_id: int) -> String:
    if _world != null and is_instance_valid(_world):
        var node := _world.get_node_or_null(str(peer_id))
        if node != null and node is Player:
            var p := node as Player
            if "player_name" in p and not String(p.player_name).is_empty():
                return String(p.player_name)
    return "Player %d" % peer_id


# ---------------------------------------------------------------- signals

func _on_phase_changed(phase: int) -> void:
    # New round: the previous round's kills are irrelevant, so the feed starts
    # clean. (Matches CS 1.6: the kill list clears between rounds.)
    if phase == PHASE_BUY_TIME or phase == PHASE_WAITING:
        _clear_kill_feed()
    _kill_accum = 0.0
    if is_node_ready():
        _refresh()


func _on_score_changed(_team_t: int, _team_ct: int) -> void:
    if not is_node_ready():
        return
    if score_t_label != null and score_ct_label != null:
        _update_score(_game_state)
