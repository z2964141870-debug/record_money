#!/bin/sh
set -eu
mkdir -p /app/storage/data /app/storage/logs
chown node:node /app/storage /app/storage/data /app/storage/logs
exec /usr/sbin/runuser -u node -- "$@"
