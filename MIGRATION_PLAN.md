# Albedo Architecture Migration Plan

## Overview

Migrate from the current multi-tool spatial stack to a minimal architecture centered on DuckDB + rio-tiler. The goal is fewer dependencies, less abstraction, and a cleaner mental model.

**Current stack:** DuckDB, dbt, rasterio, GDAL CLI, tippecanoe, PMTiles, rio-tiler, Pillow, FastAPI, MapLibre GL

**Target stack:** DuckDB, rasterio, rio-tiler, FastAPI, MapLibre GL

---

## Phase 1: Remove dbt, Use Plain SQL

### Goal
Replace dbt with plain SQL scripts executed directly by DuckDB CLI.

### Files to Create

**`etl/transform.sql`** — Single file containing all transformations:

```sql
-- Albedo ETL Pipeline
-- Run with: duckdb data/data.duckdb < etl/transform.sql

INSTALL spatial;
LOAD spatial;

-- =============================================================================
-- STAGING: Load raw parquet files
-- =============================================================================

CREATE OR REPLACE TABLE vessel_presence AS
SELECT * FROM read_parquet('data/gfw/*/*.parquet');

-- =============================================================================
-- INTERMEDIATE: Clean and snap to grid
-- =============================================================================

CREATE OR REPLACE TABLE vessel_positions AS
SELECT
    vessel->>'id' as vessel_id,
    CAST(vessel->>'mmsi' AS VARCHAR) as mmsi,
    vessel->>'shipname' as ship_name,
    vessel->>'flag' as flag,
    vessel->>'vesselType' as vessel_type,
    ROUND(CAST(vessel->>'lat' AS DOUBLE), 2) as lat,
    ROUND(CAST(vessel->>'lon' AS DOUBLE), 2) as lon,
    CAST(vessel->>'hours' AS DOUBLE) as hours,
    year
FROM vessel_presence
WHERE vessel->>'lat' IS NOT NULL
  AND vessel->>'lon' IS NOT NULL
  AND CAST(vessel->>'lat' AS DOUBLE) BETWEEN 56 AND 90;

-- =============================================================================
-- MARTS: Aggregated tables
-- =============================================================================

-- Vessel activity summary (one row per vessel)
CREATE OR REPLACE TABLE vessel_activity AS
SELECT
    vessel_id,
    mmsi,
    FIRST(ship_name) as ship_name,
    FIRST(flag) as flag,
    FIRST(vessel_type) as vessel_type,
    SUM(hours) as total_hours,
    COUNT(*) as position_count,
    MIN(year) as first_year,
    MAX(year) as last_year
FROM vessel_positions
GROUP BY vessel_id, mmsi;

-- Vessel crossings with protected areas
CREATE OR REPLACE TABLE vessel_crossings AS
WITH protected_areas AS (
    SELECT * FROM ST_Read('data/protected_areas.geojson')
)
SELECT
    vp.vessel_id,
    vp.mmsi,
    vp.ship_name,
    vp.flag,
    vp.vessel_type,
    pa.name as protected_area_name,
    pa.category as protected_area_category,
    SUM(vp.hours) as hours_in_area,
    SUM(vp.lon * vp.hours) / SUM(vp.hours) as centroid_lon,
    SUM(vp.lat * vp.hours) / SUM(vp.hours) as centroid_lat,
    MIN(vp.year) as first_year,
    MAX(vp.year) as last_year
FROM vessel_positions vp
JOIN protected_areas pa
  ON ST_Within(ST_Point(vp.lon, vp.lat), pa.geom)
GROUP BY vp.vessel_id, vp.mmsi, vp.ship_name, vp.flag, vp.vessel_type,
         pa.name, pa.category
HAVING SUM(vp.hours) >= 1;

-- =============================================================================
-- EXPORTS: GeoJSON for frontend
-- =============================================================================

-- Export protected areas as GeoJSON
COPY (
    SELECT json_group_array(json_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(geom)::JSON,
        'properties', json_object(
            'name', name,
            'category', category
        )
    )) as features
    FROM ST_Read('data/protected_areas.geojson')
) TO 'data/exports/protected_areas.geojson' (FORMAT JSON);

-- Export vessel crossings as GeoJSON
COPY (
    SELECT json_object(
        'type', 'FeatureCollection',
        'features', json_group_array(json_object(
            'type', 'Feature',
            'geometry', json_object(
                'type', 'Point',
                'coordinates', [centroid_lon, centroid_lat]
            ),
            'properties', json_object(
                'vessel_id', vessel_id,
                'mmsi', mmsi,
                'ship_name', ship_name,
                'flag', flag,
                'vessel_type', vessel_type,
                'protected_area', protected_area_name,
                'hours', hours_in_area
            )
        ))
    )
    FROM vessel_crossings
) TO 'data/exports/vessel_crossings.geojson' (FORMAT JSON);
```

