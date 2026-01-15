/**
 * Vessel Activity Viewer - Main Application
 * Generic viewer that loads all configuration from manifest.json
 */

import './style.css'
import maplibregl from 'maplibre-gl'
import { initI18n, t, tVesselType, getLang, toggleLang, localize } from './i18n.js'
import { initCOG, renderTile, clearCache as clearCOGCache, getCOGBBox, getCOGPixelSize, switchCOG } from './cog-tiles.js'
import { initDB, loadProtectedAreas, loadPlaces, queryVesselsAt } from './data-layer.js'
import {
  DEBUG_MODE,
  RASTER_TOOLTIP_MIN_ZOOM,
  MANIFEST_URL,
  PROTECTED_AREA_LAYERS,
  createMapStyle,
  getYearColor
} from './config.js'

// App state
let manifest = null
let dataUrl = ''
let map = null

// Map state
let currentCategory = 'all'
let categories = []
let cogUrls = {}  // { 'all': url, 'FISHING': url, ... }
let activeYears = new Set()
let knownYears = []
let satelliteMode = false
let dataInitialized = false

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

/**
 * Apply UI settings from manifest (title, favicon, theme)
 */
function applyManifestUI(manifest) {
  const ui = manifest.ui || {}

  // Set page title
  if (ui.title) {
    document.title = ui.title
  }

  // Set favicon
  if (ui.favicon) {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.href = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><circle cx='5' cy='5' r='4' fill='${ui.favicon}'/></svg>`
    document.head.appendChild(link)
  }

  // Apply theme as CSS custom properties
  const theme = ui.theme || {}
  const root = document.documentElement
  if (theme.background) root.style.setProperty('--ui-background', theme.background)
  if (theme.text) root.style.setProperty('--ui-color', theme.text)
  if (theme.textMuted) root.style.setProperty('--ui-color-muted', theme.textMuted)
  if (theme.panelBg) root.style.setProperty('--ui-bg', theme.panelBg)
  if (theme.panelBorder) root.style.setProperty('--ui-border', `1px solid ${theme.panelBorder}`)
  if (theme.panelHover) root.style.setProperty('--ui-bg-hover', theme.panelHover)
}

/**
 * Throttle with leading edge - fires immediately on first call,
 * then ignores calls until delay passes, then fires trailing call if any
 */
function throttle(fn, delay) {
  let lastCall = 0
  let pendingArgs = null
  let timeoutId = null

  return (...args) => {
    const now = Date.now()

    if (now - lastCall >= delay) {
      // Enough time passed, fire immediately
      lastCall = now
      fn(...args)
    } else {
      // Too soon, queue for later
      pendingArgs = args
      if (!timeoutId) {
        timeoutId = setTimeout(() => {
          lastCall = Date.now()
          timeoutId = null
          if (pendingArgs) {
            fn(...pendingArgs)
            pendingArgs = null
          }
        }, delay - (now - lastCall))
      }
    }
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

  // Legend labels (use short versions on narrow screens)
  document.getElementById('legend-protected').textContent = t(isNarrow ? 'protectedAreasShort' : 'protectedAreas')
  document.getElementById('legend-satellite').textContent = t(isNarrow ? 'satelliteShort' : 'satellite')
  document.getElementById('legend-multi-year').textContent = t(isNarrow ? 'multiYearShort' : 'multiYear')
  document.getElementById('legend-section-vessel').textContent = t(isNarrow ? 'sectionVesselShort' : 'sectionVessel')
  document.getElementById('legend-section-layers').textContent = t(isNarrow ? 'sectionLayersShort' : 'sectionLayers')

  // Data source with link
  const sourceText = t(isNarrow ? 'dataSourceShort' : 'dataSource')
  const gfwLink = '<a href="https://globalfishingwatch.org/" target="_blank" rel="noopener">Global Fishing Watch</a>'
  const gfwLinkShort = '<a href="https://globalfishingwatch.org/" target="_blank" rel="noopener">GFW</a>'
  document.getElementById('legend-source').innerHTML = sourceText.replace('Global Fishing Watch', gfwLink).replace('GFW', gfwLinkShort)

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

    // Update place description if one is selected
    if (selectedValue !== '') {
      const place = manifest.places[parseInt(selectedValue)]
      if (place) {
        document.getElementById('places-info').innerHTML = `<span>${localize(place.description)}</span>`
      }
    }
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

  // Get vessel types from manifest's cogsByType (these have COGs available)
  const cogsByType = manifest?.data?.cogsByType || {}
  Object.keys(cogsByType).sort().forEach(type => {
    categories.push({ id: type, label: tVesselType(type) })
  })

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

async function selectCategory(categoryId) {
  if (categoryId === currentCategory) return

  const previousCategory = currentCategory
  currentCategory = categoryId

  // Switch to the appropriate COG for this vessel type
  const cogUrl = cogUrls[categoryId]
  if (!cogUrl) {
    console.warn(`No COG URL for category: ${categoryId}`)
    return
  }

  console.log(`Switching to COG: ${categoryId}`)

  try {
    // Switch COG source
    await switchCOG(cogUrl)

    // Clear tile cache and force reload
    cogTileCache.clear()
    const source = map.getSource('vessel-heatmap')
    if (source) {
      source.setTiles([`cog://{z}/{x}/{y}?t=${Date.now()}`])
    }
  } catch (err) {
    console.error(`Failed to switch to COG for ${categoryId}:`, err)
    // Revert to previous category
    currentCategory = previousCategory
    document.getElementById('category-select').value = previousCategory
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

function formatDateShort(isoString) {
  if (!isoString) return '?'
  const date = new Date(isoString)
  const day = date.getDate()
  const month = date.toLocaleString(getLang() === 'ru' ? 'ru' : 'en', { month: 'short' })
  const year = String(date.getFullYear()).slice(-2)
  return `${day} ${month} ${year}`
}

function showRasterTooltip(vessels) {
  if (!vessels || vessels.length === 0) {
    hideTooltip()
    return
  }

  const displayVessels = vessels.slice(0, 3)
  const totalCount = vessels[0]?.cell_count || vessels.length
  const moreCount = totalCount > 3 ? totalCount - 3 : 0

  const rows = [
    { key: t('vessel'), values: displayVessels.map(v => v.ship_name || t('unknown')) },
    { key: t('mmsi'), values: displayVessels.map(v => v.mmsi) },
    { key: t('type'), values: displayVessels.map(v => tVesselType(v.vessel_type)) },
    { key: t('flag'), values: displayVessels.map(v => v.flag || '?') },
    { key: t('hours'), values: displayVessels.map(v => Math.round(v.total_hours) + t('hoursShort')) },
    { key: t('date'), values: displayVessels.map(v => v.last_seen ? formatDateShort(v.last_seen) : v.year) }
  ]

  let html = '<table>'
  html += rows.map(row =>
    `<tr><td>${row.key}</td>${row.values.map(v => `<td>${v}</td>`).join('')}</tr>`
  ).join('')
  html += '</table>'

  if (moreCount > 0) {
    html += `<div style="padding-top: 8px; color: var(--ui-color-muted);">+${moreCount} ${t('more')}</div>`
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

  // Apply UI settings from manifest
  applyManifestUI(manifest)

  // Determine data URL (relative to manifest or absolute)
  const manifestDir = MANIFEST_URL.substring(0, MANIFEST_URL.lastIndexOf('/') + 1)
  dataUrl = manifestDir

  // 2. Initialize i18n
  await initI18n(manifest, dataUrl)

  // Set language toggle button to show the OTHER language (what you can switch to)
  document.getElementById('lang-toggle').textContent = getLang() === 'ru' ? 'en' : 'ру'

  // 3. Build COG URLs from manifest
  const cogFile = manifest.data?.cog || 'vessel_heatmap.tif'
  const cogUrl = cogFile.startsWith('http') ? cogFile : dataUrl + cogFile

  // Build COG URL map: 'all' + per-vessel-type
  cogUrls = { all: cogUrl }
  const cogsByType = manifest.data?.cogsByType || {}
  for (const [type, url] of Object.entries(cogsByType)) {
    cogUrls[type] = url.startsWith('http') ? url : dataUrl + url
  }
  console.log('COG URLs:', Object.keys(cogUrls))

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
  loadCategories()

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
    map.triggerRepaint()

    // Load vector data in background
    try {
      await initDB(dataUrl, manifest)

      const [protectedAreas, places] = await Promise.all([
        loadProtectedAreas(),
        loadPlaces()
      ])

      map.getSource('protected-areas').setData(protectedAreas)
      map.getSource('places').setData(places)

      dataInitialized = true

      // Fade in the map
      document.getElementById('map').classList.add('ready')
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

  })

  // Raster hover tooltip - use throttle for immediate response
  // Track last queried cell to avoid redundant queries
  let lastQueryCell = null

  const handleRasterHover = throttle(async (e) => {
    if (!dataInitialized || map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) return

    const { lat, lng } = e.lngLat
    const year = activeYears.size === 1 ? Array.from(activeYears)[0] : null

    // Calculate which grid cell this falls into (0.01° grid)
    const cellLat = Math.floor(lat * 100) / 100
    const cellLon = Math.floor(lng * 100) / 100
    const cellKey = `${cellLat}_${cellLon}_${year}_${currentCategory}`

    // Skip if we already queried this exact cell
    if (cellKey === lastQueryCell) return
    lastQueryCell = cellKey

    // Debug: show the actual COG pixel being rendered
    // COG is now in EPSG:4326 (geographic) with 0.01° pixels
    if (DEBUG_MODE) {
      const cogBBox = getCOGBBox()
      const pixelSize = getCOGPixelSize()
      if (cogBBox && pixelSize) {
        const [cogMinLon, cogMinLat, cogMaxLon, cogMaxLat] = cogBBox
        const [pixelW, pixelH] = pixelSize  // in degrees

        // Find which COG pixel this falls into
        const col = Math.floor((lng - cogMinLon) / pixelW)
        const row = Math.floor((cogMaxLat - lat) / pixelH)

        // Calculate pixel bounds in geographic coordinates
        const pixelMinLon = cogMinLon + col * pixelW
        const pixelMaxLon = pixelMinLon + pixelW
        const pixelMaxLat = cogMaxLat - row * pixelH
        const pixelMinLat = pixelMaxLat - pixelH

        const feature = {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [pixelMinLon, pixelMinLat],  // bottom-left
              [pixelMaxLon, pixelMinLat],  // bottom-right
              [pixelMaxLon, pixelMaxLat],  // top-right
              [pixelMinLon, pixelMaxLat],  // top-left
              [pixelMinLon, pixelMinLat]   // close polygon
            ]]
          }
        }
        map.getSource('debug-tooltip-targets').setData({
          type: 'FeatureCollection',
          features: [feature]
        })
      }
    }

    try {
      const vesselType = currentCategory === 'all' ? null : currentCategory
      const vessels = await queryVesselsAt(lat, lng, year, vesselType)
      showRasterTooltip(vessels)
    } catch (err) {
      // Silently fail tooltip queries
    }
  }, 16)  // ~60fps throttle - fires immediately, then rate-limits

  map.on('mousemove', (e) => {
    if (map.getZoom() >= RASTER_TOOLTIP_MIN_ZOOM) {
      handleRasterHover(e)
    }
  })

  map.on('mouseout', () => hideTooltip())

  // Touch support - tap to show tooltip
  map.on('click', async (e) => {
    if (!dataInitialized || map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) return

    const { lat, lng } = e.lngLat
    const year = activeYears.size === 1 ? Array.from(activeYears)[0] : null
    const vesselType = currentCategory === 'all' ? null : currentCategory

    try {
      const vessels = await queryVesselsAt(lat, lng, year, vesselType)
      showRasterTooltip(vessels)
    } catch (err) {
      // Silently fail
    }
  })

  map.on('zoom', () => {
    if (map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) {
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
