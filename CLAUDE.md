# Albedo

Template-driven vessel activity viewer. Fully static, client-side architecture.

## Quick Start

```bash
make install   # Install dependencies
make dev       # Dev server at localhost:5173
```

## Data Pipeline

```bash
make fetch     # GFW API → data/gfw/*.json
make convert   # JSON → Parquet
make transform # SQL → data/data.duckdb
make tiles     # Export COG heatmaps
make export    # PMTiles + manifest
```

## Configuration

Region config in `.env`:

```bash
COG_BASE_URL=https://storage.googleapis.com/albedo-data/
SOUTH_LAT=57
NORTH_LAT=90
WEST_LON=20
EAST_LON=-160
CENTER_LON=100
CENTER_LAT=75
INITIAL_ZOOM=2.5
```

Manifest generated from `manifest.template.json` via `scripts/export_manifest.sh`.

## Architecture

```
GCS                              Browser
├── vessel_heatmap.tif (COG)     geotiff.js → raster tiles
├── vectors.pmtiles              pmtiles → vector layers
├── vessel_data.bin              vessel-tiles.js → tooltips
├── manifest.json                config + layer definitions
└── index.html + JS              MapLibre GL → composites
```

## Key Files

- `src/config.js` — Map style generation, layer configuration
- `src/main.js` — App initialization, UI handlers
- `src/cog-tiles.js` — COG tile renderer with EPSG:4326→Web Mercator reprojection
- `scripts/export_pmtiles.sh` — PMTiles generation (clips to SOUTH_LAT)
