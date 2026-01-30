/**
 * Vessel Activity Viewer
 * Interactive map of vessel presence using Cloud-Optimized GeoTIFFs
 */

import './style.css'
import { initI18n, t, tVesselType, getLang, toggleLang, localize } from './i18n.js'
import { RASTER_TOOLTIP_MIN_ZOOM, MANIFEST_URL, createMapStyle, getYearColor } from './config.js'

// Lazy-loaded modules
let maplibregl, cogModule, dataModule

// App state
let manifest, map
let currentCategory = 'all'
let currentFlagFilter = 'all'
let categories = []
let cogUrls = {}
let flagCogUrls = {}
let activeYears = new Set()
let knownYears = []
let satelliteVisible = false
let dataInitialized = false
let sanctionedMmsi = new Set()
let vesselMeta = {}
let showSanctionedOnly = false
let lastTooltipVesselsRaw = null

// COG tile cache
const cogTileCache = new Map()
let activeYearBands = []

// DOM refs
const $ = id => document.getElementById(id)
const tooltip = $('tooltip')
const controlsEl = $('controls')

// --- Progress ---

const PROGRESS_WIDTH = 20
function updateProgress(percent) {
  const filled = Math.round((percent / 100) * PROGRESS_WIDTH)
  const bar = '#'.repeat(filled) + '.'.repeat(PROGRESS_WIDTH - filled)
  const el = $('about-progress')
  if (el) el.textContent = `loading [${bar}] ${percent}%`
}

// --- Tooltip ---

function showTooltip(html) {
  tooltip.style.top = (controlsEl.getBoundingClientRect().bottom + 8) + 'px'
  tooltip.innerHTML = html
  tooltip.classList.add('visible')
}

function hideTooltip() {
  tooltip.classList.remove('visible')
  lastTooltipVesselsRaw = null
}

// --- Utilities ---

function rafThrottle(fn) {
  let pending = null, rafId = null
  return (...args) => {
    pending = args
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (pending) { fn(...pending); pending = null }
      })
    }
  }
}

function resolveUrl(url, base) {
  return url.startsWith('http') ? url : base + url
}

// --- Manifest UI ---

function applyManifestUI() {
  const ui = manifest.ui || {}
  if (ui.title) document.title = ui.title

  // Globe favicon
  const link = document.createElement('link')
  link.rel = 'icon'
  link.href = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='30' fill='%23000'/><g fill='%23fff'><ellipse cx='32' cy='20' rx='12' ry='8' transform='rotate(-20 32 20)'/><ellipse cx='18' cy='32' rx='8' ry='14' transform='rotate(30 18 32)'/><ellipse cx='46' cy='28' rx='7' ry='10' transform='rotate(-40 46 28)'/><ellipse cx='32' cy='44' rx='10' ry='6' transform='rotate(10 32 44)'/><circle cx='32' cy='10' r='6'/></g><circle cx='32' cy='32' r='30' fill='none' stroke='%23333' stroke-width='1'/></svg>`)}`
  document.head.appendChild(link)

  const theme = ui.theme || {}
  const root = document.documentElement
  const props = { background: '--ui-background', text: '--ui-color', textMuted: '--ui-color-muted', panelBg: '--ui-bg', panelHover: '--ui-bg-hover' }
  for (const [key, prop] of Object.entries(props)) {
    if (theme[key]) root.style.setProperty(prop, theme[key])
  }
  if (theme.panelBorder) root.style.setProperty('--ui-border', `1px solid ${theme.panelBorder}`)
}

// --- About modal ---

function renderAboutModal() {
  if (!manifest?.about) return
  $('about-title').textContent = localize(manifest.about.title)
  let html = localize(manifest.about.description).split('\n\n').map(p => `<p>${p}</p>`).join('')
  if (manifest.about.dataCredits) {
    html += `<p class="about-credits">${localize(manifest.about.dataCredits)}</p>`
  }
  $('about-description').innerHTML = html
}

// --- UI updates ---

let wasNarrow = window.innerWidth <= 768

