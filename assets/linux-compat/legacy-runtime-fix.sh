#!/bin/sh
# mirasim-windows-ssh-fix: keep the active Mirasim remote server runnable on an old glibc.
#
# Every Mirasim upgrade delivers a fresh payload into ~/.mirasim-remote/servers/<version>/
# whose bundled Node.js needs glibc 2.28. This script replaces that Node.js (and the
# node-pty binary beside it) with the compatibility copies kept in
# ~/.mirasim-remote/compat, which run on glibc 2.17 and newer.
#
# It is started
#   - by install-legacy-runtime.sh right after the compatibility store is prepared, and
#   - from ~/.ssh/rc at the start of every SSH session, which is how it also runs between
#     Mirasim's "deliver" and "launch" steps after any future update, without a client patch.
#
# It writes nothing to stdout (sshd would forward that to the SSH client) and returns in a
# few milliseconds when the active payload was already checked.
set -u
BASE="$HOME/.mirasim-remote"
COMPAT="$BASE/compat"
[ -x "$COMPAT/node" ] || exit 0
CURRENT="$(cd "$BASE/current" 2>/dev/null && pwd -P)" || exit 0
case "$CURRENT" in
  "$BASE"/servers/*) ;;
  *) exit 0 ;;
esac
[ -f "$CURRENT/node" ] || exit 0

identity() { stat -c '%d:%i:%s' "$1" 2>/dev/null || ls -li "$1" 2>/dev/null; }
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$COMPAT/fix.log"; }
STAMP="$CURRENT/.mirasim-compat-checked"
[ "$(cat "$STAMP" 2>/dev/null)" = "$(identity "$CURRENT/node")" ] && exit 0

if "$CURRENT/node" --version >/dev/null 2>&1; then
  # The delivered Node.js runs on this machine: leave the payload exactly as shipped.
  identity "$CURRENT/node" >"$STAMP"
  exit 0
fi

if ! cp "$COMPAT/node" "$CURRENT/node.compat.tmp" ||
   ! chmod 755 "$CURRENT/node.compat.tmp" ||
   ! mv -f "$CURRENT/node.compat.tmp" "$CURRENT/node"; then
  rm -f "$CURRENT/node.compat.tmp"
  log "$(basename "$CURRENT"): could not replace node"
  exit 0
fi

PTY_DIR="$CURRENT/node_modules/node-pty/prebuilds/linux-x64"
if [ -f "$COMPAT/pty.node" ] && [ -d "$PTY_DIR" ] &&
   ! "$CURRENT/node" -e "process.dlopen({exports:{}},process.argv[1])" "$PTY_DIR/pty.node" >/dev/null 2>&1; then
  cp "$COMPAT/pty.node" "$PTY_DIR/pty.node.compat.tmp" &&
    chmod 755 "$PTY_DIR/pty.node.compat.tmp" &&
    mv -f "$PTY_DIR/pty.node.compat.tmp" "$PTY_DIR/pty.node"
fi

identity "$CURRENT/node" >"$STAMP"
log "$(basename "$CURRENT"): replaced node with $("$CURRENT/node" --version 2>/dev/null || echo '?') from $COMPAT"
exit 0
