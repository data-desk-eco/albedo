#!/bin/bash
# Export protected areas vector tiles (split into sea/land for inversion effect)
set -e

cd "$(dirname "$0")/.."
source .env

# Filter protected areas to only those with vessel activity within 5km
echo "Finding protected areas with vessel activity (5km buffer)..."
duckdb data/data.duckdb << 'SQL_EOF'
INSTALL spatial;
LOAD spatial;

-- Create temp table with protected area geometries
CREATE TEMP TABLE protected_areas_geom AS
WITH features AS (
  SELECT unnest(features) as feature
  FROM read_json_auto('data/protected_areas.geojson', maximum_object_size=200000000)
)
SELECT
  feature.id as feature_id,
  ST_GeomFromGeoJSON(json(feature.geometry)) as geometry
FROM features;

-- Find protected areas within 5km of vessel positions
-- Export list of IDs to CSV
COPY (
  SELECT DISTINCT pa.feature_id
  FROM protected_areas_geom pa
  JOIN vessel_positions vp
    ON ST_DWithin(
      ST_Point(vp.lon, vp.lat),
      pa.geometry,
      0.045  -- ~5km at 60°N latitude
    )
  WHERE vp.hours > 0
  ORDER BY pa.feature_id
) TO 'data/protected_areas_filter_ids.csv' (HEADER false);
SQL_EOF

# Filter GeoJSON using the ID list
echo "Filtering protected areas GeoJSON..."
IDS=$(cat data/protected_areas_filter_ids.csv | jq -R . | jq -s .)
jq --argjson ids "$IDS" -c '
  .features = [.features[] | select(.id as $id | $ids | index($id))]
' data/protected_areas.geojson > data/protected_areas_filtered_temp.geojson

echo "✓ Filtered to $(jq '.features | length' data/protected_areas_filtered_temp.geojson) protected areas with nearby vessel activity"

# Clip protected areas to study area (same as land basemap)
echo "Clipping protected areas to northern cap..."
ogr2ogr -f GeoJSON \
  -clipsrc -180 ${SOUTH_LAT} 180 90 \
  data/protected_areas_clipped.geojson \
  data/protected_areas_filtered_temp.geojson

echo "✓ Clipped protected areas to latitude ${SOUTH_LAT}° to 90°"

# Filter out inland-only protected areas (keep only those in/touching ocean)
echo "Filtering to ocean-only protected areas..."
duckdb << SQL_EOF
INSTALL spatial;
LOAD spatial;

-- Create study area boundary
CREATE TEMP TABLE study_area AS
SELECT ST_GeomFromText('POLYGON((-180 ${SOUTH_LAT}, 180 ${SOUTH_LAT}, 180 90, -180 90, -180 ${SOUTH_LAT}))') as geometry;

-- Load and clip land polygons to study area
CREATE TEMP TABLE land_raw AS
FROM ST_Read('data/ne_10m_land/ne_10m_land.shp');

CREATE TEMP TABLE land_geom AS
SELECT ST_GeomFromWKB(ST_AsWKB(geom)) as geometry
FROM land_raw
WHERE ST_Intersects(
  ST_GeomFromWKB(ST_AsWKB(geom)),
  (SELECT geometry FROM study_area)
);

-- Combine all land into one multipolygon
CREATE TEMP TABLE land_union AS
SELECT ST_Union_Agg(geometry) as geometry
FROM land_geom;

-- Create ocean mask by subtracting land from study area
CREATE TEMP TABLE ocean_mask AS
SELECT ST_Difference(
  (SELECT geometry FROM study_area),
  (SELECT geometry FROM land_union)
) as geometry;

-- Load protected areas
CREATE TEMP TABLE protected_areas_geom AS
WITH features AS (
  SELECT unnest(features) as feature
  FROM read_json_auto('data/protected_areas_clipped.geojson')
)
SELECT
  feature,
  ST_GeomFromGeoJSON(json(feature.geometry)) as geometry
FROM features;

-- Keep only protected areas that intersect with ocean
-- This excludes rivers and inland areas
COPY (
  SELECT json(feature) as feature
  FROM protected_areas_geom pa, ocean_mask o
  WHERE ST_Intersects(pa.geometry, o.geometry)
) TO 'data/protected_areas_maritime_features.jsonl';
SQL_EOF

# Reconstruct GeoJSON from filtered features
echo "Reconstructing GeoJSON..."
echo '{"type":"FeatureCollection","features":[' > data/protected_areas_filtered.geojson
cat data/protected_areas_maritime_features.jsonl | jq -s '.' | jq -c '.[]' | sed '$!s/$/,/' >> data/protected_areas_filtered.geojson
echo ']}' >> data/protected_areas_filtered.geojson

MARITIME_COUNT=$(jq '.features | length' data/protected_areas_filtered.geojson)
echo "✓ Filtered to ${MARITIME_COUNT} maritime/coastal protected areas (excluded inland areas)"

# Split protected area boundaries into sea and land portions for inversion effect
echo "Splitting protected area boundaries into sea/land portions..."
duckdb << SQL_EOF
INSTALL spatial;
LOAD spatial;

