/**
 * Vessel Activity Viewer
 * Interactive map of vessel presence using Cloud-Optimized GeoTIFFs
 */

import './style.css'
import { initI18n, t, tVesselType, getLang, toggleLang, localize } from './i18n.js'
import {
  DEBUG_MODE,
  RASTER_TOOLTIP_MIN_ZOOM,
  MANIFEST_URL,
  createMapStyle,
  getYearColor
} from './config.js'

// Lazy-loaded modules
let maplibregl = null
let cogModule = null
let dataModule = null

// App state
let manifest = null
let map = null

// Map state
let currentCategory = 'all'
let categories = []
let cogUrls = {}
let activeYears = new Set()
let knownYears = []
let satelliteVisible = false
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

function showTooltip(html) {
  const rect = controlsEl.getBoundingClientRect()
  tooltip.style.top = (rect.bottom + 8) + 'px'
  tooltip.innerHTML = html
  tooltip.classList.add('visible')
}

function hideTooltip() {
  tooltip.classList.remove('visible')
}

/**
 * RAF-based throttle - coalesces calls to next animation frame
 */
function rafThrottle(fn) {
  let pending = null
  let rafId = null

  return (...args) => {
    pending = args
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (pending) {
          fn(...pending)
          pending = null
        }
      })
    }
  }
}

function applyManifestUI(manifest) {
  const ui = manifest.ui || {}
  if (ui.title) document.title = ui.title
  if (ui.favicon) {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.href = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><circle cx='5' cy='5' r='4' fill='${ui.favicon}'/></svg>`
    document.head.appendChild(link)
  }
  const theme = ui.theme || {}
  const root = document.documentElement
  if (theme.background) root.style.setProperty('--ui-background', theme.background)
  if (theme.text) root.style.setProperty('--ui-color', theme.text)
  if (theme.textMuted) root.style.setProperty('--ui-color-muted', theme.textMuted)
  if (theme.panelBg) root.style.setProperty('--ui-bg', theme.panelBg)
  if (theme.panelBorder) root.style.setProperty('--ui-border', `1px solid ${theme.panelBorder}`)
  if (theme.panelHover) root.style.setProperty('--ui-bg-hover', theme.panelHover)
}

// ============================================================================
// UI Functions
// ============================================================================

function updateUI() {
  const isNarrow = window.innerWidth <= 768

  // About modal
  if (manifest?.about) {
    document.getElementById('about-title').textContent = localize(manifest.about.title)
    document.getElementById('about-description').textContent = localize(manifest.about.description)
    document.getElementById('about-continue').textContent = t('continue')
  }

  // Legend labels
  document.getElementById('legend-multi-year').textContent = t(isNarrow ? 'multiYearShort' : 'multiYear')
  document.getElementById('legend-section-vessel').textContent = t(isNarrow ? 'sectionVesselShort' : 'sectionVessel')
  document.getElementById('legend-section-layers').textContent = t(isNarrow ? 'sectionLayersShort' : 'sectionLayers')

  // Layer toggle labels from manifest
  const layerToggles = manifest.ui?.layerToggles || []
  layerToggles.forEach((toggle, i) => {
    const el = document.getElementById(`legend-layer-${i}`)
    if (el) el.textContent = localize(isNarrow && toggle.labelShort ? toggle.labelShort : toggle.label)
  })

  // Data source
  const sourceEl = document.getElementById('legend-source')
  if (sourceEl && manifest.ui?.sourceLink) {
    const link = manifest.ui.sourceLink
    sourceEl.innerHTML = `data: <a href="${link.url}" target="_blank" rel="noopener">${localize(isNarrow && link.labelShort ? link.labelShort : link.label)}</a>`
  }

  // Update dropdowns
  if (manifest?.places?.length > 0) {
    const select = document.getElementById('places-select')
    const selectedValue = select.value
    populatePlacesDropdown()
    select.value = selectedValue
    if (selectedValue !== '') {
      const place = manifest.places[parseInt(selectedValue)]
      if (place) {
        document.getElementById('places-info').innerHTML = `<span>${localize(place.description)}</span>`
      }
    }
  }

  if (categories.length > 0) populateCategoryDropdown()
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

function initLayerToggles() {
  const container = document.getElementById('legend-layers')
  container.innerHTML = ''

  const layerToggles = manifest.ui?.layerToggles || []
  layerToggles.forEach((toggle, i) => {
    const item = document.createElement('div')
    item.className = `legend-item legend-toggle ${toggle.defaultVisible !== false ? 'active' : ''}`
    item.dataset.layers = toggle.layers.join(',')
    item.innerHTML = `
      <div class="legend-symbol">
        <div class="legend-${toggle.symbol || 'square'}"></div>
      </div>
      <span id="legend-layer-${i}" class="legend-text">${localize(toggle.label)}</span>
    `
    container.appendChild(item)
    item.addEventListener('click', () => {
      const layerIds = item.dataset.layers.split(',')
      const firstLayer = layerIds.find(id => map.getLayer(id))
      if (!firstLayer) return

      const isVisible = map.getLayoutProperty(firstLayer, 'visibility') !== 'none'
      layerIds.forEach(id => {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, 'visibility', isVisible ? 'none' : 'visible')
        }
      })
      item.classList.toggle('active')

      // Handle satellite mode for COG rendering
      if (toggle.isSatellite) {
        satelliteVisible = !isVisible
        cogTileCache.clear()
        cogModule?.clearCache()
        map.getSource('vessel-heatmap')?.setTiles([`cog://{z}/{x}/{y}?t=${Date.now()}`])
      }
    })
  })
}

