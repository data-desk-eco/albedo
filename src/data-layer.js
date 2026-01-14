/**
 * Client-side data queries using sql.js-httpvfs
 * Generic vessel activity viewer data layer
 *
 * Uses SQLite with HTTP range requests for efficient tooltip queries (~1.5MB WASM)
 * Small vector files loaded as JSON (protected areas, crossings, places)
 */

import { createDbWorker } from 'sql.js-httpvfs'

let worker = null
let vesselLookupUrl = null
let southLatCutoff = 57  // Default, can be updated from manifest

// Cached JSON data
let protectedAreasData = null
let vesselCrossingsData = null
let placesData = null

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
 * Initialize data layer with manifest configuration
 * @param {string} baseUrl Base URL for data files (e.g., '/data/export/' or 'https://...')
 * @param {Object} manifest The app manifest with data configuration
 */
export async function initDB(baseUrl, manifest) {
  const dataUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'

  // Get south latitude cutoff from manifest bounds
  if (manifest.map?.bounds?.south) {
    southLatCutoff = manifest.map.bounds.south
  }

  // Get vessel lookup URL from manifest
  const lookupFile = manifest.data?.vectors?.lookup || 'vessel_lookup.sqlite'
  if (lookupFile.startsWith('http')) {
    vesselLookupUrl = lookupFile
  } else {
    const base = new URL(dataUrl, window.location.href)
    vesselLookupUrl = new URL(lookupFile, base).href
  }

  // Initialize sql.js-httpvfs worker
  const workerUrl = new URL('sql.js-httpvfs/dist/sqlite.worker.js', import.meta.url)
  const wasmUrl = new URL('sql.js-httpvfs/dist/sql-wasm.wasm', import.meta.url)

  worker = await createDbWorker(
    [{
      from: 'inline',
      config: {
        serverMode: 'full',
        requestChunkSize: 4096,
        url: vesselLookupUrl
      }
    }],
    workerUrl.toString(),
    wasmUrl.toString()
  )

  // Load small JSON files in parallel
  const vectorFiles = manifest.data?.vectors || {}
  const [protectedAreas, crossings, places] = await Promise.all([
    fetchJson(dataUrl, vectorFiles.protectedAreas || 'protected_areas.json'),
    fetchJson(dataUrl, vectorFiles.crossings || 'vessel_crossings.json'),
    fetchJson(dataUrl, vectorFiles.places || 'places.json')
  ])

  protectedAreasData = protectedAreas
  vesselCrossingsData = crossings
  placesData = places
}

/**
 * Fetch a JSON file
 */
async function fetchJson(baseUrl, filename) {
  const url = filename.startsWith('http') ? filename : baseUrl + filename
  try {
    const response = await fetch(url)
    if (!response.ok) {
      console.warn(`Failed to fetch ${filename}: ${response.status}`)
      return null
    }
    return await response.json()
  } catch (err) {
    console.warn(`Failed to load ${filename}:`, err)
    return null
  }
}

/**
 * Load protected areas as GeoJSON FeatureCollection
 * @returns {Object} GeoJSON FeatureCollection
 */
export async function loadProtectedAreas() {
  if (!protectedAreasData) {
    return { type: 'FeatureCollection', features: [] }
  }

  // Filter by latitude
  const features = protectedAreasData.features.filter(
    feature => getMinLatitude(feature.geometry) >= southLatCutoff
  )

  return { type: 'FeatureCollection', features }
}

/**
 * Load vessel crossings as GeoJSON FeatureCollection
 * @returns {Object} GeoJSON FeatureCollection
 */
export async function loadVesselCrossings() {
  if (!vesselCrossingsData) {
    return { type: 'FeatureCollection', features: [] }
  }

  // Filter by latitude
  const features = vesselCrossingsData.features.filter(
    feature => feature.geometry.coordinates[1] >= southLatCutoff
  )

  return { type: 'FeatureCollection', features }
}

/**
 * Load places as GeoJSON FeatureCollection
 * @returns {Object} GeoJSON FeatureCollection
 */
export async function loadPlaces() {
  if (!placesData) {
    return { type: 'FeatureCollection', features: [] }
  }

  // Filter by latitude
  const features = placesData.features.filter(
    feature => feature.geometry.coordinates[1] >= southLatCutoff
  )

  return { type: 'FeatureCollection', features }
}

/**
 * Query vessels at a grid cell for tooltips
 * Uses efficient HTTP range requests via sql.js-httpvfs
 * @param {number} lat Latitude
 * @param {number} lon Longitude
 * @param {number|null} year Optional year filter
 * @returns {Array} Array of vessel objects
 */
export async function queryVesselsAt(lat, lon, year = null) {
  if (!worker) return []

  // Skip queries south of the latitude cutoff
  if (lat < southLatCutoff) {
    return []
  }

  // Snap to 0.01 degree grid (same as raster)
  const gridLat = Math.round(lat * 100) / 100
  const gridLon = Math.round(lon * 100) / 100

  // Use larger epsilon to account for Web Mercator -> WGS84 coordinate differences
  const eps = 0.015
  const yearFilter = year ? `AND year = ${year}` : ''

  const query = `
    SELECT s.mmsi, s.name as ship_name, f.code as flag, t.name as vessel_type,
           v.year, v.total_hours
    FROM vessel_lookup v
    LEFT JOIN ships s ON v.ship_id = s.id
    LEFT JOIN flags f ON v.flag_id = f.id
    LEFT JOIN vessel_types t ON v.type_id = t.id
    WHERE v.lat BETWEEN ${gridLat - eps} AND ${gridLat + eps}
      AND v.lon BETWEEN ${gridLon - eps} AND ${gridLon + eps}
      ${yearFilter}
    ORDER BY v.total_hours DESC
  `

  try {
    const result = await worker.db.exec(query)
    if (!result || result.length === 0) {
      return []
    }

    // Convert result to array of objects
    const columns = result[0].columns
    const values = result[0].values
    return values.map(row => {
      const obj = {}
      columns.forEach((col, i) => {
        obj[col] = row[i]
      })
      return obj
    })
  } catch (err) {
    console.warn('Query error:', err)
    return []
  }
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
  if (!worker) {
    return { type: 'FeatureCollection', features: [] }
  }

  const query = `
    SELECT DISTINCT lat, lon
    FROM vessel_lookup v
    WHERE v.lat BETWEEN ${minLat} AND ${maxLat}
      AND v.lon BETWEEN ${minLon} AND ${maxLon}
  `

  try {
    const result = await worker.db.exec(query)
    if (!result || result.length === 0) {
      return { type: 'FeatureCollection', features: [] }
    }

    const values = result[0].values
    const CELL_SIZE = 0.01

    const features = values.map(([lat, lon]) => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [lon, lat],
          [lon + CELL_SIZE, lat],
          [lon + CELL_SIZE, lat - CELL_SIZE],
          [lon, lat - CELL_SIZE],
          [lon, lat]
        ]]
      },
      properties: {}
    }))

    return { type: 'FeatureCollection', features }
  } catch (err) {
    console.warn('Query error:', err)
    return { type: 'FeatureCollection', features: [] }
  }
}

/**
 * Check if database is initialized
 * @returns {boolean}
 */
export function isInitialized() {
  return worker !== null
}

/**
 * Close the database connection
 */
export async function closeDB() {
  if (worker) {
    // sql.js-httpvfs doesn't have explicit close, but we can null the reference
    worker = null
  }
  protectedAreasData = null
  vesselCrossingsData = null
  placesData = null
}
