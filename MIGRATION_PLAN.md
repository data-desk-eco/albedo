# Albedo Architecture Migration Plan

## Overview

Migrate from server-rendered tiles to a **fully static, client-side architecture**. The entire application becomes static files on Cloud Storage, with all rendering and queries happening in the browser.

**Current stack:** DuckDB, dbt, rasterio, GDAL, tippecanoe, PMTiles, rio-tiler, Pillow, FastAPI, Cloud Run

**Target stack:** DuckDB (build only), geotiff.js, DuckDB-WASM, MapLibre GL, Google Cloud Storage

**Result:** Zero server compute. Infinite scale. ~$0.50/month hosting.

---

## Architecture

```
Cloud Storage (~100 MB)
├── index.html + JS/CSS           ~2 MB    (Vite build)
├── vessel_heatmap.tif            ~18 MB   (COG: 3 vessel bands + land mask)
└── data.parquet                  ~80 MB   (vectors + tooltips)

Browser
├── geotiff.js          → reads COG via range requests, renders raster tiles
├── DuckDB-WASM         → queries Parquet for vectors + tooltips
└── MapLibre GL         → composites all layers

External
└── Sentinel-2 tiles    → EOX public CDN (satellite imagery option)
```

### Data flow

1. **Raster tiles**: MapLibre requests tile → custom protocol → geotiff.js fetches ~20KB from COG → JS colorizes → returns ImageBitmap
2. **Vector layers**: On load → DuckDB-WASM queries Parquet → returns GeoJSON → MapLibre renders
3. **Tooltips**: On hover → DuckDB-WASM queries Parquet → instant (data cached)
4. **Year filtering**: Instant re-render, no network (COG data already cached)

---

## Phase 1: Create Combined COG with Land Mask

### Goal
Add land as band 4 in the vessel heatmap COG. Single file serves both vessels and land.

### Changes to `scripts/export_raster.sh`

```bash
#!/bin/bash
set -e

cd "$(dirname "$0")/.."
source .env

IFS=',' read -ra YEAR_ARRAY <<< "$YEARS"

# Export per-year vessel activity
echo "Exporting vessel activity per year..."
for year in "${YEAR_ARRAY[@]}"; do
  echo "  → ${year}"
  duckdb data/data.duckdb -c "
    COPY (
      SELECT lon, lat, sum(hours) as hours
      FROM vessel_positions
      WHERE year = ${year}
      GROUP BY lat, lon
    ) TO 'data/vessel_activity_${year}.csv' (HEADER);
  "
done

# Generate per-year rasters
echo "Creating per-year rasters..."
for year in "${YEAR_ARRAY[@]}"; do
  INPUT_CSV="data/vessel_activity_${year}.csv" \
  OUTPUT_PATH="data/vessel_activity_${year}.tif" \
  uv run python scripts/create_raster.py
done

# Create land mask at same resolution
echo "Creating land mask..."
gdal_rasterize -burn 1 \
  -te -180 56 180 90 \
  -tr 0.01 0.01 \
  -ot Float32 \
  -co COMPRESS=DEFLATE \
  data/ne_10m_land/ne_10m_land.shp \
  data/land_mask.tif

# Combine all bands: years + land mask
echo "Combining into 4-band raster..."
uv run python3 << 'PYTHON_EOF'
import rasterio
import numpy as np

years = "${YEARS}".split(',')

# Read first year to get profile
with rasterio.open(f"data/vessel_activity_{years[0]}.tif") as src:
    profile = src.profile.copy()
    bands = [src.read(1)]

# Read remaining years
for year in years[1:]:
    with rasterio.open(f"data/vessel_activity_{year}.tif") as src:
        bands.append(src.read(1))

# Read land mask
with rasterio.open("data/land_mask.tif") as src:
    bands.append(src.read(1))

# Stack and write
combined = np.stack(bands)
profile.update(count=len(bands), compress='deflate', tiled=True)

with rasterio.open("data/vessel_combined.tif", 'w', **profile) as dst:
    dst.write(combined)

print(f"Created {len(bands)}-band raster")
PYTHON_EOF

# Convert to Cloud-Optimized GeoTIFF
echo "Creating COG..."
gdal_translate -of COG \
  -co COMPRESS=DEFLATE \
  -co OVERVIEWS=AUTO \
  -co RESAMPLING=NEAREST \
  data/vessel_combined.tif \
  data/vessel_heatmap.tif

# Cleanup
rm -f data/vessel_activity_*.csv data/vessel_activity_*.tif
rm -f data/vessel_combined.tif data/land_mask.tif

echo "✓ Created: data/vessel_heatmap.tif ($(du -h data/vessel_heatmap.tif | cut -f1))"
```