function updateMultiYearLegend() {
  const multiYearItem = document.querySelector('.legend-multi-year')
  if (multiYearItem) multiYearItem.classList.toggle('disabled', activeYears.size < 2)
}

function updateMapLabels() {
  if (!map || !map.getLayer('place-labels')) return
  const lang = getLang()
  map.setLayoutProperty('place-labels', 'text-field', [
    'coalesce',
    ['get', `name_${lang}`],
    ['get', 'name_en']
  ])
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
  'hatch-white-md': () => createHatchPattern('#ffffff', 10),
  'hatch-white-lg': () => createHatchPattern('#ffffff', 16)
}

// ============================================================================
// Layer Controls
// ============================================================================

function updateHeatmapSource() {
  const years = Array.from(activeYears).sort()
  activeYearBands = years.map(y => knownYears.indexOf(y)).filter(i => i >= 0)
  map.setLayoutProperty('vessel-heatmap', 'visibility', 'visible')
  cogTileCache.clear()
  cogModule?.clearCache()
  map.getSource('vessel-heatmap')?.setTiles([`cog://{z}/{x}/{y}?t=${Date.now()}`])
}

function toggleYear(year) {
  activeYears.has(year) ? activeYears.delete(year) : activeYears.add(year)
  updateHeatmapSource()
  updateMultiYearLegend()
}

// ============================================================================
// Categories (Vessel Type Filter)
// ============================================================================

function loadCategories() {
  categories = [{ id: 'all', label: t('allVessels') }]
  const cogsByType = manifest?.data?.cogsByType || {}
  Object.keys(cogsByType).sort().forEach(type => {
    categories.push({ id: type, label: tVesselType(type) })
  })
  populateCategoryDropdown()
}

function populateCategoryDropdown() {
  const select = document.getElementById('category-select')
  if (categories.length <= 1) {
    select.classList.add('hidden')
    return
  }
  select.classList.remove('hidden')
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
  const cogUrl = cogUrls[categoryId]
  if (!cogUrl) return

  try {
    await cogModule.switchCOG(cogUrl)
    cogTileCache.clear()
    map.getSource('vessel-heatmap')?.setTiles([`cog://{z}/{x}/{y}?t=${Date.now()}`])
  } catch (err) {
    console.error(`Failed to switch COG:`, err)
    currentCategory = previousCategory
    document.getElementById('category-select').value = previousCategory
  }
}

