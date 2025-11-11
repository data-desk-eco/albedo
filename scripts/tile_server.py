#!/usr/bin/env python3
"""Tile server for COG with static file serving"""
from flask import Flask, send_file, Response, request
from flask_cors import CORS
from rio_tiler.io import Reader
from rio_tiler.colormap import cmap
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

app = Flask(__name__, static_folder=PROJECT_ROOT, static_url_path='')
CORS(app)

COG_PATH = os.path.join(PROJECT_ROOT, 'data/vessel_heatmap.tif')

# Define custom colormaps with aggressive low-end boosting for visibility
# Using logarithmic-style stops to make low activity areas pop
COLORMAPS = {
    'blue': {
        0: (0, 0, 0, 0),
        0.1: (0, 0, 180, 255),    # Boosted: was 64
        1: (0, 0, 220, 255),       # Boosted: was 128
        10: (0, 0, 240, 255),      # Boosted: was 192
        100: (0, 0, 255, 255),
        404475: (0, 0, 255, 255),
    },
    'aqua': {
        0: (0, 0, 0, 0),
        0.1: (0, 200, 200, 255),   # Boosted: bright cyan even at 0.1 hours
        1: (0, 230, 230, 255),     # Boosted: very bright
        10: (0, 250, 250, 255),    # Boosted: nearly full
        100: (0, 255, 255, 255),
        404475: (0, 255, 255, 255),
    },
    'white': {
        0: (0, 0, 0, 0),
        0.1: (255, 255, 255, 255),  # Pure white at even lowest values
        1: (255, 255, 255, 255),
        10: (255, 255, 255, 255),
        100: (255, 255, 255, 255),
        404475: (255, 255, 255, 255),
    },
    'red': {
        0: (0, 0, 0, 0),
        0.1: (180, 0, 0, 255),     # Boosted
        1: (220, 0, 0, 255),       # Boosted
        10: (240, 0, 0, 255),      # Boosted
        100: (255, 0, 0, 255),
        404475: (255, 0, 0, 255),
    },
    'green': {
        0: (0, 0, 0, 0),
        0.1: (0, 180, 0, 255),     # Boosted
        1: (0, 220, 0, 255),       # Boosted
        10: (0, 240, 0, 255),      # Boosted
        100: (0, 255, 0, 255),
        404475: (0, 255, 0, 255),
    },
    'yellow': {
        0: (0, 0, 0, 0),
        0.1: (255, 255, 0, 255),   # Bright yellow at lowest values
        1: (255, 255, 0, 255),
        10: (255, 255, 0, 255),
        100: (255, 255, 0, 255),
        404475: (255, 255, 0, 255),
    },
    'grayscale': {
        0: (0, 0, 0, 0),
        0.1: (160, 160, 160, 255), # Boosted
        1: (200, 200, 200, 255),   # Boosted
        10: (230, 230, 230, 255),  # Boosted
        100: (255, 255, 255, 255),
        404475: (255, 255, 255, 255),
    },
    'viridis': cmap.get('viridis'),
    'plasma': cmap.get('plasma'),
}

@app.route('/tiles/<int:z>/<int:x>/<int:y>.png')
def tiles(z, x, y):
    """Serve raster tiles from COG with dynamic colormap"""
    try:
        # Get colormap from query parameter (default: blue)
        colormap_name = request.args.get('colormap', 'blue')
        colormap = COLORMAPS.get(colormap_name, COLORMAPS['blue'])

        with Reader(COG_PATH) as cog:
            # Read tile with nearest-neighbor resampling for crisp pixels
            img = cog.tile(x, y, z, tilesize=256, resampling_method="nearest")

            # Render to PNG with colormap
            png_data = img.render(img_format="PNG", colormap=colormap)

            response = Response(png_data, mimetype='image/png')
            response.headers['Cache-Control'] = 'public, max-age=86400'
            response.headers['Access-Control-Allow-Origin'] = '*'
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
    print(f"Starting tile server at http://localhost:8000")
    print(f"Serving from: {PROJECT_ROOT}")
    app.run(host='0.0.0.0', port=8000, debug=True)
