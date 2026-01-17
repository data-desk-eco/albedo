/**
 * Client-side COG tile renderer using geotiff.js
 * Reads year configuration from COG metadata for self-describing data
 */

import { fromUrl, Pool } from 'geotiff'

// Color palette for years (assigned by index, cycles if >6 years)
const YEAR_PALETTE = [
  [0, 255, 255],    // Cyan
  [0, 255, 0],      // Green
  [255, 0, 255],    // Magenta
  [255, 255, 0],    // Yellow
  [255, 128, 0],    // Orange
  [128, 0, 255],    // Purple
]

// Color for mixed cells where no single year dominates
const MULTI_YEAR_COLOR = [180, 180, 180]

// COG configuration - populated from metadata on init
let cogConfig = null

const DOMINANCE_THRESHOLD = 0.6
const TILE_SIZE = 256
const MAX_MERCATOR_LAT = 85  // Web Mercator practical limit

let tiff = null
let pool = null
let imageCache = new Map()
let mainImageBBox = null  // Store main image bbox for all calculations
let mainImageSize = null  // Store main image dimensions

/**
 * Parse GDAL metadata XML to extract custom tags
 */
function parseGDALMetadata(xml) {
  if (!xml) return {}
  const result = {}
  // Parse <Item name="KEY">VALUE</Item> format
  const matches = xml.matchAll(/<Item\s+name="([^"]+)"[^>]*>([^<]*)<\/Item>/g)
  for (const match of matches) {
    // Decode HTML entities (GDAL stores XML, so quotes become &quot; etc.)
    // Order matters: &amp; must be decoded first since other entities contain &
    let value = match[2]
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&apos;/g, "'")
    result[match[1]] = value
  }
  return result
}

/**
 * Initialize the COG reader and extract configuration from metadata
 * @returns {Object} COG configuration: { years, landBand, lastUpdated, yearColors }
 */
export async function initCOG(url) {
  tiff = await fromUrl(url, {
    cacheSize: 100,
    blockSize: 65536,
  })
  // Use available CPU cores for decoding
  pool = new Pool(navigator.hardwareConcurrency || 4)

  // Store main image bbox and size - overview images don't have geotransform
  const mainImage = await tiff.getImage(0)
  mainImageBBox = mainImage.getBoundingBox()
  mainImageSize = [mainImage.getWidth(), mainImage.getHeight()]

  // Extract configuration from COG metadata
  const fileDirectory = mainImage.fileDirectory
  const gdalMetadata = parseGDALMetadata(fileDirectory.GDAL_METADATA)

  if (gdalMetadata.ALBEDO_CONFIG) {
    cogConfig = JSON.parse(gdalMetadata.ALBEDO_CONFIG)
  } else {
    // Fallback: try to infer from band descriptions
    const bandCount = mainImage.getSamplesPerPixel()
    console.warn('No ALBEDO_CONFIG in COG, using fallback config')
    cogConfig = {
      years: [2023, 2024, 2025].slice(0, bandCount - 1),
      landBand: bandCount - 1,
      lastUpdated: null
    }
  }

  // Build year-to-color mapping
  cogConfig.yearColors = {}
  cogConfig.years.forEach((year, idx) => {
    cogConfig.yearColors[year] = YEAR_PALETTE[idx % YEAR_PALETTE.length]
  })

  return cogConfig
}

/**
 * Get the appropriate image for a zoom level (uses COG overviews)
 * COG structure: image 0 = full res (36000x3400), images 1+ = overviews (progressively smaller)
 * MapLibre zoom: higher z = more detail needed = use lower overview index
 */
async function getImageForZoom(z) {
  if (imageCache.has(z)) {
    return imageCache.get(z)
  }

  const imageCount = await tiff.getImageCount()
  // Map zoom level to overview index:
  // z >= 8: use full resolution (index 0)
  // z 7: overview 1
  // z 6: overview 2
  // etc.
  // Start using full res earlier for better detail
  const overviewIndex = Math.max(0, Math.min(imageCount - 1, 8 - z))

  const image = await tiff.getImage(overviewIndex)
  imageCache.set(z, image)
  return image
}

