/**
 * Hilbert-curve ordered, block-compressed vessel data (v2)
 * Single file with range requests - ~200 lines, one dependency
 */

import { latLonToHilbert, snapToGrid } from './geo.js'

let flags = []
let vesselTypes = []
let vessels = []
let blockIndex = []  // [{hilbertStart, hilbertEnd, offset, compressedLen}]
let dataUrl = ''
let dataVersion = 2  // Track format version for parsing

// LRU cache for blocks (limits memory on long sessions)
const CACHE_MAX_SIZE = 64
let blockCache = new Map()  // blockId -> Map(cellKey -> vessels[])
let cacheOrder = []  // LRU order tracking

function cacheGet(blockId) {
  if (!blockCache.has(blockId)) return null
  // Move to end (most recently used)
  const idx = cacheOrder.indexOf(blockId)
  if (idx > -1) cacheOrder.splice(idx, 1)
  cacheOrder.push(blockId)
  return blockCache.get(blockId)
}

function cacheSet(blockId, data) {
  // Evict oldest if at capacity
  while (cacheOrder.length >= CACHE_MAX_SIZE) {
    const oldest = cacheOrder.shift()
    blockCache.delete(oldest)
  }
  blockCache.set(blockId, data)
  cacheOrder.push(blockId)
}

/**
 * Binary search to find block containing hilbert index
 */
function findBlock(hilbert) {
  let lo = 0
  let hi = blockIndex.length - 1

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const block = blockIndex[mid]

    if (hilbert < block.hilbertStart) {
      hi = mid - 1
    } else if (hilbert > block.hilbertEnd) {
      lo = mid + 1
    } else {
      return mid
    }
  }
  return -1
}

/**
 * Decompress gzip data using DecompressionStream
 */
async function decompress(compressed) {
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  writer.write(compressed)
  writer.close()
  const reader = ds.readable.getReader()
  const chunks = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0)
  const result = new Uint8Array(total)
  let pos = 0
  for (const chunk of chunks) {
    result.set(chunk, pos)
    pos += chunk.length
  }
  return result.buffer
}

/**
 * Initialize by loading header, block index, and lookup tables via range request
 * @param {string} url URL to vessel_data.bin
 */
export async function initVesselTiles(url) {
  dataUrl = url

  // First, fetch just the header (16 bytes) to get sizes
  const headerResp = await fetch(url, {
    headers: { Range: 'bytes=0-15' }
  })
  const headerBuf = await headerResp.arrayBuffer()
  const headerView = new DataView(headerBuf)

  // Parse header
  const magic = new TextDecoder().decode(new Uint8Array(headerBuf, 0, 4))
  if (magic !== 'VSSL') {
    throw new Error(`Invalid magic: ${magic}`)
  }

  dataVersion = headerView.getUint16(4, true)
  if (dataVersion !== 2 && dataVersion !== 3) {
    throw new Error(`Unsupported version: ${dataVersion}`)
  }

  const blockCount = headerView.getUint16(6, true)
  const cellCount = headerView.getUint32(8, true)
  const lookupOffset = headerView.getUint32(12, true)

  // Calculate how much we need to fetch (header + index + lookup)
  // We need to know lookup size - fetch index first to find first block offset
  const indexSize = blockCount * 16
  const indexEnd = 16 + indexSize - 1

  // Fetch index
  const indexResp = await fetch(url, {
    headers: { Range: `bytes=16-${indexEnd}` }
  })
  const indexBuf = await indexResp.arrayBuffer()
  const indexView = new DataView(indexBuf)

  // Parse block index and find first block offset (= end of lookup)
  blockIndex = []
  let firstBlockOffset = 0
  for (let i = 0; i < blockCount; i++) {
    const offset = i * 16
    const entry = {
      hilbertStart: indexView.getUint32(offset, true),
      hilbertEnd: indexView.getUint32(offset + 4, true),
      offset: indexView.getUint32(offset + 8, true),
      compressedLen: indexView.getUint32(offset + 12, true)
    }
    blockIndex.push(entry)
    if (i === 0) {
      firstBlockOffset = entry.offset
    }
  }

  // Now fetch lookup tables (from lookupOffset to firstBlockOffset - 1)
  const lookupResp = await fetch(url, {
    headers: { Range: `bytes=${lookupOffset}-${firstBlockOffset - 1}` }
  })
  const lookupBuf = await lookupResp.arrayBuffer()
  const lookupView = new DataView(lookupBuf)
  let lookupPos = 0

  // Parse flags
  const flagCount = lookupView.getUint16(lookupPos, true)
  lookupPos += 2
  flags = []
  for (let i = 0; i < flagCount; i++) {
    const len = lookupView.getUint8(lookupPos)
    lookupPos += 1
    flags.push(new TextDecoder().decode(new Uint8Array(lookupBuf, lookupPos, len)))
    lookupPos += len
  }

  // Parse vessel types
  const typeCount = lookupView.getUint16(lookupPos, true)
  lookupPos += 2
  vesselTypes = []
  for (let i = 0; i < typeCount; i++) {
    const len = lookupView.getUint8(lookupPos)
    lookupPos += 1
    vesselTypes.push(new TextDecoder().decode(new Uint8Array(lookupBuf, lookupPos, len)))
    lookupPos += len
  }

  // Parse vessels
  const vesselCount = lookupView.getUint32(lookupPos, true)
  lookupPos += 4
  vessels = []
  for (let i = 0; i < vesselCount; i++) {
    const mmsiBytes = new Uint8Array(lookupBuf, lookupPos, 12)
    const mmsi = new TextDecoder().decode(mmsiBytes).replace(/\0+$/, '')
    lookupPos += 12
    const nameLen = lookupView.getUint8(lookupPos)
    lookupPos += 1
    const shipName = new TextDecoder().decode(new Uint8Array(lookupBuf, lookupPos, nameLen))
    lookupPos += nameLen
    vessels.push({ mmsi, shipName })
  }

  console.log(`Vessel tiles v2 initialized: ${blockCount} blocks, ${cellCount} cells, ${vessels.length} vessels`)
}

