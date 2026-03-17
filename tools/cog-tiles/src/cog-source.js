/**
 * COGTileSource - Client-side COG tile renderer for MapLibre GL
 *
 * Renders Cloud Optimized GeoTIFFs as raster tiles with:
 * - Automatic overview selection based on zoom level
 * - EPSG:4326 to Web Mercator reprojection
 * - Pluggable colorization
 * - Tile caching
 */

import { fromUrl, Pool } from 'geotiff'
import {
  tileToBBox,
  latToMercatorY,
  mercatorYToLat,
  bboxIntersects,
  MAX_MERCATOR_LAT
} from './geo.js'

/** Default tile size in pixels */
const DEFAULT_TILE_SIZE = 256

/** Default number of decoder threads */
const DEFAULT_POOL_SIZE = 4

/**
 * COG tile source for MapLibre GL
 */
export class COGTileSource {
  /**
   * Create a new COG tile source
   * @param {string} url - URL to the COG file
   * @param {Object} [options]
   * @param {Function} [options.colorize] - Colorizer function: (bands, x, y) => [r, g, b, a]
   * @param {number} [options.tileSize=256] - Output tile size in pixels
   * @param {number} [options.cacheSize=100] - Maximum cached images
   * @param {number} [options.poolSize=4] - Number of decoder threads
   * @param {number} [options.maxZoom=22] - Maximum zoom level
   * @param {number} [options.minZoom=0] - Minimum zoom level
   */
  constructor(url, options = {}) {
    this.url = url
    this.options = {
      tileSize: options.tileSize || DEFAULT_TILE_SIZE,
      cacheSize: options.cacheSize || 100,
      poolSize: options.poolSize || (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : DEFAULT_POOL_SIZE) || DEFAULT_POOL_SIZE,
      maxZoom: options.maxZoom ?? 22,
      minZoom: options.minZoom ?? 0,
      colorize: options.colorize || null
    }

    // Internal state
    this._tiff = null
    this._pool = null
    this._imageCache = new Map()
    this._mainImageBBox = null
    this._mainImageSize = null
    this._metadata = null
    this._initialized = false
    this._initializing = null
  }

  /**
   * Initialize the COG source (loads metadata)
   * @returns {Promise<Object>} COG metadata
   */
  async initialize() {
    if (this._initialized) {
      return this._metadata
    }

    // Prevent concurrent initialization
    if (this._initializing) {
      return this._initializing
    }

    this._initializing = this._doInitialize()
    return this._initializing
  }

  async _doInitialize() {
    this._tiff = await fromUrl(this.url, {
      cacheSize: this.options.cacheSize,
      blockSize: 65536,
    })

    this._pool = new Pool(this.options.poolSize)

    // Get main image for bbox and size (overviews don't have geotransform)
    const mainImage = await this._tiff.getImage(0)
    this._mainImageBBox = mainImage.getBoundingBox()
    this._mainImageSize = [mainImage.getWidth(), mainImage.getHeight()]

    // Extract metadata
    const fileDirectory = mainImage.fileDirectory
    this._metadata = {
      bbox: this._mainImageBBox,
      size: this._mainImageSize,
      bandCount: mainImage.getSamplesPerPixel(),
      fileDirectory: fileDirectory,
      gdalMetadata: this._parseGDALMetadata(fileDirectory.GDAL_METADATA)
    }

    this._initialized = true
    this._initializing = null

    return this._metadata
  }

  /**
   * Parse GDAL metadata XML
   * @private
   */
  _parseGDALMetadata(xml) {
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
   * Get the appropriate image for a zoom level (uses COG overviews)
   * @private
   */
  async _getImageForZoom(z) {
    if (this._imageCache.has(z)) {
      return this._imageCache.get(z)
    }

    const imageCount = await this._tiff.getImageCount()
    // Map zoom to overview: higher z = more detail = lower overview index
    const overviewIndex = Math.max(0, Math.min(imageCount - 1, 8 - z))

    const image = await this._tiff.getImage(overviewIndex)
    this._imageCache.set(z, image)
    return image
  }

  /**
   * Create an empty transparent tile
   * @private
   */
  async _createEmptyTile() {
    const size = this.options.tileSize
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, size, size)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return await blob.arrayBuffer()
  }

