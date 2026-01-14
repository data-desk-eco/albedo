/**
 * Binary tile-based vessel lookup - ~50 lines, zero dependencies
 * Replaces sql.js-httpvfs for vessel tooltips
 */

let flags = []
let vesselTypes = []
let vessels = []  // [{mmsi, shipName}, ...]
let tilesBaseUrl = ''
let tileCache = new Map()

/**
 * Initialize by loading lookup tables
 * @param {string} baseUrl Base URL for tiles directory
 */
export async function initVesselTiles(baseUrl) {
  tilesBaseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'

  const resp = await fetch(tilesBaseUrl + 'lookup.bin')
  const buf = await resp.arrayBuffer()
  const view = new DataView(buf)
  let offset = 0

  // Read flags
  const flagCount = view.getUint16(offset, true); offset += 2
  flags = []
  for (let i = 0; i < flagCount; i++) {
    const len = view.getUint8(offset); offset += 1
    flags.push(new TextDecoder().decode(new Uint8Array(buf, offset, len)))
    offset += len
  }

  // Read vessel types
  const typeCount = view.getUint16(offset, true); offset += 2
  vesselTypes = []
  for (let i = 0; i < typeCount; i++) {
    const len = view.getUint8(offset); offset += 1
    vesselTypes.push(new TextDecoder().decode(new Uint8Array(buf, offset, len)))
    offset += len
  }

  // Read vessels (mmsi + ship_name)
  const vesselCount = view.getUint32(offset, true); offset += 4
  vessels = []
  for (let i = 0; i < vesselCount; i++) {
    const mmsiBytes = new Uint8Array(buf, offset, 12)
    const mmsi = new TextDecoder().decode(mmsiBytes).replace(/\0+$/, '')
    offset += 12
    const nameLen = view.getUint8(offset); offset += 1
    const shipName = new TextDecoder().decode(new Uint8Array(buf, offset, nameLen))
    offset += nameLen
    vessels.push({ mmsi, shipName })
  }
}

/**
 * Decompress gzipped data using DecompressionStream
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
 * Load and parse a tile, caching the result
 */
async function loadTile(tileLat, tileLon) {
  const key = `${tileLat}_${tileLon}`
  if (tileCache.has(key)) return tileCache.get(key)

  const resp = await fetch(`${tilesBaseUrl}${key}.bin`)
  if (!resp.ok) {
    tileCache.set(key, new Map())
    return tileCache.get(key)
  }

  const compressed = await resp.arrayBuffer()
  const buf = await decompress(new Uint8Array(compressed))
  const view = new DataView(buf)
  let offset = 0

  const cellCount = view.getUint16(offset, true); offset += 2
  const cells = new Map()

  for (let i = 0; i < cellCount; i++) {
    const lat = view.getInt16(offset, true) / 100; offset += 2
    const lon = view.getInt16(offset, true) / 100; offset += 2
    const totalCount = view.getUint16(offset, true); offset += 2
    const vesselCount = view.getUint8(offset); offset += 1

    const cellVessels = []
    for (let j = 0; j < vesselCount; j++) {
      // vessel_id: 3 bytes LE
      const vesselId = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
      offset += 3
      const flagId = view.getUint8(offset); offset += 1
      const typeId = view.getUint8(offset); offset += 1
      const yearOffset = view.getUint8(offset); offset += 1
      const hours = view.getUint16(offset, true); offset += 2

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

  tileCache.set(key, cells)
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
  const tileLat = Math.floor(lat)
  const tileLon = Math.floor(lon)

  const tile = await loadTile(tileLat, tileLon)

  // Snap to grid
  const gridLat = (Math.round(lat * 100) / 100).toFixed(2)
  const gridLon = (Math.round(lon * 100) / 100).toFixed(2)
  const cellKey = `${gridLat}_${gridLon}`

  let vessels = tile.get(cellKey) || []

  if (year !== null) {
    vessels = vessels.filter(v => v.year === year)
  }

  return vessels
}

/**
 * Check if tiles are initialized
 */
export function isInitialized() {
  return vessels.length > 0
}
