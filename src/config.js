// Debug mode: set to true to visualize tooltip target grid cells
export const DEBUG_MODE = false

// Year colors: oldest (2023) → newest (2025)
// SYNC: Must match YEAR_COLORS in cog-tiles.js
export const YEAR_COLORS = {
  2023: 'rgb(0, 255, 255)',   // Cyan (band 0)
  2024: 'rgb(0, 255, 0)',     // Green (band 1)
  2025: 'rgb(255, 0, 255)',   // Magenta (band 2)
}

// Arctic region focus
export const ARCTIC_CENTER_LAT = 75
export const ARCTIC_MIN_LAT_ZOOMED_OUT = 60  // Minimum latitude when zoomed out (z <= 4)
export const ARCTIC_MIN_LAT_ZOOMED_IN = 50   // Minimum latitude when zoomed in (z > 4)

// Raster tooltip minimum zoom level
export const RASTER_TOOLTIP_MIN_ZOOM = 8

// Tile cache version - injected from .env at build time
export const TILE_VERSION = __TILE_VERSION__

// Get base path for asset URLs (works with /albedo or any path prefix)
export const basePath = window.location.pathname.endsWith('/')
  ? window.location.pathname
  : window.location.pathname + '/'

// Data URLs - can be overridden via env vars for CDN deployment
export const COG_URL = import.meta.env.VITE_COG_URL || basePath + 'data/vessel_heatmap.tif'
export const DATA_URL = import.meta.env.VITE_DATA_URL || basePath + 'data/export/'

// Protected area layer IDs (used for toggling visibility)
export const PROTECTED_AREA_LAYERS = [
  'protected-areas-fill',
  'protected-areas-border'
]

// Create map style configuration
// Note: Vector sources are now added dynamically after DuckDB loads
export function createMapStyle() {
  return {
    version: 8,
    projection: { type: 'globe' },
    sources: {
      'sentinel-2': {
        type: 'raster',
        tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg'],
        tileSize: 256,
        bounds: [-180, 65, 180, 90],
        attribution: '© EOX IT Services GmbH - Sentinel-2 cloudless'
      },
      'vessel-heatmap': {
        type: 'raster',
        tiles: ['cog://{z}/{x}/{y}'],
        tileSize: 256,
        attribution: 'GFW 4Wings'
      },
      // These GeoJSON sources will be populated dynamically after data loads
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
      'activity-hotspots': {
        type: 'geojson',
        data: basePath + 'data/places/activity_hotspots.geojson'
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
        layout: { 'visibility': 'none' },
        paint: { 'raster-opacity': 1 }
      },
      // Debug: tooltip target grid cells (red squares matching raster pixels)
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
      // Protected areas (single layer, styled with hatch pattern)
      {
        id: 'protected-areas-fill',
        type: 'fill',
        source: 'protected-areas',
        paint: {
          'fill-pattern': 'hatch-white-md',
          'fill-opacity': 1
        }
      },
      {
        id: 'protected-areas-border',
        type: 'line',
        source: 'protected-areas',
        paint: {
          'line-color': '#ffffff',
          'line-width': 2,
          'line-opacity': 1
        }
      },
      {
        id: 'activity-hotspots-line',
        type: 'line',
        source: 'activity-hotspots',
        paint: {
          'line-color': '#ffff00',
          'line-width': 2,
          'line-opacity': 0.9
        }
      },
      {
        id: 'crossings',
        type: 'circle',
        source: 'vessel-crossings',
        minzoom: 0,
        maxzoom: 24,
        layout: {
          'visibility': 'none',
          'circle-sort-key': ['get', 'year']
        },
        paint: {
          'circle-radius': createCrossingsRadius(),
          'circle-color': 'transparent',
          'circle-opacity': 0,
          'circle-stroke-color': [
            'match', ['get', 'year'],
            2023, YEAR_COLORS[2023],
            2024, YEAR_COLORS[2024],
            2025, YEAR_COLORS[2025],
            '#ffffff'
          ],
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

// Helper: create crossings circle radius expression
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
