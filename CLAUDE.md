# Albedo

Map of shipping activity along Russia's Northern Sea Route. Consultancy project for Arctida.

## Setup

```bash
make install   # Install Python + JS dependencies
make fetch     # Fetch GFW data + protected areas + basemaps
make convert   # Convert JSON → Parquet
make transform # Run dbt pipeline → data/data.duckdb
make tiles     # Generate COG heatmap + PMTiles
make dev       # Start dev server at http://localhost:5173
```

Configuration in `.env` — edit date ranges, study area, tile version, etc.

## Data pipeline

1. **Fetch**: GFW 4Wings API → `data/gfw/*.json` (monthly)
2. **Convert**: JSON → Parquet with DuckDB
3. **Transform**: dbt models → `data/data.duckdb` (2.6GB)
4. **Tiles**: Spatial filter → protected areas with vessel activity (5km buffer) → PMTiles (5.3MB)

## Database (data/data.duckdb)

- `vessel_activity` — 79K vessels, aggregated stats
- `vessel_positions` — 25M positions, 2023-2025, 0.01° grid

## Vessel Lookup Database (production tooltips)

The full database (2.6GB) is too large for the container. A smaller lookup database (`vessel_lookup.duckdb`, ~130MB) is used in production for the `/api/vessels` tooltip endpoint.

The lookup DB is stored as a GitHub release asset and downloaded during container build.

**To update after changing vessel data:**
```bash
make lookup         # Create vessel_lookup.duckdb from data.duckdb
make upload-lookup  # Upload to GitHub release (replaces existing)
```

Then trigger a container rebuild (push to main or manual deploy).

## Frontend

Vite-based build with:
- MapLibre GL JS for rendering
- Globe projection with raster heatmap visualization
- PMTiles for protected areas (vector tiles)
- Python tile server (`scripts/tile_server.py`) serves COG as XYZ tiles using rio-tiler
- Arctic-focused navigation (pitch + zoom limits, latitude constraint on moveend)

## Structure

```
.
├── index.html              # HTML entry point
├── src/
│   ├── main.js             # App logic + map
│   └── style.css           # Styles
├── vite.config.js          # Vite configuration
├── package.json            # Frontend dependencies
├── Makefile                # Pipeline orchestration
├── scripts/                # Data fetching & processing
│   └── tile_server.py      # Tile server for COG + static files
├── etl/                    # dbt models & configuration
└── data/                   # Generated data (gitignored)
    ├── gfw/                # Raw GFW API responses
    ├── data.duckdb         # Transformed data (2.6GB)
    ├── vessel_heatmap.tif  # COG raster heatmap
    └── *.pmtiles           # Vector tiles
```

## Sources

- **Vessels**: [GFW 4Wings API](https://globalfishingwatch.org/our-apis/documentation)
- **Protected areas**: Russian Ministry WFS

## Stack

- **Data**: DuckDB + dbt
- **Tiles**: GDAL (COG generation) + tippecanoe (vector tiles)
- **Server**: FastAPI + rio-tiler (serves COG as XYZ tiles)
- **Frontend**: Vite + MapLibre GL JS + PMTiles
