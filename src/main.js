import './style.css'
import maplibregl from 'maplibre-gl'
import { t, tVesselType, getLang, setLang, toggleLang } from './i18n.js'
import { initCOG, renderTile, clearCache as clearCOGCache } from './cog-tiles.js'
import { initDB, loadProtectedAreas, loadVesselCrossings, loadPlaces, queryVesselsAt, loadTooltipTargetsInBounds } from './data-layer.js'
import {
  DEBUG_MODE,
  YEAR_COLORS,
  ARCTIC_CENTER_LAT,
  ARCTIC_MIN_LAT_ZOOMED_OUT,
  ARCTIC_MIN_LAT_ZOOMED_IN,
  RASTER_TOOLTIP_MIN_ZOOM,
  basePath,
  COG_URL,
  DATA_URL,
  PROTECTED_AREA_LAYERS,
  createMapStyle
} from './config.js'

// State
let currentCategory = 'all'
let categories = []
let placesData = []
const activeYears = new Set([2023, 2024, 2025])
let satelliteMode = false
let hoveringCrossing = false
let dataInitialized = false

// COG tile cache
const cogTileCache = new Map()
let activeYearBands = [0, 1, 2]  // All years by default

// DOM elements
const tooltip = document.getElementById('tooltip')
const controlsEl = document.getElementById('controls')

// Tooltip utilities
function positionTooltip() {
  const rect = controlsEl.getBoundingClientRect()
  tooltip.style.top = (rect.bottom + 8) + 'px'
}

function showTooltip(html) {
  positionTooltip()
  tooltip.innerHTML = html
  tooltip.classList.add('visible')
}

function hideTooltip() {
  tooltip.classList.remove('visible')
}

// Date formatting
function formatDate(isoString) {
  const date = new Date(isoString)
  const day = date.getDate()
  const month = date.toLocaleString(getLang() === 'ru' ? 'ru' : 'en', { month: 'short' })
  const year = date.getFullYear()
  return `${day} ${month} ${year}`
}

// Debounce utility
function debounce(fn, delay) {
  let timeoutId
  return (...args) => {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn(...args), delay)
  }
}

// UI updates
function updateUI() {
  const isNarrow = window.innerWidth <= 600
  const lang = getLang()

  // Legend labels
  document.getElementById('legend-protected').textContent = t(isNarrow ? 'protectedAreasShort' : 'protectedAreas')
  document.getElementById('legend-crossings').textContent = t(isNarrow ? 'vesselCrossingsShort' : 'vesselCrossings')
  document.getElementById('legend-satellite').textContent = t(isNarrow ? 'satelliteShort' : 'satellite')
  document.getElementById('legend-source').textContent = t(isNarrow ? 'dataSourceShort' : 'dataSource')
  document.getElementById('legend-multi-year').textContent = t(isNarrow ? 'multiYearShort' : 'multiYear')
  document.getElementById('legend-section-vessel').textContent = t('sectionVessel')
  document.getElementById('legend-section-layers').textContent = t('sectionLayers')

  // Update place labels language if map is loaded
  if (typeof map !== 'undefined' && map.getLayer('place-labels')) {
    const nameField = lang === 'ru' ? 'name_ru' : 'name_en'
    map.setLayoutProperty('place-labels', 'text-field',
      ['coalesce', ['get', nameField], ['get', lang === 'ru' ? 'name_en' : 'name_ru']]
    )
  }

  // Update dropdowns
  if (placesData.length > 0) {
    const select = document.getElementById('places-select')
    const selectedValue = select.value
    populatePlacesDropdown()
    select.value = selectedValue
    if (selectedValue !== '') showPlace(parseInt(selectedValue))
  }

  if (categories.length > 0) {
    populateCategoryDropdown()
  }
}

