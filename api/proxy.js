import { preflight, fail } from '../server-lib/http.js'
import { validateFetchUrl, isPrivateHost } from '../server-lib/ssrf.js'
import { checkRateLimit, clientKey } from '../server-lib/rateLimit.js'
import { probeAndFixO2TvUrl } from '../server-lib/o2tvResolver.js'

/** Read optional domain allow-list from env (JSON array of hostnames). */
function getProxyDomainAllowlist() {
  const raw = process.env.PROXY_ALLOWED_DOMAINS
  if (!raw) return null // null = allow all (backward compat)
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length) {
      return parsed.map(h => h.toLowerCase().replace(/^\.*/, '.'))
    }
  } catch { /* ignore */ }
  return null
}

function isDomainAllowed(hostname) {
  const allowlist = getProxyDomainAllowlist()
  if (!allowlist) return true // no allowlist configured → permissive
  const lower = hostname.toLowerCase()
  return allowlist.some(domain => lower === domain.slice(1) || lower.endsWith(domain))
}

function validateProxyUrl(rawUrl) {
  const parsed = validateFetchUrl(rawUrl)
  if (!isDomainAllowed(parsed.hostname)) {
    throw new Error('Target domain is not allowed by proxy policy')
  }
  return parsed
}

/** Choose Cache-Control based on content type. */
function cacheControlForType(contentType = '', isM3u8 = false) {
  if (isM3u8) return 'public, max-age=2, must-revalidate' // playlists change often
  if (/video\/|\/octet-stream/i.test(contentType)) return 'public, max-age=3600' // video files
  if (/image\//i.test(contentType)) return 'public, max-age=86400'
  return 'public, max-age=300' // default 5 min
}

const UPSTREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

/**
 * Stream a ReadableStream from an upstream fetch directly to the Node.js
 * ServerResponse. Handles backpressure and client disconnects.
 *
 * Returns the number of bytes streamed.
 */
async function pipeStreamToResponse(reader, res, abortSignal) {
  let bytesSent = 0
  try {
    while (!abortSignal.aborted) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = Buffer.from(value)
      const ok = res.write(chunk)
      bytesSent += chunk.length

      if (!ok) {
        // Backpressure — wait for the client to drain
        await new Promise((resolve) => {
          const onDrain = () => { cleanup(); resolve() }
          const onClose = () => { cleanup(); resolve() }
          const cleanup = () => {
            res.off('drain', onDrain)
            res.off('close', onClose)
          }
          res.once('drain', onDrain)
          res.once('close', onClose)
        })
      }
    }
  } catch {
    // Stream interrupted (client disconnect, upstream error, or abort)
  }
  return bytesSent
}

