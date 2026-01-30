/**
 * Vessel Activity Viewer - Configuration
 * Loads settings from manifest.json and COG metadata
 */

// Color palette for years - Arctida blue scale (must match cog.js)
const YEAR_PALETTE = [
  [41, 136, 255],   // Blue #2988FF (2023)
  [112, 223, 238],  // Turquoise #70DFEE (2024)
  [204, 227, 255],  // Light Blue #CCE3FF (2025)
  [0, 99, 219],     // Deep Blue #0063DB
  [133, 187, 255],  // Mid Blue #85BBFF
  [70, 213, 217],   // Turquoise Second #46D5D9
]

// Debug mode: visualize tooltip target grid cells
export const DEBUG_MODE = false

// Manifest URL - override via VITE_MANIFEST_URL environment variable
export const MANIFEST_URL = import.meta.env.VITE_MANIFEST_URL || './data/export/manifest.json'

// Minimum zoom level for vessel tooltips
export const RASTER_TOOLTIP_MIN_ZOOM = 8

/**
 * Convert RGB array to CSS rgb() string
 */
function rgbToCss(rgb) {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
}

/**
 * Get CSS color for a year based on its band index
 */
export function getYearColor(bandIndex) {
  return rgbToCss(YEAR_PALETTE[bandIndex % YEAR_PALETTE.length])
}

/**
 * Create MapLibre style from manifest configuration
 */
export function createMapStyle(manifest, manifestDir = '') {
  const theme = manifest.ui?.theme || {}
  const bounds = manifest.map?.bounds || {}
  const southBound = bounds.south ?? -90

  // Sources
  const sources = {
    'vessel-heatmap': {
      type: 'raster',
      tiles: ['cog://{z}/{x}/{y}'],
      tileSize: 256,
      attribution: manifest.ui?.attribution || ''
    },
    'south-mask': {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[-180, -90], [180, -90], [180, southBound], [-180, southBound], [-180, -90]]]
        }
      }
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
      bounds: [-180, bounds.south ?? -90, 180, bounds.north ?? 90]
    }
  }

  // Add PMTiles vector sources and GeoJSON sources
  const vectorLayers = manifest.layers?.vectors || {}
  for (const [id, config] of Object.entries(vectorLayers)) {
    if (config.url) {
      const resolvedUrl = config.url.startsWith('http') ? config.url : manifestDir + config.url
      sources[id] = {
        type: 'vector',
        url: `pmtiles://${resolvedUrl}`
      }
    } else if (config.geojson) {
      // GeoJSON sources loaded via manifest-relative URL
      // Actual data is loaded dynamically in main.js after map init
      sources[id] = {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      }
    }
  }

  // Layers
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

  // Vessel heatmap
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

  // Debug layer
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

  // Vector layers from manifest
  for (const [sourceId, config] of Object.entries(vectorLayers)) {
    if (!config.style) continue
    for (const layerStyle of config.style) {
      const layer = {
        ...layerStyle,
        source: sourceId,
        layout: {
          ...layerStyle.layout,
          visibility: config.defaultVisible !== false ? 'visible' : 'none'
        }
      }
      // GeoJSON sources don't use source-layer
      if (config.geojson && layer['source-layer']) {
        delete layer['source-layer']
      }
      layers.push(layer)
    }
  }

  // South-mask: clip all layers below SOUTH_LAT boundary
  layers.push({
    id: 'south-mask',
    type: 'fill',
    source: 'south-mask',
    paint: { 'fill-color': theme.background || '#000000' }
  })

  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    projection: { type: manifest.map?.projection || 'globe' },
    sources,
    layers
  }
}
