#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "Building static deployment bundle..."

# Load environment variables
source .env

# Create deployment directory
DEPLOY_DIR="dist"
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"

# Generate static XYZ tiles from COG
echo "Generating static XYZ tiles from vessel heatmap..."
echo "  (This may take a few minutes...)"

# Convert to 8-bit with bright pink colormap (matching tile server)
echo "Converting to 8-bit with bright pink colormap..."

# First create 8-bit grayscale with clipped scaling
gdal_translate \
  -of GTiff \
  -ot Byte \
  -scale 0 1000 0 255 \
  data/vessel_heatmap.tif \
  data/vessel_heatmap_8bit.tif

# Create color relief with bright gradient from pink to white
# Format: value R G B alpha
# More granular steps and brighter overall for better visibility
cat > data/color_relief.txt << 'EOF'
0 0 0 0 0
1 180 0 180 255
20 200 0 200 255
40 220 0 220 255
60 235 0 235 255
80 245 20 245 255
100 255 40 255 255
130 255 80 255 255
160 255 120 255 255
190 255 160 255 255
220 255 200 255 255
255 255 230 255 255
nv 0 0 0 0
EOF

echo "Applying bright pink colormap..."
gdaldem color-relief \
  -alpha \
  -nearest_color_entry \
  data/vessel_heatmap_8bit.tif \
  data/color_relief.txt \
  data/vessel_heatmap_colored.tif

# Create VRT for gdal2tiles
gdal_translate \
  -of VRT \
  data/vessel_heatmap_colored.tif \
  data/vessel_heatmap_8bit.vrt

# Generate tiles with gdal2tiles
# -z: zoom levels (0-8 is reasonable for Arctic focus)
# -r: resampling method (nearest preserves the discrete pixel look)
# -w: don't generate OpenLayers viewer HTML
# --xyz: use XYZ tile scheme instead of TMS (matches MapLibre expectations)
gdal2tiles.py \
  -z 0-8 \
  -r near \
  -w none \
  --xyz \
  --processes=4 \
  data/vessel_heatmap_8bit.vrt \
  "$DEPLOY_DIR/tiles/"

# Clean up temp files
rm -f data/vessel_heatmap_8bit.vrt data/vessel_heatmap_8bit.tif data/vessel_heatmap_colored.tif data/color_relief.txt

echo "✓ Generated static tiles (zoom 0-8)"

# Copy PMTiles files
echo "Copying vector tiles..."
mkdir -p "$DEPLOY_DIR/data"
cp data/protected_areas.pmtiles "$DEPLOY_DIR/data/"
cp data/land.pmtiles "$DEPLOY_DIR/data/"

# Copy and modify HTML for static deployment
echo "Copying and modifying index.html for static deployment..."
cp index.html "$DEPLOY_DIR/"

# Update tile paths to work with static deployment (remove ./ prefix)
sed -i '' "s|tiles: \['\./tiles|tiles: ['tiles|g" "$DEPLOY_DIR/index.html"
sed -i '' "s|pmtiles://\./data/|pmtiles://data/|g" "$DEPLOY_DIR/index.html"

# Count tiles
TILE_COUNT=$(find "$DEPLOY_DIR/tiles" -name "*.png" | wc -l | tr -d ' ')
DEPLOY_SIZE=$(du -sh "$DEPLOY_DIR" | cut -f1)

echo ""
echo "✓ Static bundle ready in $DEPLOY_DIR/"
echo "  • $TILE_COUNT PNG tiles"
echo "  • 2 PMTiles files (vector data)"
echo "  • Total size: $DEPLOY_SIZE"
echo ""
echo "Deploy to your VPS:"
echo "  rsync -avz --delete $DEPLOY_DIR/ user@server:/var/www/albedo/"
echo ""
echo "Or test locally (PMTiles require range request support):"
echo "  npx http-server $DEPLOY_DIR -p 8000 --cors"
echo ""
echo "Note: Python's simple HTTP server doesn't support range requests needed by PMTiles."
