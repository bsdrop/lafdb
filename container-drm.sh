#!/usr/bin/env bash
set -eu
cd /lafdb

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

sleep 3

exec /lafdb/bin/drm \
  --sleep 4003 \
  --token "${LAFTEL_TOKEN}" \
  --daemon \
  --skip-failed \
  --proxies /lafdb/scripts/proxies.txt
