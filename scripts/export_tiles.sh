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
  data/protected_areas_filtered.geojson \
  data/protected_areas_filtered_temp.geojson

echo "✓ Clipped protected areas to latitude ${SOUTH_LAT}° to 90°"

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

# Cleanup intermediate files
rm -f data/vessel_activity.csv data/vessel_activity.tif data/protected_areas_filtered.geojson data/protected_areas_filtered_temp.geojson data/protected_areas_filter_ids.csv data/land_clipped.geojson

echo "✓ Vessel heatmap: data/vessel_heatmap.tif"
echo "✓ Protected areas tiles: data/protected_areas.pmtiles"
echo "✓ Land basemap: data/land.pmtiles"