### Files to Delete

```
etl/dbt_project.yml
etl/profiles.yml (if exists)
etl/models/staging/
etl/models/intermediate/
etl/models/marts/
etl/macros/
```

Keep `etl/` directory with just `transform.sql`.

### Makefile Changes

Replace:
```makefile
transform:
	cd etl && dbt run --target prod
```

With:
```makefile
transform:
	mkdir -p data/exports
	duckdb data/data.duckdb < etl/transform.sql
```

### Dependencies to Remove

In `pyproject.toml`, remove:
- `dbt-core`
- `dbt-duckdb`

---

## Phase 2: Remove tippecanoe and PMTiles

### Goal
Serve vector data as GeoJSON instead of PMTiles. For small datasets (< 10k features), GeoJSON is simpler and fast enough.

### Tile Server Changes

**`scripts/tile_server.py`** — Add GeoJSON API endpoints:

```python
from fastapi import FastAPI
from fastapi.responses import JSONResponse
import duckdb

app = FastAPI()
db = duckdb.connect('data/data.duckdb', read_only=True)

@app.get("/api/protected-areas")
def get_protected_areas():
    """Serve protected areas as GeoJSON FeatureCollection"""
    result = db.execute("""
        SELECT json_object(
            'type', 'FeatureCollection',
            'features', json_group_array(json_object(
                'type', 'Feature',
                'geometry', ST_AsGeoJSON(geom)::JSON,
                'properties', json_object(
                    'name', name,
                    'category', category,
                    'area_km2', ST_Area(geom::GEOGRAPHY) / 1e6
                )
            ))
        )
        FROM protected_areas_ocean
    """).fetchone()[0]
    return JSONResponse(content=json.loads(result))

@app.get("/api/vessel-crossings")
def get_vessel_crossings():
    """Serve vessel crossings as GeoJSON FeatureCollection"""
    result = db.execute("""
        SELECT json_object(
            'type', 'FeatureCollection',
            'features', json_group_array(json_object(
                'type', 'Feature',
                'geometry', json_object(
                    'type', 'Point',
                    'coordinates', [centroid_lon, centroid_lat]
                ),
                'properties', json_object(
                    'vessel_id', vessel_id,
                    'mmsi', mmsi,
                    'ship_name', ship_name,
                    'flag', flag,
                    'vessel_type', vessel_type,
                    'protected_area', protected_area_name,
                    'hours', ROUND(hours_in_area, 1),
                    'first_year', first_year,
                    'last_year', last_year
                )
            ))
        )
        FROM vessel_crossings
    """).fetchone()[0]
    return JSONResponse(content=json.loads(result))

@app.get("/api/places")
def get_places():
    """Serve places of interest as GeoJSON"""
    # Read from static file or database table
    with open('data/places/places.geojson') as f:
        return JSONResponse(content=json.load(f))
```

### Frontend Changes

**`src/main.js`** — Replace PMTiles sources with GeoJSON:

Remove PMTiles protocol registration:
```javascript
// DELETE THIS:
import { Protocol } from 'pmtiles';
let protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
```

Replace PMTiles sources:
```javascript
// BEFORE:
map.addSource('protected-areas', {
    type: 'vector',
    url: 'pmtiles://data/protected_areas.pmtiles'
});

// AFTER:
map.addSource('protected-areas', {
    type: 'geojson',
    data: '/api/protected-areas'
});

// BEFORE:
map.addSource('vessel-crossings', {
    type: 'vector',
    url: 'pmtiles://data/vessel_crossings.pmtiles'
});

// AFTER:
map.addSource('vessel-crossings', {
    type: 'geojson',
    data: '/api/vessel-crossings'
});
```

