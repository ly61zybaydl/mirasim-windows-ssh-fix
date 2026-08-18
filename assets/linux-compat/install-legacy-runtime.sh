#!/bin/sh
set -eu

BASE="$HOME/.mirasim-remote"
CURRENT="$(cd "$BASE/current" && pwd -P)"
TMP="$BASE/tmp"
WORK="$TMP/windows-compat-node-v22.23.1"
NODE_ARCHIVE="$TMP/node-v22.23.1-linux-x64-glibc-217.tar.xz"
PTY_ASSET="$TMP/pty-node-v127-glibc217.node"
PTY_DIR="$CURRENT/node_modules/node-pty/prebuilds/linux-x64"

case "$CURRENT" in
  "$BASE"/servers/*) ;;
  *) echo "refusing unexpected current target: $CURRENT" >&2; exit 1 ;;
esac

rm -rf "$WORK"
mkdir -p "$WORK" "$PTY_DIR"
tar -xJf "$NODE_ARCHIVE" -C "$WORK"
NODE_SOURCE="$WORK/node-v22.23.1-linux-x64-glibc-217/bin/node"

[ -f "$CURRENT/node" ]
[ -f "$PTY_DIR/pty.node" ]
cp -p "$CURRENT/node" "$WORK/original-node"
cp -p "$PTY_DIR/pty.node" "$WORK/original-pty.node"

COMMITTED=0
rollback() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$COMMITTED" -ne 1 ]; then
    install -m 755 "$WORK/original-pty.node" "$PTY_DIR/pty.node.rollback.tmp"
    mv -f "$PTY_DIR/pty.node.rollback.tmp" "$PTY_DIR/pty.node"
    install -m 755 "$WORK/original-node" "$CURRENT/node.rollback.tmp"
    mv -f "$CURRENT/node.rollback.tmp" "$CURRENT/node"
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM

[ "$($NODE_SOURCE --version)" = 'v22.23.1' ]
$NODE_SOURCE -e \
  "const binding={exports:{}}; process.dlopen(binding, process.argv[1]); if(typeof binding.exports.fork!=='function') process.exit(1);" \
  "$PTY_ASSET"

install -m 755 "$PTY_ASSET" "$PTY_DIR/pty.node.windows-compat.tmp"
mv -f "$PTY_DIR/pty.node.windows-compat.tmp" "$PTY_DIR/pty.node"
install -m 755 "$NODE_SOURCE" "$CURRENT/node.windows-compat.tmp"
mv -f "$CURRENT/node.windows-compat.tmp" "$CURRENT/node"

cd "$CURRENT"
"$CURRENT/node" -e \
  "const pty=require('./node_modules/node-pty'); if(typeof pty.spawn!=='function') process.exit(1); process.stdout.write(process.version);"
printf '\nnode=v22.23.1\n' > "$CURRENT/.windows-compat-runtime.tmp"
mv -f "$CURRENT/.windows-compat-runtime.tmp" "$CURRENT/.windows-compat-runtime"

COMMITTED=1
trap - EXIT HUP INT TERM
rm -rf "$WORK"
rm -f "$NODE_ARCHIVE" "$PTY_ASSET"
