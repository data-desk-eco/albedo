/**
 * Client-side COG tile renderer
 * Year-colorized vessel heatmap from Cloud-Optimized GeoTIFF bands.
 * Colorization + reprojection + PNG encoding run in a Web Worker.
 */

import { COGTileSource } from '../tools/cog-tiles/src/index.js'
import {
  YEAR_PALETTE, MULTI_YEAR_COLOR, LAND_COLOR, ICE_COLOR,
  OVERLAY_SANCTIONS, OVERLAY_OLD_TANKER, OVERLAY_ALPHA
} from './config.js'
import CogWorker from './cog-worker.js?worker'

const DOMINANCE_THRESHOLD = 0.6

let cogSource = null
let cogConfig = null
let selectedBands = [0, 1, 2]
let showLand = true
let showIce = true
let showSanctioned = false
let showOldTankers = false

// Worker setup
let worker = null
let nextMsgId = 0
const pending = new Map()  // id → { resolve, reject }

function initWorker() {
  if (worker) return
  worker = new CogWorker()
  worker.onmessage = (e) => {
    const { id, buffer } = e.data
    const p = pending.get(id)
    if (p) { pending.delete(id); p.resolve(buffer) }
  }
}

function sendToWorker(type, data, transferables = []) {
  const id = nextMsgId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ type, id, ...data }, transferables)
  })
}

function sendColorizerConfig() {
  if (!worker || !cogConfig) return
  worker.postMessage({
    type: 'config',
    config: {
      landBand: cogConfig.landBand,
      iceBand: cogConfig.iceBand ?? null,
      sanctionsBandOffset: cogConfig.sanctionsBandOffset ?? null,
      oldTankerBandOffset: cogConfig.oldTankerBandOffset ?? null,
      selectedBands,
      showLand,
      showIce,
      showSanctioned,
      showOldTankers,
      yearPalette: YEAR_PALETTE,
      multiYearColor: MULTI_YEAR_COLOR,
      landColor: LAND_COLOR,
      iceColor: ICE_COLOR,
      overlaySanctions: OVERLAY_SANCTIONS,
      overlayOldTanker: OVERLAY_OLD_TANKER,
      overlayAlpha: OVERLAY_ALPHA,
      dominanceThreshold: DOMINANCE_THRESHOLD
    }
  })
}

// Cached empty tile (shared across empty tile responses)
let emptyTilePromise = null
function getEmptyTile(tileSize) {
  if (!emptyTilePromise) {
    emptyTilePromise = sendToWorker('empty', { tileSize })
  }
  // Return a copy each time since MapLibre may transfer ownership
  return emptyTilePromise.then(buf => buf.slice(0))
}

export async function initCOG(url) {
  initWorker()
  cogSource = new COGTileSource(url, {})
  const metadata = await cogSource.initialize()
  const gdal = metadata.gdalMetadata || {}

  if (gdal.ALBEDO_CONFIG) {
    const config = JSON.parse(gdal.ALBEDO_CONFIG)
    cogConfig = config
    cogConfig.sanctionsBandOffset = config.sanctionsBandOffset ?? null
    cogConfig.oldTankerBandOffset = config.oldTankerBandOffset ?? null
    cogConfig.iceBand = config.iceBand ?? null
  } else {
    cogConfig = { years: [2023, 2024, 2025].slice(0, metadata.bandCount - 1), landBand: metadata.bandCount - 1, sanctionsBandOffset: null, oldTankerBandOffset: null, iceBand: null }
  }

  cogConfig.yearColors = Object.fromEntries(cogConfig.years.map((y, i) => [y, YEAR_PALETTE[i % YEAR_PALETTE.length]]))
  sendColorizerConfig()
  return cogConfig
}

export async function renderTile(z, x, y, bands = [0, 1, 2], land = true) {
  if (!cogSource) throw new Error('COG not initialized')
  selectedBands = bands
  showLand = land
  sendColorizerConfig()

  const raw = await cogSource.renderTileRaw(z, x, y)
  if (!raw) return getEmptyTile(cogSource.options.tileSize)

  // Transfer band arrays to worker (zero-copy)
  const transferables = raw.bands.map(b => b.buffer)
  return sendToWorker('render', { bands: raw.bands, params: raw.params }, transferables)
}

export function clearCache() {
  cogSource?.clearCache()
  emptyTilePromise = null
}

export async function switchCOG(url) {
  cogSource?.dispose()
  cogSource = cogConfig = null
  emptyTilePromise = null
  return initCOG(url)
}

export function setOverlayState({ sanctioned, oldTankers }) {
  if (sanctioned !== undefined) showSanctioned = sanctioned
  if (oldTankers !== undefined) showOldTankers = oldTankers
  sendColorizerConfig()
}

export function setIceState(visible) {
  showIce = visible
  sendColorizerConfig()
}

export { YEAR_PALETTE } from './config.js'
