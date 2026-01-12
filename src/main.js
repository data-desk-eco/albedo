import './style.css'
import maplibregl from 'maplibre-gl'
import * as pmtiles from 'pmtiles'

// Year colors: oldest (2023) → newest (2025)
// SYNC: Must match YEAR_COLORS in scripts/tile_server.py
const YEAR_COLORS = {
  2023: 'rgb(0, 255, 255)',   // Cyan (band 0)
  2024: 'rgb(0, 255, 0)',     // Green (band 1)
  2025: 'rgb(255, 0, 255)',   // Magenta (band 2)
}

// Current vessel category
let currentCategory = 'all'
let categories = []

// Internationalization
const i18n = {
  en: {
    protectedAreas: 'protected areas',
    protectedAreasShort: 'protected',
    vesselCrossings: 'vessel crossings',
    vesselCrossingsShort: 'crossings',
    satellite: 'satellite imagery',
    satelliteShort: 'satellite',
    dataSource: 'data: Global Fishing Watch',
    dataSourceShort: 'data: GFW',
    vessel: 'vessel',
    mmsi: 'mmsi',
    type: 'type',
    flag: 'flag',
    duration: 'duration',
    days: 'days',
    hours: 'hours',
    year: 'year',
    firstSeen: 'first seen',
    lastSeen: 'last seen',
    unknown: 'unknown',
    protectedArea: 'protected area',
    selectPlace: 'select a place of interest',
    selectCategory: 'select vessel category',
    allVessels: 'all vessels',
    multiYear: 'multiple years',
    multiYearShort: 'multi',
    sectionVessel: 'vessel presence',
    sectionLayers: 'additional layers',
    aboutTitle: 'about this map',
    aboutText: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.',
    // Vessel types
    vesselType_BUNKER: 'bunker',
    vesselType_CARGO: 'cargo',
    vesselType_CARRIER: 'carrier',
    vesselType_DISCREPANCY: 'discrepancy',
    vesselType_FISHING: 'fishing',
    vesselType_GEAR: 'gear',
    vesselType_OTHER: 'other',
    vesselType_PASSENGER: 'passenger',
    vesselType_SEISMIC_VESSEL: 'seismic',
    hoursShort: 'h',
    more: 'more',
  },
  ru: {
    protectedAreas: 'охраняемые территории',
    protectedAreasShort: 'охраняемые',
    vesselCrossings: 'пересечения судов',
    vesselCrossingsShort: 'пересечения',
    satellite: 'спутниковые снимки',
    satelliteShort: 'спутник',
    dataSource: 'данные: Global Fishing Watch',
    dataSourceShort: 'данные: GFW',
    vessel: 'судно',
    mmsi: 'mmsi',
    type: 'тип',
    flag: 'флаг',
    duration: 'длительность',
    days: 'дней',
    hours: 'часов',
    year: 'год',
    firstSeen: 'первое обнаружение',
    lastSeen: 'последнее обнаружение',
    unknown: 'неизвестно',
    protectedArea: 'охраняемая территория',
    selectPlace: 'выберите место',
    selectCategory: 'выберите категорию судов',
    allVessels: 'все суда',
    multiYear: 'несколько лет',
    multiYearShort: 'неск.',
    sectionVessel: 'присутствие судов',
    sectionLayers: 'дополнительные слои',
    aboutTitle: 'о карте',
    aboutText: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.',
    // Vessel types
    vesselType_BUNKER: 'бункеровщик',
    vesselType_CARGO: 'грузовое',
    vesselType_CARRIER: 'перевозчик',
    vesselType_DISCREPANCY: 'несоответствие',
    vesselType_FISHING: 'рыболовное',
    vesselType_GEAR: 'оборудование',
    vesselType_OTHER: 'другое',
    vesselType_PASSENGER: 'пассажирское',
    vesselType_SEISMIC_VESSEL: 'сейсморазведка',
    hoursShort: 'ч',
    more: 'ещё',
  }
}

// Translate vessel type
const tVesselType = (type) => {
  if (!type) return t('unknown')
  const key = `vesselType_${type}`
  return i18n[lang][key] || type
}

let lang = 'ru'
const t = (key) => i18n[lang][key]

