#!/usr/bin/env python3
"""
Generate raster tiles for vessel categories.
Must match the main vessel_heatmap.tif bounds and resolution exactly.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds

PROJECT_ROOT = Path(__file__).parent.parent
DATA_ROOT = PROJECT_ROOT / "data"
CATEGORIES_DIR = DATA_ROOT / "vessel_categories"
DB_PATH = DATA_ROOT / "data.duckdb"

# Must match main raster exactly
# Main raster: 36000 x 3400, origin (-180, 90), pixel size 0.01
BOUNDS = (-180, 56, 180, 90)  # (west, south, east, north)
WIDTH = 36000
HEIGHT = 3400
RESOLUTION = 0.01


def load_categories():
    """Load category definitions."""
    config_path = CATEGORIES_DIR / "categories.json"
    with open(config_path) as f:
        return json.load(f)["categories"]


def get_category_imos(category: dict) -> list[str] | None:
    """Get IMO numbers for a category filter."""
    if not category.get("filter"):
        return None

    filter_config = category["filter"]
    if filter_config["type"] == "imo_list":
        imo_file = CATEGORIES_DIR / filter_config["file"]
        with open(imo_file) as f:
            return [line.strip() for line in f if line.strip()]

    return None


def create_category_raster(category_id: str, imos: list[str]) -> Path:
    """Create a multi-band raster matching main raster dimensions."""
    import duckdb

    output_path = DATA_ROOT / f"category_{category_id}_heatmap.tif"
    imo_list = ", ".join(f"'{imo}'" for imo in imos)

    print(f"  Querying vessel positions...")
    conn = duckdb.connect(str(DB_PATH), read_only=True)

    # Query positions for matching vessels
    df = conn.execute(f"""
        SELECT
            vp.lon,
            vp.lat,
            vp.hours,
            vp.year
        FROM vessel_positions vp
        JOIN vessel_activity va ON vp.vessel_id = va.vessel_id
        WHERE va.imo IN ({imo_list})
          AND vp.lat >= {BOUNDS[1]} AND vp.lat <= {BOUNDS[3]}
    """).fetchdf()
    conn.close()

    if df.empty:
        print(f"  No positions found for category {category_id}")
        return None

    print(f"  Found {len(df)} positions")

    # Get years from data
    years = sorted(df["year"].unique())
    print(f"  Years: {years}")

    # Create per-year arrays
    bands = {year: np.zeros((HEIGHT, WIDTH), dtype=np.float32) for year in years}

    # Aggregate hours into grid cells
    print(f"  Rasterizing...")
    for _, row in df.iterrows():
        col = int((row["lon"] - BOUNDS[0]) / RESOLUTION)
        row_idx = int((BOUNDS[3] - row["lat"]) / RESOLUTION)  # Y flipped (north at top)

        if 0 <= col < WIDTH and 0 <= row_idx < HEIGHT:
            year = row["year"]
            if year in bands:
                bands[year][row_idx, col] += row["hours"]

    # Write multi-band raster
    transform = from_bounds(*BOUNDS, WIDTH, HEIGHT)
    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "width": WIDTH,
        "height": HEIGHT,
        "count": len(years),
        "crs": "EPSG:4326",
        "transform": transform,
        "compress": "deflate",
    }

    with rasterio.open(output_path, "w", **profile) as dst:
        for i, year in enumerate(sorted(years)):
            dst.write(bands[year], i + 1)
            nonzero = np.count_nonzero(bands[year])
            print(f"    Band {i+1}: {year} - {nonzero} cells with data, max {bands[year].max():.0f} hours")

    return output_path


def convert_to_cog(input_path: Path) -> Path:
    """Convert raster to Cloud-Optimized GeoTIFF."""
    output_path = input_path.with_suffix(".cog.tif")

    subprocess.run([
        "gdal_translate",
        "-of", "COG",
        "-co", "COMPRESS=DEFLATE",
        "-co", "PREDICTOR=2",
        "-co", "OVERVIEWS=AUTO",
        "-co", "RESAMPLING=NEAREST",
        str(input_path),
        str(output_path)
    ], check=True)

    # Replace original with COG
    input_path.unlink()
    output_path.rename(input_path)

    return input_path


def main():
    categories = load_categories()

    for cat in categories:
        if cat["id"] == "all":
            continue  # Skip "all" - use main raster

        print(f"\nProcessing category: {cat['id']}")
        imos = get_category_imos(cat)

        if not imos:
            print(f"  No IMO filter for {cat['id']}, skipping")
            continue

        print(f"  {len(imos)} IMOs in filter")

        # Create raster
        raster_path = create_category_raster(cat["id"], imos)

        if raster_path:
            # Convert to COG
            print("  Converting to COG...")
            convert_to_cog(raster_path)
            print(f"  Created: {raster_path.name}")

    print("\nDone!")


if __name__ == "__main__":
    main()
