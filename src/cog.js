/**
 * Client-side COG tile renderer for Albedo
 * Uses cog-tiles library with application-specific colorization
 */

import { COGTileSource } from '../tools/cog-tiles/src/index.js'

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

const DOMINANCE_THRESHOLD = 0.6

// Application state
let cogSource = null
let cogConfig = null

// Render options (can be changed dynamically)
let selectedBands = [0, 1, 2]
let showLand = true

/**
 * Parse GDAL metadata XML to extract custom tags
 */
function parseGDALMetadata(xml) {
  if (!xml) return {}
  const result = {}
  const matches = xml.matchAll(/<Item\s+name="([^"]+)"[^>]*>([^<]*)<\/Item>/g)
  for (const match of matches) {
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
 * Create the colorizer function for vessel heatmap data
 */
function createVesselColorizer() {
  return (bands) => {
    const landBandIdx = cogConfig?.landBand ?? bands.length - 1

    // Land: white or transparent
    if (bands[landBandIdx] === 1) {
      if (showLand) {
        return [255, 255, 255, 255]
      } else {
        return [0, 0, 0, 0]
      }
    }

    // No vessel bands selected = show land only
    if (selectedBands.length === 0) {
      return [0, 0, 0, 0]
    }

    // Get vessel values for selected bands
    const values = selectedBands.map(b => bands[b] || 0)
    const total = values.reduce((a, b) => a + b, 0)

    // No activity: transparent
    if (total === 0) {
      return [0, 0, 0, 0]
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

    return [
      Math.round(color[0] * brightness),
      Math.round(color[1] * brightness),
      Math.round(color[2] * brightness),
      255
    ]
  }
}

/**
 * Initialize the COG reader and extract configuration from metadata
 * @param {string} url - URL to the COG file
 * @returns {Object} COG configuration: { years, landBand, lastUpdated, yearColors }
 */
export async function initCOG(url) {
  cogSource = new COGTileSource(url, {
    colorize: createVesselColorizer()
  })

  const metadata = await cogSource.initialize()

  // Extract configuration from COG metadata
  const gdalMetadata = parseGDALMetadata(metadata.fileDirectory?.GDAL_METADATA)

  if (gdalMetadata.ALBEDO_CONFIG) {
    cogConfig = JSON.parse(gdalMetadata.ALBEDO_CONFIG)
  } else {
    // Fallback: try to infer from band descriptions
    const bandCount = metadata.bandCount
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
 * Render a single tile
 * @param {number} z Zoom level
 * @param {number} x Tile x coordinate
 * @param {number} y Tile y coordinate
 * @param {number[]} bands Array of band indices to render
 * @param {boolean} land Whether to render land as white
 * @returns {ArrayBuffer} Rendered tile as PNG
 */
export async function renderTile(z, x, y, bands = [0, 1, 2], land = true) {
  if (!cogSource) {
    throw new Error('COG not initialized')
  }

  // Update render options before rendering
  selectedBands = bands
  showLand = land

  // Update colorizer with new options
  cogSource.options.colorize = createVesselColorizer()

  return await cogSource.renderTile(z, x, y)
}

/**
 * Clear the image cache
 */
export function clearCache() {
  if (cogSource) {
    cogSource.clearCache()
  }
}

/**
 * Switch to a different COG file
 * @param {string} url URL of the new COG file
 * @returns {Object} New COG configuration
 */
export async function switchCOG(url) {
  if (cogSource) {
    cogSource.dispose()
  }
  cogSource = null
  cogConfig = null
  return await initCOG(url)
}

/**
 * Check if COG is initialized
 */
export function isInitialized() {
  return cogSource !== null && cogSource.isInitialized()
}

/**
 * Get the COG configuration (years, colors, etc.)
 * @returns {Object|null} Config object or null if not initialized
 */
export function getCOGConfig() {
  return cogConfig
}

/**
 * Get the COG bounding box in EPSG:4326
 * @returns {number[]|null} [minLon, minLat, maxLon, maxLat] or null if not initialized
 */
export function getCOGBBox() {
  if (!cogSource) return null
  return cogSource.getBBox()
}

/**
 * Get the COG pixel size in degrees
 * @returns {number[]|null} [pixelWidth, pixelHeight] or null if not initialized
 */
export function getCOGPixelSize() {
  if (!cogSource) return null
  const metadata = cogSource.getMetadata()
  if (!metadata) return null
  const [minX, minY, maxX, maxY] = metadata.bbox
  return [
    (maxX - minX) / metadata.size[0],
    (maxY - minY) / metadata.size[1]
  ]
}

/**
 * Export the year color palette for UI consistency
 */
export { YEAR_PALETTE }