### Verification
```bash
gdalinfo data/vessel_heatmap.tif | grep Band
# Should show 4 bands with overviews
```

---

## Phase 2: Create Static Parquet Export

### Goal
Export all vector data and tooltip data to a single Parquet file optimized for DuckDB-WASM range queries.

### Create `scripts/export_parquet.py`

```python
#!/usr/bin/env python3
"""Export all data to a single Parquet file for client-side queries."""

import duckdb

OUTPUT = "data/data.parquet"

def main():
    db = duckdb.connect("data/data.duckdb", read_only=True)

    # Export as multi-table Parquet using Hive partitioning
    # DuckDB-WASM can query specific partitions via range requests

    print("Exporting protected areas...")
    db.execute("""
        COPY (
            SELECT
                'protected_areas' as _table,
                feature_id,
                area_name,
                ST_AsGeoJSON(geometry) as geometry
            FROM protected_areas_ocean
        ) TO 'data/export/protected_areas.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)

    print("Exporting vessel crossings...")
    db.execute("""
        COPY (
            SELECT
                'vessel_crossings' as _table,
                feature_id,
                area_name,
                vessel_id,
                mmsi,
                ship_name,
                flag,
                vessel_type,
                gear_type,
                total_hours,
                first_seen,
                last_seen,
                year,
                centroid_lon,
                centroid_lat,
                position_count
            FROM vessel_crossings
        ) TO 'data/export/vessel_crossings.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)

    print("Exporting vessel lookup (tooltips)...")
    db.execute("""
        COPY (
            SELECT
                'vessel_lookup' as _table,
                lat,
                lon,
                mmsi,
                ship_name,
                flag,
                vessel_type,
                year,
                total_hours
            FROM (
                SELECT
                    lat, lon, mmsi, ship_name, flag, vessel_type, year,
                    SUM(hours) as total_hours,
                    ROW_NUMBER() OVER (PARTITION BY lat, lon, year ORDER BY SUM(hours) DESC) as rn
                FROM vessel_positions
                GROUP BY lat, lon, mmsi, ship_name, flag, vessel_type, year
            )
            WHERE rn <= 5  -- Top 5 vessels per cell per year
            ORDER BY lat, lon, year, total_hours DESC
        ) TO 'data/export/vessel_lookup.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
    """)

    print("Exporting places...")
    db.execute("""
        COPY (
            SELECT
                'places' as _table,
                name_en,
                name_ru,
                lon,
                lat,
                population,
                scalerank
            FROM (
                SELECT
                    NAME as name_en,
                    NAME_RU as name_ru,
                    ST_X(geom) as lon,
                    ST_Y(geom) as lat,
                    POP_MAX as population,
                    SCALERANK as scalerank
                FROM ST_Read('data/ne_10m_populated_places/ne_10m_populated_places.shp')
                WHERE SCALERANK <= 5
                  AND ST_Y(geom) >= 57
                  AND ADM0_A3 = 'RUS'
            )
        ) TO 'data/export/places.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)

    db.close()

    # Combine into single file for simpler deployment
    print("Combining into single Parquet file...")
    db = duckdb.connect()
    db.execute("""
        COPY (
            SELECT * FROM read_parquet('data/export/*.parquet')
        ) TO 'data/data.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    db.close()

    import os
    size_mb = os.path.getsize(OUTPUT) / 1024 / 1024
    print(f"✓ Created: {OUTPUT} ({size_mb:.1f} MB)")

if __name__ == "__main__":
    main()
```

---

## Phase 3: Client-Side Tile Rendering

### Goal
Replace server-side rio-tiler with client-side geotiff.js.

### Install dependencies

```bash
npm install geotiff
```

### Create `src/cog-tiles.js`

