#!/usr/bin/env python3
"""
Export sanctioned vessel positions as GeoJSON for PMTiles generation.

Filters vessel presence data for MMSIs in the sanctioned list,
then exports as point features for visualization on the map.

Usage:
    uv run python scripts/export_sanctions_layer.py

Output:
    data/temp_geojson/sanctioned_vessels.geojson
"""

import json
from pathlib import Path

import duckdb

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

    # Query sanctioned vessel positions - aggregate by grid cell per vessel
    rows = con.execute("""
        SELECT
            vp.lat, vp.lon,
            vp.mmsi,
            vp.ship_name,
            vp.vessel_type,
            vp.flag,
            SUM(vp.hours) as total_hours,
            MIN(vp.entry_timestamp) as first_seen,
            MAX(vp.exit_timestamp) as last_seen
        FROM vessel_positions vp
        JOIN sanctioned_mmsi sm ON vp.mmsi = sm.mmsi
        GROUP BY vp.lat, vp.lon, vp.mmsi, vp.ship_name, vp.vessel_type, vp.flag
        HAVING SUM(vp.hours) >= 1
    """).fetchall()

    con.close()

    print(f"Found {len(rows)} sanctioned vessel position records")

    # Build GeoJSON features
    features = []
    for lat, lon, mmsi, ship_name, vessel_type, flag, total_hours, first_seen, last_seen in rows:
        props = {
            "mmsi": mmsi,
            "name": ship_name or "",
            "type": vessel_type or "",
            "flag": flag or "",
            "hours": round(total_hours, 1),
        }
        if first_seen:
            props["first_seen"] = first_seen.isoformat()
        if last_seen:
            props["last_seen"] = last_seen.isoformat()

        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [lon, lat],
            },
            "properties": props,
        })

    geojson = {
        "type": "FeatureCollection",
        "features": features,
    }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(geojson))
    print(f"Wrote {OUTPUT_PATH} ({len(features)} features)")


if __name__ == "__main__":
    main()