function updateUI() {
  const narrow = window.innerWidth <= 768

  renderAboutModal()
  if (manifest?.about) $('about-continue').textContent = t('continue')

  $('legend-multi-year').textContent = t(narrow ? 'multiYearShort' : 'multiYear')
  $('legend-section-vessel').textContent = t(narrow ? 'sectionVesselShort' : 'sectionVessel')
  $('legend-section-layers').textContent = t(narrow ? 'sectionLayersShort' : 'sectionLayers')

  // Layer toggle labels
  ;(manifest.ui?.layerToggles || []).forEach((toggle, i) => {
    const el = $(`legend-layer-${i}`)
    if (el) el.textContent = localize(narrow && toggle.labelShort ? toggle.labelShort : toggle.label)
  })

  // Sanctions label
  $('sanctions-label').textContent = t(narrow ? 'sanctionedShort' : 'sanctioned')

  // Legend collapse label
  $('legend-collapse-label').textContent = t('legend')

  // Force legend open only when transitioning from narrow to wide
  if (!narrow && wasNarrow) $('legend').classList.remove('collapsed')
  wasNarrow = narrow

  // Data credits section
  $('legend-section-data').textContent = t(narrow ? 'sectionDataShort' : 'sectionData')
  const dataEl = $('legend-data')
  if (dataEl) {
    const links = manifest.ui?.sourceLinks || (manifest.ui?.sourceLink ? [manifest.ui.sourceLink] : [])
    dataEl.innerHTML = links.filter(l => l.url).map(l => {
      const label = localize(narrow && l.labelShort ? l.labelShort : l.label)
      const logo = l.logo || ''
      return `<div class="legend-data-item"><a href="${l.url}" target="_blank" rel="noopener"><div class="legend-data-logo">${logo}</div><span class="legend-text">${label}</span></a></div>`
    }).join('')
  }

  // Dropdowns
  if (manifest?.places?.length > 0) {
    const select = $('places-select')
    const val = select.value
    populatePlacesDropdown()
    select.value = val
    if (val !== '') {
      const place = manifest.places[parseInt(val)]
      if (place) $('places-info').innerHTML = `<span>${localize(place.description)}</span>`
    }
  }
  if (categories.length > 0) populateCategoryDropdown()
  populateFlagDropdown()
  $('sanctions-label').textContent = t(window.innerWidth <= 768 ? 'sanctionedShort' : 'sanctioned')
}

// --- Legend ---

function initYearLegend(years) {
  const container = $('legend-years')
  container.innerHTML = ''
  ;[...years].sort((a, b) => b - a).forEach(year => {
    const color = getYearColor(years.indexOf(year))
    const item = document.createElement('div')
    item.className = 'legend-item legend-toggle active'
    item.dataset.year = year
    item.innerHTML = `<div class="legend-symbol"><div class="legend-square" style="background:${color}"></div></div><span class="legend-text">${year}</span>`
    container.appendChild(item)
    item.addEventListener('click', () => {
      toggleYear(parseInt(item.dataset.year))
      item.classList.toggle('active', activeYears.has(parseInt(item.dataset.year)))
    })
  })
}

function initLayerToggles() {
  const container = $('legend-layers')
  container.innerHTML = ''
  ;(manifest.ui?.layerToggles || []).forEach((toggle, i) => {
    const item = document.createElement('div')
    item.className = `legend-item legend-toggle ${toggle.defaultVisible !== false ? 'active' : ''}`
    item.dataset.layers = toggle.layers.join(',')
    item.innerHTML = `<div class="legend-symbol"><div class="legend-${toggle.symbol || 'square'}"></div></div><span id="legend-layer-${i}" class="legend-text">${localize(toggle.label)}</span>`
    container.appendChild(item)
    item.addEventListener('click', () => {
      const layerIds = item.dataset.layers.split(',')
      const first = layerIds.find(id => map.getLayer(id))
      if (!first) return
      const visible = map.getLayoutProperty(first, 'visibility') !== 'none'
      layerIds.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'none' : 'visible') })
      item.classList.toggle('active')
      if (toggle.isSatellite) {
        satelliteVisible = !visible
        refreshHeatmapTiles()
      }
      // Force re-render — needed for fill-pattern layers with globe projection
      map.triggerRepaint()
    })
  })
}

function updateMultiYearLegend() {
  document.querySelector('.legend-multi-year')?.classList.toggle('disabled', activeYears.size < 2)
}

function updateMapLabels() {
  if (!map?.getLayer('place-labels')) return
  const lang = getLang()
  map.setLayoutProperty('place-labels', 'text-field', ['coalesce', ['get', `name_${lang}`], ['get', 'name_en']])
}

