#!/usr/bin/env python3
"""Create raster directly from gridded vessel position data."""

import csv
import os

from raster_utils import ARCTIC_CONFIG, write_raster, print_raster_stats

# Configuration - can be overridden via environment variables
INPUT_CSV = os.environ.get("INPUT_CSV", "data/vessel_activity.csv")
OUTPUT_PATH = os.environ.get("OUTPUT_PATH", "data/vessel_activity.tif")


def main():
    config = ARCTIC_CONFIG

    print(f"Creating raster: {config.width}x{config.height} pixels")
    print(f"Resolution: {config.resolution}deg ({config.resolution * 111:.1f}km at equator)")

    raster_array = config.create_array()

    print(f"Reading vessel activity data from {INPUT_CSV}...")
    count = 0
    with open(INPUT_CSV, "r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            lon = float(row["lon"])
            lat = float(row["lat"])
            hours = float(row["hours"])

            if hours <= 0:
                continue

            col, row_idx = config.lonlat_to_pixel(lon, lat)

            if config.is_valid_pixel(col, row_idx):
                raster_array[row_idx, col] = hours
                count += 1

                if count % 100000 == 0:
                    print(f"  Processed {count:,} grid cells...")

    print(f"Processed {count:,} grid cells total")

    print(f"Writing raster to {OUTPUT_PATH}...")
    write_raster(OUTPUT_PATH, raster_array, config, compress="lzw")

    print(f"Created raster: {OUTPUT_PATH}")
    print_raster_stats(raster_array)


if __name__ == "__main__":
    main()