Update layer definitions (remove `source-layer` property):
```javascript
// BEFORE:
map.addLayer({
    id: 'crossings-circles',
    type: 'circle',
    source: 'vessel-crossings',
    'source-layer': 'crossings',  // DELETE THIS LINE
    paint: { ... }
});

// AFTER:
map.addLayer({
    id: 'crossings-circles',
    type: 'circle',
    source: 'vessel-crossings',
    paint: { ... }
});
```

### Special Case: Land Layer

Natural Earth land is larger (~10MB GeoJSON). Options:

1. **Keep as PMTiles** (recommended if you need zoom-dependent simplification)
2. **Simplify and serve as GeoJSON** using DuckDB:
   ```sql
   -- Simplify geometry for web display
   SELECT ST_Simplify(geom, 0.01) FROM land WHERE ...
   ```
3. **Use external basemap** — If using Sentinel-2, you may not need land polygons at all

### Files to Delete

```
data/protected_areas.pmtiles
data/vessel_crossings.pmtiles
data/places.pmtiles
scripts/export_crossings.sh
scripts/export_protected_areas.sh (if uses tippecanoe)
```

### Makefile Changes

Remove tippecanoe targets:
```makefile
# DELETE:
crossings-tiles:
	tippecanoe -o data/vessel_crossings.pmtiles ...
```

### Dependencies to Remove

In `package.json`, remove:
- `pmtiles`

System dependency no longer needed:
- `tippecanoe`

---

## Phase 3: Consolidate Raster Pipeline

### Goal
Use rasterio exclusively for all raster operations. Remove GDAL CLI dependency.

### Changes to `scripts/create_raster.py`

```python
import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.enums import Resampling
import csv

# Configuration
RESOLUTION = 0.01  # degrees
BOUNDS = {
    'west': 20,
    'east': 200,  # -160 wrapped
    'south': 56,
    'north': 90
}

def create_cog(input_csvs: list[str], output_path: str):
    """
    Create a Cloud-Optimized GeoTIFF directly from CSV data.

    Args:
        input_csvs: List of CSV files [2023.csv, 2024.csv, 2025.csv]
        output_path: Output COG path
    """
    # Calculate dimensions
    width = int((BOUNDS['east'] - BOUNDS['west']) / RESOLUTION)
    height = int((BOUNDS['north'] - BOUNDS['south']) / RESOLUTION)

    # Initialize bands array
    bands = np.zeros((len(input_csvs), height, width), dtype=np.float32)

    # Read each CSV into a band
    for band_idx, csv_path in enumerate(input_csvs):
        with open(csv_path) as f:
            reader = csv.DictReader(f)
            for row in reader:
                lon = float(row['lon'])
                lat = float(row['lat'])
                hours = float(row['hours'])

                # Convert to pixel coordinates
                col = int((lon - BOUNDS['west']) / RESOLUTION)
                row_idx = int((BOUNDS['north'] - lat) / RESOLUTION)

                if 0 <= col < width and 0 <= row_idx < height:
                    bands[band_idx, row_idx, col] += hours

    # Create transform
    transform = from_bounds(
        BOUNDS['west'], BOUNDS['south'],
        BOUNDS['east'], BOUNDS['north'],
        width, height
    )

    # Write COG directly (rasterio 1.3+ supports COG driver)
    profile = {
        'driver': 'COG',
        'dtype': 'float32',
        'width': width,
        'height': height,
        'count': len(input_csvs),
        'crs': 'EPSG:4326',
        'transform': transform,
        'compress': 'deflate',
        'predictor': 2,
        'blocksize': 512,
        'overview_resampling': Resampling.nearest,
    }

    with rasterio.open(output_path, 'w', **profile) as dst:
        for i, band in enumerate(bands, start=1):
            dst.write(band, i)

    print(f"Created COG: {output_path}")
    print(f"  Dimensions: {width} x {height}")
    print(f"  Bands: {len(input_csvs)}")

if __name__ == '__main__':
    import sys
    create_cog(sys.argv[1:-1], sys.argv[-1])
```

### Changes to `scripts/export_raster.sh`

Simplify to just export CSVs and call Python:

```bash
#!/bin/bash
set -e

# Export per-year CSVs from DuckDB
for year in 2023 2024 2025; do
    duckdb data/data.duckdb -csv -c "
        SELECT lon, lat, SUM(hours) as hours
        FROM vessel_positions
        WHERE year = $year
        GROUP BY lon, lat
    " > data/vessel_${year}.csv
done

# Create COG with all bands
python scripts/create_raster.py \
    data/vessel_2023.csv \
    data/vessel_2024.csv \
    data/vessel_2025.csv \
    data/vessel_heatmap.tif

# Cleanup intermediate files
rm -f data/vessel_202*.csv
```

