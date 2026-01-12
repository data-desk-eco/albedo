#!/usr/bin/env python3
"""Create a small vessel lookup database for production tooltips.

This creates a pre-aggregated lookup table with:
- Only cells with >=10h total vessel activity
- Top 5 vessels per cell by hours
- ~2.6M rows (vs 25M in full DB)

Output: data/vessel_lookup.duckdb (~130MB)
"""
import os
import sys
from pathlib import Path

import duckdb

DATA_ROOT = Path(__file__).parent.parent / "data"
SOURCE_DB = DATA_ROOT / "data.duckdb"
OUTPUT_DB = DATA_ROOT / "vessel_lookup.duckdb"
TEMP_PARQUET = DATA_ROOT / "vessel_lookup.parquet"

# Configuration
MIN_CELL_HOURS = 10  # Minimum total hours per cell to include
TOP_N_VESSELS = 5    # Number of top vessels per cell to keep


def main():
    if not SOURCE_DB.exists():
        print(f"Error: Source database not found: {SOURCE_DB}")
        sys.exit(1)

    print(f"Creating vessel lookup from {SOURCE_DB}")
    print(f"  Min cell hours: {MIN_CELL_HOURS}")
    print(f"  Top N vessels: {TOP_N_VESSELS}")

    src = duckdb.connect(str(SOURCE_DB), read_only=True)

    # Export to parquet (intermediate step for efficiency)
    print("Exporting aggregated data...")
    src.execute(f"""
        COPY (
            WITH cell_totals AS (
                SELECT lat, lon
                FROM vessel_positions
                GROUP BY lat, lon
                HAVING SUM(hours) >= {MIN_CELL_HOURS}
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
            WHERE rn <= {TOP_N_VESSELS}
        ) TO '{TEMP_PARQUET}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    src.close()

    parquet_size = TEMP_PARQUET.stat().st_size / 1024 / 1024
    print(f"  Parquet size: {parquet_size:.1f} MB")

    # Create new database from parquet
    print("Creating DuckDB database...")
    if OUTPUT_DB.exists():
        OUTPUT_DB.unlink()

    dst = duckdb.connect(str(OUTPUT_DB))
    dst.execute(f'CREATE TABLE vessel_lookup AS SELECT * FROM read_parquet("{TEMP_PARQUET}")')
    dst.execute('CREATE INDEX idx_lookup_coords ON vessel_lookup(lat, lon)')

    row_count = dst.execute('SELECT COUNT(*) FROM vessel_lookup').fetchone()[0]
    dst.close()

    # Clean up
    TEMP_PARQUET.unlink()

    db_size = OUTPUT_DB.stat().st_size / 1024 / 1024
    print(f"Created {OUTPUT_DB}")
    print(f"  Rows: {row_count:,}")
    print(f"  Size: {db_size:.1f} MB")


if __name__ == "__main__":
    main()
