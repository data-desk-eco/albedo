import { defineConfig, loadEnv } from 'vite'
import { existsSync, createReadStream, statSync, mkdirSync, copyFileSync, readdirSync } from 'fs'
import { resolve, join } from 'path'

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
            'geotiff': ['geotiff'],
            'maplibre': ['maplibre-gl']
          }
        }
      }
    },
    server: {
      allowedHosts: ['albedo.datadesk.eco'],
      fs: {
        allow: ['..']
      }
    },
    plugins: [
      {
        name: 'serve-data-directory',
        configureServer(server) {
          // Serve data/ directory at /data/ path in development
          // This replaces the public/data symlink which caused 16GB builds
          server.middlewares.use('/data', (req, res, next) => {
            const filePath = resolve(process.cwd(), 'data', req.url.slice(1))
            if (existsSync(filePath) && statSync(filePath).isFile()) {
              const stat = statSync(filePath)
              res.setHeader('Content-Length', stat.size)
              res.setHeader('Accept-Ranges', 'bytes')

              // Handle range requests for COG and SQLite files
              const range = req.headers.range
              if (range) {
                const parts = range.replace(/bytes=/, '').split('-')
                const start = parseInt(parts[0], 10)
                const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
                res.statusCode = 206
                res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
                res.setHeader('Content-Length', end - start + 1)
                createReadStream(filePath, { start, end }).pipe(res)
              } else {
                createReadStream(filePath).pipe(res)
              }
            } else {
              next()
            }
          })
        }
      },
      {
        name: 'copy-data-files',
        closeBundle() {
          // Copy local data files to dist (main data files served from GCS)
          const outDir = resolve(process.cwd(), 'dist')
          const dataDir = resolve(process.cwd(), 'data')

          // Places
          const placesDir = join(dataDir, 'places')
          const outPlacesDir = join(outDir, 'data', 'places')
          mkdirSync(outPlacesDir, { recursive: true })
          for (const file of readdirSync(placesDir)) {
            const src = join(placesDir, file)
            if (statSync(src).isFile()) {
              copyFileSync(src, join(outPlacesDir, file))
            }
          }

          console.log('Copied data files to dist/')
        }
      }
    ]
  }
})
