import { preflight, fail } from '../server-lib/http.js'
import { validateFetchUrl, isPrivateHost } from '../server-lib/ssrf.js'
import { checkRateLimit, clientKey } from '../server-lib/rateLimit.js'
import { probeAndFixO2TvUrl } from '../server-lib/o2tvResolver.js'
import { MkvRemuxStream, isMkvContentType, probeMkvVideoCodec } from '../server-lib/mkvRemux.js'

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

/**
 * Stream an upstream response directly to the client.
 * Used as a fallback when MKV remux is skipped or after re-fetch.
 */
async function streamDirectResponse(upstreamRes, req, res) {
  const contentType = upstreamRes.headers.get('content-type') || ''
  const contentRange = upstreamRes.headers.get('content-range')
  const contentLength = upstreamRes.headers.get('content-length')

  res.setHeader('Content-Type', contentType || 'application/octet-stream')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', cacheControlForType(contentType))

  if (contentRange) res.setHeader('Content-Range', contentRange)
  if (contentLength) res.setHeader('Content-Length', contentLength)

  res.status(upstreamRes.status === 206 ? 206 : 200)

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const abortController = new AbortController()
  const onClose = () => { abortController.abort() }
  req.on('close', onClose)

  try {
    const reader = upstreamRes.body.getReader()
    await pipeStreamToResponse(reader, res, abortController.signal)
    await reader.cancel().catch(() => {})
  } catch {
    // Stream error
  } finally {
    req.off('close', onClose)
    try { res.end() } catch { /* */ }
  }
}

