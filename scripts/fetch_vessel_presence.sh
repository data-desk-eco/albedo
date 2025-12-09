#!/bin/bash
set -e

mkdir -p data/gfw

# Parse YEARS env var (comma-separated)
IFS=',' read -ra YEAR_ARRAY <<< "$YEARS"

echo "Fetching vessel presence for years: ${YEARS}..."

for year in "${YEAR_ARRAY[@]}"; do
  mkdir -p "data/gfw/${year}"

  for month in {1..12}; do
    month_padded=$(printf "%02d" $month)
    output_file="data/gfw/${year}/${year}-${month_padded}.json"

    # Calculate last day of month
    if [ $month -eq 2 ]; then
      if [ $(($year % 4)) -eq 0 ] && ([ $(($year % 100)) -ne 0 ] || [ $(($year % 400)) -eq 0 ]); then
        last_day=29
      else
        last_day=28
      fi
    elif [ $month -eq 4 ] || [ $month -eq 6 ] || [ $month -eq 9 ] || [ $month -eq 11 ]; then
      last_day=30
    else
      last_day=31
    fi

    month_start="${year}-${month_padded}-01"
    month_end="${year}-${month_padded}-${last_day}"

    echo "  Fetching ${month_start} to ${month_end}..."

    # Polygon: 20°E to 160°W (via 180°), covering Russian Arctic / NSR
    # Goes: 20°E → 180° → -160° (160°W), north of SOUTH_LAT
    curl -sS --location -g --request POST \
      "https://gateway.api.globalfishingwatch.org/v3/4wings/report?spatial-resolution=${SPATIAL_RES}&temporal-resolution=${TEMPORAL_RES}&group-by=VESSEL_ID&datasets[0]=${DATASET}&date-range=${month_start}T00:00:00.000Z,${month_end}T23:59:59.999Z&format=JSON" \
      -H "Authorization: Bearer ${GFW_API_TOKEN}" \
      -H 'Content-Type: application/json' \
      -d "{\"geojson\":{\"type\":\"Polygon\",\"coordinates\":[[[${WEST_LON},${SOUTH_LAT}],[180,${SOUTH_LAT}],[180,90],[${WEST_LON},90],[${WEST_LON},${SOUTH_LAT}]]]}}" \
      -o "${output_file}.east"

    curl -sS --location -g --request POST \
      "https://gateway.api.globalfishingwatch.org/v3/4wings/report?spatial-resolution=${SPATIAL_RES}&temporal-resolution=${TEMPORAL_RES}&group-by=VESSEL_ID&datasets[0]=${DATASET}&date-range=${month_start}T00:00:00.000Z,${month_end}T23:59:59.999Z&format=JSON" \
      -H "Authorization: Bearer ${GFW_API_TOKEN}" \
      -H 'Content-Type: application/json' \
      -d "{\"geojson\":{\"type\":\"Polygon\",\"coordinates\":[[[-180,${SOUTH_LAT}],[${EAST_LON},${SOUTH_LAT}],[${EAST_LON},90],[-180,90],[-180,${SOUTH_LAT}]]]}}" \
      -o "${output_file}.west"

    # Merge the two JSON responses
    # Extract entries from both and combine them
    python3 << MERGE_EOF
import json

try:
    with open("${output_file}.east", 'r') as f:
        east = json.load(f)
    with open("${output_file}.west", 'r') as f:
        west = json.load(f)

    # Check for errors
    if 'error' in east or 'error' in west:
        # Write error response for retry logic
        with open("${output_file}", 'w') as f:
            json.dump({"error": "API error in one of the requests"}, f)
    else:
        # Merge entries from both responses
        merged = east.copy()
        if 'entries' in east and 'entries' in west and len(east['entries']) > 0 and len(west['entries']) > 0:
            # Get the dataset key (e.g., "public-global-presence:v3.0")
            east_entries = east['entries'][0]
            west_entries = west['entries'][0]
            for key in west_entries:
                if key in east_entries:
                    east_entries[key].extend(west_entries[key])
                else:
                    east_entries[key] = west_entries[key]
        with open("${output_file}", 'w') as f:
            json.dump(merged, f)
except Exception as e:
    with open("${output_file}", 'w') as f:
        json.dump({"error": str(e)}, f)
MERGE_EOF

    rm -f "${output_file}.east" "${output_file}.west"

    # Check if the response contains an error
    if grep -q '"error"' "$output_file"; then
      echo "    ✗ Error in response, waiting 2 minutes before retry..."
      sleep 120
      # Retry the request
      curl -sS --location -g --request POST \
        "https://gateway.api.globalfishingwatch.org/v3/4wings/report?spatial-resolution=${SPATIAL_RES}&temporal-resolution=${TEMPORAL_RES}&group-by=VESSEL_ID&datasets[0]=${DATASET}&date-range=${month_start}T00:00:00.000Z,${month_end}T23:59:59.999Z&format=JSON" \
        -H "Authorization: Bearer ${GFW_API_TOKEN}" \
        -H 'Content-Type: application/json' \
        -d "{\"geojson\":{\"type\":\"Polygon\",\"coordinates\":[[[${WEST_LON},${SOUTH_LAT}],[180,${SOUTH_LAT}],[180,90],[${WEST_LON},90],[${WEST_LON},${SOUTH_LAT}]]]}}" \
        -o "${output_file}.east"

      curl -sS --location -g --request POST \
        "https://gateway.api.globalfishingwatch.org/v3/4wings/report?spatial-resolution=${SPATIAL_RES}&temporal-resolution=${TEMPORAL_RES}&group-by=VESSEL_ID&datasets[0]=${DATASET}&date-range=${month_start}T00:00:00.000Z,${month_end}T23:59:59.999Z&format=JSON" \
        -H "Authorization: Bearer ${GFW_API_TOKEN}" \
        -H 'Content-Type: application/json' \
        -d "{\"geojson\":{\"type\":\"Polygon\",\"coordinates\":[[[-180,${SOUTH_LAT}],[${EAST_LON},${SOUTH_LAT}],[${EAST_LON},90],[-180,90],[-180,${SOUTH_LAT}]]]}}" \
        -o "${output_file}.west"

      python3 << MERGE_EOF
import json
try:
    with open("${output_file}.east", 'r') as f:
        east = json.load(f)
    with open("${output_file}.west", 'r') as f:
        west = json.load(f)
    merged = east.copy()
    if 'entries' in east and 'entries' in west and len(east['entries']) > 0 and len(west['entries']) > 0:
        east_entries = east['entries'][0]
        west_entries = west['entries'][0]
        for key in west_entries:
            if key in east_entries:
                east_entries[key].extend(west_entries[key])
            else:
                east_entries[key] = west_entries[key]
    with open("${output_file}", 'w') as f:
        json.dump(merged, f)
except Exception as e:
    with open("${output_file}", 'w') as f:
        json.dump({"error": str(e)}, f)
MERGE_EOF
      rm -f "${output_file}.east" "${output_file}.west"
    fi

    # Wait between requests to avoid rate limiting
    sleep 10
  done
done

echo "✓ Vessel presence data fetched"
