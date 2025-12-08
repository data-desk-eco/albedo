#!/bin/bash
set -e

cd "$(dirname "$0")/.."

PLACES_URL="https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places.zip"
PLACES_ZIP="data/ne_10m_populated_places.zip"
PLACES_DIR="data/ne_10m_populated_places"

echo "Downloading Natural Earth populated places (10m resolution)..."
mkdir -p data
curl -L -o "$PLACES_ZIP" "$PLACES_URL"

echo "Extracting..."
unzip -o "$PLACES_ZIP" -d "$PLACES_DIR"

echo "✓ Places data downloaded to $PLACES_DIR"
