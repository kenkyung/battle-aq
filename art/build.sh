#!/usr/bin/env bash
# Rebuild every Blender-made asset into web/public/assets/.
#
#   art/build.sh                 everything (~4 min on 16 cores; the map bakes dominate)
#   art/build.sh textures        just one stage: textures | maps | characters | weapons
#   BLENDER=/path/to/blender art/build.sh
#
# Needs Blender 4.2+ (tested on 4.5 LTS; headless is fine) and node.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BLENDER="${BLENDER:-$(command -v blender || echo "$HOME/tools/blender")}"
[ -x "$BLENDER" ] || { echo "blender not found: set BLENDER=/path/to/blender"; exit 1; }
run() { echo "== $1"; "$BLENDER" -b --factory-startup -P "$HERE/blender/$1.py" -- "${@:2}" 2>&1 \
  | grep -E "^(wrote|==|   trimmed|soldier_|[a-z0-9_]+: [0-9]+ tris)|Error|Traceback" || true; }
STAGE="${1:-all}"
case "$STAGE" in all|textures) run build_textures ;; esac
case "$STAGE" in all|maps)
  (cd "$REPO/web" && node tools/export-maps.mjs ../art/build/maps)
  run build_maps ;; esac
case "$STAGE" in all|characters) run build_characters ;; esac
case "$STAGE" in all|weapons) run build_weapons ;; esac
