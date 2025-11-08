#!/bin/bash
set -e

mkdir -p data

# Fetch vessel presence
curl -sS --location -g --request POST \
  "https://gateway.api.globalfishingwatch.org/v3/4wings/report?spatial-resolution=${SPATIAL_RES}&temporal-resolution=${TEMPORAL_RES}&group-by=VESSEL_ID&datasets[0]=${DATASET}&date-range=${START_DATE}T00:00:00.000Z,${END_DATE}T23:59:59.999Z&format=JSON" \
  -H "Authorization: Bearer ${GFW_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{\"geojson\":{\"type\":\"Polygon\",\"coordinates\":[[[-180,${SOUTH_LAT}],[180,${SOUTH_LAT}],[180,90],[-180,90],[-180,${SOUTH_LAT}]]]}}" \
  -o data/vessel_presence.json

# Extract vessel details
jq -c '[.entries[] | .[][] | {vesselId, imo, mmsi, shipName, flag, geartype, vesselType, firstTransmissionDate, lastTransmissionDate, dataset, callsign}] | unique_by(.vesselId)' \
  data/vessel_presence.json > data/vessel_details.json

echo "✓ $(jq length data/vessel_details.json) vessels (${START_DATE} to ${END_DATE})"
