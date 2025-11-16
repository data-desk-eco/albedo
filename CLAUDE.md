# Albedo

Map of shipping activity along Russia's Northern Sea Route. Consultancy project for Arctida.

## Setup

```bash
make           # Fetch GFW data + protected areas
make convert   # Convert JSON → Parquet
make transform # Run dbt pipeline → data/data.duckdb
make tiles     # Generate COG heatmap + PMTiles → data/vessel_heatmap.tif (1.3MB) + data/protected_areas.pmtiles (5.3MB)
make serve     # Start tile server at http://localhost:8000
```

**Note**: The tile server (`tile_server.py`) serves the COG (Cloud-Optimized GeoTIFF) as XYZ raster tiles on-the-fly using rio-tiler.

Configuration in `.env` — edit date ranges, study area, etc.

## Data pipeline

1. **Fetch**: GFW 4Wings API → `data/gfw/*.json` (monthly)
2. **Convert**: JSON → Parquet with DuckDB
3. **Transform**: dbt models → `data/data.duckdb` (2.6GB)
4. **Tiles**: Spatial filter → protected areas with vessel activity (5km buffer) → PMTiles (5.3MB)

## Database (data/data.duckdb)

- `vessel_activity` — 79K vessels, aggregated stats
- `vessel_positions` — 16.9M positions, 2024, 0.01° grid

## Frontend

Single `index.html` file with:
- MapLibre GL JS for rendering
- Globe projection with raster heatmap visualization
- PMTiles for protected areas (vector tiles)
- Inline CSS/JS, no build step
- Python tile server (`tile_server.py`) serves COG as XYZ tiles using rio-tiler
- Arctic-focused navigation (pitch + zoom limits, latitude constraint on moveend)

## Structure

```
.
├── index.html              # Web map interface
├── tile_server.py          # Tile server for COG + static files
├── Makefile                # Pipeline orchestration
├── scripts/                # Data fetching & processing scripts
├── etl/                    # dbt models & configuration
└── data/                   # Generated data (gitignored)
    ├── gfw/                # Raw GFW API responses
    ├── data.duckdb         # Transformed data (2.6GB)
    ├── vessel_heatmap.tif  # COG raster heatmap (1.3MB)
    └── protected_areas.pmtiles  # Vector tiles (5.3MB, 391 areas with vessel activity)
```

## Sources

- **Vessels**: [GFW 4Wings API](https://globalfishingwatch.org/our-apis/documentation)
- **Protected areas**: Russian Ministry WFS

## Stack

- **Data**: DuckDB + dbt
- **Tiles**: GDAL (COG generation) + tippecanoe (vector tiles)
- **Server**: Flask + rio-tiler (serves COG as XYZ tiles)
- **Frontend**: MapLibre GL JS + PMTiles