  /**
   * Render a tile
   * @param {number} z - Zoom level
   * @param {number} x - Tile X coordinate
   * @param {number} y - Tile Y coordinate
   * @returns {Promise<ArrayBuffer>} PNG tile as ArrayBuffer
   */
  async renderTile(z, x, y) {
    if (!this._initialized) {
      await this.initialize()
    }

    const tileSize = this.options.tileSize
    const image = await this._getImageForZoom(z)
    const [imgWidth, imgHeight] = [image.getWidth(), image.getHeight()]

    // COG bbox in EPSG:4326
    const [cogMinLon, cogMinLat, cogMaxLon, cogMaxLat] = this._mainImageBBox

    // Tile bbox in EPSG:4326
    const tileBBox = tileToBBox(z, x, y)
    const [tileMinLon, tileMinLat, tileMaxLon, tileMaxLat] = tileBBox

    // Check intersection
    if (!bboxIntersects(tileBBox, this._mainImageBBox)) {
      return await this._createEmptyTile()
    }
    if (tileMinLat > MAX_MERCATOR_LAT) {
      return await this._createEmptyTile()
    }

    // Scale from main image to current overview
    const scaleX = imgWidth / this._mainImageSize[0]
    const scaleY = imgHeight / this._mainImageSize[1]

    // Pixel size in degrees (main image)
    const pixelWidthDeg = (cogMaxLon - cogMinLon) / this._mainImageSize[0]
    const pixelHeightDeg = (cogMaxLat - cogMinLat) / this._mainImageSize[1]

    // Calculate X (longitude) window
    const mainWindowX = (tileMinLon - cogMinLon) / pixelWidthDeg
    const mainWindowWidth = (tileMaxLon - tileMinLon) / pixelWidthDeg

    // Calculate Y window (clamp to COG bounds and Mercator limit)
    const readMinLat = Math.max(tileMinLat, cogMinLat)
    const readMaxLat = Math.min(tileMaxLat, cogMaxLat, MAX_MERCATOR_LAT)

    const mainWindowYTop = (cogMaxLat - readMaxLat) / pixelHeightDeg
    const mainWindowYBottom = (cogMaxLat - readMinLat) / pixelHeightDeg

    // Scale to overview coordinates
    const windowX = mainWindowX * scaleX
    const windowWidth = mainWindowWidth * scaleX
    const windowYTop = mainWindowYTop * scaleY
    const windowYBottom = mainWindowYBottom * scaleY

    // Clamp to image bounds
    const srcLeft = Math.max(0, windowX)
    const srcRight = Math.min(imgWidth, windowX + windowWidth)
    const srcTop = Math.max(0, windowYTop)
    const srcBottom = Math.min(imgHeight, windowYBottom)

    const srcWidth = srcRight - srcLeft
    const srcHeight = srcBottom - srcTop

    if (srcWidth <= 0 || srcHeight <= 0) {
      return await this._createEmptyTile()
    }

    // Calculate destination region
    const dstLeft = Math.round(((srcLeft - windowX) / windowWidth) * tileSize)
    const dstRight = Math.round(((srcRight - windowX) / windowWidth) * tileSize)
    const dstWidth = dstRight - dstLeft

    // Y requires Mercator projection
    const tileMercMinY = latToMercatorY(tileMinLat)
    const tileMercMaxY = latToMercatorY(tileMaxLat)
    const tileMercHeight = tileMercMaxY - tileMercMinY

    const actualMinLat = cogMaxLat - (srcBottom / scaleY) * pixelHeightDeg
    const actualMaxLat = cogMaxLat - (srcTop / scaleY) * pixelHeightDeg

    const actualMercMinY = latToMercatorY(actualMinLat)
    const actualMercMaxY = latToMercatorY(actualMaxLat)

    const dstTop = Math.round(((tileMercMaxY - actualMercMaxY) / tileMercHeight) * tileSize)
    const dstBottom = Math.round(((tileMercMaxY - actualMercMinY) / tileMercHeight) * tileSize)
    const dstHeight = dstBottom - dstTop

    if (dstWidth <= 0 || dstHeight <= 0) {
      return await this._createEmptyTile()
    }

    try {
      // Read rasters at native resolution
      const srcLeftInt = Math.floor(srcLeft)
      const srcTopInt = Math.floor(srcTop)
      const srcRightInt = Math.ceil(srcRight)
      const srcBottomInt = Math.ceil(srcBottom)

      const rasters = await image.readRasters({
        window: [srcLeftInt, srcTopInt, srcRightInt, srcBottomInt],
        resampleMethod: 'nearest',
        pool: this._pool,
      })

      // Precise latitude bounds of what we read
      const readMinLatActual = cogMaxLat - (srcBottomInt / scaleY) * pixelHeightDeg
      const readMaxLatActual = cogMaxLat - (srcTopInt / scaleY) * pixelHeightDeg

      // Source longitude range
      const srcMinLon = cogMinLon + (srcLeftInt / scaleX) * pixelWidthDeg
      const srcMaxLon = cogMinLon + (srcRightInt / scaleX) * pixelWidthDeg

      return await this._colorizeWithReprojection(
        rasters,
        dstLeft, dstTop, dstWidth, dstHeight,
        readMinLatActual, readMaxLatActual,
        srcMinLon, srcMaxLon,
        tileMinLon, tileMaxLon,
        tileMinLat, tileMaxLat
      )
    } catch (err) {
      return await this._createEmptyTile()
    }
  }