function updateUI() {
  const isNarrow = window.innerWidth <= 600
  document.getElementById('legend-protected').textContent = t(isNarrow ? 'protectedAreasShort' : 'protectedAreas')
  document.getElementById('legend-crossings').textContent = t(isNarrow ? 'vesselCrossingsShort' : 'vesselCrossings')
  document.getElementById('legend-satellite').textContent = t(isNarrow ? 'satelliteShort' : 'satellite')
  document.getElementById('legend-source').textContent = t(isNarrow ? 'dataSourceShort' : 'dataSource')
  document.getElementById('legend-multi-year').textContent = t(isNarrow ? 'multiYearShort' : 'multiYear')
  document.getElementById('legend-section-vessel').textContent = t('sectionVessel')
  document.getElementById('legend-section-layers').textContent = t('sectionLayers')
  document.getElementById('about-title').textContent = t('aboutTitle')
  document.getElementById('about-text').textContent = t('aboutText')

  // Update place labels language if map is loaded
  if (typeof map !== 'undefined' && map.getLayer('place-labels')) {
    const nameField = lang === 'ru' ? 'name_ru' : 'name_en'
    map.setLayoutProperty('place-labels', 'text-field',
      ['coalesce', ['get', nameField], ['get', lang === 'ru' ? 'name_en' : 'name_ru']]
    )
  }

  // Update places dropdown if places are loaded (check if places is defined first)
  if (typeof places !== 'undefined' && places.length > 0) {
    const select = document.getElementById('places-select')
    const selectedValue = select.value
    populatePlacesDropdown()
    select.value = selectedValue
    // Update the description text if a place is selected
    if (selectedValue !== '') {
      showPlace(parseInt(selectedValue))
    }
  }

  // Update category dropdown if categories are loaded
  if (typeof categories !== 'undefined' && categories.length > 0) {
    populateCategoryDropdown()
  }
}

document.getElementById('lang-toggle').addEventListener('click', () => {
  lang = lang === 'ru' ? 'en' : 'ru'
  document.getElementById('lang-toggle').textContent = lang === 'ru' ? 'en' : 'ру'
  updateUI()
})

// About modal - close on click anywhere
document.getElementById('about-modal').addEventListener('click', () => {
  document.getElementById('about-modal').classList.add('hidden')
})

// Update UI on resize for responsive legend labels
window.addEventListener('resize', updateUI)

// Generate year legend items dynamically from YEAR_COLORS
function initYearLegend() {
  const container = document.getElementById('legend-years')
  Object.entries(YEAR_COLORS)
    .sort(([a], [b]) => Number(b) - Number(a))  // Newest first
    .forEach(([year, color]) => {
      const item = document.createElement('div')
      item.className = 'legend-item legend-toggle active'
      item.dataset.year = year
      item.innerHTML = `
        <div class="legend-symbol">
          <div class="legend-square" style="background: ${color};"></div>
        </div>
        <span class="legend-text">${year}</span>
      `
      container.appendChild(item)
    })
}
initYearLegend()

// Register PMTiles protocol
const protocol = new pmtiles.Protocol()
maplibregl.addProtocol('pmtiles', protocol.tile)

// Arctic region focus
const ARCTIC_CENTER_LAT = 75
const ARCTIC_MIN_LAT_ZOOMED_OUT = 60  // Minimum latitude when zoomed out (z <= 4)
const ARCTIC_MIN_LAT_ZOOMED_IN = 50   // Minimum latitude when zoomed in (z > 4)

// Create diagonal hatch pattern with given color (single direction)
function createHatchPattern(color, size = 6) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  ctx.strokeStyle = color
  ctx.lineWidth = 1

  // Draw diagonal lines (/) - with wrap for seamless tiling
  ctx.beginPath()
  ctx.moveTo(0, size)
  ctx.lineTo(size, 0)
  ctx.moveTo(-size, size)
  ctx.lineTo(size, -size)
  ctx.moveTo(0, size * 2)
  ctx.lineTo(size * 2, 0)
  ctx.stroke()

  return ctx.getImageData(0, 0, size, size)
}

// Get base path for tile URLs (works with /albedo or any path prefix)
const basePath = window.location.pathname.endsWith('/')
  ? window.location.pathname
  : window.location.pathname + '/'

// Tile cache version - injected from .env at build time
const TILE_VERSION = __TILE_VERSION__

