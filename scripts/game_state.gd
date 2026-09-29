extends Node
## Round and match state. Server-authoritative; clients listen to RPCs to
## update the HUD. Kept intentionally small — the round flow is:
##
##   waiting -> buy_time (15s) -> round_time (1m55) -> round_end (5s) -> loop
##
## A team wins a round by eliminating the other team, or by completing the
## objective (plant/defuse, bomb timer) — objective scripts will live in a
## separate `objective.gd` later.

const BUY_TIME := 15.0
const ROUND_TIME := 115.0
const ROUND_END_TIME := 5.0
const ROUNDS_TO_WIN := 8

signal phase_changed(phase: int)
signal score_changed(team_t: int, team_ct: int)

enum Phase { WAITING, BUY_TIME, ROUND_TIME, ROUND_END }

var phase: int = Phase.WAITING
var score_t: int = 0
var score_ct: int = 0
var timer: float = 0.0


func _process(delta: float) -> void:
    if not multiplayer.is_server():
        return
    if phase == Phase.WAITING:
        return
    timer -= delta
    if timer <= 0.0:
        _advance_phase()


func start_round() -> void:
    if not multiplayer.is_server():
        return
    score_changed.emit(score_t, score_ct)
    _set_phase.rpc(Phase.BUY_TIME, BUY_TIME)


func _advance_phase() -> void:
    match phase:
        Phase.BUY_TIME:
            _set_phase.rpc(Phase.ROUND_TIME, ROUND_TIME)
        Phase.ROUND_TIME:
            # Timeout: defending team wins. Tweak to your objective.
            _round_wins.rpc(2)
        Phase.ROUND_END:
            if score_t >= ROUNDS_TO_WIN or score_ct >= ROUNDS_TO_WIN:
                _set_phase.rpc(Phase.WAITING, 0)
            else:
                start_round()
        _:
            pass


@rpc("authority", "call_local")
func _set_phase(new_phase: int, duration: float) -> void:
    phase = new_phase
    timer = duration
    phase_changed.emit(new_phase)


@rpc("authority", "call_local")
func _round_wins(winning_team: int) -> void:
    if winning_team == 1:
        score_t += 1
    else:
        score_ct += 1
    score_changed.emit(score_t, score_ct)
    _set_phase.rpc(Phase.ROUND_END, ROUND_END_TIME)