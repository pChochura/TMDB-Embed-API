#!/bin/sh
set -e

# Fix ownership and permissions of mounted volumes/paths if present
for p in /app/utils/user-config.json /app/data /app/utils; do
  if [ -e "$p" ]; then
    chown -R app:app "$p" 2>/dev/null || true
    chmod -R u+rwX "$p" 2>/dev/null || true
  fi
done

# Step down from root to app user if running as root
if [ "$(id -u)" = '0' ]; then
  exec su-exec app "$@"
fi

exec "$@"
