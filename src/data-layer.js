/**
 * Client-side data queries using DuckDB-WASM
 * Replaces server-side FastAPI endpoints for vector data and tooltips
 */

import * as duckdb from '@duckdb/duckdb-wasm'

let db = null
let conn = null
let vesselLookupUrl = null  // Remote URL for range-request queries

// Track registered files to avoid re-registering
const registeredFiles = new Set()

// Southern latitude cutoff for vector features (must match cog-tiles.js)
const SOUTH_LAT = 57

/**
 * Convert BigInt to Number (DuckDB-WASM returns BigInt for some integer types)
 */
function convertValue(val) {
  if (typeof val === 'bigint') {
    return Number(val)
  }
  return val
}

/**
 * Parse geometry - handles both string (needs JSON.parse) and object (already parsed)
 */
function parseGeometry(geom) {
  if (typeof geom === 'string') {
    return JSON.parse(geom)
  }
  return geom
}

/**
 * Get the minimum latitude from a GeoJSON geometry
 */
function getMinLatitude(geometry) {
  let minLat = 90

  function processCoords(coords) {
    if (typeof coords[0] === 'number') {
      // It's a coordinate pair [lon, lat]
      minLat = Math.min(minLat, coords[1])
    } else {
      // It's an array of coordinates
      coords.forEach(processCoords)
    }
  }

  if (geometry.coordinates) {
    processCoords(geometry.coordinates)
  }

  return minLat
}

/**
 * Convert Arrow query result to array of plain objects
 */
function resultToObjects(result) {
  const arr = result.toArray()
  if (arr.length === 0) return []

  const columns = result.schema.fields.map(f => f.name)
  const firstRow = arr[0]

  // Check if direct property access works
  if (firstRow[columns[0]] !== undefined) {
    return arr.map(row => {
      const obj = {}
      for (const col of columns) {
        obj[col] = convertValue(row[col])
      }
      return obj
    })
  }

  // Fallback: use get() method if available
  if (typeof firstRow.get === 'function') {
    return arr.map(row => {
      const obj = {}
      for (const col of columns) {
        obj[col] = convertValue(row.get(col))
      }
      return obj
    })
  }

  // Last resort: column-based access
  const rows = []
  for (let i = 0; i < result.numRows; i++) {
    const row = {}
    for (const col of columns) {
      const colData = result.getChild(col)
      row[col] = colData ? convertValue(colData.get(i)) : undefined
    }
    rows.push(row)
  }
  return rows
}

/**
 * Initialize DuckDB-WASM
 * @param {string} baseUrl Base URL for data files (e.g., '/data/export/' or 'https://...')
 */
export async function initDB(baseUrl = '/data/export/') {
  const dataUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'

  // Use local bundles for offline support (files in public/duckdb/)
  // Construct absolute URLs for the worker using the same basePath as config.js
  const pathname = window.location.pathname.endsWith('/')
    ? window.location.pathname
    : window.location.pathname + '/'
  const workerUrl = window.location.origin + pathname + 'duckdb/duckdb-browser-eh.worker.js'
  const wasmUrl = window.location.origin + pathname + 'duckdb/duckdb-eh.wasm'

  // Create worker directly from the local script
  const worker = new Worker(workerUrl)
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING)

  db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(wasmUrl)

  conn = await db.connect()

  // Store URL for vessel_lookup.parquet - queried remotely via HTTP range requests (~75MB)
  vesselLookupUrl = dataUrl + 'vessel_lookup.parquet'

  // Pre-register small parquet files needed for map layers (~1MB total)
  const files = ['protected_areas.parquet', 'vessel_crossings.parquet', 'places.parquet']

  await Promise.all(files.map(async (filename) => {
    const url = dataUrl + filename
    const response = await fetch(url)
    if (!response.ok) {
      console.warn(`Failed to fetch ${filename}: ${response.status}`)
      return
    }
    const buffer = await response.arrayBuffer()
    await db.registerFileBuffer(filename, new Uint8Array(buffer))
    registeredFiles.add(filename)
  }))
}

/**
 * Load protected areas as GeoJSON FeatureCollection
 * @returns {Object} GeoJSON FeatureCollection
 */
export async function loadProtectedAreas() {
  const result = await conn.query(`
    SELECT
      feature_id as id,
      area_name as name,
      geometry
    FROM read_parquet('protected_areas.parquet')
  `)

  const rows = resultToObjects(result)

  const features = rows
    .map(row => ({
      type: 'Feature',
      id: row.id,
      geometry: parseGeometry(row.geometry),
      properties: { name: row.name }
    }))
    .filter(feature => getMinLatitude(feature.geometry) >= SOUTH_LAT)

  return { type: 'FeatureCollection', features }
}

