#!/bin/bash
set -e

# Export vessel activity to GeoJSON for tile generation
echo "Exporting vessel activity to GeoJSON..."

cd "$(dirname "$0")/../etl"

# Export aggregated grid cells with activity metrics
duckdb ../data/data.duckdb -c "
COPY (
  SELECT
    json_object(
      'type', 'Feature',
      'geometry', json_object(
        'type', 'Point',
        'coordinates', json_array(lon, lat)
      ),
      'properties', json_object(
        'vessels', unique_vessels,
        'hours', round(total_hours, 1),
        'detections', total_detections
      )
    ) as feature
  FROM (
    SELECT
      lat,
      lon,
      count(distinct vessel_id) as unique_vessels,
      sum(hours) as total_hours,
      count(*) as total_detections
    FROM vessel_positions
    GROUP BY lat, lon
  )
) TO '../data/vessel_activity.geojsonseq' (FORMAT JSON, ARRAY false);
"

# Convert to proper GeoJSON
cd ..
echo "Converting to GeoJSON..."
echo '{"type":"FeatureCollection","features":[' > data/vessel_activity.geojson
cat data/vessel_activity.geojsonseq | sed 's/$/,/' | sed '$ s/,$//' >> data/vessel_activity.geojson
echo ']}' >> data/vessel_activity.geojson

echo "Generating PMTiles with vessel activity..."
tippecanoe -o data/vessel_activity.pmtiles \
  --force \
  --maximum-zoom=10 \
  --minimum-zoom=0 \
  --no-feature-limit \
  --no-tile-size-limit \
  --cluster-distance=5 \
  --accumulate-attribute=vessels:sum \
  --accumulate-attribute=hours:sum \
  --accumulate-attribute=detections:sum \
  --layer=vessel_activity \
  data/vessel_activity.geojson

echo "Generating PMTiles with protected areas..."
tippecanoe -o data/protected_areas.pmtiles \
  --force \
  --maximum-zoom=10 \
  --minimum-zoom=0 \
  --no-feature-limit \
  --no-tile-size-limit \
  --simplification=10 \
  --layer=protected_areas \
  data/protected_areas.geojson

echo "Merging PMTiles..."
tile-join -o data/tiles.pmtiles --force \
  data/vessel_activity.pmtiles \
  data/protected_areas.pmtiles

rm data/vessel_activity.geojsonseq data/vessel_activity.geojson \
   data/vessel_activity.pmtiles data/protected_areas.pmtiles

echo "✓ Tiles generated: data/tiles.pmtiles"
