#!/bin/sh
set -eu

BUILD="$HOME/.mirasim-remote/compat-build-v22.23.1-pty-beta14"
NODE_ROOT="$BUILD/node-v22.23.1-linux-x64-glibc-217"
PTY_SOURCE="$BUILD/node-pty-source"

if [ ! -x "$NODE_ROOT/bin/node" ]; then
  tar -xJf "$BUILD/node-v22.23.1-linux-x64-glibc-217.tar.xz" -C "$BUILD"
fi

if [ ! -f "$PTY_SOURCE/binding.gyp" ]; then
  mkdir -p "$PTY_SOURCE"
  tar -xzf "$BUILD/node-pty-1.2.0-beta.14.tgz" --strip-components=1 -C "$PTY_SOURCE"
fi

if [ ! -f "$PTY_SOURCE/node_modules/node-addon-api/package.json" ]; then
  mkdir -p "$PTY_SOURCE/node_modules/node-addon-api"
  tar -xzf "$BUILD/node-addon-api-7.1.0.tgz" \
    --strip-components=1 \
    -C "$PTY_SOURCE/node_modules/node-addon-api"
fi

if [ -x "$HOME/anaconda3/bin/python" ]; then
  PYTHON="$HOME/anaconda3/bin/python"
else
  PYTHON="$(command -v python3)"
fi

cd "$PTY_SOURCE"
export PATH="$NODE_ROOT/bin:$PATH"
"$NODE_ROOT/bin/node" \
  "$NODE_ROOT/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js" \
  rebuild \
  --nodedir="$NODE_ROOT" \
  --python="$PYTHON"

install -m 755 "$PTY_SOURCE/build/Release/pty.node" "$BUILD/pty.node"
"$NODE_ROOT/bin/node" -e \
  "const binding={exports:{}}; process.dlopen(binding, process.argv[1]); if(typeof binding.exports.fork!=='function') throw new Error('node-pty fork export missing');" \
  "$BUILD/pty.node"
