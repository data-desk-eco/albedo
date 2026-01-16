/**
 * MapLibre Custom Layer for direct COG rendering
 * Renders Cloud-Optimized GeoTIFFs directly into MapLibre's WebGL context
 * Zero intermediate formats - COG data goes straight to GPU
 */

import { fromUrl, Pool } from 'geotiff'
import { YEAR_PALETTE, MULTI_YEAR_COLOR } from './cog-tiles.js'
import { latToMercatorY, MERCATOR_EXTENT } from './geo.js'

// Performance tracking
let lastRenderTime = 0
let avgRenderTime = 0
let renderCount = 0
let lastLoadTime = 0

export function getPerformanceMetrics() {
  return {
    lastRenderMs: lastRenderTime,
    avgRenderMs: avgRenderTime,
    lastLoadMs: lastLoadTime,
    renderCount
  }
}

// Shader sources
const VERTEX_SHADER = `
attribute vec2 a_pos;
uniform mat4 u_matrix;
uniform vec4 u_bounds;  // [minX, minY, maxX, maxY] in Mercator
varying vec2 v_texCoord;
varying vec2 v_mapCoord;

void main() {
  // Map vertex position [0,1] to bounds
  vec2 mercator = mix(u_bounds.xy, u_bounds.zw, a_pos);
  gl_Position = u_matrix * vec4(mercator, 0.0, 1.0);
  v_texCoord = a_pos;
  v_mapCoord = mercator;
}
`

const FRAGMENT_SHADER = `
precision highp float;

varying vec2 v_texCoord;
varying vec2 v_mapCoord;

uniform sampler2D u_raster;
uniform int u_bandCount;
uniform int u_srcWidth;
uniform int u_srcHeight;
uniform int u_landBandIdx;
uniform int u_selectedBands[8];
uniform int u_selectedCount;
uniform vec3 u_palette[8];
uniform vec3 u_multiYearColor;
uniform bool u_showLand;

// COG bounds in Mercator
uniform vec2 u_cogMin;
uniform vec2 u_cogMax;

const float PI = 3.14159265359;
const float MERCATOR_EXTENT = 20037508.34;

float mercatorYToLat(float y) {
  return (atan(exp(y * PI / MERCATOR_EXTENT)) * 360.0 / PI) - 90.0;
}

// Sample a specific band at normalized coordinates
float sampleBand(int bandIdx, vec2 coord) {
  float bandOffset = float(bandIdx) / float(u_bandCount);
  float bandHeight = 1.0 / float(u_bandCount);
  vec2 texCoord = vec2(coord.x, bandOffset + coord.y * bandHeight);
  return texture2D(u_raster, texCoord).r;
}

void main() {
  // Convert Mercator coords to lat/lon for proper sampling
  float lon = v_mapCoord.x * 180.0 / MERCATOR_EXTENT;
  float lat = mercatorYToLat(v_mapCoord.y);

  // Map to COG texture coordinates (COG is in EPSG:4326)
  // COG coords: x = longitude, y = latitude (top = maxLat)
  float cogMinLon = u_cogMin.x * 180.0 / MERCATOR_EXTENT;
  float cogMaxLon = u_cogMax.x * 180.0 / MERCATOR_EXTENT;
  float cogMinLat = mercatorYToLat(u_cogMin.y);
  float cogMaxLat = mercatorYToLat(u_cogMax.y);

  float srcX = (lon - cogMinLon) / (cogMaxLon - cogMinLon);
  float srcY = (cogMaxLat - lat) / (cogMaxLat - cogMinLat);

  // Out of bounds = transparent
  if (srcX < 0.0 || srcX > 1.0 || srcY < 0.0 || srcY > 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 srcCoord = vec2(srcX, srcY);

  // Check land band
  float landValue = sampleBand(u_landBandIdx, srcCoord);
  if (landValue > 0.5) {
    if (u_showLand) {
      gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
    } else {
      gl_FragColor = vec4(0.0);
    }
    return;
  }

  // Sample selected bands and compute dominance
  float total = 0.0;
  float maxVal = 0.0;
  int maxIdx = 0;

  for (int i = 0; i < 8; i++) {
    if (i >= u_selectedCount) break;
    float value = sampleBand(u_selectedBands[i], srcCoord);
    total += value;
    if (value > maxVal) {
      maxVal = value;
      maxIdx = i;
    }
  }

  // No activity = transparent
  if (total < 0.001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Dominance coloring
  float proportion = maxVal / total;
  vec3 color = u_multiYearColor;

  if (proportion >= 0.6) {
    // Manual indexing (GLSL ES doesn't allow dynamic array access)
    int idx = 0;
    if (maxIdx == 0) idx = u_selectedBands[0];
    else if (maxIdx == 1) idx = u_selectedBands[1];
    else if (maxIdx == 2) idx = u_selectedBands[2];
    else if (maxIdx == 3) idx = u_selectedBands[3];
    else if (maxIdx == 4) idx = u_selectedBands[4];
    else if (maxIdx == 5) idx = u_selectedBands[5];
    else if (maxIdx == 6) idx = u_selectedBands[6];
    else idx = u_selectedBands[7];

    if (idx == 0) color = u_palette[0];
    else if (idx == 1) color = u_palette[1];
    else if (idx == 2) color = u_palette[2];
    else if (idx == 3) color = u_palette[3];
    else if (idx == 4) color = u_palette[4];
    else if (idx == 5) color = u_palette[5];
    else if (idx == 6) color = u_palette[6];
    else color = u_palette[7];
  }

  // Log brightness
  float brightness = min(1.0, max(0.7, log(1.0 + total) / log(51.0)));

  gl_FragColor = vec4(color * brightness, 1.0);
}
`

