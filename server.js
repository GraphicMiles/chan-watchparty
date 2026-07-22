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

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }))

// API routes
app.post('/api/media', async (req, res) => {
  try {
    await mediaHandler(req, res)
  } catch (err) {
    console.error('Media API error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/room', async (req, res) => {
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

// Serve static frontend
app.use(express.static(join(__dirname, 'dist'), {
  maxAge: '1y',
  immutable: true,
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
