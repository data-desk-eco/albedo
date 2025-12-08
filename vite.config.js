import { defineConfig } from 'vite'

export default defineConfig({
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
