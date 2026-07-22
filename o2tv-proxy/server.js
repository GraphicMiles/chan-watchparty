/**
 * O2TV Proxy Server with Puppeteer
 *
 * Uses headless Chrome to bypass Cloudflare's JavaScript challenge.
 */

import express from 'express'
import puppeteer from 'puppeteer'
import { createHash } from 'crypto'

const app = express()
const PORT = process.env.PORT || 3001

const TARGET_URL = 'https://tvshows4mobile.org'

// Cache
const cache = new Map()
const CACHE_TTL = 5 * 60 * 1000

// Rate limiting
const rateLimitMap = new Map()
const RATE_LIMIT_WINDOW = 60 * 1000
const RATE_LIMIT_MAX = 30

let browser = null

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
  }
  return browser
}

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

app.get('/proxy', async (req, res) => {
  const targetPath = req.query.url

  if (!targetPath) {
    return res.status(400).json({ error: 'Missing url parameter' })
  }

  let fullUrl
  try {
    fullUrl = targetPath.startsWith('http')
      ? targetPath
      : `${TARGET_URL}${targetPath}`
    new URL(fullUrl)
  } catch {
    return res.status(400).json({ error: 'Invalid URL' })
  }

  const clientIP = getClientIP(req)
  if (!checkRateLimit(clientIP)) {
    return res.status(429).json({ error: 'Rate limit exceeded' })
  }

  const cacheKey = getCacheKey(fullUrl)
  const cached = getFromCache(cacheKey)
  if (cached) {
    console.log(`[Proxy] Cache hit: ${fullUrl}`)
    return res.json(cached)
  }

  try {
    console.log(`[Proxy] Fetching with Puppeteer: ${fullUrl}`)

    const page = await (await getBrowser()).newPage()

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.5',
    })

    const response = await page.goto(fullUrl, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    })

    const status = response.status()
    const contentType = response.headers()['content-type'] || ''

    let data
    if (contentType.includes('text/html') || contentType.includes('text/plain')) {
      data = await page.content()
    } else {
      const buffer = await response.buffer()
      data = buffer.toString('base64')
    }

    await page.close()

    const result = {
      url: fullUrl,
      status,
      contentType,
      data,
      isBinary: !contentType.includes('text/'),
    }

    setCache(cacheKey, result)

    console.log(`[Proxy] Success: ${fullUrl} (${data.length} bytes)`)
    res.json(result)
  } catch (err) {
    console.error(`[Proxy] Error: ${err.message}`)
    res.status(500).json({ error: err.message, url: fullUrl })
  }
})

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cacheSize: cache.size,
    rateLimits: rateLimitMap.size,
    browser: browser ? 'running' : 'not started',
  })
})

app.post('/clear-cache', (req, res) => {
  cache.clear()
  res.json({ message: 'Cache cleared' })
})

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
  console.log(`[Proxy] O2TV Proxy with Puppeteer running on port ${PORT}`)
  console.log(`[Proxy] Target: ${TARGET_URL}`)
  console.log(`[Proxy] Cache TTL: ${CACHE_TTL / 1000}s`)
})

process.on('SIGINT', async () => {
  if (browser) await browser.close()
  process.exit(0)
})
