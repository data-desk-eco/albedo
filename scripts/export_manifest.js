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

// Strip wrapping quotes from env values (guards against shell/dotenv version differences)
const env = new Proxy(process.env, {
  get: (target, key) => typeof target[key] === 'string' ? target[key].replace(/^"|"$/g, '') : target[key]
})
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

// Build cogsByFlag and UI flag presets from FLAG_PRESETS
const FLAG_LABELS = {
  RUS: 'russia', NOR: 'norway', PAN: 'panama', LBR: 'liberia',
  MHL: 'marshall islands', MLT: 'malta', CHN: 'china', GBR: 'united kingdom',
  USA: 'united states', JPN: 'japan', KOR: 'south korea', SGP: 'singapore',
  CYP: 'cyprus', BHS: 'bahamas', GRC: 'greece', HKG: 'hong kong',
  DNK: 'denmark', DEU: 'germany', TUR: 'turkey', IND: 'india',
}
const flagPresetIds = (env.FLAG_PRESETS || 'foreign,RUS,NOR,PAN,LBR,MHL,MLT,CHN,GBR').split(',').filter(Boolean)
const cogsByFlag = {}
for (const flag of flagPresetIds) {
  const suffix = flag.toLowerCase()
  cogsByFlag[flag] = `${cogBase}vessel_heatmap_flag_${suffix}.tif`
}
const uiFlagPresets = [
  { id: 'all', labelKey: 'allFlags' },
  ...flagPresetIds.map(id =>
    id === 'foreign'
      ? { id: 'foreign', labelKey: 'foreignFlag' }
      : { id, label: FLAG_LABELS[id] || id.toLowerCase() }
  )
]

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

// Parse AVAILABLE_LANGS (strip surrounding single quotes if present)
let availableLangs = ['en']
try {
  if (env.AVAILABLE_LANGS) {
    let raw = env.AVAILABLE_LANGS
    if (raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1)
    availableLangs = JSON.parse(raw)
  }
} catch (e) {
  console.warn('Warning: Could not parse AVAILABLE_LANGS:', e.message)
}

// Clean env text: strip surrounding quotes and convert literal \n to newlines
function cleanText(val) {
  if (!val) return ''
  // Strip surrounding quotes (dotenv may leave them)
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1)
  }
  // Convert literal \n to actual newlines
  val = val.replace(/\\n/g, '\n')
  return val
}

// Build manifest object
const manifest = {
  name: env.REGION_ID || 'albedo',

  about: {
    title: { en: 'about this map', ru: 'о карте' },
    description: {
      en: cleanText(env.ABOUT_EN),
      ru: cleanText(env.ABOUT_RU)
    },
    builtBy: {
      en: 'Built by: <a href="https://arctida.io" target="_blank" rel="noopener">Arctida</a>, <a href="https://datadesk.eco" target="_blank" rel="noopener">Data Desk</a>',
      ru: 'Создано: <a href="https://arctida.io" target="_blank" rel="noopener">Arctida</a>, <a href="https://datadesk.eco" target="_blank" rel="noopener">Data Desk</a>'
    },
    dataCredits: {
      en: 'Data: <a href="https://globalfishingwatch.org/" target="_blank" rel="noopener">Global Fishing Watch</a>, <a href="https://www.opensanctions.org/" target="_blank" rel="noopener">OpenSanctions</a>, <a href="https://nsidc.org/data/g02135" target="_blank" rel="noopener">NSIDC</a>',
      ru: 'Данные: <a href="https://globalfishingwatch.org/" target="_blank" rel="noopener">Global Fishing Watch</a>, <a href="https://www.opensanctions.org/" target="_blank" rel="noopener">OpenSanctions</a>, <a href="https://nsidc.org/data/g02135" target="_blank" rel="noopener">NSIDC</a>'
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
    vesselMetadata: `${cogBase}vessel_metadata.json`,
    analysisExcel: `${cogBase}vessels_in_protected_areas.xlsx`
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
            paint: { 'line-color': '#037874', 'line-width': 2, 'line-opacity': 1 }
          }
        ]
      },
      'buffer-zones': {
        url: `${cogBase}vectors.pmtiles`,
        defaultVisible: true,
        style: [
          {
            id: 'buffer-zones-fill',
            type: 'fill',
            'source-layer': 'buffer_zones',
            paint: { 'fill-color': '#037874', 'fill-opacity': 0.05 }
          },
          {
            id: 'buffer-zones-border',
            type: 'line',
            'source-layer': 'buffer_zones',
            paint: {
              'line-color': '#037874',
              'line-width': 1.5,
              'line-opacity': 0.6,
              'line-dasharray': [4, 3]
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
            minzoom: 2,
            layout: {
              'text-field': ['coalesce', ['get', `name_${env.DEFAULT_LANG || 'en'}`], ['get', 'name_en']],
              'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 8, 16],
              'text-anchor': 'center',
              'text-padding': 1,
              'text-allow-overlap': false,
              'symbol-sort-key': ['get', 'scalerank']
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
    flagPresets: uiFlagPresets.length > 1 ? uiFlagPresets : undefined,
    homeFlag: env.HOME_FLAG || undefined,
    sourceLink: {
      url: env.SOURCE_URL || '',
      label: { en: env.SOURCE_LABEL || '', ru: env.SOURCE_LABEL || '' },
      labelShort: { en: env.SOURCE_LABEL_SHORT || '', ru: env.SOURCE_LABEL_SHORT || '' }
    },
    sourceLinks: [
      {
        url: env.SOURCE_URL || '',
        label: { en: env.SOURCE_LABEL || '', ru: env.SOURCE_LABEL || '' },
        labelShort: { en: env.SOURCE_LABEL_SHORT || '', ru: env.SOURCE_LABEL_SHORT || '' },
        logo: "<img src='https://globalfishingwatch.org/wp-content/uploads/cropped-gfwisologo512x512-1-1-32x32.png' alt='GFW'>"
      },
      {
        url: 'https://www.opensanctions.org/',
        label: { en: 'OpenSanctions', ru: 'OpenSanctions' },
        labelShort: { en: 'OS', ru: 'OS' },
        logo: "<img src='https://assets.opensanctions.org/images/nura/favicon-32.png' alt='OpenSanctions'>"
      }
    ],
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
        layers: [],
        label: { en: 'Sea ice extent', ru: 'Морской лёд' },
        labelShort: { en: 'Ice', ru: 'Лёд' },
        symbol: 'ice',
        defaultVisible: true,
        isIce: true
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
