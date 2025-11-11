#!/bin/bash
set -e

cd "$(dirname "$0")/.."

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

# Generate protected areas vector tiles
echo "Generating protected areas vector tiles..."
tippecanoe -o data/protected_areas.pmtiles \
  --force \
  --maximum-zoom=10 \
  --minimum-zoom=2 \
  --no-feature-limit \
  --no-tile-size-limit \
  --simplification=10 \
  --layer=protected_areas \
  data/protected_areas.geojson

# Cleanup intermediate files
rm -f data/vessel_activity.csv data/vessel_activity.tif

echo "✓ Vessel heatmap: data/vessel_heatmap.tif"
echo "✓ Protected areas tiles: data/protected_areas.pmtiles"
