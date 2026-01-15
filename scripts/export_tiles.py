#!/usr/bin/env python3
"""Export vessel data as Hilbert-curve ordered, block-compressed single file.

Generates:
  - vessel_data.bin: Single file with header, block index, lookup tables, and compressed blocks

Format (v2):
  Header (16 bytes):
    magic: 4 bytes ("VSSL")
    version: u16
    block_count: u16
    cell_count: u32
    lookup_offset: u32

  Block Index (block_count × 16 bytes):
    hilbert_start: u32
    hilbert_end: u32
    offset: u32
    compressed_len: u32

  Lookup Tables (~1.9MB):
    [flags: count + (len, string)[]]
    [vessel_types: count + (len, string)[]]
    [vessels: count + (mmsi, name_len, name)[]]

  Blocks (independently gzip-compressed):
    [block 0: ~1000 cells sorted by hilbert index]
    ...
"""
import gzip
import struct
from collections import defaultdict
from pathlib import Path

import duckdb

DATA_ROOT = Path(__file__).parent.parent / "data"
OUTPUT_FILE = DATA_ROOT / "export" / "vessel_data.bin"

# Block size: number of cells per block
BLOCK_SIZE = 1000

# Hilbert curve order (16 allows for coordinates up to 65535)
HILBERT_ORDER = 16