  /**
   * Render a tile and return raw raster data + reprojection params (no colorization)
   * Useful for offloading colorization to a Web Worker.
   * @param {number} z - Zoom level
   * @param {number} x - Tile X coordinate
   * @param {number} y - Tile Y coordinate
   * @returns {Promise<Object|null>} { rasters, params } or null for empty tiles
   */
  async renderTileRaw(z, x, y) {
    if (!this._initialized) {
      await this.initialize()
    }

    const tileSize = this.options.tileSize
    const image = await this._getImageForZoom(z)
    const [imgWidth, imgHeight] = [image.getWidth(), image.getHeight()]

    const [cogMinLon, cogMinLat, cogMaxLon, cogMaxLat] = this._mainImageBBox
    const tileBBox = tileToBBox(z, x, y)
    const [tileMinLon, tileMinLat, tileMaxLon, tileMaxLat] = tileBBox

    if (!bboxIntersects(tileBBox, this._mainImageBBox)) return null
    if (tileMinLat > MAX_MERCATOR_LAT) return null

    const scaleX = imgWidth / this._mainImageSize[0]
    const scaleY = imgHeight / this._mainImageSize[1]
    const pixelWidthDeg = (cogMaxLon - cogMinLon) / this._mainImageSize[0]
    const pixelHeightDeg = (cogMaxLat - cogMinLat) / this._mainImageSize[1]

    const mainWindowX = (tileMinLon - cogMinLon) / pixelWidthDeg
    const mainWindowWidth = (tileMaxLon - tileMinLon) / pixelWidthDeg
    const readMinLat = Math.max(tileMinLat, cogMinLat)
    const readMaxLat = Math.min(tileMaxLat, cogMaxLat, MAX_MERCATOR_LAT)
    const mainWindowYTop = (cogMaxLat - readMaxLat) / pixelHeightDeg
    const mainWindowYBottom = (cogMaxLat - readMinLat) / pixelHeightDeg

    const windowX = mainWindowX * scaleX
    const windowWidth = mainWindowWidth * scaleX
    const windowYTop = mainWindowYTop * scaleY
    const windowYBottom = mainWindowYBottom * scaleY

    const srcLeft = Math.max(0, windowX)
    const srcRight = Math.min(imgWidth, windowX + windowWidth)
    const srcTop = Math.max(0, windowYTop)
    const srcBottom = Math.min(imgHeight, windowYBottom)
    const srcWidth = srcRight - srcLeft
    const srcHeight = srcBottom - srcTop
    if (srcWidth <= 0 || srcHeight <= 0) return null

    const dstLeft = Math.round(((srcLeft - windowX) / windowWidth) * tileSize)
    const dstRight = Math.round(((srcRight - windowX) / windowWidth) * tileSize)
    const dstWidth = dstRight - dstLeft

    const tileMercMinY = latToMercatorY(tileMinLat)
    const tileMercMaxY = latToMercatorY(tileMaxLat)
    const tileMercHeight = tileMercMaxY - tileMercMinY

    const actualMinLat = cogMaxLat - (srcBottom / scaleY) * pixelHeightDeg
    const actualMaxLat = cogMaxLat - (srcTop / scaleY) * pixelHeightDeg
    const actualMercMinY = latToMercatorY(actualMinLat)
    const actualMercMaxY = latToMercatorY(actualMaxLat)

    const dstTop = Math.round(((tileMercMaxY - actualMercMaxY) / tileMercHeight) * tileSize)
    const dstBottom = Math.round(((tileMercMaxY - actualMercMinY) / tileMercHeight) * tileSize)
    const dstHeight = dstBottom - dstTop
    if (dstWidth <= 0 || dstHeight <= 0) return null

    try {
      const srcLeftInt = Math.floor(srcLeft)
      const srcTopInt = Math.floor(srcTop)
      const srcRightInt = Math.ceil(srcRight)
      const srcBottomInt = Math.ceil(srcBottom)

      const rasters = await image.readRasters({
        window: [srcLeftInt, srcTopInt, srcRightInt, srcBottomInt],
        resampleMethod: 'nearest',
        pool: this._pool,
      })

      const readMinLatActual = cogMaxLat - (srcBottomInt / scaleY) * pixelHeightDeg
      const readMaxLatActual = cogMaxLat - (srcTopInt / scaleY) * pixelHeightDeg
      const srcMinLon = cogMinLon + (srcLeftInt / scaleX) * pixelWidthDeg
      const srcMaxLon = cogMinLon + (srcRightInt / scaleX) * pixelWidthDeg

      // Convert rasters to plain Float32Arrays for transfer
      const bandArrays = []
      for (let b = 0; b < rasters.length; b++) {
        bandArrays.push(new Float32Array(rasters[b]))
      }

      return {
        bands: bandArrays,
        params: {
          tileSize, dstLeft, dstTop, dstWidth, dstHeight,
          srcMinLat: readMinLatActual, srcMaxLat: readMaxLatActual,
          srcMinLon, srcMaxLon,
          tileMinLon, tileMaxLon, tileMinLat, tileMaxLat,
          srcWidth: rasters.width, srcHeight: rasters.height
        }
      }
    } catch (err) {
      return null
    }
  }

