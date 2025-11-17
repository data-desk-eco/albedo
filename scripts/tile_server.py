#!/usr/bin/env python3
"""Tile server for COG with static file serving"""
from flask import Flask, send_file, Response
from flask_cors import CORS
from rio_tiler.io import Reader
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

app = Flask(__name__, static_folder=PROJECT_ROOT, static_url_path='')
CORS(app)

COG_PATH = os.path.join(PROJECT_ROOT, 'data/vessel_heatmap.tif')

# Bright pink gradient colormap - matching static build
# Use numpy colormaps for fast interpolation
import numpy as np

# Color stops from static build (8-bit values)
# Adjusted to ensure low-value pixels (sparse vessel activity) are visible
COLOR_STOPS = np.array([
    [0, 0, 0, 0, 0],              # value, R, G, B, A - transparent background
    [0.25, 180, 0, 180, 255],     # Very low values - bright magenta (increased from 1)
    [20, 200, 0, 200, 255],
    [40, 220, 0, 220, 255],
    [60, 235, 0, 235, 255],
    [80, 245, 20, 245, 255],
    [100, 255, 40, 255, 255],
    [130, 255, 80, 255, 255],
    [160, 255, 120, 255, 255],
    [190, 255, 160, 255, 255],
    [220, 255, 200, 255, 255],
    [255, 255, 230, 255, 255],     # High values - bright pink/white
], dtype=np.float32)

def apply_colormap(data):
    """Apply colormap using numpy interp for fast interpolation

    Static build: gdal_translate -scale 0 1000 0 255
    Scales raw [0-1000] → 8-bit [0-255], then color relief

    Modified to ensure low-value pixels are visible:
    - Values ≥1 get full opacity bright magenta
    - Values are clamped to at least 0.25 in 8-bit space to avoid near-invisible pixels
    """
    # Scale raw data to 8-bit range, but ensure non-zero values are at least 0.25
    # This makes sparse vessel activity visible
    scaled = data / 1000.0 * 255.0
    scaled = np.where(data > 0, np.maximum(scaled, 0.25), 0)
    scaled = np.clip(scaled, 0, 255)

    # Interpolate each color channel
    r = np.interp(scaled, COLOR_STOPS[:, 0], COLOR_STOPS[:, 1])
    g = np.interp(scaled, COLOR_STOPS[:, 0], COLOR_STOPS[:, 2])
    b = np.interp(scaled, COLOR_STOPS[:, 0], COLOR_STOPS[:, 3])
    a = np.interp(scaled, COLOR_STOPS[:, 0], COLOR_STOPS[:, 4])

    # Stack channels
    return np.stack([r, g, b, a], axis=0).astype(np.uint8)

@app.route('/tiles/<int:z>/<int:x>/<int:y>.png')
def tiles(z, x, y):
    """Serve raster tiles from COG with bright pink colormap"""
    import time
    from io import BytesIO
    from PIL import Image
    start = time.time()

    try:
        with Reader(COG_PATH) as cog:
            # Read tile with nearest-neighbor resampling for crisp pixels
            img = cog.tile(x, y, z, tilesize=256, resampling_method="nearest")

            # Apply custom colormap using numpy interpolation (fast!)
            colored_data = apply_colormap(img.data[0])

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
