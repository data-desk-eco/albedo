#!/usr/bin/env python3
"""Shared utilities for raster generation."""

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RasterConfig:
    """Configuration for Arctic vessel activity rasters."""
    min_lon: float = -180.0
    max_lon: float = 180.0
    min_lat: float = 56.0
    max_lat: float = 90.0
    resolution: float = 0.01

    @property
    def width(self) -> int:
        return int((self.max_lon - self.min_lon) / self.resolution)

    @property
    def height(self) -> int:
        return int((self.max_lat - self.min_lat) / self.resolution)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """Returns (west, south, east, north)."""
        return (self.min_lon, self.min_lat, self.max_lon, self.max_lat)

    @property
    def transform(self):
        return from_bounds(*self.bounds, self.width, self.height)

    def lonlat_to_pixel(self, lon: float, lat: float) -> tuple[int, int]:
        """
        Convert lon/lat to pixel coordinates.

        Uses round() to avoid floating point precision errors that cause banding.
        Returns (col, row) where (0,0) is top-left.
        """
        col = round((lon - self.min_lon) / self.resolution)
        row = round((self.max_lat - lat) / self.resolution)
        return col, row

    def is_valid_pixel(self, col: int, row: int) -> bool:
        """Check if pixel coordinates are within bounds."""
        return 0 <= col < self.width and 0 <= row < self.height

    def create_array(self) -> np.ndarray:
        """Create an empty raster array."""
        return np.zeros((self.height, self.width), dtype=np.float32)


# Default configuration instance
ARCTIC_CONFIG = RasterConfig()


def write_raster(
    output_path: Path | str,
    arrays: dict[int, np.ndarray] | np.ndarray,
    config: RasterConfig = ARCTIC_CONFIG,
    compress: str = "deflate",
) -> None:
    """
    Write raster array(s) to a GeoTIFF.

    Args:
        output_path: Path to output file
        arrays: Either a single 2D array, or dict mapping band index (1-based) to arrays
        config: Raster configuration
        compress: Compression method
    """
    if isinstance(arrays, np.ndarray):
        arrays = {1: arrays}

    num_bands = len(arrays)

    with rasterio.open(
        str(output_path),
        "w",
        driver="GTiff",
        height=config.height,
        width=config.width,
        count=num_bands,
        dtype=rasterio.float32,
        crs="EPSG:4326",
        transform=config.transform,
        nodata=0.0,
        compress=compress,
        tiled=True,
        bigtiff="IF_SAFER",
    ) as dst:
        for band_idx, array in arrays.items():
            dst.write(array, band_idx)


def print_raster_stats(array: np.ndarray, label: str = "") -> None:
    """Print statistics about a raster array."""
    nonzero = np.count_nonzero(array)
    total = array.size
    prefix = f"{label}: " if label else ""
    print(f"  {prefix}{nonzero:,} cells with data ({100*nonzero/total:.2f}%)")
    if nonzero > 0:
        print(f"  {prefix}range: {array[array > 0].min():.2f} - {array.max():.2f}")
