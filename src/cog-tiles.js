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

// COG configuration - populated from metadata on init
let cogConfig = null

const DOMINANCE_THRESHOLD = 0.6
const TILE_SIZE = 256

// Latitude cutoffs (in Web Mercator Y coordinates)
// Formula: y = R * ln(tan(π/4 + lat/2)) where R = 20037508.34 / π
const SOUTH_LAT_DEG = 57
const SOUTH_LAT_MERCATOR = 20037508.34 * Math.log(Math.tan(Math.PI / 4 + (SOUTH_LAT_DEG * Math.PI / 180) / 2)) / Math.PI

// Northern cutoff to prevent stretching artifacts at the Web Mercator limit on globe projection
const NORTH_LAT_DEG = 85.0
const NORTH_LAT_MERCATOR = 20037508.34 * Math.log(Math.tan(Math.PI / 4 + (NORTH_LAT_DEG * Math.PI / 180) / 2)) / Math.PI

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
 * Convert tile coordinates to Web Mercator bbox (EPSG:3857)
 * Returns [minX, minY, maxX, maxY] in meters
 */
function tileToBBox(z, x, y) {
  const WORLD_SIZE = 20037508.34 * 2  // Web Mercator world extent
  const tileSize = WORLD_SIZE / Math.pow(2, z)

  const minX = x * tileSize - WORLD_SIZE / 2
  const maxX = (x + 1) * tileSize - WORLD_SIZE / 2
  const maxY = WORLD_SIZE / 2 - y * tileSize
  const minY = WORLD_SIZE / 2 - (y + 1) * tileSize

  return [minX, minY, maxX, maxY]
}

/**
 * Render a single tile
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

  // Use main image bbox (overviews don't have geotransform) - in Web Mercator
  const [cogMinX, cogMinY, cogMaxX, cogMaxY] = mainImageBBox

  // Tile bbox in Web Mercator coordinates
  const [tileMinX, tileMinY, tileMaxX, tileMaxY] = tileToBBox(z, x, y)

  // Check if tile intersects image bounds
  if (tileMaxX < cogMinX || tileMinX > cogMaxX || tileMaxY < cogMinY || tileMinY > cogMaxY) {
    return await createEmptyTile()
  }

  // Calculate pixel window relative to THIS image's resolution
  // Scale factor from main image to current overview
  const scaleX = imgWidth / mainImageSize[0]
  const scaleY = imgHeight / mainImageSize[1]

  const pixelWidth = (cogMaxX - cogMinX) / mainImageSize[0]
  const pixelHeight = (cogMaxY - cogMinY) / mainImageSize[1]

  // Calculate window in main image coordinates, then scale
  // Note: image Y increases downward, but Web Mercator Y increases upward
  const mainWindowX = (tileMinX - cogMinX) / pixelWidth
  const mainWindowY = (cogMaxY - tileMaxY) / pixelHeight
  const mainWindowWidth = (tileMaxX - tileMinX) / pixelWidth
  const mainWindowHeight = (tileMaxY - tileMinY) / pixelHeight

  // Scale to this overview's coordinates
  const windowX = Math.floor(mainWindowX * scaleX)
  const windowY = Math.floor(mainWindowY * scaleY)
  const windowWidth = Math.ceil(mainWindowWidth * scaleX)
  const windowHeight = Math.ceil(mainWindowHeight * scaleY)

  // Clamp to image bounds
  const clampedX = Math.max(0, Math.min(windowX, imgWidth))
  const clampedY = Math.max(0, Math.min(windowY, imgHeight))
  const clampedWidth = Math.min(windowWidth, imgWidth - clampedX)
  const clampedHeight = Math.min(windowHeight, imgHeight - clampedY)

  if (clampedWidth <= 0 || clampedHeight <= 0) {
    return await createEmptyTile()
  }

  try {
    // Read all 4 bands for the tile window
    const rasters = await image.readRasters({
      window: [clampedX, clampedY, clampedX + clampedWidth, clampedY + clampedHeight],
      width: TILE_SIZE,
      height: TILE_SIZE,
      pool,
    })

    const result = await colorize(rasters, selectedBands, showLand, tileMinY, tileMaxY)
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
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await blob.arrayBuffer()
}

/**
 * Colorize raster data into RGBA PNG ArrayBuffer
 * @param {Object} rasters Raster data with bands
 * @param {number[]} selectedBands Band indices to use for coloring (can be empty for land-only)
 * @param {boolean} showLand Whether to render land as white
 * @param {number} tileMinY Tile's minimum Y in Web Mercator (south edge)
 * @param {number} tileMaxY Tile's maximum Y in Web Mercator (north edge)
 * @returns {ArrayBuffer}
 */
async function colorize(rasters, selectedBands, showLand = true, tileMinY = 0, tileMaxY = 0) {
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(TILE_SIZE, TILE_SIZE)
  const pixels = imageData.data

  const landBandIdx = cogConfig?.landBand ?? rasters.length - 1
  const land = rasters[landBandIdx]
  const vesselBands = selectedBands.length > 0 ? selectedBands.map(b => rasters[b]) : []

  // Calculate Y range per pixel for latitude cutoff
  const yPerPixel = (tileMaxY - tileMinY) / TILE_SIZE

  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
    const px = i * 4

    // Calculate this pixel's Y coordinate in Web Mercator
    // Pixel row 0 is at the top (north), row 255 is at the bottom (south)
    const row = Math.floor(i / TILE_SIZE)
    const pixelY = tileMaxY - (row + 0.5) * yPerPixel

    // Skip pixels outside latitude cutoffs
    if (pixelY < SOUTH_LAT_MERCATOR || pixelY > NORTH_LAT_MERCATOR) {
      pixels[px + 3] = 0  // transparent
      continue
    }

    // Land: white (or transparent in satellite mode)
    if (land && land[i] === 1) {
      if (showLand) {
        pixels[px] = 255
        pixels[px + 1] = 255
        pixels[px + 2] = 255
        pixels[px + 3] = 255
      } else {
        pixels[px + 3] = 0  // transparent
      }
      continue
    }

    // No vessel bands selected = show land only, ocean is transparent
    if (vesselBands.length === 0) {
      pixels[px + 3] = 0
      continue
    }

    // Get vessel values for selected bands
    const values = vesselBands.map(band => (band ? band[i] : 0) || 0)
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
      // Dominant year color (use band index to get palette color)
      const bandIdx = selectedBands[maxIdx]
      color = YEAR_PALETTE[bandIdx % YEAR_PALETTE.length] || [180, 180, 180]
    } else {
      // Mixed: gray
      color = [180, 180, 180]
    }

    pixels[px] = Math.round(color[0] * brightness)
    pixels[px + 1] = Math.round(color[1] * brightness)
    pixels[px + 2] = Math.round(color[2] * brightness)
    pixels[px + 3] = 255
  }

  ctx.putImageData(imageData, 0, 0)

  // Convert to PNG blob and then ArrayBuffer for MapLibre protocol
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
 * Export the year color palette for UI consistency
 */
export { YEAR_PALETTE }
