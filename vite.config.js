import { defineConfig } from 'vite'

export default defineConfig({
  base: './',  // Use relative paths for assets (works from any base path)
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  },
  server: {
    proxy: {
      '/tiles': 'http://localhost:8000',
      '/data': 'http://localhost:8000'
    }
  }
})
