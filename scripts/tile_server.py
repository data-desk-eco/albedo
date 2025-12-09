#!/usr/bin/env python3
"""Tile server for COG with static file serving"""
from flask import Flask, send_from_directory, Response
from flask_cors import CORS
from rio_tiler.io import Reader
import os
import numpy as np

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# In production (Docker), serve from dist/; in dev, serve from project root
SERVE_DIST = os.environ.get('SERVE_DIST', '').lower() in ('1', 'true')
STATIC_ROOT = os.path.join(PROJECT_ROOT, 'dist') if SERVE_DIST else PROJECT_ROOT

app = Flask(__name__)
CORS(app)

COG_PATH = os.path.join(PROJECT_ROOT, 'data/vessel_heatmap.tif')

# Year colors for multi-band raster (RGB tuples) - no transparency
# Band 1 = 2022 (Cyan), Band 2 = 2023 (Green), Band 3 = 2024 (Magenta/Pink)
YEAR_COLORS = [
    (0, 255, 255),    # 2022 - Cyan (oldest)
    (0, 255, 0),      # 2023 - Green (middle)
    (255, 0, 255),    # 2024 - Magenta/Pink (latest)
]

# Map year to band index
YEAR_TO_BAND = {
    2022: 0,
    2023: 1,
    2024: 2,
}

# Single-band colormap (bright pink gradient) - fallback for single-band rasters
COLOR_STOPS = np.array([
    [0, 0, 0, 0, 0],              # value, R, G, B, A - transparent background
    [0.25, 180, 0, 180, 255],     # Very low values - bright magenta
    [20, 200, 0, 200, 255],
    [40, 220, 0, 220, 255],
    [60, 235, 0, 235, 255],
    [80, 245, 20, 245, 255],
    [100, 255, 40, 255, 255],
    [130, 255, 80, 255, 255],
    [160, 255, 120, 255, 255],
    [190, 255, 160, 255, 255],
    [220, 255, 200, 255, 255],
    [255, 255, 230, 255, 255],
], dtype=np.float32)


def apply_colormap(data):
    """Apply colormap for single-band raster using numpy interp."""
    scaled = data / 1000.0 * 255.0
    scaled = np.where(data > 0, np.maximum(scaled, 0.25), 0)
    scaled = np.clip(scaled, 0, 255)

    r = np.interp(scaled, COLOR_STOPS[:, 0], COLOR_STOPS[:, 1])
    g = np.interp(scaled, COLOR_STOPS[:, 0], COLOR_STOPS[:, 2])
    b = np.interp(scaled, COLOR_STOPS[:, 0], COLOR_STOPS[:, 3])
    a = np.interp(scaled, COLOR_STOPS[:, 0], COLOR_STOPS[:, 4])

    return np.stack([r, g, b, a], axis=0).astype(np.uint8)


def apply_single_year_colormap(data, band_index):
    """Colorize a single band (year) with its designated color.

    Shows pixels where this year was dominant (>=60%) in color,
    plus gray pixels where no year was dominant.
    """
    num_bands = min(data.shape[0], len(YEAR_COLORS))
    height, width = data.shape[1], data.shape[2]
    color = YEAR_COLORS[band_index]

    # Get all bands to calculate dominance
    bands = np.array([data[i].astype(np.float32) for i in range(num_bands)])
    total = np.sum(bands, axis=0)
    has_activity = total > 0

    # Calculate proportion of each year
    safe_total = np.where(total > 0, total, 1)
    proportions = bands / safe_total

    # Find dominant year and its proportion
    dominant_band = np.argmax(bands, axis=0)
    dominant_proportion = np.max(proportions, axis=0)

    DOMINANCE_THRESHOLD = 0.6
    is_dominant_enough = dominant_proportion >= DOMINANCE_THRESHOLD
    is_this_year_dominant = (dominant_band == band_index) & has_activity & is_dominant_enough
    is_gray = has_activity & ~is_dominant_enough

    # Brightness based on total activity (log scale)
    brightness = np.log1p(total) / np.log1p(50)
    brightness = np.where(has_activity, np.maximum(brightness, 0.7), 0)
    brightness = np.clip(brightness, 0, 1)

    # Initialize output RGBA
    out = np.zeros((4, height, width), dtype=np.float32)

    # Apply color where this year is dominant
    out[0] = np.where(is_this_year_dominant, brightness * color[0], 0)
    out[1] = np.where(is_this_year_dominant, brightness * color[1], 0)
    out[2] = np.where(is_this_year_dominant, brightness * color[2], 0)

    # Gray for mixed pixels
    gray_value = brightness * 200
    out[0] = np.where(is_gray, gray_value, out[0])
    out[1] = np.where(is_gray, gray_value, out[1])
    out[2] = np.where(is_gray, gray_value, out[2])

    # Opacity for dominant or gray pixels
    out[3] = np.where(is_this_year_dominant | is_gray, 255, 0)

    return out.astype(np.uint8)


