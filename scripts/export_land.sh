#!/bin/bash
# Export land basemap vector tiles
set -e

cd "$(dirname "$0")/.."
source .env

echo "Generating land basemap for study area..."

# Clip land polygons to study area using ogr2ogr
ogr2ogr -f GeoJSON \
  -clipsrc -180 ${SOUTH_LAT} 180 90 \
  -simplify 0.01 \
  data/land_clipped.geojson \
  data/ne_10m_land/ne_10m_land.shp

echo "✓ Clipped land to northern cap (latitude ${SOUTH_LAT}° to 90°)"

# Generate land vector tiles
echo "Generating land vector tiles..."
tippecanoe -o data/land.pmtiles \
  --force \
  --maximum-zoom=10 \
  --minimum-zoom=0 \
  --no-feature-limit \
  --no-tile-size-limit \
  --simplification=10 \
  --layer=land \
  data/land_clipped.geojson

# Cleanup
rm -f data/land_clipped.geojson

echo "✓ Land basemap: data/land.pmtiles"
