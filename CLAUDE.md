# Albedo

Map of shipping activity along Russia's Northern Sea Route. Consultancy project for Arctida.

## Architecture

Fully static, client-side architecture. Zero server compute - all rendering happens in browser.

```
Cloud Storage (~100 MB)
├── index.html + JS/CSS           ~2 MB    (Vite build)
├── vessel_heatmap.tif            ~18 MB   (COG: 3 vessel bands + land mask)
└── data/export/*.parquet         ~80 MB   (vectors + tooltips)

Browser
├── geotiff.js          → reads COG via range requests, renders raster tiles
├── DuckDB-WASM         → queries Parquet for vectors + tooltips
└── MapLibre GL         → composites all layers
```

## Setup

```bash
make install   # Install Python + JS dependencies
make fetch     # Fetch GFW data + protected areas + basemaps
make convert   # Convert JSON → Parquet
make transform # Run SQL transformations → data/data.duckdb
make tiles     # Generate COG heatmap with land mask
make export    # Export Parquet files for client
make dev       # Start dev server at http://localhost:5173
```

Configuration in `.env` — edit date ranges, study area, tile version, etc.

## Data pipeline

1. **Fetch**: GFW 4Wings API → `data/gfw/*.json` (monthly)
2. **Convert**: JSON → Parquet with DuckDB
3. **Transform**: `etl/transform.sql` → `data/data.duckdb` (2.6GB)
4. **Tiles**: Export COG with land mask (`data/vessel_heatmap.tif`)
5. **Export**: Parquet files for client (`data/export/*.parquet`)

## Database (data/data.duckdb)

- `vessel_positions` — 25M positions, 2023-2025, 0.01° grid
- `vessel_activity` — 79K vessels, aggregated stats
- `protected_areas_ocean` — Ocean-only protected areas
- `vessel_crossings` — Vessels crossing protected areas

## Client-side data

Exported to `data/export/`:
- `protected_areas.parquet` — Protected area polygons as GeoJSON
- `vessel_crossings.parquet` — Vessel crossing points
- `vessel_lookup.parquet` — Pre-aggregated vessel data for tooltips (sorted for fast queries)
- `places.parquet` — Place names

## Frontend

Vite-based build with:
- MapLibre GL JS for rendering
- geotiff.js for client-side COG tile rendering
- DuckDB-WASM for client-side data queries
- Globe projection with raster heatmap visualization
- Arctic-focused navigation (pitch + zoom limits, latitude constraint)

## Structure

```
.
├── index.html              # HTML entry point
├── src/
│   ├── main.js             # App logic + map
│   ├── config.js           # Map style and constants
│   ├── cog-tiles.js        # Client-side COG tile renderer
│   ├── data-layer.js       # DuckDB-WASM queries
│   ├── i18n.js             # Internationalization
│   └── style.css           # Styles
├── vite.config.js          # Vite configuration
├── package.json            # Frontend dependencies
├── Makefile                # Pipeline orchestration
├── scripts/                # Data fetching & processing
│   ├── export_raster.sh    # Generate COG with land mask
│   └── export_parquet.py   # Export Parquet for client
├── etl/
│   └── transform.sql       # SQL transformations (replaces dbt)
└── data/                   # Generated data (gitignored)
    ├── gfw/                # Raw GFW API responses
    ├── data.duckdb         # Transformed data (2.6GB)
    ├── vessel_heatmap.tif  # COG raster heatmap with land mask
    └── export/             # Parquet files for client
```

## Sources

- **Vessels**: [GFW 4Wings API](https://globalfishingwatch.org/our-apis/documentation)
- **Protected areas**: Russian Ministry WFS

## Stack

- **Data**: DuckDB + plain SQL
- **Tiles**: GDAL (COG generation)
- **Frontend**: Vite + MapLibre GL JS + geotiff.js + DuckDB-WASM
- **Hosting**: Google Cloud Storage (static files)
