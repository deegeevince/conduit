#!/usr/bin/env bash
# Reverses ops/install.sh: stops the service and removes its LaunchAgent.
#
#   ops/uninstall.sh [--purge-app]
#
# It does NOT touch the data folder (~/Library/Application Support/Conduit: logs, audit trail, usage meter) or tailscale serve.
# `--purge-app` also deletes the installed copy (~/.conduit/app and its .prev); without it the app stays for a quick reinstall.
set -euo pipefail
LABEL="com.conduit.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.conduit/app}"
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge-app) PURGE=1 ;;
    *) echo "uninstall: unknown option $arg" >&2; exit 2 ;;
  esac
done
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" && echo "uninstall: stopped $LABEL"
else
  echo "uninstall: $LABEL was not loaded"
fi
if [ -f "$PLIST" ]; then rm -f "$PLIST" && echo "uninstall: removed $PLIST"; fi
if [ "$PURGE" = 1 ]; then
  case "$INSTALL_DIR" in */.conduit/app) rm -rf "$INSTALL_DIR" "$INSTALL_DIR.prev" "$INSTALL_DIR.new" && echo "uninstall: removed $INSTALL_DIR";; *) echo "uninstall: refusing to delete $INSTALL_DIR (not a .conduit/app folder)" >&2;; esac
fi
echo "uninstall: your data is untouched (${DATA_DIR:-$HOME/Library/Application Support/Conduit})"
