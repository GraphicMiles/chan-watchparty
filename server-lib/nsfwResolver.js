/**
 * NSFW Video URL Resolver
 *
 * Given a provider page URL (xvideos, pornhub, spankbang), fetches the page HTML
 * and extracts the actual direct video URL (.mp4 / .m3u8) that the provider's
 * player embeds. This allows NSFW results to play directly in Chan rooms instead
 * of showing a broken video player that can't render an HTML page.
 *
 * Important: These resolvers do NOT bypass login, paywall, CAPTCHA, or anti-bot
 * controls. They extract video URLs from publicly accessible page source.
 * Providers may change their page structure at any time.
 *
 * CRITICAL: NSFW video CDNs typically require specific Referer headers.
 * The browser can't set these directly (CORS + Referer policy), so all
 * resolved video URLs MUST be routed through /api/proxy which sends
 * the correct Referer. Without the proxy, the browser gets 403/format errors.
 */

import * as cheerio from 'cheerio'

const RESOLVE_TIMEOUT_MS = 8000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

/**
 * Decode HTML entities in a string. JSON.parse does NOT decode HTML entities,
 * so URLs extracted from page source (via regex or JSON) can contain &amp; &quot; etc.
 * This must be applied before using any URL extracted from HTML.
 */
function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/&#47;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
}

/**
 * Clean and validate a video URL extracted from HTML source.
 * Decodes HTML entities, trims whitespace, and validates the URL.
 */
