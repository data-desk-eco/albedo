#!/usr/bin/env bash
# Export vectors.pmtiles for client-side rendering
set -euo pipefail

cd "$(dirname "$0")/.."
source .env

DATA_ROOT="data"
EXPORT_DIR="$DATA_ROOT/export"
DUCKDB_PATH="$DATA_ROOT/data.duckdb"
TEMP_DIR="$DATA_ROOT/temp_geojson"

MIN_LAT="${SOUTH_LAT:-50}"

mkdir -p "$EXPORT_DIR" "$TEMP_DIR"

echo "Exporting GeoJSON layers..."

# Export protected areas as GeoJSON FeatureCollection, clipped to SOUTH_LAT
duckdb "$DUCKDB_PATH" -json -c "
INSTALL spatial; LOAD spatial;
SELECT json_object(
  'type', 'FeatureCollection',
  'features', json_group_array(
    json_object(
      'type', 'Feature',
      'properties', json_object(
        'id', feature_id,
        'name', area_name,
        'category', category,
        'significance', significance,
        'area_ha', ROUND(area_ha),
        'status', status
      ),
      'geometry', ST_AsGeoJSON(
        ST_Intersection(geometry, ST_GeomFromText('POLYGON((-180 $MIN_LAT, 180 $MIN_LAT, 180 90, -180 90, -180 $MIN_LAT))'))
      )::JSON
    )
  )
) as geojson
FROM protected_areas_ocean
WHERE ST_Intersects(geometry, ST_GeomFromText('POLYGON((-180 $MIN_LAT, 180 $MIN_LAT, 180 90, -180 90, -180 $MIN_LAT))'));
" | jq -r '.[0].geojson' > "$TEMP_DIR/protected_areas.geojson"

# Export places as GeoJSON FeatureCollection
duckdb "$DUCKDB_PATH" -json -c "
INSTALL spatial; LOAD spatial;
SELECT json_object(
  'type', 'FeatureCollection',
  'features', json_group_array(
    json_object(
      'type', 'Feature',
      'properties', json_object(
        'name_en', NAME,
        'name_ru', NAME_RU,
        'population', CAST(POP_MAX AS INTEGER),
        'scalerank', CAST(SCALERANK AS INTEGER)
      ),
      'geometry', json_object('type', 'Point', 'coordinates', list_value(ST_X(geom), ST_Y(geom)))
    )
  )
) as geojson
FROM ST_Read('$DATA_ROOT/ne_10m_populated_places/ne_10m_populated_places.shp')
WHERE SCALERANK <= 5 AND ST_Y(geom) >= $MIN_LAT;
" | jq -r '.[0].geojson' > "$TEMP_DIR/places.geojson"

echo "Exporting sanctioned vessel positions..."
# Generate sanctioned vessel GeoJSON from DuckDB + sanctions list
if [ -f "$EXPORT_DIR/sanctioned_mmsi.json" ]; then
  uv run python scripts/export_sanctions_layer.py
fi

echo "Creating PMTiles with tippecanoe..."

# Build layer args
LAYER_ARGS="-L protected_areas:$TEMP_DIR/protected_areas.geojson -L places:$TEMP_DIR/places.geojson"
if [ -f "$TEMP_DIR/sanctioned_vessels.geojson" ]; then
  LAYER_ARGS="$LAYER_ARGS -L sanctioned_vessels:$TEMP_DIR/sanctioned_vessels.geojson"
fi

# Create PMTiles with all layers
tippecanoe \
  --output="$EXPORT_DIR/vectors.pmtiles" \
  --force \
  --no-feature-limit \
  --no-tile-size-limit \
  --minimum-zoom=0 \
  --maximum-zoom=10 \
  $LAYER_ARGS

# Cleanup
rm -rf "$TEMP_DIR"

PMTILES_SIZE=$(du -h "$EXPORT_DIR/vectors.pmtiles" | cut -f1)
echo "Done: vectors.pmtiles ($PMTILES_SIZE)"
