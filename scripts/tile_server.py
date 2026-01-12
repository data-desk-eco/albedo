#!/usr/bin/env python3
"""Tile server for COG using FastAPI + rio-tiler"""
import json
import logging
import os
import warnings
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path

import duckdb
import numpy as np
from PIL import Image
from fastapi import FastAPI, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from rio_tiler.io import Reader

warnings.filterwarnings("ignore", message=".*NoData.*")
logging.getLogger("rasterio._err").setLevel(logging.ERROR)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).parent.parent
DATA_ROOT = PROJECT_ROOT / "data"
CATEGORIES_DIR = DATA_ROOT / "vessel_categories"

# Year colors (RGB) by band index: oldest → newest
# SYNC: Must match YEAR_COLORS in src/main.js
YEAR_COLORS = np.array([
    [0, 255, 255],    # Band 0 (2023) - cyan
    [0, 255, 0],      # Band 1 (2024) - green
    [255, 0, 255],    # Band 2 (2025) - magenta
], dtype=np.float32)

# COG readers for each category
cog_readers: dict[str, Reader] = {}

# DuckDB connection for vessel queries
db_conn: duckdb.DuckDBPyConnection | None = None

# Grid resolution for vessel position data (must match raster resolution)
GRID_RESOLUTION = 0.01


def load_categories():
    """Load category definitions."""
    config_path = CATEGORIES_DIR / "categories.json"
    if config_path.exists():
        with open(config_path) as f:
            return json.load(f)["categories"]
    return [{"id": "all", "name_en": "All vessels", "name_ru": "Все суда"}]


