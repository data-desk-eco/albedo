#!/usr/bin/env python3
"""Tile server for COG with static file serving"""
from flask import Flask, send_file, Response, request, Blueprint
from flask_cors import CORS
from rio_tiler.io import Reader
from rio_tiler.colormap import cmap
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Support deployment under /albedo path
PATH_PREFIX = os.environ.get('PATH_PREFIX', '').rstrip('/')

# Create blueprint with url_prefix if specified
if PATH_PREFIX:
    bp = Blueprint('albedo', __name__, url_prefix=PATH_PREFIX)
else:
    bp = Blueprint('albedo', __name__)

app = Flask(__name__, static_folder=PROJECT_ROOT, static_url_path='')
CORS(app)

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

@bp.route('/tiles/<int:z>/<int:x>/<int:y>.png')
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

@bp.route('/')
def index():
    """Serve index.html"""
    return send_file(os.path.join(PROJECT_ROOT, 'index.html'))

@bp.route('/<path:path>')
def static_files(path):
    """Serve static files"""
    return send_file(os.path.join(PROJECT_ROOT, path))

# Register blueprint
app.register_blueprint(bp)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    print(f"Starting tile server at http://0.0.0.0:{port}")
    print(f"Serving from: {PROJECT_ROOT}")
    app.run(host='0.0.0.0', port=port, debug=False)