const map = new maplibregl.Map({
  container: 'map',
  attributionControl: false,
  style: {
    version: 8,
    projection: {
      type: 'globe'
    },
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
        paint: {
          'background-color': '#000000'
        }
      },
      {
        id: 'land',
        type: 'fill',
        source: 'land',
        'source-layer': 'land',
        paint: {
          'fill-color': '#ffffff',
          'fill-opacity': 1
        }
      },
      {
        id: 'sentinel-2',
        type: 'raster',
        source: 'sentinel-2',
        layout: {
          'visibility': 'none'
        },
        paint: {
          'raster-opacity': 1
        }
      },
      {
        id: 'protected-areas-on-land-sm',
        type: 'fill',
        source: 'protected-areas',
        'source-layer': 'protected_areas_land',
        maxzoom: 4,
        paint: {
          'fill-pattern': 'hatch-black-sm',
          'fill-opacity': 1
        }
      },
      {
        id: 'protected-areas-on-land-md',
        type: 'fill',
        source: 'protected-areas',
        'source-layer': 'protected_areas_land',
        minzoom: 4,
        maxzoom: 7,
        paint: {
          'fill-pattern': 'hatch-black-md',
          'fill-opacity': 1
        }
      },
      {
        id: 'protected-areas-on-land-lg',
        type: 'fill',
        source: 'protected-areas',
        'source-layer': 'protected_areas_land',
        minzoom: 7,
        paint: {
          'fill-pattern': 'hatch-black-lg',
          'fill-opacity': 1
        }
      },
      {
        id: 'protected-areas-on-land-border',
        type: 'line',
        source: 'protected-areas',
        'source-layer': 'protected_areas_land',
        paint: {
          'line-color': '#000000',
          'line-width': 2,
          'line-opacity': 1
        }
      },
      {
        id: 'protected-areas-on-sea-sm',
        type: 'fill',
        source: 'protected-areas',
        'source-layer': 'protected_areas_sea',
        maxzoom: 4,
        paint: {
          'fill-pattern': 'hatch-white-sm',
          'fill-opacity': 1
        }
      },
      {
        id: 'protected-areas-on-sea-md',
        type: 'fill',
        source: 'protected-areas',
        'source-layer': 'protected_areas_sea',
        minzoom: 4,
        maxzoom: 7,
        paint: {
          'fill-pattern': 'hatch-white-md',
          'fill-opacity': 1
        }
      },
      {
        id: 'protected-areas-on-sea-lg',
        type: 'fill',
        source: 'protected-areas',
        'source-layer': 'protected_areas_sea',
        minzoom: 7,
        paint: {
          'fill-pattern': 'hatch-white-lg',
          'fill-opacity': 1
        }
      },
      {
        id: 'protected-areas-on-sea-border',
        type: 'line',
        source: 'protected-areas',
        'source-layer': 'protected_areas_sea',
        paint: {
          'line-color': '#ffffff',
          'line-width': 2,
          'line-opacity': 1
        }
      },
      {
        id: 'vessel-heatmap',
        type: 'raster',
        source: 'vessel-heatmap',
        paint: {
          'raster-opacity': 1,
          'raster-resampling': 'nearest',  // Keep pixels crisp, no blur
          'raster-brightness-max': 1,      // Boost brightness
          'raster-contrast': 0.3           // Increase contrast to make it pop
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
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            2.5, [
              'interpolate',
              ['linear'],
              ['get', 'total_hours'],
              1, 3,      // 1 hour → 3px at min zoom
              24, 5,     // 1 day → 5px
              168, 10,   // 1 week → 10px
              720, 18    // 1 month → 18px
            ],
            10, [
              'interpolate',
              ['linear'],
              ['get', 'total_hours'],
              1, 6,      // 1 hour → 6px at max zoom
              24, 10,    // 1 day → 10px
              168, 20,   // 1 week → 20px
              720, 36    // 1 month → 36px
            ]
          ],
          'circle-color': 'transparent',
          'circle-opacity': 0,
          'circle-stroke-color': [
            'match',
            ['get', 'year'],
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
            'interpolate',
            ['linear'],
            ['zoom'],
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
  },
  center: [100, ARCTIC_CENTER_LAT],
  zoom: 2.5,
  pitch: 20,  // Slight tilt to view Arctic region
  bearing: 0,
  maxZoom: 14,
  minZoom: 2.5,
  minPitch: 0,
  maxPitch: 30,
  renderWorldCopies: false
})

// Generate hatch patterns on demand to avoid "image not found" warnings
const hatchPatterns = {
  'hatch-white-sm': () => createHatchPattern('#ffffff', 6),
  'hatch-black-sm': () => createHatchPattern('#000000', 6),
  'hatch-white-md': () => createHatchPattern('#ffffff', 10),
  'hatch-black-md': () => createHatchPattern('#000000', 10),
  'hatch-white-lg': () => createHatchPattern('#ffffff', 16),
  'hatch-black-lg': () => createHatchPattern('#000000', 16)
}

map.on('styleimagemissing', (e) => {
  const id = e.id
  if (hatchPatterns[id]) {
    map.addImage(id, hatchPatterns[id](), { pixelRatio: 1 })
  }
})

map.on('load', () => {
  // Load vessel categories
  loadCategories()
  // Load places of interest from JSON
  loadPlaces()
})

// Set up legend toggle click handlers
document.querySelectorAll('.legend-toggle').forEach(item => {
  item.addEventListener('click', () => {
    const year = item.dataset.year
    const layer = item.dataset.layer

    if (year) {
      toggleYear(parseInt(year))
      item.classList.toggle('active', activeYears.has(parseInt(year)))
    } else if (layer) {
      toggleLayer(layer)
      item.classList.toggle('active')
    }
  })
})

// Keep focus on Arctic region
map.on('moveend', () => {
  const center = map.getCenter()
  const zoom = map.getZoom()
  const minLat = zoom > 4 ? ARCTIC_MIN_LAT_ZOOMED_IN : ARCTIC_MIN_LAT_ZOOMED_OUT

  if (center.lat < minLat) {
    map.panTo([center.lng, ARCTIC_CENTER_LAT])
  }
})

// Tooltip for incursion points on hover
const tooltip = document.getElementById('tooltip')

const formatDate = (isoString) => {
  const date = new Date(isoString)
  const day = date.getDate()
  const month = date.toLocaleString(lang === 'ru' ? 'ru' : 'en', { month: 'short' })
  const year = date.getFullYear()
  return `${day} ${month} ${year}`
}

let hoveringCrossing = false

map.on('mouseenter', 'crossings', (e) => {
  hoveringCrossing = true
  map.getCanvas().style.cursor = 'pointer'

  const props = e.features[0].properties
  const hours = Math.round(props.total_hours)

  // Position tooltip below controls container
  const controlsEl = document.getElementById('controls')
  const controlsRect = controlsEl.getBoundingClientRect()
  tooltip.style.top = (controlsRect.bottom + 8) + 'px'

  tooltip.innerHTML = `
    <table>
      <tr><td>${t('vessel')}</td><td>${props.ship_name || t('unknown')}</td></tr>
      <tr><td>${t('mmsi')}</td><td>${props.mmsi}</td></tr>
      <tr><td>${t('type')}</td><td>${tVesselType(props.vessel_type)}</td></tr>
      <tr><td>${t('flag')}</td><td>${props.flag || t('unknown')}</td></tr>
      <tr><td>${t('duration')}</td><td>${hours} ${t('hours')}</td></tr>
      <tr><td>${t('firstSeen')}</td><td>${formatDate(props.first_seen)}</td></tr>
      <tr><td>${t('lastSeen')}</td><td>${formatDate(props.last_seen)}</td></tr>
    </table>
  `
  tooltip.classList.add('visible')
})

map.on('mouseleave', 'crossings', () => {
  hoveringCrossing = false
  map.getCanvas().style.cursor = ''
  tooltip.classList.remove('visible')
})


// Raster hover for vessel tooltips at high zoom (server-side query)
const RASTER_TOOLTIP_MIN_ZOOM = 8

// Debounce utility
function debounce(fn, delay) {
  let timeoutId
  return (...args) => {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn(...args), delay)
  }
}

