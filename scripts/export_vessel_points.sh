#!/bin/bash
# Export vessel hotspots as PMTiles for interactive tooltips
set -e

cd "$(dirname "$0")/.."

echo "Exporting vessel hotspots to GeoJSON..."
duckdb data/data.duckdb << 'SQL_EOF'
COPY (
  SELECT
    vessel_id,
    mmsi,
    ship_name,
    flag,
    vessel_type,
    gear_type,
    year,
    total_hours,
    lat,
    lon
  FROM vessel_hotspots
) TO '/tmp/vessel_hotspots.csv' (HEADER, DELIMITER ',');
SQL_EOF

# Convert to GeoJSON
python3 << 'PYTHON_EOF'
import csv
import json

features = []
with open('/tmp/vessel_hotspots.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        feature = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(row['lon']), float(row['lat'])]
            },
            "properties": {
                "mmsi": row['mmsi'],
                "ship_name": row['ship_name'],
                "flag": row['flag'],
                "vessel_type": row['vessel_type'],
                "year": int(row['year']),
                "total_hours": float(row['total_hours'])
            }
        }
        features.append(feature)

geojson = {"type": "FeatureCollection", "features": features}

with open('/tmp/vessel_hotspots.geojson', 'w') as f:
    json.dump(geojson, f)

print(f"  Exported {len(features):,} points")
PYTHON_EOF

# Generate PMTiles with tippecanoe
# - minzoom=7: only visible when zoomed in (reduce tile count)
# - maxzoom=10: sufficient detail for interaction
# - drop-densest-as-needed: intelligently reduce density at low zooms
echo "Generating PMTiles..."
tippecanoe -o data/vessel_hotspots.pmtiles \
  --force \
  --minimum-zoom=7 \
  --maximum-zoom=10 \
  --drop-densest-as-needed \
  --extend-zooms-if-still-dropping \
  --layer=hotspots \
  /tmp/vessel_hotspots.geojson

echo "  Created: data/vessel_hotspots.pmtiles"

# Cleanup
rm -f /tmp/vessel_hotspots.csv /tmp/vessel_hotspots.geojson
