#!/bin/sh
# mirasim-windows-ssh-fix: install the glibc 2.17 compatibility runtime for Mirasim's remote
# server on this Linux machine.
#
# The patched Windows client uploads these files into ~/.mirasim-remote/tmp and runs this
# script over SSH right before it launches the remote server:
#   node-v<version>-linux-x64-glibc-217.tar.xz   only when the store does not hold it yet
#   pty-node-napi-glibc217.node                  node-pty built on an old glibc (N-API)
#   legacy-runtime-fix.sh                        the swap script, see below
#
# Result:
#   ~/.mirasim-remote/compat/node, pty.node, fix.sh, VERSION, NODE_LICENSE
#   ~/.ssh/rc runs fix.sh before every SSH session, so later Mirasim upgrades keep working
#     even when the Windows client is updated and loses its patch
#   the active payload (~/.mirasim-remote/current) switched to the compatibility Node.js
#
# Undo: remove the marked block from ~/.ssh/rc and delete ~/.mirasim-remote/compat.
set -eu
RUNTIME="node-v24.19.0-linux-x64-glibc-217"
BASE="$HOME/.mirasim-remote"
TMP="$BASE/tmp"
COMPAT="$BASE/compat"
CURRENT="$(cd "$BASE/current" && pwd -P)"
case "$CURRENT" in
  "$BASE"/servers/*) ;;
  *) echo "unexpected current target: $CURRENT" >&2; exit 1 ;;
esac

mkdir -p "$COMPAT"
chmod 700 "$COMPAT"

if [ "$(cat "$COMPAT/VERSION" 2>/dev/null)" != "$RUNTIME" ] || ! "$COMPAT/node" --version >/dev/null 2>&1; then
  [ -f "$TMP/$RUNTIME.tar.xz" ] || { echo "missing $TMP/$RUNTIME.tar.xz" >&2; exit 1; }
  rm -rf "$COMPAT/.extract"
  mkdir -p "$COMPAT/.extract"
  tar -xJf "$TMP/$RUNTIME.tar.xz" -C "$COMPAT/.extract" "$RUNTIME/bin/node" "$RUNTIME/LICENSE"
  install -m 755 "$COMPAT/.extract/$RUNTIME/bin/node" "$COMPAT/node.tmp"
  mv -f "$COMPAT/node.tmp" "$COMPAT/node"
  cp "$COMPAT/.extract/$RUNTIME/LICENSE" "$COMPAT/NODE_LICENSE"
  rm -rf "$COMPAT/.extract"
  printf '%s\n' "$RUNTIME" >"$COMPAT/VERSION"
fi
"$COMPAT/node" --version >/dev/null

install -m 755 "$TMP/pty-node-napi-glibc217.node" "$COMPAT/pty.node.tmp"
mv -f "$COMPAT/pty.node.tmp" "$COMPAT/pty.node"
"$COMPAT/node" -e \
  "const binding={exports:{}}; process.dlopen(binding, process.argv[1]); if(typeof binding.exports.fork!=='function') process.exit(1);" \
  "$COMPAT/pty.node"

install -m 700 "$TMP/legacy-runtime-fix.sh" "$COMPAT/fix.sh.tmp"
mv -f "$COMPAT/fix.sh.tmp" "$COMPAT/fix.sh"

# Hook every SSH session. sshd runs ~/.ssh/rc before the session's command; when this file
# exists sshd no longer adds X11 cookies itself, so a freshly created rc does that first.
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
RC="$HOME/.ssh/rc"
if ! grep -qs 'mirasim-windows-ssh-fix' "$RC"; then
  if [ ! -f "$RC" ]; then
    cat >"$RC" <<'EOF'
#!/bin/sh
# Created by mirasim-windows-ssh-fix. sshd runs this file before every SSH session.
# X11 forwarding cookie handling, taken from sshd(8), because sshd skips it when ~/.ssh/rc exists.
if read proto cookie && [ -n "${DISPLAY:-}" ]; then
  if [ "$(echo "$DISPLAY" | cut -c1-10)" = 'localhost:' ]; then
    echo add "unix:$(echo "$DISPLAY" | cut -c11-)" "$proto" "$cookie"
  else
    echo add "$DISPLAY" "$proto" "$cookie"
  fi | xauth -q -
fi
EOF
  fi
  cat >>"$RC" <<'EOF'
# >>> mirasim-windows-ssh-fix >>>
# Keep ~/.mirasim-remote runnable on this machine's glibc before every SSH command.
# Remove this block and ~/.mirasim-remote/compat to undo.
[ -f "$HOME/.mirasim-remote/compat/fix.sh" ] && sh "$HOME/.mirasim-remote/compat/fix.sh" >/dev/null 2>&1
# <<< mirasim-windows-ssh-fix <<<
EOF
  chmod 600 "$RC"
fi

# Switch the active payload now and prove node-pty loads under it.
rm -f "$CURRENT/.mirasim-compat-checked"
sh "$COMPAT/fix.sh"
cd "$CURRENT"
"$CURRENT/node" -e \
  "const pty=require('./node_modules/node-pty'); if(typeof pty.spawn!=='function') process.exit(1); process.stdout.write(process.version+'\n');"
printf 'node=%s\n' "$("$CURRENT/node" --version)" >"$CURRENT/.windows-compat-runtime"

rm -f "$TMP/$RUNTIME.tar.xz" "$TMP/pty-node-napi-glibc217.node" "$TMP/legacy-runtime-fix.sh"
