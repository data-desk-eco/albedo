#!/usr/bin/env python3
"""Tile server for COG using FastAPI + rio-tiler"""
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
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from rio_tiler.io import Reader

warnings.filterwarnings("ignore", message=".*NoData.*")
logging.getLogger("rasterio._err").setLevel(logging.ERROR)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).parent.parent
DATA_ROOT = PROJECT_ROOT / "data"
COG_PATH = DATA_ROOT / "vessel_heatmap.tif"

cog_reader: Reader | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage COG reader lifecycle."""
    global cog_reader
    cog_reader = Reader(str(COG_PATH))
    logger.info(f"COG reader initialized: {COG_PATH}")
    yield
    cog_reader.close()
    logger.info("COG reader closed")


SERVE_DIST = os.environ.get("SERVE_DIST", "").lower() in ("1", "true")
STATIC_ROOT = PROJECT_ROOT / "dist" if SERVE_DIST else PROJECT_ROOT

# Year colors (RGB) - must match YEAR_COLORS in src/main.js
# Band 0=2022 (cyan), Band 1=2023 (green), Band 2=2024 (magenta)
YEAR_COLORS = np.array([
    [0, 255, 255],    # 2022
    [0, 255, 0],      # 2023
    [255, 0, 255],    # 2024
], dtype=np.float32)

YEAR_TO_BAND = {2022: 0, 2023: 1, 2024: 2}


def colorize_tile(data: np.ndarray, years: str = "") -> np.ndarray:
    """Colorize multi-band raster by year dominance.

    Returns RGBA array in (H, W, 4) format for PIL.
    """
    num_bands = min(data.shape[0], len(YEAR_COLORS))
    height, width = data.shape[1], data.shape[2]

    # Parse selected bands
    if years:
        try:
            selected_years = [int(y) for y in years.split(",")]
            selected_bands = [YEAR_TO_BAND[y] for y in selected_years if y in YEAR_TO_BAND]
        except (ValueError, KeyError):
            selected_bands = list(range(num_bands))
    else:
        selected_bands = list(range(num_bands))

    # Get all bands for dominance calculation
    bands = np.array([data[i].astype(np.float32) for i in range(num_bands)])
    total = np.sum(bands, axis=0)
    has_activity = total > 0

    # Calculate proportions
    safe_total = np.where(total > 0, total, 1)
    proportions = bands / safe_total

    # Find dominant year
    dominant_band = np.argmax(bands, axis=0)
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
    for band_idx in selected_bands:
        is_this_dominant = (dominant_band == band_idx) & has_activity & is_dominant_enough
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/tiles/{z}/{x}/{y}.png")
async def tile(
    z: int,
    x: int,
    y: int,
    years: str = Query(default="", description="Comma-separated years to show"),
):
    """Serve colorized vessel activity tiles."""
    try:
        img = cog_reader.tile(x, y, z, tilesize=256, resampling_method="nearest")

        # Colorize and encode to PNG
        rgba = colorize_tile(img.array, years)
        pil_img = Image.fromarray(rgba, mode="RGBA")
        buf = BytesIO()
        pil_img.save(buf, format="PNG", optimize=True)

        return Response(
            content=buf.getvalue(),
            media_type="image/png",
            headers={
                "Cache-Control": "public, max-age=86400" if not years else "public, max-age=300",
            },
        )
    except Exception as e:
        # TileOutsideBounds is expected for edge tiles, don't log
        if "outside bounds" not in str(e).lower():
            logger.warning(f"Tile error {z}/{x}/{y}: {e}")
        return Response(status_code=204)


@app.get("/")
async def index():
    """Serve index.html"""
    return FileResponse(STATIC_ROOT / "index.html")


@app.get("/data/{path:path}")
async def data_files(path: str):
    """Serve data files (pmtiles, etc.)"""
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
    print(f"Serving tiles from: {COG_PATH}")
    uvicorn.run(app, host="0.0.0.0", port=port)
