#!/usr/bin/env bash
# ============================================================================
#  Battle-AQ — VPS installer (run from WSL/Linux, inside the git checkout)
#
#       git pull && deploy/install.sh        deploy what is on main
#       deploy/install.sh --inspect          read-only look at the server
#       deploy/install.sh --dry-run          show what would happen
#
#  Installs the game server as the `battle-aq` systemd service, listening on
#  127.0.0.1:PORT. The arcade (capy-leap's installer) owns nginx and routes
#  /battle/ -> 127.0.0.1:PORT, so after the first install run the arcade
#  installer once to add the route and the picker card.
#
#  Settings come from deploy/deploy.conf (gitignored); flags override:
#    --host user@vps   --port 8095   --map de_aq_dust   --key FILE   --stale
# ============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
HOST=""; PORT=8095; MAP="de_aq_dust"; SSH_KEY=""; INSPECT=0; DRY=0; STALE=0
[ -f "$HERE/deploy.conf" ] && . "$HERE/deploy.conf"

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_info() { printf '\033[36m==> %s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m!!  %s\033[0m\n' "$*"; }
die()    { printf '\033[31m!!  %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --map) MAP="${2:?}"; shift 2 ;;
    --key|-i) SSH_KEY="${2:?}"; shift 2 ;;
    --inspect) INSPECT=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --stale) STALE=1; shift ;;
    -h|--help) awk 'NR>1{ if(/^#/){sub(/^# ?/,"");print} else exit }' "$0"; exit 0 ;;
    *) die "unknown option: $1  (try --help)" ;;
  esac
done
[ -n "$HOST" ] || die "no host: cp deploy/deploy.conf.example deploy/deploy.conf and set HOST (or pass --host user@vps)"

