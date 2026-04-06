# Albedo — Technical Guide for the Arctida Team

This document covers everything needed to maintain, update, and extend Albedo:
the interactive vessel activity viewer for Russia's Arctic waters.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Quick Start](#quick-start)
4. [Architecture](#architecture)
5. [Data Pipeline](#data-pipeline)
6. [Frontend Application](#frontend-application)
7. [Configuration](#configuration)
8. [Updating Data](#updating-data)
9. [Deployment](#deployment)
10. [Extending the Application](#extending-the-application)
11. [Troubleshooting](#troubleshooting)

---

## Overview

Albedo is a **fully static, client-side** web application. There is no backend
server — all data processing happens either at build time (Python/SQL pipeline)
or in the browser (JavaScript + Web Workers). The app loads pre-built data files
(COG rasters, PMTiles vectors, binary tile data) from a static hosting service
(Google Cloud Storage) and renders everything using MapLibre GL.

**Key properties:**
- Zero server-side compute at runtime
- All vessel data comes from [Global Fishing Watch](https://globalfishingwatch.org/)
- Sanctions data comes from [OpenSanctions](https://opensanctions.org/)
- Vessel metadata (build year, DWT) comes from LSEG Excel exports
- Sea ice extent comes from [NSIDC](https://nsidc.org/)
- Hosting requires only static file serving with HTTP Range request support

---

## Prerequisites

### System Dependencies

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | ≥18 | Frontend build (Vite) |
| **Yarn** | ≥1.22 | JS package manager |
| **Python** | ≥3.11 | Data pipeline scripts |
| **uv** | latest | Python project/dependency manager |
| **DuckDB CLI** | ≥1.0 | SQL transformations (`duckdb` command) |
| **tippecanoe** | latest | Vector tile generation (PMTiles) |
| **GDAL** | ≥3.6 | Raster processing (via rasterio) |
| **gcloud CLI** | latest | GCS deployment (optional) |

### API Keys

- **GFW_API_TOKEN**: Register at https://globalfishingwatch.org/ to get an API
  token for vessel presence data.

### Install Everything

```bash
git clone <repo-url> && cd albedo
cp .env.example .env
# Edit .env with your GFW_API_TOKEN and region settings
make install   # Installs both JS (yarn) and Python (uv) dependencies
```

---

## Quick Start

```bash
make install        # Install dependencies
make dev            # Start dev server at localhost:5173
```

To run the full pipeline from scratch (requires API token and source data):

```bash
make fetch          # Download vessel presence data from GFW API
make convert        # Convert JSON → Parquet
make transform      # SQL transformations → DuckDB
make tankers        # Ingest LSEG tanker metadata (needs data/lseg/*.xlsx)
make tiles          # Generate COG heatmap rasters
make sanctions      # Fetch OpenSanctions data
make export         # Generate PMTiles, manifest, binary vessel data, i18n
make analysis       # Generate Excel analysis of vessels in protected areas
make build          # Production build
```

---

## Architecture

### System Diagram

```
                      BUILD TIME                              RUNTIME (Browser)
                 ┌─────────────────┐                    ┌──────────────────────┐
  GFW API ──────▸│                 │                    │                      │
                 │  Python/SQL     │    Static Files    │  MapLibre GL         │
  LSEG XLSX ───▸│  Pipeline       │──────────────────▸│  + Web Worker        │
                 │                 │                    │  + geotiff.js        │
  OpenSanctions ▸│  (DuckDB,       │    *.tif (COGs)   │  + pmtiles           │
                 │   rasterio,     │    *.pmtiles       │                      │
  NSIDC ────────▸│   tippecanoe)   │    *.bin           │  All rendering is    │
                 │                 │    *.json          │  client-side         │
                 └─────────────────┘                    └──────────────────────┘
                                          │
                                     GCS / S3 / Nginx
                                     (static hosting)
```

### File Roles

| File | Role |
|------|------|
| `src/main.js` | App init, UI state, tooltips, map handlers |
| `src/cog.js` | COG tile orchestration (main thread side) |
| `src/cog-worker.js` | Web Worker: colorization, reprojection, PNG encoding |
| `src/config.js` | Colour palette, MapLibre style builder |
| `src/data.js` | PMTiles protocol, vessel binary data queries |
| `src/vessel-tiles.js` | Hilbert-indexed binary tile parser |
| `src/geo.js` | Coordinate math (Mercator, grid snapping) |
| `src/i18n.js` | Multi-language support |
| `src/style.css` | Dark/light themes, responsive layout |

### Data Flow

1. **COG heatmaps** (`vessel_heatmap*.tif`): Multi-band GeoTIFFs with one band
   per year, plus special bands for land mask, ice, sanctions overlay, and old
   tanker overlay. Decoded by `geotiff.js`, colourised in a Web Worker, returned
   as PNG tiles to MapLibre.

2. **Vector tiles** (`vectors.pmtiles`): Protected areas, buffer zones, and
   place labels. Served via PMTiles protocol (HTTP Range requests, no tile
   server needed).

3. **Binary vessel data** (`vessel_data.bin`): Hilbert-curve indexed blocks of
   vessel entries. Queried at zoom ≥ 8 for tooltip display. Each cell stores up
   to 5 vessels with name, MMSI, flag, type, hours, and a year bitmask.

4. **JSON files**: `manifest.json` (runtime config), `sanctioned_mmsi.json`
   (sanctions list), `vessel_metadata.json` (build year, DWT from LSEG),
   `i18n/*.json` (translations).

---

## Data Pipeline

### Pipeline Stages

```
fetch → convert → transform → tiles + export + sanctions + tankers + analysis
```

#### 1. Fetch (`make fetch`)

Downloads monthly vessel presence data from the GFW API for each year and grid
cell in the study area. Output: `data/gfw/YYYY/*.json`.

Also fetches: protected areas (GeoJSON), buffer zones, land polygons, place
names, sea ice extent (shapefiles from NSIDC).

#### 2. Convert (`make convert`)

Converts GFW JSON to Parquet format for efficient SQL processing.
Output: `data/gfw/YYYY/*.parquet`.

#### 3. Transform (`make transform`)

Runs `etl/transform.sql` in DuckDB to create:
- `vessel_positions`: Gridded position data (snapped to 0.01°)
- `vessel_activity`: Per-vessel aggregated stats
- `protected_areas_ocean`: Coastal protected areas
- `buffer_zones_coastal`: Coastal buffer zones

Output: `data/data.duckdb`.

#### 4. Tiles (`make tiles`)

Generates Cloud-Optimized GeoTIFFs (COGs) from vessel positions:
- Main aggregate heatmap with year bands + sanctions/tanker overlay bands
- Per-flag COGs for the flag filter dropdown
- Land mask, ice extent, and special overlay bands embedded in the COG

Output: `data/vessel_heatmap*.tif`.

#### 5. Export (`make export`)

Generates client-side data files:
- `manifest.json` from `manifest.template.json` + `.env` variables
- `vectors.pmtiles` from DuckDB tables via tippecanoe
- `vessel_data.bin` (Hilbert-indexed binary tiles)
- `i18n/*.json` translation files

Output: `data/export/`.

#### 6. Sanctions (`make sanctions`)

Fetches the OpenSanctions bulk CSV, filters for `Vessel` entities with MMSI
identifiers, cross-references with the local database, and outputs
`sanctioned_mmsi.json` and `sanctions_details.json`.

#### 7. Tankers (`make tankers`)

Ingests LSEG vessel search Excel exports from `data/lseg/*.xlsx`. Joins with
GFW data via IMO numbers to produce `vessel_metadata.json` with build year,
DWT, and oil tanker flags.

#### 8. Analysis (`make analysis`)

Generates an Excel spreadsheet (`vessels_in_protected_areas.xlsx`) by
spatial-joining vessel positions with protected area polygons. The spreadsheet
includes vessel details, sanctions status, metadata enrichment, and a summary
tab. This file is linked from the about modal for download.

---

## Frontend Application

### Tile Rendering Pipeline

COG rendering is split across threads for performance:

```
Main Thread (cog.js)              Worker Thread (cog-worker.js)
────────────────────              ──────────────────────────────
MapLibre requests tile
  ↓
geotiff.js decodes COG bands
  ↓
Raw raster arrays ──transfer──▸  Mercator reprojection
                                  Year-based colourization
                                  Overlay compositing (sanctions/tankers)
                                  OffscreenCanvas → PNG encode
                   ◂──transfer── ArrayBuffer (PNG)
  ↓
Return to MapLibre for display
```

Band data is transferred zero-copy via `Transferable` objects.

### Tooltip System

Vessel tooltips are powered by Hilbert-indexed binary tiles (`vessel_data.bin`).
At zoom ≥ 8, the app queries the binary data at the cursor position:

1. Convert lat/lon to Hilbert curve index
2. Binary search the block index to find the right block
3. HTTP Range request to fetch just that block
4. Decompress, find matching cell, return vessel list
5. Display in tooltip with metadata enrichment

**Click-to-pin**: Clicking pins the tooltip in place. It stays until the next
click. Hover tooltips are suppressed while a tooltip is pinned.

### Theme System

The app supports dark and light modes, toggled via a button. Theme state is
persisted in localStorage. Light mode updates:
- CSS variables (background, text, panel colours)
- MapLibre layer properties (background, south mask, place labels)

### Overlays

- **Sanctions** (red): Dedicated COG bands show sanctioned vessel positions.
  Toggle highlights these on the heatmap. Tooltip badges mark sanctioned vessels.
- **Old tankers** (yellow): COG bands for tankers ≥ 15 years old (all tanker
  types, not just oil). Age determined from LSEG build year metadata.

Both overlays work with all filter combinations (year, flag, vessel type).

---

## Configuration

### Environment Variables (`.env`)

| Variable | Description |
|----------|-------------|
| `GFW_API_TOKEN` | Global Fishing Watch API token |
| `REGION_ID` | Unique identifier for this deployment |
| `SOUTH_LAT` / `NORTH_LAT` / `WEST_LON` / `EAST_LON` | Study area bounds |
| `CENTER_LON` / `CENTER_LAT` / `INITIAL_ZOOM` | Initial map view |
| `YEARS` | Comma-separated years to include (e.g., `2023,2024,2025`) |
| `VESSEL_TYPES` | Vessel types for per-type COG generation |
| `FLAG_PRESETS` | Flag filter options in the dropdown |
| `HOME_FLAG` | Home flag for "foreign" filter logic |
| `UI_TITLE` | Page title |
| `DEFAULT_LANG` | Default language (`en` or `ru`) |
| `COG_BASE_URL` | Base URL for data files (empty = relative paths) |

### Manifest

`manifest.template.json` is the template that gets `${VAR}` substitution from
`.env` values. The generated `manifest.json` controls everything at runtime:
map bounds, data file URLs, layer toggles, theme, places, flag presets, etc.

---

## Updating Data

### Regular Updates

#### Vessel Presence Data (quarterly/annual)

```bash
# Update .env YEARS if adding a new year
make fetch          # Downloads new data
make convert
make transform
make tankers        # Re-run if LSEG data updated
make tiles
make export
make analysis       # Regenerate Excel analysis
make deploy-data    # Push to GCS
```

#### Sanctions Data (weekly recommended)

The simplest approach:

```bash
make update-sanctions              # Local update
make update-sanctions DEPLOY=1     # Update + deploy to GCS
```

For automated weekly updates, add a cron job:

```bash
# Edit crontab: crontab -e
# Run every Sunday at 3 AM:
0 3 * * 0 cd /path/to/albedo && ./scripts/update_sanctions.sh --deploy >> logs/sanctions.log 2>&1
```

The script:
1. Deletes the cached CSV to force a fresh download
2. Runs `fetch_sanctions.py` to download and parse OpenSanctions data
3. With `--deploy`, uploads the result to GCS

No app rebuild needed — the browser fetches the JSON on each page load.

#### Tanker Metadata

When new LSEG Excel files are available:

```bash
# Place new .xlsx files in data/lseg/
make tankers        # Re-ingests all LSEG files
make deploy-data    # Push updated vessel_metadata.json to GCS
```

### Adding a New Year

1. Update `YEARS` in `.env` (e.g., `2023,2024,2025,2026`)
2. Run the full pipeline: `make fetch convert transform tiles export`
3. The COG will have an additional band; the frontend auto-discovers years from
   the COG metadata.

---

## Deployment

### Static Hosting Requirements

The only server requirement is **HTTP Range request** support (RFC 7233). This
is needed for:
- COG tiles (geotiff.js reads specific byte ranges)
- PMTiles (reads tile data by offset)
- Binary vessel data (reads blocks by range)

Most static hosts support this by default: GCS, S3, Cloudflare R2, Nginx, Apache.

### Deploy to GCS

```bash
make deploy-data    # Upload data files to GCS bucket
make deploy-app     # Upload built app to GCS
```

### Self-Contained Package

For offline or third-party hosting:

```bash
./scripts/download_package.sh                # Downloads from GCS → albedo-YYYYMMDD.zip
./scripts/download_package.sh custom.zip     # Custom output filename
```

The zip contains the full app + all data files with relative URLs. Unzip to any
static host.

### GCS Bucket Setup (one-time)

```bash
make setup-gcs      # Creates bucket, sets public access, configures CORS
```

---

## Extending the Application

### Adding a New Overlay Type

1. **Pipeline**: Add bands to the COG in `scripts/export_raster.sh` /
   `scripts/create_raster.py`. Set a band offset in the GDAL metadata.
2. **Worker**: Add overlay compositing logic in `cog-worker.js` (similar to
   `sanctionsTotal` / `oldTankerTotal` pattern).
3. **UI**: Add a legend toggle in `index.html` and wire it up in `main.js`.
4. **Config**: Add `cog.js` state and `sendColorizerConfig()` message fields.

### Adding a New Language

1. Create `data/export/i18n/{lang}.json` (copy `en.json` as template)
2. Add the language code to `AVAILABLE_LANGS` in `.env`
3. Add `_{lang}` property suffixes in PMTiles export for bilingual fields

### Adding Protected Area Data

Place GeoJSON files in `data/` and update `etl/transform.sql` to load them.
The pipeline filters to coastal areas using the ocean mask.

---

## Troubleshooting

### Common Issues

| Problem | Cause | Fix |
|---------|-------|-----|
| Blank map on load | CORS not configured on hosting | Run `make setup-gcs` or configure CORS headers |
| No vessel tooltips | Zoom level < 8 | Zoom in to level 8+ |
| Tooltips show "unknown" | Binary tile data out of sync | Re-run `make export` |
| COG tiles not loading | Range requests not supported | Check server config; test with `curl -r 0-100` |
| Sanctions toggle missing | `sanctioned_mmsi.json` not found | Run `make sanctions` |
| Old tanker toggle missing | `vessel_metadata.json` missing or empty | Run `make tankers` |
| Build fails | Missing system dependencies | Check Prerequisites section above |

### Debugging

Press `p` on the keyboard to toggle the performance overlay, which shows zoom
level, center coordinates, and tile cache size.

### Data Validation

```bash
# Check DuckDB tables
duckdb data/data.duckdb "SELECT * FROM information_schema.tables"
duckdb data/data.duckdb "SELECT COUNT(*) FROM vessel_positions"

# Inspect COG metadata
gdalinfo data/vessel_heatmap.tif

# Check PMTiles
pmtiles show data/export/vectors.pmtiles
```

---

## File Size Reference

Typical data sizes for the Arctic study area:

| File | Size | Description |
|------|------|-------------|
| `vessel_heatmap.tif` | ~50–150 MB | Main aggregate COG |
| `vessel_heatmap_flag_*.tif` | ~10–30 MB each | Per-flag COGs |
| `vectors.pmtiles` | ~5–15 MB | Protected areas + places |
| `vessel_data.bin` | ~20–50 MB | Binary vessel tooltip data |
| `sanctioned_mmsi.json` | <100 KB | Sanctions MMSI list |
| `vessel_metadata.json` | ~1–5 MB | Build year, DWT metadata |
| `data.duckdb` | ~500 MB–1 GB | Full analytical database |

---

## Contact

- **Code & pipeline**: [Data Desk](https://datadesk.eco)
- **Project**: [Arctida](https://arctida.io)
