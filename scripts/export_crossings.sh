#!/bin/bash
# Export vessel crossings vector tiles
set -e

cd "$(dirname "$0")/.."
source .env

# Export vessel crossings to GeoJSON
# Uses protected_areas_ocean from the dbt models which filters to ocean-only areas
echo "Exporting vessel crossings to GeoJSON..."
duckdb data/data.duckdb << SQL_EOF
INSTALL spatial;
LOAD spatial;

-- Export all crossings (they're already filtered to ocean protected areas by the dbt model)
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
    vc.year,
    vc.centroid_lon as lon,
    vc.centroid_lat as lat,
    vc.position_count
  FROM vessel_crossings vc
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
                "year": int(row['year']),
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

# Cleanup
rm -f data/vessel_crossings.csv data/vessel_crossings.geojson