/**
 * Fetch and parse a block
 */
async function loadBlock(blockId) {
  const cached = cacheGet(blockId)
  if (cached) return cached

  const block = blockIndex[blockId]
  const resp = await fetch(dataUrl, {
    headers: { Range: `bytes=${block.offset}-${block.offset + block.compressedLen - 1}` }
  })
  const compressed = await resp.arrayBuffer()
  const buf = await decompress(new Uint8Array(compressed))
  const view = new DataView(buf)
  let offset = 0

  const cellCount = view.getUint16(offset, true)
  offset += 2
  const cells = new Map()

  for (let i = 0; i < cellCount; i++) {
    const lat = view.getInt16(offset, true) / 100
    offset += 2
    const lon = view.getInt16(offset, true) / 100
    offset += 2
    const totalCount = view.getUint16(offset, true)
    offset += 2
    const vesselCount = view.getUint8(offset)
    offset += 1

    const cellVessels = []
    for (let j = 0; j < vesselCount; j++) {
      const vesselId = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
      offset += 3
      const flagId = view.getUint8(offset)
      offset += 1
      const typeId = view.getUint8(offset)
      offset += 1
      const yearMask = view.getUint8(offset)
      offset += 1
      const hours = view.getUint16(offset, true)
      offset += 2

      // v3 adds timestamps
      let firstSeen = null
      let lastSeen = null
      if (dataVersion >= 3) {
        const firstTs = view.getUint32(offset, true)
        offset += 4
        const lastTs = view.getUint32(offset, true)
        offset += 4
        // Convert Unix timestamps to ISO strings (0 means no data)
        if (firstTs > 0) firstSeen = new Date(firstTs * 1000).toISOString()
        if (lastTs > 0) lastSeen = new Date(lastTs * 1000).toISOString()
      }

      const vessel = vessels[vesselId] || { mmsi: '', shipName: '' }
      cellVessels.push({
        mmsi: vessel.mmsi,
        ship_name: vessel.shipName,
        flag: flags[flagId] || null,
        vessel_type: vesselTypes[typeId] || null,
        year_mask: yearMask,
        total_hours: hours,
        cell_count: totalCount,
        first_seen: firstSeen,
        last_seen: lastSeen
      })
    }

    const cellKey = `${lat.toFixed(2)}_${lon.toFixed(2)}`
    cells.set(cellKey, cellVessels)
  }

  cacheSet(blockId, cells)
  return cells
}

/**
 * Query vessels at a grid cell
 * Uses geo.js for coordinate math - see snapToGrid() for pixel-is-area convention
 *
 * @param {number} lat Latitude
 * @param {number} lon Longitude
 * @param {number|null} year Optional year filter
 * @param {string|null} vesselType Optional vessel type filter
 * @returns {Promise<Array>} Array of vessel objects
 */
export async function queryVesselsAt(lat, lon, year = null, vesselType = null) {
  const hilbert = latLonToHilbert(lat, lon)
  const blockId = findBlock(hilbert)
  if (blockId === -1) return []

  const cells = await loadBlock(blockId)
  const { key: cellKey } = snapToGrid(lat, lon)

  let result = cells.get(cellKey) || []

  if (year !== null) {
    const bit = 1 << (year - 2020)
    result = result.filter(v => v.year_mask & bit)
  }

  if (vesselType !== null) {
    result = result.filter(v => v.vessel_type === vesselType)
  }

  return result
}

/**
 * Check if tiles are initialized
 */
export function isInitialized() {
  return vessels.length > 0
}
