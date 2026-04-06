#!/bin/bash
# Export vessel heatmap rasters with land mask from DuckDB
# Generates: aggregate COG (all vessels) + per-vessel-type COGs
set -e

cd "$(dirname "$0")/.."
source .env

IFS=',' read -ra YEAR_ARRAY <<< "$YEARS"
IFS=',' read -ra TYPE_ARRAY <<< "$VESSEL_TYPES"

# Create DuckDB lookup tables for sanctions and old tankers
setup_lookup_tables() {
  echo "Setting up sanctions and old-tanker lookup tables..."

  python3 -c "
import json

with open('data/export/sanctioned_mmsi.json') as f:
    mmsis = json.load(f)
with open('data/_sanctioned_mmsi.csv', 'w') as f:
    f.write('mmsi\n')
    for m in mmsis:
        f.write(f'{m}\n')
print(f'  Sanctioned MMSIs: {len(mmsis)}')

from datetime import date
with open('data/export/vessel_metadata.json') as f:
    meta = json.load(f)
cutoff_year = date.today().year - 15
# Get tanker MMSIs from GFW data via pre-exported CSV
import subprocess
result = subprocess.run(
    ['duckdb', 'data/data.duckdb', '-csv', '-noheader', '-c',
     \"SELECT DISTINCT mmsi FROM vessel_presence WHERE vessel_type = 'TANKER'\"],
    capture_output=True, text=True)
tanker_mmsis = set(line.strip() for line in result.stdout.strip().split('\n') if line.strip())
count = 0
with open('data/_old_tanker_mmsi.csv', 'w') as f:
    f.write('mmsi\n')
    for mmsi, info in meta.items():
        is_tanker = info.get('ot') or mmsi in tanker_mmsis
        if is_tanker and info.get('y') and info['y'] <= cutoff_year:
            f.write(f'{mmsi}\n')
            count += 1
print(f'  Old tanker MMSIs (>= 15 years): {count}')
"

  duckdb data/data.duckdb -c "
  CREATE OR REPLACE TABLE sanctioned_mmsi AS SELECT mmsi FROM read_csv('data/_sanctioned_mmsi.csv', columns={'mmsi': 'VARCHAR'});
  CREATE OR REPLACE TABLE old_tanker_mmsi AS SELECT mmsi FROM read_csv('data/_old_tanker_mmsi.csv', columns={'mmsi': 'VARCHAR'});
  SELECT 'Loaded ' || (SELECT COUNT(*) FROM sanctioned_mmsi) || ' sanctioned + ' || (SELECT COUNT(*) FROM old_tanker_mmsi) || ' old tanker MMSIs';
  "

  rm -f data/_sanctioned_mmsi.csv data/_old_tanker_mmsi.csv
}

# Cleanup DuckDB lookup tables
cleanup_lookup_tables() {
  duckdb data/data.duckdb -c "
  DROP TABLE IF EXISTS sanctioned_mmsi;
  DROP TABLE IF EXISTS old_tanker_mmsi;
  "
}

# Function to export vessel activity for a specific filter
# Args: $1 = output suffix (e.g., "" for all, "_fishing" for fishing)
#       $2 = SQL WHERE clause addition (e.g., "" for all, "AND vessel_type = 'FISHING'" for fishing)
export_vessel_activity() {
  local suffix="$1"
  local filter="$2"
  local label="${3:-all vessels}"

  echo "Exporting vessel activity: ${label}..."
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
        ${filter}
      GROUP BY lat, lon
      ORDER BY lat DESC, lon ASC
    ) TO 'data/vessel_activity${suffix}_${year}.csv' (HEADER, DELIMITER ',');
    "

    # Export sanctions subset
    duckdb data/data.duckdb -c "
    COPY (
      SELECT lon, lat, sum(hours) as hours
      FROM vessel_positions
      WHERE year = ${year}
        AND (lon >= ${WEST_LON} OR lon <= ${EAST_LON})
        ${filter}
        AND mmsi IN (SELECT mmsi FROM sanctioned_mmsi)
      GROUP BY lat, lon
      ORDER BY lat DESC, lon ASC
    ) TO 'data/vessel_activity${suffix}_${year}_sanctioned.csv' (HEADER, DELIMITER ',');
    "

    # Export old tankers subset
    duckdb data/data.duckdb -c "
    COPY (
      SELECT lon, lat, sum(hours) as hours
      FROM vessel_positions
      WHERE year = ${year}
        AND (lon >= ${WEST_LON} OR lon <= ${EAST_LON})
        ${filter}
        AND mmsi IN (SELECT mmsi FROM old_tanker_mmsi)
      GROUP BY lat, lon
      ORDER BY lat DESC, lon ASC
    ) TO 'data/vessel_activity${suffix}_${year}_old_tankers.csv' (HEADER, DELIMITER ',');
    "
  done
}