/**
 * Load vessel crossings as GeoJSON FeatureCollection
 * @returns {Object} GeoJSON FeatureCollection
 */
export async function loadVesselCrossings() {
  const result = await conn.query(`
    SELECT
      feature_id,
      area_name,
      vessel_id,
      mmsi,
      ship_name,
      flag,
      vessel_type,
      gear_type,
      total_hours,
      first_seen,
      last_seen,
      year,
      centroid_lon,
      centroid_lat,
      position_count
    FROM read_parquet('vessel_crossings.parquet')
    WHERE centroid_lat >= ${SOUTH_LAT}
  `)

  const rows = resultToObjects(result)

  const features = rows.map(row => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [row.centroid_lon, row.centroid_lat]
    },
    properties: {
      feature_id: row.feature_id,
      area_name: row.area_name,
      vessel_id: row.vessel_id,
      mmsi: row.mmsi,
      ship_name: row.ship_name,
      flag: row.flag,
      vessel_type: row.vessel_type,
      gear_type: row.gear_type,
      total_hours: row.total_hours,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      year: row.year,
      position_count: row.position_count
    }
  }))

  return { type: 'FeatureCollection', features }
}

/**
 * Load places as GeoJSON FeatureCollection
 * @returns {Object} GeoJSON FeatureCollection
 */
export async function loadPlaces() {
  const result = await conn.query(`
    SELECT name_en, name_ru, lon, lat, population, scalerank
    FROM read_parquet('places.parquet')
    WHERE lat >= ${SOUTH_LAT}
  `)

  const rows = resultToObjects(result)

  const features = rows.map(row => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [row.lon, row.lat]
    },
    properties: {
      name_en: row.name_en,
      name_ru: row.name_ru,
      population: row.population,
      scalerank: row.scalerank
    }
  }))

  return { type: 'FeatureCollection', features }
}

/**
 * Query vessels at a grid cell for tooltips
 * Uses efficient row-group pruning since data is sorted by (lat, lon)
 * @param {number} lat Latitude
 * @param {number} lon Longitude
 * @param {number|null} year Optional year filter
 * @returns {Array} Array of vessel objects
 */
export async function queryVesselsAt(lat, lon, year = null) {
  // Skip queries south of the latitude cutoff
  if (lat < SOUTH_LAT) {
    return []
  }

  // Snap to 0.01 degree grid (same as raster)
  const gridLat = Math.round(lat * 100) / 100
  const gridLon = Math.round(lon * 100) / 100

  const yearFilter = year ? `AND year = ${year}` : ''

  // Use larger epsilon to account for Web Mercator -> WGS84 coordinate differences
  const eps = 0.015
  const result = await conn.query(`
    SELECT mmsi, ship_name, flag, vessel_type, year, total_hours, lat, lon
    FROM read_parquet('${vesselLookupUrl}')
    WHERE lat BETWEEN ${gridLat - eps} AND ${gridLat + eps}
      AND lon BETWEEN ${gridLon - eps} AND ${gridLon + eps}
      ${yearFilter}
    ORDER BY total_hours DESC
    LIMIT 10
  `)

  return resultToObjects(result)
}

/**
 * Load tooltip target points for debug visualization within a bounding box
 * @param {number} minLat
 * @param {number} maxLat
 * @param {number} minLon
 * @param {number} maxLon
 * @returns {Object} GeoJSON FeatureCollection
 */
export async function loadTooltipTargetsInBounds(minLat, maxLat, minLon, maxLon) {
  const result = await conn.query(`
    SELECT DISTINCT lat, lon
    FROM read_parquet('${vesselLookupUrl}')
    WHERE lat BETWEEN ${minLat} AND ${maxLat}
      AND lon BETWEEN ${minLon} AND ${maxLon}
  `)

  const rows = resultToObjects(result)

  // Create grid cell polygons (0.01° squares) matching raster pixels
  // Grid coordinates represent the top-left corner of each cell
  const CELL_SIZE = 0.01
  const features = rows.map(row => ({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [row.lon, row.lat],
        [row.lon + CELL_SIZE, row.lat],
        [row.lon + CELL_SIZE, row.lat - CELL_SIZE],
        [row.lon, row.lat - CELL_SIZE],
        [row.lon, row.lat]
      ]]
    },
    properties: {}
  }))

  return { type: 'FeatureCollection', features }
}

/**
 * Check if database is initialized
 * @returns {boolean}
 */
export function isInitialized() {
  return db !== null && conn !== null
}

/**
 * Close the database connection
 */
export async function closeDB() {
  if (conn) {
    await conn.close()
    conn = null
  }
  if (db) {
    await db.terminate()
    db = null
  }
}