def apply_multiband_colormap_filtered(data, selected_bands):
    """Colorize multi-band raster showing only selected bands/years.

    Shows pixels where one of the selected years was dominant (>=60%) in color,
    plus gray pixels where no year was dominant.
    """
    num_bands = min(data.shape[0], len(YEAR_COLORS))
    height, width = data.shape[1], data.shape[2]

    # Get ALL bands to calculate true dominance
    all_bands = np.array([data[i].astype(np.float32) for i in range(num_bands)])
    total = np.sum(all_bands, axis=0)
    has_activity = total > 0

    # Calculate proportion of each year against total
    safe_total = np.where(total > 0, total, 1)
    all_proportions = all_bands / safe_total

    # Find which year is dominant overall
    dominant_band = np.argmax(all_bands, axis=0)
    dominant_proportion = np.max(all_proportions, axis=0)

    # Dominance threshold
    DOMINANCE_THRESHOLD = 0.6
    is_dominant_enough = dominant_proportion >= DOMINANCE_THRESHOLD
    is_gray = has_activity & ~is_dominant_enough

    # Brightness based on total activity (log scale)
    brightness = np.log1p(total) / np.log1p(50)
    brightness = np.where(has_activity, np.maximum(brightness, 0.7), 0)
    brightness = np.clip(brightness, 0, 1)

    # Initialize output RGBA
    out = np.zeros((4, height, width), dtype=np.float32)

    # Only show pixels where one of the SELECTED bands is dominant
    for band_idx in selected_bands:
        is_this_dominant = (dominant_band == band_idx) & has_activity & is_dominant_enough
        color = YEAR_COLORS[band_idx]
        out[0] = np.where(is_this_dominant, brightness * color[0], out[0])
        out[1] = np.where(is_this_dominant, brightness * color[1], out[1])
        out[2] = np.where(is_this_dominant, brightness * color[2], out[2])
        out[3] = np.where(is_this_dominant, 255, out[3])

    # Gray for mixed pixels (no year dominant)
    gray_value = brightness * 200
    out[0] = np.where(is_gray, gray_value, out[0])
    out[1] = np.where(is_gray, gray_value, out[1])
    out[2] = np.where(is_gray, gray_value, out[2])
    out[3] = np.where(is_gray, 255, out[3])

    return out.astype(np.uint8)


def apply_multiband_colormap(data):
    """Colorize multi-band raster with dominant year coloring.

    Pixels where one year has >=60% of activity get that year's color.
    Otherwise pixels show as gray. Brightness based on total activity.
    2022 = Cyan, 2023 = Green, 2024 = Magenta/Pink
    """
    num_bands = min(data.shape[0], len(YEAR_COLORS))
    height, width = data.shape[1], data.shape[2]

    # Get activity for each year
    bands = np.array([data[i].astype(np.float32) for i in range(num_bands)])

    # Total activity for brightness scaling
    total = np.sum(bands, axis=0)
    has_activity = total > 0

    # Calculate proportion of each year
    safe_total = np.where(total > 0, total, 1)
    proportions = bands / safe_total

    # Find dominant year and its proportion
    dominant = np.argmax(bands, axis=0)
    dominant_proportion = np.max(proportions, axis=0)

    # Dominance threshold - must have >=60% to get color
    DOMINANCE_THRESHOLD = 0.6
    is_dominant_enough = dominant_proportion >= DOMINANCE_THRESHOLD

    # Brightness based on total activity (log scale) - boosted
    brightness = np.log1p(total) / np.log1p(50)  # Lower divisor = brighter
    brightness = np.where(has_activity, np.maximum(brightness, 0.7), 0)  # Higher minimum
    brightness = np.clip(brightness, 0, 1)

    # Initialize output RGBA
    out = np.zeros((4, height, width), dtype=np.float32)

    # Assign color based on dominant year (only if dominant enough)
    for i in range(num_bands):
        is_this_dominant = (dominant == i) & has_activity & is_dominant_enough
        color = YEAR_COLORS[i]
        out[0] = np.where(is_this_dominant, brightness * color[0], out[0])
        out[1] = np.where(is_this_dominant, brightness * color[1], out[1])
        out[2] = np.where(is_this_dominant, brightness * color[2], out[2])

    # Gray for mixed pixels (not dominant enough)
    is_gray = has_activity & ~is_dominant_enough
    gray_value = brightness * 200
    out[0] = np.where(is_gray, gray_value, out[0])
    out[1] = np.where(is_gray, gray_value, out[1])
    out[2] = np.where(is_gray, gray_value, out[2])

    # Full opacity for pixels with activity, transparent for empty
    out[3] = np.where(has_activity, 255, 0)

    return out.astype(np.uint8)