  /**
   * Colorize raster data with EPSG:4326 to Web Mercator reprojection
   * @private
   */
  async _colorizeWithReprojection(
    rasters,
    dstLeft, dstTop, dstWidth, dstHeight,
    srcMinLat, srcMaxLat,
    srcMinLon, srcMaxLon,
    tileMinLon, tileMaxLon,
    tileMinLat, tileMaxLat
  ) {
    const tileSize = this.options.tileSize
    const canvas = new OffscreenCanvas(tileSize, tileSize)
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, tileSize, tileSize)

    const imageData = ctx.createImageData(dstWidth, dstHeight)
    const pixels = imageData.data

    const srcHeight = rasters.height
    const srcWidth = rasters.width
    const bandCount = rasters.length

    // Mercator Y range for the tile
    const tileMercMinY = latToMercatorY(tileMinLat)
    const tileMercMaxY = latToMercatorY(tileMaxLat)
    const tileMercHeight = tileMercMaxY - tileMercMinY

    const tileLonWidth = tileMaxLon - tileMinLon
    const srcLonWidth = srcMaxLon - srcMinLon

    // Get colorizer
    const colorize = this.options.colorize || this._defaultColorize.bind(this)

    // Pre-allocate reusable arrays (avoids 65k allocations per tile)
    const bands = new Array(bandCount)
    const color = [0, 0, 0, 0]

