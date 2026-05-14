#!/usr/bin/env bash
set -eu
cd /lafdb
mkdir -p bin

clean_public_assets() {
  [ -d public ] || return 0
  find public -maxdepth 1 -type f \( -name '*.js' -o -name '*.css' \) \
    ! -name 'sw.js' \
    ! -name 'accessible.js' \
    -exec rm -f {} \;
}

if [ -f package.json ]; then
  if [ -f bun.lock ] || [ -f bun.lockb ]; then
    bun install
    clean_public_assets
    bun build.mjs
  elif [ -f pnpm-lock.yaml ]; then
    corepack enable || true
    pnpm install
    clean_public_assets
    node build.mjs
  else
    npm install
    clean_public_assets
    node build.mjs
  fi
fi


go build -buildvcs=false -o bin/lafdb .
go build -buildvcs=false -o bin/scraper ./cmd/scraper
go build -buildvcs=false -o bin/drm ./cmd/drm
