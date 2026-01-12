#!/usr/bin/env python3
"""
Generate raster tiles for vessel categories.
Uses shared raster configuration to match main vessel_heatmap.tif exactly.
"""
import json
import subprocess
from pathlib import Path

import duckdb

from raster_utils import ARCTIC_CONFIG, write_raster, print_raster_stats

PROJECT_ROOT = Path(__file__).parent.parent
DATA_ROOT = PROJECT_ROOT / "data"
CATEGORIES_DIR = DATA_ROOT / "vessel_categories"
DB_PATH = DATA_ROOT / "data.duckdb"


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
    config = ARCTIC_CONFIG
    output_path = DATA_ROOT / f"category_{category_id}_heatmap.tif"
    imo_list = ", ".join(f"'{imo}'" for imo in imos)

    print(f"  Querying vessel positions...")
    conn = duckdb.connect(str(DB_PATH), read_only=True)

    df = conn.execute(f"""
        SELECT
            vp.lon,
            vp.lat,
            vp.hours,
            vp.year
        FROM vessel_positions vp
        JOIN vessel_activity va ON vp.vessel_id = va.vessel_id
        WHERE va.imo IN ({imo_list})
          AND vp.lat >= {config.min_lat} AND vp.lat <= {config.max_lat}
    """).fetchdf()
    conn.close()

    if df.empty:
        print(f"  No positions found for category {category_id}")
        return None

    print(f"  Found {len(df)} positions")

    years = sorted(df["year"].unique())
    print(f"  Years: {years}")

    bands = {year: config.create_array() for year in years}

    print(f"  Rasterizing...")
    for _, row in df.iterrows():
        col, row_idx = config.lonlat_to_pixel(row["lon"], row["lat"])

        if config.is_valid_pixel(col, row_idx):
            year = row["year"]
            if year in bands:
                bands[year][row_idx, col] += row["hours"]

    band_arrays = {i + 1: bands[year] for i, year in enumerate(sorted(years))}
    write_raster(output_path, band_arrays, config)

    for i, year in enumerate(sorted(years)):
        print_raster_stats(bands[year], label=f"Band {i+1} ({year})")

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

    input_path.unlink()
    output_path.rename(input_path)

    return input_path


def main():
    categories = load_categories()

    for cat in categories:
        if cat["id"] == "all":
            continue

        print(f"\nProcessing category: {cat['id']}")
        imos = get_category_imos(cat)

        if not imos:
            print(f"  No IMO filter for {cat['id']}, skipping")
            continue

        print(f"  {len(imos)} IMOs in filter")

        raster_path = create_category_raster(cat["id"], imos)

        if raster_path:
            print("  Converting to COG...")
            convert_to_cog(raster_path)
            print(f"  Created: {raster_path.name}")

    print("\nDone!")


if __name__ == "__main__":
    main()
