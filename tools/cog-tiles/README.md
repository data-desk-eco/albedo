# cog-tiles

Client-side COG (Cloud Optimized GeoTIFF) tile renderer for MapLibre GL.

Render COGs directly in the browser without a tile server. Just point at a COG on any static host (S3, GCS, etc.) and get raster tiles.

## Features

- **No server required** - reads COGs via HTTP range requests
- **Automatic overview selection** - uses COG internal pyramids based on zoom
- **EPSG:4326 → Web Mercator reprojection** - handles geographic COGs
- **Pluggable colorization** - built-in colorizers or bring your own
- **MapLibre integration** - protocol handler for seamless tile loading

## Installation

```bash
npm install cog-tiles geotiff
```

`geotiff` is a peer dependency.

## Quick Start

```javascript
import { COGTileSource, colormap } from 'cog-tiles'
import maplibregl from 'maplibre-gl'

// Create source with a colorizer
const cogSource = new COGTileSource('https://example.com/data.tif', {
  colorize: colormap({ min: 0, max: 100 })
})

// Initialize (loads metadata)
await cogSource.initialize()

// Register protocol with MapLibre
const protocol = cogSource.createProtocol('cog')
maplibregl.addProtocol(protocol.name, protocol.handler)

// Add to map
map.addSource('my-data', cogSource.getSourceConfig('cog'))
map.addLayer({
  id: 'my-data-layer',
  type: 'raster',
  source: 'my-data'
})
```

## API

### `COGTileSource`

Main class for rendering COG tiles.

```javascript
const source = new COGTileSource(url, options)
```

**Options:**
- `colorize` - Function: `(bands, x, y) => [r, g, b, a]`
- `tileSize` - Tile size in pixels (default: 256)
- `cacheSize` - Max cached images (default: 100)
- `poolSize` - Decoder threads (default: CPU cores)
- `minZoom` / `maxZoom` - Zoom range (default: 0-22)

**Methods:**
- `initialize()` - Load COG metadata (async)
- `renderTile(z, x, y)` - Render a tile (async, returns ArrayBuffer)
- `createProtocol(name)` - Get MapLibre protocol handler
- `getSourceConfig(name)` - Get MapLibre source config
- `getMetadata()` - Get COG metadata
- `getBBox()` - Get bounding box `[minLon, minLat, maxLon, maxLat]`
- `clearCache()` - Clear image cache
- `dispose()` - Clean up resources

### Built-in Colorizers

```javascript
import { rgb, grayscale, colormap, categorical, threshold } from 'cog-tiles'
```

#### `rgb(options)`
Map 3 bands to RGB channels.
```javascript
colorize: rgb({ redBand: 0, greenBand: 1, blueBand: 2, min: 0, max: 255 })
```

#### `grayscale(options)`
Single band to grayscale.
```javascript
colorize: grayscale({ band: 0, min: 0, max: 255 })
```

#### `colormap(options)`
Single band with color gradient.
```javascript
colorize: colormap({
  band: 0,
  min: 0,
  max: 100,
  colors: [[0,0,255], [0,255,0], [255,0,0]]  // blue → green → red
})
```

#### `categorical(options)`
Discrete value mapping.
```javascript
colorize: categorical({
  band: 0,
  mapping: {
    1: [255, 0, 0, 255],    // class 1 = red
    2: [0, 255, 0, 255],    // class 2 = green
    3: [0, 0, 255, 255],    // class 3 = blue
  },
  defaultColor: [0, 0, 0, 0]
})
```

#### `threshold(options)`
Value range classification.
```javascript
colorize: threshold({
  band: 0,
  stops: [
    { threshold: 0, color: [0, 0, 255, 255] },
    { threshold: 50, color: [255, 255, 0, 255] },
    { threshold: 100, color: [255, 0, 0, 255] },
  ]
})
```

#### `withTransparency(options)`
Add transparency to any colorizer.
```javascript
colorize: withTransparency({
  colorizer: colormap({ min: 0, max: 100 }),
  noDataBand: 1,      // band to check for no-data
  noDataValue: 0,     // value indicating no-data
  opacity: 0.8
})
```

### Custom Colorizers

Write your own colorizer function:

```javascript
const source = new COGTileSource(url, {
  colorize: (bands, x, y) => {
    // bands = array of band values at this pixel
    // x, y = pixel coordinates in tile (0-255)

    const value = bands[0]

    // Return [r, g, b, a] (0-255 each)
    if (value === 0) return [0, 0, 0, 0]  // transparent
    if (value > 100) return [255, 0, 0, 255]  // red
    return [0, 255, 0, 255]  // green
  }
})
```

### Geo Utilities

```javascript
import { tileToBBox, latToMercatorY, mercatorYToLat } from 'cog-tiles'

// Get geographic bounds of a tile
const [minLon, minLat, maxLon, maxLat] = tileToBBox(z, x, y)

// Coordinate conversions
const mercY = latToMercatorY(45.0)
const lat = mercatorYToLat(mercY)
```

## COG Requirements

Your COG should:
- Have internal overviews (pyramids) for performance
- Be in EPSG:4326 (geographic) projection
- Use tiled storage (not stripped)

Create COGs with GDAL:
```bash
gdal_translate input.tif output.tif \
  -of COG \
  -co COMPRESS=DEFLATE \
  -co OVERVIEWS=AUTO
```

## Browser Support

Requires:
- `OffscreenCanvas` (Chrome 69+, Firefox 105+, Safari 16.4+)
- `DecompressionStream` for gzipped COGs (Chrome 80+, Firefox 113+, Safari 16.4+)

## License

MIT
