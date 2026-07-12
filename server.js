// Minimal dev/prod server that emulates Vercel's setup locally:
// - /api/*.js files are mounted as routes (same handler signature Vercel uses).
// - Everything else is served by Vite (dev) or the built `dist/` (prod).
import express from 'express'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 5000
const isProd = process.env.NODE_ENV === 'production'

async function createApiRouter() {
  const router = express.Router()
  router.use(express.json({ limit: '2mb' }))

  const apiDir = path.join(__dirname, 'api')
  const files = fs
    .readdirSync(apiDir)
    .filter((f) => f.endsWith('.js') && fs.statSync(path.join(apiDir, f)).isFile())

  for (const file of files) {
    const name = file.replace(/\.js$/, '')
    const mod = await import(path.join(apiDir, file))
    const fn = mod.default
    if (typeof fn !== 'function') continue

    router.all(`/${name}`, (req, res) => {
      Promise.resolve(fn(req, res)).catch((err) => {
        console.error(`[api/${name}] unhandled error:`, err)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      })
    })
  }

  console.log(`[server] mounted ${files.length} api route(s): ${files.map((f) => f.replace(/\.js$/, '')).join(', ')}`)
  return router
}

async function start() {
  const app = express()
  app.use('/api', await createApiRouter())

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite')
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        allowedHosts: true,
        hmr: { clientPort: 443 },
      },
      appType: 'spa',
    })
    app.use(vite.middlewares)
  } else {
    const distPath = path.join(__dirname, 'dist')
    app.use(express.static(distPath))
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'))
    })
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT} (${isProd ? 'production' : 'development'})`)
  })
}

start()
