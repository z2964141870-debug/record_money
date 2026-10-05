#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$SCRIPT_DIR"
/usr/bin/caffeinate -s -w $$ &
exec "${NODE_BINARY:-/usr/local/bin/node}" "$SCRIPT_DIR/build/server.js"
