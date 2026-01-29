#!/bin/bash

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

# Fetch and merge east/west responses for a month (returns 0 on success, 1 on failure)
fetch_month() {
  local output_file=$1
  local month_start=$2
  local month_end=$3
  local max_retries=3

  local east_polygon="{\"type\":\"Polygon\",\"coordinates\":[[[${WEST_LON},${SOUTH_LAT}],[180,${SOUTH_LAT}],[180,90],[${WEST_LON},90],[${WEST_LON},${SOUTH_LAT}]]]}"
  local west_polygon="{\"type\":\"Polygon\",\"coordinates\":[[[-180,${SOUTH_LAT}],[${EAST_LON},${SOUTH_LAT}],[${EAST_LON},90],[-180,90],[-180,${SOUTH_LAT}]]]}"

  for attempt in $(seq 1 $max_retries); do
    # Fetch east region
    fetch_region "${output_file}.east" "$east_polygon" "$month_start" "$month_end"

    # Check for rate limit error on east
    if grep -q '"Too Many Requests"' "${output_file}.east" 2>/dev/null || [ ! -s "${output_file}.east" ]; then
      echo "    Rate limited on east (attempt $attempt), waiting 3 minutes..."
      sleep 180
      continue
    fi

    # Wait between east/west - API only allows one concurrent report
    sleep 60

    # Fetch west region
    fetch_region "${output_file}.west" "$west_polygon" "$month_start" "$month_end"

    # Check for rate limit error on west
    if grep -q '"Too Many Requests"' "${output_file}.west" 2>/dev/null || [ ! -s "${output_file}.west" ]; then
      echo "    Rate limited on west (attempt $attempt), waiting 3 minutes..."
      sleep 180
      continue
    fi

    # Try to merge
    if python3 "$(dirname "$0")/merge_gfw_responses.py" \
      "${output_file}.east" "${output_file}.west" "$output_file"; then
      rm -f "${output_file}.east" "${output_file}.west"
      return 0
    else
      echo "    Merge failed (attempt $attempt), waiting 3 minutes..."
      sleep 180
    fi
  done

  echo "    Failed after $max_retries attempts"
  rm -f "${output_file}.east" "${output_file}.west" "$output_file"
  return 1
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

    # Skip if already fetched (file exists and is valid JSON with entries)
    if [ -f "$output_file" ] && grep -q '"entries"' "$output_file" 2>/dev/null; then
      echo "  Skipping ${month_start} (already exists)"
      continue
    fi

    echo "  Fetching ${month_start} to ${month_end}..."

    if ! fetch_month "$output_file" "$month_start" "$month_end"; then
      echo "  ✗ Failed to fetch ${month_start}, continuing to next month..."
    fi

    # Wait between months to avoid rate limiting
    sleep 30
  done
done

echo "✓ Vessel presence data fetched"
