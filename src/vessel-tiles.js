/**
 * Hilbert-curve ordered, block-compressed vessel data (v2)
 * Single file with range requests - ~200 lines, zero dependencies
 */

// Hilbert curve order (must match Python export)
const HILBERT_ORDER = 16

let flags = []
let vesselTypes = []
let vessels = []
let blockIndex = []  // [{hilbertStart, hilbertEnd, offset, compressedLen}]
let dataUrl = ''
let blockCache = new Map()  // blockId -> Map(cellKey -> vessels[])

/**
 * Convert lat/lon to grid coordinates for Hilbert curve
 */
function latLonToGrid(lat, lon) {
  const latGrid = Math.floor((lat + 90) * 100)
  const lonGrid = Math.floor((lon + 180) * 100)
  return [latGrid, lonGrid]
}

/**
 * Convert 2D coordinates to Hilbert curve index
 * Order n maps a 2^n x 2^n grid to a 1D index
 */
function xyToHilbert(x, y, order = HILBERT_ORDER) {
  let d = 0
  let s = 1 << (order - 1)  // Start at 2^(order-1)
  while (s > 0) {
    const rx = (x & s) > 0 ? 1 : 0
    const ry = (y & s) > 0 ? 1 : 0
    d += s * s * ((3 * rx) ^ ry)
    // Rotate
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

  const version = headerView.getUint16(4, true)
  if (version !== 2) {
    throw new Error(`Unsupported version: ${version}`)
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
  if (blockCache.has(blockId)) {
    return blockCache.get(blockId)
  }

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
      const yearOffset = view.getUint8(offset)
      offset += 1
      const hours = view.getUint16(offset, true)
      offset += 2

      const vessel = vessels[vesselId] || { mmsi: '', shipName: '' }
      cellVessels.push({
        mmsi: vessel.mmsi,
        ship_name: vessel.shipName,
        flag: flags[flagId] || null,
        vessel_type: vesselTypes[typeId] || null,
        year: 2020 + yearOffset,
        total_hours: hours,
        cell_count: totalCount
      })
    }

    const cellKey = `${lat.toFixed(2)}_${lon.toFixed(2)}`
    cells.set(cellKey, cellVessels)
  }

  blockCache.set(blockId, cells)
  return cells
}

/**
 * Query vessels at a grid cell
 * @param {number} lat Latitude
 * @param {number} lon Longitude
 * @param {number|null} year Optional year filter
 * @returns {Promise<Array>} Array of vessel objects
 */
export async function queryVesselsAt(lat, lon, year = null) {
  // Convert to Hilbert index
  const [latGrid, lonGrid] = latLonToGrid(lat, lon)
  const hilbert = xyToHilbert(latGrid, lonGrid)

  // Find block
  const blockId = findBlock(hilbert)
  if (blockId === -1) {
    return []
  }

  // Load block
  const cells = await loadBlock(blockId)

  // Snap to grid and lookup
  const gridLat = (Math.round(lat * 100) / 100).toFixed(2)
  const gridLon = (Math.round(lon * 100) / 100).toFixed(2)
  const cellKey = `${gridLat}_${gridLon}`

  let result = cells.get(cellKey) || []

  if (year !== null) {
    result = result.filter(v => v.year === year)
  }

  return result
}

/**
 * Check if tiles are initialized
 */
export function isInitialized() {
  return vessels.length > 0
}
