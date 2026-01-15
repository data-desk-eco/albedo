/**
 * Client-side data queries
 * - SQLite (sql.js-httpvfs) for small vector data
 * - Binary tiles for vessel lookups (zero-dependency, ~60MB total)
 */

import { createDbWorker } from 'sql.js-httpvfs'
import { initVesselTiles, queryVesselsAt as queryTileVessels, isInitialized as tilesInitialized } from './vessel-tiles.js'

let vectorsDb = null
let southLatCutoff = 57  // Default, can be updated from manifest

// sql.js-httpvfs worker configuration
const workerUrl = new URL(
  'sql.js-httpvfs/dist/sqlite.worker.js',
  import.meta.url
)
const wasmUrl = new URL(
  'sql.js-httpvfs/dist/sql-wasm.wasm',
  import.meta.url
)

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
 * Convert sql.js result to array of plain objects
 */
function resultToObjects(result) {
  if (!result || result.length === 0) return []

  const { columns, values } = result[0]
  return values.map(row => {
    const obj = {}
    columns.forEach((col, i) => {
      obj[col] = row[i]
    })
    return obj
  })
}

/**
 * Initialize databases with manifest configuration
 * @param {string} baseUrl Base URL for data files (e.g., '/data/export/' or 'https://...')
 * @param {Object} manifest The app manifest with data configuration
 */
export async function initDB(baseUrl, manifest) {
  const dataUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'

  // Get south latitude cutoff from manifest bounds
  if (manifest.map?.bounds?.south) {
    southLatCutoff = manifest.map.bounds.south
  }

  // Determine URLs for SQLite files
  const vectorsFile = manifest.data?.vectors?.vectors || 'vectors.sqlite'

  const vectorsUrl = vectorsFile.startsWith('http')
    ? vectorsFile
    : new URL(vectorsFile, new URL(dataUrl, window.location.href)).href

  // Initialize vectors database (small, loaded entirely)
  vectorsDb = await createDbWorker(
    [
      {
        from: 'inline',
        config: {
          serverMode: 'full',
          url: vectorsUrl,
          requestChunkSize: 1024 * 1024  // 1MB chunks for small file
        }
      }
    ],
    workerUrl.toString(),
    wasmUrl.toString()
  )

  // Initialize vessel data (Hilbert-ordered binary format, fetched on demand via range requests)
  const vesselDataUrl = manifest.data?.vectors?.vesselData || 'vessel_data.bin'
  const vesselDataFullUrl = vesselDataUrl.startsWith('http')
    ? vesselDataUrl
    : new URL(vesselDataUrl, new URL(dataUrl, window.location.href)).href
  await initVesselTiles(vesselDataFullUrl)
}

/**
 * Load protected areas as GeoJSON FeatureCollection
 * @returns {Object} GeoJSON FeatureCollection
 */
export async function loadProtectedAreas() {
  const result = await vectorsDb.db.exec(`
    SELECT feature_id as id, area_name as name, geometry
    FROM protected_areas
  `)

  const rows = resultToObjects(result)

  const features = rows
    .map(row => ({
      type: 'Feature',
      id: row.id,
      geometry: parseGeometry(row.geometry),
      properties: { name: row.name }
    }))
    .filter(feature => getMinLatitude(feature.geometry) >= southLatCutoff)

  return { type: 'FeatureCollection', features }
}

/**
 * Load places as GeoJSON FeatureCollection
 * @returns {Object} GeoJSON FeatureCollection
 */
export async function loadPlaces() {
  const result = await vectorsDb.db.exec(`
    SELECT name_en, name_ru, lon, lat, population, scalerank
    FROM places
    WHERE lat >= ${southLatCutoff}
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
 * Uses binary tiles - fetches tile on first access, then cached
 * @param {number} lat Latitude
 * @param {number} lon Longitude
 * @param {number|null} year Optional year filter
 * @param {string|null} vesselType Optional vessel type filter
 * @returns {Array} Array of vessel objects
 */
export async function queryVesselsAt(lat, lon, year = null, vesselType = null) {
  // Skip queries south of the latitude cutoff
  if (lat < southLatCutoff) {
    return []
  }

  return queryTileVessels(lat, lon, year, vesselType)
}

/**
 * Check if database is initialized
 * @returns {boolean}
 */
export function isInitialized() {
  return vectorsDb !== null && tilesInitialized()
}

/**
 * Close the database connections
 */
export async function closeDB() {
  if (vectorsDb) {
    vectorsDb.worker.terminate()
    vectorsDb = null
  }
}
