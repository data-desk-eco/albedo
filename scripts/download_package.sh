#!/usr/bin/env bash
# Download a complete self-contained Albedo deployment from GCS
# No build tools required — just curl and zip
# Usage: ./scripts/download_package.sh [output.zip]
set -euo pipefail

GCS_BASE="https://storage.googleapis.com/albedo-data"
OUTPUT="${1:-albedo-$(date +%Y%m%d).zip}"
STAGING=$(mktemp -d)
trap "rm -rf $STAGING" EXIT

echo "Downloading Albedo from GCS..."

# App files (built Vite output)
echo "  App files..."
mkdir -p "$STAGING/assets" "$STAGING/data/places" "$STAGING/data/export/i18n"

curl -sfL "$GCS_BASE/app/index.html" -o "$STAGING/index.html"
# Download all JS/CSS assets
for file in $(curl -sfL "$GCS_BASE/app/assets.txt"); do
  curl -sfL "$GCS_BASE/app/assets/$file" -o "$STAGING/assets/$file"
done

# Places data (bundled with the app)
for file in $(curl -sfL "$GCS_BASE/app/places.txt"); do
  curl -sfL "$GCS_BASE/app/data/places/$file" -o "$STAGING/data/places/$file"
done

# Manifest (relative-URL version for self-contained deployment)
echo "  ↓ manifest.json"
curl -sfL "$GCS_BASE/app/manifest.json" -o "$STAGING/data/export/manifest.json"

# Data files
echo "  Data files..."
DATA_FILES=(
  vessel_heatmap.tif
  vessel_heatmap_fishing.tif
  vessel_heatmap_cargo.tif
  vessel_heatmap_passenger.tif
  vessel_heatmap_carrier.tif
  vessel_heatmap_flag_foreign.tif
  vessel_heatmap_flag_rus.tif
  vessel_heatmap_flag_nor.tif
  vessel_heatmap_flag_pan.tif
  vessel_heatmap_flag_lbr.tif
  vessel_heatmap_flag_mhl.tif
  vessel_heatmap_flag_mlt.tif
  vessel_heatmap_flag_chn.tif
  vessel_heatmap_flag_gbr.tif
  vectors.pmtiles
  vessel_data.bin
  sanctioned_mmsi.json
  vessel_metadata.json
  i18n/en.json
  i18n/ru.json
)

for file in "${DATA_FILES[@]}"; do
  echo "  ↓ $file"
  curl -sfL "$GCS_BASE/$file" -o "$STAGING/data/export/$file" || echo "  ⚠ $file not found, skipping"
done

# Create zip
echo ""
echo "Creating $OUTPUT..."
cd "$STAGING" && zip -r "$OLDPWD/$OUTPUT" . -x '*.DS_Store'
cd "$OLDPWD"

SIZE=$(du -h "$OUTPUT" | cut -f1)
echo ""
echo "Done: $OUTPUT ($SIZE)"
echo ""
echo "Deployment:"
echo "  1. Unzip to any static hosting root (S3, GCS, Nginx, etc.)"
echo "  2. Server must support HTTP Range requests (for COG + PMTiles)"
echo "  3. If cross-origin, add CORS headers:"
echo "     Access-Control-Allow-Headers: Range"
echo "     Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length"
