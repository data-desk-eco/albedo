/**
 * Configuration — manifest loading, MapLibre style generation
 */

// --- Colour palette ---
// Arctida brand blues, dark→light (oldest→newest year)
export const YEAR_PALETTE = [
  [41, 136, 255],   // #2988FF — Blue 5
  [97, 167, 255],   // #61A7FF — Blue 7
  [168, 207, 255],  // #A8CFFF — Blue 9
  [30, 106, 255],   // #1E6AFF — Primary
  [133, 187, 255],  // #85BBFF — Blue 8
  [204, 227, 255],  // #CCE3FF — Blue 10
]

// Map surface colours (RGB arrays for COG tile renderer)
export const MULTI_YEAR_COLOR = [169, 178, 194]  // #A9B2C2 — blue-gray blend
export const LAND_COLOR = [204, 227, 255]         // #CCE3FF — Blue 10
export const ICE_COLOR = [255, 255, 255]           // white

// Overlay colours (RGB arrays for COG tile renderer)
export const OVERLAY_SANCTIONS = [255, 68, 68]     // #FF4444 — red
export const OVERLAY_OLD_TANKER = [255, 204, 0]    // #FFCC00 — yellow
export const OVERLAY_ALPHA = 0.8

// Protected area colour (used in hatch patterns)
export const PROTECTED_AREA_COLOR = '#037874'

export const MANIFEST_URL = import.meta.env.VITE_MANIFEST_URL || './data/export/manifest.json'
export const RASTER_TOOLTIP_MIN_ZOOM = 8

export function getYearColor(bandIndex) {
  const rgb = YEAR_PALETTE[bandIndex % YEAR_PALETTE.length]
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
}

export function createMapStyle(manifest, manifestDir = '', isLightTheme = false) {
  const theme = manifest.ui?.theme || {}
  const bounds = manifest.map?.bounds || {}
  const southBound = bounds.south ?? -90
  const bgColor = isLightTheme ? '#f0f2f5' : (theme.background || '#000000')

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
    }
  }

  if (manifest.layers?.satellite?.url) {
    sources['satellite'] = {
      type: 'raster',
      tiles: [manifest.layers.satellite.url],
      tileSize: 256,
      bounds: [-180, bounds.south ?? -90, 180, bounds.north ?? 90]
    }
  }

  // Pole cap: covers area above Mercator limit where raster tiles can't reach
  // Ice (and land) in the raster stops at ~85°N, so we fill the pole with a vector polygon
  sources['pole-cap'] = {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-180, 84], [180, 84], [180, 90], [-180, 90], [-180, 84]]] } }
  }

  // PMTiles vector sources
  const vectorLayers = manifest.layers?.vectors || {}
  for (const [id, config] of Object.entries(vectorLayers)) {
    if (config.url) {
      sources[id] = { type: 'vector', url: `pmtiles://${config.url.startsWith('http') ? config.url : manifestDir + config.url}` }
    }
  }

  const layers = [
    { id: 'background', type: 'background', paint: { 'background-color': bgColor } }
  ]

  if (sources['satellite']) {
    layers.push({
      id: 'satellite', type: 'raster', source: 'satellite',
      layout: { visibility: manifest.layers?.satellite?.defaultVisible ? 'visible' : 'none' },
      paint: { 'raster-opacity': 1 }
    })
  }

  // Vector layers marked belowHeatmap render under the raster heatmap
  const addVectorLayers = (belowHeatmap) => {
    for (const [sourceId, config] of Object.entries(vectorLayers)) {
      if (!config.style) continue
      if (!!config.belowHeatmap !== belowHeatmap) continue
      for (const s of config.style) {
        const layer = { ...s, source: sourceId, layout: { ...s.layout, visibility: config.defaultVisible !== false ? 'visible' : 'none' } }
        layers.push(layer)
      }
    }
  }

  addVectorLayers(true)

  // Pole cap fill (white, covers area above ~84°N where raster tiles can't reach)
  layers.push({
    id: 'pole-cap-fill', type: 'fill', source: 'pole-cap',
    paint: { 'fill-color': '#ffffff', 'fill-opacity': 1 }
  })

  layers.push({
    id: 'vessel-heatmap', type: 'raster', source: 'vessel-heatmap',
    paint: { 'raster-opacity': 1, 'raster-resampling': 'nearest', 'raster-brightness-max': 1, 'raster-contrast': 0.3 }
  })

  addVectorLayers(false)

  // South mask: hide everything below SOUTH_LAT
  layers.push({ id: 'south-mask', type: 'fill', source: 'south-mask', paint: { 'fill-color': bgColor } })

  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    projection: { type: manifest.map?.projection || 'globe' },
    sources,
    layers
  }
}