// Fetch vessels at a location from the API
async function fetchVesselsAtLocation(lat, lon) {
  try {
    // Filter by active years if only one is selected
    const yearsParam = activeYears.size === 1
      ? `&year=${Array.from(activeYears)[0]}`
      : ''
    const response = await fetch(`${basePath}api/vessels?lat=${lat}&lon=${lon}${yearsParam}`)
    if (!response.ok) return null
    const data = await response.json()
    return data.vessels || []
  } catch (err) {
    console.warn('Vessel query failed:', err)
    return null
  }
}

// Show raster tooltip with vessel data
function showRasterTooltip(vessels) {
  if (!vessels || vessels.length === 0) {
    tooltip.classList.remove('visible')
    return
  }

  // Position tooltip below controls container
  const controlsEl = document.getElementById('controls')
  const controlsRect = controlsEl.getBoundingClientRect()
  tooltip.style.top = (controlsRect.bottom + 8) + 'px'

  // Show up to 5 vessels in compact row format
  const displayVessels = vessels.slice(0, 5)
  const moreCount = vessels.length > 5 ? vessels.length - 5 : 0

  // Column headers
  let html = `
    <div class="vessel-row vessel-header">
      <span class="vessel-mmsi">${t('mmsi')}</span>
      <span class="vessel-name">${t('vessel')}</span>
      <span class="vessel-type">${t('type')}</span>
      <span class="vessel-flag">${t('flag')}</span>
      <span class="vessel-hours">${t('hours')}</span>
      <span class="vessel-year">${t('year')}</span>
    </div>
  `

  html += displayVessels.map(v => {
    const hours = Math.round(v.total_hours)
    return `
      <div class="vessel-row">
        <span class="vessel-mmsi">${v.mmsi}</span>
        <span class="vessel-name">${v.ship_name || t('unknown')}</span>
        <span class="vessel-type">${tVesselType(v.vessel_type)}</span>
        <span class="vessel-flag">${v.flag || '?'}</span>
        <span class="vessel-hours">${hours}${t('hoursShort')}</span>
        <span class="vessel-year">${v.year}</span>
      </div>
    `
  }).join('')

  if (moreCount > 0) {
    html += `<div style="padding-top: 6px; color: #fff;">+${moreCount} ${t('more')}</div>`
  }

  tooltip.innerHTML = html
  tooltip.classList.add('visible')
}

