#!/usr/bin/env python3
"""
Export sanctioned vessel positions as GeoJSON for PMTiles generation.

Filters vessel presence data for MMSIs in the sanctioned list,
then exports as 0.01° grid cell polygons that overlay the heatmap.

Usage:
    uv run python scripts/export_sanctions_layer.py

Output:
    data/temp_geojson/sanctioned_vessels.geojson
"""

import json
from pathlib import Path

import duckdb

CELL_SIZE = 0.01  # Must match the raster grid cell size

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "data.duckdb"
SANCTIONS_PATH = ROOT / "data" / "export" / "sanctioned_mmsi.json"
OUTPUT_DIR = ROOT / "data" / "temp_geojson"
OUTPUT_PATH = OUTPUT_DIR / "sanctioned_vessels.geojson"


def main():
    if not DB_PATH.exists():
        print("Database not found. Run 'make transform' first.")
        return

    if not SANCTIONS_PATH.exists():
        print("Sanctioned MMSI list not found. Run 'make sanctions' first.")
        return

    # Load sanctioned MMSIs
    mmsi_list = json.loads(SANCTIONS_PATH.read_text())
    print(f"Loaded {len(mmsi_list)} sanctioned MMSIs")

    con = duckdb.connect(str(DB_PATH), read_only=True)

    # Create a temp table with sanctioned MMSIs
    con.execute("CREATE TEMP TABLE sanctioned_mmsi (mmsi VARCHAR)")
    for mmsi in mmsi_list:
        con.execute("INSERT INTO sanctioned_mmsi VALUES (?)", [str(mmsi)])

    # Aggregate by grid cell across all sanctioned vessels, tracking years
    rows = con.execute("""
        SELECT
            vp.lat, vp.lon,
            SUM(vp.hours) as total_hours,
            COUNT(DISTINCT vp.mmsi) as vessel_count,
            LIST(DISTINCT vp.year ORDER BY vp.year) as years
        FROM vessel_positions vp
        JOIN sanctioned_mmsi sm ON vp.mmsi = sm.mmsi
        GROUP BY vp.lat, vp.lon
        HAVING SUM(vp.hours) >= 1
    """).fetchall()

    con.close()

    print(f"Found {len(rows)} grid cells with sanctioned vessel activity")

    # Build GeoJSON polygon features (one per grid cell)
    features = []
    all_years = set()
    for lat, lon, total_hours, vessel_count, years in rows:
        # lat from the DB is the TOP edge of the cell (snapToGrid uses
        # 90 - floor((90 - lat) * 100) * 0.01), so the polygon extends
        # downward.  lon is the LEFT edge, so the polygon extends right.
        min_lat = lat - CELL_SIZE
        max_lat = lat
        min_lon = lon
        max_lon = lon + CELL_SIZE

        # Boolean year properties for efficient MapLibre filtering
        props = {
            "hours": round(total_hours, 1),
            "vessels": vessel_count,
        }
        for y in years:
            props[f"y{y}"] = True
            all_years.add(y)

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
