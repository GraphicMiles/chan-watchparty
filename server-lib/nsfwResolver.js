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

function pickBestDefinition(definitions) {
  if (!Array.isArray(definitions) || !definitions.length) return null

  const isPlayable = (d) => {
    const url = d?.videoUrl || d?.url || d?.link || ''
    return typeof url === 'string' && /^https?:\/\//i.test(url)
  }

  // Prefer progressive MP4 that is NOT a remote get_media JSON endpoint
  const mp4Direct = definitions
    .filter((d) => isPlayable(d) && String(d.format || '').toLowerCase() === 'mp4' && !d.remote)
    .filter((d) => !/get_media|\/hls\//i.test(d.videoUrl || d.url || ''))
    .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))

  if (mp4Direct.length) {
    const best = mp4Direct[0]
    return {
      videoUrl: best.videoUrl || best.url,
      type: 'mp4',
      quality: best.quality,
    }
  }

  // HLS (m3u8) is playable via hls.js through the proxy
  const hls = definitions
    .filter((d) => isPlayable(d) && (
      String(d.format || '').toLowerCase() === 'hls'
      || /\.m3u8/i.test(d.videoUrl || d.url || '')
    ))
    .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))

  if (hls.length) {
    const best = hls[0]
    return {
      videoUrl: best.videoUrl || best.url,
      type: 'hls',
      quality: best.quality,
    }
  }

  // Any remaining direct http URL that looks like media
  const anyMedia = definitions
    .filter(isPlayable)
    .filter((d) => !/get_media/i.test(d.videoUrl || d.url || ''))
    .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))

  if (anyMedia.length) {
    const best = anyMedia[0]
    const url = best.videoUrl || best.url
    return {
      videoUrl: url,
      type: /\.m3u8/i.test(url) ? 'hls' : 'mp4',
      quality: best.quality,
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
      if (Array.isArray(remote)) {
        for (const item of remote) expanded.push(item)
      } else if (remote && typeof remote === 'object') {
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
    return { videoUrl: highMatch[1], type: 'mp4', source: 'xvideos', referer: 'https://www.xvideos.com/' }
  }

  const lowMatch = html.match(/html5player\.setVideoUrlLow\s*\(\s*['"]([^'"]+)['"]\s*\)/)
  if (lowMatch?.[1]) {
    return { videoUrl: lowMatch[1], type: 'mp4', source: 'xvideos', referer: 'https://www.xvideos.com/' }
  }

  const hlsMatch = html.match(/html5player\.setVideoHLS\s*\(\s*['"]([^'"]+)['"]\s*\)/)
  if (hlsMatch?.[1]) {
    return { videoUrl: hlsMatch[1], type: 'hls', source: 'xvideos', referer: 'https://www.xvideos.com/' }
  }

  const flashvarsMatch = html.match(/video_url(?:_text)?=([^&"']+)/)
  if (flashvarsMatch?.[1]) {
    const decoded = decodeURIComponent(flashvarsMatch[1])
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
  if (sourceSrc && /^https?:\/\//i.test(sourceSrc)) {
    return { videoUrl: sourceSrc, type: 'mp4', source: 'xvideos', referer: 'https://www.xvideos.com/' }
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
            } else if (/^https?:\/\//i.test(best.url)) {
              return {
                videoUrl: best.url,
                type: /\.m3u8/i.test(best.url) ? 'hls' : 'mp4',
                source: 'pornhub',
                quality: best.text,
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

  // Strategy 4: video_url / video_alt_url flashvars
  const flashUrlMatch = html.match(/(?:video_url|video_alt_url[0-9]*)\s*=\s*(?:encodeURIComponent\s*\(\s*)?['"]([^'"]+)['"]/)
  if (flashUrlMatch?.[1]) {
    let url = flashUrlMatch[1]
    try { url = decodeURIComponent(url) } catch { /* already decoded */ }
    if (/^https?:\/\//i.test(url) && !/get_media/i.test(url)) {
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
  if (sourceSrc && /^https?:\/\//i.test(sourceSrc)) {
    return { videoUrl: sourceSrc, type: 'mp4', source: 'pornhub', referer: 'https://www.pornhub.com/' }
  }

  // Strategy 6: Look for embedded player vars in script tags
  const scriptBlocks = []
  $('script').each((_, el) => {
    const text = $(el).html()
    if (text && (text.includes('mediaDefinitions') || text.includes('videoUrl') || text.includes('flashvars'))) {
      scriptBlocks.push(text)
    }
  })

  for (const script of scriptBlocks) {
    // Try to find any direct video URLs in the script
    const directUrlMatch = script.match(/["'](https?:\/\/[^"']*\.(?:mp4|m3u8)[^"']*)["']/i)
    if (directUrlMatch?.[1]) {
      const url = directUrlMatch[1]
      if (!/get_media/i.test(url)) {
        return {
          videoUrl: url,
          type: /\.m3u8/i.test(url) ? 'hls' : 'mp4',
          source: 'pornhub',
          referer: 'https://www.pornhub.com/',
        }
      }
    }
  }

  throw new Error('Could not extract video URL from PornHub page')
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
  if (streamUrlMatch?.[1] && /^https?:\/\//i.test(streamUrlMatch[1])) {
    return { videoUrl: streamUrlMatch[1], type: 'mp4', source: 'spankbang', referer: 'https://spankbang.party/' }
  }

  // Strategy 3: Look for direct video URLs in script blocks (SpankBang embeds these)
  const scriptVideoMatch = html.match(/["']((?:https?:)?\/\/[a-z0-9.-]*(?:sb-cd|spankbang|spankcdn|cdn-)[^"']*\.(?:mp4|m3u8)[^"']*)["']/i)
  if (scriptVideoMatch?.[1]) {
    let url = scriptVideoMatch[1]
    if (url.startsWith('//')) url = 'https:' + url
    try { url = decodeURIComponent(url) } catch { /* */ }
    if (/^https?:\/\//i.test(url)) {
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
    let url = videoUrlMatch[1]
    if (url.startsWith('//')) url = 'https:' + url
    try { url = decodeURIComponent(url) } catch { /* */ }
    if (/^https?:\/\//i.test(url)) {
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
  if (sourceSrc && /^https?:\/\//i.test(sourceSrc)) {
    return { videoUrl: sourceSrc, type: 'mp4', source: 'spankbang', referer: 'https://spankbang.party/' }
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
    return {
      videoUrl: cdnVideoMatch[0],
      type: /\.m3u8/i.test(cdnVideoMatch[0]) ? 'hls' : 'mp4',
      source: 'spankbang',
      referer: 'https://spankbang.party/',
    }
  }

  // Strategy 8: Generic video URL in script tags
  const genericMatch = html.match(/["'](https?:\/\/[^"']*(?:video|stream|cdn|media)[^"']*\.(?:mp4|m3u8)[^"']*)["']/i)
  if (genericMatch?.[1]) {
    return {
      videoUrl: genericMatch[1],
      type: /\.m3u8/i.test(genericMatch[1]) ? 'hls' : 'mp4',
      source: 'spankbang',
      referer: 'https://spankbang.party/',
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
