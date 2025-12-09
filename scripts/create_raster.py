#!/usr/bin/env python3
"""Create raster directly from gridded vessel position data."""

import numpy as np
import rasterio
from rasterio.transform import from_bounds
import csv
import os

# Configuration - can be overridden via environment variables
INPUT_CSV = os.environ.get("INPUT_CSV", "data/vessel_activity.csv")
OUTPUT_PATH = os.environ.get("OUTPUT_PATH", "data/vessel_activity.tif")

# Raster bounds and resolution
MIN_LON, MAX_LON = -180.0, 180.0
MIN_LAT, MAX_LAT = 56.0, 90.0
RESOLUTION = 0.01

# Calculate raster dimensions
width = int((MAX_LON - MIN_LON) / RESOLUTION)
height = int((MAX_LAT - MIN_LAT) / RESOLUTION)

print(f"Creating raster: {width}x{height} pixels")
print(f"Resolution: {RESOLUTION}° ({RESOLUTION * 111:.1f}km at equator)")

# Initialize array with nodata
raster_array = np.zeros((height, width), dtype=np.float32)

# Read CSV and populate raster
print(f"Reading vessel activity data from {INPUT_CSV}...")
count = 0
with open(INPUT_CSV, 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        lon = float(row['lon'])
        lat = float(row['lat'])
        hours = float(row['hours'])

        if hours <= 0:
            continue

        # Calculate pixel position with proper rounding to avoid floating point errors
        # Pixel coordinates: (0,0) is top-left
        # Longitude increases left to right (col)
        # Latitude decreases top to bottom (row)
        # Use round() instead of int() to handle float precision issues
        # e.g., 1.9999999 should map to pixel 2, not pixel 1
        col = round((lon - MIN_LON) / RESOLUTION)
        row_idx = round((MAX_LAT - lat) / RESOLUTION)

        # Bounds check
        if 0 <= row_idx < height and 0 <= col < width:
            raster_array[row_idx, col] = hours
            count += 1

            if count % 100000 == 0:
                print(f"  Processed {count:,} grid cells...")

print(f"Processed {count:,} grid cells total")

# Create affine transform
transform = from_bounds(MIN_LON, MIN_LAT, MAX_LON, MAX_LAT, width, height)

# Write GeoTIFF
print(f"Writing raster to {OUTPUT_PATH}...")
with rasterio.open(
    OUTPUT_PATH,
    'w',
    driver='GTiff',
    height=height,
    width=width,
    count=1,
    dtype=rasterio.float32,
    crs='EPSG:4326',
    transform=transform,
    nodata=0.0,
    compress='lzw',
    tiled=True,
    bigtiff='IF_SAFER'
) as dst:
    dst.write(raster_array, 1)

print(f"✓ Created raster: {OUTPUT_PATH}")
print(f"  Non-zero pixels: {np.count_nonzero(raster_array):,} / {width * height:,}")
print(f"  Value range: {raster_array[raster_array > 0].min():.2f} - {raster_array.max():.2f}")