```javascript
/**
 * Client-side COG tile renderer using geotiff.js
 * Replaces server-side rio-tiler + Pillow
 */

import GeoTIFF, { Pool } from 'geotiff'

// Band indices in the COG
const BAND_2023 = 0
const BAND_2024 = 1
const BAND_2025 = 2
const BAND_LAND = 3

// Year colors (RGB)
const YEAR_COLORS = {
  0: [0, 255, 255],    // 2023 - cyan
  1: [0, 255, 0],      // 2024 - green
  2: [255, 0, 255],    // 2025 - magenta
}

const DOMINANCE_THRESHOLD = 0.6
const TILE_SIZE = 256

let tiff = null
let pool = null
let imageCache = new Map()

/**
 * Initialize the COG reader
 */
export async function initCOG(url) {
  tiff = await GeoTIFF.fromUrl(url, {
    cacheSize: 100,
    blockSize: 65536,
  })
  pool = new Pool(navigator.hardwareConcurrency || 4)
  console.log(`COG initialized: ${url}`)
}

/**
 * Get the appropriate image for a zoom level (uses COG overviews)
 */
async function getImageForZoom(z) {
  if (imageCache.has(z)) {
    return imageCache.get(z)
  }

  const imageCount = await tiff.getImageCount()
  // COG overviews: image 0 is full res, 1+ are overviews
  // Map zoom levels to appropriate overview
  const overviewIndex = Math.max(0, Math.min(imageCount - 1, imageCount - 1 - z + 2))

  const image = await tiff.getImage(overviewIndex)
  imageCache.set(z, image)
  return image
}

/**
 * Convert tile coordinates to geographic bbox
 */
function tileToBBox(z, x, y) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z)
  const north = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))

  const n2 = Math.PI - (2 * Math.PI * (y + 1)) / Math.pow(2, z)
  const south = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n2) - Math.exp(-n2)))

  const west = (x / Math.pow(2, z)) * 360 - 180
  const east = ((x + 1) / Math.pow(2, z)) * 360 - 180

  return [west, south, east, north]
}

/**
 * Render a single tile
 */
export async function renderTile(z, x, y, selectedBands = [0, 1, 2]) {
  if (!tiff) {
    throw new Error('COG not initialized')
  }

  const image = await getImageForZoom(z)
  const [imgWidth, imgHeight] = [image.getWidth(), image.getHeight()]
  const [minX, minY, maxX, maxY] = image.getBoundingBox()

  // Tile bbox
  const [tileWest, tileSouth, tileEast, tileNorth] = tileToBBox(z, x, y)

  // Check if tile intersects image
  if (tileEast < minX || tileWest > maxX || tileNorth < minY || tileSouth > maxY) {
    return createEmptyTile()
  }

  // Calculate pixel window
  const pixelWidth = (maxX - minX) / imgWidth
  const pixelHeight = (maxY - minY) / imgHeight

  const windowX = Math.floor((tileWest - minX) / pixelWidth)
  const windowY = Math.floor((maxY - tileNorth) / pixelHeight)
  const windowWidth = Math.ceil((tileEast - tileWest) / pixelWidth)
  const windowHeight = Math.ceil((tileNorth - tileSouth) / pixelHeight)

  // Clamp to image bounds
  const clampedX = Math.max(0, Math.min(windowX, imgWidth))
  const clampedY = Math.max(0, Math.min(windowY, imgHeight))
  const clampedWidth = Math.min(windowWidth, imgWidth - clampedX)
  const clampedHeight = Math.min(windowHeight, imgHeight - clampedY)

  if (clampedWidth <= 0 || clampedHeight <= 0) {
    return createEmptyTile()
  }

  try {
    // Read all 4 bands for the tile window
    const rasters = await image.readRasters({
      window: [clampedX, clampedY, clampedX + clampedWidth, clampedY + clampedHeight],
      width: TILE_SIZE,
      height: TILE_SIZE,
      pool,
    })

    return colorize(rasters, selectedBands)
  } catch (err) {
    console.warn(`Tile ${z}/${x}/${y} read error:`, err.message)
    return createEmptyTile()
  }
}

/**
 * Create an empty transparent tile
 */
function createEmptyTile() {
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
  return canvas.transferToImageBitmap()
}

/**
 * Colorize raster data into RGBA ImageBitmap
 */
function colorize(rasters, selectedBands) {
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(TILE_SIZE, TILE_SIZE)
  const pixels = imageData.data

  const land = rasters[BAND_LAND]
  const vesselBands = selectedBands.map(b => rasters[b])

  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
    const px = i * 4

    // Land: white
    if (land[i] === 1) {
      pixels[px] = 255
      pixels[px + 1] = 255
      pixels[px + 2] = 255
      pixels[px + 3] = 255
      continue
    }

    // Get vessel values for selected bands
    const values = vesselBands.map(band => band[i] || 0)
    const total = values.reduce((a, b) => a + b, 0)

    // No activity: transparent (ocean)
    if (total === 0) {
      pixels[px + 3] = 0
      continue
    }

    // Find dominant band
    let maxVal = 0
    let maxIdx = 0
    for (let j = 0; j < values.length; j++) {
      if (values[j] > maxVal) {
        maxVal = values[j]
        maxIdx = j
      }
    }

    const proportion = maxVal / total

    // Brightness (log scale, minimum 0.7 for visibility)
    const brightness = Math.min(1, Math.max(0.7, Math.log1p(total) / Math.log1p(50)))

    let color
    if (proportion >= DOMINANCE_THRESHOLD) {
      // Dominant year color
      color = YEAR_COLORS[selectedBands[maxIdx]] || [180, 180, 180]
    } else {
      // Mixed: gray
      color = [180, 180, 180]
    }

    pixels[px] = Math.round(color[0] * brightness)
    pixels[px + 1] = Math.round(color[1] * brightness)
    pixels[px + 2] = Math.round(color[2] * brightness)
    pixels[px + 3] = 255
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas.transferToImageBitmap()
}

/**
 * Clear the image cache (call on cleanup)
 */
export function clearCache() {
  imageCache.clear()
}
```

