#!/usr/bin/env python3
"""Export vessel lookup data to SQLite for sql.js-httpvfs range queries.

Creates a SQLite database optimized for HTTP range requests:
- Normalized schema (lookup tables for ships, flags, vessel types)
- Spatial index on lat/lon for fast tooltip queries
- Vacuumed and optimized for minimal file size

The small vector files (protected_areas, vessel_crossings, places) are
exported as JSON since they're small enough to load fully.
"""
import json
import os
import sqlite3
import sys
from datetime import date, datetime
from pathlib import Path

import duckdb

DATA_ROOT = Path(__file__).parent.parent / "data"
SOURCE_DB = DATA_ROOT / "data.duckdb"
EXPORT_DIR = DATA_ROOT / "export"


def json_serial(obj):
    """JSON serializer for datetime objects."""
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    raise TypeError(f"Type {type(obj)} not serializable")


def export_vessel_lookup_sqlite(db: duckdb.DuckDBPyConnection):
    """Export vessel lookup to normalized SQLite with spatial index."""
    sqlite_path = EXPORT_DIR / "vessel_lookup.sqlite"

    # Remove existing file
    if sqlite_path.exists():
        sqlite_path.unlink()

    print("Exporting vessel lookup to SQLite...")

    # Query data from DuckDB
    result = db.execute("""
        WITH cell_totals AS (
            SELECT lat, lon
            FROM vessel_positions
            GROUP BY lat, lon
            HAVING SUM(hours) >= 1
        ),
        ranked AS (
            SELECT v.lat, v.lon, v.mmsi, v.ship_name, v.flag, v.vessel_type, v.year,
                   CAST(SUM(v.hours) AS INTEGER) as total_hours,
                   ROW_NUMBER() OVER (PARTITION BY v.lat, v.lon ORDER BY SUM(v.hours) DESC) as rn
            FROM vessel_positions v
            INNER JOIN cell_totals c ON v.lat = c.lat AND v.lon = c.lon
            GROUP BY v.lat, v.lon, v.mmsi, v.ship_name, v.flag, v.vessel_type, v.year
        )
        SELECT lat, lon, mmsi, ship_name, flag, vessel_type, year, total_hours
        FROM ranked
        WHERE rn <= 5
        ORDER BY lat, lon
    """).fetchall()

    print(f"  Read {len(result):,} rows from database")

    # Build lookup tables
    ship_data = {}  # mmsi -> (id, name)
    flags = {}
    types = {}

    for row in result:
        mmsi, name, flag, vtype = row[2], row[3], row[4], row[5]
        if mmsi and mmsi not in ship_data:
            ship_data[mmsi] = (len(ship_data), name)
        elif mmsi and name and ship_data.get(mmsi, (None, None))[1] is None:
            ship_data[mmsi] = (ship_data[mmsi][0], name)
        if flag and flag not in flags:
            flags[flag] = len(flags)
        if vtype and vtype not in types:
            types[vtype] = len(types)

    print(f"  Unique ships: {len(ship_data)}, flags: {len(flags)}, types: {len(types)}")

    # Create normalized SQLite database
    conn = sqlite3.connect(str(sqlite_path), isolation_level=None)
    conn.execute("PRAGMA page_size = 4096")
    conn.execute("PRAGMA journal_mode = DELETE")

    # Create lookup tables
    conn.execute("CREATE TABLE ships (id INTEGER PRIMARY KEY, mmsi TEXT, name TEXT)")
    conn.execute("CREATE TABLE flags (id INTEGER PRIMARY KEY, code TEXT)")
    conn.execute("CREATE TABLE vessel_types (id INTEGER PRIMARY KEY, name TEXT)")

    conn.execute("BEGIN")
    conn.executemany(
        "INSERT INTO ships VALUES (?, ?, ?)",
        [(id, mmsi, name) for mmsi, (id, name) in ship_data.items()],
    )
    conn.executemany(
        "INSERT INTO flags VALUES (?, ?)", [(id, code) for code, id in flags.items()]
    )
    conn.executemany(
        "INSERT INTO vessel_types VALUES (?, ?)",
        [(id, name) for name, id in types.items()],
    )
    conn.execute("COMMIT")

    # Create main table with foreign keys
    conn.execute("""
        CREATE TABLE vessel_lookup (
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            ship_id INTEGER,
            flag_id INTEGER,
            type_id INTEGER,
            year INTEGER,
            total_hours INTEGER
        )
    """)

    # Transform and insert data
    print("  Inserting normalized data...")
    conn.execute("BEGIN")
    batch = []
    batch_size = 50000
    for row in result:
        ship_id = ship_data.get(row[2], (None,))[0] if row[2] else None
        flag_id = flags.get(row[4])
        type_id = types.get(row[5])
        batch.append((row[0], row[1], ship_id, flag_id, type_id, row[6], row[7]))

        if len(batch) >= batch_size:
            conn.executemany(
                "INSERT INTO vessel_lookup VALUES (?, ?, ?, ?, ?, ?, ?)", batch
            )
            batch = []

    if batch:
        conn.executemany("INSERT INTO vessel_lookup VALUES (?, ?, ?, ?, ?, ?, ?)", batch)
    conn.execute("COMMIT")

    # Create indexes
    print("  Creating indexes...")
    conn.execute("CREATE INDEX idx_lookup_lat_lon ON vessel_lookup(lat, lon)")
    conn.execute("CREATE INDEX idx_ships_mmsi ON ships(mmsi)")

    # Optimize
    print("  Optimizing...")
    conn.execute("VACUUM")

    row_count = conn.execute("SELECT COUNT(*) FROM vessel_lookup").fetchone()[0]
    conn.close()

    file_size = sqlite_path.stat().st_size / 1024 / 1024
    print(f"  vessel_lookup.sqlite: {row_count:,} rows ({file_size:.1f} MB)")

    return file_size


