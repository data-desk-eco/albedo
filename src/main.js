import './style.css'
import maplibregl from 'maplibre-gl'
import * as pmtiles from 'pmtiles'

// Year colors used throughout the app (heatmap, legend, crossings)
const YEAR_COLORS = {
  2024: 'rgb(255, 0, 255)',  // Magenta (latest)
  2023: 'rgb(0, 255, 0)',    // Green (middle)
  2022: 'rgb(0, 255, 255)'   // Cyan (oldest)
}

// Set random favicon from year colors
function setRandomFavicon() {
  const colors = Object.values(YEAR_COLORS)
  const randomColor = colors[Math.floor(Math.random() * colors.length)]

  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' fill='${randomColor}'/></svg>`
  const encodedSvg = encodeURIComponent(svg)

  const existing = document.querySelector("link[rel*='icon']")
  if (existing) {
    existing.href = `data:image/svg+xml,${encodedSvg}`
  } else {
    const link = document.createElement('link')
    link.type = 'image/svg+xml'
    link.rel = 'icon'
    link.href = `data:image/svg+xml,${encodedSvg}`
    document.head.appendChild(link)
  }
}

// Internationalization
const i18n = {
  en: {
    protectedAreas: 'protected areas',
    vesselCrossings: 'vessel crossings',
    satellite: 'satellite imagery',
    dataSource: 'data: Global Fishing Watch',
    vessel: 'Vessel',
    mmsi: 'MMSI',
    type: 'Type',
    flag: 'Flag',
    duration: 'Duration',
    days: 'days',
    hours: 'hours',
    firstSeen: 'First seen',
    lastSeen: 'Last seen',
    unknown: 'Unknown',
    protectedArea: 'Protected Area',
    selectPlace: 'select a place of interest'
  },
  ru: {
    protectedAreas: 'охраняемые территории',
    vesselCrossings: 'пересечения судов',
    satellite: 'спутниковые снимки',
    dataSource: 'данные: Global Fishing Watch',
    vessel: 'Судно',
    mmsi: 'MMSI',
    type: 'Тип',
    flag: 'Флаг',
    duration: 'Длительность',
    days: 'дней',
    hours: 'часов',
    firstSeen: 'Первое обнаружение',
    lastSeen: 'Последнее обнаружение',
    unknown: 'Неизвестно',
    protectedArea: 'Охраняемая территория',
    selectPlace: 'выберите место'
  }
}

let lang = 'en'
const t = (key) => i18n[lang][key]

function updateUI() {
  document.getElementById('legend-protected').textContent = t('protectedAreas')
  document.getElementById('legend-crossings').textContent = t('vesselCrossings')
  document.getElementById('legend-satellite').textContent = t('satellite')
  document.getElementById('legend-source').textContent = t('dataSource')

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
}

document.getElementById('lang-toggle').addEventListener('click', () => {
  lang = lang === 'en' ? 'ru' : 'en'
  document.getElementById('lang-toggle').textContent = lang === 'en' ? 'РУ' : 'EN'
  updateUI()
})

// Set random favicon on page load
setRandomFavicon()

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
      }
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
            2022, YEAR_COLORS[2022],
            2023, YEAR_COLORS[2023],
            2024, YEAR_COLORS[2024],
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
          'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name_ru']],
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

// Add hatch patterns at different sizes for zoom levels
map.on('load', () => {
  // Small/tight patterns for zoomed out (z0-4)
  map.addImage('hatch-white-sm', createHatchPattern('#ffffff', 6), { pixelRatio: 1 })
  map.addImage('hatch-black-sm', createHatchPattern('#000000', 6), { pixelRatio: 1 })
  // Medium patterns (z4-7)
  map.addImage('hatch-white-md', createHatchPattern('#ffffff', 10), { pixelRatio: 1 })
  map.addImage('hatch-black-md', createHatchPattern('#000000', 10), { pixelRatio: 1 })
  // Large/loose patterns for zoomed in (z7+)
  map.addImage('hatch-white-lg', createHatchPattern('#ffffff', 16), { pixelRatio: 1 })
  map.addImage('hatch-black-lg', createHatchPattern('#000000', 16), { pixelRatio: 1 })

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
  const month = date.toLocaleString('en', { month: 'short' })
  const year = date.getFullYear()
  return `${day} ${month} ${year}`
}

map.on('mouseenter', 'crossings', (e) => {
  map.getCanvas().style.cursor = 'pointer'

  const props = e.features[0].properties
  const hours = props.total_hours
  const days = (hours / 24).toFixed(1)

  // Position tooltip below places container
  const placesEl = document.getElementById('places')
  const placesRect = placesEl.getBoundingClientRect()
  tooltip.style.top = (placesRect.bottom + 8) + 'px'

  tooltip.innerHTML = `
    <table>
      <tr><td>${t('vessel')}</td><td>${props.ship_name || t('unknown')}</td></tr>
      <tr><td>${t('mmsi')}</td><td>${props.mmsi}</td></tr>
      <tr><td>${t('type')}</td><td>${props.vessel_type || t('unknown')}</td></tr>
      <tr><td>${t('flag')}</td><td>${props.flag || t('unknown')}</td></tr>
      <tr><td>${t('duration')}</td><td>${days} ${t('days')}</td></tr>
      <tr><td>${t('firstSeen')}</td><td>${formatDate(props.first_seen)}</td></tr>
      <tr><td>${t('lastSeen')}</td><td>${formatDate(props.last_seen)}</td></tr>
    </table>
  `
  tooltip.classList.add('visible')
})

map.on('mouseleave', 'crossings', () => {
  map.getCanvas().style.cursor = ''
  tooltip.classList.remove('visible')
})

// Layer visibility toggles
const activeYears = new Set([2022, 2023, 2024])
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
  const yearsParam = years.length < 3 ? `&years=${years.join(',')}` : ''
  const newTileUrl = basePath + `tiles/{z}/{x}/{y}.png?v=${TILE_VERSION}${yearsParam}`

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

async function loadPlaces() {
  try {
    const response = await fetch(basePath + 'data/places/places.json')
    const data = await response.json()
    places = data.places
    if (places.length > 0) {
      document.getElementById('places').classList.remove('hidden')
      populatePlacesDropdown()
    }
  } catch (err) {
    console.warn('Could not load places:', err)
    document.getElementById('places').classList.add('hidden')
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

