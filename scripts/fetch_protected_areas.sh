#!/bin/bash
set -e

BASE_URL="https://xn--80aa2azak.xn--g1agk6a.xn--p1ai"
COOKIE=$(mktemp)

mkdir -p data

# Get CSRF token
curl -sS -c "$COOKIE" "$BASE_URL" > /dev/null
CSRF=$(grep csrftoken "$COOKIE" | awk '{print $7}')

# Fetch protected areas
curl -sS -X POST "${BASE_URL}/proxy_geoserver_request/" \
  -H "Content-Type: application/json" \
  -H "X-CSRFToken: $CSRF" \
  -H "Referer: $BASE_URL" \
  -b "$COOKIE" \
  -d '{"url":"ows?service=WFS&version=1.1.0&request=GetFeature&typeName=oopt:oopt_wth_details&outputFormat=application/json"}' \
  -o data/protected_areas.geojson

rm "$COOKIE"

echo "✓ $(jq -r '.numberReturned // "unknown"' data/protected_areas.geojson) protected areas"
