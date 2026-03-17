/**
 * Data layer initialization
 * PMTiles for vector layers, Hilbert-indexed binary for vessel tooltips
 */

import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { initVesselTiles, queryVesselsAt as queryTileVessels } from './vessel-tiles.js'

let protocol = null
let southLatCutoff = -90

/**
 * Register PMTiles protocol (synchronous, no network).
 * Called during init to unblock map creation.
 */
export function initProtocol() {
  if (!protocol) {
    protocol = new Protocol()
    maplibregl.addProtocol('pmtiles', protocol.tile)
  }
}

/**
 * Load vessel binary tiles (deferred — only needed for tooltips at zoom 8+).
 * Safe to call after map is already rendering.
 */
export async function initVesselData(manifestDir, manifest) {
  if (manifest.map?.bounds?.south) southLatCutoff = manifest.map.bounds.south

  const vesselDataUrl = manifest.data?.vesselData
  if (vesselDataUrl) {
    const fullUrl = vesselDataUrl.startsWith('http')
      ? vesselDataUrl
      : new URL(vesselDataUrl, new URL(manifestDir, window.location.href)).href
    await initVesselTiles(fullUrl)
  }
}

export async function queryVesselsAt(lat, lon, year = null) {
  if (lat < southLatCutoff) return []
  return queryTileVessels(lat, lon, year)
}
