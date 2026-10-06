#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$SCRIPT_DIR"
if [ "$(uname -s)" = Darwin ]; then /usr/bin/caffeinate -s -w $$ & fi
exec "${NODE_BINARY:-node}" "$SCRIPT_DIR/build/server.js"
