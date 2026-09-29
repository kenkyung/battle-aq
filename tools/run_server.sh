#!/usr/bin/env bash
# Battle-AQ dedicated / listen server launcher.
#
# Usage:
#   tools/run_server.sh [--map de_aq_dust] [--port 24816] [--max-players 16] [--listen]
#
#   --listen   start a LISTEN server: you also play on this machine (needs a
#              display and a GPU). Without it you get a headless DEDICATED
#              server that only simulates.
#
# Godot is located via $GODOT, then `godot`/`godot4` on PATH, then the download
# Hermes keeps in ~/.hermes/cache/scratch/godot.
#
# The server prints the addresses to hand out on startup (Tailscale first, then
# LAN). Players reach it with:
#   godot --path . -- --connect <address> --port <port>

set -euo pipefail

MAP="de_aq_dust"
PORT="24816"
MAX_PLAYERS="16"
MODE="--server"
HEADLESS="--headless"

usage() {
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --map)         MAP="${2:?--map needs a value}"; shift 2 ;;
        --port)        PORT="${2:?--port needs a value}"; shift 2 ;;
        --max-players) MAX_PLAYERS="${2:?--max-players needs a value}"; shift 2 ;;
        --listen)      MODE="--host"; HEADLESS=""; shift ;;
        -h|--help)     usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; echo; usage >&2; exit 2 ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

find_godot() {
    if [[ -n "${GODOT:-}" && -x "${GODOT}" ]]; then printf '%s\n' "$GODOT"; return 0; fi
    local c
    for c in godot godot4; do
        if c="$(command -v "$c" 2>/dev/null)"; then printf '%s\n' "$c"; return 0; fi
    done
    local scratch="$HOME/.hermes/cache/scratch/godot"
    if [[ -d "$scratch" ]]; then
        local found
        # NB the binary is `Godot_v4.3-stable_linux.x86_64` — a DOT before
        # x86_64, not an underscore. Match any executable starting with Godot.
        found="$(find "$scratch" -maxdepth 3 -type f -name 'Godot*' -executable 2>/dev/null | head -1)"
        if [[ -n "$found" ]]; then printf '%s\n' "$found"; return 0; fi
    fi
    return 1
}

if ! GODOT_BIN="$(find_godot)"; then
    cat >&2 <<'EOF'
error: no Godot 4 binary found.

Install Godot 4.3+ (standard build, not Mono), or point at one explicitly:
    GODOT=/path/to/Godot_v4.3-stable_linux.x86_64 tools/run_server.sh

On Arch/Omarchy, Godot is in the AUR:
    omarchy pkg aur add godot
EOF
    exit 1
fi

echo "[run_server] godot       : $GODOT_BIN"
echo "[run_server] project     : $REPO_ROOT"
echo "[run_server] mode        : ${MODE#--}   map: $MAP   port: $PORT   max players: $MAX_PLAYERS"
echo

cd "$REPO_ROOT"
# $HEADLESS is intentionally unquoted: it is either --headless or empty.
# shellcheck disable=SC2086
exec "$GODOT_BIN" $HEADLESS --path . -- "$MODE" --map "$MAP" --port "$PORT" --max-players "$MAX_PLAYERS"
