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
# Static build: gdal_translate -scale 0 1000 0 255, then color relief maps 8-bit values
# Color relief values (0,1,20,40...) are 8-bit (0-255), we need to map back to raw values (0-1000)
# Formula: raw_value = (8bit_value / 255) * 1000
COLORMAP = {
    0: (0, 0, 0, 0),              # No activity = transparent
    3.92: (180, 0, 180, 255),     # 1/255 * 1000 - dark magenta
    78.43: (200, 0, 200, 255),    # 20/255 * 1000
    156.86: (220, 0, 220, 255),   # 40/255 * 1000
    235.29: (235, 0, 235, 255),   # 60/255 * 1000
    313.73: (245, 20, 245, 255),  # 80/255 * 1000
    392.16: (255, 40, 255, 255),  # 100/255 * 1000
    509.80: (255, 80, 255, 255),  # 130/255 * 1000
    627.45: (255, 120, 255, 255), # 160/255 * 1000
    745.10: (255, 160, 255, 255), # 190/255 * 1000
    862.75: (255, 200, 255, 255), # 220/255 * 1000
    1000: (255, 230, 255, 255),   # 255/255 * 1000 - bright pink/white
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