// Debounced handler for raster mousemove
const handleRasterHover = debounce(async (e) => {
  const zoom = map.getZoom()
  if (zoom < RASTER_TOOLTIP_MIN_ZOOM) return

  const { lat, lng } = e.lngLat
  const vessels = await fetchVesselsAtLocation(lat, lng)
  showRasterTooltip(vessels)
}, 150)

// Raster hover events
map.on('mousemove', (e) => {
  if (hoveringCrossing) return  // Don't override crossings tooltip
  const zoom = map.getZoom()
  if (zoom >= RASTER_TOOLTIP_MIN_ZOOM) {
    handleRasterHover(e)
  }
})

map.on('mouseout', () => {
  // Hide tooltip when mouse leaves the map
  tooltip.classList.remove('visible')
})

// Layer visibility toggles
const activeYears = new Set([2023, 2024, 2025])
let satelliteMode = false

// Protected area layer IDs
const protectedAreaLayers = [
  'protected-areas-on-land-sm',
  'protected-areas-on-land-md',
  'protected-areas-on-land-lg',
  'protected-areas-on-land-border',
  'protected-areas-on-sea-sm',
  'protected-areas-on-sea-md',
  'protected-areas-on-sea-lg',
  'protected-areas-on-sea-border'
]

// Update protected area styling based on satellite mode
function updateProtectedAreaColors() {
  const landColor = satelliteMode ? 'white' : 'black'
  // Land hatching patterns
  map.setPaintProperty('protected-areas-on-land-sm', 'fill-pattern', `hatch-${landColor}-sm`)
  map.setPaintProperty('protected-areas-on-land-md', 'fill-pattern', `hatch-${landColor}-md`)
  map.setPaintProperty('protected-areas-on-land-lg', 'fill-pattern', `hatch-${landColor}-lg`)
  map.setPaintProperty('protected-areas-on-land-border', 'line-color', satelliteMode ? '#ffffff' : '#000000')
}

function updateHeatmapSource() {
  const years = Array.from(activeYears).sort()

  // Hide heatmap layer if no years selected
  if (years.length === 0) {
    map.setLayoutProperty('vessel-heatmap', 'visibility', 'none')
    return
  }

  map.setLayoutProperty('vessel-heatmap', 'visibility', 'visible')

  // Build tile URL with category and year filters
  // Years are now band indices (0, 1, 2) - convert from year to index
  const yearList = Object.keys(YEAR_COLORS).map(Number).sort()
  const bandIndices = years.map(y => yearList.indexOf(y)).filter(i => i >= 0)
  const yearsParam = bandIndices.length < 3 ? `&years=${bandIndices.join(',')}` : ''
  const categoryParam = currentCategory !== 'all' ? `&category=${currentCategory}` : ''
  const newTileUrl = basePath + `tiles/{z}/{x}/{y}.png?v=${TILE_VERSION}${yearsParam}${categoryParam}`

  // Update the tile source URL and force refresh
  const source = map.getSource('vessel-heatmap')
  if (source) {
    source.setTiles([newTileUrl])
    // Clear tile cache to force reload with new params
    const sourceCache = map.style?.sourceCaches?.['vessel-heatmap']
    if (sourceCache) {
      sourceCache.clearTiles()
    }
    map.triggerRepaint()
  }
}

