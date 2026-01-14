/**
 * Vessel Activity Viewer - Main Application
 * Generic viewer that loads all configuration from manifest.json
 */

import './style.css'
import maplibregl from 'maplibre-gl'
import { initI18n, t, tVesselType, getLang, toggleLang, localize } from './i18n.js'
import { initCOG, renderTile, clearCache as clearCOGCache } from './cog-tiles.js'
import { initDB, loadProtectedAreas, loadVesselCrossings, loadPlaces, queryVesselsAt, loadTooltipTargetsInBounds } from './data-layer.js'
import {
  DEBUG_MODE,
  RASTER_TOOLTIP_MIN_ZOOM,
  MANIFEST_URL,
  PROTECTED_AREA_LAYERS,
  createMapStyle,
  getYearColor,
  createYearColorExpression
} from './config.js'

// App state
let manifest = null
let dataUrl = ''
let map = null

// Map state
let currentCategory = 'all'
let categories = []
let activeYears = new Set()
let knownYears = []
let satelliteMode = false
let hoveringCrossing = false
let dataInitialized = false
let allCrossings = null

// COG tile cache
const cogTileCache = new Map()
let activeYearBands = []

// DOM elements
const tooltip = document.getElementById('tooltip')
const controlsEl = document.getElementById('controls')

// ============================================================================
// Utility Functions
// ============================================================================

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

function formatDate(isoString) {
  const date = new Date(isoString)
  const day = date.getDate()
  const month = date.toLocaleString(getLang() === 'ru' ? 'ru' : 'en', { month: 'short' })
  const year = date.getFullYear()
  return `${day} ${month} ${year}`
}

function debounce(fn, delay) {
  let timeoutId
  return (...args) => {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn(...args), delay)
  }
}

// ============================================================================
// UI Functions
// ============================================================================

function updateUI() {
  const isNarrow = window.innerWidth <= 600
  const lang = getLang()

  // About modal
  if (manifest?.about) {
    document.getElementById('about-title').textContent = localize(manifest.about.title)
    document.getElementById('about-description').textContent = localize(manifest.about.description)
  }

  // Legend labels
  document.getElementById('legend-protected').textContent = t(isNarrow ? 'protectedAreasShort' : 'protectedAreas')
  document.getElementById('legend-crossings').textContent = t(isNarrow ? 'vesselCrossingsShort' : 'vesselCrossings')
  document.getElementById('legend-satellite').textContent = t(isNarrow ? 'satelliteShort' : 'satellite')
  document.getElementById('legend-source').textContent = t(isNarrow ? 'dataSourceShort' : 'dataSource')
  document.getElementById('legend-multi-year').textContent = t(isNarrow ? 'multiYearShort' : 'multiYear')
  document.getElementById('legend-section-vessel').textContent = t('sectionVessel')
  document.getElementById('legend-section-layers').textContent = t('sectionLayers')

  // Update place labels language if map is loaded
  if (map && map.getLayer('place-labels')) {
    const nameField = lang === 'ru' ? 'name_ru' : 'name_en'
    map.setLayoutProperty('place-labels', 'text-field',
      ['coalesce', ['get', nameField], ['get', lang === 'ru' ? 'name_en' : 'name_ru']]
    )
  }

  // Update dropdowns
  if (manifest?.places?.length > 0) {
    const select = document.getElementById('places-select')
    const selectedValue = select.value
    populatePlacesDropdown()
    select.value = selectedValue
  }

  if (categories.length > 0) {
    populateCategoryDropdown()
  }
}

function initYearLegend(years) {
  const container = document.getElementById('legend-years')
  container.innerHTML = ''

  const sortedYears = [...years].sort((a, b) => b - a)
  sortedYears.forEach((year) => {
    const bandIndex = years.indexOf(year)
    const color = getYearColor(bandIndex)
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

    item.addEventListener('click', () => {
      toggleYear(parseInt(item.dataset.year))
      item.classList.toggle('active', activeYears.has(parseInt(item.dataset.year)))
    })
  })
}

function updateMultiYearLegend() {
  const multiYearItem = document.querySelector('.legend-multi-year')
  if (multiYearItem) {
    multiYearItem.classList.toggle('disabled', activeYears.size < 2)
  }
}

// ============================================================================
// Hatch Patterns
// ============================================================================

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

// ============================================================================
// Layer Controls
// ============================================================================

