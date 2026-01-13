/**
 * Vessel Activity Viewer - Configuration
 * Generic viewer that loads region-specific config from manifest.json
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
 * Create a MapLibre match expression for year-based colors
 */
export function createYearColorExpression(years) {
  const expr = ['match', ['get', 'year']]
  years.forEach((year, idx) => {
    expr.push(year, getYearColor(idx))
  })
  expr.push('#ffffff')  // fallback
  return expr
}

/**
 * Create map style configuration from manifest
 * @param {Object} manifest - The loaded manifest
 * @param {string} dataUrl - Base URL for data files
 */
export function createMapStyle(manifest, dataUrl) {
  const satelliteUrl = manifest.layers?.satellite?.url ||
    'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg'

  return {
    version: 8,
    projection: { type: manifest.map?.projection || 'globe' },
    sources: {
      'sentinel-2': {
        type: 'raster',
        tiles: [satelliteUrl],
        tileSize: 256,
        attribution: manifest.ui?.attribution || ''
      },
      'vessel-heatmap': {
        type: 'raster',
        tiles: ['cog://{z}/{x}/{y}'],
        tileSize: 256,
        attribution: manifest.ui?.attribution || ''
      },
      'protected-areas': {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      },
      'vessel-crossings': {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      },
      'places': {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      },
      'debug-tooltip-targets': {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      }
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#000000' }
      },
      {
        id: 'sentinel-2',
        type: 'raster',
        source: 'sentinel-2',
        layout: { 'visibility': manifest.layers?.satellite?.defaultVisible ? 'visible' : 'none' },
        paint: { 'raster-opacity': 1 }
      },
      {
        id: 'debug-tooltip-targets',
        type: 'fill',
        source: 'debug-tooltip-targets',
        minzoom: 5,
        paint: {
          'fill-color': '#ff0000',
          'fill-opacity': 0.5,
          'fill-outline-color': '#ff0000'
        }
      },
      {
        id: 'vessel-heatmap',
        type: 'raster',
        source: 'vessel-heatmap',
        paint: {
          'raster-opacity': 1,
          'raster-resampling': 'nearest',
          'raster-brightness-max': 1,
          'raster-contrast': 0.3
        }
      },
      {
        id: 'protected-areas-fill',
        type: 'fill',
        source: 'protected-areas',
        layout: { 'visibility': manifest.layers?.protectedAreas?.defaultVisible ? 'visible' : 'none' },
        paint: {
          'fill-pattern': 'hatch-white-md',
          'fill-opacity': 1
        }
      },
      {
        id: 'protected-areas-border',
        type: 'line',
        source: 'protected-areas',
        layout: { 'visibility': manifest.layers?.protectedAreas?.defaultVisible ? 'visible' : 'none' },
        paint: {
          'line-color': '#ffffff',
          'line-width': 2,
          'line-opacity': 1
        }
      },
      {
        id: 'crossings',
        type: 'circle',
        source: 'vessel-crossings',
        minzoom: 0,
        maxzoom: 24,
        layout: {
          'visibility': manifest.layers?.crossings?.defaultVisible ? 'visible' : 'none',
          'circle-sort-key': ['get', 'year']
        },
        paint: {
          'circle-radius': createCrossingsRadius(),
          'circle-color': 'transparent',
          'circle-opacity': 0,
          'circle-stroke-color': '#ffffff',  // Updated dynamically from COG config
          'circle-stroke-width': 2,
          'circle-stroke-opacity': 1
        }
      },
      {
        id: 'place-labels',
        type: 'symbol',
        source: 'places',
        minzoom: 2,
        layout: {
          'text-field': ['coalesce', ['get', 'name_ru'], ['get', 'name_en']],
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            2.5, ['case', ['<=', ['get', 'scalerank'], 1], 14, 12],
            10, ['case', ['<=', ['get', 'scalerank'], 1], 28, 20]
          ],
          'text-anchor': 'center',
          'text-padding': 2,
          'text-allow-overlap': false,
          'text-ignore-placement': false
        },
        paint: {
          'text-color': '#666666',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
          'text-halo-blur': 0.5
        }
      }
    ]
  }
}

/**
 * Helper: create crossings circle radius expression
 */
function createCrossingsRadius() {
  return [
    'interpolate', ['linear'], ['zoom'],
    2.5, [
      'interpolate', ['linear'], ['get', 'total_hours'],
      1, 3, 24, 5, 168, 10, 720, 18
    ],
    10, [
      'interpolate', ['linear'], ['get', 'total_hours'],
      1, 6, 24, 10, 168, 20, 720, 36
    ]
  ]
}

// Protected area layer IDs (used for toggling visibility)
export const PROTECTED_AREA_LAYERS = [
  'protected-areas-fill',
  'protected-areas-border'
]