### Create `src/data-layer.js`

```javascript
/**
 * Client-side data queries using DuckDB-WASM
 * Replaces server-side FastAPI endpoints
 */

import * as duckdb from '@duckdb/duckdb-wasm'

let db = null
let conn = null
const DATA_URL = import.meta.env.VITE_DATA_URL || '/data/data.parquet'

/**
 * Initialize DuckDB-WASM and register remote Parquet file
 */
export async function initDB() {
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles()
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES)

  const worker = new Worker(bundle.mainWorker)
  const logger = new duckdb.ConsoleLogger()

  db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)

  conn = await db.connect()

  // Register the remote Parquet file
  await conn.query(`
    CREATE VIEW data AS SELECT * FROM read_parquet('${DATA_URL}')
  `)

  console.log('DuckDB-WASM initialized')
}

/**
 * Load protected areas as GeoJSON FeatureCollection
 */
export async function loadProtectedAreas() {
  const result = await conn.query(`
    SELECT
      feature_id as id,
      area_name as name,
      geometry
    FROM data
    WHERE _table = 'protected_areas'
  `)

  const features = result.toArray().map(row => ({
    type: 'Feature',
    id: row.id,
    geometry: JSON.parse(row.geometry),
    properties: { name: row.name }
  }))

  return { type: 'FeatureCollection', features }
}

/**
 * Load vessel crossings as GeoJSON FeatureCollection
 */
export async function loadVesselCrossings() {
  const result = await conn.query(`
    SELECT
      feature_id,
      area_name,
      vessel_id,
      mmsi,
      ship_name,
      flag,
      vessel_type,
      gear_type,
      total_hours,
      first_seen,
      last_seen,
      year,
      centroid_lon,
      centroid_lat,
      position_count
    FROM data
    WHERE _table = 'vessel_crossings'
  `)

  const features = result.toArray().map(row => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [row.centroid_lon, row.centroid_lat]
    },
    properties: {
      feature_id: row.feature_id,
      area_name: row.area_name,
      vessel_id: row.vessel_id,
      mmsi: row.mmsi,
      ship_name: row.ship_name,
      flag: row.flag,
      vessel_type: row.vessel_type,
      gear_type: row.gear_type,
      total_hours: row.total_hours,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      year: row.year,
      position_count: row.position_count
    }
  }))

  return { type: 'FeatureCollection', features }
}

/**
 * Load places as GeoJSON FeatureCollection
 */
export async function loadPlaces() {
  const result = await conn.query(`
    SELECT name_en, name_ru, lon, lat, population, scalerank
    FROM data
    WHERE _table = 'places'
  `)

  const features = result.toArray().map(row => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [row.lon, row.lat]
    },
    properties: {
      name_en: row.name_en,
      name_ru: row.name_ru,
      population: row.population,
      scalerank: row.scalerank
    }
  }))

  return { type: 'FeatureCollection', features }
}

/**
 * Query vessels at a grid cell for tooltips
 */
export async function queryVesselsAt(lat, lon, year = null) {
  const gridLat = Math.round(lat * 100) / 100
  const gridLon = Math.round(lon * 100) / 100

  const yearFilter = year ? `AND year = ${year}` : ''

  const result = await conn.query(`
    SELECT mmsi, ship_name, flag, vessel_type, year, total_hours
    FROM data
    WHERE _table = 'vessel_lookup'
      AND lat = ${gridLat}
      AND lon = ${gridLon}
      ${yearFilter}
    ORDER BY total_hours DESC
    LIMIT 10
  `)

  return result.toArray()
}

/**
 * Close the database connection
 */
export async function closeDB() {
  if (conn) await conn.close()
  if (db) await db.terminate()
}
```

