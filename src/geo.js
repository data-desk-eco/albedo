/**
 * Geospatial coordinate primitives
 * All projection and grid math in one place
 */

// Web Mercator constants
export const MERCATOR_EXTENT = 20037508.34
export const WORLD_SIZE = MERCATOR_EXTENT * 2

// Grid constants (0.01° resolution)
export const GRID_RESOLUTION = 0.01
export const GRID_SCALE = 100  // 1 / GRID_RESOLUTION

// Hilbert curve order (16 allows coordinates up to 65535)
export const HILBERT_ORDER = 16

/**
 * Convert latitude to Web Mercator Y
 * @param {number} lat Latitude in degrees
 * @returns {number} Web Mercator Y coordinate
 */
export function latToMercatorY(lat) {
  const latRad = lat * Math.PI / 180
  return MERCATOR_EXTENT * Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI
}

/**
 * Convert Web Mercator Y to latitude
 * @param {number} y Web Mercator Y coordinate
 * @returns {number} Latitude in degrees
 */
export function mercatorYToLat(y) {
  return (Math.atan(Math.exp(y * Math.PI / MERCATOR_EXTENT)) * 360 / Math.PI) - 90
}

/**
 * Convert tile coordinates to geographic bbox
 * @param {number} z Zoom level
 * @param {number} x Tile X
 * @param {number} y Tile Y
 * @returns {number[]} [minLon, minLat, maxLon, maxLat] in degrees
 */
export function tileToBBox(z, x, y) {
  const tileSize = WORLD_SIZE / Math.pow(2, z)

  const mercMinX = x * tileSize - MERCATOR_EXTENT
  const mercMaxX = (x + 1) * tileSize - MERCATOR_EXTENT
  const mercMaxY = MERCATOR_EXTENT - y * tileSize
  const mercMinY = MERCATOR_EXTENT - (y + 1) * tileSize

  return [
    mercMinX * 180 / MERCATOR_EXTENT,  // minLon
    mercatorYToLat(mercMinY),           // minLat
    mercMaxX * 180 / MERCATOR_EXTENT,  // maxLon
    mercatorYToLat(mercMaxY)            // maxLat
  ]
}

/**
 * Snap coordinates to grid cell (pixel-is-area convention)
 * Grid cells are identified by their lower-left corner.
 * A cell labeled "72.51" covers the area [72.51, 72.52).
 *
 * @param {number} lat Latitude
 * @param {number} lon Longitude
 * @returns {{lat: number, lon: number, key: string}} Grid cell coordinates and key
 */
export function snapToGrid(lat, lon) {
  // Use floor() to map to cell's lower-left corner
  // This matches COG renderer pixel boundaries
  const col = Math.floor((lon + 180) * GRID_SCALE)
  const row = Math.floor((90 - lat) * GRID_SCALE)
  const gridLon = -180 + col * GRID_RESOLUTION
  const gridLat = 90 - row * GRID_RESOLUTION
  return {
    lat: gridLat,
    lon: gridLon,
    key: `${gridLat.toFixed(2)}_${gridLon.toFixed(2)}`
  }
}

/**
 * Convert lat/lon to Hilbert curve grid coordinates
 * @param {number} lat Latitude (-90 to 90)
 * @param {number} lon Longitude (-180 to 180)
 * @returns {number[]} [latGrid, lonGrid] integers for Hilbert conversion
 */
export function latLonToHilbertGrid(lat, lon) {
  return [
    Math.floor((lat + 90) * GRID_SCALE),
    Math.floor((lon + 180) * GRID_SCALE)
  ]
}

/**
 * Convert 2D coordinates to Hilbert curve index
 * Uses standard algorithm: rotate and flip quadrants
 * @param {number} x X coordinate
 * @param {number} y Y coordinate
 * @param {number} order Hilbert curve order (default 16)
 * @returns {number} 1D Hilbert index
 */
export function xyToHilbert(x, y, order = HILBERT_ORDER) {
  let d = 0
  let s = 1 << (order - 1)
  while (s > 0) {
    const rx = (x & s) > 0 ? 1 : 0
    const ry = (y & s) > 0 ? 1 : 0
    d += s * s * ((3 * rx) ^ ry)
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x
        y = s - 1 - y
      }
      ;[x, y] = [y, x]
    }
    s >>= 1
  }
  return d
}

/**
 * Get Hilbert index for a geographic coordinate
 * @param {number} lat Latitude
 * @param {number} lon Longitude
 * @returns {number} Hilbert curve index
 */
export function latLonToHilbert(lat, lon) {
  const [latGrid, lonGrid] = latLonToHilbertGrid(lat, lon)
  return xyToHilbert(latGrid, lonGrid)
}
