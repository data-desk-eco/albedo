// Year colors: oldest (2023) → newest (2025)
// SYNC: Must match YEAR_COLORS in scripts/tile_server.py
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

// Get base path for tile URLs (works with /albedo or any path prefix)
export const basePath = window.location.pathname.endsWith('/')
  ? window.location.pathname
  : window.location.pathname + '/'

// Protected area layer IDs
export const PROTECTED_AREA_LAYERS = [
  'protected-areas-on-land-sm',
  'protected-areas-on-land-md',
  'protected-areas-on-land-lg',
  'protected-areas-on-land-border',
  'protected-areas-on-sea-sm',
  'protected-areas-on-sea-md',
  'protected-areas-on-sea-lg',
  'protected-areas-on-sea-border'
]

// Create map style configuration
export function createMapStyle() {
  return {
    version: 8,
    projection: { type: 'globe' },
    sources: {
      'land': {
        type: 'vector',
        url: 'pmtiles://' + basePath + 'data/land.pmtiles',
        attribution: '© Natural Earth'
      },
      'sentinel-2': {
        type: 'raster',
        tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg'],
        tileSize: 256,
        bounds: [-180, 65, 180, 90],
        attribution: '© EOX IT Services GmbH - Sentinel-2 cloudless'
      },
      'vessel-heatmap': {
        type: 'raster',
        tiles: [basePath + `tiles/{z}/{x}/{y}.png?v=${TILE_VERSION}`],
        tileSize: 256,
        attribution: 'GFW 4Wings'
      },
      'protected-areas': {
        type: 'vector',
        url: 'pmtiles://' + basePath + 'data/protected_areas.pmtiles',
        attribution: 'Russian Ministry'
      },
      'vessel-crossings': {
        type: 'vector',
        url: 'pmtiles://' + basePath + 'data/vessel_crossings.pmtiles',
        attribution: 'GFW 4Wings'
      },
      'places': {
        type: 'vector',
        url: 'pmtiles://' + basePath + 'data/places.pmtiles',
        attribution: 'Natural Earth'
      },
      'activity-hotspots': {
        type: 'geojson',
        data: basePath + 'data/places/activity_hotspots.geojson'
      },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#000000' }
      },
      {
        id: 'land',
        type: 'fill',
        source: 'land',
        'source-layer': 'land',
        paint: { 'fill-color': '#ffffff', 'fill-opacity': 1 }
      },
      {
        id: 'sentinel-2',
        type: 'raster',
        source: 'sentinel-2',
        layout: { 'visibility': 'none' },
        paint: { 'raster-opacity': 1 }
      },
      // Protected areas on land (3 zoom levels)
      ...createProtectedAreaLayers('land', 'black'),
      // Protected areas on sea (3 zoom levels)
      ...createProtectedAreaLayers('sea', 'white'),
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
        'source-layer': 'crossings',
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
        'source-layer': 'places',
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

// Helper: create protected area layers for a given location (land/sea)
function createProtectedAreaLayers(location, color) {
  const sourceLayer = `protected_areas_${location}`
  const idPrefix = `protected-areas-on-${location}`
  const zoomBreaks = [
    { suffix: 'sm', maxzoom: 4, size: 'sm' },
    { suffix: 'md', minzoom: 4, maxzoom: 7, size: 'md' },
    { suffix: 'lg', minzoom: 7, size: 'lg' }
  ]

  const fillLayers = zoomBreaks.map(({ suffix, minzoom, maxzoom, size }) => ({
    id: `${idPrefix}-${suffix}`,
    type: 'fill',
    source: 'protected-areas',
    'source-layer': sourceLayer,
    ...(minzoom && { minzoom }),
    ...(maxzoom && { maxzoom }),
    paint: {
      'fill-pattern': `hatch-${color}-${size}`,
      'fill-opacity': 1
    }
  }))

  const borderLayer = {
    id: `${idPrefix}-border`,
    type: 'line',
    source: 'protected-areas',
    'source-layer': sourceLayer,
    paint: {
      'line-color': color === 'black' ? '#000000' : '#ffffff',
      'line-width': 2,
      'line-opacity': 1
    }
  }

  return [...fillLayers, borderLayer]
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
