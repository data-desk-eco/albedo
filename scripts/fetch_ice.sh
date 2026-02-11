#!/bin/bash
# Fetch Arctic sea ice extent + glaciated areas data
set -e

cd "$(dirname "$0")/.."

# NSIDC Sea Ice Index v4 — September 2024 extent (annual minimum)
# Source: National Snow and Ice Data Center
# https://nsidc.org/data/g02135/versions/4
# Citation: Fetterer, F., et al. (2025). Sea Ice Index. (G02135, Version 4).
#   National Snow and Ice Data Center. https://doi.org/10.7265/a98x-0f50
ICE_URL="https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/shapefiles/shp_extent/09_Sep/extent_N_202409_polygon_v4.0.zip"
ICE_ZIP="data/nsidc_ice_extent.zip"
ICE_DIR="data/nsidc_ice_extent"

echo "Downloading NSIDC sea ice extent (September 2024)..."
mkdir -p data
curl -L -o "$ICE_ZIP" "$ICE_URL"
unzip -o "$ICE_ZIP" -d "$ICE_DIR"
rm -f "$ICE_ZIP"

# Natural Earth glaciated areas (10m) — land ice (Greenland ice sheet, etc.)
GLAC_URL="https://naciscdn.org/naturalearth/10m/physical/ne_10m_glaciated_areas.zip"
GLAC_ZIP="data/ne_10m_glaciated_areas.zip"
GLAC_DIR="data/ne_10m_glaciated_areas"

echo "Downloading Natural Earth glaciated areas (10m)..."
curl -L -o "$GLAC_ZIP" "$GLAC_URL"
unzip -o "$GLAC_ZIP" -d "$GLAC_DIR"
rm -f "$GLAC_ZIP"

echo "Done: ice data downloaded"
