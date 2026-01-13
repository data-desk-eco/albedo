#!/usr/bin/env python3
"""Export all data to Parquet files for client-side DuckDB-WASM queries.

Creates separate Parquet files optimized for range queries:
- protected_areas.parquet: Protected area polygons as GeoJSON
- vessel_crossings.parquet: Vessel crossing points and metadata
- vessel_lookup.parquet: Pre-aggregated vessel data for tooltips (sorted by lat/lon)
- places.parquet: Place names and locations

These are exported as separate files rather than a single file to allow
DuckDB-WASM to efficiently query just the data it needs via HTTP range requests.
"""
import os
import sys
from pathlib import Path

import duckdb

DATA_ROOT = Path(__file__).parent.parent / "data"
SOURCE_DB = DATA_ROOT / "data.duckdb"
EXPORT_DIR = DATA_ROOT / "export"


def main():
    if not SOURCE_DB.exists():
        print(f"Error: Source database not found: {SOURCE_DB}")
        sys.exit(1)

    EXPORT_DIR.mkdir(exist_ok=True)

    db = duckdb.connect(str(SOURCE_DB), read_only=True)
    db.execute("INSTALL spatial; LOAD spatial;")

    # Export protected areas with geometry as GeoJSON
    print("Exporting protected areas...")
    db.execute(f"""
        COPY (
            SELECT
                feature_id,
                area_name,
                ST_AsGeoJSON(geometry) as geometry
            FROM protected_areas_ocean
        ) TO '{EXPORT_DIR}/protected_areas.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)

    # Export vessel crossings
    print("Exporting vessel crossings...")
    db.execute(f"""
        COPY (
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
        ) TO '{EXPORT_DIR}/vessel_crossings.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)

    # Export vessel lookup for tooltips - original WGS84 coordinates
    print("Exporting vessel lookup (tooltips)...")
    db.execute(f"""
        COPY (
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
        ) TO '{EXPORT_DIR}/vessel_lookup.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
    """)

    # Export places
    print("Exporting places...")
    db.execute(f"""
        COPY (
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
        ) TO '{EXPORT_DIR}/places.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)

    db.close()

    # Report stats for each file
    print("\nExport complete:")
    conn = duckdb.connect()
    total_size = 0
    for parquet_file in EXPORT_DIR.glob("*.parquet"):
        row_count = conn.execute(f"SELECT COUNT(*) FROM read_parquet('{parquet_file}')").fetchone()[0]
        file_size = parquet_file.stat().st_size / 1024 / 1024
        total_size += file_size
        print(f"  {parquet_file.name}: {row_count:,} rows ({file_size:.1f} MB)")
    conn.close()

    print(f"\nTotal export size: {total_size:.1f} MB")
    print(f"Export directory: {EXPORT_DIR}")


if __name__ == "__main__":
    main()