/**
 * Convert Web Mercator Y to latitude
 */
function mercatorYToLat(y) {
  return (Math.atan(Math.exp(y * Math.PI / 20037508.34)) * 360 / Math.PI) - 90
}

/**
 * Convert latitude to Web Mercator Y
 */
function latToMercatorY(lat) {
  const latRad = lat * Math.PI / 180
  return 20037508.34 * Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI
}

/**
 * Convert tile coordinates to geographic bbox (EPSG:4326)
 * Returns [minLon, minLat, maxLon, maxLat] in degrees
 */
function tileToBBox(z, x, y) {
  const WORLD_SIZE = 20037508.34 * 2  // Web Mercator world extent
  const tileSize = WORLD_SIZE / Math.pow(2, z)

  // Calculate Web Mercator bounds first
  const mercMinX = x * tileSize - WORLD_SIZE / 2
  const mercMaxX = (x + 1) * tileSize - WORLD_SIZE / 2
  const mercMaxY = WORLD_SIZE / 2 - y * tileSize
  const mercMinY = WORLD_SIZE / 2 - (y + 1) * tileSize

  // Convert to geographic coordinates (EPSG:4326)
  const minLon = mercMinX * 180 / 20037508.34
  const maxLon = mercMaxX * 180 / 20037508.34
  const minLat = mercatorYToLat(mercMinY)
  const maxLat = mercatorYToLat(mercMaxY)

  return [minLon, minLat, maxLon, maxLat]
}

/**
 * Render a single tile with proper EPSG:4326 to Web Mercator reprojection
 * @param {number} z Zoom level
 * @param {number} x Tile x coordinate
 * @param {number} y Tile y coordinate
 * @param {number[]} selectedBands Array of band indices to render (0=2023, 1=2024, 2=2025)
 * @param {boolean} showLand Whether to render land as white (false = transparent for satellite mode)
 * @returns {ArrayBuffer} Rendered tile as PNG
 */
