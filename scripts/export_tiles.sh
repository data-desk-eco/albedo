#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# Load environment variables
source .env

# Parse YEARS env var
IFS=',' read -ra YEAR_ARRAY <<< "$YEARS"

# Export per-year vessel activity from DuckDB to CSV
echo "Exporting vessel activity per year from DuckDB..."
for year in "${YEAR_ARRAY[@]}"; do
  echo "  → Exporting ${year}..."
  duckdb data/data.duckdb -c "
  COPY (
    SELECT
      lon,
      lat,
      sum(hours) as hours
    FROM vessel_positions
    WHERE year = ${year}
    GROUP BY lat, lon
    ORDER BY lat DESC, lon ASC
  ) TO 'data/vessel_activity_${year}.csv' (HEADER, DELIMITER ',');
  "
done

# Generate per-year rasters
echo "Creating per-year rasters..."
for year in "${YEAR_ARRAY[@]}"; do
  echo "  → Rasterizing ${year}..."
  INPUT_CSV="data/vessel_activity_${year}.csv" \
  OUTPUT_PATH="data/vessel_activity_${year}.tif" \
  uv run --with "rasterio" --with "numpy" python scripts/create_raster.py
done

# Combine into 3-band RGB raster (band order = year order)
echo "Combining years into multi-band raster..."
uv run --with "rasterio" --with "numpy" python3 << COMBINE_EOF
import rasterio
import numpy as np

years = "${YEARS}".split(',')
print(f"Combining {len(years)} year rasters...")

# Read the first raster to get metadata
with rasterio.open(f"data/vessel_activity_{years[0]}.tif") as src:
    profile = src.profile.copy()
    height, width = src.height, src.width

# Update profile for multi-band output
profile.update(count=len(years))

# Create output raster
with rasterio.open("data/vessel_multiband.tif", 'w', **profile) as dst:
    for i, year in enumerate(years):
        with rasterio.open(f"data/vessel_activity_{year}.tif") as src:
            data = src.read(1)
            dst.write(data, i + 1)
            print(f"  Added band {i+1}: {year}")

print("✓ Created multi-band raster")
COMBINE_EOF

# Convert to Cloud-Optimized GeoTIFF
echo "Creating Cloud-Optimized GeoTIFF with nearest-neighbor resampling..."
gdal_translate \
  -of COG \
  -co COMPRESS=DEFLATE \
  -co PREDICTOR=2 \
  -co OVERVIEWS=AUTO \
  -co RESAMPLING=NEAREST \
  data/vessel_multiband.tif \
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

# Generate place labels (Natural Earth populated places)
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

# Export vessel crossings to GeoJSON (filtered to only include points within displayed protected areas)
echo "Exporting vessel crossings to GeoJSON..."
duckdb data/data.duckdb << SQL_EOF
INSTALL spatial;
LOAD spatial;

-- Load the displayed protected areas (already filtered to ocean-only)
CREATE TEMP TABLE display_protected_areas AS
WITH features AS (
  SELECT unnest(features) as f
  FROM read_json_auto('data/protected_areas_filtered.geojson')
)
SELECT
  f.feature.id as feature_id,
  ST_GeomFromGeoJSON(json(f.feature.geometry)) as geometry
FROM features;

-- Export only crossings that are within the displayed protected areas
COPY (
  SELECT
    vc.feature_id,
    vc.area_name,
    vc.vessel_id,
    vc.mmsi,
    vc.ship_name,
    vc.flag,
    vc.vessel_type,
    vc.gear_type,
    vc.total_hours,
    vc.first_seen,
    vc.last_seen,
    vc.centroid_lon as lon,
    vc.centroid_lat as lat,
    vc.position_count
  FROM vessel_crossings vc
  WHERE EXISTS (
    SELECT 1 FROM display_protected_areas pa
    WHERE ST_Within(ST_Point(vc.centroid_lon, vc.centroid_lat), pa.geometry)
  )
) TO 'data/vessel_crossings.csv' (HEADER, DELIMITER ',');
SQL_EOF

# Convert crossings CSV to GeoJSON with point geometries
echo "Converting crossings to GeoJSON..."
python3 << 'PYTHON_EOF'
import csv
import json

features = []
with open('data/vessel_crossings.csv', 'r') as f:
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

with open('data/vessel_crossings.geojson', 'w') as f:
    json.dump(geojson, f)

print(f"✓ Exported {len(features)} crossings")
PYTHON_EOF

# Generate crossings vector tiles
if [ -f data/vessel_crossings.geojson ] && [ $(jq '.features | length' data/vessel_crossings.geojson) -gt 0 ]; then
  echo "Generating vessel crossings vector tiles..."
  tippecanoe -o data/vessel_crossings.pmtiles \
    --force \
    --maximum-zoom=10 \
    --minimum-zoom=0 \
    --drop-rate=0 \
    --no-feature-limit \
    --no-tile-size-limit \
    --layer=crossings \
    data/vessel_crossings.geojson

  echo "✓ Vessel crossings tiles: data/vessel_crossings.pmtiles"
else
  echo "⚠ No vessel crossings found - skipping tile generation"
fi

# Cleanup intermediate files
rm -f data/vessel_activity_*.csv data/vessel_activity_*.tif data/vessel_multiband.tif data/protected_areas_filtered_temp.geojson data/protected_areas_clipped.geojson data/protected_areas_maritime_features.jsonl data/protected_areas_filter_ids.csv data/vessel_crossings.csv data/vessel_crossings.geojson data/land_clipped.geojson data/protected_areas_filtered.geojson data/places_filtered.geojson

echo "✓ Vessel heatmap: data/vessel_heatmap.tif"
echo "✓ Protected areas tiles: data/protected_areas.pmtiles"
echo "✓ Land basemap: data/land.pmtiles"
echo "✓ Place labels: data/places.pmtiles"