def get_cog_path(category_id: str) -> Path:
    """Get COG path for a category."""
    if category_id == "all":
        return DATA_ROOT / "vessel_heatmap.tif"
    return DATA_ROOT / f"category_{category_id}_heatmap.tif"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage COG reader and DuckDB connection lifecycle."""
    global cog_readers, db_conn

    # Load main raster
    main_cog = DATA_ROOT / "vessel_heatmap.tif"
    if main_cog.exists():
        cog_readers["all"] = Reader(str(main_cog))
        logger.info(f"Loaded main COG: {main_cog}")

    # Load category-specific rasters
    categories = load_categories()
    for cat in categories:
        if cat["id"] == "all":
            continue
        cog_path = get_cog_path(cat["id"])
        if cog_path.exists():
            cog_readers[cat["id"]] = Reader(str(cog_path))
            logger.info(f"Loaded category COG: {cog_path}")

    # Open DuckDB connection for vessel queries (use small lookup DB if available)
    db_path = DATA_ROOT / "vessel_lookup.duckdb"
    if not db_path.exists():
        db_path = DATA_ROOT / "data.duckdb"  # Fallback to full DB for dev
    if db_path.exists():
        db_conn = duckdb.connect(str(db_path), read_only=True)
        logger.info(f"Connected to DuckDB: {db_path}")

    yield

    for reader in cog_readers.values():
        reader.close()
    logger.info("COG readers closed")

    if db_conn:
        db_conn.close()
        logger.info("DuckDB connection closed")


SERVE_DIST = os.environ.get("SERVE_DIST", "").lower() in ("1", "true")
STATIC_ROOT = PROJECT_ROOT / "dist" if SERVE_DIST else PROJECT_ROOT


def colorize_tile(data: np.ndarray, years: str = "") -> np.ndarray:
    """Colorize multi-band raster by year dominance.

    Returns RGBA array in (H, W, 4) format for PIL.
    """
    num_bands = min(data.shape[0], len(YEAR_COLORS))
    height, width = data.shape[1], data.shape[2]

    # Parse selected bands (by index: 0, 1, 2)
    if years:
        try:
            selected_bands = [int(y) for y in years.split(",") if 0 <= int(y) < num_bands]
        except ValueError:
            selected_bands = list(range(num_bands))
    else:
        selected_bands = list(range(num_bands))

    if not selected_bands:
        selected_bands = list(range(num_bands))

    # Get ONLY selected bands for dominance calculation
    # This fixes the banding issue where pixels dominated by non-selected bands were blank
    bands = np.array([data[i].astype(np.float32) for i in selected_bands])
    total = np.sum(bands, axis=0)
    has_activity = total > 0

    # Calculate proportions among selected bands only
    safe_total = np.where(total > 0, total, 1)
    proportions = bands / safe_total

    # Find dominant year among selected bands
    dominant_idx = np.argmax(bands, axis=0)  # Index into selected_bands array
    dominant_proportion = np.max(proportions, axis=0)

    # Dominance threshold
    DOMINANCE_THRESHOLD = 0.6
    is_dominant_enough = dominant_proportion >= DOMINANCE_THRESHOLD
    is_gray = has_activity & ~is_dominant_enough

    # Brightness based on activity (log scale)
    brightness = np.log1p(total) / np.log1p(50)
    brightness = np.where(has_activity, np.maximum(brightness, 0.7), 0)
    brightness = np.clip(brightness, 0, 1)

    # Initialize RGBA output (H, W, 4)
    out = np.zeros((height, width, 4), dtype=np.uint8)

    # Color pixels where selected bands are dominant
    for i, band_idx in enumerate(selected_bands):
        if band_idx >= len(YEAR_COLORS):
            continue
        # dominant_idx is index into selected_bands array, so compare with i
        is_this_dominant = (dominant_idx == i) & has_activity & is_dominant_enough
        color = YEAR_COLORS[band_idx]
        out[is_this_dominant, 0] = (brightness[is_this_dominant] * color[0]).astype(np.uint8)
        out[is_this_dominant, 1] = (brightness[is_this_dominant] * color[1]).astype(np.uint8)
        out[is_this_dominant, 2] = (brightness[is_this_dominant] * color[2]).astype(np.uint8)
        out[is_this_dominant, 3] = 255

    # Gray for mixed pixels
    gray_value = (brightness * 200).astype(np.uint8)
    out[is_gray, 0] = gray_value[is_gray]
    out[is_gray, 1] = gray_value[is_gray]
    out[is_gray, 2] = gray_value[is_gray]
    out[is_gray, 3] = 255

    return out


# Create FastAPI app
app = FastAPI(
    title="Albedo Tile Server",
    description="Vessel activity tiles for Northern Sea Route",
    lifespan=lifespan,
)

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "categories": list(cog_readers.keys())}


@app.get("/api/categories")
async def get_categories():
    """Get available vessel categories."""
    categories = load_categories()
    # Only return categories that have COG files
    available = []
    for cat in categories:
        if cat["id"] in cog_readers:
            available.append(cat)
    return JSONResponse(content={"categories": available})


@app.get("/api/vessels")
async def get_vessels(
    lat: float = Query(..., description="Latitude"),
    lon: float = Query(..., description="Longitude"),
    year: int | None = Query(default=None, description="Filter by year"),
):
    """Query vessels at a given grid cell location.

    Returns vessels that have been detected at the 0.01° grid cell
    containing the given coordinates.
    """
    if not db_conn:
        return JSONResponse(
            content={"error": "Database not available"},
            status_code=503,
        )

    # Snap to grid cell using round() to match database storage
    grid_lat = round(lat, 2)
    grid_lon = round(lon, 2)

    # Search within one grid cell in each direction to handle rounding edge cases
    tolerance = GRID_RESOLUTION

    # Determine table name (vessel_lookup for prod, vessel_positions for dev)
    # Check which table exists
    tables = db_conn.execute("SHOW TABLES").fetchall()
    table_names = [t[0] for t in tables]
    use_lookup = "vessel_lookup" in table_names

    if use_lookup:
        # Pre-aggregated lookup table (production)
        query = """
            SELECT mmsi, ship_name, flag, vessel_type, year, total_hours
            FROM vessel_lookup
            WHERE lat BETWEEN ? AND ?
              AND lon BETWEEN ? AND ?
        """
    else:
        # Full table with aggregation (development)
        query = """
            SELECT mmsi, ship_name, flag, vessel_type, year, SUM(hours) as total_hours
            FROM vessel_positions
            WHERE lat BETWEEN ? AND ?
              AND lon BETWEEN ? AND ?
        """

    params = [
        grid_lat - tolerance,
        grid_lat + tolerance,
        grid_lon - tolerance,
        grid_lon + tolerance,
    ]

    if year is not None:
        query += " AND year = ?"
        params.append(year)

    if use_lookup:
        query += " ORDER BY total_hours DESC LIMIT 10"
    else:
        query += """
            GROUP BY mmsi, ship_name, flag, vessel_type, year
            ORDER BY total_hours DESC
            LIMIT 10
        """

    try:
        result = db_conn.execute(query, params).fetchall()
        vessels = [
            {
                "mmsi": row[0],
                "ship_name": row[1],
                "flag": row[2],
                "vessel_type": row[3],
                "year": row[4],
                "total_hours": round(row[5], 1),
            }
            for row in result
        ]
        return JSONResponse(content={"vessels": vessels, "grid": {"lat": grid_lat, "lon": grid_lon}})
    except Exception as e:
        logger.error(f"Vessel query error: {e}")
        return JSONResponse(
            content={"error": "Query failed"},
            status_code=500,
        )


@app.get("/tiles/{z}/{x}/{y}.png")
async def tile(
    z: int,
    x: int,
    y: int,
    years: str = Query(default="", description="Comma-separated band indices to show (0,1,2)"),
    category: str = Query(default="all", description="Vessel category ID"),
):
    """Serve colorized vessel activity tiles."""
    reader = cog_readers.get(category)
    if not reader:
        reader = cog_readers.get("all")
    if not reader:
        return Response(status_code=404, content="No tile data available")

    try:
        img = reader.tile(x, y, z, tilesize=256, resampling_method="bilinear")

        # Colorize and encode to PNG
        rgba = colorize_tile(img.array, years)
        pil_img = Image.fromarray(rgba, mode="RGBA")
        buf = BytesIO()
        pil_img.save(buf, format="PNG", optimize=True)

        cache_time = 86400 if not years and category == "all" else 300
        return Response(
            content=buf.getvalue(),
            media_type="image/png",
            headers={"Cache-Control": f"public, max-age={cache_time}"},
        )
    except Exception as e:
        if "outside bounds" not in str(e).lower():
            logger.warning(f"Tile error {z}/{x}/{y}: {e}")
        return Response(status_code=204)


@app.get("/")
async def index():
    """Serve index.html"""
    return FileResponse(STATIC_ROOT / "index.html")


@app.get("/data/{path:path}")
async def data_files(path: str):
    """Serve data files (pmtiles, geojson, etc.)"""
    file_path = DATA_ROOT / path
    if file_path.exists():
        return FileResponse(file_path)
    return Response(status_code=404)


# Mount static files (must be last to not override other routes)
app.mount("/", StaticFiles(directory=str(STATIC_ROOT), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    print(f"Starting tile server at http://0.0.0.0:{port}")
    print(f"Serving static files from: {STATIC_ROOT}")
    uvicorn.run(app, host="0.0.0.0", port=port)
