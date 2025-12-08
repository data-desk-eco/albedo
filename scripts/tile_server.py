#!/usr/bin/env python3
"""Tile server for COG with static file serving"""
from flask import Flask, send_file, Response
from flask_cors import CORS
from rio_tiler.io import Reader
import os
import numpy as np

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

app = Flask(__name__, static_folder=PROJECT_ROOT, static_url_path='')
CORS(app)

COG_PATH = os.path.join(PROJECT_ROOT, 'data/vessel_heatmap.tif')

# Year colors for multi-band raster (RGB tuples)
# Band 1 = oldest year, Band 3 = newest year
YEAR_COLORS = [
    (255, 100, 0),    # Year 1 (oldest) - Orange
    (0, 200, 255),    # Year 2 - Cyan
    (255, 0, 200),    # Year 3 (newest) - Magenta
]

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


def apply_multiband_colormap(data):
    """Colorize multi-band raster with configurable year colors.

    Each input band represents a year's vessel activity hours.
    Output is RGBA with additive color blending.
    """
    num_bands = data.shape[0]
    height, width = data.shape[1], data.shape[2]

    # Initialize output RGBA
    out = np.zeros((4, height, width), dtype=np.float32)

    for i in range(min(num_bands, len(YEAR_COLORS))):
        band = data[i].astype(np.float32)
        # Normalize band values (log scale for better visibility)
        # Use log1p(100) as reference - most values are 1-100 hours
        # Then boost to make even low values visible
        normalized = np.log1p(band) / np.log1p(100)
        # Ensure any non-zero value is visible (min brightness 0.4)
        normalized = np.where(band > 0, np.maximum(normalized, 0.4), 0)
        normalized = np.clip(normalized, 0, 1)

        # Add this year's color contribution
        color = YEAR_COLORS[i]
        out[0] += normalized * color[0]  # R
        out[1] += normalized * color[1]  # G
        out[2] += normalized * color[2]  # B
        out[3] = np.maximum(out[3], normalized * 255)  # A (max of all bands)

    # Clip and convert to uint8
    out[0:3] = np.clip(out[0:3], 0, 255)
    out[3] = np.clip(out[3], 0, 255)

    return out.astype(np.uint8)


@app.route('/tiles/<int:z>/<int:x>/<int:y>.png')
def tiles(z, x, y):
    """Serve raster tiles from COG with colormap"""
    import time
    from io import BytesIO
    from PIL import Image
    start = time.time()

    try:
        with Reader(COG_PATH) as cog:
            # Read tile with nearest-neighbor resampling for crisp pixels
            img = cog.tile(x, y, z, tilesize=256, resampling_method="nearest")

            if img.data.shape[0] == 1:
                # Single band - use original colormap
                colored_data = apply_colormap(img.data[0])
            else:
                # Multi-band - use year color mixing
                colored_data = apply_multiband_colormap(img.data)

            # Convert to PIL Image and save as PNG
            pil_img = Image.fromarray(colored_data.transpose(1, 2, 0), mode='RGBA')
            buf = BytesIO()
            pil_img.save(buf, format='PNG', optimize=True)
            png_data = buf.getvalue()

            response = Response(png_data, mimetype='image/png')
            response.headers['Cache-Control'] = 'public, max-age=86400'
            response.headers['Access-Control-Allow-Origin'] = '*'

            elapsed = time.time() - start
            print(f"Tile {z}/{x}/{y}: {elapsed*1000:.0f}ms")

            return response

    except Exception as e:
        print(f"Error serving tile {z}/{x}/{y}: {e}")
        # Return 204 No Content for missing tiles (common at edges)
        return Response(status=204)

@app.route('/')
def index():
    """Serve index.html"""
    return send_file(os.path.join(PROJECT_ROOT, 'index.html'))

@app.route('/<path:path>')
def static_files(path):
    """Serve static files"""
    return send_file(os.path.join(PROJECT_ROOT, path))

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    print(f"Starting tile server at http://0.0.0.0:{port}")
    print(f"Serving from: {PROJECT_ROOT}")
    app.run(host='0.0.0.0', port=port, debug=False)