---

## Phase 4: Update Frontend

### Goal
Integrate client-side tile rendering and data queries with MapLibre.

### Update `src/main.js`

Key changes:
1. Remove PMTiles protocol registration
2. Add custom COG tile protocol
3. Load vector layers from DuckDB-WASM
4. Update tooltip handler to use client-side queries

```javascript
// Remove these imports:
// import * as pmtiles from 'pmtiles'

// Add these imports:
import { initCOG, renderTile } from './cog-tiles.js'
import { initDB, loadProtectedAreas, loadVesselCrossings, loadPlaces, queryVesselsAt } from './data-layer.js'

// Remove PMTiles protocol:
// const protocol = new pmtiles.Protocol()
// maplibregl.addProtocol('pmtiles', protocol.tile)

// Add COG tile protocol:
const cogTileCache = new Map()
let activeYearBands = [0, 1, 2]  // All years by default

maplibregl.addProtocol('cog', (params, callback) => {
  const match = params.url.match(/cog:\/\/(\d+)\/(\d+)\/(\d+)/)
  if (!match) {
    callback(new Error('Invalid COG tile URL'))
    return { cancel: () => {} }
  }

  const [, z, x, y] = match.map(Number)
  const cacheKey = `${z}/${x}/${y}/${activeYearBands.join(',')}`

  if (cogTileCache.has(cacheKey)) {
    callback(null, cogTileCache.get(cacheKey))
    return { cancel: () => {} }
  }

  renderTile(z, x, y, activeYearBands)
    .then(bitmap => {
      cogTileCache.set(cacheKey, bitmap)
      callback(null, bitmap)
    })
    .catch(err => callback(err))

  return { cancel: () => {} }
})

// Initialize on load
async function init() {
  // Initialize COG reader
  const cogUrl = import.meta.env.VITE_COG_URL || '/data/vessel_heatmap.tif'
  await initCOG(cogUrl)

  // Initialize DuckDB
  await initDB()

  // Load vector data
  const [protectedAreas, crossings, places] = await Promise.all([
    loadProtectedAreas(),
    loadVesselCrossings(),
    loadPlaces()
  ])

  // Add sources
  map.addSource('protected-areas', { type: 'geojson', data: protectedAreas })
  map.addSource('vessel-crossings', { type: 'geojson', data: crossings })
  map.addSource('places', { type: 'geojson', data: places })

  // ... add layers
}

// Update tooltip handler
async function handleRasterHover(e) {
  if (map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) return

  const { lat, lng } = e.lngLat
  const year = activeYears.size === 1 ? Array.from(activeYears)[0] : null
  const vessels = await queryVesselsAt(lat, lng, year)

  showRasterTooltip(vessels)
}

// Update year toggle to clear tile cache and re-render
function updateHeatmapSource() {
  const years = Array.from(activeYears).sort()
  activeYearBands = years.map(y => y - 2023)

  // Clear cache and trigger repaint
  cogTileCache.clear()
  map.triggerRepaint()
}
```

### Update `src/config.js`

Remove PMTiles sources, use GeoJSON:

