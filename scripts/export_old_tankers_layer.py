#!/usr/bin/env python3
"""
Export old oil tanker (>25yr) vessel positions as GeoJSON for PMTiles generation.

Filters vessel presence data for MMSIs in the vessel_metadata.json that are
tagged as oil tankers (ot=true) with build year >= 25 years ago, then exports
as 0.01 grid cell polygons that overlay the heatmap.

Usage:
    uv run python scripts/export_old_tankers_layer.py

Output:
    data/temp_geojson/old_tankers.geojson
"""

import json
from pathlib import Path

import duckdb

CELL_SIZE = 0.01  # Must match the raster grid cell size
AGE_THRESHOLD = 25

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "data.duckdb"
METADATA_PATH = ROOT / "data" / "export" / "vessel_metadata.json"
OUTPUT_DIR = ROOT / "data" / "temp_geojson"
OUTPUT_PATH = OUTPUT_DIR / "old_tankers.geojson"


def main():
    if not DB_PATH.exists():
        print("Database not found. Run 'make transform' first.")
        return

    if not METADATA_PATH.exists():
        print("Vessel metadata not found. Run tanker ingestion first.")
        return

    # Load vessel metadata and find old tanker MMSIs
    metadata = json.loads(METADATA_PATH.read_text())
    current_year = 2025
    old_tanker_mmsis = []
    for mmsi, meta in metadata.items():
        if meta.get("ot") and meta.get("y") and (current_year - meta["y"]) >= AGE_THRESHOLD:
            old_tanker_mmsis.append(mmsi)

    print(f"Found {len(old_tanker_mmsis)} old tanker MMSIs (>={AGE_THRESHOLD}yr)")

    if not old_tanker_mmsis:
        print("No old tankers found, skipping export.")
        return

    con = duckdb.connect(str(DB_PATH), read_only=True)

    # Create a temp table with old tanker MMSIs
    con.execute("CREATE TEMP TABLE old_tanker_mmsi (mmsi VARCHAR)")
    for mmsi in old_tanker_mmsis:
        con.execute("INSERT INTO old_tanker_mmsi VALUES (?)", [str(mmsi)])

    # Aggregate by grid cell, tracking years, vessel types and flags
    rows = con.execute("""
        SELECT
            vp.lat, vp.lon,
            SUM(vp.hours) as total_hours,
            COUNT(DISTINCT vp.mmsi) as vessel_count,
            LIST(DISTINCT vp.year ORDER BY vp.year) as years,
            LIST(DISTINCT vp.vessel_type) as vessel_types,
            LIST(DISTINCT vp.flag) as flags
        FROM vessel_positions vp
        JOIN old_tanker_mmsi ot ON vp.mmsi = ot.mmsi
        GROUP BY vp.lat, vp.lon
        HAVING SUM(vp.hours) >= 1
    """).fetchall()

    con.close()

    print(f"Found {len(rows)} grid cells with old tanker activity")

    # Build GeoJSON polygon features (one per grid cell)
    features = []
    all_years = set()
    for lat, lon, total_hours, vessel_count, years, vessel_types, flags in rows:
        min_lat = lat - CELL_SIZE
        max_lat = lat
        min_lon = lon
        max_lon = lon + CELL_SIZE

        # Boolean year, vessel type, and flag properties for MapLibre filtering
        props = {}
        for y in years:
            props[f"y{y}"] = True
            all_years.add(y)
        has_foreign = False
        for vt in (vessel_types or []):
            if vt:
                props[f"t_{vt}"] = True
        for f in (flags or []):
            if f:
                props[f"f_{f}"] = True
                if f != "RUS":
                    has_foreign = True
        if has_foreign:
            props["f_foreign"] = True

        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [min_lon, min_lat],
                    [max_lon, min_lat],
                    [max_lon, max_lat],
                    [min_lon, max_lat],
                    [min_lon, min_lat],
                ]],
            },
            "properties": props,
        })

    geojson = {
        "type": "FeatureCollection",
        "features": features,
    }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(geojson))
    print(f"Wrote {OUTPUT_PATH} ({len(features)} polygon features, years: {sorted(all_years)})")


if __name__ == "__main__":
    main()