// ============================================================================
// Places
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

  // Group entries by mmsi to consolidate multiple dates for same vessel
  const byMmsi = new Map()
  for (const v of vessels) {
    const key = v.mmsi || v.ship_name || 'unknown'
    if (!byMmsi.has(key)) {
      byMmsi.set(key, {
        mmsi: v.mmsi,
        ship_name: v.ship_name,
        vessel_type: v.vessel_type,
        flag: v.flag,
        total_hours: 0,
        dates: []
      })
    }
    const entry = byMmsi.get(key)
    entry.total_hours += v.total_hours || 0
    const dateStr = v.last_seen ? formatDateShort(v.last_seen) : v.year
    if (!entry.dates.includes(dateStr)) {
      entry.dates.push(dateStr)
    }
  }

  const grouped = Array.from(byMmsi.values())
  const displayVessels = grouped.slice(0, 3)
  const totalCount = vessels[0]?.cell_count || grouped.length
  const moreCount = totalCount > 3 ? totalCount - 3 : 0

  const rows = [
    { key: t('vessel'), values: displayVessels.map(v => v.ship_name || t('unknown')) },
    { key: t('mmsi'), values: displayVessels.map(v => v.mmsi) },
    { key: t('type'), values: displayVessels.map(v => tVesselType(v.vessel_type)) },
    { key: t('flag'), values: displayVessels.map(v => v.flag || '?') },
    { key: t('hours'), values: displayVessels.map(v => Math.round(v.total_hours) + t('hoursShort')) },
    { key: t('date'), values: displayVessels.map(v => v.dates.join('<br>')) }
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

/**
 * Phase 1: Load manifest and show about modal immediately
 * This runs before any heavy libraries are loaded
 */
async function initPhase1() {
  // Load manifest (tiny JSON file)
  const resp = await fetch(MANIFEST_URL)
  if (!resp.ok) throw new Error(`Failed to load manifest: ${resp.status}`)
  manifest = await resp.json()

  // Determine base URL for data files
  const manifestDir = MANIFEST_URL.substring(0, MANIFEST_URL.lastIndexOf('/') + 1) || './'

  // Initialize i18n (small module, already imported)
  await initI18n(manifest, manifestDir)
  document.getElementById('lang-toggle').textContent = getLang() === 'ru' ? 'en' : 'ру'

  // Apply UI theme immediately
  applyManifestUI(manifest)

  // Show about modal content immediately
  if (manifest?.about) {
    document.getElementById('about-title').textContent = localize(manifest.about.title)
    document.getElementById('about-description').textContent = localize(manifest.about.description)
    document.getElementById('about-continue').textContent = t('continue')
  }

  // Show the about modal now (before map loads)
  document.body.classList.add('about-visible')

  return manifestDir
}

/**
 * Phase 2: Load heavy libraries and initialize map (runs in background)
 */
async function initPhase2(manifestDir) {
  // Lazy-load MapLibre GL and COG module in parallel
  const [maplibreModule, cog, data] = await Promise.all([
    import('maplibre-gl'),
    import('./cog.js'),
    import('./data.js')
  ])

  maplibregl = maplibreModule.default
  cogModule = cog
  dataModule = data

  // Build COG URLs
  const cogUrl = manifest.data?.cog?.startsWith('http')
    ? manifest.data.cog
    : manifestDir + (manifest.data?.cog || 'vessel_heatmap.tif')

  cogUrls = { all: cogUrl }
  const cogsByType = manifest.data?.cogsByType || {}
  for (const [type, url] of Object.entries(cogsByType)) {
    cogUrls[type] = url.startsWith('http') ? url : manifestDir + url
  }

  // Initialize COG
  const cogConfig = await cogModule.initCOG(cogUrl)
  knownYears = cogConfig.years
  activeYears = new Set(knownYears)
  activeYearBands = knownYears.map((_, idx) => idx)

  // Initialize data layer (PMTiles protocol + vessel tooltips)
  await dataModule.initData(manifestDir, manifest)

  // Register COG tile protocol
  maplibregl.addProtocol('cog', async (params) => {
    const match = params.url.match(/cog:\/\/(\d+)\/(\d+)\/(\d+)/)
    if (!match) throw new Error('Invalid COG tile URL')
    const [, z, x, y] = match.map(Number)
    const cacheKey = `${z}/${x}/${y}/${activeYearBands.join(',')}/${satelliteVisible}`
    if (cogTileCache.has(cacheKey)) return { data: cogTileCache.get(cacheKey) }
    const buffer = await cogModule.renderTile(z, x, y, activeYearBands, !satelliteVisible)
    cogTileCache.set(cacheKey, buffer)
    return { data: buffer }
  })

  // Create map
  const mapConfig = manifest.map || {}
  map = window.map = new maplibregl.Map({
    container: 'map',
    attributionControl: false,
    style: createMapStyle(manifest),
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

  // Set up handlers
  setupMapHandlers()
  setupUIHandlers()

  // Initial UI
  initYearLegend(knownYears)
  initLayerToggles()
  updateMultiYearLegend()
  populatePlacesDropdown()
  loadCategories()
  updateUI()

  // Show full UI now that map is ready
  document.body.classList.add('app-ready')
}

async function init() {
  const manifestDir = await initPhase1()
  await initPhase2(manifestDir)
}

function setupMapHandlers() {
  map.on('styleimagemissing', (e) => {
    if (hatchPatterns[e.id]) map.addImage(e.id, hatchPatterns[e.id](), { pixelRatio: 1 })
  })

  map.on('load', () => {
    map.triggerRepaint()
    dataInitialized = true
    updateMapLabels()
    document.getElementById('map').classList.add('ready')
    document.body.classList.add('map-ready')
  })

  // Vessel tooltips
  let lastQueryCell = null
  const handleRasterHover = rafThrottle(async (e) => {
    if (!dataInitialized || map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) return

    const { lat, lng } = e.lngLat
    const year = activeYears.size === 1 ? Array.from(activeYears)[0] : null
    const cellLat = Math.floor(lat * 100) / 100
    const cellLon = Math.floor(lng * 100) / 100
    const cellKey = `${cellLat}_${cellLon}_${year}_${currentCategory}`

    if (cellKey === lastQueryCell) return
    lastQueryCell = cellKey

    if (DEBUG_MODE) {
      const cogBBox = getCOGBBox()
      const pixelSize = getCOGPixelSize()
      if (cogBBox && pixelSize) {
        const [cogMinLon, , cogMaxLon, cogMaxLat] = cogBBox
        const [pixelW, pixelH] = pixelSize
        const col = Math.floor((lng - cogMinLon) / pixelW)
        const row = Math.floor((cogMaxLat - lat) / pixelH)
        const pixelMinLon = cogMinLon + col * pixelW
        const pixelMaxLon = pixelMinLon + pixelW
        const pixelMaxLat = cogMaxLat - row * pixelH
        const pixelMinLat = pixelMaxLat - pixelH
        map.getSource('debug-tooltip-targets')?.setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [pixelMinLon, pixelMinLat], [pixelMaxLon, pixelMinLat],
                [pixelMaxLon, pixelMaxLat], [pixelMinLon, pixelMaxLat],
                [pixelMinLon, pixelMinLat]
              ]]
            }
          }]
        })
      }
    }

    try {
      const vesselType = currentCategory === 'all' ? null : currentCategory
      const vessels = await dataModule.queryVesselsAt(lat, lng, year, vesselType)
      showRasterTooltip(vessels)
    } catch (err) { /* ignore */ }
  }, 16)

  map.on('mousemove', (e) => {
    if (map.getZoom() >= RASTER_TOOLTIP_MIN_ZOOM) handleRasterHover(e)
  })
  map.on('mouseout', hideTooltip)
  map.on('click', async (e) => {
    if (!dataInitialized || map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) return
    const { lat, lng } = e.lngLat
    const year = activeYears.size === 1 ? Array.from(activeYears)[0] : null
    const vesselType = currentCategory === 'all' ? null : currentCategory
    try {
      const vessels = await dataModule.queryVesselsAt(lat, lng, year, vesselType)
      showRasterTooltip(vessels)
    } catch (err) { /* ignore */ }
  })
  map.on('zoom', () => {
    if (map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) hideTooltip()
  })
}

