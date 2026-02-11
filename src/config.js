/**
 * Configuration — manifest loading, MapLibre style generation
 */

// Year color palette (must match cog.js) — Arctida brand blues, dark→light (oldest→newest)
const YEAR_PALETTE = [
  [41, 136, 255],   // #2988FF — oldest year (brand Blue 5)
  [97, 167, 255],   // #61A7FF — middle year (brand Blue 7)
  [168, 207, 255],  // #A8CFFF — newest year (brand Blue 9)
  [30, 106, 255],   // #1E6AFF — future (brand primary)
  [133, 187, 255],  // #85BBFF — future (brand Blue 8)
  [204, 227, 255],  // #CCE3FF — future (brand Blue 10)
]

export const MANIFEST_URL = import.meta.env.VITE_MANIFEST_URL || './data/export/manifest.json'
export const RASTER_TOOLTIP_MIN_ZOOM = 8

export function getYearColor(bandIndex) {
  const rgb = YEAR_PALETTE[bandIndex % YEAR_PALETTE.length]
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
}

export function createMapStyle(manifest, manifestDir = '') {
  const theme = manifest.ui?.theme || {}
  const bounds = manifest.map?.bounds || {}
  const southBound = bounds.south ?? -90

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

  // PMTiles vector sources
  const vectorLayers = manifest.layers?.vectors || {}
  for (const [id, config] of Object.entries(vectorLayers)) {
    if (config.url) {
      sources[id] = { type: 'vector', url: `pmtiles://${config.url.startsWith('http') ? config.url : manifestDir + config.url}` }
    }
  }

  const layers = [
    { id: 'background', type: 'background', paint: { 'background-color': theme.background || '#000000' } }
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

  layers.push({
    id: 'vessel-heatmap', type: 'raster', source: 'vessel-heatmap',
    paint: { 'raster-opacity': 1, 'raster-resampling': 'nearest', 'raster-brightness-max': 1, 'raster-contrast': 0.3 }
  })

  addVectorLayers(false)

  // South mask: hide everything below SOUTH_LAT
  layers.push({ id: 'south-mask', type: 'fill', source: 'south-mask', paint: { 'fill-color': theme.background || '#000000' } })

  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    projection: { type: manifest.map?.projection || 'globe' },
    sources,
    layers
  }
}