export async function renderTile(z, x, y, selectedBands = [0, 1, 2], showLand = true) {
  if (!tiff || !mainImageBBox) {
    throw new Error('COG not initialized')
  }

  const image = await getImageForZoom(z)
  const [imgWidth, imgHeight] = [image.getWidth(), image.getHeight()]

  // COG bbox in EPSG:4326 (degrees)
  const [cogMinLon, cogMinLat, cogMaxLon, cogMaxLat] = mainImageBBox

  // Tile bbox in EPSG:4326 (degrees)
  const [tileMinLon, tileMinLat, tileMaxLon, tileMaxLat] = tileToBBox(z, x, y)

  // Check if tile intersects COG bounds (and is within Web Mercator limits)
  if (tileMaxLon < cogMinLon || tileMinLon > cogMaxLon || tileMaxLat < cogMinLat || tileMinLat > cogMaxLat) {
    return await createEmptyTile()
  }
  if (tileMinLat > MAX_MERCATOR_LAT) {
    return await createEmptyTile()
  }

  // Scale factor from main image to current overview
  const scaleX = imgWidth / mainImageSize[0]
  const scaleY = imgHeight / mainImageSize[1]

  // Pixel size in degrees (main image)
  const pixelWidthDeg = (cogMaxLon - cogMinLon) / mainImageSize[0]
  const pixelHeightDeg = (cogMaxLat - cogMinLat) / mainImageSize[1]

  // Calculate X (longitude) window - this is still linear
  const mainWindowX = (tileMinLon - cogMinLon) / pixelWidthDeg
  const mainWindowWidth = (tileMaxLon - tileMinLon) / pixelWidthDeg

  // For Y, we need to find the latitude range we actually need to read from the COG
  // Clamp the tile's lat range to the COG's lat range AND Web Mercator limit
  const readMinLat = Math.max(tileMinLat, cogMinLat)
  const readMaxLat = Math.min(tileMaxLat, cogMaxLat, MAX_MERCATOR_LAT)

  // Convert to source Y coordinates (image row 0 = cogMaxLat, row increases = lat decreases)
  const mainWindowYTop = (cogMaxLat - readMaxLat) / pixelHeightDeg
  const mainWindowYBottom = (cogMaxLat - readMinLat) / pixelHeightDeg
  const mainWindowHeight = mainWindowYBottom - mainWindowYTop

  // Scale to this overview's coordinates
  const windowX = mainWindowX * scaleX
  const windowWidth = mainWindowWidth * scaleX
  const windowYTop = mainWindowYTop * scaleY
  const windowYBottom = mainWindowYBottom * scaleY
  const windowHeight = windowYBottom - windowYTop

  // Calculate source region (clamped to image bounds)
  const srcLeft = Math.max(0, windowX)
  const srcRight = Math.min(imgWidth, windowX + windowWidth)
  const srcTop = Math.max(0, windowYTop)
  const srcBottom = Math.min(imgHeight, windowYBottom)

  const srcWidth = srcRight - srcLeft
  const srcHeight = srcBottom - srcTop

  if (srcWidth <= 0 || srcHeight <= 0) {
    return await createEmptyTile()
  }

  // Calculate destination region in the output tile
  // X is linear: dst pixels map linearly to longitude
  const dstLeft = Math.round(((srcLeft - windowX) / windowWidth) * TILE_SIZE)
  const dstRight = Math.round(((srcRight - windowX) / windowWidth) * TILE_SIZE)
  const dstWidth = dstRight - dstLeft

  // For Y, we need to calculate based on Mercator projection
  // Convert latitude range to Mercator Y, then to tile pixel coordinates
  const tileMercMinY = latToMercatorY(tileMinLat)
  const tileMercMaxY = latToMercatorY(tileMaxLat)
  const tileMercHeight = tileMercMaxY - tileMercMinY

  // The actual lat range we're reading
  const actualMinLat = cogMaxLat - (srcBottom / scaleY) * pixelHeightDeg
  const actualMaxLat = cogMaxLat - (srcTop / scaleY) * pixelHeightDeg

  const actualMercMinY = latToMercatorY(actualMinLat)
  const actualMercMaxY = latToMercatorY(actualMaxLat)

  // Map to tile pixel coordinates (tile top = maxY, tile bottom = minY in Mercator)
  const dstTop = Math.round(((tileMercMaxY - actualMercMaxY) / tileMercHeight) * TILE_SIZE)
  const dstBottom = Math.round(((tileMercMaxY - actualMercMinY) / tileMercHeight) * TILE_SIZE)
  const dstHeight = dstBottom - dstTop

  if (dstWidth <= 0 || dstHeight <= 0) {
    return await createEmptyTile()
  }

  try {
    // Calculate source dimensions (integer pixel bounds)
    const srcLeftInt = Math.floor(srcLeft)
    const srcTopInt = Math.floor(srcTop)
    const srcRightInt = Math.ceil(srcRight)
    const srcBottomInt = Math.ceil(srcBottom)
    const srcWidthInt = srcRightInt - srcLeftInt
    const srcHeightInt = srcBottomInt - srcTopInt

    // Read rasters at SOURCE resolution - no resampling by geotiff.js
    // This ensures we never skip any source pixels due to downsampling
    const rasters = await image.readRasters({
      window: [srcLeftInt, srcTopInt, srcRightInt, srcBottomInt],
      // No width/height specified = read at native resolution
      resampleMethod: 'nearest',
      pool,
    })

    // Calculate the precise latitude bounds of what we actually read
    // (accounting for integer pixel snapping)
    const readMinLat = cogMaxLat - (srcBottomInt / scaleY) * pixelHeightDeg
    const readMaxLat = cogMaxLat - (srcTopInt / scaleY) * pixelHeightDeg

    // Colorize with per-scanline reprojection (handles both X and Y resampling)
    const result = await colorizeWithReprojection(
      rasters, selectedBands, showLand,
      dstLeft, dstTop, dstWidth, dstHeight,
      readMinLat, readMaxLat,
      tileMinLon, tileMaxLon,
      tileMinLat, tileMaxLat,
      cogMinLon, cogMaxLon,
      srcLeftInt, srcRightInt, scaleX, pixelWidthDeg
    )
    return result
  } catch (err) {
    console.warn(`Tile ${z}/${x}/${y} error:`, err.message)
    return await createEmptyTile()
  }
}

