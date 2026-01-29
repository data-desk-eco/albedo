#!/bin/bash
# Fetch buffer zones for protected areas from the OOPT GeoServer
# Buffer zones are separate geometries around core protected area boundaries
set -e

BASE_URL="https://xn--80aa2azak.xn--g1agk6a.xn--p1ai"
COOKIE=$(mktemp)

mkdir -p data/buffer_zones

# Get CSRF token
curl -sS -c "$COOKIE" "$BASE_URL" > /dev/null
CSRF=$(grep csrftoken "$COOKIE" | awk '{print $7}')

# Fetch buffer zones layer (ohr_zones = охранные зоны)
echo "Fetching buffer zones from OOPT GeoServer..."
curl -sS -X POST "${BASE_URL}/proxy_geoserver_request/" \
  -H "Content-Type: application/json" \
  -H "X-CSRFToken: $CSRF" \
  -H "Referer: $BASE_URL" \
  -b "$COOKIE" \
  -d '{"url":"ows?service=WFS&version=1.1.0&request=GetFeature&typeName=oopt:ohr_zones_wth_details&outputFormat=application/json"}' \
  -o data/buffer_zones/raw.geojson

rm "$COOKIE"

FEATURE_COUNT=$(jq -r '.numberReturned // (.features | length) // "unknown"' data/buffer_zones/raw.geojson 2>/dev/null || echo "unknown")
echo "Fetched $FEATURE_COUNT buffer zone features"
