/**
 * cog-tiles - Client-side COG tile renderer for MapLibre GL
 *
 * Renders Cloud Optimized GeoTIFFs directly in the browser with:
 * - Automatic overview selection based on zoom level
 * - EPSG:4326 to Web Mercator reprojection
 * - Pluggable colorization
 * - MapLibre protocol integration
 *
 * @example
 * import { COGTileSource, colorizers } from 'cog-tiles'
 *
 * const source = new COGTileSource('https://example.com/data.tif', {
 *   colorize: colorizers.colormap({ min: 0, max: 100 })
 * })
 *
 * await source.initialize()
 *
 * const protocol = source.createProtocol('cog')
 * maplibregl.addProtocol(protocol.name, protocol.handler)
 *
 * map.addSource('my-cog', source.getSourceConfig('cog'))
 * map.addLayer({ id: 'cog-layer', type: 'raster', source: 'my-cog' })
 */

export { COGTileSource } from './cog-source.js'

// Re-export colorizers
export * as colorizers from './colorizers.js'

// Re-export geo utilities
export * as geo from './geo.js'

// Convenience: also export individual colorizers at top level
export {
  rgb,
  grayscale,
  colormap,
  categorical,
  threshold,
  withTransparency,
  composite
} from './colorizers.js'

// Convenience: export commonly used geo functions
export {
  tileToBBox,
  latToMercatorY,
  mercatorYToLat,
  lonToMercatorX,
  mercatorXToLon,
  bboxIntersects,
  MERCATOR_EXTENT,
  MAX_MERCATOR_LAT
} from './geo.js'
