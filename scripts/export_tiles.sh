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

# Convert to proper GeoJSON and generate tiles
cd ..
echo "Converting to GeoJSON..."
echo '{"type":"FeatureCollection","features":[' > data/vessel_activity.geojson
cat data/vessel_activity.geojsonseq | sed 's/$/,/' | sed '$ s/,$//' >> data/vessel_activity.geojson
echo ']}' >> data/vessel_activity.geojson

echo "Generating PMTiles..."
tippecanoe -o data/tiles.pmtiles \
  --force \
  --maximum-zoom=10 \
  --minimum-zoom=0 \
  --drop-densest-as-needed \
  --extend-zooms-if-still-dropping \
  --accumulate-attribute=vessels:sum \
  --accumulate-attribute=hours:sum \
  --accumulate-attribute=detections:sum \
  data/vessel_activity.geojson

rm data/vessel_activity.geojsonseq data/vessel_activity.geojson

echo "✓ Tiles generated: data/tiles.pmtiles"
