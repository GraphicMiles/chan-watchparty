/**
 * O2TV Proxy Server
 *
 * Proxies requests to tvshows4mobile.org to avoid IP blocking.
 * - Adds browser-like headers
 * - Caches responses (5 min TTL)
 * - Rate limiting (10 req/min per IP)
 * - Can be deployed on Render/VPS with different IP
 */

import express from 'express'
import { createHash } from 'crypto'

const app = express()
const PORT = process.env.PORT || 3001

const TARGET_URL = 'https://tvshows4mobile.org'

// Browser headers to avoid detection
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
}

// Simple in-memory cache
const cache = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Rate limiting
const rateLimitMap = new Map()
const RATE_LIMIT_WINDOW = 60 * 1000 // 1 minute
const RATE_LIMIT_MAX = 60 // 60 requests per minute

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.ip
}

function checkRateLimit(clientIP) {
  const now = Date.now()
  const window = rateLimitMap.get(clientIP) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW }

  if (now > window.resetAt) {
    window.count = 0
    window.resetAt = now + RATE_LIMIT_WINDOW
  }

  window.count++
  rateLimitMap.set(clientIP, window)

  return window.count <= RATE_LIMIT_MAX
}

function getCacheKey(url) {
  return createHash('md5').update(url).digest('hex')
}

function getFromCache(key) {
  const cached = cache.get(key)
  if (!cached) return null
  if (Date.now() > cached.expiresAt) {
    cache.delete(key)
    return null
  }
  return cached.data
}

function setCache(key, data) {
  cache.set(key, {
    data,
    expiresAt: Date.now() + CACHE_TTL,
  })
}

// Proxy endpoint
app.get('/proxy', async (req, res) => {
  const targetPath = req.query.url

  if (!targetPath) {
    return res.status(400).json({ error: 'Missing url parameter' })
  }

  // Validate URL
  let fullUrl
  try {
    fullUrl = targetPath.startsWith('http')
      ? targetPath
      : `${TARGET_URL}${targetPath}`
    new URL(fullUrl)
  } catch {
    return res.status(400).json({ error: 'Invalid URL' })
  }

  // Rate limiting
  const clientIP = getClientIP(req)
  if (!checkRateLimit(clientIP)) {
    return res.status(429).json({ error: 'Rate limit exceeded' })
  }

  // Check cache
  const cacheKey = getCacheKey(fullUrl)
  const cached = getFromCache(cacheKey)
  if (cached) {
    console.log(`[Proxy] Cache hit: ${fullUrl}`)
    return res.json(cached)
  }

  try {
    console.log(`[Proxy] Fetching: ${fullUrl}`)

    const response = await fetch(fullUrl, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
    })

    if (!response.ok) {
      console.error(`[Proxy] HTTP ${response.status} for ${fullUrl}`)
      return res.status(response.status).json({
        error: `HTTP ${response.status}`,
        url: fullUrl,
      })
    }

    const contentType = response.headers.get('content-type') || ''
    let data

    if (contentType.includes('text/html') || contentType.includes('text/plain')) {
      data = await response.text()
    } else {
      data = await response.arrayBuffer()
    }

    const result = {
      url: fullUrl,
      status: response.status,
      contentType,
      data: contentType.includes('text/') ? data : Buffer.from(data).toString('base64'),
      isBinary: !contentType.includes('text/'),
    }

    // Cache the response
    setCache(cacheKey, result)

    console.log(`[Proxy] Success: ${fullUrl} (${data.length} bytes)`)
    res.json(result)
  } catch (err) {
    console.error(`[Proxy] Error: ${err.message}`)
    res.status(500).json({ error: err.message, url: fullUrl })
  }
})

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cacheSize: cache.size,
    rateLimits: rateLimitMap.size,
  })
})

// Clear cache endpoint
app.post('/clear-cache', (req, res) => {
  cache.clear()
  res.json({ message: 'Cache cleared' })
})

// Stats endpoint
app.get('/stats', (req, res) => {
  const now = Date.now()
  const activeRates = Array.from(rateLimitMap.entries())
    .filter(([_, window]) => now < window.resetAt)
    .map(([ip, window]) => ({ ip, count: window.count }))

  res.json({
    cacheSize: cache.size,
    activeClients: activeRates.length,
    rateLimits: activeRates,
  })
})

app.listen(PORT, () => {
  console.log(`[Proxy] O2TV Proxy running on port ${PORT}`)
  console.log(`[Proxy] Target: ${TARGET_URL}`)
  console.log(`[Proxy] Cache TTL: ${CACHE_TTL / 1000}s`)
  console.log(`[Proxy] Rate limit: ${RATE_LIMIT_MAX} req/${RATE_LIMIT_WINDOW / 1000}s`)
})
