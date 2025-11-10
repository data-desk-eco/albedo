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

Configuration in `.env` — edit date ranges, study area, etc.

## Data pipeline

1. **Fetch**: GFW 4Wings API → `data/gfw/*.json` (monthly)
2. **Convert**: JSON → Parquet with DuckDB
3. **Transform**: dbt models → `data/data.duckdb` (1.3GB)
4. **Tiles**: DuckDB → PMTiles (50MB) for web display

## Database (data/data.duckdb)

- `vessel_activity` — 79K vessels, aggregated stats
- `vessel_positions` — 16.9M positions, 2024, 0.01° grid

## Frontend

Single `index.html` file with:
- MapLibre GL JS + PMTiles for vector tile rendering
- Globe projection with grayscale circle visualization
- Inline CSS/JS, no build step or dependencies
- Custom Python server (`serve.py`) for Range request support

## Structure

```
.
├── index.html          # Web map interface
├── serve.py            # HTTP server with Range request support
├── Makefile            # Pipeline orchestration
├── scripts/            # Data fetching & processing scripts
├── etl/                # dbt models & configuration
└── data/               # Generated data (gitignored)
    ├── gfw/            # Raw GFW API responses
    ├── data.duckdb     # Transformed data (1.3GB)
    └── tiles.pmtiles   # Vector tiles (50MB)
```

## Sources

- **Vessels**: [GFW 4Wings API](https://globalfishingwatch.org/our-apis/documentation)
- **Protected areas**: Russian Ministry WFS

## Stack

- Bash + DuckDB + dbt + tippecanoe
- MapLibre GL JS + PMTiles