// --- Hatch patterns ---

function createHatchPattern(color, size = 6) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, size); ctx.lineTo(size, 0)
  ctx.moveTo(-size, size); ctx.lineTo(size, -size)
  ctx.moveTo(0, size * 2); ctx.lineTo(size * 2, 0)
  ctx.stroke()
  return ctx.getImageData(0, 0, size, size)
}

const hatchPatterns = Object.fromEntries(
  ['white', 'blue'].flatMap(c => ['sm', 'md', 'lg'].map((s, i) =>
    [`hatch-${c === 'white' ? 'white' : 'blue'}-${s}`, () => createHatchPattern(c === 'white' ? '#ffffff' : '#037874', [6, 10, 16][i])]
  ))
)

// --- Heatmap & year controls ---

function refreshHeatmapTiles() {
  cogTileCache.clear()
  cogModule?.clearCache()
  map.getSource('vessel-heatmap')?.setTiles([`cog://{z}/{x}/{y}?t=${Date.now()}`])
}

function updateHeatmapSource() {
  activeYearBands = Array.from(activeYears).sort().map(y => knownYears.indexOf(y)).filter(i => i >= 0)
  map.setLayoutProperty('vessel-heatmap', 'visibility', 'visible')
  refreshHeatmapTiles()
}

function toggleYear(year) {
  activeYears.has(year) ? activeYears.delete(year) : activeYears.add(year)
  updateHeatmapSource()
  updateMultiYearLegend()
  updateSanctionsFilter()
}

// --- Categories ---

function loadCategories() {
  categories = [{ id: 'all', label: t('allVessels') }]
  for (const type of Object.keys(manifest?.data?.cogsByType || {}).sort()) {
    categories.push({ id: type, label: tVesselType(type) })
  }
  populateCategoryDropdown()
}

function populateCategoryDropdown() {
  const select = $('category-select')
  if (categories.length <= 1) { select.classList.add('hidden'); return }
  select.classList.remove('hidden')
  select.innerHTML = categories.map(c => `<option value="${c.id}">${c.label}</option>`).join('')
  select.value = currentCategory
}

// --- Flag filter ---

const FLAG_PRESETS = [
  { id: 'all', labelKey: 'allFlags' },
  { id: 'foreign', labelKey: 'foreignFlag' },
  { id: 'RUS' }, { id: 'NOR' }, { id: 'PAN' }, { id: 'LBR' },
  { id: 'MHL' }, { id: 'MLT' }, { id: 'CHN' }, { id: 'GBR' },
]

function populateFlagDropdown() {
  const select = $('flag-select')
  select.classList.remove('hidden')
  select.innerHTML = FLAG_PRESETS.map(p =>
    `<option value="${p.id}">${p.labelKey ? t(p.labelKey) : p.id}</option>`
  ).join('')
  select.value = currentFlagFilter
}

// --- Sanctions ---

function updateSanctionsFilter() {
  const toggle = $('sanctions-toggle')
  const hasYears = activeYears.size > 0
  const canUse = hasYears

  if (!canUse) {
    toggle.classList.add('disabled')
    if (showSanctionedOnly) {
      showSanctionedOnly = false
      toggle.classList.remove('active')
      setSanctionsVisibility(false)
    }
  } else {
    toggle.classList.remove('disabled')
  }

  if (!map) return

  // Year filter
  const yearFilter = hasYears
    ? ['any', ...Array.from(activeYears).map(y => ['has', `y${y}`])]
    : ['literal', false]

  // Combine with vessel type and flag filters
  const conditions = [yearFilter]

  if (currentCategory !== 'all') {
    conditions.push(['has', `t_${currentCategory}`])
  }

  if (currentFlagFilter === 'foreign') {
    conditions.push(['has', 'f_foreign'])
  } else if (currentFlagFilter !== 'all') {
    conditions.push(['has', `f_${currentFlagFilter}`])
  }

  const filter = conditions.length === 1 ? conditions[0] : ['all', ...conditions]

  for (const id of ['sanctioned-vessels-fill', 'sanctioned-vessels-outline']) {
    if (map.getLayer(id)) map.setFilter(id, filter)
  }
}