# Function to create rasters from CSV files
# Args: $1 = suffix
create_rasters() {
  local suffix="$1"

  echo "Creating per-year rasters${suffix}..."
  for year in "${YEAR_ARRAY[@]}"; do
    echo "  → Rasterizing ${year}..."
    INPUT_CSV="data/vessel_activity${suffix}_${year}.csv" \
    OUTPUT_PATH="data/vessel_activity${suffix}_${year}.tif" \
    uv run --with "rasterio" --with "numpy" python scripts/create_raster.py
  done

  echo "Creating per-year sanctions rasters${suffix}..."
  for year in "${YEAR_ARRAY[@]}"; do
    echo "  → Rasterizing sanctions ${year}..."
    INPUT_CSV="data/vessel_activity${suffix}_${year}_sanctioned.csv" \
    OUTPUT_PATH="data/vessel_activity${suffix}_${year}_sanctioned.tif" \
    uv run --with "rasterio" --with "numpy" python scripts/create_raster.py
  done

  echo "Creating per-year old-tanker rasters${suffix}..."
  for year in "${YEAR_ARRAY[@]}"; do
    echo "  → Rasterizing old tankers ${year}..."
    INPUT_CSV="data/vessel_activity${suffix}_${year}_old_tankers.csv" \
    OUTPUT_PATH="data/vessel_activity${suffix}_${year}_old_tankers.tif" \
    uv run --with "rasterio" --with "numpy" python scripts/create_raster.py
  done
}

