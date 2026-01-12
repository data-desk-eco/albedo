#!/usr/bin/env python3
"""Create a vessel lookup file for production tooltips.

This creates a pre-aggregated, sorted Parquet file with:
- All cells with >=1h total vessel activity
- Top 5 vessels per cell by hours
- Sorted by (lat, lon) for efficient row group pruning

Output: data/vessel_lookup.parquet (~150MB for full dataset)
"""
import sys
from pathlib import Path

import duckdb

DATA_ROOT = Path(__file__).parent.parent / "data"
SOURCE_DB = DATA_ROOT / "data.duckdb"
OUTPUT_PARQUET = DATA_ROOT / "vessel_lookup.parquet"

# Configuration
MIN_CELL_HOURS = 1   # Minimum total hours per cell to include (1 = all visible pixels)
TOP_N_VESSELS = 5    # Number of top vessels per cell to keep


def main():
    if not SOURCE_DB.exists():
        print(f"Error: Source database not found: {SOURCE_DB}")
        sys.exit(1)

    print(f"Creating vessel lookup from {SOURCE_DB}")
    print(f"  Min cell hours: {MIN_CELL_HOURS}")
    print(f"  Top N vessels: {TOP_N_VESSELS}")

    src = duckdb.connect(str(SOURCE_DB), read_only=True)

    # Export sorted parquet (sorted by lat,lon enables row group pruning for fast queries)
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
            ORDER BY lat, lon
        ) TO '{OUTPUT_PARQUET}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
    """)
    src.close()

    # Report stats
    conn = duckdb.connect()
    row_count = conn.execute(f"SELECT COUNT(*) FROM read_parquet('{OUTPUT_PARQUET}')").fetchone()[0]
    conn.close()

    file_size = OUTPUT_PARQUET.stat().st_size / 1024 / 1024
    print(f"Created {OUTPUT_PARQUET}")
    print(f"  Rows: {row_count:,}")
    print(f"  Size: {file_size:.1f} MB")


if __name__ == "__main__":
    main()
