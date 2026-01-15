#!/usr/bin/env bash
# Export vectors.pmtiles for client-side rendering
# Replaces SQLite with PMTiles for vector layers
set -euo pipefail

source "$(dirname "$0")/../.env"

DATA_ROOT="$(dirname "$0")/../data"
EXPORT_DIR="$DATA_ROOT/export"
DUCKDB_PATH="$DATA_ROOT/data.duckdb"
TEMP_DIR="$DATA_ROOT/temp_geojson"

MIN_LAT="${SOUTH_LAT:-50}"

mkdir -p "$EXPORT_DIR" "$TEMP_DIR"

echo "Exporting GeoJSON layers..."

# Export protected areas as GeoJSON
duckdb "$DUCKDB_PATH" -c "
INSTALL spatial; LOAD spatial;
COPY (
  SELECT json_object(
    'type', 'Feature',
    'properties', json_object('id', feature_id, 'name', area_name),
    'geometry', ST_AsGeoJSON(geometry)::JSON
  ) as feature
  FROM protected_areas_ocean
) TO '$TEMP_DIR/protected_areas.ndjson' (FORMAT JSON, ARRAY false);
"

# Wrap in FeatureCollection
echo '{"type":"FeatureCollection","features":[' > "$TEMP_DIR/protected_areas.geojson"
cat "$TEMP_DIR/protected_areas.ndjson" | jq -c '.feature' | paste -sd ',' >> "$TEMP_DIR/protected_areas.geojson"
echo ']}' >> "$TEMP_DIR/protected_areas.geojson"

# Export places as GeoJSON
duckdb "$DUCKDB_PATH" -c "
INSTALL spatial; LOAD spatial;
COPY (
  SELECT json_object(
    'type', 'Feature',
    'properties', json_object(
      'name_en', NAME,
      'name_ru', NAME_RU,
      'population', CAST(POP_MAX AS INTEGER),
      'scalerank', CAST(SCALERANK AS INTEGER)
    ),
    'geometry', json_object('type', 'Point', 'coordinates', [ST_X(geom), ST_Y(geom)])
  ) as feature
  FROM ST_Read('$DATA_ROOT/ne_10m_populated_places/ne_10m_populated_places.shp')
  WHERE SCALERANK <= 5 AND ST_Y(geom) >= $MIN_LAT
) TO '$TEMP_DIR/places.ndjson' (FORMAT JSON, ARRAY false);
"

echo '{"type":"FeatureCollection","features":[' > "$TEMP_DIR/places.geojson"
cat "$TEMP_DIR/places.ndjson" | jq -c '.feature' | paste -sd ',' >> "$TEMP_DIR/places.geojson"
echo ']}' >> "$TEMP_DIR/places.geojson"

echo "Creating PMTiles with tippecanoe..."

# Check if tippecanoe is installed
if ! command -v tippecanoe &> /dev/null; then
  echo "Error: tippecanoe not found. Install with: brew install tippecanoe"
  exit 1
fi

# Create PMTiles with both layers
tippecanoe \
  --output="$EXPORT_DIR/vectors.pmtiles" \
  --force \
  --no-feature-limit \
  --no-tile-size-limit \
  --minimum-zoom=0 \
  --maximum-zoom=10 \
  --layer=protected_areas:"$TEMP_DIR/protected_areas.geojson" \
  --layer=places:"$TEMP_DIR/places.geojson"

# Cleanup
rm -rf "$TEMP_DIR"

PMTILES_SIZE=$(du -h "$EXPORT_DIR/vectors.pmtiles" | cut -f1)
echo "Done: vectors.pmtiles ($PMTILES_SIZE)"