function setupUIHandlers() {
  document.getElementById('lang-toggle').addEventListener('click', async () => {
    const newLang = await toggleLang()
    document.getElementById('lang-toggle').textContent = newLang === 'ru' ? 'en' : 'ру'
    updateUI()
    updateMapLabels()
    loadCategories()
  })

  document.getElementById('about-modal').addEventListener('click', () => {
    document.body.classList.remove('about-visible')
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

  window.addEventListener('resize', updateUI)

  // Performance overlay (press 'p' to toggle)
  const perfOverlay = document.getElementById('perf-overlay')
  let perfVisible = false
  document.addEventListener('keydown', (e) => {
    if (e.key === 'p' && !e.ctrlKey && !e.metaKey) {
      perfVisible = !perfVisible
      perfOverlay.classList.toggle('hidden', !perfVisible)
    }
  })

  setInterval(() => {
    if (!perfVisible || !map) return
    const zoom = map.getZoom().toFixed(1)
    const center = map.getCenter()
    perfOverlay.innerHTML = `z${zoom} | ${center.lat.toFixed(2)},${center.lng.toFixed(2)} | tiles:${cogTileCache.size}`
  }, 500)
}

// ============================================================================
// Start
// ============================================================================

init().catch(err => {
  console.error('Failed to initialize:', err)
  document.body.innerHTML = `
    <div style="padding: 2rem; color: #fff; background: #1a1a1a; min-height: 100vh;">
      <h1>Failed to load</h1>
      <p>${err.message}</p>
    </div>
  `
})
