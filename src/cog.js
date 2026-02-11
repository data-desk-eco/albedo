/**
 * Client-side COG tile renderer
 * Year-colorized vessel heatmap from Cloud-Optimized GeoTIFF bands
 */

import { COGTileSource } from '../tools/cog-tiles/src/index.js'
import { YEAR_PALETTE } from './config.js'

const MULTI_YEAR_COLOR = [169, 178, 194]  // #A9B2C2 — Arctida blue-gray
const DOMINANCE_THRESHOLD = 0.6
const LAND_COLOR = [200, 200, 200]  // light grey
const ICE_COLOR = [255, 255, 255]   // white

let cogSource = null
let cogConfig = null
let selectedBands = [0, 1, 2]
let showLand = true
let showIce = true
let showSanctioned = false
let showOldTankers = false

const OVERLAY_OLD_TANKER = [255, 204, 0]     // #FFCC00 — yellow
const OVERLAY_SANCTIONS = [255, 59, 48]      // #FF3B30 — red
const OVERLAY_ALPHA = 0.8

function alphaBlend(base, overlay, alpha) {
  return [
    Math.round(base[0] * (1 - alpha) + overlay[0] * alpha),
    Math.round(base[1] * (1 - alpha) + overlay[1] * alpha),
    Math.round(base[2] * (1 - alpha) + overlay[2] * alpha),
  ]
}

function createVesselColorizer() {
  const oldTankerOffset = cogConfig?.oldTankerBandOffset ?? null
  const sanctionsOffset = cogConfig?.sanctionsBandOffset ?? null

  return (bands) => {
    const landIdx = cogConfig?.landBand ?? bands.length - 1
    const iceIdx = cogConfig?.iceBand ?? null

    // Ice pixel (may also be land underneath, e.g. Greenland)
    if (iceIdx != null && bands[iceIdx] === 1) {
      if (!showLand) return [0, 0, 0, 0]  // satellite mode: transparent
      if (showIce) return [...ICE_COLOR, 255]
      // Ice toggled off: show as land if also land, otherwise transparent
      if (bands[landIdx] === 1) return [...LAND_COLOR, 255]
      return [0, 0, 0, 0]
    }

    // Land pixel
    if (bands[landIdx] === 1) return showLand ? [...LAND_COLOR, 255] : [0, 0, 0, 0]

    if (!selectedBands.length) return [0, 0, 0, 0]

    const values = selectedBands.map(b => bands[b] || 0)
    const total = values.reduce((a, b) => a + b, 0)

    // Check overlay totals
    let oldTankerTotal = 0
    if (showOldTankers && oldTankerOffset != null) {
      for (const b of selectedBands) oldTankerTotal += bands[b + oldTankerOffset] || 0
    }
    let sanctionsTotal = 0
    if (showSanctioned && sanctionsOffset != null) {
      for (const b of selectedBands) sanctionsTotal += bands[b + sanctionsOffset] || 0
    }

    // If base and all active overlays are empty, transparent
    if (total === 0 && oldTankerTotal === 0 && sanctionsTotal === 0) return [0, 0, 0, 0]

    // Compute base color
    let r, g, b
    if (total > 0) {
      let maxVal = 0, maxIdx = 0
      for (let j = 0; j < values.length; j++) {
        if (values[j] > maxVal) { maxVal = values[j]; maxIdx = j }
      }
      const brightness = Math.min(1, Math.max(0.7, Math.log1p(total) / Math.log1p(50)))
      const color = maxVal / total >= DOMINANCE_THRESHOLD
        ? (YEAR_PALETTE[selectedBands[maxIdx] % YEAR_PALETTE.length] || MULTI_YEAR_COLOR)
        : MULTI_YEAR_COLOR
      r = Math.round(color[0] * brightness)
      g = Math.round(color[1] * brightness)
      b = Math.round(color[2] * brightness)
    } else {
      // No base data but overlay has data — start from black
      r = 0; g = 0; b = 0
    }

    // Composite old tanker overlay (yellow)
    if (oldTankerTotal > 0) {
      ;[r, g, b] = alphaBlend([r, g, b], OVERLAY_OLD_TANKER, OVERLAY_ALPHA)
    }

    // Composite sanctions overlay (red) — renders on top
    if (sanctionsTotal > 0) {
      ;[r, g, b] = alphaBlend([r, g, b], OVERLAY_SANCTIONS, OVERLAY_ALPHA)
    }

    return [r, g, b, 255]
  }
}

export async function initCOG(url) {
  cogSource = new COGTileSource(url, { colorize: createVesselColorizer() })
  const metadata = await cogSource.initialize()
  const gdal = metadata.gdalMetadata || {}

  if (gdal.ALBEDO_CONFIG) {
    const config = JSON.parse(gdal.ALBEDO_CONFIG)
    cogConfig = config
    cogConfig.sanctionsBandOffset = config.sanctionsBandOffset ?? null
    cogConfig.oldTankerBandOffset = config.oldTankerBandOffset ?? null
    cogConfig.iceBand = config.iceBand ?? null
  } else {
    console.warn('No ALBEDO_CONFIG in COG, using fallback')
    cogConfig = { years: [2023, 2024, 2025].slice(0, metadata.bandCount - 1), landBand: metadata.bandCount - 1, sanctionsBandOffset: null, oldTankerBandOffset: null, iceBand: null }
  }

  cogConfig.yearColors = Object.fromEntries(cogConfig.years.map((y, i) => [y, YEAR_PALETTE[i % YEAR_PALETTE.length]]))
  return cogConfig
}

export async function renderTile(z, x, y, bands = [0, 1, 2], land = true) {
  if (!cogSource) throw new Error('COG not initialized')
  selectedBands = bands
  showLand = land
  cogSource.options.colorize = createVesselColorizer()
  return cogSource.renderTile(z, x, y)
}

export function clearCache() {
  cogSource?.clearCache()
}

export async function switchCOG(url) {
  cogSource?.dispose()
  cogSource = cogConfig = null
  return initCOG(url)
}

export function setOverlayState({ sanctioned, oldTankers }) {
  if (sanctioned !== undefined) showSanctioned = sanctioned
  if (oldTankers !== undefined) showOldTankers = oldTankers
}

export function setIceState(visible) {
  showIce = visible
}

export { YEAR_PALETTE } from './config.js'
