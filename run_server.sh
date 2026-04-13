#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# Define color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
RESET='\033[0m'

# Function to ask for user input
ask() {
    local message="$1" default="${2:-n}" answer
    printf "${YELLOW}%s${RESET} [%s] " "$message" "$([ "$default" = y ] && echo 'Y/n' || echo 'y/N')"
    read -r answer
    answer="${answer:-$default}"
    [[ "$answer" =~ ^[Yy]$ ]]
}

REBUILD_CACHE=false
SCRAPER_FLAGS=""

echo -e "${BLUE}=== lafdb run_server ===${RESET}"
if ask "Rebuild?" y; then
    echo -e "${GREEN}▶ bun build.mjs && go build -o bin/lafdb . && go build -o bin/scraper ./cmd/scraper && go build -o bin/drm ./cmd/drm${RESET}"
    # ln -sf ../THIRD-PARTY-NOTICES.md public/;
    bun build.mjs
    go build -o bin/lafdb .
    go build -o bin/scraper ./cmd/scraper
    go build -o bin/drm ./cmd/drm
    echo -e "${GREEN}Build completed${RESET}"
fi

if ask "Perform scraping?"; then
    ask "Skip items?"      && SCRAPER_FLAGS+=" --skip-items"
    ask "Skip episodes?"   && SCRAPER_FLAGS+=" --skip-episodes"
    ask "Skip reviews?"    && SCRAPER_FLAGS+=" --skip-reviews"
    ask "Skip statistics?" && SCRAPER_FLAGS+=" --skip-statistics"
    ask "Skip comments?"   && SCRAPER_FLAGS+=" --skip-comments"
    ask "Skip thumbnails?" && SCRAPER_FLAGS+=" --skip-thumbnails"

    echo -e "${GREEN}▶ ./bin/scraper${SCRAPER_FLAGS}${RESET}"
    ./bin/scraper $SCRAPER_FLAGS
    REBUILD_CACHE=true
else
    if ask "Rebuild cache? (--rebuild-cache)"; then
        REBUILD_CACHE=true
    fi
fi

if ask "Collect DRM key?"; then
    DRM_TOKEN=""
    printf "${YELLOW}Laftel token:${RESET} "
    read -r DRM_TOKEN
    DRM_FLAGS=""
    ask "Skip previously failed episodes? (--skip-failed)" y && DRM_FLAGS+=" --skip-failed"

    echo -e "${GREEN}▶ ./bin/drm --token ...${DRM_FLAGS}${RESET}"
    ./bin/drm --token "$DRM_TOKEN" $DRM_FLAGS
fi

if $REBUILD_CACHE; then
    echo -e "${GREEN}▶ ./bin/lafdb --rebuild-cache${RESET}"
    exec ./bin/lafdb --rebuild-cache
else
    echo -e "${GREEN}▶ ./bin/lafdb${RESET}"
    exec ./bin/lafdb
fi