function setSanctionsVisibility(visible) {
  for (const id of ['sanctioned-vessels-fill', 'sanctioned-vessels-outline']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
  }
}

async function loadSanctions(manifestDir) {
  const url = manifest?.data?.sanctionedMmsi
  if (!url) return
  try {
    const resp = await fetch(resolveUrl(url, manifestDir))
    if (!resp.ok) return
    sanctionedMmsi = new Set(await resp.json())
    console.log(`Loaded ${sanctionedMmsi.size} sanctioned MMSIs`)
    $('sanctions-toggle').classList.remove('hidden')
    $('sanctions-label').textContent = t(window.innerWidth <= 768 ? 'sanctionedShort' : 'sanctioned')
    updateSanctionsFilter()
  } catch (err) {
    console.warn('Failed to load sanctions data:', err)
  }
}

async function loadVesselMetadata(manifestDir) {
  const url = manifest?.data?.vesselMetadata
  if (!url) return
  try {
    const resp = await fetch(resolveUrl(url, manifestDir))
    if (!resp.ok) return
    vesselMeta = await resp.json()
    console.log(`Loaded metadata for ${Object.keys(vesselMeta).length} vessels`)
  } catch (err) {
    console.warn('Failed to load vessel metadata:', err)
  }
}

// --- COG switching ---

function getActiveCogUrl() {
  if (currentFlagFilter !== 'all' && flagCogUrls[currentFlagFilter]) return flagCogUrls[currentFlagFilter]
  return cogUrls[currentCategory] || cogUrls.all
}

async function switchActiveCOG() {
  const url = getActiveCogUrl()
  if (!url || !cogModule) return
  try {
    await cogModule.switchCOG(url)
    refreshHeatmapTiles()
  } catch (err) {
    console.warn('Failed to switch COG:', err)
  }
}

async function selectCategory(categoryId) {
  if (categoryId === currentCategory) return
  const prev = currentCategory
  currentCategory = categoryId
  try { await switchActiveCOG() } catch (err) {
    console.error('Failed to switch COG:', err)
    currentCategory = prev
    $('category-select').value = prev
  }
}

// --- Places ---

function populatePlacesDropdown() {
  const select = $('places-select')
  const places = manifest?.places || []
  if (!places.length) { select.classList.add('hidden'); return }
  select.classList.remove('hidden')
  select.innerHTML = `<option value="">${t('selectPlace')}</option>` +
    places.map((p, i) => `<option value="${i}">${localize(p.name)}</option>`).join('')
}

function showPlace(index) {
  const place = manifest?.places?.[index]
  const el = $('places-info')
  if (!place) { el.classList.add('hidden'); return }
  el.innerHTML = `<span>${localize(place.description)}</span>`
  el.classList.remove('hidden')
  map.flyTo({ center: place.center, zoom: place.zoom, duration: 2000 })
}

// --- Tooltips ---

function formatDateShort(isoString) {
  if (!isoString) return '?'
  const d = new Date(isoString)
  return `${d.getDate()} ${d.toLocaleString(getLang() === 'ru' ? 'ru' : 'en', { month: 'short' })} ${String(d.getFullYear()).slice(-2)}`
}

function yearsFromMask(mask) {
  const years = []
  for (let i = 0; i < 8; i++) {
    if (mask & (1 << i)) years.push(2020 + i)
  }
  return years.join(', ') || '?'
}

function filterVesselsByFlags(vessels) {
  if (currentFlagFilter === 'all') return vessels
  let filtered = vessels
  if (currentFlagFilter === 'foreign') filtered = filtered.filter(v => v.flag && v.flag !== 'RUS')
  else if (currentFlagFilter !== 'all') filtered = filtered.filter(v => v.flag === currentFlagFilter)
  return filtered
}