function toggleYear(year) {
  if (activeYears.has(year)) {
    activeYears.delete(year)
  } else {
    activeYears.add(year)
  }
  updateHeatmapSource()
  updateMultiYearLegend()
}

function updateMultiYearLegend() {
  const multiYearItem = document.querySelector('.legend-multi-year')
  if (activeYears.size >= 2) {
    multiYearItem.classList.remove('disabled')
  } else {
    multiYearItem.classList.add('disabled')
  }
}

function toggleLayer(layerId) {
  if (layerId === 'protected-areas') {
    const isVisible = map.getLayoutProperty(protectedAreaLayers[0], 'visibility') !== 'none'
    const visibility = isVisible ? 'none' : 'visible'
    protectedAreaLayers.forEach(id => {
      map.setLayoutProperty(id, 'visibility', visibility)
    })
  } else if (layerId === 'crossings') {
    const isVisible = map.getLayoutProperty('crossings', 'visibility') !== 'none'
    map.setLayoutProperty('crossings', 'visibility', isVisible ? 'none' : 'visible')
  } else if (layerId === 'satellite') {
    satelliteMode = !satelliteMode
    map.setLayoutProperty('sentinel-2', 'visibility', satelliteMode ? 'visible' : 'none')
    updateProtectedAreaColors()
  }
}

// Places of interest - loaded from JSON
let places = []

// Initialize UI text after places variable is declared
updateUI()

// Category selection and management
async function loadCategories() {
  try {
    const response = await fetch(basePath + 'api/categories')
    const data = await response.json()
    categories = data.categories || []
    if (categories.length > 0) {
      populateCategoryDropdown()
    }
  } catch (err) {
    console.warn('Could not load categories:', err)
  }
}

function populateCategoryDropdown() {
  const select = document.getElementById('category-select')
  select.innerHTML = ''

  categories.forEach(cat => {
    const option = document.createElement('option')
    option.value = cat.id
    option.textContent = lang === 'ru' ? cat.name_ru : cat.name_en
    select.appendChild(option)
  })

  select.value = currentCategory
}

function selectCategory(categoryId) {
  currentCategory = categoryId
  updateHeatmapSource()
}

document.getElementById('category-select').addEventListener('change', (e) => {
  selectCategory(e.target.value)
})

async function loadPlaces() {
  try {
    const response = await fetch(basePath + 'data/places/places.json')
    const data = await response.json()
    places = data.places
    if (places.length > 0) {
      document.getElementById('places-select').classList.remove('hidden')
      populatePlacesDropdown()
    }
  } catch (err) {
    console.warn('Could not load places:', err)
    document.getElementById('places-select').classList.add('hidden')
  }
}

function populatePlacesDropdown() {
  const select = document.getElementById('places-select')
  // Clear existing options except the default
  select.innerHTML = `<option value="">${t('selectPlace')}</option>`

  places.forEach((place, index) => {
    const option = document.createElement('option')
    option.value = index
    option.textContent = lang === 'ru' ? place.name_ru : place.name_en
    select.appendChild(option)
  })
}

function showPlace(index) {
  const place = places[index]
  const infoEl = document.getElementById('places-info')

  if (!place) {
    infoEl.classList.add('hidden')
    return
  }

  const description = lang === 'ru' ? place.description_ru : place.description_en
  infoEl.innerHTML = `<span>${description}</span>`
  infoEl.classList.remove('hidden')

  // Fly to location
  map.flyTo({ center: place.center, zoom: place.zoom, duration: 2000 })
}

document.getElementById('places-select').addEventListener('change', (e) => {
  const value = e.target.value
  if (value === '') {
    document.getElementById('places-info').classList.add('hidden')
    return
  }
  showPlace(parseInt(value))
})

