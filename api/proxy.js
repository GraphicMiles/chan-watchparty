import { preflight, fail } from '../server-lib/http.js'
import { validateFetchUrl, isPrivateHost } from '../server-lib/ssrf.js'
import { checkRateLimit, clientKey } from '../server-lib/rateLimit.js'
import { probeAndFixO2TvUrl } from '../server-lib/o2tvResolver.js'
import { MkvRemuxStream, isMkvContentType, probeMkvVideoCodec } from '../server-lib/mkvRemux.js'

// ─── Vercel Hobby (~10s hard kill) ───────────────────────────────────────────
// Each invocation must finish under the plan limit. Large files are served as
// short byte-range CHUNKS; the browser re-requests the next range. Small files
// stream in one shot. MKV remux is only attempted for small files.
const HOBBY_MAX_DURATION_MS = 9_000
const UPSTREAM_CONNECT_MS = 3_500
const PLAYLIST_FETCH_MS = 4_000
const SMALL_FILE_BYTES = 8 * 1024 * 1024 // ≤8 MiB → full progressive stream
const CHUNK_BYTES = 1 * 1024 * 1024 // 1 MiB per large-file passthrough invocation
// Progressive MKV→fMP4 remux (the Chrome loophole): stream as many clusters as
// fit in Hobby time. Browser plays fMP4 from the first fragments even if the
// function ends early. Do NOT require the whole file to remux.
const REMUX_MAX_INPUT_BYTES = 80 * 1024 * 1024 // soft cap per invocation
const REMUX_DEADLINE_MS = 8_500

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

/** Parse `bytes=start-end` (end optional). Returns null if invalid / multi-range. */
function parseRangeHeader(rangeHeader) {
  if (!rangeHeader || typeof rangeHeader !== 'string') return null
  const m = rangeHeader.trim().match(/^bytes=(\d+)-(\d+)?$/i)
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] != null && m[2] !== '' ? Number(m[2]) : null
  if (!Number.isFinite(start) || start < 0) return null
  if (end != null && (!Number.isFinite(end) || end < start)) return null
  return { start, end }
}

/**
 * Decide the exact byte window this invocation will serve.
 * - Small files: honour client range fully, or whole file if none.
 * - Large / unknown size: clamp to CHUNK_BYTES so Hobby 10s never tries to
 *   pump an entire movie through one serverless function.
 */
function resolveServeWindow({ clientRange, totalSize, forceChunk }) {
  const isSmall = Number.isFinite(totalSize) && totalSize > 0 && totalSize <= SMALL_FILE_BYTES
  const shouldChunk = forceChunk || !isSmall

  if (!shouldChunk) {
    if (!clientRange) {
      return {
        start: 0,
        end: totalSize > 0 ? totalSize - 1 : null,
        totalSize,
        status: 200,
        chunked: false,
        isSmall: true,
      }
    }
    const end = clientRange.end != null
      ? clientRange.end
      : (totalSize > 0 ? totalSize - 1 : clientRange.start + CHUNK_BYTES - 1)
    return {
      start: clientRange.start,
      end,
      totalSize,
      status: 206,
      chunked: false,
      isSmall: true,
    }
  }

  // Large / unknown → always 206 chunk
  const start = clientRange?.start ?? 0
  let end
  if (clientRange?.end != null) {
    end = Math.min(clientRange.end, start + CHUNK_BYTES - 1)
  } else {
    end = start + CHUNK_BYTES - 1
  }
  if (Number.isFinite(totalSize) && totalSize > 0) {
    end = Math.min(end, totalSize - 1)
  }
  return {
    start,
    end,
    totalSize: Number.isFinite(totalSize) && totalSize > 0 ? totalSize : null,
    status: 206,
    chunked: true,
    isSmall: false,
  }
}

/**
 * Total size from Content-Length / Content-Range when present.
 */
function totalSizeFromUpstream(upstream) {
  const cr = upstream.headers.get('content-range')
  if (cr) {
    const m = cr.match(/\/(\d+)\s*$/)
    if (m) return Number(m[1])
  }
  const cl = upstream.headers.get('content-length')
  if (cl && /^\d+$/.test(cl)) return Number(cl)
  return null
}