function showRasterTooltip(vessels, isRefilter = false) {
  if (!isRefilter) lastTooltipVesselsRaw = vessels
  if (!vessels?.length) { hideTooltip(); return false }

  const filtered = filterVesselsByFlags(vessels)
  if (!filtered.length) { hideTooltip(); return false }

  // Group by MMSI
  const byMmsi = new Map()
  for (const v of filtered) {
    const key = v.mmsi || v.ship_name || 'unknown'
    if (!byMmsi.has(key)) {
      byMmsi.set(key, { mmsi: v.mmsi, ship_name: v.ship_name, vessel_type: v.vessel_type, flag: v.flag, total_hours: 0, dates: [], sanctioned: sanctionedMmsi.has(v.mmsi) })
    }
    const entry = byMmsi.get(key)
    entry.total_hours += v.total_hours || 0
    const dateStr = v.last_seen ? formatDateShort(v.last_seen) : yearsFromMask(v.year_mask)
    if (!entry.dates.includes(dateStr)) entry.dates.push(dateStr)
  }

  const grouped = Array.from(byMmsi.values())
  // Prioritize sanctioned vessels for display
  grouped.sort((a, b) => (b.sanctioned ? 1 : 0) - (a.sanctioned ? 1 : 0))
  const w = window.innerWidth
  const maxDisplay = w >= 1000 ? 8 : w >= 768 ? 4 : 3
  const display = grouped.slice(0, maxDisplay)
  const totalCount = filtered[0]?.cell_count || grouped.length
  const more = totalCount > maxDisplay ? totalCount - maxDisplay : 0

  const rows = [
    { key: t('vessel'), values: display.map(v => v.ship_name || t('unknown')) },
    { key: t('mmsi'), values: display.map(v => v.mmsi) },
    { key: t('type'), values: display.map(v => tVesselType(v.vessel_type)) },
    { key: t('flag'), values: display.map(v => v.flag || '?') },
    { key: t('hours'), values: display.map(v => Math.round(v.total_hours) + t('hoursShort')) },
    { key: t('date'), values: display.map(v => v.dates.join('<br>')) }
  ]

  // Enriched metadata
  if (display.some(v => vesselMeta[v.mmsi])) {
    const years = display.map(v => vesselMeta[v.mmsi]?.y || '–')
    if (years.some(y => y !== '–')) rows.push({ key: t('buildYear'), values: years })
    const dwts = display.map(v => { const d = vesselMeta[v.mmsi]?.d; return d ? d.toLocaleString() + ' t' : '–' })
    if (dwts.some(d => d !== '–')) rows.push({ key: t('dwt'), values: dwts })
  }

  // Sanctions badge
  if (display.some(v => v.sanctioned)) {
    rows.push({ key: t('status'), values: display.map(v =>
      v.sanctioned ? `<span class="sanction-badge">${t('sanctioned')}</span>` : '–'
    )})
  }

  let html = '<table>' + rows.map(r =>
    `<tr><td>${r.key}</td>${r.values.map(v => `<td>${v}</td>`).join('')}</tr>`
  ).join('') + '</table>'
  if (more > 0) html += `<div style="padding-top:8px;color:var(--ui-color-muted)">+${more} ${t('more')}</div>`
  showTooltip(html)
  return true
}

function showProtectedAreaTooltip(feature, isBuffer = false) {
  const p = feature.properties || {}
  const lang = getLang()
  const name = p[`name_${lang}`] || p.name_en || p.name_ru || p.name || t('protectedArea')
  const category = p[`category_${lang}`] || p.category_en || p.category
  const status = p[`status_${lang}`] || p.status_en || p.status
  const rows = [{ key: isBuffer ? t('bufferZone') : t('protectedArea'), value: name }]
  if (category) rows.push({ key: t('category'), value: category })
  if (p.significance) rows.push({ key: t('significance'), value: p.significance })
  if (p.area_ha) rows.push({ key: t('area'), value: `${Math.round(p.area_ha / 100).toLocaleString()} km²` })
  if (status) rows.push({ key: t('status'), value: status })
  showTooltip('<table>' + rows.map(r => `<tr><td>${r.key}</td><td>${r.value}</td></tr>`).join('') + '</table>')
}

// --- Initialization ---

async function initPhase1() {
  const resp = await fetch(MANIFEST_URL)
  if (!resp.ok) throw new Error(`Failed to load manifest: ${resp.status}`)
  manifest = await resp.json()

  const manifestDir = MANIFEST_URL.substring(0, MANIFEST_URL.lastIndexOf('/') + 1) || './'

  await initI18n(manifest, manifestDir)
  $('lang-toggle').textContent = getLang() === 'ru' ? 'en' : 'ру'
  applyManifestUI()
  renderAboutModal()
  document.body.classList.add('about-visible')

  return manifestDir
}

