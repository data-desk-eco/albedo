#!/usr/bin/env bash
# Export vectors.sqlite for client-side queries (protected areas, places)
set -euo pipefail

# Load environment variables
source "$(dirname "$0")/../.env"

DATA_ROOT="$(dirname "$0")/../data"
EXPORT_DIR="$DATA_ROOT/export"
DUCKDB_PATH="$DATA_ROOT/data.duckdb"

# Configurable filters (from .env)
MIN_LAT="${SOUTH_LAT:-50}"
COUNTRY="${COUNTRY_CODE:-}"  # Empty = all countries

mkdir -p "$EXPORT_DIR"

echo "Exporting vectors.sqlite..."
rm -f "$EXPORT_DIR/vectors.sqlite"

# Build country filter clause
COUNTRY_FILTER=""
if [ -n "$COUNTRY" ]; then
  COUNTRY_FILTER="AND ADM0_A3 = '$COUNTRY'"
fi

duckdb "$DUCKDB_PATH" <<EOF
INSTALL sqlite; LOAD sqlite;
INSTALL spatial; LOAD spatial;
ATTACH '$EXPORT_DIR/vectors.sqlite' AS out (TYPE SQLITE);

-- Protected areas with GeoJSON geometry
CREATE TABLE out.protected_areas AS
SELECT feature_id, area_name, ST_AsGeoJSON(geometry) as geometry
FROM protected_areas_ocean;

-- Places from Natural Earth shapefile
CREATE TABLE out.places AS
SELECT NAME as name_en, NAME_RU as name_ru, ST_X(geom) as lon, ST_Y(geom) as lat,
       CAST(POP_MAX AS INTEGER) as population, CAST(SCALERANK AS INTEGER) as scalerank
FROM ST_Read('$DATA_ROOT/ne_10m_populated_places/ne_10m_populated_places.shp')
WHERE SCALERANK <= 5 AND ST_Y(geom) >= $MIN_LAT $COUNTRY_FILTER;

DETACH out;
EOF

VECTORS_SIZE=$(du -h "$EXPORT_DIR/vectors.sqlite" | cut -f1)
echo "Done: vectors.sqlite ($VECTORS_SIZE)"