export default async function handler(req, res) {
  if (preflight(req, res, { methods: ['GET', 'HEAD', 'OPTIONS'] })) return
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed')

  // --- Rate limiting (IP-based, since browser <video> can't send Bearer) ---
  const ip = clientKey(req)
  const rl = await checkRateLimit(`proxy:${ip}`, { limit: 120, windowMs: 60_000 })
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

    // ─── Build upstream request headers ───
    // Many CDNs require a specific Referer (provider site), not the CDN origin.
    // Optional override: /api/proxy?url=...&referer=https://example.com/
    let referer = targetUrl.origin
    const hostname = targetUrl.hostname.toLowerCase()
    const refererOverride = typeof req.query?.referer === 'string' ? req.query.referer : ''
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
      // DownloadWella hotlink tokens require the download host as Referer.
      // Without it the CDN returns an HTML error page → browser "format error" / 502.
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
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': referer,
      // Some CDNs also check Origin
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

      // Use the final URL after redirects so relative playlist entries resolve correctly
      const finalUrl = response.url || targetUrl.href
      let text = await response.text()
      // Decode HTML entities that may appear in m3u8 playlists (common with PornHub/phncdn CDNs)
      text = text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x2F;/g, '/').replace(/&#47;/g, '/')
      const rewritten = text.split('\n').map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return line
        if (trimmed.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/gi, (_, keyUri) => {
            try {
              // Also decode HTML entities inside URI attributes
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

    // ─── Fetch from upstream (video, image, segment, anything else) ───
    const isKeyHost = hostname.includes('koyeb') || hostname.includes('wildshare') || hostname.includes('silversurfer') || hostname.includes('kissorgrab') || hostname.includes('downloadwella') || hostname.includes('fsmc')
    if (isKeyHost) {
      console.log(`Proxy upstream fetch: ${targetUrl.hostname} ${targetUrl.pathname.slice(0, 80)} remux=${req.query?.remux || 'auto'}`)
    }
    const upstream = await fetch(targetUrl.href, {
      redirect: 'follow',
      headers: upstreamHeaders,
    })
    if (isKeyHost) {
      console.log(`Proxy upstream response: ${targetUrl.hostname} status=${upstream.status} type=${upstream.headers.get('content-type') || 'none'}`)
    }

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
      let text = await upstream.text()
      // Decode HTML entities that may appear in m3u8 playlists
      text = text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x2F;/g, '/').replace(/&#47;/g, '/')
      // Use the final URL after redirects so relative playlist entries resolve correctly
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
    // (dead IPTV channels, o2tv error pages, expired downloadwella tokens, etc.)
    if (/^text\/html/i.test(contentType)) {
      // Consume a small sample for diagnostics, then free the connection
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

    // Also reject JSON error bodies disguised as application/json
    if (/^application\/json/i.test(contentType) && !/\.json(\?|#|$)/i.test(targetUrl.pathname)) {
      await upstream.arrayBuffer().catch(() => {})
      return fail(res, 502, 'Stream server returned JSON instead of video — link may be expired')
    }

    // ─── MKV Remuxing: convert Matroska to fMP4 on-the-fly ───
    // Browsers can't play MKV containers natively. This remuxes the same
    // video/audio data into a fragmented MP4 container (no re-encoding).
    // Only trigger remuxing when EXPLICITLY requested via remux=1 query param,
    // or when the upstream Content-Type is definitively Matroska.
    // Do NOT auto-detect from URL patterns — that causes false positives on IPTV etc.
    const needsRemux = req.query?.remux === '1' || isMkvContentType(contentType)

    if (needsRemux) {
      // For MKV files, we must fetch from the start (no Range header)
      // because the remuxer needs sequential MKV data from the beginning.
      let mkvUpstream = upstream
      if (req.headers.range && (upstream.status === 206 || upstream.headers.get('content-range'))) {
        // Re-fetch from the beginning without Range
        await upstream.body?.cancel().catch(() => {})
        const freshHeaders = { ...upstreamHeaders }
        delete freshHeaders.Range
        mkvUpstream = await fetch(targetUrl.href, { redirect: 'follow', headers: freshHeaders })
        if (!mkvUpstream.ok && mkvUpstream.status !== 206) {
          return fail(res, mkvUpstream.status, `Upstream returned HTTP ${mkvUpstream.status}`)
        }
      }

      try {
        const reader = mkvUpstream.body.getReader()

        // Verify MKV magic (EBML header starts with 0x1A) and probe the video codec
        // before committing to a 200 response. This lets us return a clear error for
        // HEVC/H.265 sources instead of silently sending a broken MP4 stream.
        const { value: firstChunk, done } = await reader.read()
        if (done || !firstChunk) {
          await reader.cancel().catch(() => {})
          return fail(res, 502, 'Empty response from upstream')
        }
        const firstBytes = Buffer.from(firstChunk)
        if (firstBytes[0] !== 0x1A) {
          await reader.cancel().catch(() => {})
          console.log('Proxy: remux=1 requested but data is not MKV, falling through to passthrough')
          // Re-fetch so the normal passthrough path below has a fresh body.
          const refetch = await fetch(targetUrl.href, { redirect: 'follow', headers: upstreamHeaders })
          if (!refetch.ok && refetch.status !== 206) {
            return fail(res, refetch.status, `Upstream returned HTTP ${refetch.status}`)
          }
          return streamDirectResponse(refetch, req, res)
        }

        // Wrap the reader so the probe can consume from the start (including the
        // first chunk we already read), then continue into the remuxer.
        let probeDone = false
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
          videoCodec = await probeMkvVideoCodec(probingReader, { maxBytes: 524288, timeoutMs: 5000 })
        } catch (probeErr) {
          console.error('MKV codec probe error:', probeErr.message)
        }

        const isHevc = videoCodec && /HEVC|H\.265|V_MPEGH/i.test(videoCodec)
        if (isHevc) {
          await reader.cancel().catch(() => {})
          console.error('Proxy HEVC rejected:', targetUrl.hostname, videoCodec)
          return fail(res, 502, 'This source uses HEVC/H.265 video, which most browsers cannot play. Try a different source or device.')
        }

        // Commit to a 200 MP4 response now that we know the codec is supported.
        res.setHeader('Content-Type', 'video/mp4')
        res.setHeader('Cache-Control', cacheControlForType('video/mp4'))
        res.status(200)

        if (req.method === 'HEAD') {
          await reader.cancel().catch(() => {})
          res.end()
          return
        }

        const remuxer = new MkvRemuxStream()
        const abortController = new AbortController()
        const onClose = () => { abortController.abort(); remuxer.destroy() }
        req.on('close', onClose)

        remuxer.on('error', (err) => {
          console.error('MKV remux error:', err.message)
          try { res.end() } catch { /* */ }
        })

        remuxer.on('data', (chunk) => {
          if (!abortController.signal.aborted) {
            res.write(chunk)
          }
        })

        remuxer.on('end', () => {
          try { res.end() } catch { /* */ }
        })

        // Feed any leftover bytes the probe did not consume, then continue reading.
        const feedLoop = async () => {
          try {
            // First feed the queued chunk if the probe left it
            if (queued) {
              if (!remuxer.destroyed) remuxer.write(queued)
              queued = null
            }
            while (!abortController.signal.aborted) {
              const { done, value } = await reader.read()
              if (done) break
              if (!remuxer.destroyed) {
                remuxer.write(Buffer.from(value))
              }
            }
          } catch {
            // Stream interrupted
          } finally {
            if (!remuxer.destroyed) remuxer.end()
            await reader.cancel().catch(() => {})
          }
        }

        await feedLoop()
        req.off('close', onClose)
        return

      } catch (peekErr) {
        console.error('Proxy MKV peek error:', peekErr.message)
        return fail(res, 502, 'MKV remux failed — could not read stream header')
      }
    }

    // ─── Stream the response directly to the client ───
    // No buffering. Data flows from upstream → proxy → browser in real-time.
    // The browser's <video> element controls the flow via Range requests.
    // If the function times out (10s Hobby / 60s Pro), the browser simply
    // reconnects with a new Range request — this is standard HTTP behaviour.
    return streamDirectResponse(upstream, req, res)
  } catch (err) {
    console.error('Proxy error:', err)
    return fail(res, 502, 'Upstream request failed')
  }
}
