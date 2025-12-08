#!/bin/bash
# Export vessel heatmap raster from DuckDB
set -e

cd "$(dirname "$0")/.."
source .env

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

# Cleanup
rm -f data/vessel_activity_*.csv data/vessel_activity_*.tif data/vessel_multiband.tif

echo "✓ Vessel heatmap: data/vessel_heatmap.tif"