@app.route('/tiles/<int:z>/<int:x>/<int:y>.png')
def tiles(z, x, y):
    """Serve raster tiles from COG with colormap.

    Query params:
        years: comma-separated list of years to show (e.g., "2022,2024")
               If not provided, shows all years.
    """
    import time
    from io import BytesIO
    from PIL import Image
    from flask import request
    start = time.time()

    # Parse years filter
    years_param = request.args.get('years', '')
    if years_param:
        try:
            selected_years = [int(y) for y in years_param.split(',')]
            selected_bands = [YEAR_TO_BAND[y] for y in selected_years if y in YEAR_TO_BAND]
        except (ValueError, KeyError):
            selected_bands = None  # Show all on invalid input
    else:
        selected_bands = None  # Show all

    try:
        with Reader(COG_PATH) as cog:
            # Read tile with nearest-neighbor resampling for crisp pixels
            img = cog.tile(x, y, z, tilesize=256, resampling_method="nearest")

            if img.data.shape[0] == 1:
                # Single band - use original colormap
                colored_data = apply_colormap(img.data[0])
            elif selected_bands is not None and len(selected_bands) == 1:
                # Single year selected - use single year colormap
                colored_data = apply_single_year_colormap(img.data, selected_bands[0])
            elif selected_bands is not None and len(selected_bands) > 1:
                # Multiple specific years - filter and use multiband
                colored_data = apply_multiband_colormap_filtered(img.data, selected_bands)
            else:
                # All years - use standard multiband colormap
                colored_data = apply_multiband_colormap(img.data)

            # Convert to PIL Image and save as PNG
            pil_img = Image.fromarray(colored_data.transpose(1, 2, 0), mode='RGBA')
            buf = BytesIO()
            pil_img.save(buf, format='PNG', optimize=True)
            png_data = buf.getvalue()

            response = Response(png_data, mimetype='image/png')
            # Cache unfiltered tiles longer, filtered tiles shorter
            if selected_bands is None:
                response.headers['Cache-Control'] = 'public, max-age=86400'
            else:
                response.headers['Cache-Control'] = 'public, max-age=300'
            response.headers['Access-Control-Allow-Origin'] = '*'

            elapsed = time.time() - start
            print(f"Tile {z}/{x}/{y} (years={years_param or 'all'}): {elapsed*1000:.0f}ms")

            return response

    except Exception as e:
        print(f"Error serving tile {z}/{x}/{y}: {e}")
        # Return 204 No Content for missing tiles (common at edges)
        return Response(status=204)

DATA_ROOT = os.path.join(PROJECT_ROOT, 'data')

@app.route('/')
def index():
    """Serve index.html"""
    return send_from_directory(STATIC_ROOT, 'index.html')

@app.route('/data/<path:path>')
def data_files(path):
    """Serve data files (pmtiles, etc.)"""
    return send_from_directory(DATA_ROOT, path)

@app.route('/<path:path>')
def static_files(path):
    """Serve static files"""
    return send_from_directory(STATIC_ROOT, path)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    print(f"Starting tile server at http://0.0.0.0:{port}")
    print(f"Serving static files from: {STATIC_ROOT}")
    print(f"Serving tiles from: {COG_PATH}")
    app.run(host='0.0.0.0', port=port, debug=False)