/**
 * Create a MapLibre custom layer for COG rendering
 */
export function createCOGLayer(id, cogUrl, options = {}) {
  let tiff = null
  let pool = null
  let cogBounds = null  // [minLon, minLat, maxLon, maxLat] in degrees
  let cogConfig = null
  let mainImage = null

  // WebGL state
  let program = null
  let buffer = null
  let texture = null
  let textureLoaded = false
  let uniforms = {}

  // Layer state
  let selectedBands = options.selectedBands || []
  let showLand = options.showLand !== false

  // Track current overview loaded
  let currentOverviewLevel = -1
  let loadingOverview = false

  // Texture dimensions (set by loadOverview, read by render)
  let textureBandCount = 0
  let textureSrcWidth = 0
  let textureSrcHeight = 0

  return {
    id,
    type: 'custom',

    // Layer configuration methods
    setSelectedBands(bands) {
      selectedBands = bands
    },

    setShowLand(show) {
      showLand = show
    },

    getCOGConfig() {
      return cogConfig
    },

    getCOGBounds() {
      return cogBounds
    },

    async initialize() {
      // Load COG metadata
      tiff = await fromUrl(cogUrl, { cacheSize: 100, blockSize: 65536 })
      pool = new Pool(navigator.hardwareConcurrency || 4)

      mainImage = await tiff.getImage(0)
      cogBounds = mainImage.getBoundingBox()  // [minLon, minLat, maxLon, maxLat]

      // Parse config from metadata
      const fileDirectory = mainImage.fileDirectory
      const gdalMeta = fileDirectory.GDAL_METADATA
      if (gdalMeta) {
        const match = gdalMeta.match(/<Item\s+name="ALBEDO_CONFIG"[^>]*>([^<]*)<\/Item>/)
        if (match) {
          const decoded = match[1]
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
          cogConfig = JSON.parse(decoded)
        }
      }

      if (!cogConfig) {
        const bandCount = mainImage.getSamplesPerPixel()
        cogConfig = {
          years: [2023, 2024, 2025].slice(0, bandCount - 1),
          landBand: bandCount - 1
        }
      }

      cogConfig.yearColors = {}
      cogConfig.years.forEach((year, idx) => {
        cogConfig.yearColors[year] = YEAR_PALETTE[idx % YEAR_PALETTE.length]
      })

      // Set initial selected bands to all years
      if (selectedBands.length === 0) {
        selectedBands = cogConfig.years.map((_, i) => i)
      }

      return cogConfig
    },

    onAdd(map, gl) {
      // Compile shaders
      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)

      program = gl.createProgram()
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.linkProgram(program)

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('COG layer shader link error:', gl.getProgramInfoLog(program))
        return
      }

      // Create quad buffer (two triangles covering [0,1] x [0,1])
      buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, 0,  1, 0,  0, 1,
        0, 1,  1, 0,  1, 1
      ]), gl.STATIC_DRAW)

      // Create texture
      texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

      // Cache uniform locations
      uniforms = {
        matrix: gl.getUniformLocation(program, 'u_matrix'),
        bounds: gl.getUniformLocation(program, 'u_bounds'),
        raster: gl.getUniformLocation(program, 'u_raster'),
        bandCount: gl.getUniformLocation(program, 'u_bandCount'),
        srcWidth: gl.getUniformLocation(program, 'u_srcWidth'),
        srcHeight: gl.getUniformLocation(program, 'u_srcHeight'),
        landBandIdx: gl.getUniformLocation(program, 'u_landBandIdx'),
        selectedBands: gl.getUniformLocation(program, 'u_selectedBands'),
        selectedCount: gl.getUniformLocation(program, 'u_selectedCount'),
        palette: gl.getUniformLocation(program, 'u_palette'),
        multiYearColor: gl.getUniformLocation(program, 'u_multiYearColor'),
        showLand: gl.getUniformLocation(program, 'u_showLand'),
        cogMin: gl.getUniformLocation(program, 'u_cogMin'),
        cogMax: gl.getUniformLocation(program, 'u_cogMax'),
      }

      // Set static uniforms
      gl.useProgram(program)

      // Upload palette
      const paletteFlat = new Float32Array(24)
      YEAR_PALETTE.forEach((rgb, i) => {
        paletteFlat[i * 3] = rgb[0] / 255
        paletteFlat[i * 3 + 1] = rgb[1] / 255
        paletteFlat[i * 3 + 2] = rgb[2] / 255
      })
      gl.uniform3fv(uniforms.palette, paletteFlat)
      gl.uniform3f(uniforms.multiYearColor,
        MULTI_YEAR_COLOR[0] / 255,
        MULTI_YEAR_COLOR[1] / 255,
        MULTI_YEAR_COLOR[2] / 255
      )
    },

    render(gl, matrix) {
      if (!program || !cogBounds || !cogConfig || !matrix) return

      const renderStart = performance.now()

      // Determine appropriate overview level based on zoom
      const zoom = this.map?.getZoom() || 2
      const targetOverview = Math.max(0, Math.min(4, 8 - Math.floor(zoom)))

      // Load overview if needed
      if (targetOverview !== currentOverviewLevel && !loadingOverview) {
        loadingOverview = true
        const loadStart = performance.now()
        this.loadOverview(gl, targetOverview).then(() => {
          lastLoadTime = performance.now() - loadStart
          currentOverviewLevel = targetOverview
          loadingOverview = false
          this.map?.triggerRepaint()
        })
      }

      if (!textureLoaded) return

      gl.useProgram(program)

      // Enable blending for transparency
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

      // Set up vertex attribute
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      const posLoc = gl.getAttribLocation(program, 'a_pos')
      gl.enableVertexAttribArray(posLoc)
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

      // Convert COG bounds (EPSG:4326) to Web Mercator for MapLibre
      const [minLon, minLat, maxLon, maxLat] = cogBounds
      const minX = minLon * MERCATOR_EXTENT / 180
      const maxX = maxLon * MERCATOR_EXTENT / 180
      const minY = latToMercatorY(minLat)
      const maxY = latToMercatorY(maxLat)

      // Set uniforms (convert Float64Array from MapLibre to Float32Array for WebGL)
      gl.uniformMatrix4fv(uniforms.matrix, false, new Float32Array(matrix))
      gl.uniform4f(uniforms.bounds, minX, minY, maxX, maxY)
      gl.uniform2f(uniforms.cogMin, minX, minY)
      gl.uniform2f(uniforms.cogMax, maxX, maxY)

      gl.uniform1i(uniforms.landBandIdx, cogConfig.landBand)
      gl.uniform1i(uniforms.selectedCount, selectedBands.length)

      const paddedBands = new Int32Array(8)
      selectedBands.forEach((b, i) => { if (i < 8) paddedBands[i] = b })
      gl.uniform1iv(uniforms.selectedBands, paddedBands)

      gl.uniform1i(uniforms.showLand, showLand ? 1 : 0)

      // Texture dimensions (set by loadOverview)
      gl.uniform1i(uniforms.bandCount, textureBandCount)
      gl.uniform1i(uniforms.srcWidth, textureSrcWidth)
      gl.uniform1i(uniforms.srcHeight, textureSrcHeight)

      // Bind texture
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.uniform1i(uniforms.raster, 0)

      // Draw
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      gl.disableVertexAttribArray(posLoc)

      // Track render performance
      lastRenderTime = performance.now() - renderStart
      renderCount++
      avgRenderTime = avgRenderTime + (lastRenderTime - avgRenderTime) / Math.min(renderCount, 60)
    },

    async loadOverview(gl, overviewLevel) {
      const imageCount = await tiff.getImageCount()
      const imageIdx = Math.min(overviewLevel, imageCount - 1)
      const image = await tiff.getImage(imageIdx)

      const width = image.getWidth()
      const height = image.getHeight()
      const bands = image.getSamplesPerPixel()

      // Read all bands
      const rasters = await image.readRasters({ pool })

      // Stack bands into single texture (bands stacked vertically)
      const texHeight = height * bands
      const textureData = new Float32Array(width * texHeight)

      for (let b = 0; b < bands; b++) {
        const band = rasters[b]
        const offset = b * width * height
        for (let i = 0; i < width * height; i++) {
          textureData[offset + i] = band[i] || 0
        }
      }

      // Find max value for normalization (can't use spread on large arrays)
      let maxVal = 1
      for (let i = 0; i < textureData.length; i++) {
        if (textureData[i] > maxVal) maxVal = textureData[i]
      }

      // Convert Float32 to Uint8 (normalized) for WebGL 1 compatibility
      const normalized = new Uint8Array(textureData.length)
      for (let i = 0; i < textureData.length; i++) {
        normalized[i] = Math.min(255, Math.floor(textureData[i] / maxVal * 255))
      }

      // Upload to GPU - set alignment to 1 since width may not be multiple of 4
      gl.useProgram(program)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, texHeight, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, normalized)

      // Store dimensions for render() - uniforms set there when program is bound
      textureBandCount = bands
      textureSrcWidth = width
      textureSrcHeight = height

      textureLoaded = true
      console.log(`COG overview ${imageIdx} loaded: ${width}×${height}, ${bands} bands`)
    },

    async switchCOG(newUrl) {
      // Reset state
      textureLoaded = false
      currentOverviewLevel = -1

      // Load new COG
      tiff = await fromUrl(newUrl, { cacheSize: 100, blockSize: 65536 })
      mainImage = await tiff.getImage(0)
      cogBounds = mainImage.getBoundingBox()

      // Parse config from metadata
      const fileDirectory = mainImage.fileDirectory
      const gdalMeta = fileDirectory.GDAL_METADATA
      if (gdalMeta) {
        const match = gdalMeta.match(/<Item\s+name="ALBEDO_CONFIG"[^>]*>([^<]*)<\/Item>/)
        if (match) {
          const decoded = match[1]
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
          cogConfig = JSON.parse(decoded)
        }
      }

      // Trigger repaint to load new data
      this.map?.triggerRepaint()
      return cogConfig
    },

    onRemove(map, gl) {
      if (buffer) gl.deleteBuffer(buffer)
      if (texture) gl.deleteTexture(texture)
      if (program) gl.deleteProgram(program)
    },

    // Map reference - set externally after adding layer
    map: null
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}