function cleanExtractedUrl(raw) {
  if (!raw || typeof raw !== 'string') return null
  let url = decodeHtmlEntities(raw.trim())
  // Some JS-escaped URLs use \/ instead of /
  url = url.replace(/\\\//g, '/')
  // Remove trailing backslash escapes
  url = url.replace(/\\["']/g, '')
  if (!/^https?:\/\//i.test(url)) {
    // Try prepending https: for protocol-relative URLs
    if (url.startsWith('//')) url = 'https:' + url
    else return null
  }
  return url
}

async function fetchHtml(pageUrl, referer) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)
  try {
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: referer || pageUrl,
      },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(url, referer) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: referer || 'https://www.pornhub.com/',
        Origin: 'https://www.pornhub.com',
        'X-Requested-With': 'XMLHttpRequest',
      },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    
    // Check if response is HTML (PornHub returns login/anti-bot pages)
    if (text.trim().startsWith('<') || text.includes('<!DOCTYPE')) {
      console.log('PornHub remote fetch returned HTML instead of JSON — likely blocked by anti-bot')
      return null
    }
    
    try {
      return JSON.parse(text)
    } catch {
      // Sometimes the body is a JS-ish array/object without strict JSON
      const cleaned = text
        .replace(/^\s*while\s*\(\s*1\s*\)\s*;?\s*/, '')
        .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')
        .replace(/'/g, '"')
      return JSON.parse(cleaned)
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Score a quality label for playback viability.
 * Prefer mid-tier (480–720): seekable enough, smaller than 1080/4K, better than 240.
 */
function qualityScore(q) {
  const n = parseInt(String(q ?? '').replace(/[^\d]/g, ''), 10)
  if (!Number.isFinite(n) || n <= 0) return 50
  // Sweet spot ~720, then 480, then 360; penalize ultra-high (bandwidth) and tiny (looks bad)
  if (n >= 700 && n <= 800) return 100
  if (n >= 450 && n < 700) return 90
  if (n >= 300 && n < 450) return 70
  if (n > 800 && n <= 1100) return 60
  if (n > 1100) return 30
  return 40
}

function defUrl(d) {
  return cleanExtractedUrl(d?.videoUrl || d?.url || d?.link || '')
}

function isHlsDef(d) {
  const url = defUrl(d) || ''
  const fmt = String(d?.format || d?.type || '').toLowerCase()
  return fmt === 'hls' || fmt === 'm3u8' || /\.m3u8(\?|#|$)/i.test(url) || /\/hls\//i.test(url)
}

function isPlayableDef(d) {
  const url = defUrl(d)
  if (!url || !/^https?:\/\//i.test(url)) return false
  // get_media / remote JSON endpoints are not playable files
  if (/get_media/i.test(url) && !/\.(mp4|m3u8)(\?|#|$)/i.test(url)) return false
  if (d?.remote === true && !isHlsDef(d) && !/\.(mp4|m3u8)(\?|#|$)/i.test(url)) return false
  return true
}

function pickBestDefinition(definitions) {
  if (!Array.isArray(definitions) || !definitions.length) return null

  const playable = definitions.filter(isPlayableDef)
  if (!playable.length) return null

  // Prefer HLS (m3u8) — segmented streams are Range/seek friendly.
  // Progressive PH MP4 often has moov-at-end → unseekable until fully downloaded.
  const hls = playable
    .filter(isHlsDef)
    .sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality)
      || (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))

  if (hls.length) {
    const best = hls[0]
    return {
      videoUrl: defUrl(best),
      type: 'hls',
      quality: best.quality,
      seekable: true,
    }
  }

  // Progressive MP4: prefer mid quality (480–720), never force 1080+ first
  const mp4Direct = playable
    .filter((d) => {
      const url = defUrl(d) || ''
      const fmt = String(d.format || '').toLowerCase()
      if (d.remote === true) return false
      if (/get_media/i.test(url)) return false
      return fmt === 'mp4' || /\.mp4(\?|#|$)/i.test(url)
    })
    .sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality))

  if (mp4Direct.length) {
    const best = mp4Direct[0]
    return {
      videoUrl: defUrl(best),
      type: 'mp4',
      quality: best.quality,
      // Progressive CDN MP4 may still be poorly seekable if moov is at end
      seekable: false,
    }
  }

  // Any remaining direct media URL
  const anyMedia = playable
    .filter((d) => !/get_media/i.test(defUrl(d) || ''))
    .sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality))

  if (anyMedia.length) {
    const best = anyMedia[0]
    const url = defUrl(best)
    const hlsType = /\.m3u8/i.test(url || '')
    return {
      videoUrl: url,
      type: hlsType ? 'hls' : 'mp4',
      quality: best.quality,
      seekable: hlsType,
    }
  }

  return null
}

/**
 * PornHub often stores remote:true mediaDefinitions whose videoUrl is a
 * get_media JSON endpoint, not a playable file. Fetch and flatten those.
 */
async function expandRemoteDefinitions(definitions, pageUrl) {
  if (!Array.isArray(definitions)) return []
  const expanded = []

  for (const def of definitions) {
    if (!def) continue
    const url = def.videoUrl || def.url
    if (!url || typeof url !== 'string') continue

    const isRemoteJson = def.remote === true
      || /get_media/i.test(url)
      || (/pornhub\.com/i.test(url) && !/\.(mp4|m3u8)(\?|#|$)/i.test(url))

    if (!isRemoteJson) {
      expanded.push(def)
      continue
    }

    try {
      const remote = await fetchJson(url, pageUrl)
      if (!remote) {
        // fetchJson returned null (HTML response or parse error) — skip this remote def
        console.log('Skipping remote definition — fetch returned null')
        continue
      }
      if (Array.isArray(remote)) {
        for (const item of remote) expanded.push(item)
      } else if (typeof remote === 'object') {
        if (Array.isArray(remote.mediaDefinitions)) {
          for (const item of remote.mediaDefinitions) expanded.push(item)
        } else if (remote.videoUrl || remote.url) {
          expanded.push(remote)
        }
      }
    } catch (err) {
      console.error('PornHub remote media fetch failed:', err.message)
      // Keep the original def as last-resort (usually unusable, but harmless)
      expanded.push(def)
    }
  }

  return expanded
}

function parseLooseJsonArray(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    try {
      const cleaned = raw
        .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')
        .replace(/,\s*]/g, ']')
        .replace(/,\s*}/g, '}')
        .replace(/'/g, '"')
      return JSON.parse(cleaned)
    } catch {
      return null
    }
  }
}

/**
 * Extract a balanced JSON array or object starting at a given position in a string.
 * Returns the matched substring or null if no valid bracket-balanced JSON found.
 * This is much more reliable than regex for nested structures like mediaDefinitions.
 */
function extractBalancedJson(str, startPos) {
  if (!str || startPos >= str.length) return null
  const openChar = str[startPos]
  if (openChar !== '[' && openChar !== '{') return null
  const closeChar = openChar === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  let escape = false
  let i = startPos

  for (; i < str.length; i++) {
    const ch = str[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === openChar || (openChar === '[' && ch === '{') || (openChar === '{' && ch === '[')) {
      depth++
    } else if (ch === closeChar || (openChar === ']' && ch === '}') || (openChar === '}' && ch === ']')) {
      // Actually we need to track both types
      if (ch === ']') depth--
      if (ch === '}') depth--
      if (depth <= 0) {
        return str.slice(startPos, i + 1)
      }
    }
  }
  return null
}

/**
 * Better balanced extraction that tracks both [] and {} depth properly.
 */
function extractBalancedJsonV2(str, startPos) {
  if (!str || startPos >= str.length) return null
  const openChar = str[startPos]
  if (openChar !== '[' && openChar !== '{') return null
  
  let bracketDepth = 0  // tracks [] 
  let braceDepth = 0    // tracks {}
  let inString = false
  let escape = false
  let started = false

  for (let i = startPos; i < str.length; i++) {
    const ch = str[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === '[') { bracketDepth++; started = true }
    else if (ch === ']') { bracketDepth-- }
    else if (ch === '{') { braceDepth++; started = true }
    else if (ch === '}') { braceDepth-- }

    if (started && bracketDepth <= 0 && braceDepth <= 0) {
      return str.slice(startPos, i + 1)
    }
  }
  return null
}

/**
 * Resolve an XVideos page URL to a direct video URL.
 */
async function resolveXVideos(pageUrl) {
  const html = await fetchHtml(pageUrl, 'https://www.xvideos.com/')

  const highMatch = html.match(/html5player\.setVideoUrlHigh\s*\(\s*['"]([^'"]+)['"]\s*\)/)
  if (highMatch?.[1]) {
    const url = cleanExtractedUrl(highMatch[1])
    if (url) return { videoUrl: url, type: 'mp4', source: 'xvideos', referer: 'https://www.xvideos.com/' }
  }

  const lowMatch = html.match(/html5player\.setVideoUrlLow\s*\(\s*['"]([^'"]+)['"]\s*\)/)
  if (lowMatch?.[1]) {
    const url = cleanExtractedUrl(lowMatch[1])
    if (url) return { videoUrl: url, type: 'mp4', source: 'xvideos', referer: 'https://www.xvideos.com/' }
  }

  const hlsMatch = html.match(/html5player\.setVideoHLS\s*\(\s*['"]([^'"]+)['"]\s*\)/)
  if (hlsMatch?.[1]) {
    const url = cleanExtractedUrl(hlsMatch[1])
    if (url) return { videoUrl: url, type: 'hls', source: 'xvideos', referer: 'https://www.xvideos.com/' }
  }

  const flashvarsMatch = html.match(/video_url(?:_text)?=([^&"']+)/)
  if (flashvarsMatch?.[1]) {
    const decoded = decodeHtmlEntities(decodeURIComponent(flashvarsMatch[1]))
    if (/^https?:\/\//i.test(decoded)) {
      return {
        videoUrl: decoded,
        type: decoded.includes('.m3u8') ? 'hls' : 'mp4',
        source: 'xvideos',
        referer: 'https://www.xvideos.com/',
      }
    }
  }

  const $ = cheerio.load(html)
  const sourceSrc = $('video source[type="video/mp4"]').attr('src') || $('video source').first().attr('src')
  if (sourceSrc) {
    const url = cleanExtractedUrl(sourceSrc)
    if (url) return { videoUrl: url, type: 'mp4', source: 'xvideos', referer: 'https://www.xvideos.com/' }
  }

  throw new Error('Could not extract video URL from XVideos page')
}

/**
 * Resolve a PornHub page URL to a direct video URL.
 * Handles remote mediaDefinitions (get_media JSON) which are the modern format.
 */
async function resolvePornhub(pageUrl) {
  const html = await fetchHtml(pageUrl, 'https://www.pornhub.com/')

  // Strategy 1: mediaDefinitions array — use balanced JSON extraction
  // instead of fragile regex that breaks on nested arrays
  let definitions = null

  // Find the position of "mediaDefinitions" in the HTML and extract the balanced array
  const mediaDefMarkers = ['"mediaDefinitions"', 'mediaDefinitions']
  for (const marker of mediaDefMarkers) {
    let searchFrom = 0
    while (searchFrom < html.length) {
      const idx = html.indexOf(marker, searchFrom)
      if (idx === -1) break
      // Find the opening bracket after the marker
      const afterMarker = html.indexOf('[', idx + marker.length)
      if (afterMarker === -1 || afterMarker - (idx + marker.length) > 20) {
        searchFrom = idx + marker.length
        continue
      }
      const rawJson = extractBalancedJsonV2(html, afterMarker)
      if (rawJson) {
        definitions = parseLooseJsonArray(rawJson)
        if (Array.isArray(definitions) && definitions.length) break
        definitions = null
      }
      searchFrom = idx + marker.length
    }
    if (definitions) break
  }

  if (Array.isArray(definitions) && definitions.length) {
    const expanded = await expandRemoteDefinitions(definitions, pageUrl)
    const best = pickBestDefinition(expanded)
    if (best?.videoUrl) {
      return {
        videoUrl: best.videoUrl,
        type: best.type || 'mp4',
        source: 'pornhub',
        quality: best.quality,
        referer: 'https://www.pornhub.com/',
      }
    }
  }

  // Strategy 2: flashvars object containing mediaDefinitions
  const flashvarsMatch = html.match(/var\s+flashvars_(\d+)\s*=\s*/)
  if (flashvarsMatch) {
    const startIdx = flashvarsMatch.index + flashvarsMatch[0].length
    const braceIdx = html.indexOf('{', startIdx)
    if (braceIdx !== -1 && braceIdx - startIdx < 5) {
      const rawJson = extractBalancedJsonV2(html, braceIdx)
      if (rawJson) {
        try {
          const fv = parseLooseJsonArray(rawJson)
          if (fv?.mediaDefinitions) {
            const expanded = await expandRemoteDefinitions(fv.mediaDefinitions, pageUrl)
            const best = pickBestDefinition(expanded)
            if (best?.videoUrl) {
              return {
                videoUrl: best.videoUrl,
                type: best.type || 'mp4',
                source: 'pornhub',
                quality: best.quality,
                referer: 'https://www.pornhub.com/',
              }
            }
          }
        } catch {
          /* fall through */
        }
      }
    }
  }

  // Strategy 3: qualityItems_XXXX = [...] — use balanced extraction
  const qualityMatch = html.match(/qualityItems_\d+\s*=\s*/)
  if (qualityMatch) {
    const startIdx = qualityMatch.index + qualityMatch[0].length
    const bracketIdx = html.indexOf('[', startIdx)
    if (bracketIdx !== -1 && bracketIdx - startIdx < 5) {
      const rawJson = extractBalancedJsonV2(html, bracketIdx)
      if (rawJson) {
        try {
          const items = parseLooseJsonArray(rawJson) || []
          const sorted = [...items].sort((a, b) => (parseInt(b.text) || 0) - (parseInt(a.text) || 0))
          for (const best of sorted) {
            if (!best?.url) continue
            // qualityItems may also point at remote get_media URLs
            if (/get_media/i.test(best.url) || best.remote) {
              try {
                const remote = await fetchJson(best.url, pageUrl)
                const list = Array.isArray(remote) ? remote : []
                const picked = pickBestDefinition(list)
                if (picked?.videoUrl) {
                  return {
                    videoUrl: picked.videoUrl,
                    type: picked.type || 'mp4',
                    source: 'pornhub',
                    quality: picked.quality || best.text,
                    referer: 'https://www.pornhub.com/',
                  }
                }
              } catch {
                continue
              }
            } else {
              const cleanedUrl = cleanExtractedUrl(best.url)
              if (cleanedUrl && /^https?:\/\//i.test(cleanedUrl)) {
                return {
                  videoUrl: cleanedUrl,
                  type: /\.m3u8/i.test(cleanedUrl) ? 'hls' : 'mp4',
                  source: 'pornhub',
                  quality: best.text,
                  referer: 'https://www.pornhub.com/',
                }
              }
            }
          }
        } catch {
          /* fall through */
        }
      }
    }
  }

  // Strategy 4: video_url / video_alt_url flashvars
  const flashUrlMatch = html.match(/(?:video_url|video_alt_url[0-9]*)\s*=\s*(?:encodeURIComponent\s*\(\s*)?['"]([^'"]+)['"]/)
  if (flashUrlMatch?.[1]) {
    let url = cleanExtractedUrl(flashUrlMatch[1])
    if (!url) {
      try { url = decodeHtmlEntities(decodeURIComponent(flashUrlMatch[1])) } catch { url = null }
    }
    if (url && /^https?:\/\//i.test(url) && !/get_media/i.test(url)) {
      return {
        videoUrl: url,
        type: url.includes('.m3u8') ? 'hls' : 'mp4',
        source: 'pornhub',
        referer: 'https://www.pornhub.com/',
      }
    }
  }

  // Strategy 5: <source> tag
  const $ = cheerio.load(html)
  const sourceSrc = $('video source[type="video/mp4"]').attr('src') || $('video source').first().attr('src')
  if (sourceSrc) {
    const url = cleanExtractedUrl(sourceSrc)
    if (url) return { videoUrl: url, type: 'mp4', source: 'pornhub', referer: 'https://www.pornhub.com/' }
  }

  // Strategy 6: Look for embedded player vars in script tags
  const scriptBlocks = []
  $('script').each((_, el) => {
    const text = $(el).html()
    if (text && (text.includes('mediaDefinitions') || text.includes('videoUrl') || text.includes('flashvars') || text.includes('qualityItems'))) {
      scriptBlocks.push(text)
    }
  })

  // Prefer m3u8 hits in scripts first (seekable), then mp4
  const scriptCandidates = []
  for (const script of scriptBlocks) {
    const re = /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/gi
    let sm
    while ((sm = re.exec(script)) !== null) {
      const url = cleanExtractedUrl(sm[1])
      if (!url || /get_media/i.test(url)) continue
      scriptCandidates.push(url)
    }
  }
  const hlsScript = scriptCandidates.find((u) => /\.m3u8/i.test(u))
  if (hlsScript) {
    return {
      videoUrl: hlsScript,
      type: 'hls',
      source: 'pornhub',
      referer: 'https://www.pornhub.com/',
      seekable: true,
    }
  }
  if (scriptCandidates[0]) {
    return {
      videoUrl: scriptCandidates[0],
      type: 'mp4',
      source: 'pornhub',
      referer: 'https://www.pornhub.com/',
      seekable: false,
    }
  }

  // Strategy 7: next-video / player bootstrap JSON sometimes embeds stream URLs
  // after client-side "continue" — scrape any get_media links and expand them.
  const getMediaUrls = [...html.matchAll(/https?:\/\/[^"'\\s]+get_media[^"'\\s]*/gi)]
    .map((m) => cleanExtractedUrl(m[0]))
    .filter(Boolean)
  const uniqueGetMedia = [...new Set(getMediaUrls)].slice(0, 4)
  for (const gm of uniqueGetMedia) {
    try {
      const remote = await fetchJson(gm, pageUrl)
      const list = Array.isArray(remote)
        ? remote
        : (Array.isArray(remote?.mediaDefinitions) ? remote.mediaDefinitions : [])
      const picked = pickBestDefinition(list)
      if (picked?.videoUrl) {
        return {
          videoUrl: picked.videoUrl,
          type: picked.type || 'mp4',
          source: 'pornhub',
          quality: picked.quality,
          referer: 'https://www.pornhub.com/',
          seekable: picked.seekable,
        }
      }
    } catch {
      /* next */
    }
  }

  // Strategy 8: browser-based unlock removed (Puppeteer not available on Vercel)
  // Strategies 1-7 handle the vast majority of PornHub videos via HTML parsing

  throw new Error('Could not extract video URL from PornHub page — stream may require browser JS unlock')
}

/**
 * Resolve a SpankBang page URL to a direct video URL.
 */
async function resolveSpankBang(pageUrl) {
  // SpankBang may redirect between .party, .com, and other TLDs
  const html = await fetchHtml(pageUrl, 'https://spankbang.party/')

  // Strategy 1: data-stream attribute (JSON object with quality → URL mapping)
  const streamMatch = html.match(/data-stream\s*=\s*"([^"]+)"/)
  if (streamMatch?.[1]) {
    try {
      const raw = streamMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x2F;/g, '/').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      const streamData = JSON.parse(raw)
      const qualities = Object.entries(streamData)
        .filter(([, v]) => v && /^https?:\/\//i.test(v))
        .sort(([a], [b]) => (parseInt(b) || 0) - (parseInt(a) || 0))
      if (qualities.length > 0) {
        const [quality, videoUrl] = qualities[0]
        return {
          videoUrl,
          type: videoUrl.includes('.m3u8') ? 'hls' : 'mp4',
          source: 'spankbang',
          quality,
          referer: 'https://spankbang.party/',
        }
      }
    } catch {
      /* next */
    }
  }

  // Strategy 2: SpankBang often uses a <script> block with stream_url or player config
  const streamUrlMatch = html.match(/stream_url\s*=\s*['"]([^'"]+)['"]/)
  if (streamUrlMatch?.[1]) {
    const url = cleanExtractedUrl(streamUrlMatch[1])
    if (url) return { videoUrl: url, type: 'mp4', source: 'spankbang', referer: 'https://spankbang.party/' }
  }

  // Strategy 3: Look for direct video URLs in script blocks (SpankBang embeds these)
  const scriptVideoMatch = html.match(/["']((?:https?:)?\/\/[a-z0-9.-]*(?:sb-cd|spankbang|spankcdn|cdn-)[^"']*\.(?:mp4|m3u8)[^"']*)["']/i)
  if (scriptVideoMatch?.[1]) {
    const url = cleanExtractedUrl(scriptVideoMatch[1])
    if (url) {
      return {
        videoUrl: url,
        type: /\.m3u8/i.test(url) ? 'hls' : 'mp4',
        source: 'spankbang',
        referer: 'https://spankbang.party/',
      }
    }
  }

  // Strategy 4: videoUrl, playUrl, file_url patterns
  const videoUrlMatch = html.match(/(?:videoUrl|playUrl|file_url|video_url|src)\s*[:=]\s*['"]([^'"]+)['"]/i)
  if (videoUrlMatch?.[1]) {
    const url = cleanExtractedUrl(videoUrlMatch[1])
    if (url) {
      return {
        videoUrl: url,
        type: url.includes('.m3u8') ? 'hls' : 'mp4',
        source: 'spankbang',
        referer: 'https://spankbang.party/',
      }
    }
  }

  // Strategy 5: <video> or <source> tags
  const $ = cheerio.load(html)
  const sourceSrc = $('video source[type="video/mp4"]').attr('src')
    || $('video source').first().attr('src')
    || $('video').attr('src')
    || $('video').attr('data-src')
  if (sourceSrc) {
    const url = cleanExtractedUrl(sourceSrc)
    if (url) return { videoUrl: url, type: 'mp4', source: 'spankbang', referer: 'https://spankbang.party/' }
  }

  // Strategy 6: JSON-LD structured data
  const ldMatch = html.match(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i)
  if (ldMatch) {
    try {
      const ldData = JSON.parse(ldMatch[1])
      const contentUrl = ldData?.contentUrl || ldData?.embedUrl
      if (contentUrl && /^https?:\/\//i.test(contentUrl)) {
        return {
          videoUrl: contentUrl,
          type: contentUrl.includes('.m3u8') ? 'hls' : 'mp4',
          source: 'spankbang',
          referer: 'https://spankbang.party/',
        }
      }
    } catch {
      /* */
    }
  }

  // Strategy 7: Look for any CDN video URL in the entire page source
  const cdnVideoMatch = html.match(/https?:\/\/[a-z0-9.-]*cdn[a-z0-9.-]*\.(?:sb-cd\.com|spankbang\.com|spankcdn\.net)[^"'\s<>]*\.(?:mp4|m3u8)[^"'\s<>]*/i)
  if (cdnVideoMatch?.[0]) {
    const url = cleanExtractedUrl(cdnVideoMatch[0])
    if (url) {
      return {
        videoUrl: url,
        type: /\.m3u8/i.test(url) ? 'hls' : 'mp4',
        source: 'spankbang',
        referer: 'https://spankbang.party/',
      }
    }
  }

  // Strategy 8: Generic video URL in script tags
  const genericMatch = html.match(/["'](https?:\/\/[^"']*(?:video|stream|cdn|media)[^"']*\.(?:mp4|m3u8)[^"']*)["']/i)
  if (genericMatch?.[1]) {
    const url = cleanExtractedUrl(genericMatch[1])
    if (url) {
      return {
        videoUrl: url,
        type: /\.m3u8/i.test(url) ? 'hls' : 'mp4',
        source: 'spankbang',
        referer: 'https://spankbang.party/',
      }
    }
  }

  throw new Error('Could not extract video URL from SpankBang page')
}

/**
 * Auto-detect the NSFW provider from a URL and resolve it to a direct video URL.
 */
export async function resolveNsfwVideoUrl(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return null

  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase()

    if (hostname.includes('xvideos.com') || hostname.includes('xvideos.')) {
      try {
        return await resolveXVideos(pageUrl)
      } catch (err) {
        console.error('XVideos resolve error:', err.message)
        return null
      }
    }

    if (hostname.includes('pornhub.com') || hostname.includes('pornhub.')) {
      try {
        return await resolvePornhub(pageUrl)
      } catch (err) {
        console.error('PornHub resolve error:', err.message)
        return null
      }
    }

    if (hostname.includes('spankbang')) {
      try {
        return await resolveSpankBang(pageUrl)
      } catch (err) {
        console.error('SpankBang resolve error:', err.message)
        return null
      }
    }
  } catch {
    return null
  }

  return null
}

/**
 * Check if a URL belongs to a known NSFW provider that we can resolve.
 */
export function isNsfwProviderUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname.includes('xvideos') || hostname.includes('pornhub') || hostname.includes('spankbang')
  } catch {
    return false
  }
}
