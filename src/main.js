import './style.css'
import maplibregl from 'maplibre-gl'
import * as pmtiles from 'pmtiles'
import { t, tVesselType, getLang, setLang, toggleLang } from './i18n.js'
import {
  YEAR_COLORS,
  ARCTIC_CENTER_LAT,
  ARCTIC_MIN_LAT_ZOOMED_OUT,
  ARCTIC_MIN_LAT_ZOOMED_IN,
  RASTER_TOOLTIP_MIN_ZOOM,
  TILE_VERSION,
  basePath,
  PROTECTED_AREA_LAYERS,
  createMapStyle
} from './config.js'

// State
let currentCategory = 'all'
let categories = []
let places = []
const activeYears = new Set([2023, 2024, 2025])
let satelliteMode = false
let hoveringCrossing = false

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
  document.getElementById('about-title').textContent = t('aboutTitle')
  document.getElementById('about-text').textContent = t('aboutText')

  // Update place labels language if map is loaded
  if (typeof map !== 'undefined' && map.getLayer('place-labels')) {
    const nameField = lang === 'ru' ? 'name_ru' : 'name_en'
    map.setLayoutProperty('place-labels', 'text-field',
      ['coalesce', ['get', nameField], ['get', lang === 'ru' ? 'name_en' : 'name_ru']]
    )
  }

  // Update dropdowns
  if (places.length > 0) {
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

// Register PMTiles protocol
const protocol = new pmtiles.Protocol()
maplibregl.addProtocol('pmtiles', protocol.tile)

// Initialize map
const map = new maplibregl.Map({
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
  renderWorldCopies: false
})

// Map event handlers
map.on('styleimagemissing', (e) => {
  if (hatchPatterns[e.id]) {
    map.addImage(e.id, hatchPatterns[e.id](), { pixelRatio: 1 })
  }
})

map.on('load', () => {
  loadCategories()
  loadPlaces()
})

map.on('moveend', () => {
  const center = map.getCenter()
  const zoom = map.getZoom()
  const minLat = zoom > 4 ? ARCTIC_MIN_LAT_ZOOMED_IN : ARCTIC_MIN_LAT_ZOOMED_OUT
  if (center.lat < minLat) {
    map.panTo([center.lng, ARCTIC_CENTER_LAT])
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

// Raster vessel tooltip
async function fetchVesselsAtLocation(lat, lon) {
  try {
    const yearsParam = activeYears.size === 1 ? `&year=${Array.from(activeYears)[0]}` : ''
    const response = await fetch(`${basePath}api/vessels?lat=${lat}&lon=${lon}${yearsParam}`)
    if (!response.ok) return null
    const data = await response.json()
    return data.vessels || []
  } catch (err) {
    console.warn('Vessel query failed:', err)
    return null
  }
}

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
  const { lat, lng } = e.lngLat
  const vessels = await fetchVesselsAtLocation(lat, lng)
  showRasterTooltip(vessels)
}, 150)

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
  const landColor = satelliteMode ? 'white' : 'black'
  map.setPaintProperty('protected-areas-on-land-sm', 'fill-pattern', `hatch-${landColor}-sm`)
  map.setPaintProperty('protected-areas-on-land-md', 'fill-pattern', `hatch-${landColor}-md`)
  map.setPaintProperty('protected-areas-on-land-lg', 'fill-pattern', `hatch-${landColor}-lg`)
  map.setPaintProperty('protected-areas-on-land-border', 'line-color', satelliteMode ? '#ffffff' : '#000000')
}

function updateHeatmapSource() {
  const years = Array.from(activeYears).sort()

  if (years.length === 0) {
    map.setLayoutProperty('vessel-heatmap', 'visibility', 'none')
    return
  }

  map.setLayoutProperty('vessel-heatmap', 'visibility', 'visible')

  const yearList = Object.keys(YEAR_COLORS).map(Number).sort()
  const bandIndices = years.map(y => yearList.indexOf(y)).filter(i => i >= 0)
  const yearsParam = bandIndices.length < 3 ? `&years=${bandIndices.join(',')}` : ''
  const categoryParam = currentCategory !== 'all' ? `&category=${currentCategory}` : ''
  const newTileUrl = basePath + `tiles/{z}/{x}/{y}.png?v=${TILE_VERSION}${yearsParam}${categoryParam}`

  const source = map.getSource('vessel-heatmap')
  if (source) {
    source.setTiles([newTileUrl])
    const sourceCache = map.style?.sourceCaches?.['vessel-heatmap']
    if (sourceCache) sourceCache.clearTiles()
    map.triggerRepaint()
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
  }
}

// Categories
async function loadCategories() {
  try {
    const response = await fetch(basePath + 'api/categories')
    const data = await response.json()
    categories = data.categories || []
    if (categories.length > 0) populateCategoryDropdown()
  } catch (err) {
    console.warn('Could not load categories:', err)
  }
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
  updateHeatmapSource()
}

// Places
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
  const lang = getLang()
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

// Initialize
initYearLegend()
updateUI()
