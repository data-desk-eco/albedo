/**
 * Vessel Activity Viewer - Configuration
 * Generic viewer that loads config from manifest.json and COG metadata
 */

import { YEAR_PALETTE } from './cog-tiles.js'

// Debug mode: set to true to visualize tooltip target grid cells
export const DEBUG_MODE = false

// Manifest URL - can be overridden via environment variable
export const MANIFEST_URL = import.meta.env.VITE_MANIFEST_URL || './data/export/manifest.json'

// Raster tooltip minimum zoom level
export const RASTER_TOOLTIP_MIN_ZOOM = 8

/**
 * Convert RGB array to CSS rgb() string
 */
export function rgbToCss(rgb) {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
}

/**
 * Get CSS color for a year based on its band index
 */
export function getYearColor(bandIndex) {
  const rgb = YEAR_PALETTE[bandIndex % YEAR_PALETTE.length]
  return rgbToCss(rgb)
}

/**
 * Create map style configuration from manifest
 * @param {Object} manifest - The loaded manifest
 */
export function createMapStyle(manifest) {
  const theme = manifest.ui?.theme || {}
  const bounds = manifest.map?.bounds || {}

  // Build sources from manifest
  const sources = {
    'vessel-heatmap': {
      type: 'raster',
      tiles: ['cog://{z}/{x}/{y}'],
      tileSize: 256,
      attribution: manifest.ui?.attribution || ''
    },
    'debug-tooltip-targets': {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    }
  }

  // Add satellite source if configured
  if (manifest.layers?.satellite?.url) {
    sources['satellite'] = {
      type: 'raster',
      tiles: [manifest.layers.satellite.url],
      tileSize: 256,
      bounds: [
        bounds.west ?? -180,
        bounds.south ?? -90,
        bounds.east ?? 180,
        bounds.north ?? 90
      ]
    }
  }

  // Add PMTiles vector sources from manifest
  const vectorLayers = manifest.layers?.vectors || {}
  for (const [id, config] of Object.entries(vectorLayers)) {
    if (config.url) {
      sources[id] = {
        type: 'vector',
        url: `pmtiles://${config.url}`
      }
    }
  }

  // Build layers
  const layers = [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': theme.background || '#000000' }
    }
  ]

  // Satellite layer (if configured)
  if (sources['satellite']) {
    layers.push({
      id: 'satellite',
      type: 'raster',
      source: 'satellite',
      layout: { visibility: manifest.layers?.satellite?.defaultVisible ? 'visible' : 'none' },
      paint: { 'raster-opacity': 1 }
    })
  }

  // Vessel heatmap (always present)
  layers.push({
    id: 'vessel-heatmap',
    type: 'raster',
    source: 'vessel-heatmap',
    paint: {
      'raster-opacity': 1,
      'raster-resampling': 'nearest',
      'raster-brightness-max': 1,
      'raster-contrast': 0.3
    }
  })

  // Debug layer for tooltip targets
  layers.push({
    id: 'debug-tooltip-targets',
    type: 'fill',
    source: 'debug-tooltip-targets',
    minzoom: 5,
    paint: {
      'fill-color': '#ff0000',
      'fill-opacity': 0.5,
      'fill-outline-color': '#ff0000'
    }
  })

  // Add vector layers from manifest
  for (const [sourceId, config] of Object.entries(vectorLayers)) {
    if (!config.style) continue

    for (const layerStyle of config.style) {
      layers.push({
        ...layerStyle,
        source: sourceId,
        layout: {
          ...layerStyle.layout,
          visibility: config.defaultVisible !== false ? 'visible' : 'none'
        }
      })
    }
  }

  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    projection: { type: manifest.map?.projection || 'globe' },
    sources,
    layers
  }
}

/**
 * Get layer IDs for a vector source (for toggling visibility)
 */
export function getVectorLayerIds(manifest, sourceId) {
  const config = manifest.layers?.vectors?.[sourceId]
  if (!config?.style) return []
  return config.style.map(s => s.id)
}