```javascript
export function createMapStyle() {
  return {
    version: 8,
    projection: { type: 'globe' },
    sources: {
      'sentinel-2': {
        type: 'raster',
        tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg'],
        tileSize: 256,
        bounds: [-180, 65, 180, 90]
      },
      'vessel-heatmap': {
        type: 'raster',
        tiles: ['cog://{z}/{x}/{y}'],
        tileSize: 256
      }
      // Vector sources added dynamically after DuckDB loads
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
      { id: 'sentinel-2', type: 'raster', source: 'sentinel-2', layout: { visibility: 'none' } },
      { id: 'vessel-heatmap', type: 'raster', source: 'vessel-heatmap' }
      // Vector layers added dynamically
    ]
  }
}
```

---

## Phase 5: Simplify ETL

### Goal
Remove dbt, use plain SQL.

### Create `etl/transform.sql`

```sql
-- Albedo ETL Pipeline
-- Run with: duckdb data/data.duckdb < etl/transform.sql

INSTALL spatial;
LOAD spatial;

-- =============================================================================
-- STAGING: Load raw parquet files
-- =============================================================================

CREATE OR REPLACE TABLE vessel_presence AS
SELECT
    year,
    vessel->>'mmsi' as mmsi,
    vessel->>'imo' as imo,
    vessel->>'shipName' as ship_name,
    vessel->>'callsign' as callsign,
    vessel->>'flag' as flag,
    vessel->>'vesselType' as vessel_type,
    vessel->>'geartype' as gear_type,
    CAST(vessel->>'hours' AS DOUBLE) as hours,
    CAST(vessel->>'lat' AS DOUBLE) as lat,
    CAST(vessel->>'lon' AS DOUBLE) as lon,
    TRY_CAST(vessel->>'entryTimestamp' AS TIMESTAMP) as entry_timestamp,
    TRY_CAST(vessel->>'exitTimestamp' AS TIMESTAMP) as exit_timestamp,
    vessel->>'vesselId' as vessel_id,
    vessel->>'dataset' as dataset
FROM read_parquet('data/gfw/*/*.parquet');

-- =============================================================================
-- INTERMEDIATE: Clean and snap to grid
-- =============================================================================

CREATE OR REPLACE TABLE vessel_positions AS
SELECT
    vessel_id,
    mmsi,
    ship_name,
    flag,
    vessel_type,
    gear_type,
    ROUND(lat, 2) as lat,
    ROUND(lon, 2) as lon,
    hours,
    entry_timestamp,
    exit_timestamp,
    year
FROM vessel_presence
WHERE mmsi IS NOT NULL
  AND lat IS NOT NULL
  AND lon IS NOT NULL
  AND hours > 0;

-- =============================================================================
-- PROTECTED AREAS (ocean-only)
-- =============================================================================

CREATE OR REPLACE TABLE protected_areas_ocean AS
WITH study_area AS (
    SELECT ST_GeomFromText('POLYGON((-180 57, 180 57, 180 90, -180 90, -180 57))') as geometry
),
land_union AS (
    SELECT ST_Union_Agg(geom) as geometry
    FROM ST_Read('data/ne_10m_land/ne_10m_land.shp')
),
ocean_mask AS (
    SELECT ST_Difference(s.geometry, l.geometry) as geometry
    FROM study_area s, land_union l
),
protected_areas_raw AS (
    SELECT
        feature.id as feature_id,
        feature.properties.title as area_name,
        ST_GeomFromGeoJSON(json(feature.geometry)) as geometry
    FROM (
        SELECT unnest(features) as feature
        FROM read_json_auto('data/protected_areas.geojson', maximum_object_size=200000000)
    )
)
SELECT
    pa.feature_id,
    pa.area_name,
    ST_Intersection(pa.geometry, o.geometry) as geometry
FROM protected_areas_raw pa, ocean_mask o
WHERE ST_Intersects(pa.geometry, o.geometry)
  AND pa.feature_id != 'oopt_wth_details.fid-e747cd5_19a6f70ccf9_-2215';

-- =============================================================================
-- VESSEL CROSSINGS
-- =============================================================================

CREATE OR REPLACE TABLE vessel_crossings AS
WITH crossings_raw AS (
    SELECT
        pa.feature_id,
        pa.area_name,
        vp.*
    FROM vessel_positions vp
    CROSS JOIN protected_areas_ocean pa
    WHERE ST_Within(ST_Point(vp.lon, vp.lat), pa.geometry)
)
SELECT
    feature_id,
    area_name,
    vessel_id,
    mmsi,
    ship_name,
    flag,
    vessel_type,
    gear_type,
    SUM(hours) as total_hours,
    MIN(entry_timestamp) as first_seen,
    MAX(exit_timestamp) as last_seen,
    EXTRACT(YEAR FROM MIN(entry_timestamp))::INTEGER as year,
    SUM(lon * hours) / SUM(hours) as centroid_lon,
    SUM(lat * hours) / SUM(hours) as centroid_lat,
    COUNT(*) as position_count
FROM crossings_raw
GROUP BY feature_id, area_name, vessel_id, mmsi, ship_name, flag, vessel_type, gear_type
HAVING SUM(hours) >= 1;

-- =============================================================================
-- VESSEL ACTIVITY (summary)
-- =============================================================================

CREATE OR REPLACE TABLE vessel_activity AS
SELECT
    vessel_id,
    mmsi,
    ship_name,
    flag,
    vessel_type,
    gear_type,
    COUNT(*) as total_detections,
    SUM(hours) as total_hours,
    MIN(entry_timestamp) as first_seen,
    MAX(exit_timestamp) as last_seen,
    LIST(DISTINCT year ORDER BY year) as years_active
FROM vessel_positions
GROUP BY vessel_id, mmsi, ship_name, flag, vessel_type, gear_type;
```

