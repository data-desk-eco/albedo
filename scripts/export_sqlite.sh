#!/usr/bin/env bash
# Export vectors.sqlite for client-side queries (protected areas, crossings, places)
set -euo pipefail

DATA_ROOT="$(dirname "$0")/../data"
EXPORT_DIR="$DATA_ROOT/export"
DUCKDB_PATH="$DATA_ROOT/data.duckdb"

mkdir -p "$EXPORT_DIR"

echo "Exporting vectors.sqlite..."
rm -f "$EXPORT_DIR/vectors.sqlite"
duckdb "$DUCKDB_PATH" <<EOF
INSTALL sqlite; LOAD sqlite;
INSTALL spatial; LOAD spatial;
ATTACH '$EXPORT_DIR/vectors.sqlite' AS out (TYPE SQLITE);

-- Protected areas with GeoJSON geometry
CREATE TABLE out.protected_areas AS
SELECT feature_id, area_name, ST_AsGeoJSON(geometry) as geometry
FROM protected_areas_ocean;

-- Vessel crossings (already computed)
CREATE TABLE out.vessel_crossings AS
SELECT feature_id, area_name, vessel_id, mmsi, ship_name, flag, vessel_type, gear_type,
       total_hours, first_seen, last_seen, year, centroid_lon, centroid_lat, position_count
FROM vessel_crossings;

-- Places from Natural Earth shapefile
CREATE TABLE out.places AS
SELECT NAME as name_en, NAME_RU as name_ru, ST_X(geom) as lon, ST_Y(geom) as lat,
       CAST(POP_MAX AS INTEGER) as population, CAST(SCALERANK AS INTEGER) as scalerank
FROM ST_Read('$DATA_ROOT/ne_10m_populated_places/ne_10m_populated_places.shp')
WHERE SCALERANK <= 5 AND ST_Y(geom) >= 50 AND ADM0_A3 = 'RUS';

DETACH out;
EOF

VECTORS_SIZE=$(du -h "$EXPORT_DIR/vectors.sqlite" | cut -f1)
echo "Done: vectors.sqlite ($VECTORS_SIZE)"