/**
 * Create an empty transparent tile
 */
async function createEmptyTile() {
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
  // Must get context before convertToBlob works
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await blob.arrayBuffer()
}

/**
 * Colorize raster data with proper EPSG:4326 to Web Mercator reprojection
 * Does per-pixel sampling to handle non-linear latitude transformation
 * and ensure no source data is lost during resampling.
 *
 * @param {Object} rasters Source raster data at native resolution
 * @param {number[]} selectedBands Band indices to use for coloring
 * @param {boolean} showLand Whether to render land as white
 * @param {number} dstLeft X offset in output tile
 * @param {number} dstTop Y offset in output tile
 * @param {number} dstWidth Width of output region
 * @param {number} dstHeight Height of output region
 * @param {number} srcMinLat Minimum latitude of source data
 * @param {number} srcMaxLat Maximum latitude of source data
 * @param {number} tileMinLon Minimum longitude of the tile
 * @param {number} tileMaxLon Maximum longitude of the tile
 * @param {number} tileMinLat Minimum latitude of the tile
 * @param {number} tileMaxLat Maximum latitude of the tile
 * @param {number} cogMinLon COG minimum longitude
 * @param {number} cogMaxLon COG maximum longitude
 * @param {number} srcLeftPx Source left pixel coordinate (in overview space)
 * @param {number} srcRightPx Source right pixel coordinate (in overview space)
 * @param {number} scaleX Scale factor from main image to overview
 * @param {number} pixelWidthDeg Pixel width in degrees (main image)
 */