### Files to delete

```
etl/dbt_project.yml
etl/profiles.yml
etl/.user.yml
etl/models/
etl/macros/
etl/target/
```

---

## Phase 6: Update Dependencies

### `package.json`

```json
{
  "name": "albedo",
  "version": "2.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@duckdb/duckdb-wasm": "^1.29.0",
    "@fontsource/inter": "^5.2.8",
    "geotiff": "^2.1.3",
    "maplibre-gl": "^5.14.0"
  },
  "devDependencies": {
    "vite": "^7.2.7"
  }
}
```

Removed: `pmtiles`

### `pyproject.toml`

```toml
[project]
name = "albedo"
version = "2.0.0"
requires-python = ">=3.11"
dependencies = [
    "duckdb>=1.0.0",
    "rasterio>=1.3.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

Removed: `fastapi`, `uvicorn`, `rio-tiler`, `pillow`, `requests`, `beautifulsoup4`, `pandas`

---

## Phase 7: Update Build & Deploy

### `Makefile`

```makefile
# Albedo - Static Build Pipeline

.PHONY: all install fetch convert transform tiles export build deploy clean

# Full pipeline
all: transform tiles export build

# Install dependencies
install:
	uv sync
	npm install

# Fetch source data
fetch:
	./scripts/fetch_vessel_presence.sh
	./scripts/fetch_protected_areas.sh
	./scripts/fetch_land.sh

# Convert JSON to Parquet
convert:
	./scripts/convert.sh

# Run SQL transformations
transform: data/data.duckdb

data/data.duckdb: data/.convert.done
	duckdb $@ < etl/transform.sql

# Generate COG with land mask
tiles: data/vessel_heatmap.tif

data/vessel_heatmap.tif: data/data.duckdb
	./scripts/export_raster.sh

# Export Parquet for client
export: data/data.parquet

data/data.parquet: data/data.duckdb
	uv run python scripts/export_parquet.py

# Build frontend
build: dist

