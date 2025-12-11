#!/bin/bash
set -e

mkdir -p data/gfw

# Parse YEARS env var (comma-separated)
IFS=',' read -ra YEAR_ARRAY <<< "$YEARS"

echo "Fetching vessel presence for years: ${YEARS}..."

# Fetch GFW data for a single region (east or west of antimeridian)
fetch_region() {
  local output=$1
  local polygon=$2
  local start=$3
  local end=$4

  curl -sS --location -g --request POST \
    "https://gateway.api.globalfishingwatch.org/v3/4wings/report?spatial-resolution=${SPATIAL_RES}&temporal-resolution=${TEMPORAL_RES}&group-by=VESSEL_ID&datasets[0]=${DATASET}&date-range=${start}T00:00:00.000Z,${end}T23:59:59.999Z&format=JSON" \
    -H "Authorization: Bearer ${GFW_API_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"geojson\":${polygon}}" \
    -o "$output"
}

# Fetch and merge east/west responses for a month
fetch_month() {
  local output_file=$1
  local month_start=$2
  local month_end=$3

  local east_polygon="{\"type\":\"Polygon\",\"coordinates\":[[[${WEST_LON},${SOUTH_LAT}],[180,${SOUTH_LAT}],[180,90],[${WEST_LON},90],[${WEST_LON},${SOUTH_LAT}]]]}"
  local west_polygon="{\"type\":\"Polygon\",\"coordinates\":[[[-180,${SOUTH_LAT}],[${EAST_LON},${SOUTH_LAT}],[${EAST_LON},90],[-180,90],[-180,${SOUTH_LAT}]]]}"

  fetch_region "${output_file}.east" "$east_polygon" "$month_start" "$month_end"
  fetch_region "${output_file}.west" "$west_polygon" "$month_start" "$month_end"

  python3 "$(dirname "$0")/merge_gfw_responses.py" \
    "${output_file}.east" "${output_file}.west" "$output_file"

  rm -f "${output_file}.east" "${output_file}.west"
}

for year in "${YEAR_ARRAY[@]}"; do
  mkdir -p "data/gfw/${year}"

  for month in {1..12}; do
    month_padded=$(printf "%02d" $month)
    output_file="data/gfw/${year}/${year}-${month_padded}.json"

    # Calculate last day of month using date command
    # macOS/BSD date syntax
    last_day=$(date -j -v+1m -v1d -v-1d -f "%Y-%m-%d" "${year}-${month_padded}-01" +%d 2>/dev/null || \
               date -d "${year}-${month_padded}-01 +1 month -1 day" +%d)

    month_start="${year}-${month_padded}-01"
    month_end="${year}-${month_padded}-${last_day}"

    echo "  Fetching ${month_start} to ${month_end}..."

    fetch_month "$output_file" "$month_start" "$month_end"

    # Check if the response contains an error
    if grep -q '"error"' "$output_file"; then
      echo "    ✗ Error in response, waiting 2 minutes before retry..."
      sleep 120
      fetch_month "$output_file" "$month_start" "$month_end"
    fi

    # Wait between requests to avoid rate limiting
    sleep 10
  done
done

echo "✓ Vessel presence data fetched"
