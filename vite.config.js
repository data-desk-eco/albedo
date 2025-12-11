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
      assetsDir: 'assets'
    },
    server: {
      proxy: {
        '/tiles': 'http://localhost:8000',
        '/data': 'http://localhost:8000',
        '/places': 'http://localhost:8000'
      }
    }
  }
})
