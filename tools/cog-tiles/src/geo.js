/**
 * Geospatial coordinate utilities for COG tile rendering
 * Web Mercator (EPSG:3857) and Geographic (EPSG:4326) conversions
 */

/** Web Mercator extent in meters (half of world size) */
export const MERCATOR_EXTENT = 20037508.34

/** Full Web Mercator world size in meters */
export const WORLD_SIZE = MERCATOR_EXTENT * 2

/** Maximum latitude for Web Mercator (practical limit) */
export const MAX_MERCATOR_LAT = 85

/**
 * Convert latitude to Web Mercator Y coordinate
 * @param {number} lat - Latitude in degrees (-90 to 90)
 * @returns {number} Web Mercator Y coordinate in meters
 */
export function latToMercatorY(lat) {
  const latRad = lat * Math.PI / 180
  return MERCATOR_EXTENT * Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI
}

/**
 * Convert Web Mercator Y coordinate to latitude
 * @param {number} y - Web Mercator Y coordinate in meters
 * @returns {number} Latitude in degrees
 */
export function mercatorYToLat(y) {
  return (Math.atan(Math.exp(y * Math.PI / MERCATOR_EXTENT)) * 360 / Math.PI) - 90
}

/**
 * Convert longitude to Web Mercator X coordinate
 * @param {number} lon - Longitude in degrees (-180 to 180)
 * @returns {number} Web Mercator X coordinate in meters
 */
export function lonToMercatorX(lon) {
  return lon * MERCATOR_EXTENT / 180
}

/**
 * Convert Web Mercator X coordinate to longitude
 * @param {number} x - Web Mercator X coordinate in meters
 * @returns {number} Longitude in degrees
 */
export function mercatorXToLon(x) {
  return x * 180 / MERCATOR_EXTENT
}

/**
 * Convert tile coordinates to geographic bounding box
 * @param {number} z - Zoom level
 * @param {number} x - Tile X coordinate
 * @param {number} y - Tile Y coordinate
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
 * Check if two bounding boxes intersect
 * @param {number[]} bbox1 - [minLon, minLat, maxLon, maxLat]
 * @param {number[]} bbox2 - [minLon, minLat, maxLon, maxLat]
 * @returns {boolean} True if boxes intersect
 */
export function bboxIntersects(bbox1, bbox2) {
  return !(
    bbox1[2] < bbox2[0] ||  // bbox1 max lon < bbox2 min lon
    bbox1[0] > bbox2[2] ||  // bbox1 min lon > bbox2 max lon
    bbox1[3] < bbox2[1] ||  // bbox1 max lat < bbox2 min lat
    bbox1[1] > bbox2[3]     // bbox1 min lat > bbox2 max lat
  )
}