export default async function handler(req, res) {
  if (preflight(req, res, { methods: ['GET', 'HEAD', 'OPTIONS'] })) return
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed')

  // --- Rate limiting (IP-based, since browser <video> can't send Bearer) ---
  const ip = clientKey(req)
  const rl = checkRateLimit(`proxy:${ip}`, { limit: 120, windowMs: 60_000 })
  if (!rl.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
    res.end(JSON.stringify({ success: false, error: 'Too many proxy requests — slow down' }))
    return
  }

  try {
    const rawUrl = req.query?.url
    if (!rawUrl) return fail(res, 400, 'Missing url query parameter')

    const targetUrl = validateProxyUrl(rawUrl)

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', '*')

    // ─── Build upstream request headers ───
    const upstreamHeaders = {
      'User-Agent': UPSTREAM_UA,
      'Accept': '*/*',
      'Referer': targetUrl.origin,
    }

    // Forward the browser's Range header (used by <video> for seeking / buffering)
    if (req.headers.range) {
      upstreamHeaders.Range = req.headers.range
    }

    // ─── Early m3u8 detection by URL path (avoids streaming a playlist) ───
    const isM3u8ByPath = /\.m3u8(?:\?|#|$)/i.test(targetUrl.pathname)

    if (isM3u8ByPath) {
      const response = await fetch(targetUrl.href, {
        redirect: 'follow',
        headers: upstreamHeaders,
      })
      if (!response.ok) return fail(res, response.status, `Upstream returned ${response.status}`)

      const text = await response.text()
      const rewritten = text.split('\n').map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return line
        if (trimmed.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/gi, (_, keyUri) => {
            try {
              const absKey = new URL(keyUri, targetUrl.href).href
              return `URI="/api/proxy?url=${encodeURIComponent(absKey)}"`
            } catch {
              return `URI="${keyUri}"`
            }
          })
        }
        try {
          const absoluteUri = new URL(trimmed, targetUrl.href).href
          return `/api/proxy?url=${encodeURIComponent(absoluteUri)}`
        } catch {
          return line
        }
      }).join('\n')

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
      res.setHeader('Cache-Control', cacheControlForType('', true))
      res.status(200).send(rewritten)
      return
    }

    // ─── Fetch from upstream (video, image, segment, anything else) ───
    const upstream = await fetch(targetUrl.href, {
      redirect: 'follow',
      headers: upstreamHeaders,
    })

    if (!upstream.ok && upstream.status !== 206) {
      // ─── O2TV 404 retry: try to probe for the correct CDN suffix ───
      // o2tv CDN URLs have random per-file suffixes (otv-XXXXX) that may be wrong.
      // If we get a 404 from o2tv, try to find the correct URL.
      if (upstream.status === 404 && targetUrl.hostname.includes('o2tv.org')) {
        try {
          const fixedUrl = await probeAndFixO2TvUrl(targetUrl.href)
          if (fixedUrl !== targetUrl.href) {
            const retryRes = await fetch(fixedUrl, {
              redirect: 'follow',
              headers: upstreamHeaders,
            })
            if (retryRes.ok || retryRes.status === 206) {
              const retryContentType = retryRes.headers.get('content-type') || ''
              if (/^text\/html/i.test(retryContentType)) {
                await retryRes.arrayBuffer().catch(() => {})
                return fail(res, 502, 'Stream server returned a web page instead of video')
              }
              const retryContentRange = retryRes.headers.get('content-range')
              const retryContentLength = retryRes.headers.get('content-length')
              res.setHeader('Content-Type', retryContentType || 'application/octet-stream')
              res.setHeader('Accept-Ranges', 'bytes')
              res.setHeader('Cache-Control', cacheControlForType(retryContentType))
              if (retryContentRange) res.setHeader('Content-Range', retryContentRange)
              if (retryContentLength) res.setHeader('Content-Length', retryContentLength)
              res.status(retryRes.status === 206 ? 206 : 200)
              if (req.method === 'HEAD') { res.end(); return }
              const reader = retryRes.body.getReader()
              const ac = new AbortController()
              const onClose = () => { ac.abort() }
              req.on('close', onClose)
              try { await pipeStreamToResponse(reader, res, ac.signal) } catch { /* */ }
              finally { req.off('close', onClose); await reader.cancel().catch(() => {}) }
              return
            }
          }
        } catch {
          // Probing failed — fall through to original 404
        }
      }
      return fail(res, upstream.status, `Upstream returned HTTP ${upstream.status}`)
    }

    const contentType = upstream.headers.get('content-type') || ''

    // ─── Detect m3u8 by Content-Type (after redirect) ───
    const isM3u8ByType = /(?:application\/vnd\.apple\.mpegurl|audio\/mpegurl|application\/x-mpegurl|text\/vnd\.apple\.mpegurl)/i.test(contentType)
    if (isM3u8ByType) {
      const text = await upstream.text()
      const rewritten = text.split('\n').map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return line
        if (trimmed.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/gi, (_, keyUri) => {
            try {
              const absKey = new URL(keyUri, targetUrl.href).href
              return `URI="/api/proxy?url=${encodeURIComponent(absKey)}"`
            } catch {
              return `URI="${keyUri}"`
            }
          })
        }
        try {
          const absoluteUri = new URL(trimmed, targetUrl.href).href
          return `/api/proxy?url=${encodeURIComponent(absoluteUri)}`
        } catch {
          return line
        }
      }).join('\n')

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
      res.setHeader('Cache-Control', cacheControlForType(contentType, true))
      res.status(200).send(rewritten)
      return
    }

    // ─── Guard: reject HTML when the client expects video ───
    // (dead IPTV channels, o2tv error pages, etc.)
    if (/^text\/html/i.test(contentType)) {
      // Consume the body to free the connection
      await upstream.arrayBuffer().catch(() => {})
      return fail(res, 502, 'Stream server returned a web page instead of video — channel may be offline')
    }

    // ─── Stream the response directly to the client ───
    // No buffering. Data flows from upstream → proxy → browser in real-time.
    // The browser's <video> element controls the flow via Range requests.
    // If the function times out (10s Hobby / 60s Pro), the browser simply
    // reconnects with a new Range request — this is standard HTTP behaviour.

    const contentRange = upstream.headers.get('content-range')
    const contentLength = upstream.headers.get('content-length')

    res.setHeader('Content-Type', contentType || 'application/octet-stream')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', cacheControlForType(contentType))

    if (contentRange) res.setHeader('Content-Range', contentRange)
    if (contentLength) res.setHeader('Content-Length', contentLength)

    // Forward the correct status: 206 for partial, 200 for full
    res.status(upstream.status === 206 ? 206 : 200)

    if (req.method === 'HEAD') {
      res.end()
      return
    }

    // Abort signal for client disconnect
    const abortController = new AbortController()
    const onClose = () => {
      abortController.abort()
    }
    req.on('close', onClose)

    try {
      const reader = upstream.body.getReader()
      await pipeStreamToResponse(reader, res, abortController.signal)
      await reader.cancel().catch(() => {})
    } catch {
      // Stream error (client disconnect / upstream error) — just end
    } finally {
      req.off('close', onClose)
    }

    res.end()
  } catch (err) {
    console.error('Proxy error:', err)
    return fail(res, 502, 'Upstream request failed')
  }
}