async function initPhase2(manifestDir) {
  updateProgress(10)

  const [maplibreModule, cog, data] = await Promise.all([
    import('maplibre-gl'),
    import('./cog.js'),
    import('./data.js')
  ])
  maplibregl = maplibreModule.default
  cogModule = cog
  dataModule = data
  updateProgress(40)

  // Build COG URL maps
  const baseCogUrl = resolveUrl(manifest.data?.cog || 'vessel_heatmap.tif', manifestDir)
  cogUrls = { all: baseCogUrl }
  for (const [k, v] of Object.entries(manifest.data?.cogsByType || {})) cogUrls[k] = resolveUrl(v, manifestDir)
  flagCogUrls = { all: baseCogUrl }
  for (const [k, v] of Object.entries(manifest.data?.cogsByFlag || {})) flagCogUrls[k] = resolveUrl(v, manifestDir)

  // Initialize COG
  const cogConfig = await cogModule.initCOG(baseCogUrl)
  knownYears = cogConfig.years
  activeYears = new Set(knownYears)
  activeYearBands = knownYears.map((_, i) => i)
  updateProgress(60)

  await dataModule.initData(manifestDir, manifest)
  updateProgress(80)

  // COG tile protocol
  maplibregl.addProtocol('cog', async (params) => {
    const m = params.url.match(/cog:\/\/(\d+)\/(\d+)\/(\d+)/)
    if (!m) throw new Error('Invalid COG tile URL')
    const [, z, x, y] = m.map(Number)
    const key = `${z}/${x}/${y}/${activeYearBands}/${satelliteVisible}`
    if (cogTileCache.has(key)) return { data: cogTileCache.get(key) }
    const buf = await cogModule.renderTile(z, x, y, activeYearBands, !satelliteVisible)
    cogTileCache.set(key, buf)
    return { data: buf }
  })

  // Create map
  const mc = manifest.map || {}
  map = new maplibregl.Map({
    container: 'map',
    attributionControl: false,
    style: createMapStyle(manifest, manifestDir),
    center: mc.center || [0, 0],
    zoom: mc.zoom || 2,
    pitch: mc.pitch || 0,
    bearing: mc.bearing || 0,
    maxZoom: mc.maxZoom || 18,
    minZoom: mc.minZoom || 0,
    minPitch: 0,
    maxPitch: 30,
    renderWorldCopies: false,
    localFontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  })

  // Zoom controls
  const zc = document.createElement('div')
  zc.id = 'zoom-controls'
  for (const [id, label, action] of [['zoom-in', '+', () => map.zoomIn()], ['zoom-out', '−', () => map.zoomOut()]]) {
    const btn = document.createElement('button')
    btn.id = id
    btn.textContent = label
    btn.addEventListener('click', action)
    zc.appendChild(btn)
  }
  document.body.appendChild(zc)

  setupMapHandlers()
  setupUIHandlers()
  initYearLegend(knownYears)
  initLayerToggles()
  updateMultiYearLegend()
  populatePlacesDropdown()
  populateFlagDropdown()
  loadCategories()
  updateUI()

  document.body.classList.add('app-ready')

  // Non-blocking loads
  loadSanctions(manifestDir)
  loadVesselMetadata(manifestDir)
}

// --- Map handlers ---

