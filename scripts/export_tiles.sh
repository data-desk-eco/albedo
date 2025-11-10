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

# Apply color ramp with alpha channel
echo "Applying color ramp..."
gdaldem color-relief data/vessel_activity.tif /dev/stdin data/vessel_activity_color.tif -alpha << 'EOF'
0 0 0 0 0
0.1 160 160 160 255
1 96 96 96 255
10 48 48 48 255
100 0 0 0 255
nv 0 0 0 0
EOF

# Convert to Cloud-Optimized GeoTIFF with internal overview pyramids
# Use nearest-neighbor resampling to keep pixel boundaries crisp (no blur)
echo "Creating Cloud-Optimized GeoTIFF with nearest-neighbor resampling..."
gdal_translate \
  -of COG \
  -co COMPRESS=DEFLATE \
  -co PREDICTOR=2 \
  -co OVERVIEWS=AUTO \
  -co RESAMPLING=NEAREST \
  data/vessel_activity_color.tif \
  data/vessel_heatmap.tif

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
  data/protected_areas.geojson

# Cleanup intermediate files
rm -f data/vessel_activity.csv data/vessel_activity.tif data/vessel_activity_color.tif

echo "✓ Vessel heatmap: data/vessel_heatmap.tif"
echo "✓ Protected areas tiles: data/protected_areas.pmtiles"
