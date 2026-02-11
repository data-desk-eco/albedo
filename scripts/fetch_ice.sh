#!/bin/bash
# Fetch Arctic sea ice extent + glaciated areas data
set -e

cd "$(dirname "$0")/.."

# IMS Daily Northern Hemisphere Snow and Ice Analysis, 1km resolution
# Source: NOAA/NSIDC (G02156, Version 1)
# Using September 15, 2024 (day 259) — near annual Arctic sea ice minimum
# https://nsidc.org/data/g02156/versions/1
# Values: 0=outside coverage, 1=open water, 2=land, 3=sea ice, 4=snow
IMS_URL="https://noaadata.apps.nsidc.org/NOAA/G02156/GIS/1km/2024/ims2024259_1km_GIS_v1.3.tif.gz"
IMS_GZ="data/ims_1km.tif.gz"
IMS_TIF="data/ims_1km.tif"

echo "Downloading IMS 1km sea ice data (September 15, 2024)..."
mkdir -p data
curl -L -o "$IMS_GZ" "$IMS_URL"
gunzip -f "$IMS_GZ"

# Natural Earth glaciated areas (10m) — land ice (Greenland ice sheet, etc.)
GLAC_URL="https://naciscdn.org/naturalearth/10m/physical/ne_10m_glaciated_areas.zip"
GLAC_ZIP="data/ne_10m_glaciated_areas.zip"
GLAC_DIR="data/ne_10m_glaciated_areas"

echo "Downloading Natural Earth glaciated areas (10m)..."
curl -L -o "$GLAC_ZIP" "$GLAC_URL"
unzip -o "$GLAC_ZIP" -d "$GLAC_DIR"
rm -f "$GLAC_ZIP"

echo "Done: ice data downloaded"