function updateHeatmapSource() {
  const years = Array.from(activeYears).sort()
  map.setLayoutProperty('vessel-heatmap', 'visibility', 'visible')
  activeYearBands = years.map(y => knownYears.indexOf(y)).filter(i => i >= 0)

  cogTileCache.clear()
  clearCOGCache()

  const source = map.getSource('vessel-heatmap')
  if (source) {
    source.setTiles([`cog://{z}/{x}/{y}?t=${Date.now()}`])
  }
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
    cogTileCache.clear()
    clearCOGCache()
    const source = map.getSource('vessel-heatmap')
    if (source) {
      source.setTiles([`cog://{z}/{x}/{y}?t=${Date.now()}`])
    }
  }
}

// ============================================================================
// Categories (Vessel Type Filter)
// ============================================================================

function loadCategories() {
  categories = [{ id: 'all', label: t('allVessels') }]

  if (allCrossings?.features) {
    const types = new Set()
    allCrossings.features.forEach(f => {
      if (f.properties?.vessel_type) {
        types.add(f.properties.vessel_type)
      }
    })

    Array.from(types).sort().forEach(type => {
      categories.push({ id: type, label: tVesselType(type) })
    })
  }

  populateCategoryDropdown()
}

function populateCategoryDropdown() {
  const select = document.getElementById('category-select')
  select.innerHTML = ''
  categories.forEach(cat => {
    const option = document.createElement('option')
    option.value = cat.id
    option.textContent = cat.label
    select.appendChild(option)
  })
  select.value = currentCategory
}

