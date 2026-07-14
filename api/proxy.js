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

    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': targetUrl.origin,
    }
    if (req.headers.range) {
      fetchHeaders['Range'] = req.headers.range
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

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', '*')

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

    const isLargeFile = contentLength && Number(contentLength) > 4500000 || /\.(mp4|mkv|mov|avi)$/i.test(targetUrl.pathname)
    if (isLargeFile && response.body) {
      if (typeof response.body.pipe === 'function') {
        response.body.pipe(res)
        return
      }
      try {
        const nodeStream = Readable.fromWeb(response.body)
        nodeStream.pipe(res)
        return
      } catch {
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
        res.end()
        return
      }
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
