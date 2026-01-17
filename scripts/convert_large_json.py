#!/usr/bin/env python3
"""Convert large GFW JSON files to Parquet using streaming parsing."""

import sys
from decimal import Decimal
import ijson
import pyarrow as pa
import pyarrow.parquet as pq


def to_float(val):
    """Convert Decimal or other numeric to float."""
    if isinstance(val, Decimal):
        return float(val)
    return float(val) if val is not None else 0.0


def convert_json_to_parquet(json_path: str, parquet_path: str, year: int, batch_size: int = 50000):
    """Stream JSON and write to Parquet in batches.

    Output schema matches DuckDB convert.sh: year (int) + vessel (JSON string)
    """
    import json as json_mod

    schema = pa.schema([
        ("year", pa.int32()),
        ("vessel", pa.string()),  # JSON string to match DuckDB output
    ])

    writer = None
    batch = []
    total = 0

    with open(json_path, "rb") as f:
        # Stream the array at entries.0.public-global-presence:v3.0
        items = ijson.items(f, "entries.item.public-global-presence:v3.0.item")

        for item in items:
            # Convert Decimal values to float for JSON serialization
            vessel_dict = {}
            for k, v in item.items():
                if isinstance(v, Decimal):
                    vessel_dict[k] = float(v)
                else:
                    vessel_dict[k] = v

            row = {
                "year": year,
                "vessel": json_mod.dumps(vessel_dict),  # JSON string
            }
            batch.append(row)

            if len(batch) >= batch_size:
                table = pa.Table.from_pylist(batch, schema=schema)
                if writer is None:
                    writer = pq.ParquetWriter(parquet_path, schema, compression="zstd")
                writer.write_table(table)
                total += len(batch)
                print(f"  {total:,} rows...", flush=True)
                batch = []

    # Write remaining rows
    if batch:
        table = pa.Table.from_pylist(batch, schema=schema)
        if writer is None:
            writer = pq.ParquetWriter(parquet_path, schema, compression="zstd")
        writer.write_table(table)
        total += len(batch)

    if writer:
        writer.close()

    print(f"  Done: {total:,} rows")
    return total


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(f"Usage: {sys.argv[0]} <json_path> <parquet_path> <year>")
        sys.exit(1)

    json_path = sys.argv[1]
    parquet_path = sys.argv[2]
    year = int(sys.argv[3])

    convert_json_to_parquet(json_path, parquet_path, year)
