#!/bin/bash
set -e

mkdir -p data/gfw

start_year=$(date -j -f "%Y-%m-%d" "$START_DATE" "+%Y")
start_month=$(date -j -f "%Y-%m-%d" "$START_DATE" "+%m")
end_year=$(date -j -f "%Y-%m-%d" "$END_DATE" "+%Y")
end_month=$(date -j -f "%Y-%m-%d" "$END_DATE" "+%m")

echo "Fetching ${START_DATE} to ${END_DATE}..."

for year in $(seq $start_year $end_year); do
  for month in {1..12}; do
    # Skip months outside the date range
    if [ $year -eq $start_year ] && [ $month -lt $((10#$start_month)) ]; then
      continue
    fi
    if [ $year -eq $end_year ] && [ $month -gt $((10#$end_month)) ]; then
      continue
    fi

    month_padded=$(printf "%02d" $month)
    output_file="data/gfw/${year}-${month_padded}.json"

    # Skip if already exists
    if [ -f "$output_file" ]; then
      echo "  Skipping ${year}-${month_padded} (already exists)"
      continue
    fi

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

    curl -sS --location -g --request POST \
      "https://gateway.api.globalfishingwatch.org/v3/4wings/report?spatial-resolution=${SPATIAL_RES}&temporal-resolution=${TEMPORAL_RES}&group-by=VESSEL_ID&datasets[0]=${DATASET}&date-range=${month_start}T00:00:00.000Z,${month_end}T23:59:59.999Z&format=JSON" \
      -H "Authorization: Bearer ${GFW_API_TOKEN}" \
      -H 'Content-Type: application/json' \
      -d "{\"geojson\":{\"type\":\"Polygon\",\"coordinates\":[[[-180,${SOUTH_LAT}],[180,${SOUTH_LAT}],[180,90],[-180,90],[-180,${SOUTH_LAT}]]]}}" \
      -o "$output_file"

    sleep 3
  done
done

echo "✓ Vessel presence data fetched"