function selectCategory(categoryId) {
  currentCategory = categoryId

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

// ============================================================================
// Places (Points of Interest)
// ============================================================================

function populatePlacesDropdown() {
  const select = document.getElementById('places-select')
  const places = manifest?.places || []

  if (places.length === 0) {
    select.classList.add('hidden')
    return
  }

  select.classList.remove('hidden')
  select.innerHTML = `<option value="">${t('selectPlace')}</option>`
  places.forEach((place, index) => {
    const option = document.createElement('option')
    option.value = index
    option.textContent = localize(place.name)
    select.appendChild(option)
  })
}

function showPlace(index) {
  const place = manifest?.places?.[index]
  const infoEl = document.getElementById('places-info')

  if (!place) {
    infoEl.classList.add('hidden')
    return
  }

  infoEl.innerHTML = `<span>${localize(place.description)}</span>`
  infoEl.classList.remove('hidden')
  map.flyTo({ center: place.center, zoom: place.zoom, duration: 2000 })
}

// ============================================================================
// Tooltips
// ============================================================================

function showRasterTooltip(vessels) {
  if (!vessels || vessels.length === 0) {
    hideTooltip()
    return
  }

  const displayVessels = vessels.slice(0, 5)
  const totalCount = vessels[0]?.cell_count || vessels.length
  const moreCount = totalCount > 5 ? totalCount - 5 : 0

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

// ============================================================================
// Application Initialization
// ============================================================================

async function init() {
  // 1. Load manifest
  console.log('Loading manifest from:', MANIFEST_URL)
  const manifestResponse = await fetch(MANIFEST_URL)
  if (!manifestResponse.ok) {
    throw new Error(`Failed to load manifest: ${manifestResponse.status}`)
  }
  manifest = await manifestResponse.json()
  console.log('Manifest loaded:', manifest.region?.id)

  // Determine data URL (relative to manifest or absolute)
  const manifestDir = MANIFEST_URL.substring(0, MANIFEST_URL.lastIndexOf('/') + 1)
  dataUrl = manifestDir

  // 2. Initialize i18n
  await initI18n(manifest, dataUrl)

  // 3. Build COG URL from manifest
  const cogFile = manifest.data?.cog || 'vessel_heatmap.tif'
  const cogUrl = cogFile.startsWith('http') ? cogFile : dataUrl + cogFile

  // 4. Initialize COG and get metadata
  const cogConfig = await initCOG(cogUrl)
  knownYears = cogConfig.years
  activeYears = new Set(knownYears)
  activeYearBands = knownYears.map((_, idx) => idx)
  console.log('COG config:', cogConfig)

  // 5. Register COG tile protocol
  maplibregl.addProtocol('cog', async (params) => {
    const match = params.url.match(/cog:\/\/(\d+)\/(\d+)\/(\d+)/)
    if (!match) throw new Error('Invalid COG tile URL')

    const [, z, x, y] = match.map(Number)
    const cacheKey = `${z}/${x}/${y}/${activeYearBands.join(',')}/${satelliteMode}`

    if (cogTileCache.has(cacheKey)) {
      return { data: cogTileCache.get(cacheKey) }
    }

    const buffer = await renderTile(z, x, y, activeYearBands, !satelliteMode)
    cogTileCache.set(cacheKey, buffer)
    return { data: buffer }
  })

  // 6. Initialize map with manifest config
  const mapConfig = manifest.map || {}
  map = window.map = new maplibregl.Map({
    container: 'map',
    attributionControl: false,
    style: createMapStyle(manifest, dataUrl),
    center: mapConfig.center || [0, 0],
    zoom: mapConfig.zoom || 2,
    pitch: mapConfig.pitch || 0,
    bearing: mapConfig.bearing || 0,
    maxZoom: mapConfig.maxZoom || 18,
    minZoom: mapConfig.minZoom || 0,
    minPitch: 0,
    maxPitch: 30,
    renderWorldCopies: false,
    localFontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  })

  // 7. Set up map event handlers
  setupMapHandlers(cogConfig)

  // 8. Set up UI event handlers
  setupUIHandlers()

  // 9. Initial UI update
  updateUI()
  initYearLegend(knownYears)
  updateMultiYearLegend()
  populatePlacesDropdown()

}

function setupMapHandlers(cogConfig) {
  // Hatch pattern handler
  map.on('styleimagemissing', (e) => {
    if (hatchPatterns[e.id]) {
      map.addImage(e.id, hatchPatterns[e.id](), { pixelRatio: 1 })
    }
  })

  // Map load handler
  map.on('load', async () => {
    // Update crossings layer colors
    if (cogConfig?.years) {
      map.setPaintProperty('crossings', 'circle-stroke-color', createYearColorExpression(cogConfig.years))
    }

    map.triggerRepaint()

    // Load vector data in background
    try {
      await initDB(dataUrl, manifest)

      const [protectedAreas, crossings, places] = await Promise.all([
        loadProtectedAreas(),
        loadVesselCrossings(),
        loadPlaces()
      ])

      allCrossings = crossings

      map.getSource('protected-areas').setData(protectedAreas)
      map.getSource('vessel-crossings').setData(crossings)
      map.getSource('places').setData(places)

      dataInitialized = true
      loadCategories()
    } catch (err) {
      console.error('Failed to load vector data:', err)
    }
  })

  // Map movement handler (constrain to region bounds)
  const bounds = manifest.map?.bounds || {}
  const centerLat = manifest.map?.center?.[1] || 0
  const minLatZoomedOut = bounds.south || -90
  const minLatZoomedIn = Math.max(bounds.south - 10, -90)

  map.on('moveend', async () => {
    const center = map.getCenter()
    const zoom = map.getZoom()
    const minLat = zoom > 4 ? minLatZoomedIn : minLatZoomedOut

    if (center.lat < minLat) {
      map.panTo([center.lng, centerLat])
    }

    // Debug tooltip targets
    if (DEBUG_MODE && dataInitialized && zoom >= 5) {
      const mapBounds = map.getBounds()
      try {
        const targets = await loadTooltipTargetsInBounds(
          mapBounds.getSouth(),
          mapBounds.getNorth(),
          mapBounds.getWest(),
          mapBounds.getEast()
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

  // Raster hover tooltip
  const handleRasterHover = debounce(async (e) => {
    if (!dataInitialized || map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) return

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
}

function setupUIHandlers() {
  // Language toggle
  document.getElementById('lang-toggle').addEventListener('click', async () => {
    const newLang = await toggleLang()
    document.getElementById('lang-toggle').textContent = newLang === 'ru' ? 'en' : 'ру'
    updateUI()
    loadCategories()  // Refresh category labels
  })

  // About modal
  document.getElementById('about-modal').addEventListener('click', () => {
    document.getElementById('about-modal').classList.add('hidden')
  })

  // Category filter
  document.getElementById('category-select').addEventListener('change', (e) => {
    selectCategory(e.target.value)
  })

  // Places dropdown
  document.getElementById('places-select').addEventListener('change', (e) => {
    const value = e.target.value
    if (value === '') {
      document.getElementById('places-info').classList.add('hidden')
      return
    }
    showPlace(parseInt(value))
  })

  // Layer toggles
  document.querySelectorAll('.legend-toggle[data-layer]').forEach(item => {
    item.addEventListener('click', () => {
      const layer = item.dataset.layer
      if (layer) {
        toggleLayer(layer)
        item.classList.toggle('active')
      }
    })
  })

  // Window resize
  window.addEventListener('resize', updateUI)
}

// ============================================================================
// Start the application
// ============================================================================

init().catch(err => {
  console.error('Failed to initialize app:', err)
  document.body.innerHTML = `
    <div style="padding: 2rem; color: #fff; background: #1a1a1a; min-height: 100vh;">
      <h1>Failed to load</h1>
      <p>${err.message}</p>
      <p>Check the console for details.</p>
    </div>
  `
})
