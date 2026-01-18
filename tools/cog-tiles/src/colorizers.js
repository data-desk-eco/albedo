/**
 * Built-in colorizer functions for COG tile rendering
 *
 * A colorizer is a function that takes band values and returns RGBA:
 *   (bands: number[], x: number, y: number) => [r, g, b, a]
 *
 * - bands: Array of band values at the pixel (0-indexed)
 * - x, y: Pixel coordinates within the tile (0-255 for 256px tiles)
 * - Returns: [r, g, b, a] where each value is 0-255
 */

/**
 * Create an RGB colorizer that maps 3 bands to RGB channels
 * @param {Object} options
 * @param {number} [options.redBand=0] - Band index for red channel
 * @param {number} [options.greenBand=1] - Band index for green channel
 * @param {number} [options.blueBand=2] - Band index for blue channel
 * @param {number} [options.min=0] - Minimum input value
 * @param {number} [options.max=255] - Maximum input value
 * @returns {Function} Colorizer function
 */
export function rgb({ redBand = 0, greenBand = 1, blueBand = 2, min = 0, max = 255 } = {}) {
  const range = max - min
  return (bands) => {
    const r = Math.round(((bands[redBand] || 0) - min) / range * 255)
    const g = Math.round(((bands[greenBand] || 0) - min) / range * 255)
    const b = Math.round(((bands[blueBand] || 0) - min) / range * 255)
    return [
      Math.max(0, Math.min(255, r)),
      Math.max(0, Math.min(255, g)),
      Math.max(0, Math.min(255, b)),
      255
    ]
  }
}

/**
 * Create a single-band grayscale colorizer
 * @param {Object} options
 * @param {number} [options.band=0] - Band index to use
 * @param {number} [options.min=0] - Minimum input value (maps to black)
 * @param {number} [options.max=255] - Maximum input value (maps to white)
 * @returns {Function} Colorizer function
 */
export function grayscale({ band = 0, min = 0, max = 255 } = {}) {
  const range = max - min
  return (bands) => {
    const v = Math.round(((bands[band] || 0) - min) / range * 255)
    const clamped = Math.max(0, Math.min(255, v))
    return [clamped, clamped, clamped, 255]
  }
}

/**
 * Create a colormap-based colorizer for single-band data
 * @param {Object} options
 * @param {number} [options.band=0] - Band index to use
 * @param {number} [options.min=0] - Minimum input value
 * @param {number} [options.max=1] - Maximum input value
 * @param {Array<[number, number, number]>} [options.colors] - Array of [r,g,b] colors
 * @returns {Function} Colorizer function
 */