### Files to Delete

```
scripts/export_raster.sh (replace with above)
```

Remove GDAL CLI calls like:
```bash
# DELETE any gdal_translate calls
gdal_translate -of COG ...
```

### Dependencies

Ensure rasterio is >= 1.3.0 for native COG support.

---

## Phase 4: Simplify Tile Colorization

### Goal
Remove Pillow dependency. Use rio-tiler's built-in rendering or NumPy directly.

### Changes to `scripts/tile_server.py`

Replace Pillow-based colorization:

```python
import numpy as np
from rio_tiler.io import Reader
from rio_tiler.models import ImageData
from fastapi import Response
import io

# Color scheme (RGB)
COLORS = {
    0: np.array([0, 255, 255]),    # 2023 - Cyan
    1: np.array([0, 255, 0]),      # 2024 - Green
    2: np.array([255, 0, 255]),    # 2025 - Magenta
}
GRAY = np.array([128, 128, 128])
DOMINANCE_THRESHOLD = 0.6

@app.get("/tiles/{z}/{x}/{y}.png")
def get_tile(z: int, x: int, y: int, years: str = "0,1,2"):
    """Serve colorized raster tile"""
    band_indices = [int(i) for i in years.split(',')]

    with Reader("data/vessel_heatmap.tif") as src:
        # Read requested bands
        img = src.tile(x, y, z, indexes=[i + 1 for i in band_indices])
        data = img.data  # shape: (bands, height, width)

    # Colorize
    rgb = colorize_tile(data, band_indices)

    # Encode to PNG using rio-tiler's utilities
    # Or use imageio for minimal dependencies:
    import imageio
    buf = io.BytesIO()
    imageio.imwrite(buf, rgb, format='PNG')
    buf.seek(0)

    return Response(content=buf.read(), media_type="image/png")

def colorize_tile(data: np.ndarray, band_indices: list[int]) -> np.ndarray:
    """
    Convert multi-band activity data to RGB image.

    Args:
        data: Array of shape (bands, height, width)
        band_indices: Which years each band represents

    Returns:
        RGBA array of shape (height, width, 4)
    """
    bands, height, width = data.shape

    # Calculate total and proportions
    total = np.sum(data, axis=0)  # (height, width)

    # Avoid division by zero
    total_safe = np.where(total > 0, total, 1)
    proportions = data / total_safe  # (bands, height, width)

    # Find dominant band
    dominant_idx = np.argmax(data, axis=0)  # (height, width)
    dominant_proportion = np.max(proportions, axis=0)

    # Initialize RGB
    rgb = np.zeros((height, width, 4), dtype=np.uint8)

    # Calculate brightness (log scale)
    brightness = np.clip(np.log1p(total) / np.log1p(50), 0, 1)

    # Apply colors
    for i, band_idx in enumerate(band_indices):
        mask = (dominant_idx == i) & (dominant_proportion >= DOMINANCE_THRESHOLD)
        color = COLORS.get(band_idx, GRAY)
        for c in range(3):
            rgb[:, :, c] = np.where(mask,
                                    (color[c] * brightness * 255).astype(np.uint8),
                                    rgb[:, :, c])

    # Mixed areas (no dominant year)
    mixed_mask = dominant_proportion < DOMINANCE_THRESHOLD
    for c in range(3):
        rgb[:, :, c] = np.where(mixed_mask & (total > 0),
                                (GRAY[c] * brightness * 255).astype(np.uint8),
                                rgb[:, :, c])

    # Alpha channel
    rgb[:, :, 3] = np.where(total > 0, 255, 0)

    return rgb
```

### Dependencies to Remove

In `pyproject.toml`, remove:
- `Pillow`

Add (if not present):
- `imageio`

Or use rio-tiler's built-in PNG encoding if available.

---

## Phase 5: Update Dependencies

### Final `pyproject.toml`

```toml
[project]
name = "albedo"
version = "0.1.0"
requires-python = ">=3.11"

dependencies = [
    "duckdb>=1.0.0",
    "rasterio>=1.3.0",
    "rio-tiler>=6.0.0",
    "fastapi>=0.100.0",
    "uvicorn>=0.23.0",
    "imageio>=2.31.0",
]

[tool.uv]
dev-dependencies = [
    "pytest>=7.0.0",
]
```

