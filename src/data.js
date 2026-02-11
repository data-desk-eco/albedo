/**
 * Data layer initialization
 * PMTiles for vector layers, Hilbert-indexed binary for vessel tooltips
 */

import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { initVesselTiles, queryVesselsAt as queryTileVessels } from './vessel-tiles.js'

let protocol = null
let southLatCutoff = -90

export async function initData(baseUrl, manifest) {
  if (!protocol) {
    protocol = new Protocol()
    maplibregl.addProtocol('pmtiles', protocol.tile)
  }

  if (manifest.map?.bounds?.south) southLatCutoff = manifest.map.bounds.south

  const vesselDataUrl = manifest.data?.vesselData
  if (vesselDataUrl) {
    const fullUrl = vesselDataUrl.startsWith('http')
      ? vesselDataUrl
      : new URL(vesselDataUrl, new URL(baseUrl, window.location.href)).href
    await initVesselTiles(fullUrl)
  }
}

export async function queryVesselsAt(lat, lon, year = null) {
  if (lat < southLatCutoff) return []
  return queryTileVessels(lat, lon, year)
}