    // Pre-compute Mercator Y per row (avoids trig per pixel — only per row)
    const rowToSrcRow = new Int32Array(dstHeight)
    const latScale = 1 / (srcMaxLat - srcMinLat) * srcHeight
    for (let dstRow = 0; dstRow < dstHeight; dstRow++) {
      const tileY = dstTop + dstRow
      const mercY = tileMercMaxY - ((tileY + 0.5) / tileSize) * tileMercHeight
      const lat = mercatorYToLat(mercY)
      if (lat > MAX_MERCATOR_LAT) { rowToSrcRow[dstRow] = -1; continue }
      const srcRowFrac = (srcMaxLat - lat) * latScale
      rowToSrcRow[dstRow] = Math.floor(Math.max(0, Math.min(srcHeight - 1, srcRowFrac)))
    }

    // Pre-compute source column per destination column
    const colToSrcCol = new Int32Array(dstWidth)
    for (let col = 0; col < dstWidth; col++) {
      const tileX = dstLeft + col
      const lon = tileMinLon + ((tileX + 0.5) / tileSize) * tileLonWidth
      const srcColFrac = ((lon - srcMinLon) / srcLonWidth) * srcWidth
      colToSrcCol[col] = Math.floor(Math.max(0, Math.min(srcWidth - 1, srcColFrac)))
    }

    // Per-pixel sampling with Mercator reprojection
    for (let dstRow = 0; dstRow < dstHeight; dstRow++) {
      const srcRow = rowToSrcRow[dstRow]
      if (srcRow === -1) continue
      const tileY = dstTop + dstRow
      const rowOffset = srcRow * srcWidth

      for (let col = 0; col < dstWidth; col++) {
        const px = (dstRow * dstWidth + col) * 4
        const srcIdx = rowOffset + colToSrcCol[col]

        // Collect band values into reusable array
        for (let b = 0; b < bandCount; b++) {
          bands[b] = rasters[b][srcIdx] || 0
        }

        // Apply colorizer
        const c = colorize(bands, dstLeft + col, tileY)
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

  /**
   * Default colorizer (grayscale first band)
   * @private
   */
  _defaultColorize(bands) {
    const v = Math.min(255, Math.max(0, bands[0] || 0))
    return [v, v, v, bands[0] ? 255 : 0]
  }

  /**
   * Create a MapLibre-compatible protocol handler
   * @param {string} [protocolName='cog'] - Protocol name (e.g., 'cog' for 'cog://...')
   * @returns {Object} Protocol handler for maplibregl.addProtocol()
   */
  createProtocol(protocolName = 'cog') {
    const source = this

    return {
      name: protocolName,
      handler: async (params, abortController) => {
        // Parse URL: cog://z/x/y
        const parts = params.url.replace(`${protocolName}://`, '').split('/')
        const z = parseInt(parts[0])
        const x = parseInt(parts[1])
        const y = parseInt(parts[2])

        try {
          const data = await source.renderTile(z, x, y)
          return { data }
        } catch (err) {
          throw err
        }
      }
    }
  }

  /**
   * Get a MapLibre source configuration object
   * @param {string} [protocolName='cog'] - Protocol name
   * @returns {Object} Source configuration for map.addSource()
   */
  getSourceConfig(protocolName = 'cog') {
    return {
      type: 'raster',
      tiles: [`${protocolName}://{z}/{x}/{y}`],
      tileSize: this.options.tileSize,
      minzoom: this.options.minZoom,
      maxzoom: this.options.maxZoom,
    }
  }

  /**
   * Get COG metadata
   * @returns {Object|null} Metadata or null if not initialized
   */
  getMetadata() {
    return this._metadata
  }

  /**
   * Get COG bounding box
   * @returns {number[]|null} [minLon, minLat, maxLon, maxLat] or null
   */
  getBBox() {
    return this._mainImageBBox
  }

  /**
   * Check if source is initialized
   * @returns {boolean}
   */
  isInitialized() {
    return this._initialized
  }

  /**
   * Clear image cache
   */
  clearCache() {
    this._imageCache.clear()
  }

  /**
   * Dispose of resources
   */
  dispose() {
    this._imageCache.clear()
    this._tiff = null
    this._pool = null
    this._initialized = false
  }
}
