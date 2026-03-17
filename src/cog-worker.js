/**
 * Web Worker for COG tile colorization + Mercator reprojection + PNG encoding.
 * Receives raw raster bands from main thread, returns PNG ArrayBuffer.
 */

const MERCATOR_EXTENT = 20037508.34
const MAX_MERCATOR_LAT = 85

function latToMercatorY(lat) {
  const latRad = lat * Math.PI / 180
  return MERCATOR_EXTENT * Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI
}

function mercatorYToLat(y) {
  return (Math.atan(Math.exp(y * Math.PI / MERCATOR_EXTENT)) * 360 / Math.PI) - 90
}

function alphaBlend(base, overlay, alpha) {
  return [
    Math.round(base[0] * (1 - alpha) + overlay[0] * alpha),
    Math.round(base[1] * (1 - alpha) + overlay[1] * alpha),
    Math.round(base[2] * (1 - alpha) + overlay[2] * alpha),
  ]
}

// Colorizer state — updated via 'config' messages from main thread
let colorizerConfig = null

function colorize(bands) {
  const cfg = colorizerConfig
  if (!cfg) return [0, 0, 0, 0]

  const landIdx = cfg.landBand ?? bands.length - 1
  const iceIdx = cfg.iceBand ?? null

  // Ice pixel
  if (iceIdx != null && bands[iceIdx] === 1) {
    if (!cfg.showLand) return [0, 0, 0, 0]
    if (cfg.showIce) return [...cfg.iceColor, 255]
    if (bands[landIdx] === 1) return [...cfg.landColor, 255]
    return [0, 0, 0, 0]
  }

  // Land pixel
  if (bands[landIdx] === 1) return cfg.showLand ? [...cfg.landColor, 255] : [0, 0, 0, 0]

  const selectedBands = cfg.selectedBands
  if (!selectedBands.length) return [0, 0, 0, 0]

  let total = 0
  let maxVal = 0, maxIdx = 0
  for (let j = 0; j < selectedBands.length; j++) {
    const v = bands[selectedBands[j]] || 0
    total += v
    if (v > maxVal) { maxVal = v; maxIdx = j }
  }

  // Overlay totals
  let oldTankerTotal = 0
  if (cfg.showOldTankers && cfg.oldTankerBandOffset != null) {
    for (const b of selectedBands) oldTankerTotal += bands[b + cfg.oldTankerBandOffset] || 0
  }
  let sanctionsTotal = 0
  if (cfg.showSanctioned && cfg.sanctionsBandOffset != null) {
    for (const b of selectedBands) sanctionsTotal += bands[b + cfg.sanctionsBandOffset] || 0
  }

  if (total === 0 && oldTankerTotal === 0 && sanctionsTotal === 0) return [0, 0, 0, 0]

  let r, g, b
  if (total > 0) {
    const brightness = Math.min(1, Math.max(0.7, Math.log1p(total) / Math.log1p(50)))
    const color = maxVal / total >= cfg.dominanceThreshold
      ? (cfg.yearPalette[selectedBands[maxIdx] % cfg.yearPalette.length] || cfg.multiYearColor)
      : cfg.multiYearColor
    r = Math.round(color[0] * brightness)
    g = Math.round(color[1] * brightness)
    b = Math.round(color[2] * brightness)
  } else {
    r = 0; g = 0; b = 0
  }

  if (oldTankerTotal > 0) {
    ;[r, g, b] = alphaBlend([r, g, b], cfg.overlayOldTanker, cfg.overlayAlpha)
  }
  if (sanctionsTotal > 0) {
    ;[r, g, b] = alphaBlend([r, g, b], cfg.overlaySanctions, cfg.overlayAlpha)
  }

  return [r, g, b, 255]
}

// Cached empty tile PNG
let emptyTileBuffer = null
async function getEmptyTile(tileSize) {
  if (emptyTileBuffer) return emptyTileBuffer
  const canvas = new OffscreenCanvas(tileSize, tileSize)
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, tileSize, tileSize)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  emptyTileBuffer = await blob.arrayBuffer()
  return emptyTileBuffer
}