/**
 * Stream a ReadableStream to the client with optional byte + time caps.
 * Returns { bytesSent, capped }.
 */
async function pipeStreamToResponse(reader, res, abortSignal, { maxBytes = Infinity, deadlineMs = HOBBY_MAX_DURATION_MS } = {}) {
  let bytesSent = 0
  let capped = false
  const started = Date.now()
  try {
    while (!abortSignal.aborted) {
      if (Date.now() - started >= deadlineMs) {
        capped = true
        break
      }
      const { done, value } = await reader.read()
      if (done) break

      let chunk = Buffer.from(value)
      if (bytesSent + chunk.length > maxBytes) {
        chunk = chunk.subarray(0, Math.max(0, maxBytes - bytesSent))
        capped = true
        if (!chunk.length) break
      }

      const ok = res.write(chunk)
      bytesSent += chunk.length

      if (bytesSent >= maxBytes) {
        capped = true
        break
      }

      if (!ok) {
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
  return { bytesSent, capped }
}

/**
 * Stream an upstream response, optionally clamping to a byte window for
 * large-file chunking under the Hobby 10s limit.
 */
async function streamDirectResponse(upstreamRes, req, res, options = {}) {
  const contentType = upstreamRes.headers.get('content-type') || ''
  const {
    window = null, // { start, end, totalSize, status, chunked }
    deadlineMs = HOBBY_MAX_DURATION_MS,
  } = options

  res.setHeader('Content-Type', contentType || 'application/octet-stream')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', cacheControlForType(contentType))
  // Hint clients / CDNs that large media is intentionally ranged
  if (window?.chunked) {
    res.setHeader('X-Chan-Proxy-Mode', 'chunked')
    res.setHeader('X-Chan-Proxy-Chunk-Bytes', String(CHUNK_BYTES))
  } else {
    res.setHeader('X-Chan-Proxy-Mode', 'full')
  }

  let maxBytes = Infinity
  if (window) {
    const length = window.end != null && window.start != null
      ? (window.end - window.start + 1)
      : null
    if (length != null && length > 0) {
      res.setHeader('Content-Length', String(length))
      maxBytes = length
    }
    if (window.status === 206) {
      const total = window.totalSize != null ? window.totalSize : '*'
      const endPart = window.end != null ? window.end : ''
      res.setHeader('Content-Range', `bytes ${window.start}-${endPart}/${total}`)
    }
    res.status(window.status === 206 ? 206 : 200)
  } else {
    const contentRange = upstreamRes.headers.get('content-range')
    const contentLength = upstreamRes.headers.get('content-length')
    if (contentRange) res.setHeader('Content-Range', contentRange)
    if (contentLength) res.setHeader('Content-Length', contentLength)
    res.status(upstreamRes.status === 206 ? 206 : 200)
  }

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const abortController = new AbortController()
  const onClose = () => { abortController.abort() }
  req.on('close', onClose)

  try {
    const reader = upstreamRes.body.getReader()
    await pipeStreamToResponse(reader, res, abortController.signal, {
      maxBytes,
      deadlineMs,
    })
    await reader.cancel().catch(() => {})
  } catch {
    // Stream error
  } finally {
    req.off('close', onClose)
    try { res.end() } catch { /* */ }
  }
}

/** Build common upstream headers (Referer / Origin / UA). */
function buildUpstreamHeaders(targetUrl, req, refererOverride) {
  const hostname = targetUrl.hostname.toLowerCase()
  let referer = targetUrl.origin
  if (refererOverride && /^https?:\/\//i.test(refererOverride) && refererOverride.length < 512) {
    referer = refererOverride
  } else if (hostname.includes('xvideos') || hostname.includes('cdn-xl') || hostname.includes('cdn.xh') || hostname.includes('xvideos-cdn')) {
    referer = 'https://www.xvideos.com/'
  } else if (hostname.includes('pornhub') || hostname.includes('phncdn') || hostname.includes('pornhubpremium')) {
    referer = 'https://www.pornhub.com/'
  } else if (hostname.includes('spankbang') || hostname.includes('sb-cd') || hostname.includes('spankcdn') || hostname.includes('spankbang.party') || hostname.includes('spankbang.com')) {
    referer = 'https://spankbang.party/'
  } else if (hostname.includes('dood') || hostname.includes('doodcdn') || hostname.includes('ds2play') || hostname.includes('d0000d')) {
    referer = 'https://dood.li/'
  } else if (hostname.includes('downloadwella') || hostname.includes('fsmc') || (hostname.includes('download.') && hostname.includes('wella'))) {
    referer = 'https://downloadwella.com/'
  } else if (hostname.includes('kissorgrab') || hostname.includes('meetdownload')) {
    referer = 'https://meetdownload.com/'
  } else if (hostname.includes('wideshares')) {
    referer = 'https://wideshares.org/'
  } else if (hostname.includes('np-downloader') || hostname.includes('wildshare') || hostname.includes('silversurfer') || hostname.includes('naijaprey')) {
    referer = 'https://www.naijaprey.tv/'
  } else if (hostname.includes('koyeb.app') || hostname.includes('maxcinema')) {
    referer = 'https://www.maxcinema.name.ng/'
  } else if (hostname.includes('o2tv')) {
    referer = 'http://d6.o2tv.org/'
  }

  const upstreamHeaders = {
    'User-Agent': UPSTREAM_UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer,
    ...(hostname.includes('phncdn') || hostname.includes('pornhub')
      ? { Origin: 'https://www.pornhub.com' }
      : hostname.includes('spankbang') || hostname.includes('sb-cd') || hostname.includes('spankcdn')
        ? { Origin: 'https://spankbang.party' }
        : hostname.includes('downloadwella') || hostname.includes('fsmc')
          ? { Origin: 'https://downloadwella.com' }
          : hostname.includes('koyeb.app') || hostname.includes('maxcinema')
            ? { Origin: 'https://www.maxcinema.name.ng' }
            : {}),
  }

  return { upstreamHeaders, hostname, referer }
}

async function fetchUpstream(url, headers, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers,
      signal: controller.signal,
    })
    return response
  } finally {
    clearTimeout(timer)
  }
}

