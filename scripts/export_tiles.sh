#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# Load environment variables
source .env

# Export vessel activity from DuckDB to CSV
echo "Exporting vessel activity from DuckDB..."
duckdb data/data.duckdb -c "
COPY (
  SELECT
    lon,
    lat,
    sum(hours) as hours
  FROM vessel_positions
  GROUP BY lat, lon
  ORDER BY lat DESC, lon ASC
) TO 'data/vessel_activity.csv' (HEADER, DELIMITER ',');
"

# Generate raster directly from gridded CSV data (no rasterization needed!)
# The vessel_positions data is already gridded at 0.01° intervals
echo "Creating raster directly from gridded vessel data..."
uv run --with "rasterio" --with "numpy" python scripts/create_raster.py

# Convert grayscale to Cloud-Optimized GeoTIFF for dynamic coloring
echo "Creating Cloud-Optimized GeoTIFF (grayscale) with nearest-neighbor resampling..."
gdal_translate \
  -of COG \
  -co COMPRESS=DEFLATE \
  -co PREDICTOR=2 \
  -co OVERVIEWS=AUTO \
  -co RESAMPLING=NEAREST \
  data/vessel_activity.tif \
  data/vessel_heatmap.tif

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

# Generate protected areas vector tiles
echo "Generating protected areas vector tiles..."
tippecanoe -o data/protected_areas.pmtiles \
  --force \
  --maximum-zoom=10 \
  --minimum-zoom=0 \
  --no-feature-limit \
  --no-tile-size-limit \
  --simplification=10 \
  --layer=protected_areas \
  data/protected_areas_filtered.geojson

# Generate land basemap (clipped to study area)
echo "Generating land basemap for study area..."

# Clip land polygons to study area using ogr2ogr
# SOUTH_LAT from .env, extends to North Pole (90), full longitude range
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

# Export vessel incursions to GeoJSON
echo "Exporting vessel incursions to GeoJSON..."
duckdb data/data.duckdb << 'SQL_EOF'
INSTALL spatial;
LOAD spatial;

COPY (
  SELECT
    feature_id,
    area_name,
    vessel_id,
    mmsi,
    ship_name,
    flag,
    vessel_type,
    gear_type,
    total_hours,
    first_seen,
    last_seen,
    centroid_lon as lon,
    centroid_lat as lat,
    position_count
  FROM vessel_incursions
) TO 'data/vessel_incursions.csv' (HEADER, DELIMITER ',');
SQL_EOF

# Convert incursions CSV to GeoJSON with point geometries
echo "Converting incursions to GeoJSON..."
python3 << 'PYTHON_EOF'
import csv
import json

features = []
with open('data/vessel_incursions.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        feature = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(row['lon']), float(row['lat'])]
            },
            "properties": {
                "feature_id": row['feature_id'],
                "area_name": row['area_name'],
                "vessel_id": row['vessel_id'],
                "mmsi": row['mmsi'],
                "ship_name": row['ship_name'],
                "flag": row['flag'],
                "vessel_type": row['vessel_type'],
                "gear_type": row['gear_type'],
                "total_hours": float(row['total_hours']),
                "first_seen": row['first_seen'],
                "last_seen": row['last_seen'],
                "position_count": int(row['position_count'])
            }
        }
        features.append(feature)

geojson = {
    "type": "FeatureCollection",
    "features": features
}

with open('data/vessel_incursions.geojson', 'w') as f:
    json.dump(geojson, f)

print(f"✓ Exported {len(features)} incursions")
PYTHON_EOF

# Generate incursions vector tiles
if [ -f data/vessel_incursions.geojson ] && [ $(jq '.features | length' data/vessel_incursions.geojson) -gt 0 ]; then
  echo "Generating vessel incursions vector tiles..."
  tippecanoe -o data/vessel_incursions.pmtiles \
    --force \
    --maximum-zoom=10 \
    --minimum-zoom=0 \
    --no-feature-limit \
    --no-tile-size-limit \
    --drop-densest-as-needed \
    --layer=incursions \
    data/vessel_incursions.geojson

  echo "✓ Vessel incursions tiles: data/vessel_incursions.pmtiles"
else
  echo "⚠ No vessel incursions found - skipping tile generation"
fi

# Cleanup intermediate files
rm -f data/vessel_activity.csv data/vessel_activity.tif data/protected_areas_filtered.geojson data/protected_areas_filtered_temp.geojson data/protected_areas_clipped.geojson data/protected_areas_maritime_features.jsonl data/protected_areas_filter_ids.csv data/land_clipped.geojson data/vessel_incursions.csv data/vessel_incursions.geojson

echo "✓ Vessel heatmap: data/vessel_heatmap.tif"
echo "✓ Protected areas tiles: data/protected_areas.pmtiles"
echo "✓ Land basemap: data/land.pmtiles"
