#!/usr/bin/env bash
set -eu

cd /lafdb

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

if [ ! -x /lafdb/bin/lafdb ]; then
  echo "missing /lafdb/bin/lafdb"
  exit 1
fi

if [ ! -x /lafdb/bin/drm ]; then
  echo "missing /lafdb/bin/drm"
  exit 1
fi

(
  cd /lafdb/scripts
  if [ -x /lafdb/scripts/.venv/bin/uvicorn ]; then
    exec /lafdb/scripts/.venv/bin/uvicorn server:app \
      --host 127.0.0.1 \
      --port 3040 \
      --loop uvloop \
      --http httptools \
      --no-access-log
  else
    exec uvicorn server:app \
      --host 127.0.0.1 \
      --port 3040 \
      --loop uvloop \
      --http httptools \
      --no-access-log
  fi
) &

sleep 3

(
  cd /lafdb
  exec /lafdb/bin/drm \
    --sleep 4003 \
    --token "${LAFTEL_TOKEN}" \
    --daemon \
    --skip-failed \
    --proxies /lafdb/scripts/proxies.txt
) &

exec /lafdb/bin/lafdb --cf-csp
