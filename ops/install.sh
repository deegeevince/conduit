#!/usr/bin/env bash
# Installs Conduit as a launchd LaunchAgent on this Mac.
#
#   OWNER_LOGINS=<your tailscale login> ops/install.sh [--dry-run] [--keep-awake] [--no-owner-check]
#
# What it does, in order:
#   1. builds the COMMITTED code (git archive of HEAD, so what runs is what was reviewed) into a stable folder, $INSTALL_DIR
#      (default ~/.conduit/app), installs its packages and builds the web app there;
#   2. writes ops/conduit.plist, filled in, to ~/Library/LaunchAgents/com.conduit.server.plist;
#   3. loads it (RunAtLoad, KeepAlive): the server is up, and comes back after a crash, a reboot and a login.
# It changes THIS MACHINE. It does not touch the data folder (~/Library/Application Support/Conduit), tailscale serve, or any worktree.
# `--dry-run` does steps 1 and 2 into a temporary folder and prints what a real run would do; it loads nothing and writes nothing outside it.
#
# Settings come from the environment of this command; all optional but OWNER_LOGINS:
#   OWNER_LOGINS      comma list of Tailscale logins allowed through `tailscale serve`. Required (see --no-owner-check). Read it from the
#                     running app: curl -s http://127.0.0.1:4600/api/whoami (through the tailnet address, not localhost) shows `login`.
#   TRUSTED_HOSTS     default your-mac.your-tailnet.ts.net
#   BATTERY_SEALED_DIR default ~/.conduit-sealed
#   DATA_DIR          default ~/Library/Application Support/Conduit
#   INSTALL_DIR       default ~/.conduit/app
#   USAGE_HOURLY_CAP, MIGRATE_FROM (other checkouts whose logs/ to copy, once), AGENT, AGENT_SERVICES, STATUS_FILE, CHANGELOG_FILE: passed through when set.
#   --keep-awake      run under `caffeinate -is`: no idle sleep, and no system sleep on AC power, while the service runs. A closed lid on
#                     battery still sleeps the Mac; see docs/runbook.md "Sleep".
set -euo pipefail

LABEL="com.conduit.server"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
DRY=0; KEEP_AWAKE=0; OWNER_CHECK=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --keep-awake) KEEP_AWAKE=1 ;;
    --no-owner-check) OWNER_CHECK=0 ;;
    *) echo "install: unknown option $arg" >&2; exit 2 ;;
  esac
done

die() { echo "install: $*" >&2; exit 1; }
[ "$(uname)" = "Darwin" ] || die "this installs a launchd agent and only runs on macOS"

NODE="$(command -v node || true)"; [ -n "$NODE" ] || die "node is not on PATH (22.14 or newer; see .nvmrc)"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=14)?0:1)' || die "node $("$NODE" -v) is too old: 22.14 or newer"
PNPM="$(command -v pnpm || true)"; [ -n "$PNPM" ] || die "pnpm is not on PATH (corepack enable)"
CLAUDE="$(command -v claude || true)"; [ -n "$CLAUDE" ] || die "the claude CLI is not on PATH: the brain is claude-cli"
REMOTE="$(command -v remote || true)"

if [ "$OWNER_CHECK" = 1 ] && [ -z "${OWNER_LOGINS:-}" ]; then
  die "OWNER_LOGINS is not set. Without it anyone on the tailnet who can reach the port may use the server, and its agent tools. Set it to your Tailscale login, or pass --no-owner-check to go without."
fi

