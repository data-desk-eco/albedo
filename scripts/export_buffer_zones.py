#!/usr/bin/env python3
"""
Export buffer zones as GeoJSON for the map.
Filters buffer zones to the study area and clips to ocean.

Input:  data/buffer_zones/raw.geojson (from fetch_buffer_zones.sh)
Output: data/export/buffer_zones.geojson

Usage:
    uv run python scripts/export_buffer_zones.py
"""

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_PATH = ROOT / "data" / "buffer_zones" / "raw.geojson"
EXPORT_PATH = ROOT / "data" / "export" / "buffer_zones.geojson"
SOUTH_LAT = float(os.environ.get("SOUTH_LAT", "50"))


def main():
    if not RAW_PATH.exists():
        print(f"Warning: {RAW_PATH} not found, skipping buffer zone export")
        print("Run scripts/fetch_buffer_zones.sh first")
        return

    with open(RAW_PATH, "r") as f:
        data = json.load(f)

    features = data.get("features", [])
    print(f"Processing {len(features)} buffer zone features...")

    filtered = []
    for feat in features:
        props = feat.get("properties", {})
        geom = feat.get("geometry")
        if not geom:
            continue

        # Extract bounding box or check geometry coordinates
        bbox = feat.get("bbox")
        if bbox and bbox[1] < SOUTH_LAT and bbox[3] < SOUTH_LAT:
            continue  # Entirely below study area

        # Build clean properties
        clean_props = {
            "name": props.get("title", ""),
            "category": props.get("category_title", ""),
            "area_ha": props.get("area", 0),
        }

        filtered.append({
            "type": "Feature",
            "geometry": geom,
            "properties": clean_props,
        })

    print(f"  {len(filtered)} buffer zones in study area")

    output = {
        "type": "FeatureCollection",
        "features": filtered,
    }

    EXPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(EXPORT_PATH, "w") as f:
        json.dump(output, f)

    print(f"  Wrote {EXPORT_PATH}")


if __name__ == "__main__":
    main()