def export_json_files(db: duckdb.DuckDBPyConnection):
    """Export small vector files as JSON for direct loading."""
    total_size = 0

    # Protected areas
    print("Exporting protected areas to JSON...")
    db.execute("INSTALL spatial; LOAD spatial;")
    result = db.execute("""
        SELECT
            feature_id as id,
            area_name as name,
            ST_AsGeoJSON(geometry) as geometry
        FROM protected_areas_ocean
    """).fetchall()

    features = []
    for row in result:
        features.append(
            {
                "type": "Feature",
                "id": row[0],
                "geometry": json.loads(row[2]),
                "properties": {"name": row[1]},
            }
        )

    geojson = {"type": "FeatureCollection", "features": features}
    json_path = EXPORT_DIR / "protected_areas.json"
    with open(json_path, "w") as f:
        json.dump(geojson, f, separators=(",", ":"))

    file_size = json_path.stat().st_size / 1024
    total_size += file_size
    print(f"  protected_areas.json: {len(features)} features ({file_size:.1f} KB)")

    # Vessel crossings
    print("Exporting vessel crossings to JSON...")
    result = db.execute("""
        SELECT
            feature_id,
            area_name,
            vessel_id,
            mmsi,
            ship_name,
            flag,
            vessel_type,
            gear_type,
            total_hours,
            first_seen,
            last_seen,
            year,
            centroid_lon,
            centroid_lat,
            position_count
        FROM vessel_crossings
    """).fetchall()

    features = []
    for row in result:
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [row[12], row[13]]},
                "properties": {
                    "feature_id": row[0],
                    "area_name": row[1],
                    "vessel_id": row[2],
                    "mmsi": row[3],
                    "ship_name": row[4],
                    "flag": row[5],
                    "vessel_type": row[6],
                    "gear_type": row[7],
                    "total_hours": row[8],
                    "first_seen": row[9],
                    "last_seen": row[10],
                    "year": row[11],
                    "position_count": row[14],
                },
            }
        )

    geojson = {"type": "FeatureCollection", "features": features}
    json_path = EXPORT_DIR / "vessel_crossings.json"
    with open(json_path, "w") as f:
        json.dump(geojson, f, separators=(",", ":"), default=json_serial)

    file_size = json_path.stat().st_size / 1024
    total_size += file_size
    print(f"  vessel_crossings.json: {len(features)} features ({file_size:.1f} KB)")

    # Places
    print("Exporting places to JSON...")
    result = db.execute(f"""
        SELECT
            NAME as name_en,
            NAME_RU as name_ru,
            CAST(ST_X(geom) AS DOUBLE) as lon,
            CAST(ST_Y(geom) AS DOUBLE) as lat,
            CAST(POP_MAX AS INTEGER) as population,
            CAST(SCALERANK AS INTEGER) as scalerank
        FROM ST_Read('{DATA_ROOT}/ne_10m_populated_places/ne_10m_populated_places.shp')
        WHERE SCALERANK <= 5
          AND ST_Y(geom) >= 50
          AND ADM0_A3 = 'RUS'
    """).fetchall()

    features = []
    for row in result:
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [row[2], row[3]]},
                "properties": {
                    "name_en": row[0],
                    "name_ru": row[1],
                    "population": row[4],
                    "scalerank": row[5],
                },
            }
        )

    geojson = {"type": "FeatureCollection", "features": features}
    json_path = EXPORT_DIR / "places.json"
    with open(json_path, "w") as f:
        json.dump(geojson, f, separators=(",", ":"))

    file_size = json_path.stat().st_size / 1024
    total_size += file_size
    print(f"  places.json: {len(features)} features ({file_size:.1f} KB)")

    return total_size / 1024  # Return MB


def main():
    if not SOURCE_DB.exists():
        print(f"Error: Source database not found: {SOURCE_DB}")
        sys.exit(1)

    EXPORT_DIR.mkdir(exist_ok=True)

    db = duckdb.connect(str(SOURCE_DB), read_only=True)

    # Export SQLite for vessel lookup (large, needs range queries)
    sqlite_size = export_vessel_lookup_sqlite(db)

    # Export JSON for small vector files
    json_size = export_json_files(db)

    db.close()

    print(f"\nExport complete:")
    print(f"  SQLite (range queries): {sqlite_size:.1f} MB")
    print(f"  JSON (full load): {json_size:.1f} MB")
    print(f"  Total: {sqlite_size + json_size:.1f} MB")
    print(f"\nExport directory: {EXPORT_DIR}")


if __name__ == "__main__":
    main()