async function colorizeWithReprojection(
  rasters, selectedBands, showLand,
  dstLeft, dstTop, dstWidth, dstHeight,
  srcMinLat, srcMaxLat,
  tileMinLon, tileMaxLon,
  tileMinLat, tileMaxLat,
  cogMinLon, cogMaxLon,
  srcLeftPx, srcRightPx, scaleX, pixelWidthDeg
) {
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE)

  const imageData = ctx.createImageData(dstWidth, dstHeight)
  const pixels = imageData.data

  const srcHeight = rasters.height
  const srcWidth = rasters.width

  const landBandIdx = cogConfig?.landBand ?? rasters.length - 1
  const land = rasters[landBandIdx]
  const vesselBands = selectedBands.length > 0 ? selectedBands.map(b => rasters[b]) : []

  // Mercator Y range for the tile
  const tileMercMinY = latToMercatorY(tileMinLat)
  const tileMercMaxY = latToMercatorY(tileMaxLat)
  const tileMercHeight = tileMercMaxY - tileMercMinY

  // Longitude range for the tile
  const tileLonWidth = tileMaxLon - tileMinLon

  // Source longitude range (derived from pixel coordinates)
  const srcMinLon = cogMinLon + (srcLeftPx / scaleX) * pixelWidthDeg
  const srcMaxLon = cogMinLon + (srcRightPx / scaleX) * pixelWidthDeg
  const srcLonWidth = srcMaxLon - srcMinLon

  // For each output pixel, calculate exact source coordinates
  for (let dstRow = 0; dstRow < dstHeight; dstRow++) {
    // Output row's position in the tile (0 = top, TILE_SIZE = bottom)
    const tileY = dstTop + dstRow

    // Convert tile Y to Mercator Y (tile top = tileMercMaxY, bottom = tileMercMinY)
    const mercY = tileMercMaxY - ((tileY + 0.5) / TILE_SIZE) * tileMercHeight

    // Convert Mercator Y to latitude
    const lat = mercatorYToLat(mercY)

    // Skip rows beyond Web Mercator limit (pixels already transparent)
    if (lat > MAX_MERCATOR_LAT) continue

    // Map latitude to source row index
    // Source row 0 = srcMaxLat, row (srcHeight-1) = srcMinLat
    // Use floor for consistent pixel selection (always pick the pixel whose center is just north)
    const srcRowFrac = ((srcMaxLat - lat) / (srcMaxLat - srcMinLat)) * srcHeight
    const srcRow = Math.floor(Math.max(0, Math.min(srcHeight - 1, srcRowFrac)))

    // Process each column in this row
    for (let col = 0; col < dstWidth; col++) {
      const px = (dstRow * dstWidth + col) * 4

      // Calculate longitude for this output pixel
      const tileX = dstLeft + col
      const lon = tileMinLon + ((tileX + 0.5) / TILE_SIZE) * tileLonWidth

      // Map longitude to source column
      const srcColFrac = ((lon - srcMinLon) / srcLonWidth) * srcWidth
      const srcCol = Math.floor(Math.max(0, Math.min(srcWidth - 1, srcColFrac)))

      const srcIdx = srcRow * srcWidth + srcCol

      // Land: white (or transparent in satellite mode)
      if (land && land[srcIdx] === 1) {
        if (showLand) {
          pixels[px] = 255
          pixels[px + 1] = 255
          pixels[px + 2] = 255
          pixels[px + 3] = 255
        } else {
          pixels[px + 3] = 0
        }
        continue
      }

      // No vessel bands selected = show land only, ocean is transparent
      if (vesselBands.length === 0) {
        pixels[px + 3] = 0
        continue
      }

      // Get vessel values for selected bands
      const values = vesselBands.map(band => (band ? band[srcIdx] : 0) || 0)
      const total = values.reduce((a, b) => a + b, 0)

      // No activity: transparent (ocean)
      if (total === 0) {
        pixels[px + 3] = 0
        continue
      }

      // Find dominant band
      let maxVal = 0
      let maxIdx = 0
      for (let j = 0; j < values.length; j++) {
        if (values[j] > maxVal) {
          maxVal = values[j]
          maxIdx = j
        }
      }

      const proportion = maxVal / total

      // Brightness (log scale, minimum 0.7 for visibility)
      const brightness = Math.min(1, Math.max(0.7, Math.log1p(total) / Math.log1p(50)))

      let color
      if (proportion >= DOMINANCE_THRESHOLD) {
        const bandIdx = selectedBands[maxIdx]
        color = YEAR_PALETTE[bandIdx % YEAR_PALETTE.length] || MULTI_YEAR_COLOR
      } else {
        color = MULTI_YEAR_COLOR
      }

      pixels[px] = Math.round(color[0] * brightness)
      pixels[px + 1] = Math.round(color[1] * brightness)
      pixels[px + 2] = Math.round(color[2] * brightness)
      pixels[px + 3] = 255
    }
  }

  ctx.putImageData(imageData, dstLeft, dstTop)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await blob.arrayBuffer()
}

/**
 * Clear the image cache (call on cleanup or when switching COGs)
 */
export function clearCache() {
  imageCache.clear()
}

/**
 * Switch to a different COG file
 * @param {string} url URL of the new COG file
 * @returns {Object} New COG configuration
 */
export async function switchCOG(url) {
  // Clear caches
  imageCache.clear()
  tiff = null
  pool = null
  mainImageBBox = null
  mainImageSize = null
  cogConfig = null

  // Re-initialize with new COG
  return await initCOG(url)
}

/**
 * Check if COG is initialized
 */
export function isInitialized() {
  return tiff !== null
}

/**
 * Get the COG configuration (years, colors, etc.)
 * @returns {Object|null} Config object or null if not initialized
 */
export function getCOGConfig() {
  return cogConfig
}

/**
 * Get the COG bounding box in Web Mercator coordinates
 * @returns {number[]|null} [minX, minY, maxX, maxY] or null if not initialized
 */
export function getCOGBBox() {
  return mainImageBBox
}

/**
 * Get the COG pixel size in Web Mercator meters
 * @returns {number[]|null} [pixelWidth, pixelHeight] or null if not initialized
 */
export function getCOGPixelSize() {
  if (!mainImageBBox || !mainImageSize) return null
  const [minX, minY, maxX, maxY] = mainImageBBox
  return [
    (maxX - minX) / mainImageSize[0],
    (maxY - minY) / mainImageSize[1]
  ]
}

/**
 * Export the year color palette for UI consistency
 */
export { YEAR_PALETTE }
