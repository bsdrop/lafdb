#!/bin/sh
podman run --rm \
  --network=host \
  -v /srv/data/lafdb:/lafdb \
  localhost/lafdb-dev:latest \
  /lafdb/container-build.sh
