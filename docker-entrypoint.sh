#!/bin/sh
# Starts as root only to make /data writable for the node user (volumes from older versions
# belong to root), then runs the app as node.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  chown -R node:node "${DATA_DIR:-/data}"
  exec su-exec node "$@"
fi
exec "$@"
