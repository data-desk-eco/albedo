#!/usr/bin/env node
/**
 * Generate manifest.json from template using .env values
 * Proper JSON handling with validation - replaces shell envsubst approach
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { config } from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// Load .env
config({ path: join(ROOT, '.env') })

const env = process.env
const EXPORT_DIR = join(ROOT, 'data/export')

// Ensure export directory exists
mkdirSync(EXPORT_DIR, { recursive: true })

// Build COG URLs
const cogBase = env.COG_BASE_URL || ''
const cogUrl = `${cogBase}vessel_heatmap.tif`

// Build cogsByType from VESSEL_TYPES
const vesselTypes = (env.VESSEL_TYPES || '').split(',').filter(Boolean)
const cogsByType = {}
for (const type of vesselTypes) {
  const suffix = type.toLowerCase()
  cogsByType[type] = `${cogBase}vessel_heatmap_${suffix}.tif`
}

// Build cogsByFlag from FLAG_PRESETS
const flagPresets = (env.FLAG_PRESETS || 'foreign,RUS,NOR,PAN,LBR,MHL,MLT,CHN,GBR').split(',').filter(Boolean)
const cogsByFlag = {}
for (const flag of flagPresets) {
  const suffix = flag.toLowerCase()
  cogsByFlag[flag] = `${cogBase}vessel_heatmap_flag_${suffix}.tif`
}

// Load places from data/places.json or fall back to PLACES_JSON env var
let places = []
const placesFile = join(ROOT, 'data', 'places.json')
try {
  if (existsSync(placesFile)) {
    places = JSON.parse(readFileSync(placesFile, 'utf8'))
  } else if (env.PLACES_JSON) {
    places = JSON.parse(env.PLACES_JSON)
  }
} catch (e) {
  console.warn('Warning: Could not load places:', e.message)
}

// Parse AVAILABLE_LANGS
let availableLangs = ['en']
try {
  if (env.AVAILABLE_LANGS) {
    availableLangs = JSON.parse(env.AVAILABLE_LANGS)
  }
} catch (e) {
  console.warn('Warning: Could not parse AVAILABLE_LANGS:', e.message)
}

// Build manifest object
const manifest = {
  name: env.REGION_ID || 'albedo',

  about: {
    title: { en: 'about this map', ru: 'о карте' },
    description: {
      en: env.ABOUT_EN || '',
      ru: env.ABOUT_RU || ''
    }
  },

  map: {
    center: [
      parseFloat(env.CENTER_LON) || 0,
      parseFloat(env.CENTER_LAT) || 0
    ],
    zoom: parseFloat(env.INITIAL_ZOOM) || 2,
    minZoom: parseFloat(env.MIN_ZOOM) || 0,
    maxZoom: 14,
    pitch: 20,
    projection: 'globe',
    bounds: {
      south: parseFloat(env.SOUTH_LAT) || -90,
      north: parseFloat(env.NORTH_LAT) || 90,
      west: parseFloat(env.WEST_LON) || -180,
      east: parseFloat(env.EAST_LON) || 180
    }
  },

  data: {
    cog: cogUrl,
    vesselData: `${cogBase}vessel_data.bin`,
    sanctionedMmsi: 'sanctioned_mmsi.json',
    cogsByType: Object.keys(cogsByType).length > 0 ? cogsByType : undefined,
    cogsByFlag: Object.keys(cogsByFlag).length > 0 ? cogsByFlag : undefined,
    vesselMetadata: `${cogBase}vessel_metadata.json`
  },

  layers: {
    satellite: {
      url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
      defaultVisible: false
    },
    vectors: {
      'protected-areas': {
        url: `${cogBase}vectors.pmtiles`,
        defaultVisible: true,
        style: [
          {
            id: 'protected-areas-fill',
            type: 'fill',
            'source-layer': 'protected_areas',
            paint: { 'fill-pattern': 'hatch-blue-md', 'fill-opacity': 1 }
          },
          {
            id: 'protected-areas-border',
            type: 'line',
            'source-layer': 'protected_areas',
            paint: { 'line-color': '#1E6AFF', 'line-width': 2, 'line-opacity': 1 }
          }
        ]
      },
      'buffer-zones': {
        geojson: 'buffer_zones.geojson',
        defaultVisible: true,
        style: [
          {
            id: 'buffer-zones-fill',
            type: 'fill',
            paint: { 'fill-color': '#1E6AFF', 'fill-opacity': 0.05 }
          },
          {
            id: 'buffer-zones-border',
            type: 'line',
            paint: {
              'line-color': '#1E6AFF',
              'line-width': 1.5,
              'line-opacity': 0.6,
              'line-dasharray': [4, 3]
            }
          }
        ]
      },
      'sanctioned-vessels': {
        url: `${cogBase}vectors.pmtiles`,
        defaultVisible: false,
        style: [
          {
            id: 'sanctioned-vessels-fill',
            type: 'fill',
            'source-layer': 'sanctioned_vessels',
            paint: {
              'fill-color': '#FF3B30',
              'fill-opacity': 0.8
            }
          }
        ]
      },
      places: {
        url: `${cogBase}vectors.pmtiles`,
        defaultVisible: true,
        style: [
          {
            id: 'place-labels',
            type: 'symbol',
            'source-layer': 'places',
            minzoom: 0,
            layout: {
              'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name_en']],
              'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 2.5, 12, 10, 20],
              'text-anchor': 'center',
              'text-padding': 2,
              'text-allow-overlap': false
            },
            paint: {
              'text-color': '#666666',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.5
            }
          }
        ]
      }
    }
  },

  ui: {
    title: env.UI_TITLE || 'Albedo',
    favicon: env.UI_FAVICON || '#00ffff',
    defaultLang: env.DEFAULT_LANG || 'en',
    availableLangs,
    sourceLink: {
      url: env.SOURCE_URL || '',
      label: { en: env.SOURCE_LABEL || '', ru: env.SOURCE_LABEL || '' },
      labelShort: { en: env.SOURCE_LABEL_SHORT || '', ru: env.SOURCE_LABEL_SHORT || '' }
    },
    layerToggles: [
      {
        layers: ['protected-areas-fill', 'protected-areas-border'],
        label: { en: 'Protected areas', ru: 'ООПТ' },
        labelShort: { en: 'Protected', ru: 'ООПТ' },
        symbol: 'hatch',
        defaultVisible: true
      },
      {
        layers: ['buffer-zones-fill', 'buffer-zones-border'],
        label: { en: 'Buffer zones', ru: 'Охранные зоны' },
        labelShort: { en: 'Buffers', ru: 'Охр. зоны' },
        symbol: 'dashed',
        defaultVisible: true
      },
      {
        layers: ['satellite'],
        label: { en: 'Satellite imagery', ru: 'Спутник' },
        labelShort: { en: 'Satellite', ru: 'Спутник' },
        symbol: 'satellite',
        defaultVisible: false,
        isSatellite: true
      }
    ],
    theme: {
      background: '#000000',
      text: '#ffffff',
      textMuted: 'rgba(255, 255, 255, 0.7)',
      panelBg: 'rgba(0, 0, 0, 0.6)',
      panelBorder: 'rgba(255, 255, 255, 0.2)',
      panelHover: 'rgba(255, 255, 255, 0.1)'
    }
  },

  places
}

// Clean up undefined values
function cleanObject(obj) {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) {
      delete obj[key]
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      cleanObject(obj[key])
    }
  }
  return obj
}

cleanObject(manifest)

// Write manifest
const outputPath = join(EXPORT_DIR, 'manifest.json')
writeFileSync(outputPath, JSON.stringify(manifest, null, 2))

console.log(`Generated: ${outputPath}`)
console.log(`  Region: ${manifest.name}`)
console.log(`  COG: ${manifest.data.cog}`)
console.log(`  Types: ${Object.keys(cogsByType).join(', ') || 'none'}`)
console.log(`  Places: ${places.length}`)
