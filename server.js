/**
 * Chan - Express Server for Render
 * Serves static frontend + API routes
 */
import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import mediaHandler from './api/media.js'
import roomHandler from './api/room.js'
import proxyHandler from './api/proxy.js'
import { corsHeaders } from './server-lib/cors.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }))

// Apply CORS to every API response, not just OPTIONS preflight.
// Without this, Android/Capacitor fetch() rejects successful POST responses as
// "Failed to fetch" because the actual response has no Access-Control headers.
app.use('/api', (req, res, next) => {
  const headers = corsHeaders(req)
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value)
  }
  next()
})

// API routes
// Use app.all so Android/Capacitor CORS preflight OPTIONS requests reach
// the API handlers. Cross-origin JSON requests with Authorization headers
// will fail as "Failed to fetch" if OPTIONS is not handled here.
app.all('/api/media', async (req, res) => {
  try {
    await mediaHandler(req, res)
  } catch (err) {
    console.error('Media API error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.all('/api/room', async (req, res) => {
  try {
    await roomHandler(req, res)
  } catch (err) {
    console.error('Room API error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.all('/api/proxy', async (req, res) => {
  try {
    await proxyHandler(req, res)
  } catch (err) {
    console.error('Proxy API error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Serve static frontend - hashed assets can be cached long-term
app.use(express.static(join(__dirname, 'dist'), {
  maxAge: '1y',
  immutable: true,
  setHeaders: (res, path) => {
    // Never cache index.html - it must always be fresh to load new asset hashes
    if (path.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
    }
  }
}))

// SPA fallback - serve index.html for all non-API routes
app.get('/{*splat}', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

// Start server
app.listen(PORT, () => {
  console.log(`Chan server running on port ${PORT}`)
  console.log(`Frontend: http://localhost:${PORT}`)
  console.log(`API: http://localhost:${PORT}/api`)
})