def xy_to_hilbert(x: int, y: int, order: int = HILBERT_ORDER) -> int:
    """Convert 2D coordinates to Hilbert curve index.

    Uses standard algorithm: rotate and flip quadrants.
    Order n maps a 2^n x 2^n grid to a 1D index.
    """
    d = 0
    s = 1 << (order - 1)  # Start at 2^(order-1)
    while s > 0:
        rx = 1 if (x & s) > 0 else 0
        ry = 1 if (y & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        # Rotate
        if ry == 0:
            if rx == 1:
                x = s - 1 - x
                y = s - 1 - y
            x, y = y, x
        s >>= 1
    return d


def lat_lon_to_grid(lat: float, lon: float) -> tuple[int, int]:
    """Convert lat/lon to grid coordinates for Hilbert curve.

    lat: -90 to 90 -> 0 to 18000
    lon: -180 to 180 -> 0 to 36000
    """
    lat_grid = int((lat + 90) * 100)
    lon_grid = int((lon + 180) * 100)
    return lat_grid, lon_grid


def write_lookup_tables(db: duckdb.DuckDBPyConnection) -> tuple[bytes, dict, dict, dict]:
    """Build lookup tables and return as bytes plus ID mappings."""
    buf = bytearray()

    # Flags table
    flags = db.execute(
        "SELECT DISTINCT flag FROM vessel_positions WHERE flag IS NOT NULL ORDER BY flag"
    ).fetchall()
    flag_to_id = {f[0]: i for i, f in enumerate(flags)}
    buf.extend(struct.pack("<H", len(flags)))
    for (flag,) in flags:
        encoded = flag.encode("utf-8")
        buf.append(len(encoded))
        buf.extend(encoded)

    # Vessel types table
    types = db.execute(
        "SELECT DISTINCT vessel_type FROM vessel_positions WHERE vessel_type IS NOT NULL ORDER BY vessel_type"
    ).fetchall()
    type_to_id = {t[0]: i for i, t in enumerate(types)}
    buf.extend(struct.pack("<H", len(types)))
    for (vtype,) in types:
        encoded = vtype.encode("utf-8")
        buf.append(len(encoded))
        buf.extend(encoded)

    # Vessels table (mmsi + ship_name)
    vessels = db.execute(
        """
        SELECT DISTINCT mmsi, ship_name
        FROM vessel_positions
        WHERE mmsi IS NOT NULL
        ORDER BY mmsi
    """
    ).fetchall()
    vessel_to_id = {v[0]: i for i, v in enumerate(vessels)}
    buf.extend(struct.pack("<I", len(vessels)))
    for mmsi, ship_name in vessels:
        mmsi_bytes = (mmsi or "").encode("utf-8")[:12].ljust(12, b"\x00")
        buf.extend(mmsi_bytes)
        name = (ship_name or "").encode("utf-8")[:255]
        buf.append(len(name))
        buf.extend(name)

    print(
        f"  Lookup: {len(flags)} flags, {len(types)} types, {len(vessels)} vessels ({len(buf) / 1024:.1f} KB)"
    )

    return bytes(buf), flag_to_id, type_to_id, vessel_to_id


def build_cells(
    db: duckdb.DuckDBPyConnection,
    flag_to_id: dict,
    type_to_id: dict,
    vessel_to_id: dict,
) -> list[tuple[int, float, float, int, list]]:
    """Query vessel data and build cell list with Hilbert indices.

    Returns list of (hilbert_index, lat, lon, total_vessels, vessels_data)
    """
    print("  Querying vessel positions...")
    rows = db.execute(
        """
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
    """
    ).fetchall()

    # Group by cell
    cell_data = defaultdict(lambda: {"vessels": [], "total": 0})
    for lat, lon, mmsi, flag, vessel_type, year, total_hours, cell_count in rows:
        key = (lat, lon)
        cell_data[key]["total"] = cell_count
        cell_data[key]["vessels"].append(
            (
                vessel_to_id.get(mmsi, 0),
                flag_to_id.get(flag, 255),
                type_to_id.get(vessel_type, 255),
                max(0, min(255, (year or 2020) - 2020)),
                min(65535, total_hours or 0),
            )
        )

    # Build cells with Hilbert indices
    cells = []
    for (lat, lon), data in cell_data.items():
        lat_grid, lon_grid = lat_lon_to_grid(lat, lon)
        hilbert = xy_to_hilbert(lat_grid, lon_grid)
        cells.append((hilbert, lat, lon, data["total"], data["vessels"]))

    # Sort by Hilbert index
    cells.sort(key=lambda x: x[0])
    print(f"  Built {len(cells)} cells")
    return cells


def encode_block(cells: list[tuple[int, float, float, int, list]]) -> bytes:
    """Encode a block of cells to binary format."""
    buf = bytearray()
    buf.extend(struct.pack("<H", len(cells)))

    for _hilbert, lat, lon, total_vessels, vessels in cells:
        # lat/lon as i16 (multiply by 100)
        buf.extend(struct.pack("<hh", int(round(lat * 100)), int(round(lon * 100))))
        # total_vessels and vessel_count
        buf.extend(struct.pack("<HB", total_vessels, len(vessels)))

        for vessel_id, flag_id, type_id, year_offset, hours in vessels:
            # Pack: vessel_id (3 bytes LE), flag_id, type_id, year, hours
            buf.extend(struct.pack("<I", vessel_id)[:3])  # 3 bytes of u32
            buf.extend(struct.pack("<BBBH", flag_id, type_id, year_offset, hours))

    return bytes(buf)


def main():
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    db = duckdb.connect(str(DATA_ROOT / "data.duckdb"), read_only=True)

    print("Building lookup tables...")
    lookup_bytes, flag_to_id, type_to_id, vessel_to_id = write_lookup_tables(db)

    print("Building cells...")
    cells = build_cells(db, flag_to_id, type_to_id, vessel_to_id)
    db.close()

    # Group cells into blocks
    blocks = []
    for i in range(0, len(cells), BLOCK_SIZE):
        block_cells = cells[i : i + BLOCK_SIZE]
        blocks.append(block_cells)

    print(f"  Created {len(blocks)} blocks")

    # Compress blocks
    print("Compressing blocks...")
    compressed_blocks = []
    total_uncompressed = 0
    total_compressed = 0

    for block_cells in blocks:
        raw = encode_block(block_cells)
        compressed = gzip.compress(raw, compresslevel=9)
        compressed_blocks.append(
            {
                "hilbert_start": block_cells[0][0],
                "hilbert_end": block_cells[-1][0],
                "data": compressed,
            }
        )
        total_uncompressed += len(raw)
        total_compressed += len(compressed)

    ratio = total_compressed / total_uncompressed * 100
    print(
        f"  Compression: {total_uncompressed / 1024 / 1024:.1f} MB -> {total_compressed / 1024 / 1024:.1f} MB ({ratio:.1f}%)"
    )

    # Build output file
    print("Writing vessel_data.bin...")

    # Calculate offsets
    header_size = 16
    index_size = len(blocks) * 16
    lookup_offset = header_size + index_size
    blocks_offset = lookup_offset + len(lookup_bytes)

    # Build block index
    block_index = bytearray()
    current_offset = blocks_offset
    for block in compressed_blocks:
        block_index.extend(
            struct.pack(
                "<IIII",
                block["hilbert_start"],
                block["hilbert_end"],
                current_offset,
                len(block["data"]),
            )
        )
        current_offset += len(block["data"])

    # Build header
    header = struct.pack(
        "<4sHHII",
        b"VSSL",  # magic
        2,  # version
        len(blocks),  # block_count
        len(cells),  # cell_count
        lookup_offset,  # lookup_offset
    )

    # Write file
    with open(OUTPUT_FILE, "wb") as f:
        f.write(header)
        f.write(block_index)
        f.write(lookup_bytes)
        for block in compressed_blocks:
            f.write(block["data"])

    file_size = OUTPUT_FILE.stat().st_size
    print(f"  Output: {file_size / 1024 / 1024:.1f} MB")
    print(f"  Header + Index: {header_size + index_size} bytes")
    print(f"  Lookup: {len(lookup_bytes) / 1024:.1f} KB")
    print(f"  Blocks: {total_compressed / 1024 / 1024:.1f} MB")
    print("Done.")


if __name__ == "__main__":
    main()
