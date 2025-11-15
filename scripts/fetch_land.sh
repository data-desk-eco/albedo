#!/bin/bash
set -e

cd "$(dirname "$0")/.."

LAND_URL="https://naciscdn.org/naturalearth/10m/physical/ne_10m_land.zip"
LAND_ZIP="data/ne_10m_land.zip"
LAND_DIR="data/ne_10m_land"

echo "Downloading Natural Earth land polygons (10m resolution)..."
mkdir -p data
curl -L -o "$LAND_ZIP" "$LAND_URL"

echo "Extracting..."
unzip -o "$LAND_ZIP" -d "$LAND_DIR"

echo "✓ Land data downloaded to $LAND_DIR"