-- Load land polygons (clipped to study area)
CREATE TEMP TABLE land_raw AS
FROM ST_Read('data/ne_10m_land/ne_10m_land.shp');

CREATE TEMP TABLE study_area AS
SELECT ST_GeomFromText('POLYGON((-180 ${SOUTH_LAT}, 180 ${SOUTH_LAT}, 180 90, -180 90, -180 ${SOUTH_LAT}))') as geometry;

CREATE TEMP TABLE land_clipped AS
SELECT ST_Intersection(
  ST_GeomFromWKB(ST_AsWKB(geom)),
  (SELECT geometry FROM study_area)
) as geometry
FROM land_raw
WHERE ST_Intersects(
  ST_GeomFromWKB(ST_AsWKB(geom)),
  (SELECT geometry FROM study_area)
);

-- Union all land into single geometry
CREATE TEMP TABLE land_union AS
SELECT ST_Union_Agg(geometry) as geometry FROM land_clipped;

-- Load protected areas (handle nested structure from reconstruction)
CREATE TEMP TABLE protected_areas AS
WITH features AS (
  SELECT unnest(features) as f
  FROM read_json_auto('data/protected_areas_filtered.geojson')
)
SELECT
  f.feature.id as id,
  f.feature.properties as properties,
  ST_GeomFromGeoJSON(json(f.feature.geometry)) as geometry
FROM features
WHERE f.feature.geometry.type != 'Point';

-- Extract boundaries as linestrings
CREATE TEMP TABLE pa_boundaries AS
SELECT
  id,
  properties,
  ST_Boundary(geometry) as geometry
FROM protected_areas;

-- Clip boundaries to land (black lines)
CREATE TEMP TABLE pa_on_land AS
SELECT
  id,
  properties,
  ST_Intersection(pa.geometry, land.geometry) as geometry
FROM pa_boundaries pa, land_union land
WHERE ST_Intersects(pa.geometry, land.geometry);

-- Clip boundaries to sea (white lines) - difference from land
CREATE TEMP TABLE pa_on_sea AS
SELECT
  id,
  properties,
  ST_Difference(pa.geometry, land.geometry) as geometry
FROM pa_boundaries pa, land_union land;

-- Export land portions as GeoJSON features
COPY (
  SELECT json_object(
    'type', 'Feature',
    'id', id,
    'properties', json(properties),
    'geometry', json(ST_AsGeoJSON(geometry))
  ) as feature
  FROM pa_on_land
  WHERE geometry IS NOT NULL
    AND NOT ST_IsEmpty(geometry)
) TO 'data/pa_land_features.jsonl';

-- Export sea portions as GeoJSON features
COPY (
  SELECT json_object(
    'type', 'Feature',
    'id', id,
    'properties', json(properties),
    'geometry', json(ST_AsGeoJSON(geometry))
  ) as feature
  FROM pa_on_sea
  WHERE geometry IS NOT NULL
    AND NOT ST_IsEmpty(geometry)
) TO 'data/pa_sea_features.jsonl';

SQL_EOF

# Reconstruct GeoJSON files from JSONL
echo "Reconstructing split GeoJSON files..."

# Land portions (black lines)
echo '{"type":"FeatureCollection","features":[' > data/protected_areas_land.geojson
if [ -s data/pa_land_features.jsonl ]; then
  cat data/pa_land_features.jsonl | jq -c '.feature' | sed '$!s/$/,/' >> data/protected_areas_land.geojson
fi
echo ']}' >> data/protected_areas_land.geojson

# Sea portions (white lines)
echo '{"type":"FeatureCollection","features":[' > data/protected_areas_sea.geojson
if [ -s data/pa_sea_features.jsonl ]; then
  cat data/pa_sea_features.jsonl | jq -c '.feature' | sed '$!s/$/,/' >> data/protected_areas_sea.geojson
fi
echo ']}' >> data/protected_areas_sea.geojson

LAND_COUNT=$(jq '.features | length' data/protected_areas_land.geojson)
SEA_COUNT=$(jq '.features | length' data/protected_areas_sea.geojson)
echo "✓ Split into ${LAND_COUNT} land segments and ${SEA_COUNT} sea segments"

# Generate protected areas vector tiles (combined PMTiles with both layers)
echo "Generating protected areas vector tiles..."
tippecanoe -o data/protected_areas.pmtiles \
  --force \
  --maximum-zoom=10 \
  --minimum-zoom=0 \
  --no-feature-limit \
  --no-tile-size-limit \
  --simplification=10 \
  --named-layer=protected_areas_land:data/protected_areas_land.geojson \
  --named-layer=protected_areas_sea:data/protected_areas_sea.geojson

# Cleanup intermediate files
rm -f data/protected_areas_filtered_temp.geojson data/protected_areas_clipped.geojson \
      data/protected_areas_maritime_features.jsonl data/protected_areas_filter_ids.csv \
      data/pa_land_features.jsonl data/pa_sea_features.jsonl \
      data/protected_areas_land.geojson data/protected_areas_sea.geojson \
      data/protected_areas_filtered.geojson

echo "✓ Protected areas tiles: data/protected_areas.pmtiles"