async function renderTile(bands, params) {
  const {
    tileSize, dstLeft, dstTop, dstWidth, dstHeight,
    srcMinLat, srcMaxLat, srcMinLon, srcMaxLon,
    tileMinLon, tileMaxLon, tileMinLat, tileMaxLat,
    srcWidth, srcHeight
  } = params

  const bandCount = bands.length
  const canvas = new OffscreenCanvas(tileSize, tileSize)
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, tileSize, tileSize)

  const imageData = ctx.createImageData(dstWidth, dstHeight)
  const pixels = imageData.data

  const tileMercMinY = latToMercatorY(tileMinLat)
  const tileMercMaxY = latToMercatorY(tileMaxLat)
  const tileMercHeight = tileMercMaxY - tileMercMinY
  const tileLonWidth = tileMaxLon - tileMinLon
  const srcLonWidth = srcMaxLon - srcMinLon

  // Pre-allocate reusable band array
  const bandValues = new Array(bandCount)

  // Pre-compute row mapping
  const rowToSrcRow = new Int32Array(dstHeight)
  const latScale = 1 / (srcMaxLat - srcMinLat) * srcHeight
  for (let dstRow = 0; dstRow < dstHeight; dstRow++) {
    const tileY = dstTop + dstRow
    const mercY = tileMercMaxY - ((tileY + 0.5) / tileSize) * tileMercHeight
    const lat = mercatorYToLat(mercY)
    if (lat > MAX_MERCATOR_LAT) { rowToSrcRow[dstRow] = -1; continue }
    rowToSrcRow[dstRow] = Math.floor(Math.max(0, Math.min(srcHeight - 1, (srcMaxLat - lat) * latScale)))
  }

  // Pre-compute column mapping
  const colToSrcCol = new Int32Array(dstWidth)
  for (let col = 0; col < dstWidth; col++) {
    const tileX = dstLeft + col
    const lon = tileMinLon + ((tileX + 0.5) / tileSize) * tileLonWidth
    colToSrcCol[col] = Math.floor(Math.max(0, Math.min(srcWidth - 1, ((lon - srcMinLon) / srcLonWidth) * srcWidth)))
  }

  // Per-pixel loop
  for (let dstRow = 0; dstRow < dstHeight; dstRow++) {
    const srcRow = rowToSrcRow[dstRow]
    if (srcRow === -1) continue
    const tileY = dstTop + dstRow
    const rowOffset = srcRow * srcWidth

    for (let col = 0; col < dstWidth; col++) {
      const px = (dstRow * dstWidth + col) * 4
      const srcIdx = rowOffset + colToSrcCol[col]

      for (let b = 0; b < bandCount; b++) {
        bandValues[b] = bands[b][srcIdx] || 0
      }

      const c = colorize(bandValues)
      pixels[px] = c[0]
      pixels[px + 1] = c[1]
      pixels[px + 2] = c[2]
      pixels[px + 3] = c[3]
    }
  }

  ctx.putImageData(imageData, dstLeft, dstTop)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await blob.arrayBuffer()
}

self.onmessage = async (e) => {
  const { type, id } = e.data

  if (type === 'config') {
    colorizerConfig = e.data.config
    return
  }

  if (type === 'render') {
    const { bands, params } = e.data
    try {
      const buffer = await renderTile(bands, params)
      self.postMessage({ id, buffer }, [buffer])
    } catch (err) {
      const empty = await getEmptyTile(params.tileSize)
      // Clone since we cache the empty tile
      const copy = empty.slice(0)
      self.postMessage({ id, buffer: copy }, [copy])
    }
    return
  }

  if (type === 'empty') {
    const buffer = await getEmptyTile(e.data.tileSize)
    const copy = buffer.slice(0)
    self.postMessage({ id, buffer: copy }, [copy])
  }
}
