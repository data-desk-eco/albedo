#!/bin/bash
# Export vessel heatmap raster with land mask from DuckDB
set -e

cd "$(dirname "$0")/.."
source .env

IFS=',' read -ra YEAR_ARRAY <<< "$YEARS"

# Export per-year vessel activity from DuckDB to CSV
# Filter to study area bounds (wraps around antimeridian: WEST_LON to EAST_LON)
echo "Exporting vessel activity per year from DuckDB..."
echo "  Study area: ${WEST_LON}°E to ${EAST_LON}°E (wrap-around)"
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
      AND (lon >= ${WEST_LON} OR lon <= ${EAST_LON})
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

# Create land mask at same resolution
echo "Creating land mask..."
gdal_rasterize -burn 1 \
  -te -180 ${SOUTH_LAT} 180 90 \
  -tr 0.01 0.01 \
  -ot Float32 \
  -co COMPRESS=DEFLATE \
  data/ne_10m_land/ne_10m_land.shp \
  data/land_mask.tif

# Combine into multi-band raster (years + land mask)
echo "Combining years + land mask into multi-band raster..."
uv run --with "rasterio" --with "numpy" python3 << COMBINE_EOF
import rasterio
import numpy as np
import json
from datetime import datetime, timezone

years = "${YEARS}".split(',')
print(f"Combining {len(years)} year rasters + land mask...")

# Read the first raster to get metadata
with rasterio.open(f"data/vessel_activity_{years[0]}.tif") as src:
    profile = src.profile.copy()
    height, width = src.height, src.width
    bands = [src.read(1)]

# Read remaining years
for year in years[1:]:
    with rasterio.open(f"data/vessel_activity_{year}.tif") as src:
        bands.append(src.read(1))

# Read land mask
with rasterio.open("data/land_mask.tif") as src:
    land_data = src.read(1)
    # Resample if needed (should match, but handle edge cases)
    if land_data.shape != bands[0].shape:
        print(f"Warning: Land mask shape {land_data.shape} differs from vessel raster {bands[0].shape}")
        # Crop/pad to match
        min_h = min(land_data.shape[0], bands[0].shape[0])
        min_w = min(land_data.shape[1], bands[0].shape[1])
        land_data = land_data[:min_h, :min_w]
        bands = [b[:min_h, :min_w] for b in bands]
    bands.append(land_data)

# Stack and write with band descriptions for self-describing COG
combined = np.stack(bands)
profile.update(count=len(bands), compress='deflate', tiled=True)

# Create band descriptions: years + 'land'
band_descriptions = tuple(years) + ('land',)

# Create metadata JSON for frontend consumption
cog_metadata = {
    'years': [int(y) for y in years],
    'landBand': len(years),
    'lastUpdated': datetime.now(timezone.utc).strftime('%Y-%m-%d')
}

with rasterio.open("data/vessel_combined.tif", 'w', **profile) as dst:
    dst.write(combined)
    dst.descriptions = band_descriptions
    # Store structured metadata in GDAL metadata domain
    dst.update_tags(ALBEDO_CONFIG=json.dumps(cog_metadata))

print(f"Created {len(bands)}-band raster with metadata:")
print(f"  Bands: {band_descriptions}")
print(f"  Config: {cog_metadata}")
COMBINE_EOF

# Keep COG in EPSG:4326 (geographic coordinates) for correct display on globe projection
# Client-side renderer will convert Web Mercator tile bounds to geographic coords
echo "Creating Cloud-Optimized GeoTIFF (EPSG:4326)..."
gdal_translate \
  -of COG \
  -co COMPRESS=DEFLATE \
  -co PREDICTOR=2 \
  -co OVERVIEWS=AUTO \
  -co RESAMPLING=NEAREST \
  data/vessel_combined.tif \
  data/vessel_heatmap.tif

# Cleanup
rm -f data/vessel_activity_*.csv data/vessel_activity_*.tif data/vessel_combined.tif data/land_mask.tif

echo "✓ Vessel heatmap with land mask: data/vessel_heatmap.tif ($(du -h data/vessel_heatmap.tif | cut -f1))"
