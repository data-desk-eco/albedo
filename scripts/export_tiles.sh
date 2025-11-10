#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# Export vessel activity as CSV for raster generation
echo "Exporting vessel activity to CSV..."
duckdb data/data.duckdb -c "
COPY (
  SELECT
    lon,
    lat,
    sum(hours) as hours
  FROM vessel_positions
  GROUP BY lat, lon
) TO 'data/vessel_activity.csv' (HEADER, DELIMITER ',');
"

# Create VRT file for GDAL
echo "Creating VRT for GDAL..."
cat > data/vessel_activity.vrt << EOF
<OGRVRTDataSource>
  <OGRVRTLayer name="vessel_activity">
    <SrcDataSource>$(pwd)/data/vessel_activity.csv</SrcDataSource>
    <GeometryType>wkbPoint</GeometryType>
    <LayerSRS>EPSG:4326</LayerSRS>
    <GeometryField encoding="PointFromColumns" x="lon" y="lat" z="hours"/>
  </OGRVRTLayer>
</OGRVRTDataSource>
EOF

# Generate raster heatmap using gdal_rasterize
echo "Generating raster heatmap..."
gdal_rasterize -l vessel_activity \
  -a hours \
  -tr 0.05 0.05 \
  -a_nodata 0.0 \
  -te -180 56 180 90 \
  -ot Float32 \
  -co COMPRESS=LZW \
  -co TILED=YES \
  data/vessel_activity.vrt \
  data/vessel_activity.tif

# Apply color ramp
echo "Applying color ramp..."
gdaldem color-relief data/vessel_activity.tif /dev/stdin data/vessel_activity_color.tif << 'EOF'
0 224 224 224 0
0.1 160 160 160 255
1 96 96 96 255
10 48 48 48 255
100 0 0 0 255
nv 0 0 0 0
EOF

# Convert to Cloud-Optimized GeoTIFF with internal overview pyramids
echo "Creating Cloud-Optimized GeoTIFF..."
gdal_translate \
  -of COG \
  -co COMPRESS=DEFLATE \
  -co PREDICTOR=2 \
  -co OVERVIEWS=AUTO \
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

# Cleanup
rm -f data/vessel_activity.csv data/vessel_activity.vrt \
  data/vessel_activity.tif data/vessel_activity_color.tif

echo "✓ Vessel heatmap: data/vessel_heatmap.tif"
echo "✓ Protected areas tiles: data/protected_areas.pmtiles"
