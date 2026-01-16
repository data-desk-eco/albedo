/**
 * Data layer initialization
 * - PMTiles for vector layers (protected areas, places)
 * - Hilbert-indexed binary for vessel tooltips
 */

import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { initVesselTiles, queryVesselsAt as queryTileVessels } from './vessel-tiles.js'

let protocol = null
let southLatCutoff = -90

/**
 * Initialize data layers
 * @param {string} baseUrl - Base URL for data files
 * @param {Object} manifest - App manifest with data URLs
 */
export async function initData(baseUrl, manifest) {
  // Initialize PMTiles protocol
  if (!protocol) {
    protocol = new Protocol()
    maplibregl.addProtocol('pmtiles', protocol.tile)
  }

  // Get latitude cutoff from manifest bounds
  if (manifest.map?.bounds?.south) {
    southLatCutoff = manifest.map.bounds.south
  }

  // Initialize vessel tooltip data
  const vesselDataUrl = manifest.data?.vesselData
  if (vesselDataUrl) {
    const fullUrl = vesselDataUrl.startsWith('http')
      ? vesselDataUrl
      : new URL(vesselDataUrl, new URL(baseUrl, window.location.href)).href
    await initVesselTiles(fullUrl)
  }
}

/**
 * Get PMTiles source URL for MapLibre
 * @param {string} url - URL to .pmtiles file
 * @returns {string} pmtiles:// protocol URL
 */
export function getPMTilesUrl(url) {
  return `pmtiles://${url}`
}

/**
 * Query vessels at a location for tooltips
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number|null} year - Optional year filter
 * @param {string|null} vesselType - Optional vessel type filter
 * @returns {Promise<Array>} Vessel data
 */
export async function queryVesselsAt(lat, lon, year = null, vesselType = null) {
  if (lat < southLatCutoff) return []
  return queryTileVessels(lat, lon, year, vesselType)
}
