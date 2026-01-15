# Albedo

- Always use yarn for managing JS dependencies

Map of shipping activity along Russia's Northern Sea Route. Consultancy project for Arctida.

## Architecture

Fully static, client-side architecture. Zero server compute - all rendering happens in browser.

```
Cloud Storage (~100 MB)
├── index.html + JS/CSS           ~2 MB    (Vite build)
├── vessel_heatmap.tif            ~18 MB   (COG: 3 vessel bands + land mask)
├── vectors.sqlite                ~1 MB    (protected areas, crossings, places)
└── vessel_data.bin               ~55 MB   (Hilbert-indexed vessel tooltips)

Browser
├── geotiff.js          → reads COG via range requests, renders raster tiles
├── sql.js-httpvfs      → queries vectors.sqlite via HTTP range requests
├── vessel-tiles.js     → queries vessel_data.bin via HTTP range requests
└── MapLibre GL         → composites all layers
```

## Setup

```bash
make install   # Install Python + JS dependencies
make fetch     # Fetch GFW data + protected areas + basemaps
make convert   # Convert JSON → Parquet
make transform # Run SQL transformations → data/data.duckdb
make tiles     # Generate COG heatmap with land mask
make export    # Export SQLite files for client
make dev       # Start dev server at http://localhost:5173
```

Configuration in `.env` — edit date ranges, study area, tile version, etc.

## Data pipeline

1. **Fetch**: GFW 4Wings API → `data/gfw/*.json` (monthly)
2. **Convert**: JSON → Parquet with DuckDB
3. **Transform**: `etl/transform.sql` → `data/data.duckdb` (2.6GB)
4. **Tiles**: Export COG with land mask (`data/vessel_heatmap.tif`)
5. **Export**: SQLite files for client (`data/export/*.sqlite`)

## Database (data/data.duckdb)

- `vessel_positions` — 25M positions, 2023-2025, 0.01° grid
- `vessel_activity` — 79K vessels, aggregated stats
- `protected_areas_ocean` — Ocean-only protected areas
- `vessel_crossings` — Vessels crossing protected areas

## Client-side data

Exported to `data/export/`:
- `vectors.sqlite` — Protected areas, vessel crossings, and places (small, loaded at startup)
- `vessel_data.bin` — Hilbert-curve indexed vessel data for tooltips (HTTP range requests)

### Grid coordinate convention

**IMPORTANT:** The 0.01° grid uses pixel-is-area convention where cells are identified by their lower-left corner.

- Cell "72.51" covers the area [72.51, 72.52)
- Use `floor()` to map coordinates to cells: `floor(72.517 * 100) / 100 = 72.51`
- **DO NOT use `round()`** — it would split cells at x.xx5, causing mismatch between rendered pixels and tooltip queries

This convention is used consistently in:
- `cog-tiles.js` — COG raster renderer (per-pixel sampling)
- `vessel-tiles.js` — Tooltip data queries
- `export_tiles.py` — Binary data export

## Frontend

Vite-based build with:
- MapLibre GL JS for rendering
- geotiff.js for client-side COG tile rendering
- sql.js-httpvfs for client-side SQLite queries via HTTP range requests
- Globe projection with raster heatmap visualization
- Arctic-focused navigation (pitch + zoom limits, latitude constraint)

## Structure

```
.
├── index.html              # HTML entry point
├── src/
│   ├── main.js             # App logic + map
│   ├── config.js           # Map style and constants
│   ├── cog-tiles.js        # COG tile renderer (EPSG:4326 → Web Mercator)
│   ├── vessel-tiles.js     # Hilbert-indexed vessel data queries
│   ├── data-layer.js       # sql.js-httpvfs queries (vectors)
│   ├── i18n.js             # Internationalization
│   └── style.css           # Styles
├── vite.config.js          # Vite configuration
├── package.json            # Frontend dependencies
├── Makefile                # Pipeline orchestration
├── scripts/                # Data fetching & processing
│   ├── export_raster.sh    # Generate COG with land mask
│   └── export_sqlite.py    # Export SQLite for client
├── etl/
│   └── transform.sql       # SQL transformations (replaces dbt)
└── data/                   # Generated data (gitignored)
    ├── gfw/                # Raw GFW API responses
    ├── data.duckdb         # Transformed data (2.6GB)
    ├── vessel_heatmap.tif  # COG raster heatmap with land mask
    └── export/             # SQLite files for client
```

## Sources

- **Vessels**: [GFW 4Wings API](https://globalfishingwatch.org/our-apis/documentation)
- **Protected areas**: Russian Ministry WFS

## Stack

- **Data**: DuckDB + plain SQL
- **Tiles**: GDAL (COG generation)
- **Frontend**: Vite + MapLibre GL JS + geotiff.js + sql.js-httpvfs
- **Hosting**: Google Cloud Storage (static files)
