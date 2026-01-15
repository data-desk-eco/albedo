# Albedo

- Always use yarn for managing JS dependencies

Generic vessel activity viewer. Template-driven configuration for different regions.

## Architecture

Fully static, client-side architecture. Zero server compute - all rendering happens in browser.

```
Cloud Storage (~100 MB)
├── index.html + JS/CSS           ~2 MB    (Vite build)
├── vessel_heatmap.tif            ~18 MB   (COG: 3 year bands + land mask)
├── vessel_heatmap_*.tif          ~15 MB each (per-type COGs: fishing, cargo, etc.)
├── vectors.pmtiles               ~1 MB    (protected areas, places)
└── vessel_data.bin               ~55 MB   (Hilbert-indexed vessel tooltips)

Browser
├── geotiff.js          → reads COG via range requests, renders raster tiles
├── pmtiles             → reads vectors.pmtiles via range requests
├── vessel-tiles.js     → queries vessel_data.bin via HTTP range requests
└── MapLibre GL         → composites all layers
```

## Setup

```bash
make install   # Install Python + JS dependencies
make fetch     # Fetch GFW data + protected areas + basemaps
make convert   # Convert JSON → Parquet
make transform # Run SQL transformations → data/data.duckdb
make tiles     # Generate COG heatmaps (all + per-type)
make export    # Export PMTiles + manifest for client
make dev       # Start dev server at http://localhost:5173
```

## Configuration

All region-specific config is in `.env`:

```bash
# Data hosting (leave empty for local files)
COG_BASE_URL=https://storage.googleapis.com/albedo-data/

# Region bounds
SOUTH_LAT=57
NORTH_LAT=90
WEST_LON=20
EAST_LON=-160

# Initial view
CENTER_LON=100
CENTER_LAT=75
INITIAL_ZOOM=2.5

# Vessel types for per-type COGs
VESSEL_TYPES=FISHING,CARGO,PASSENGER,CARRIER

# UI
UI_TITLE=Albedo
DEFAULT_LANG=ru
```

The manifest is generated from `manifest.template.json` using `scripts/export_manifest.sh`.

## Data pipeline

1. **Fetch**: GFW 4Wings API → `data/gfw/*.json` (monthly)
2. **Convert**: JSON → Parquet with DuckDB
3. **Transform**: `etl/transform.sql` → `data/data.duckdb` (2.6GB)
4. **Tiles**: Export COGs with land mask (`scripts/export_raster.sh`)
5. **Export**: PMTiles + manifest (`scripts/export_pmtiles.sh`, `scripts/export_manifest.sh`)

## Database (data/data.duckdb)

- `vessel_positions` — 25M positions, 2023-2025, 0.01° grid
- `vessel_activity` — 79K vessels, aggregated stats
- `protected_areas_ocean` — Ocean-only protected areas
- `vessel_crossings` — Vessels crossing protected areas

## Client-side data

Exported to `data/export/`:
- `manifest.json` — Generated config (map bounds, COG URLs, UI settings)
- `vectors.pmtiles` — Protected areas and places (PMTiles format)
- `vessel_data.bin` — Hilbert-curve indexed vessel data for tooltips

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
- pmtiles for vector tile loading
- Globe projection with raster heatmap visualization

## Structure

```
.
├── index.html              # HTML entry point
├── manifest.template.json  # Manifest template with ${VAR} placeholders
├── .env                    # Region configuration
├── src/
│   ├── main.js             # App logic + map
│   ├── config.js           # Map style and constants
│   ├── cog-tiles.js        # COG tile renderer (EPSG:4326 → Web Mercator)
│   ├── vessel-tiles.js     # Hilbert-indexed vessel data queries
│   ├── data-layer.js       # PMTiles protocol + vessel tooltip queries
│   ├── i18n.js             # Internationalization
│   └── style.css           # Styles
├── scripts/
│   ├── export_raster.sh    # Generate COGs with land mask
│   ├── export_pmtiles.sh   # Generate PMTiles from DuckDB
│   ├── export_manifest.sh  # Generate manifest.json from template
│   └── export_tiles.py     # Export vessel_data.bin
├── etl/
│   └── transform.sql       # SQL transformations
└── data/                   # Generated data (gitignored)
    ├── gfw/                # Raw GFW API responses
    ├── data.duckdb         # Transformed data (2.6GB)
    └── export/             # Client files (manifest, PMTiles, etc.)
```

## Sources

- **Vessels**: [GFW 4Wings API](https://globalfishingwatch.org/our-apis/documentation)
- **Protected areas**: Russian Ministry WFS

## Stack

- **Data**: DuckDB + plain SQL
- **Tiles**: GDAL (COG generation), tippecanoe (PMTiles)
- **Frontend**: Vite + MapLibre GL JS + geotiff.js + pmtiles
- **Hosting**: Google Cloud Storage (static files)