export default async function handler(req, res) {
  if (preflight(req, res, { methods: ['GET', 'HEAD', 'OPTIONS'] })) return
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed')

  // --- Rate limiting (IP-based, since browser <video> can't send Bearer) ---
  const ip = clientKey(req)
  const rl = await checkRateLimit(`proxy:${ip}`, { limit: 180, windowMs: 60_000 })
  if (!rl.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
    res.end(JSON.stringify({ success: false, error: 'Too many proxy requests — slow down' }))
    return
  }

  try {
    const rawUrl = req.query?.url
    if (!rawUrl) return fail(res, 400, 'Missing url query parameter')
    if (rawUrl.length > 2048) return fail(res, 400, 'URL too long')

    const targetUrl = validateProxyUrl(rawUrl)

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type, X-Chan-Proxy-Mode, X-Chan-Proxy-Chunk-Bytes')

    const refererOverride = typeof req.query?.referer === 'string' ? req.query.referer : ''
    const { upstreamHeaders, hostname } = buildUpstreamHeaders(targetUrl, req, refererOverride)

    const clientRange = parseRangeHeader(req.headers.range || '')
    const isTinyRangeProbe = clientRange
      && clientRange.start === 0
      && clientRange.end != null
      && clientRange.end <= 16

    // ─── Early m3u8 detection by URL path (avoids streaming a playlist) ───
    const isM3u8ByPath = /\.m3u8(?:\?|#|$)/i.test(targetUrl.pathname)

    if (isM3u8ByPath) {
      let response
      try {
        response = await fetchUpstream(targetUrl.href, upstreamHeaders, PLAYLIST_FETCH_MS)
      } catch (err) {
        if (err.name === 'AbortError') return fail(res, 504, 'Playlist fetch timed out (Hobby 10s budget)')
        throw err
      }
      if (!response.ok) return fail(res, response.status, `Upstream returned ${response.status}`)

      const finalUrl = response.url || targetUrl.href
      let text = await response.text()
      text = text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x2F;/g, '/').replace(/&#47;/g, '/')
      const rewritten = text.split('\n').map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return line
        if (trimmed.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/gi, (_, keyUri) => {
            try {
              const decodedKey = keyUri.replace(/&amp;/g, '&').replace(/&#x2F;/g, '/')
              const absKey = new URL(decodedKey, finalUrl).href
              return `URI="/api/proxy?url=${encodeURIComponent(absKey)}"`
            } catch {
              return `URI="${keyUri}"`
            }
          })
        }
        try {
          const absoluteUri = new URL(trimmed, finalUrl).href
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

    // ─── Size probe for large-file chunking (only when client sent no Range) ───
    // HEAD first so we know Content-Length before committing to a body stream.
    // If HEAD fails, we fall through and treat unknown size as "large" (chunk).
    let knownTotalSize = null
    let headSupportsRanges = true
    if (!clientRange && req.method === 'GET') {
      try {
        const headRes = await fetchUpstream(targetUrl.href, { ...upstreamHeaders }, Math.min(2000, UPSTREAM_CONNECT_MS))
        if (headRes.ok || headRes.status === 206) {
          const cl = headRes.headers.get('content-length')
          if (cl && /^\d+$/.test(cl)) knownTotalSize = Number(cl)
          const ar = (headRes.headers.get('accept-ranges') || '').toLowerCase()
          if (ar === 'none') headSupportsRanges = false
          // Drain / cancel head body if any
          await headRes.arrayBuffer().catch(() => {})
        }
      } catch {
        // HEAD unsupported or slow — continue without known size
      }
    }

    // Decide window before the real fetch so we can send a tight Range upstream.
    const forceChunk = req.query?.chunk === '1'
    let window = resolveServeWindow({
      clientRange,
      totalSize: knownTotalSize,
      forceChunk,
    })

    // Tiny probes always stay tiny (preflight)
    if (isTinyRangeProbe) {
      window = {
        start: 0,
        end: clientRange.end,
        totalSize: knownTotalSize,
        status: 206,
        chunked: false,
        isSmall: true,
      }
    }

    // Attach Range for chunked / partial requests so upstream only sends what we need.
    const requestHeaders = { ...upstreamHeaders }
    if (window.start != null && (window.chunked || window.status === 206 || clientRange)) {
      const endPart = window.end != null ? window.end : ''
      requestHeaders.Range = `bytes=${window.start}-${endPart}`
    }

    const isKeyHost = hostname.includes('koyeb') || hostname.includes('wildshare') || hostname.includes('silversurfer') || hostname.includes('kissorgrab') || hostname.includes('downloadwella') || hostname.includes('fsmc')
    if (isKeyHost) {
      console.log(`Proxy fetch: ${targetUrl.hostname} range=${requestHeaders.Range || 'none'} remux=${req.query?.remux || 'auto'} chunked=${window.chunked}`)
    }

    let upstream
    try {
      upstream = await fetchUpstream(targetUrl.href, requestHeaders, UPSTREAM_CONNECT_MS)
    } catch (err) {
      if (err.name === 'AbortError') {
        return fail(res, 504, 'Upstream fetch timed out — CDN too slow for Vercel Hobby (10s). Try another source.')
      }
      throw err
    }

    if (isKeyHost) {
      console.log(`Proxy response: ${targetUrl.hostname} status=${upstream.status} type=${upstream.headers.get('content-type') || 'none'}`)
    }

    // If our Range was rejected (200 full body on a large file), re-clamp with a hard byte cap below.
    if (!upstream.ok && upstream.status !== 206) {
      if (upstream.status === 404 && targetUrl.hostname.includes('o2tv.org')) {
        try {
          const fixedUrl = await probeAndFixO2TvUrl(targetUrl.href)
          if (fixedUrl !== targetUrl.href) {
            const retryRes = await fetchUpstream(fixedUrl, requestHeaders, UPSTREAM_CONNECT_MS)
            if (retryRes.ok || retryRes.status === 206) {
              const retryContentType = retryRes.headers.get('content-type') || ''
              if (/^text\/html/i.test(retryContentType)) {
                await retryRes.arrayBuffer().catch(() => {})
                return fail(res, 502, 'Stream server returned a web page instead of video')
              }
              const total = totalSizeFromUpstream(retryRes) ?? knownTotalSize
              const retryWindow = resolveServeWindow({
                clientRange: parseRangeHeader(requestHeaders.Range || '') || clientRange,
                totalSize: total,
                forceChunk,
              })
              return streamDirectResponse(retryRes, req, res, { window: retryWindow })
            }
          }
        } catch {
          // fall through
        }
      }
      // Some CDNs return 200 ignoring Range — still serve with byte cap below.
      if (upstream.status !== 200) {
        return fail(res, upstream.status, `Upstream returned HTTP ${upstream.status}`)
      }
    }

    // Refine total size from the actual response
    const responseTotal = totalSizeFromUpstream(upstream)
    if (responseTotal != null) {
      knownTotalSize = responseTotal
      // Recompute window end clamp against real total
      if (window.end != null && knownTotalSize > 0) {
        window = {
          ...window,
          end: Math.min(window.end, knownTotalSize - 1),
          totalSize: knownTotalSize,
        }
      } else if (window.totalSize == null && knownTotalSize != null) {
        window = { ...window, totalSize: knownTotalSize }
      }
      // If we thought it was large but it's actually small and client wanted full file, switch mode
      if (!clientRange && !forceChunk && knownTotalSize <= SMALL_FILE_BYTES && upstream.status === 200) {
        window = {
          start: 0,
          end: knownTotalSize - 1,
          totalSize: knownTotalSize,
          status: 200,
          chunked: false,
          isSmall: true,
        }
      }
    }

    // If upstream ignored Range and returned 200 with a huge body, force chunked cap.
    if (upstream.status === 200 && !window.isSmall) {
      window = {
        start: window.start ?? 0,
        end: (window.start ?? 0) + CHUNK_BYTES - 1,
        totalSize: knownTotalSize,
        status: 206,
        chunked: true,
        isSmall: false,
      }
      if (knownTotalSize != null) {
        window.end = Math.min(window.end, knownTotalSize - 1)
      }
    }

    // Align window with upstream 206 content-range when present
    if (upstream.status === 206) {
      const cr = upstream.headers.get('content-range')
      const m = cr && cr.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i)
      if (m) {
        const uStart = Number(m[1])
        const uEnd = Number(m[2])
        const uTotal = m[3] === '*' ? knownTotalSize : Number(m[3])
        // Cap to CHUNK if large
        let end = uEnd
        if (!window.isSmall && (end - uStart + 1) > CHUNK_BYTES) {
          end = uStart + CHUNK_BYTES - 1
        }
        window = {
          start: uStart,
          end,
          totalSize: Number.isFinite(uTotal) ? uTotal : knownTotalSize,
          status: 206,
          chunked: !window.isSmall,
          isSmall: window.isSmall,
        }
      }
    }

    const contentType = upstream.headers.get('content-type') || ''

    // ─── Detect m3u8 by Content-Type (after redirect) ───
    const isM3u8ByType = /(?:application\/vnd\.apple\.mpegurl|audio\/mpegurl|application\/x-mpegurl|text\/vnd\.apple\.mpegurl)/i.test(contentType)
    if (isM3u8ByType) {
      let text = await upstream.text()
      text = text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x2F;/g, '/').replace(/&#47;/g, '/')
      const finalUrl = upstream.url || targetUrl.href
      const rewritten = text.split('\n').map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return line
        if (trimmed.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/gi, (_, keyUri) => {
            try {
              const decodedKey = keyUri.replace(/&amp;/g, '&').replace(/&#x2F;/g, '/')
              const absKey = new URL(decodedKey, finalUrl).href
              return `URI="/api/proxy?url=${encodeURIComponent(absKey)}"`
            } catch {
              return `URI="${keyUri}"`
            }
          })
        }
        try {
          const absoluteUri = new URL(trimmed, finalUrl).href
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
    if (/^text\/html/i.test(contentType)) {
      let snippet = ''
      try {
        const text = await upstream.text()
        snippet = text.replace(/\s+/g, ' ').slice(0, 180)
      } catch {
        await upstream.arrayBuffer().catch(() => {})
      }
      const hint = hostname.includes('downloadwella') || hostname.includes('fsmc')
        ? 'Download link may be expired or missing Referer — re-resolve the page and try again.'
        : hostname.includes('phncdn') || hostname.includes('pornhub')
          ? 'PornHub CDN rejected the request — try resolving the page again.'
          : 'channel may be offline or the link expired'
      console.error('Proxy HTML-instead-of-video:', targetUrl.hostname, snippet)
      return fail(res, 502, `Stream server returned a web page instead of video — ${hint}`)
    }

    if (/^application\/json/i.test(contentType) && !/\.json(\?|#|$)/i.test(targetUrl.pathname)) {
      await upstream.arrayBuffer().catch(() => {})
      return fail(res, 502, 'Stream server returned JSON instead of video — link may be expired')
    }

    // ─── MKV Remuxing (Chrome loophole — restored from ~Jul 15 behavior) ───
    // Chrome cannot play Matroska. The working path was:
    //   remux=1 → ignore client Range → re-fetch from byte 0 → stream fMP4
    //   until the Hobby deadline. The browser starts playback from early
    //   fragments even if the serverless function dies mid-file.
    // Chunked RAW MKV passthrough does NOT work in Chrome — never skip remux
    // just because the file is large or the client sent Range.
    const wantsRemux = req.query?.remux === '1' || isMkvContentType(contentType)
    const rangeHeader = req.headers.range || ''
    // Tiny probes stay probes; everything else with remux=1 enters remux path.
    const needsRemux = wantsRemux && !isTinyRangeProbe

    if (wantsRemux && isTinyRangeProbe) {
      try {
        const reader = upstream.body.getReader()
        const { value: firstChunk, done } = await reader.read()
        await reader.cancel().catch(() => {})
        if (done || !firstChunk) {
          return fail(res, 502, 'Empty response from upstream')
        }
        const firstBytes = Buffer.from(firstChunk)
        const looksMkv = firstBytes[0] === 0x1A
        res.setHeader('Content-Type', looksMkv ? 'video/x-matroska' : (contentType || 'application/octet-stream'))
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Cache-Control', cacheControlForType(contentType))
        res.setHeader('Content-Length', String(Math.min(firstBytes.length, 2)))
        res.setHeader('X-Chan-Proxy-Mode', 'probe')
        res.status(206)
        res.setHeader('Content-Range', `bytes 0-1/${knownTotalSize != null ? knownTotalSize : '*'}`)
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        res.end(firstBytes.subarray(0, 2))
        return
      } catch (probeErr) {
        console.error('Proxy range-probe error:', probeErr.message)
        return fail(res, 502, 'Could not probe upstream video')
      }
    }

    if (wantsRemux && !needsRemux) {
      // Only tiny Range probes skip remux (handled above).
      console.log(
        `Proxy: remux skipped for probe host=${hostname} size=${knownTotalSize ?? 'unknown'} range=${rangeHeader || 'none'}`,
      )
    }

    if (needsRemux) {
      // Always remux from byte 0 (historical working behavior). Client Range is ignored.
      let mkvUpstream = upstream
      const hadRange = Boolean(req.headers.range) || upstream.status === 206 || Boolean(upstream.headers.get('content-range'))
      // Also re-fetch when we previously forced a chunked Range on the upstream request
      const forcedChunkRange = Boolean(requestHeaders.Range)
      if (hadRange || forcedChunkRange) {
        await upstream.body?.cancel().catch(() => {})
        const freshHeaders = { ...upstreamHeaders }
        delete freshHeaders.Range
        try {
          mkvUpstream = await fetchUpstream(targetUrl.href, freshHeaders, UPSTREAM_CONNECT_MS)
        } catch (err) {
          if (err.name === 'AbortError') return fail(res, 504, 'Upstream fetch timed out during remux re-fetch')
          throw err
        }
        if (!mkvUpstream.ok && mkvUpstream.status !== 206) {
          return fail(res, mkvUpstream.status, `Upstream returned HTTP ${mkvUpstream.status}`)
        }
      }

      try {
        const reader = mkvUpstream.body.getReader()
        const { value: firstChunk, done } = await reader.read()
        if (done || !firstChunk) {
          await reader.cancel().catch(() => {})
          return fail(res, 502, 'Empty response from upstream')
        }
        const firstBytes = Buffer.from(firstChunk)
        if (firstBytes[0] !== 0x1A) {
          await reader.cancel().catch(() => {})
          console.log('Proxy: remux=1 but data is not MKV — passthrough')
          const refetch = await fetchUpstream(targetUrl.href, requestHeaders, UPSTREAM_CONNECT_MS)
          if (!refetch.ok && refetch.status !== 206) {
            return fail(res, refetch.status, `Upstream returned HTTP ${refetch.status}`)
          }
          return streamDirectResponse(refetch, req, res, { window })
        }

        let queued = firstBytes
        const probingReader = {
          read: async () => {
            if (queued) {
              const chunk = queued
              queued = null
              return { value: chunk, done: false }
            }
            return reader.read()
          },
          cancel: (reason) => reader.cancel(reason),
        }

        let videoCodec = null
        try {
          videoCodec = await probeMkvVideoCodec(probingReader, { maxBytes: 131072, timeoutMs: 2000 })
        } catch (probeErr) {
          console.error('MKV codec probe error:', probeErr.message)
        }

        const isHevc = videoCodec && /HEVC|H\.265|V_MPEGH/i.test(videoCodec)
        if (isHevc) {
          console.log('Proxy: HEVC MKV — passthrough', hostname, videoCodec)
          await reader.cancel().catch(() => {})
          const refetch = await fetchUpstream(targetUrl.href, requestHeaders, UPSTREAM_CONNECT_MS)
          if (!refetch.ok && refetch.status !== 206) {
            return fail(res, refetch.status, `Upstream returned HTTP ${refetch.status}`)
          }
          return streamDirectResponse(refetch, req, res, { window })
        }

        res.setHeader('Content-Type', 'video/mp4')
        res.setHeader('Cache-Control', cacheControlForType('video/mp4'))
        // Progressive remux is not seekable via HTTP Range (same as Jul 15 loophole)
        res.setHeader('Accept-Ranges', 'none')
        res.setHeader('X-Chan-Proxy-Mode', 'remux-progressive')
        res.status(200)

        if (req.method === 'HEAD') {
          await reader.cancel().catch(() => {})
          res.end()
          return
        }

        const remuxer = new MkvRemuxStream()
        const abortController = new AbortController()
        let inputBytes = firstBytes.length
        const remuxDeadline = setTimeout(() => {
          console.error('Proxy: MKV remux Hobby deadline — ending early')
          abortController.abort()
          try { remuxer.destroy() } catch { /* */ }
          try { res.end() } catch { /* */ }
        }, REMUX_DEADLINE_MS)
        const onClose = () => {
          abortController.abort()
          remuxer.destroy()
          clearTimeout(remuxDeadline)
        }
        req.on('close', onClose)

        remuxer.on('error', (err) => {
          console.error('MKV remux error:', err.message)
          try { res.end() } catch { /* */ }
        })
        remuxer.on('data', (chunk) => {
          if (!abortController.signal.aborted) res.write(chunk)
        })
        remuxer.on('end', () => {
          try { res.end() } catch { /* */ }
        })

        const feedLoop = async () => {
          try {
            if (queued) {
              if (!remuxer.destroyed) remuxer.write(queued)
              queued = null
            }
            while (!abortController.signal.aborted) {
              const { done: d, value } = await reader.read()
              if (d) break
              const buf = Buffer.from(value)
              inputBytes += buf.length
              if (!remuxer.destroyed) remuxer.write(buf)
              // Hard cap remux input so we never chew the whole Hobby budget
              if (inputBytes >= REMUX_MAX_INPUT_BYTES) {
                console.log('Proxy: remux input byte cap reached')
                break
              }
            }
          } catch {
            // interrupted
          } finally {
            if (!remuxer.destroyed) remuxer.end()
            await reader.cancel().catch(() => {})
            clearTimeout(remuxDeadline)
          }
        }

        await feedLoop()
        req.off('close', onClose)
        clearTimeout(remuxDeadline)
        return
      } catch (peekErr) {
        console.error('Proxy MKV peek error:', peekErr.message)
        return fail(res, 502, 'MKV remux failed — could not read stream header')
      }
    }

    // ─── Stream (full for small, chunked for large) ───
    // Browser <video> sees Accept-Ranges + Content-Range and requests the next
    // 1 MiB window automatically. Each window is a new Hobby-safe invocation.
    return streamDirectResponse(upstream, req, res, {
      window,
      deadlineMs: HOBBY_MAX_DURATION_MS,
    })
  } catch (err) {
    console.error('Proxy error:', err)
    return fail(res, 502, 'Upstream request failed')
  }
}
