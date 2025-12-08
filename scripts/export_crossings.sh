#!/bin/bash
# Export vessel crossings vector tiles
set -e

cd "$(dirname "$0")/.."
source .env

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

# Cleanup
rm -f data/vessel_crossings.csv data/vessel_crossings.geojson
