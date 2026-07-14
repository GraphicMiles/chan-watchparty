import { Readable } from 'node:stream'
import { preflight, fail } from '../server-lib/http.js'
import { validateFetchUrl, isPrivateHost } from '../server-lib/ssrf.js'
import { checkRateLimit, clientKey } from '../server-lib/rateLimit.js'

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
  if (/video\/|\/octet-stream/i.test(contentType)) return 'public, max-age=3600' // segments / video chunks
  if (/image\//i.test(contentType)) return 'public, max-age=86400'
  return 'public, max-age=300' // default 5 min
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

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', '*')

    // If it is a video file (.mp4, .mkv, .mov, .avi) or explicit Range header requested by <video> tag
    const isVideoOrBinary = /\.(mp4|mkv|mov|avi|webm|flv)$/i.test(targetUrl.pathname) || Boolean(req.headers.range)
    if (isVideoOrBinary) {
      let start = 0
      let end = null
      const rangeMatch = req.headers.range?.match(/bytes=(\d+)-(\d*)/)
      if (rangeMatch) {
        start = parseInt(rangeMatch[1], 10) || 0
        if (rangeMatch[2]) {
          end = parseInt(rangeMatch[2], 10)
        }
      }

      // First check total length via HEAD or 0-0 probe
      let totalLength = 0
      let contentType = 'video/mp4'
      const probeResponse = await fetch(targetUrl.href, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Referer': targetUrl.origin,
          'Range': 'bytes=0-0',
        },
      }).catch(() => null)

      if (probeResponse && (probeResponse.ok || probeResponse.status === 206)) {
        contentType = probeResponse.headers.get('content-type') || contentType
        const contentRange = probeResponse.headers.get('content-range')
        if (contentRange) {
          const parts = contentRange.split('/')
          totalLength = Number(parts[1]) || 0
        } else {
          totalLength = Number(probeResponse.headers.get('content-length')) || 0
        }
        if (probeResponse.body) await probeResponse.body.cancel().catch(() => {})
      }

      const CHUNK_SIZE = 3500000 // 3.5MB safe boundary

      if (totalLength > 0 && (end === null || (end - start + 1) > CHUNK_SIZE)) {
        end = Math.min(start + CHUNK_SIZE - 1, totalLength - 1)
      } else if (end === null) {
        end = start + CHUNK_SIZE - 1
      }

      const chunkResponse = await fetch(targetUrl.href, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Referer': targetUrl.origin,
          'Range': `bytes=${start}-${end}`,
        },
      })

      if (!chunkResponse.ok && chunkResponse.status !== 206) {
        return fail(res, chunkResponse.status, `Upstream chunk returned ${chunkResponse.status}`)
      }

      // Safely read up to CHUNK_SIZE bytes so Vercel Serverless memory never overflows even if upstream ignored Range
      const chunks = []
      let bytesRead = 0
      if (chunkResponse.body && typeof chunkResponse.body.getReader === 'function') {
        const reader = chunkResponse.body.getReader()
        while (bytesRead < CHUNK_SIZE) {
          const { done, value } = await reader.read()
          if (done || !value) break
          const remaining = CHUNK_SIZE - bytesRead
          if (value.length > remaining) {
            chunks.push(value.slice(0, remaining))
            bytesRead += remaining
            break
          } else {
            chunks.push(value)
            bytesRead += value.length
          }
        }
        await reader.cancel().catch(() => {})
      } else {
        const buf = Buffer.from(await chunkResponse.arrayBuffer())
        const sliced = buf.slice(0, CHUNK_SIZE)
        chunks.push(sliced)
        bytesRead = sliced.length
      }

      const buffer = Buffer.concat(chunks)
      const actualEnd = start + buffer.length - 1
      const chunkRange = `bytes ${start}-${actualEnd}/${totalLength > 0 ? totalLength : '*'}`

      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', '*')
      res.setHeader('Content-Type', contentType || 'video/mp4')
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Cache-Control', cacheControlForType(contentType))

      if (totalLength > 0 || req.headers.range || chunkResponse.status === 206) {
        res.setHeader('Content-Range', chunkRange)
        res.setHeader('Content-Length', String(buffer.length))
        res.status(206)
      } else {
        res.setHeader('Content-Length', String(buffer.length))
        res.status(200)
      }

      if (req.method === 'HEAD') {
        res.end()
        return
      }

      res.send(buffer)
      return
    }

    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': targetUrl.origin,
    }

    const response = await fetch(targetUrl.href, {
      redirect: 'follow',
      headers: fetchHeaders,
    })

    if (!response.ok && response.status !== 206) {
      return fail(res, response.status, `Upstream server returned HTTP ${response.status}`)
    }

    const contentType = response.headers.get('content-type') || ''
    const isM3u8 = /(?:application\/vnd\.apple\.mpegurl|audio\/mpegurl|application\/x-mpegurl|text\/vnd\.apple\.mpegurl|\.m3u8)/i.test(contentType) ||
                   /\.m3u8(?:\?|#|$)/i.test(targetUrl.pathname)

    if (isM3u8) {
      const text = await response.text()
      // Rewrite any relative/absolute URI inside the m3u8 playlist to run through /api/proxy
      const rewritten = text.split('\n').map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return line
        if (trimmed.startsWith('#')) {
          // Rewrite encryption key URI if present
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

    // Binary / Segment / MP4 Proxy
    const isVideoFile = /\.(mp4|mkv|mov|avi)$/i.test(targetUrl.pathname) || (contentType && /video\//i.test(contentType))
    if (isVideoFile || req.headers.range) {
      let start = 0
      let end = null
      const rangeMatch = req.headers.range?.match(/bytes=(\d+)-(\d*)/)
      if (rangeMatch) {
        start = parseInt(rangeMatch[1], 10) || 0
        if (rangeMatch[2]) {
          end = parseInt(rangeMatch[2], 10)
        }
      }

      const headResponse = await fetch(targetUrl.href, {
        method: 'HEAD',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Referer': targetUrl.origin,
        },
      }).catch(() => null)

      const totalLength = Number(headResponse?.headers.get('content-length') || response.headers.get('content-length')) || 0
      const CHUNK_SIZE = 3500000 // 3.5MB safe chunk boundary under Vercel 4.5MB Hobby payload limit

      if (totalLength > 0 && (end === null || (end - start + 1) > CHUNK_SIZE)) {
        end = Math.min(start + CHUNK_SIZE - 1, totalLength - 1)
      } else if (end === null) {
        end = start + CHUNK_SIZE - 1
      }

      const chunkResponse = await fetch(targetUrl.href, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Referer': targetUrl.origin,
          'Range': `bytes=${start}-${end}`,
        },
      })

      if (!chunkResponse.ok && chunkResponse.status !== 206) {
        return fail(res, chunkResponse.status, `Upstream chunk returned ${chunkResponse.status}`)
      }

      const chunkRange = chunkResponse.headers.get('content-range') || `bytes ${start}-${end}/${totalLength > 0 ? totalLength : '*'}`
      const chunkLen = chunkResponse.headers.get('content-length') || String(end - start + 1)

      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', '*')
      res.setHeader('Content-Type', contentType || 'video/mp4')
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Range', chunkRange)
      res.setHeader('Content-Length', chunkLen)
      res.setHeader('Cache-Control', cacheControlForType(contentType))
      res.status(206)

      if (req.method === 'HEAD') {
        res.end()
        return
      }

      const arrayBuffer = await chunkResponse.arrayBuffer()
      res.send(Buffer.from(arrayBuffer))
      return
    }

    res.setHeader('Content-Type', contentType || 'application/octet-stream')
    res.setHeader('Cache-Control', cacheControlForType(contentType))
    const contentRange = response.headers.get('content-range')
    if (contentRange) {
      res.setHeader('Content-Range', contentRange)
      res.status(206)
    } else {
      res.status(response.status === 206 ? 206 : 200)
    }

    const contentLength = response.headers.get('content-length')
    if (contentLength) res.setHeader('Content-Length', contentLength)

    if (req.method === 'HEAD') {
      res.end()
      return
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    if (!contentLength) res.setHeader('Content-Length', String(buffer.length))
    res.send(buffer)
  } catch (err) {
    console.error('Proxy error:', err)
    return fail(res, 502, 'Upstream request failed')
  }
}