# Function to combine years + land mask into multi-band COG
# Args: $1 = suffix, $2 = vessel_type (for metadata, empty for "all")
create_cog() {
  local suffix="$1"
  local vessel_type="$2"

  echo "Combining years + sanctions + old tankers + land mask into multi-band raster${suffix}..."
  uv run --with "rasterio" --with "numpy" python3 << COMBINE_EOF
import rasterio
import numpy as np
import json
from datetime import datetime, timezone

suffix = "${suffix}"
vessel_type = "${vessel_type}" if "${vessel_type}" else None
years = "${YEARS}".split(',')
n_years = len(years)
print(f"Combining {n_years} year rasters + sanctions + old tankers + land mask...")

# Read year bands
with rasterio.open(f"data/vessel_activity{suffix}_{years[0]}.tif") as src:
    profile = src.profile.copy()
    height, width = src.height, src.width
    bands = [src.read(1)]

for year in years[1:]:
    with rasterio.open(f"data/vessel_activity{suffix}_{year}.tif") as src:
        bands.append(src.read(1))

# Read sanctions bands
for year in years:
    with rasterio.open(f"data/vessel_activity{suffix}_{year}_sanctioned.tif") as src:
        bands.append(src.read(1))

# Read old tanker bands
for year in years:
    with rasterio.open(f"data/vessel_activity{suffix}_{year}_old_tankers.tif") as src:
        bands.append(src.read(1))

# Read land mask
with rasterio.open("data/land_mask.tif") as src:
    land_data = src.read(1)
    if land_data.shape != bands[0].shape:
        print(f"Warning: Land mask shape {land_data.shape} differs from vessel raster {bands[0].shape}")
        min_h = min(land_data.shape[0], bands[0].shape[0])
        min_w = min(land_data.shape[1], bands[0].shape[1])
        land_data = land_data[:min_h, :min_w]
        bands = [b[:min_h, :min_w] for b in bands]
    bands.append(land_data)

# Read ice mask (optional)
ice_data = None
try:
    with rasterio.open("data/ice_mask.tif") as src:
        ice_data = src.read(1)
        if ice_data.shape != bands[0].shape:
            print(f"Warning: Ice mask shape {ice_data.shape} differs from vessel raster {bands[0].shape}")
            min_h = min(ice_data.shape[0], bands[0].shape[0])
            min_w = min(ice_data.shape[1], bands[0].shape[1])
            ice_data = ice_data[:min_h, :min_w]
            bands = [b[:min_h, :min_w] for b in bands]
        bands.append(ice_data)
        print("  Added ice mask band")
except FileNotFoundError:
    print("  No ice mask found, skipping ice band")

# Stack and write with band descriptions
combined = np.stack(bands)
profile.update(count=len(bands), compress='deflate', tiled=True)
band_descriptions = (
    tuple(years) +
    tuple(f"{y}_sanctions" for y in years) +
    tuple(f"{y}_old_tankers" for y in years) +
    ('land',) +
    (('ice',) if ice_data is not None else ())
)

# Create metadata JSON for frontend
cog_metadata = {
    'years': [int(y) for y in years],
    'sanctionsBandOffset': n_years,
    'oldTankerBandOffset': 2 * n_years,
    'landBand': 3 * n_years,
    'lastUpdated': datetime.now(timezone.utc).strftime('%Y-%m-%d')
}
if ice_data is not None:
    cog_metadata['iceBand'] = 3 * n_years + 1
if vessel_type:
    cog_metadata['vesselType'] = vessel_type

with rasterio.open(f"data/vessel_combined{suffix}.tif", 'w', **profile) as dst:
    dst.write(combined)
    dst.descriptions = band_descriptions
    dst.update_tags(ALBEDO_CONFIG=json.dumps(cog_metadata))

print(f"Created {len(bands)}-band raster with metadata:")
print(f"  Bands: {band_descriptions}")
print(f"  Config: {cog_metadata}")
COMBINE_EOF

  # Create Cloud-Optimized GeoTIFF
  echo "Creating Cloud-Optimized GeoTIFF${suffix}..."
  gdal_translate \
    -of COG \
    -co COMPRESS=DEFLATE \
    -co PREDICTOR=2 \
    -co OVERVIEWS=AUTO \
    -co RESAMPLING=NEAREST \
    "data/vessel_combined${suffix}.tif" \
    "data/vessel_heatmap${suffix}.tif"

  echo "✓ Created: data/vessel_heatmap${suffix}.tif ($(du -h data/vessel_heatmap${suffix}.tif | cut -f1))"
}

# Cleanup function
cleanup() {
  local suffix="$1"
  rm -f data/vessel_activity${suffix}_*.csv data/vessel_activity${suffix}_*.tif data/vessel_combined${suffix}.tif
}

#───────────────────────────────────────────────────────────────────────────────
# Main execution
#───────────────────────────────────────────────────────────────────────────────

# Setup sanctions and old-tanker lookup tables
setup_lookup_tables

# Create land mask (shared by all COGs)
echo "Creating land mask..."
gdal_rasterize -burn 1 \
  -te -180 ${SOUTH_LAT} 180 90 \
  -tr 0.01 0.01 \
  -ot Float32 \
  -co COMPRESS=DEFLATE \
  data/ne_10m_land/ne_10m_land.shp \
  data/land_mask.tif

# Create ice mask (IMS 1km sea ice + glaciated areas, shared by all COGs)
echo "Creating ice mask..."
ICE_TEMP=$(mktemp -d)

IMS_TIF="data/ims_1km.tif"
if [ -f "$IMS_TIF" ]; then
  echo "  Reprojecting IMS 1km data to EPSG:4326..."
  gdalwarp -t_srs EPSG:4326 \
    -te -180 ${SOUTH_LAT} 180 90 \
    -tr 0.01 0.01 \
    -r nearest \
    -ot Byte \
    -co COMPRESS=DEFLATE \
    -overwrite \
    "$IMS_TIF" \
    "$ICE_TEMP/ims_reproj.tif"

  echo "  Extracting sea ice (IMS value 3)..."
  uv run --with "rasterio" --with "numpy" python3 -c "
import rasterio
import numpy as np
with rasterio.open('$ICE_TEMP/ims_reproj.tif') as src:
    data = src.read(1)
    ice = np.where(data == 3, 1.0, 0.0).astype(np.float32)
    profile = src.profile.copy()
    profile.update(dtype='float32')
