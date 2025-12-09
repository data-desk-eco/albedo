#!/bin/bash
# JSON → Parquet conversion with year column using DuckDB CLI

set -e

source .env

# Parse YEARS env var
IFS=',' read -ra YEAR_ARRAY <<< "$YEARS"

for year in "${YEAR_ARRAY[@]}"; do
  for month in 01 02 03 04 05 06 07 08 09 10 11 12; do
    json="data/gfw/${year}/${year}-${month}.json"
    parquet="data/gfw/${year}/${year}-${month}.parquet"

    [ ! -f "$json" ] && continue
    [ -f "$parquet" ] && [ -s "$parquet" ] && echo "✓ ${year}-${month}" && continue

    echo "→ ${year}-${month}"

    duckdb :memory: << EOF
SET preserve_insertion_order=false;
COPY (
    SELECT
        ${year} as year,
        unnest(json_extract(content, '\$.entries[0]."public-global-presence:v3.0"')::JSON[]) AS vessel
    FROM read_text('$json')
) TO '$parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
EOF

    du -h "$parquet" | cut -f1
  done
done

echo "Done"
