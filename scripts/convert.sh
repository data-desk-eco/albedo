#!/bin/bash
# Minimal JSON → Parquet conversion using DuckDB CLI

set -e

for month in 01 02 03 04 05 06 07 08 09 10 11 12; do
    json="data/gfw/2025-${month}.json"
    parquet="data/gfw/2025-${month}.parquet"

    [ ! -f "$json" ] && continue
    [ -f "$parquet" ] && [ -s "$parquet" ] && echo "✓ 2025-${month}" && continue

    echo "→ 2025-${month}"

    duckdb :memory: << EOF
SET preserve_insertion_order=false;
COPY (
    SELECT unnest(json_extract(content, '\$.entries[0]."public-global-presence:v3.0"')::JSON[]) AS vessel
    FROM read_text('$json')
) TO '$parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
EOF

    du -h "$parquet" | cut -f1
done

echo "Done"
