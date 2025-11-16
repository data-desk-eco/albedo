#!/usr/bin/env python3
"""Tile server for COG with static file serving"""
from flask import Flask, send_file, Response, request
from flask_cors import CORS
from rio_tiler.io import Reader
from rio_tiler.colormap import cmap
from werkzeug.middleware.dispatcher import DispatcherMiddleware
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Support deployment under /arctic-shipping path
PATH_PREFIX = os.environ.get('PATH_PREFIX', '')

app = Flask(__name__, static_folder=PROJECT_ROOT, static_url_path='')
CORS(app)

# If deployed under a path prefix, wrap with middleware
if PATH_PREFIX:
    app.wsgi_app = DispatcherMiddleware(
        Flask('dummy'),
        {PATH_PREFIX: app.wsgi_app}
    )

COG_PATH = os.path.join(PROJECT_ROOT, 'data/vessel_heatmap.tif')

# Bright pink colormap - all points same color
COLORMAP = {
    0: (0, 0, 0, 0),          # No activity = transparent
    0.1: (255, 0, 255, 255),  # Bright pink at all activity levels
    1: (255, 0, 255, 255),
    10: (255, 0, 255, 255),
    100: (255, 0, 255, 255),
    404475: (255, 0, 255, 255),
}

@app.route('/tiles/<int:z>/<int:x>/<int:y>.png')
def tiles(z, x, y):
    """Serve raster tiles from COG with bright pink colormap"""
    try:

        with Reader(COG_PATH) as cog:
            # Read tile with nearest-neighbor resampling for crisp pixels
            img = cog.tile(x, y, z, tilesize=256, resampling_method="nearest")

            # Render to PNG with bright pink colormap
            png_data = img.render(img_format="PNG", colormap=COLORMAP)

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
    port = int(os.environ.get('PORT', 8000))
    print(f"Starting tile server at http://0.0.0.0:{port}")
    print(f"Serving from: {PROJECT_ROOT}")
    app.run(host='0.0.0.0', port=port, debug=False)