WORK="$(mktemp -d)"
SSH_OPTS=(-o ControlMaster=auto -o ControlPath="$WORK/cm.sock" -o ControlPersist=300 -o ConnectTimeout=20)
[ -n "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY")
cleanup(){ ssh "${SSH_OPTS[@]}" -O exit "$HOST" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

# ---------------------------------------------------------------- inspect
if [ "$INSPECT" = 1 ]; then
  c_info "read-only look at $HOST"
  ssh "${SSH_OPTS[@]}" "$HOST" "PORT=$PORT bash -s" <<'ZI'
echo "node:    $(command -v node >/dev/null && node -v || echo missing)"
echo "service: $(systemctl is-active battle-aq 2>/dev/null || echo not installed)"
echo "listen:  $(ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ":$PORT\$" || echo "nothing on :$PORT")"
echo "health:  $(curl -s --max-time 3 http://127.0.0.1:$PORT/info || echo none)"
echo "nginx:   $(grep -ls 'location \^~ /battle/' /etc/nginx/sites-enabled/* 2>/dev/null | head -1 || true)"
ls -la /opt/battle-aq 2>/dev/null | tail -n +2 || echo "no /opt/battle-aq yet"
ZI
  exit 0
fi

# ---------------------------------------------------------------- source
cd "$REPO"
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  REV="$(git rev-parse --short HEAD)"
  if [ "$STALE" = 0 ] && git fetch -q origin 2>/dev/null; then
    BEHIND="$(git rev-list --count HEAD..origin/"$BRANCH" 2>/dev/null || echo 0)"
    [ "$BEHIND" -gt 0 ] && die "origin/$BRANCH has $BEHIND newer commit(s): git pull first (or --stale)"
  fi
  [ -n "$(git status --porcelain -- web)" ] && c_warn "web/ has uncommitted changes — deploying them anyway"
else
  BRANCH="-"; REV="nogit"
fi
STAMP="$(date -u +%Y%m%d-%H%M%S)-$REV"
[ -f web/node_modules/ws/package.json ] || (cd web && npm ci --omit=dev --no-audit --no-fund >/dev/null) \
  || die "web/node_modules/ws missing and npm ci failed"

c_info "packing $BRANCH@$REV"
tar -czf "$WORK/battle-aq.tar.gz" -C web --exclude='./public/vendor/addons/.cache' \
  package.json server shared public node_modules/ws
sed -e "s|__PORT__|$PORT|" -e "s|__MAP__|$MAP|" "$HERE/battle-aq.service" > "$WORK/battle-aq.service"
SIZE="$(du -h "$WORK/battle-aq.tar.gz" | cut -f1)"

if [ "$DRY" = 1 ]; then
  c_info "would upload $SIZE to $HOST:/opt/battle-aq/releases/$STAMP and install:"
  sed 's/^/    /' "$WORK/battle-aq.service"
  c_warn "nothing was changed. Drop --dry-run to apply."
  exit 0
fi

c_info "connecting to $HOST"
ssh "${SSH_OPTS[@]}" "$HOST" true || die "could not connect to $HOST"
c_info "uploading $SIZE"
ssh "${SSH_OPTS[@]}" "$HOST" "cat > /tmp/battle-aq.tar.gz" < "$WORK/battle-aq.tar.gz"
ssh "${SSH_OPTS[@]}" "$HOST" "cat > /tmp/battle-aq.service" < "$WORK/battle-aq.service"

cat > "$WORK/remote.sh" <<'REMOTE'
set -e
S=""; if [ "$(id -u)" != 0 ]; then S=sudo; sudo -n true 2>/dev/null || { echo "--> sudo password needed"; sudo -v; }; fi
if ! command -v node >/dev/null; then
  echo "--> installing node"; $S apt-get update -qq; $S apt-get install -y -qq nodejs
fi
MAJOR="$(node -v | sed 's/^v//; s/\..*//')"
[ "$MAJOR" -ge 16 ] || { echo "!! node $(node -v) is too old (need 16+)"; exit 1; }
D=/opt/battle-aq
$S mkdir -p "$D/releases/$STAMP"
$S tar -xzf /tmp/battle-aq.tar.gz -C "$D/releases/$STAMP"
$S chown -R root:root "$D/releases/$STAMP"; $S chmod -R a+rX "$D/releases/$STAMP"
$S ln -sfn "$D/releases/$STAMP" "$D/current"
$S cp /tmp/battle-aq.service /etc/systemd/system/battle-aq.service
# first deploy: an rcon password for the admin (see: sudo cat /etc/battle-aq.env)
if [ ! -f /etc/battle-aq.env ]; then
  echo "RCON_PASSWORD=$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)" | $S tee /etc/battle-aq.env >/dev/null
  $S chmod 600 /etc/battle-aq.env
  echo "--> created /etc/battle-aq.env with an rcon password"
fi
rm -f /tmp/battle-aq.tar.gz /tmp/battle-aq.service
$S systemctl daemon-reload
$S systemctl enable battle-aq >/dev/null 2>&1 || true
$S systemctl restart battle-aq
for i in 1 2 3 4 5 6; do sleep 1; curl -s --max-time 2 "http://127.0.0.1:$PORT/info" >/dev/null && break; done
if curl -s --max-time 3 "http://127.0.0.1:$PORT/info"; then echo; echo "--> battle-aq up on 127.0.0.1:$PORT"
else echo "!! battle-aq did not come up:"; $S journalctl -u battle-aq -n 30 --no-pager; exit 1; fi
# keep the last 3 releases
ls -1dt "$D"/releases/* | tail -n +4 | xargs -r $S rm -rf
rm -f /tmp/battle-aq-remote.sh
if grep -qs 'location \^~ /battle/' /etc/nginx/sites-enabled/*; then echo "ROUTED"; else echo "NOT_ROUTED"; fi
REMOTE
ssh "${SSH_OPTS[@]}" "$HOST" "cat > /tmp/battle-aq-remote.sh" < "$WORK/remote.sh"
# -t: sudo may need to ask for a password
ssh -t "${SSH_OPTS[@]}" "$HOST" "STAMP=$STAMP PORT=$PORT bash /tmp/battle-aq-remote.sh"
c_ok "deployed $REV"
echo "If the output above ends in NOT_ROUTED, add the arcade route + card once:"
echo "    cd ~/capyleap-arcade && git pull && ./install.sh"