export function colormap({ band = 0, min = 0, max = 1, colors = null } = {}) {
  // Default: viridis-like colormap
  const palette = colors || [
    [68, 1, 84],
    [72, 40, 120],
    [62, 74, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [109, 205, 89],
    [180, 222, 44],
    [253, 231, 37]
  ]

  const range = max - min
  const steps = palette.length - 1

  return (bands) => {
    const value = bands[band] || 0
    if (value <= min) return [...palette[0], 255]
    if (value >= max) return [...palette[palette.length - 1], 255]

    const normalized = (value - min) / range
    const idx = normalized * steps
    const lower = Math.floor(idx)
    const upper = Math.min(lower + 1, steps)
    const t = idx - lower

    // Linear interpolation between colors
    const c1 = palette[lower]
    const c2 = palette[upper]
    return [
      Math.round(c1[0] + (c2[0] - c1[0]) * t),
      Math.round(c1[1] + (c2[1] - c1[1]) * t),
      Math.round(c1[2] + (c2[2] - c1[2]) * t),
      255
    ]
  }
}

/**
 * Create a categorical colorizer that maps discrete values to colors
 * @param {Object} options
 * @param {number} [options.band=0] - Band index to use
 * @param {Object<number, [number, number, number, number]>} options.mapping - Value to RGBA mapping
 * @param {[number, number, number, number]} [options.defaultColor] - Color for unmapped values
 * @returns {Function} Colorizer function
 */
export function categorical({ band = 0, mapping = {}, defaultColor = [0, 0, 0, 0] } = {}) {
  return (bands) => {
    const value = bands[band]
    return mapping[value] || defaultColor
  }
}

/**
 * Create a threshold colorizer that applies colors based on value ranges
 * @param {Object} options
 * @param {number} [options.band=0] - Band index to use
 * @param {Array<{threshold: number, color: [number, number, number, number]}>} options.stops
 * @param {[number, number, number, number]} [options.belowColor] - Color for values below first threshold
 * @returns {Function} Colorizer function
 */
export function threshold({ band = 0, stops = [], belowColor = [0, 0, 0, 0] } = {}) {
  // Sort stops by threshold ascending
  const sortedStops = [...stops].sort((a, b) => a.threshold - b.threshold)

  return (bands) => {
    const value = bands[band] || 0

    for (let i = sortedStops.length - 1; i >= 0; i--) {
      if (value >= sortedStops[i].threshold) {
        return sortedStops[i].color
      }
    }
    return belowColor
  }
}

/**
 * Create a transparency mask colorizer
 * Useful for overlaying COG data on basemaps
 * @param {Object} options
 * @param {Function} options.colorizer - Base colorizer function
 * @param {number} [options.noDataBand] - Band index that indicates no-data (transparent if 0)
 * @param {number} [options.noDataValue=0] - Value that indicates no-data
 * @param {number} [options.opacity=1] - Overall opacity (0-1)
 * @returns {Function} Colorizer function
 */
export function withTransparency({ colorizer, noDataBand = null, noDataValue = 0, opacity = 1 } = {}) {
  const alpha = Math.round(opacity * 255)

  return (bands, x, y) => {
    // Check no-data condition
    if (noDataBand !== null && bands[noDataBand] === noDataValue) {
      return [0, 0, 0, 0]
    }

    const [r, g, b, a] = colorizer(bands, x, y)
    return [r, g, b, Math.round((a / 255) * alpha)]
  }
}

/**
 * Combine multiple colorizers with blend modes
 * @param {Object} options
 * @param {Array<{colorizer: Function, weight?: number}>} options.layers - Colorizers to combine
 * @param {string} [options.mode='normal'] - Blend mode: 'normal', 'add', 'multiply'
 * @returns {Function} Colorizer function
 */
export function composite({ layers = [], mode = 'normal' } = {}) {
  return (bands, x, y) => {
    if (layers.length === 0) return [0, 0, 0, 0]

    let result = [0, 0, 0, 0]

    for (const { colorizer, weight = 1 } of layers) {
      const [r, g, b, a] = colorizer(bands, x, y)

      if (mode === 'add') {
        result[0] = Math.min(255, result[0] + r * weight)
        result[1] = Math.min(255, result[1] + g * weight)
        result[2] = Math.min(255, result[2] + b * weight)
        result[3] = Math.min(255, result[3] + a * weight)
      } else if (mode === 'multiply') {
        if (result[3] === 0) {
          result = [r, g, b, a]
        } else {
          result[0] = Math.round((result[0] / 255) * (r / 255) * 255)
          result[1] = Math.round((result[1] / 255) * (g / 255) * 255)
          result[2] = Math.round((result[2] / 255) * (b / 255) * 255)
          result[3] = Math.round((result[3] / 255) * (a / 255) * 255)
        }
      } else {
        // Normal: alpha composite (later layers on top)
        const srcAlpha = (a / 255) * weight
        const dstAlpha = result[3] / 255
        const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha)

        if (outAlpha > 0) {
          result[0] = Math.round((r * srcAlpha + result[0] * dstAlpha * (1 - srcAlpha)) / outAlpha)
          result[1] = Math.round((g * srcAlpha + result[1] * dstAlpha * (1 - srcAlpha)) / outAlpha)
          result[2] = Math.round((b * srcAlpha + result[2] * dstAlpha * (1 - srcAlpha)) / outAlpha)
          result[3] = Math.round(outAlpha * 255)
        }
      }
    }

    return result
  }
}
