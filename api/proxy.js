import { Readable } from 'node:stream'
import { preflight, fail } from '../server-lib/http.js'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const PRIVATE_IPV4_RE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|0\.0\.0\.0)/

function isPrivateHost(hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1') {
    return true
  }
  return PRIVATE_IPV4_RE.test(hostname)
}

function validateProxyUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid or malformed target URL')
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs can be proxied')
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new Error('Access to private or loopback network targets is forbidden')
  }

  return parsed
}

export default async function handler(req, res) {
  if (preflight(req, res, { methods: ['GET', 'HEAD', 'OPTIONS'] })) return
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed')

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

      const chunkRange = chunkResponse.headers.get('content-range') || `bytes ${start}-${end}/${totalLength > 0 ? totalLength : '*'}`
      const chunkLen = chunkResponse.headers.get('content-length') || String(end - start + 1)

      res.setHeader('Content-Type', contentType || 'video/mp4')
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Range', chunkRange)
      res.setHeader('Content-Length', chunkLen)
      res.status(206)

      if (req.method === 'HEAD') {
        res.end()
        return
      }

      const arrayBuffer = await chunkResponse.arrayBuffer()
      res.send(Buffer.from(arrayBuffer))
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
    return fail(res, 502, err.message || 'Upstream stream request failed')
  }
}
