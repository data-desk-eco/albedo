#!/usr/bin/env python3
"""Tile server for COG with static file serving"""
from flask import Flask, send_file, make_response, Response
from flask_cors import CORS
from rio_tiler.io import Reader
import os

app = Flask(__name__, static_folder='.')
CORS(app)

COG_PATH = './data/vessel_heatmap.tif'

@app.route('/tiles/<int:z>/<int:x>/<int:y>.png')
def tiles(z, x, y):
    """Serve raster tiles from COG"""
    try:
        with Reader(COG_PATH) as cog:
            # Read tile
            img = cog.tile(x, y, z, tilesize=256)

            # Render to PNG
            png_data = img.render(img_format="PNG")

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
    return send_file('index.html')

@app.route('/<path:path>')
def static_files(path):
    """Serve static files"""
    return send_file(path)

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print("Starting tile server at http://localhost:8000")
    print("Tiles available at /tiles/{z}/{x}/{y}.png")
    app.run(host='0.0.0.0', port=8000, debug=True)
