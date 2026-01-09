#!/usr/bin/env python3
"""Tile server for COG using FastAPI + rio-tiler"""
import json
import logging
import os
import warnings
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path

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

# Year colors (RGB) - colors for years by band index
# Band 0 = oldest year (cyan), Band 1 = middle (green), Band 2 = newest (magenta)
YEAR_COLORS = np.array([
    [0, 255, 255],    # Band 0 - cyan
    [0, 255, 0],      # Band 1 - green
    [255, 0, 255],    # Band 2 - magenta
], dtype=np.float32)

# COG readers for each category
cog_readers: dict[str, Reader] = {}


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
    """Manage COG reader lifecycle."""
    global cog_readers

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

    yield

    for reader in cog_readers.values():
        reader.close()
    logger.info("COG readers closed")


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
        img = reader.tile(x, y, z, tilesize=256, resampling_method="nearest")

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