dist: src/* data/vessel_heatmap.tif data/data.parquet
	npm run build
	cp data/vessel_heatmap.tif dist/data/
	cp data/data.parquet dist/data/

# Deploy to Google Cloud Storage
deploy: dist
	gcloud storage cp -r dist/* gs://albedo-static/
	@echo "Deployed to: https://storage.googleapis.com/albedo-static/index.html"

# Clean
clean:
	rm -rf dist data/data.duckdb data/data.parquet data/vessel_heatmap.tif
```

### Setup Google Cloud Storage

```bash
# Create bucket (run once)
gcloud storage buckets create gs://albedo-static \
  --location=europe-west1 \
  --uniform-bucket-level-access

# Enable public access
gcloud storage buckets add-iam-policy-binding gs://albedo-static \
  --member=allUsers \
  --role=roles/storage.objectViewer

# Enable CORS for range requests
cat > /tmp/cors.json << 'EOF'
[
  {
    "origin": ["*"],
    "method": ["GET", "HEAD"],
    "responseHeader": ["Content-Type", "Content-Range", "Accept-Ranges", "Content-Length"],
    "maxAgeSeconds": 3600
  }
]
EOF
gcloud storage buckets update gs://albedo-static --cors-file=/tmp/cors.json

# Optional: Set up Cloud CDN for better performance
# gcloud compute backend-buckets create albedo-backend --gcs-bucket-name=albedo-static
# gcloud compute url-maps create albedo-lb --default-backend-bucket=albedo-backend
```

### `vite.config.js`

```javascript
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: {
          'duckdb': ['@duckdb/duckdb-wasm'],
          'geotiff': ['geotiff'],
          'maplibre': ['maplibre-gl']
        }
      }
    }
  },
  define: {
    __TILE_VERSION__: JSON.stringify(process.env.TILE_VERSION || '1')
  }
})
```

---

## Phase 8: Delete Server Code

### Files to delete

```
scripts/tile_server.py
scripts/create_vessel_lookup.py
scripts/export_crossings.sh
scripts/export_protected_areas.sh
scripts/export_land.sh
scripts/export_places.sh
scripts/export_vessel_points.sh
Dockerfile
cloudbuild.yaml
.github/workflows/deploy.yml
```

### Files to keep (modified)

```
scripts/fetch_vessel_presence.sh
scripts/fetch_protected_areas.sh
scripts/fetch_land.sh
scripts/convert.sh
scripts/export_raster.sh (updated)
scripts/export_parquet.py (new)
scripts/create_raster.py
scripts/raster_utils.py
```

---

## Migration Checklist

### Phase 1: Combined COG
- [ ] Update `scripts/export_raster.sh` to include land mask as band 4
- [ ] Test: `gdalinfo data/vessel_heatmap.tif` shows 4 bands
- [ ] Verify file size ~18MB

### Phase 2: Parquet Export
- [ ] Create `scripts/export_parquet.py`
- [ ] Test: `duckdb -c "SELECT _table, COUNT(*) FROM read_parquet('data/data.parquet') GROUP BY 1"`
- [ ] Verify file size ~80MB

### Phase 3: Client-Side Tiles
- [ ] Install `geotiff` npm package
- [ ] Create `src/cog-tiles.js`
- [ ] Test: Tiles render in browser console

### Phase 4: Client-Side Data
- [ ] Install `@duckdb/duckdb-wasm` npm package
- [ ] Create `src/data-layer.js`
- [ ] Test: `await loadProtectedAreas()` returns GeoJSON

### Phase 5: Update Frontend
- [ ] Remove PMTiles imports and protocol
- [ ] Add COG protocol and DuckDB initialization
- [ ] Update map sources to use GeoJSON
- [ ] Test: Full map loads with all layers

### Phase 6: Simplify ETL
- [ ] Create `etl/transform.sql`
- [ ] Delete dbt files
- [ ] Test: `make transform` creates correct tables

### Phase 7: Deploy
- [ ] Create GCS bucket with public access and CORS
- [ ] Update Makefile deploy target
- [ ] Test: `make deploy` uploads to GCS
- [ ] Test: Site loads from GCS URL

### Phase 8: Cleanup
- [ ] Delete server code
- [ ] Delete unused dependencies
- [ ] Update README/CLAUDE.md

---

## Cost Comparison

| Component | Before (Cloud Run) | After (Cloud Storage) |
|-----------|-------------------|----------------------|
| Compute | $50-150/month at scale | $0 |
| Storage | ~$1/month | ~$0.50/month |
| Bandwidth | Included | ~$0.12/GB (free with CDN) |
| **Total at HN scale** | **$100+/month** | **<$5/month** |

---

## Architecture Comparison

### Before
```
User → Cloud Run (FastAPI) → rio-tiler → COG
                          → DuckDB → PMTiles/Parquet
```

**Problems:** Server compute on every request, doesn't scale, costs money

### After
```
User → Browser → geotiff.js → COG (GCS, range requests)
              → DuckDB-WASM → Parquet (GCS, range requests)
```

**Benefits:** Zero server, infinite scale, ~$0/month, instant filter changes