function setupMapHandlers() {
  map.on('styleimagemissing', e => {
    if (hatchPatterns[e.id]) map.addImage(e.id, hatchPatterns[e.id](), { pixelRatio: 1 })
  })

  map.on('load', () => {
    map.triggerRepaint()
    dataInitialized = true
    updateMapLabels()
    updateProgress(100)
    $('map').classList.add('ready')
    document.body.classList.add('map-ready')
  })

  // Vessel tooltips on hover — vessel data takes priority over protected areas
  let lastQueryCell = null
  const handleRasterHover = rafThrottle(async (e) => {
    if (!dataInitialized) return
    if (map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) return

    const { lat, lng } = e.lngLat
    const year = activeYears.size === 1 ? Array.from(activeYears)[0] : null
    const cellKey = `${Math.floor(lat * 100)}_${Math.floor(lng * 100)}_${year}_${currentCategory}_${currentFlagFilter}`
    if (cellKey === lastQueryCell) return
    lastQueryCell = cellKey

    try {
      const vesselType = currentCategory === 'all' ? null : currentCategory
      const vessels = await dataModule.queryVesselsAt(lat, lng, year, vesselType)
      if (vessels?.length && showRasterTooltip(vessels)) return
    } catch { /* ignore */ }

    // No vessel data — fall back to protected area tooltip
    const paLayers = ['protected-areas-fill', 'buffer-zones-fill'].filter(id => map.getLayer(id))
    if (paLayers.length) {
      const features = map.queryRenderedFeatures(e.point, { layers: paLayers })
      if (features?.length) {
        showProtectedAreaTooltip(features[0], features[0].layer?.id === 'buffer-zones-fill')
        return
      }
    }
    hideTooltip()
  })

  map.on('mousemove', (e) => {
    if (map.getZoom() >= RASTER_TOOLTIP_MIN_ZOOM) {
      handleRasterHover(e)
      return
    }
    // Below vessel tooltip zoom — only show protected area tooltips
    const paLayers = ['protected-areas-fill', 'buffer-zones-fill'].filter(id => map.getLayer(id))
    if (paLayers.length) {
      const features = map.queryRenderedFeatures(e.point, { layers: paLayers })
      if (features?.length) {
        showProtectedAreaTooltip(features[0], features[0].layer?.id === 'buffer-zones-fill')
        return
      }
    }
    hideTooltip()
  })

  map.on('mouseout', hideTooltip)

  map.on('click', async (e) => {
    if (!dataInitialized || map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) return
    const { lat, lng } = e.lngLat
    const year = activeYears.size === 1 ? Array.from(activeYears)[0] : null
    try {
      showRasterTooltip(await dataModule.queryVesselsAt(lat, lng, year, currentCategory === 'all' ? null : currentCategory))
    } catch { /* ignore */ }
  })

  map.on('zoom', () => { if (map.getZoom() < RASTER_TOOLTIP_MIN_ZOOM) hideTooltip() })
}

// --- UI handlers ---

function setupUIHandlers() {
  $('lang-toggle').addEventListener('click', async () => {
    const lang = await toggleLang()
    $('lang-toggle').textContent = lang === 'ru' ? 'en' : 'ру'
    updateUI()
    updateMapLabels()
    loadCategories()
  })

  $('about-modal').addEventListener('click', () => document.body.classList.remove('about-visible'))

  $('category-select').addEventListener('change', e => {
    selectCategory(e.target.value)
    updateSanctionsFilter()
  })

  $('flag-select').addEventListener('change', async (e) => {
    currentFlagFilter = e.target.value
    await switchActiveCOG()
    updateSanctionsFilter()
    if (lastTooltipVesselsRaw) showRasterTooltip(lastTooltipVesselsRaw, true)
  })

  $('sanctions-toggle').addEventListener('click', () => {
    if ($('sanctions-toggle').classList.contains('disabled')) return
    showSanctionedOnly = !showSanctionedOnly
    $('sanctions-toggle').classList.toggle('active', showSanctionedOnly)
    setSanctionsVisibility(showSanctionedOnly)
  })

  $('places-select').addEventListener('change', (e) => {
    if (e.target.value === '') { $('places-info').classList.add('hidden'); return }
    showPlace(parseInt(e.target.value))
  })

  $('legend-collapse').addEventListener('click', () => {
    $('legend').classList.toggle('collapsed')
  })

  window.addEventListener('resize', updateUI)

  // Debug perf overlay (press 'p')
  let perfVisible = false
  document.addEventListener('keydown', (e) => {
    if (e.key === 'p' && !e.ctrlKey && !e.metaKey) {
      perfVisible = !perfVisible
      $('perf-overlay').classList.toggle('hidden', !perfVisible)
    }
  })
  setInterval(() => {
    if (!perfVisible || !map) return
    const z = map.getZoom().toFixed(1)
    const c = map.getCenter()
    $('perf-overlay').innerHTML = `z${z} | ${c.lat.toFixed(2)},${c.lng.toFixed(2)} | tiles:${cogTileCache.size}`
  }, 500)
}

// --- Start ---

(async () => {
  try {
    const manifestDir = await initPhase1()
    await initPhase2(manifestDir)
  } catch (err) {
    console.error('Failed to initialize:', err)
    document.body.innerHTML = `<div style="padding:2rem;color:#fff;background:#1a1a1a;min-height:100vh"><h1>Failed to load</h1><p>${err.message}</p></div>`
  }
})()