with rasterio.open('$ICE_TEMP/ims_ice.tif', 'w', **profile) as dst:
    dst.write(ice, 1)
print(f'  Sea ice pixels: {np.count_nonzero(ice):,}')
"
fi

GLAC_SHP="data/ne_10m_glaciated_areas/ne_10m_glaciated_areas.shp"
if [ -f "$GLAC_SHP" ]; then
  echo "  Rasterizing glaciated areas..."
  gdal_rasterize -burn 1 \
    -te -180 ${SOUTH_LAT} 180 90 \
    -tr 0.01 0.01 \
    -ot Float32 \
    -co COMPRESS=DEFLATE \
    "$GLAC_SHP" \
    "$ICE_TEMP/glaciated.tif"
fi

echo "  Merging ice sources..."
uv run --with "rasterio" --with "numpy" python3 -c "
import rasterio
import numpy as np
import os

result = None
profile = None
for path in ['$ICE_TEMP/ims_ice.tif', '$ICE_TEMP/glaciated.tif']:
    if not os.path.exists(path):
        continue
    with rasterio.open(path) as src:
        data = src.read(1)
        if result is None:
            result = data
            profile = src.profile.copy()
        else:
            h = min(data.shape[0], result.shape[0])
            w = min(data.shape[1], result.shape[1])
            result = np.maximum(result[:h, :w], data[:h, :w])
            profile.update(height=h, width=w)

if result is not None:
    profile.update(dtype='float32', compress='deflate')
    with rasterio.open('data/ice_mask.tif', 'w', **profile) as dst:
        dst.write(result.astype(np.float32), 1)
    print(f'  Total ice pixels: {np.count_nonzero(result):,}')
else:
    print('  Warning: No ice data found')
"

rm -rf "$ICE_TEMP"

# 1. Generate aggregate COG (all vessels)
echo ""
echo "═══════════════════════════════════════════════════════════════════════════"
echo "Generating aggregate COG (all vessels)..."
echo "═══════════════════════════════════════════════════════════════════════════"
export_vessel_activity "" "" "all vessels"
create_rasters ""
create_cog "" ""
cleanup ""

# 2. Generate per-vessel-type COGs
for vessel_type in "${TYPE_ARRAY[@]}"; do
  suffix="_$(echo "$vessel_type" | tr '[:upper:]' '[:lower:]')"

  echo ""
  echo "═══════════════════════════════════════════════════════════════════════════"
  echo "Generating COG for vessel type: ${vessel_type}..."
  echo "═══════════════════════════════════════════════════════════════════════════"

  export_vessel_activity "$suffix" "AND vessel_type = '${vessel_type}'" "$vessel_type"
  create_rasters "$suffix"
  create_cog "$suffix" "$vessel_type"
  cleanup "$suffix"
done

# 3. Generate per-flag COGs (foreign + key flags)
FLAG_PRESETS="${FLAG_PRESETS:-foreign,RUS,NOR,PAN,LBR,MHL,MLT,CHN,GBR}"
IFS=',' read -ra FLAG_ARRAY <<< "$FLAG_PRESETS"

for flag_filter in "${FLAG_ARRAY[@]}"; do
  suffix="_flag_$(echo "$flag_filter" | tr '[:upper:]' '[:lower:]')"

  if [ "$flag_filter" = "foreign" ]; then
    sql_filter="AND flag != 'RUS'"
    label="foreign-flagged vessels"
  else
    sql_filter="AND flag = '${flag_filter}'"
    label="flag: ${flag_filter}"
  fi

  echo ""
  echo "═══════════════════════════════════════════════════════════════════════════"
  echo "Generating COG for ${label}..."
  echo "═══════════════════════════════════════════════════════════════════════════"

  export_vessel_activity "$suffix" "$sql_filter" "$label"
  create_rasters "$suffix"
  create_cog "$suffix" ""
  cleanup "$suffix"
done

# Final cleanup
rm -f data/land_mask.tif data/ice_mask.tif
cleanup_lookup_tables

echo ""
echo "═══════════════════════════════════════════════════════════════════════════"
echo "All COGs generated:"
echo "═══════════════════════════════════════════════════════════════════════════"
ls -lh data/vessel_heatmap*.tif
