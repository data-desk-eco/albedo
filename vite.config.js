import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: './',  // Use relative paths for assets (works from any base path)
    define: {
      __TILE_VERSION__: JSON.stringify(env.TILE_VERSION || '1')
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      rollupOptions: {
        output: {
          manualChunks: {
            'duckdb': ['@duckdb/duckdb-wasm'],
            'geotiff': ['geotiff'],
            'maplibre': ['maplibre-gl']
          }
        }
      }
    },
    server: {
      // For development, serve data files directly from the data directory
      fs: {
        allow: ['..']
      }
    },
    optimizeDeps: {
      exclude: ['@duckdb/duckdb-wasm']  // Don't pre-bundle DuckDB WASM
    }
  }
})