INSTALL_DIR="${INSTALL_DIR:-$HOME/.conduit/app}"
DATA_DIR="${DATA_DIR:-$HOME/Library/Application Support/Conduit}"
TRUSTED_HOSTS="${TRUSTED_HOSTS:-your-mac.your-tailnet.ts.net}"
BATTERY_SEALED_DIR="${BATTERY_SEALED_DIR:-$HOME/.conduit-sealed}"
case "$INSTALL_DIR" in */worktrees/*|*/.claude/*) die "INSTALL_DIR must not be inside a worktree: $INSTALL_DIR" ;; esac
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git checkout"
COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"
DIRTY="$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ')"
[ "$DIRTY" = 0 ] || echo "install: note: $DIRTY uncommitted change(s) in $REPO are NOT installed; only commit $COMMIT is" >&2

if [ "$DRY" = 1 ]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/conduit-install-dryrun.XXXXXX")"
  INSTALL_DIR="$WORK/app"; PLIST="$WORK/$LABEL.plist"; DATA_DIR_NOTE="(dry run: nothing is created in $DATA_DIR)"
else
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"; DATA_DIR_NOTE=""
fi
UID_="$(id -u)"; DOMAIN="gui/$UID_"

if [ "$DRY" = 0 ]; then
  if lsof -nP -iTCP:4600 -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    die "something else is listening on port 4600 (the nohup server?). Stop it first: this service takes the port."
  fi
fi

echo "install: commit $COMMIT -> $INSTALL_DIR ${DATA_DIR_NOTE}"
STAGE="$INSTALL_DIR.new"
rm -rf "$STAGE"; mkdir -p "$STAGE"
git -C "$REPO" archive HEAD | tar -x -C "$STAGE"
if [ "$DRY" = 0 ]; then
  ( cd "$STAGE" && CI=1 "$PNPM" install --frozen-lockfile && "$PNPM" build ) || { rm -rf "$STAGE"; die "the build failed; nothing was changed"; }
else
  echo "install: (dry run) would run: pnpm install --frozen-lockfile && pnpm build in $STAGE"
fi

# The plist: the template with its tokens filled in, then the optional settings added with PlistBuddy (values are never put through sed).
PATH_VALUE="$(dirname "$NODE"):$(dirname "$CLAUDE")${REMOTE:+:$(dirname "$REMOTE")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
esc() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
sed -e "s|@LABEL@|$(esc "$LABEL")|g" -e "s|@NODE@|$(esc "$NODE")|g" -e "s|@INSTALL_DIR@|$(esc "$INSTALL_DIR")|g" \
    -e "s|@DATA_DIR@|$(esc "$DATA_DIR")|g" -e "s|@TRUSTED_HOSTS@|$(esc "$TRUSTED_HOSTS")|g" -e "s|@BATTERY_SEALED_DIR@|$(esc "$BATTERY_SEALED_DIR")|g" \
    -e "s|@CLAUDE_BIN@|$(esc "$CLAUDE")|g" -e "s|@PATH@|$(esc "$PATH_VALUE")|g" -e "s|@HOME@|$(esc "$HOME")|g" \
    "$HERE/conduit.plist" > "$PLIST.tmp"
PB=/usr/libexec/PlistBuddy
for name in OWNER_LOGINS USAGE_HOURLY_CAP MIGRATE_FROM AGENT AGENT_SERVICES STATUS_FILE CHANGELOG_FILE; do
  value="${!name:-}"
  [ -z "$value" ] || "$PB" -c "Add :EnvironmentVariables:$name string $(printf '%s' "$value" | sed 's/"/\\"/g; s/^/"/; s/$/"/')" "$PLIST.tmp"
done
if [ "$KEEP_AWAKE" = 1 ]; then
  # caffeinate runs the command it is given and holds the Mac awake for exactly as long as that command runs: caffeinate -is <node> <tsx> src/main.ts
  "$PB" -c "Delete :ProgramArguments" -c "Add :ProgramArguments array" \
    -c "Add :ProgramArguments: string /usr/bin/caffeinate" -c "Add :ProgramArguments: string -is" \
    -c "Add :ProgramArguments: string $NODE" -c "Add :ProgramArguments: string $INSTALL_DIR/server/node_modules/tsx/dist/cli.mjs" -c "Add :ProgramArguments: string src/main.ts" "$PLIST.tmp"
fi
plutil -lint "$PLIST.tmp" >/dev/null || die "the plist it made does not lint: $PLIST.tmp"

if [ "$DRY" = 1 ]; then
  mv "$PLIST.tmp" "$PLIST"
  echo "install: (dry run) the plist would be:"; plutil -p "$PLIST" | sed -e 's/OWNER_LOGINS" => .*/OWNER_LOGINS" => (set, hidden)/'
  echo "install: (dry run) then: launchctl bootstrap $DOMAIN ~/Library/LaunchAgents/$LABEL.plist ; launchctl kickstart -k $DOMAIN/$LABEL"
  echo "install: (dry run) left in $WORK; delete it when done"
  exit 0
fi

# Swap in: stop the old one, keep the old app as .prev, start the new.
mkdir -p "$HOME/Library/LaunchAgents" "$DATA_DIR"; chmod 700 "$DATA_DIR" || true
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ -d "$INSTALL_DIR" ]; then rm -rf "$INSTALL_DIR.prev"; mv "$INSTALL_DIR" "$INSTALL_DIR.prev"; fi
mv "$STAGE" "$INSTALL_DIR"
mv "$PLIST.tmp" "$PLIST"; chmod 600 "$PLIST"   # it may hold OWNER_LOGINS
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

echo "install: waiting for the server on 127.0.0.1:4600 ..."
for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 http://127.0.0.1:4600/api/health >/dev/null 2>&1; then
    echo "install: up. logs: $DATA_DIR/service.log   status: launchctl print $DOMAIN/$LABEL | head"
    echo "install: not exposed by this script: tailscale serve is yours (it already points :8444 at 127.0.0.1:4600)"
    exit 0
  fi
  sleep 1
done
die "the server did not answer in 40 s. Look at $DATA_DIR/service.log. The previous version, if any, is in $INSTALL_DIR.prev"
