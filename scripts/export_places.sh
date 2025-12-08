#!/bin/bash
# Export place labels vector tiles
set -e

cd "$(dirname "$0")/.."
source .env

echo "Generating place labels for study area..."

# Filter and convert places to GeoJSON with only needed fields (Russia only)
ogr2ogr -f GeoJSON \
  -sql "SELECT NAME as name_en, NAME_RU as name_ru, POP_MAX as population, SCALERANK as scalerank, FEATURECLA as feature_class FROM ne_10m_populated_places WHERE SCALERANK <= 5 AND LATITUDE >= ${SOUTH_LAT} AND ADM0_A3 = 'RUS'" \
  data/places_filtered.geojson \
  data/ne_10m_populated_places/ne_10m_populated_places.shp

echo "✓ Filtered places to study area (latitude >= ${SOUTH_LAT}°, scalerank <= 5)"

# Generate place labels vector tiles
echo "Generating place labels vector tiles..."
tippecanoe -o data/places.pmtiles \
  --force \
  --maximum-zoom=10 \
  --minimum-zoom=0 \
  --drop-rate=0 \
  --no-feature-limit \
  --no-tile-size-limit \
  --layer=places \
  data/places_filtered.geojson

# Cleanup
rm -f data/places_filtered.geojson

echo "✓ Place labels: data/places.pmtiles"
