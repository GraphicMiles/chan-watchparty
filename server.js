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
import { getDb } from './server-lib/firebaseAdmin.js'
import { runCleanupStaleRooms } from './server-lib/roomCleanup.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000

// Render terminates TLS and proxies to this process, appending the client IP
// to X-Forwarded-For. Without this, req.ip is the proxy's address and
// rateLimit's clientKey() would bucket every visitor together; with it,
// Express resolves the real client and ignores client-forged header entries.
app.set('trust proxy', 1)

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }))

// Security headers for EVERY response, including the HTML app shell.
// These previously lived only in vercel.json, which Render never reads — so
// the deployed app was served with no CSP, no clickjacking protection and no
// referrer policy at all. Set here so they apply to the real deployment.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()')
  // API responses are JSON and must never be treated as a document.
  if (!req.path.startsWith('/api')) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // 'unsafe-inline'/'unsafe-eval' are required by the current bundle
        // (Vite runtime + YouTube iframe API). Tightening these needs a
        // nonce/hash pass over the build and is deliberately out of scope here.
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.youtube.com https://s.ytimg.com https://apis.google.com",
        "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://livekit.cloud",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https: http:",
        "connect-src 'self' https: wss:",
        "media-src 'self' https: http: blob:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join('; ')
    )
  }
  next()
})

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

/**
 * Stale-room cleanup scheduler.
 *
 * runCleanupStaleRooms() previously had no scheduled caller at all: the only
 * triggers were an authenticated cron request (nothing was scheduled) and a
 * fire-and-forget call on `leave`. A room is abandoned precisely when `leave`
 * does NOT fire (app killed, network dropped, phone locked), so in practice
 * abandoned rooms were never reclaimed.
 *
 * Render runs one long-lived Node process, so an in-process interval is the
 * simplest correct fix and needs no secret or HTTP hop. Notes:
 *  - Free instances spin down when idle, which pauses the timer. The startup
 *    sweep covers the gap on the next wake.
 *  - unref() lets the process exit normally during a deploy.
 *  - A run is skipped if the previous one is still going, so a slow sweep
 *    cannot stack up.
 *
 * Set ROOM_CLEANUP_INTERVAL_MS=0 to disable (e.g. if you later move this to a
 * dedicated Render Cron Job on a paid plan, to avoid two schedulers).
 */
const CLEANUP_INTERVAL_MS = process.env.ROOM_CLEANUP_INTERVAL_MS !== undefined
  ? Number(process.env.ROOM_CLEANUP_INTERVAL_MS)
  : 10 * 60 * 1000
const CLEANUP_STARTUP_DELAY_MS = 30_000

let cleanupRunning = false

async function sweepStaleRooms(reason) {
  if (cleanupRunning) return
  cleanupRunning = true
  try {
    const { cleaned } = await runCleanupStaleRooms(getDb())
    if (cleaned > 0) console.log(`[cleanup] (${reason}) reclaimed ${cleaned} stale room(s)`)
  } catch (err) {
    // Never let a cleanup failure take the web process down.
    console.error(`[cleanup] (${reason}) failed:`, err?.message || err)
  } finally {
    cleanupRunning = false
  }
}

function startCleanupScheduler() {
  if (!Number.isFinite(CLEANUP_INTERVAL_MS) || CLEANUP_INTERVAL_MS <= 0) {
    console.log('[cleanup] scheduler disabled (ROOM_CLEANUP_INTERVAL_MS=0)')
    return
  }
  // Delay the first sweep so it never competes with cold-start traffic.
  setTimeout(() => sweepStaleRooms('startup'), CLEANUP_STARTUP_DELAY_MS).unref?.()
  setInterval(() => sweepStaleRooms('interval'), CLEANUP_INTERVAL_MS).unref?.()
  console.log(`[cleanup] scheduler active — every ${Math.round(CLEANUP_INTERVAL_MS / 1000)}s`)
}

// Start server
app.listen(PORT, () => {
  console.log(`Chan server running on port ${PORT}`)
  console.log(`Frontend: http://localhost:${PORT}`)
  console.log(`API: http://localhost:${PORT}/api`)
  startCleanupScheduler()
})