// Year legend
function initYearLegend() {
  const container = document.getElementById('legend-years')
  Object.entries(YEAR_COLORS)
    .sort(([a], [b]) => Number(b) - Number(a))
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

// Hatch pattern generation
function createHatchPattern(color, size = 6) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  ctx.strokeStyle = color
  ctx.lineWidth = 1
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

const hatchPatterns = {
  'hatch-white-sm': () => createHatchPattern('#ffffff', 6),
  'hatch-black-sm': () => createHatchPattern('#000000', 6),
  'hatch-white-md': () => createHatchPattern('#ffffff', 10),
  'hatch-black-md': () => createHatchPattern('#000000', 10),
  'hatch-white-lg': () => createHatchPattern('#ffffff', 16),
  'hatch-black-lg': () => createHatchPattern('#000000', 16)
}

// COG initialization - start immediately, don't wait for map load
const cogReady = initCOG(COG_URL).catch(err => {
  console.error('COG init failed:', err)
})

// DuckDB initialization - lazy load in background, doesn't block map
let dbReady = null
function ensureDB() {
  if (!dbReady) {
    dbReady = initDB(DATA_URL).catch(err => {
      console.error('DuckDB init failed:', err)
      dbReady = null
    })
  }
  return dbReady
}

// Register COG tile protocol (Promise-based API for MapLibre GL JS v5+)
maplibregl.addProtocol('cog', async (params) => {
  const match = params.url.match(/cog:\/\/(\d+)\/(\d+)\/(\d+)/)
  if (!match) {
    throw new Error('Invalid COG tile URL')
  }

  // Wait for COG initialization
  await cogReady

  const [, z, x, y] = match.map(Number)
  // Include satellite mode in cache key (land rendering differs)
  const cacheKey = `${z}/${x}/${y}/${activeYearBands.join(',')}/${satelliteMode}`

  if (cogTileCache.has(cacheKey)) {
    return { data: cogTileCache.get(cacheKey) }
  }

  try {
    // In satellite mode, make land transparent (showLand = false)
    const buffer = await renderTile(z, x, y, activeYearBands, !satelliteMode)
    cogTileCache.set(cacheKey, buffer)
    return { data: buffer }
  } catch (err) {
    console.warn('COG tile error:', err)
    throw err
  }
})

// Initialize map
const map = window.map = new maplibregl.Map({
  container: 'map',
  attributionControl: false,
  style: createMapStyle(),
  center: [100, ARCTIC_CENTER_LAT],
  zoom: 2.5,
  pitch: 20,
  bearing: 0,
  maxZoom: 14,
  minZoom: 2.5,
  minPitch: 0,
  maxPitch: 30,
  renderWorldCopies: false,
  // Use local system fonts for offline support (no glyph server needed)
  localFontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
})

// Map event handlers
map.on('styleimagemissing', (e) => {
  if (hatchPatterns[e.id]) {
    map.addImage(e.id, hatchPatterns[e.id](), { pixelRatio: 1 })
  }
})

map.on('load', async () => {
  // Wait for COG (heatmap) - this is critical for initial render
  try {
    await cogReady
    map.triggerRepaint()
  } catch (err) {
    console.error('COG init failed:', err)
  }

  // Load vector layers in background (doesn't block map interaction)
  ensureDB().then(async () => {
    try {
      const [protectedAreas, crossings, places] = await Promise.all([
        loadProtectedAreas(),
        loadVesselCrossings(),
        loadPlaces()
      ])

      // Store crossings for filtering and update sources
      allCrossings = crossings

      map.getSource('protected-areas').setData(protectedAreas)
      map.getSource('vessel-crossings').setData(crossings)
      map.getSource('places').setData(places)

      dataInitialized = true

      // Load categories now that we have crossings data
      loadCategories()
    } catch (err) {
      console.error('Failed to load vector data:', err)
    }
  })

  // Load places dropdown (uses JSON, not DuckDB)
  loadPlacesDropdown()
})

map.on('moveend', async () => {
  const center = map.getCenter()
  const zoom = map.getZoom()
  const minLat = zoom > 4 ? ARCTIC_MIN_LAT_ZOOMED_IN : ARCTIC_MIN_LAT_ZOOMED_OUT
  if (center.lat < minLat) {
    map.panTo([center.lng, ARCTIC_CENTER_LAT])
  }

  // Update debug tooltip targets layer when zoomed in enough (DEBUG_MODE only)
  if (DEBUG_MODE && zoom >= 5) {
    // Ensure DB is ready before querying
    await ensureDB()
    if (!dataInitialized) return

    const bounds = map.getBounds()
    try {
      const targets = await loadTooltipTargetsInBounds(
        bounds.getSouth(),
        bounds.getNorth(),
        bounds.getWest(),
        bounds.getEast()
      )
      map.getSource('debug-tooltip-targets').setData(targets)
    } catch (err) {
      console.warn('Failed to load debug targets:', err)
    }
  }
})

// Crossings tooltip
map.on('mouseenter', 'crossings', (e) => {
  hoveringCrossing = true
  map.getCanvas().style.cursor = 'pointer'

  const props = e.features[0].properties
  const hours = Math.round(props.total_hours)

  showTooltip(`
    <table>
      <tr><td>${t('vessel')}</td><td>${props.ship_name || t('unknown')}</td></tr>
      <tr><td>${t('mmsi')}</td><td>${props.mmsi}</td></tr>
      <tr><td>${t('type')}</td><td>${tVesselType(props.vessel_type)}</td></tr>
      <tr><td>${t('flag')}</td><td>${props.flag || t('unknown')}</td></tr>
      <tr><td>${t('duration')}</td><td>${hours} ${t('hours')}</td></tr>
      <tr><td>${t('firstSeen')}</td><td>${formatDate(props.first_seen)}</td></tr>
      <tr><td>${t('lastSeen')}</td><td>${formatDate(props.last_seen)}</td></tr>
    </table>
  `)
})

map.on('mouseleave', 'crossings', () => {
  hoveringCrossing = false
  map.getCanvas().style.cursor = ''
  hideTooltip()
})

// Raster vessel tooltip (client-side DuckDB query)
function showRasterTooltip(vessels) {
  if (!vessels || vessels.length === 0) {
    hideTooltip()
    return
  }

  const displayVessels = vessels.slice(0, 5)
  const moreCount = vessels.length > 5 ? vessels.length - 5 : 0

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

  html += displayVessels.map(v => `
    <div class="vessel-row">
      <span class="vessel-mmsi">${v.mmsi}</span>
      <span class="vessel-name">${v.ship_name || t('unknown')}</span>
      <span class="vessel-type">${tVesselType(v.vessel_type)}</span>
      <span class="vessel-flag">${v.flag || '?'}</span>
      <span class="vessel-hours">${Math.round(v.total_hours)}${t('hoursShort')}</span>
      <span class="vessel-year">${v.year}</span>
    </div>
  `).join('')

  if (moreCount > 0) {
    html += `<div style="padding-top: 6px; color: #fff;">+${moreCount} ${t('more')}</div>`
  }

  showTooltip(html)
}

const handleRasterHover = debounce(async (e) => {
  if (map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) return

  // Ensure DB is ready before querying (lazy init if needed)
  if (!dataInitialized) {
    await ensureDB()
    if (!dataInitialized) return  // Still loading vector data
  }

  const { lat, lng } = e.lngLat
  const year = activeYears.size === 1 ? Array.from(activeYears)[0] : null

  try {
    const vessels = await queryVesselsAt(lat, lng, year)
    showRasterTooltip(vessels)
  } catch (err) {
    // Silently fail tooltip queries
  }
}, 50)

map.on('mousemove', (e) => {
  if (hoveringCrossing) return
  if (map.getZoom() >= RASTER_TOOLTIP_MIN_ZOOM) {
    handleRasterHover(e)
  }
})

map.on('mouseout', () => hideTooltip())

map.on('zoom', () => {
  if (!hoveringCrossing && map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) {
    hideTooltip()
  }
})

// Layer controls
function updateProtectedAreaColors() {
  const hatchColor = satelliteMode ? 'white' : 'white'  // Keep white for now
  map.setPaintProperty('protected-areas-fill', 'fill-pattern', `hatch-${hatchColor}-md`)
  map.setPaintProperty('protected-areas-border', 'line-color', satelliteMode ? '#ffffff' : '#ffffff')
}

function updateHeatmapSource() {
  const years = Array.from(activeYears).sort()

  // Always keep heatmap visible (it contains land mask)
  // When no years selected, we render just land
  map.setLayoutProperty('vessel-heatmap', 'visibility', 'visible')

  // Map years to band indices (2023→0, 2024→1, 2025→2)
  // Empty array means no vessel data, just land
  const yearList = Object.keys(YEAR_COLORS).map(Number).sort()
  activeYearBands = years.map(y => yearList.indexOf(y)).filter(i => i >= 0)

  // Clear our application tile cache
  cogTileCache.clear()
  clearCOGCache()

  // Force MapLibre to reload tiles by updating the source tiles URL
  // Adding a timestamp query param invalidates MapLibre's internal cache
  const source = map.getSource('vessel-heatmap')
  if (source) {
    source.setTiles([`cog://{z}/{x}/{y}?t=${Date.now()}`])
  }
}

function updateMultiYearLegend() {
  const multiYearItem = document.querySelector('.legend-multi-year')
  multiYearItem.classList.toggle('disabled', activeYears.size < 2)
}

function toggleYear(year) {
  activeYears.has(year) ? activeYears.delete(year) : activeYears.add(year)
  updateHeatmapSource()
  updateMultiYearLegend()
}

function toggleLayer(layerId) {
  if (layerId === 'protected-areas') {
    const isVisible = map.getLayoutProperty(PROTECTED_AREA_LAYERS[0], 'visibility') !== 'none'
    const visibility = isVisible ? 'none' : 'visible'
    PROTECTED_AREA_LAYERS.forEach(id => map.setLayoutProperty(id, 'visibility', visibility))
  } else if (layerId === 'crossings') {
    const isVisible = map.getLayoutProperty('crossings', 'visibility') !== 'none'
    map.setLayoutProperty('crossings', 'visibility', isVisible ? 'none' : 'visible')
  } else if (layerId === 'satellite') {
    satelliteMode = !satelliteMode
    map.setLayoutProperty('sentinel-2', 'visibility', satelliteMode ? 'visible' : 'none')
    updateProtectedAreaColors()
    // Invalidate tile cache (land rendering changes with satellite mode)
    cogTileCache.clear()
    clearCOGCache()
    const source = map.getSource('vessel-heatmap')
    if (source) {
      source.setTiles([`cog://{z}/{x}/{y}?t=${Date.now()}`])
    }
  }
}

// Vessel type translations
const VESSEL_TYPE_NAMES = {
  'all': { en: 'All vessels', ru: 'Все суда' },
  'CARGO': { en: 'Cargo', ru: 'Грузовое' },
  'FISHING': { en: 'Fishing', ru: 'Рыболовное' },
  'PASSENGER': { en: 'Passenger', ru: 'Пассажирское' },
  'CARRIER': { en: 'Carrier', ru: 'Танкер' },
  'BUNKER': { en: 'Bunker', ru: 'Бункеровщик' },
  'SEISMIC_VESSEL': { en: 'Seismic', ru: 'Сейсморазведка' },
  'OTHER': { en: 'Other', ru: 'Другое' },
  'GEAR': { en: 'Gear', ru: 'Снаряжение' }
}

// Store all crossings for filtering
let allCrossings = null

// Categories - populated from vessel types in data
async function loadCategories() {
  // Start with "all" option
  categories = [{ id: 'all', name_en: 'All vessels', name_ru: 'Все суда' }]

  // Add vessel types from the data (using stored crossings)
  if (allCrossings?.features) {
    const types = new Set()
    allCrossings.features.forEach(f => {
      if (f.properties?.vessel_type) {
        types.add(f.properties.vessel_type)
      }
    })

    // Sort and add to categories
    Array.from(types).sort().forEach(type => {
      const names = VESSEL_TYPE_NAMES[type] || { en: type, ru: type }
      categories.push({
        id: type,
        name_en: names.en,
        name_ru: names.ru
      })
    })
  }

  populateCategoryDropdown()
}

function populateCategoryDropdown() {
  const select = document.getElementById('category-select')
  const lang = getLang()
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

  // Filter crossings by vessel type
  if (allCrossings && map.getSource('vessel-crossings')) {
    if (categoryId === 'all') {
      map.getSource('vessel-crossings').setData(allCrossings)
    } else {
      const filtered = {
        type: 'FeatureCollection',
        features: allCrossings.features.filter(f =>
          f.properties?.vessel_type === categoryId
        )
      }
      map.getSource('vessel-crossings').setData(filtered)
    }
  }
}

// Places
async function loadPlacesDropdown() {
  try {
    const response = await fetch(basePath + 'data/places/places.json')
    const data = await response.json()
    placesData = data.places
    if (placesData.length > 0) {
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
  const lang = getLang()
  select.innerHTML = `<option value="">${t('selectPlace')}</option>`
  placesData.forEach((place, index) => {
    const option = document.createElement('option')
    option.value = index
    option.textContent = lang === 'ru' ? place.name_ru : place.name_en
    select.appendChild(option)
  })
}

function showPlace(index) {
  const place = placesData[index]
  const infoEl = document.getElementById('places-info')

  if (!place) {
    infoEl.classList.add('hidden')
    return
  }

  const description = getLang() === 'ru' ? place.description_ru : place.description_en
  infoEl.innerHTML = `<span>${description}</span>`
  infoEl.classList.remove('hidden')
  map.flyTo({ center: place.center, zoom: place.zoom, duration: 2000 })
}

// Event listeners
document.getElementById('lang-toggle').addEventListener('click', () => {
  const newLang = toggleLang()
  document.getElementById('lang-toggle').textContent = newLang === 'ru' ? 'en' : 'ру'
  updateUI()
})

document.getElementById('about-modal').addEventListener('click', () => {
  document.getElementById('about-modal').classList.add('hidden')
})

document.getElementById('category-select').addEventListener('change', (e) => {
  selectCategory(e.target.value)
})

document.getElementById('places-select').addEventListener('change', (e) => {
  const value = e.target.value
  if (value === '') {
    document.getElementById('places-info').classList.add('hidden')
    return
  }
  showPlace(parseInt(value))
})

// Initialize year legend before attaching event listeners
initYearLegend()

// Now attach event listeners (year toggles now exist)
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

window.addEventListener('resize', updateUI)
updateUI()
