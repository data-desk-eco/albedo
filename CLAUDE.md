# Northern Sea Route shipping map

Map of shipping activity along Russia's Northern Sea Route. Consultancy project for Arctida.

## Setup

```bash
make           # Fetch GFW data + protected areas
make convert   # Convert JSON → Parquet
make transform # Run dbt pipeline → data/data.duckdb
make tiles     # Generate PMTiles → data/tiles.pmtiles (50MB)
make serve     # Start server at http://localhost:8000
```

**Note**: The server uses a custom Python HTTP handler with Range request support, required for PMTiles byte-serving.

Configuration in `.env` — edit date ranges, study area, etc.

## Data pipeline

1. **Fetch**: GFW 4Wings API → `data/gfw/*.json` (monthly)
2. **Convert**: JSON → Parquet with DuckDB
3. **Transform**: dbt models → `data/data.duckdb` (1.3GB)
4. **Tiles**: DuckDB → PMTiles (50MB) for web display

## Database (data/data.duckdb)

- `vessel_activity` — 79K vessels, aggregated stats
- `vessel_positions` — 16.9M positions, 2024, 0.01° grid

## Sources

- **Vessels**: [GFW 4Wings API](https://globalfishingwatch.org/our-apis/documentation)
- **Protected areas**: Russian Ministry WFS

## Stack

- Bash + DuckDB + dbt + tippecanoe
- MapLibre GL JS + PMTiles for display
