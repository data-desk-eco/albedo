#!/usr/bin/env bash
# Generate manifest.json from template using .env values
set -euo pipefail

cd "$(dirname "$0")/.."
source .env

EXPORT_DIR="data/export"
mkdir -p "$EXPORT_DIR"

# COG base URL (empty for local/relative paths)
COG_BASE="${COG_BASE_URL:-}"

# Build COG URL (with optional base URL prefix)
COG_URL="${COG_BASE}vessel_heatmap.tif"

# Build cogsByType JSON from VESSEL_TYPES
IFS=',' read -ra TYPE_ARRAY <<< "${VESSEL_TYPES:-}"
COGS_BY_TYPE="{"
for i in "${!TYPE_ARRAY[@]}"; do
  type="${TYPE_ARRAY[$i]}"
  suffix=$(echo "$type" | tr '[:upper:]' '[:lower:]')
  [ $i -gt 0 ] && COGS_BY_TYPE+=","
  COGS_BY_TYPE+="\"${type}\":\"${COG_BASE}vessel_heatmap_${suffix}.tif\""
done
COGS_BY_TYPE+="}"

# Generate manifest from template
echo "Generating manifest.json..."

# Use envsubst for simple substitution
export COG_URL COGS_BY_TYPE COG_BASE_URL
export REGION_ID SOUTH_LAT NORTH_LAT WEST_LON EAST_LON
export CENTER_LON CENTER_LAT INITIAL_ZOOM MIN_ZOOM
export UI_TITLE UI_FAVICON DEFAULT_LANG AVAILABLE_LANGS
export SOURCE_URL SOURCE_LABEL SOURCE_LABEL_SHORT
export ABOUT_EN ABOUT_RU PLACES_JSON

envsubst < manifest.template.json > "$EXPORT_DIR/manifest.json"

echo "Done: $EXPORT_DIR/manifest.json"