### Final `package.json`

```json
{
  "name": "albedo",
  "version": "1.0.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "maplibre-gl": "^5.0.0"
  },
  "devDependencies": {
    "vite": "^5.0.0"
  }
}
```

Removed:
- `pmtiles`

---

## Phase 6: Update Makefile

### Final `Makefile`

```makefile
.PHONY: all install fetch convert transform tiles dev clean

# Default target
all: fetch convert transform tiles

# Install dependencies
install:
	uv sync
	npm install

# Fetch raw data from GFW API
fetch:
	./scripts/fetch_vessel_presence.sh
	./scripts/fetch_protected_areas.sh

# Convert JSON to Parquet
convert:
	./scripts/convert.sh

# Run SQL transformations
transform:
	mkdir -p data/exports
	duckdb data/data.duckdb < etl/transform.sql

# Generate raster tiles (COG)
tiles:
	./scripts/export_raster.sh

# Development server
dev:
	uvicorn scripts.tile_server:app --reload --port 8000 &
	npm run dev

# Create lookup database for production
lookup:
	python scripts/create_vessel_lookup.py

# Clean generated files
clean:
	rm -rf data/data.duckdb
	rm -rf data/exports/
	rm -f data/vessel_heatmap.tif
```

---

## Migration Checklist

### Phase 1: Remove dbt
- [ ] Create `etl/transform.sql` with all SQL logic
- [ ] Update Makefile `transform` target
- [ ] Delete `etl/models/`, `etl/macros/`, `dbt_project.yml`
- [ ] Remove dbt from `pyproject.toml`
- [ ] Test: `make transform` produces correct `data.duckdb`

### Phase 2: Remove PMTiles
- [ ] Add GeoJSON API endpoints to `tile_server.py`
- [ ] Update `src/main.js` to use GeoJSON sources
- [ ] Remove PMTiles protocol registration from frontend
- [ ] Remove `source-layer` from layer definitions
- [ ] Delete PMTiles export scripts
- [ ] Remove `pmtiles` from `package.json`
- [ ] Test: Map renders protected areas and crossings

### Phase 3: Consolidate Raster
- [ ] Update `create_raster.py` to output COG directly
- [ ] Remove GDAL CLI calls from `export_raster.sh`
- [ ] Test: `make tiles` produces valid COG

### Phase 4: Simplify Colorization
- [ ] Update tile colorization to use imageio instead of Pillow
- [ ] Remove Pillow from `pyproject.toml`
- [ ] Test: Tiles render correctly with year filtering

### Phase 5: Final Cleanup
- [ ] Update `pyproject.toml` with final dependencies
- [ ] Update `package.json` with final dependencies
- [ ] Run `uv sync` and `npm install`
- [ ] Full pipeline test: `make all && make dev`
- [ ] Verify all functionality works

---

## Architecture Comparison

### Before
```
GFW API → JSON → Parquet → dbt/DuckDB → {GDAL, tippecanoe} → {COG, PMTiles} → FastAPI/rio-tiler → MapLibre
                              ↓
                           Pillow
```

**Tools:** DuckDB, dbt, rasterio, GDAL, tippecanoe, PMTiles, rio-tiler, Pillow, FastAPI, MapLibre

### After
```
GFW API → JSON → Parquet → DuckDB/SQL → rasterio → COG → FastAPI/rio-tiler → MapLibre
                              ↓
                           GeoJSON
```

**Tools:** DuckDB, rasterio, rio-tiler, FastAPI, MapLibre

### Reduction
- **Removed:** dbt, GDAL CLI, tippecanoe, PMTiles, Pillow
- **Simplified:** Single SQL file, direct COG creation, native GeoJSON serving
- **Result:** ~50% fewer dependencies, clearer data flow

---

## Notes for Implementation

1. **Test incrementally** — Complete each phase fully before moving to the next
2. **Keep backups** — Don't delete old files until new approach is verified
3. **GeoJSON performance** — If any vector dataset exceeds ~50k features, consider keeping PMTiles for just that layer
4. **Land layer decision** — Evaluate whether land polygons are needed at all given Sentinel-2 basemap
5. **COG driver** — Requires rasterio >= 1.3.0; check with `rio --version`
