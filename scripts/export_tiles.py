#!/usr/bin/env python3
"""Export vessel data as binary tiles for efficient client-side lookups.

Generates:
  - tiles/lookup.bin: Flag/type/vessel lookup tables
  - tiles/{lat}_{lon}.bin: Gzipped binary tile per 1° cell
"""
import gzip
import struct
from collections import defaultdict
from pathlib import Path

import duckdb

DATA_ROOT = Path(__file__).parent.parent / "data"
TILES_DIR = DATA_ROOT / "export" / "tiles"


def write_lookup_tables(db: duckdb.DuckDBPyConnection, out_path: Path):
    """Write lookup.bin with flags, vessel_types, and vessels tables."""
    buf = bytearray()

    # Flags table
    flags = db.execute("SELECT DISTINCT flag FROM vessel_positions WHERE flag IS NOT NULL ORDER BY flag").fetchall()
    flag_to_id = {f[0]: i for i, f in enumerate(flags)}
    buf.extend(struct.pack("<H", len(flags)))
    for (flag,) in flags:
        encoded = flag.encode("utf-8")
        buf.append(len(encoded))
        buf.extend(encoded)

    # Vessel types table
    types = db.execute("SELECT DISTINCT vessel_type FROM vessel_positions WHERE vessel_type IS NOT NULL ORDER BY vessel_type").fetchall()
    type_to_id = {t[0]: i for i, t in enumerate(types)}
    buf.extend(struct.pack("<H", len(types)))
    for (vtype,) in types:
        encoded = vtype.encode("utf-8")
        buf.append(len(encoded))
        buf.extend(encoded)

    # Vessels table (mmsi + ship_name)
    vessels = db.execute("""
        SELECT DISTINCT mmsi, ship_name
        FROM vessel_positions
        WHERE mmsi IS NOT NULL
        ORDER BY mmsi
    """).fetchall()
    vessel_to_id = {v[0]: i for i, v in enumerate(vessels)}
    buf.extend(struct.pack("<I", len(vessels)))
    for mmsi, ship_name in vessels:
        mmsi_bytes = (mmsi or "").encode("utf-8")[:12].ljust(12, b"\x00")
        buf.extend(mmsi_bytes)
        name = (ship_name or "").encode("utf-8")[:255]
        buf.append(len(name))
        buf.extend(name)

    out_path.write_bytes(buf)
    print(f"  lookup.bin: {len(flags)} flags, {len(types)} types, {len(vessels)} vessels ({len(buf)/1024:.1f} KB)")

    return flag_to_id, type_to_id, vessel_to_id


def export_tiles(db: duckdb.DuckDBPyConnection, flag_to_id: dict, type_to_id: dict, vessel_to_id: dict):
    """Export one gzipped binary tile per 1° cell."""
    # Query all vessel data grouped by cell
    print("  Querying vessel positions...")
    rows = db.execute("""
        WITH cells AS (
            SELECT lat, lon FROM vessel_positions GROUP BY lat, lon HAVING SUM(hours) >= 1
        ),
        ranked AS (
            SELECT v.lat, v.lon, v.mmsi, v.flag, v.vessel_type, v.year,
                   CAST(SUM(v.hours) AS INTEGER) as total_hours,
                   ROW_NUMBER() OVER (PARTITION BY v.lat, v.lon ORDER BY SUM(v.hours) DESC) as rn,
                   COUNT(*) OVER (PARTITION BY v.lat, v.lon) as cell_count
            FROM vessel_positions v
            JOIN cells c USING (lat, lon)
            GROUP BY v.lat, v.lon, v.mmsi, v.flag, v.vessel_type, v.year
        )
        SELECT lat, lon, mmsi, flag, vessel_type, year, total_hours, cell_count
        FROM ranked WHERE rn <= 5
        ORDER BY lat, lon
    """).fetchall()

    # Group by 1° tile
    tiles = defaultdict(list)
    for lat, lon, mmsi, flag, vessel_type, year, total_hours, cell_count in rows:
        tile_key = (int(lat), int(lon))
        tiles[tile_key].append((lat, lon, mmsi, flag, vessel_type, year, total_hours, cell_count))

    print(f"  Exporting {len(tiles)} tiles...")
    total_size = 0

    for (tile_lat, tile_lon), records in tiles.items():
        # Group by cell within tile
        cells = defaultdict(list)
        cell_counts = {}
        for lat, lon, mmsi, flag, vessel_type, year, total_hours, cell_count in records:
            cell_key = (lat, lon)
            cells[cell_key].append((mmsi, flag, vessel_type, year, total_hours))
            cell_counts[cell_key] = cell_count

        # Write tile binary
        buf = bytearray()
        buf.extend(struct.pack("<H", len(cells)))

        for (lat, lon), vessels in cells.items():
            # lat/lon as i16 (multiply by 100)
            buf.extend(struct.pack("<hh", int(round(lat * 100)), int(round(lon * 100))))
            # cell_count and vessel_count
            buf.extend(struct.pack("<HB", cell_counts[(lat, lon)], len(vessels)))

            for mmsi, flag, vessel_type, year, total_hours in vessels:
                vessel_id = vessel_to_id.get(mmsi, 0)
                flag_id = flag_to_id.get(flag, 255)
                type_id = type_to_id.get(vessel_type, 255)
                year_offset = max(0, min(255, (year or 2020) - 2020))
                hours = min(65535, total_hours or 0)

                # Pack: vessel_id (3 bytes LE), flag_id, type_id, year, hours
                buf.extend(struct.pack("<I", vessel_id)[:3])  # 3 bytes of u32
                buf.extend(struct.pack("<BBBH", flag_id, type_id, year_offset, hours))

        # Gzip and write
        compressed = gzip.compress(bytes(buf), compresslevel=9)
        tile_path = TILES_DIR / f"{tile_lat}_{tile_lon}.bin"
        tile_path.write_bytes(compressed)
        total_size += len(compressed)

    print(f"  Total tiles: {total_size / 1024 / 1024:.1f} MB")


def main():
    TILES_DIR.mkdir(parents=True, exist_ok=True)

    # Clean old tiles
    for f in TILES_DIR.glob("*.bin"):
        f.unlink()

    db = duckdb.connect(str(DATA_ROOT / "data.duckdb"), read_only=True)

    print("Exporting lookup tables...")
    flag_to_id, type_to_id, vessel_to_id = write_lookup_tables(db, TILES_DIR / "lookup.bin")

    print("Exporting tiles...")
    export_tiles(db, flag_to_id, type_to_id, vessel_to_id)

    db.close()
    print("Done.")


if __name__ == "__main__":
    main()
