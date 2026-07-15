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

const RESOLVE_TIMEOUT_MS = 5000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

/**
 * Resolve an XVideos page URL to a direct video URL.
 * XVideos embeds the video URL in a `html5player.setVideoUrlHigh()` or
 * `html5player.setVideoHLS()` call in the page's inline JavaScript.
 */
async function resolveXVideos(pageUrl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)

  try {
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        Referer: 'https://www.xvideos.com/',
      },
    })
    if (!res.ok) throw new Error(`XVideos returned HTTP ${res.status}`)

    const html = await res.text()

    // Strategy 1: Extract from html5player.setVideoUrlHigh('...')
    const highMatch = html.match(/html5player\.setVideoUrlHigh\s*\(\s*['"]([^'"]+)['"]\s*\)/)
    if (highMatch && highMatch[1]) {
      return { videoUrl: highMatch[1], type: 'mp4', source: 'xvideos', referer: 'https://www.xvideos.com/' }
    }

    // Strategy 2: Extract from html5player.setVideoUrlLow('...')
    const lowMatch = html.match(/html5player\.setVideoUrlLow\s*\(\s*['"]([^'"]+)['"]\s*\)/)
    if (lowMatch && lowMatch[1]) {
      return { videoUrl: lowMatch[1], type: 'mp4', source: 'xvideos', referer: 'https://www.xvideos.com/' }
    }

    // Strategy 3: Extract HLS URL from html5player.setVideoHLS('...')
    const hlsMatch = html.match(/html5player\.setVideoHLS\s*\(\s*['"]([^'"]+)['"]\s*\)/)
    if (hlsMatch && hlsMatch[1]) {
      return { videoUrl: hlsMatch[1], type: 'hls', source: 'xvideos', referer: 'https://www.xvideos.com/' }
    }

    // Strategy 4: Look for flashvars video_url or video_url_text
    const flashvarsMatch = html.match(/video_url(?:_text)?=([^&"']+)/)
    if (flashvarsMatch && flashvarsMatch[1]) {
      const decoded = decodeURIComponent(flashvarsMatch[1])
      if (/^https?:\/\//i.test(decoded)) {
        return { videoUrl: decoded, type: decoded.includes('.m3u8') ? 'hls' : 'mp4', source: 'xvideos', referer: 'https://www.xvideos.com/' }
      }
    }

    // Strategy 5: Look for <source> tag with video src
    const $ = cheerio.load(html)
    const sourceSrc = $('video source[type="video/mp4"]').attr('src') || $('video source').first().attr('src')
    if (sourceSrc && /^https?:\/\//i.test(sourceSrc)) {
      return { videoUrl: sourceSrc, type: 'mp4', source: 'xvideos', referer: 'https://www.xvideos.com/' }
    }

    throw new Error('Could not extract video URL from XVideos page')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve a PornHub page URL to a direct video URL.
 * PornHub embeds video URLs in a `flashvars` JSON object in inline JS,
 * or in a mediaDefinition array with multiple quality levels.
 */
async function resolvePornhub(pageUrl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)

  try {
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        Referer: 'https://www.pornhub.com/',
      },
    })
    if (!res.ok) throw new Error(`PornHub returned HTTP ${res.status}`)

    const html = await res.text()

    // Strategy 1: Extract from mediaDefinition array in flashvars
    // Format: mediaDefinitions:[{videoUrl:"...",quality:"720",format:"mp4"},...]
    const mediaDefMatch = html.match(/mediaDefinitions\s*:\s*(\[[\s\S]*?\])\s*[,}]/)
    if (mediaDefMatch) {
      try {
        // Clean up the JSON - it may have unquoted keys or trailing commas
        let jsonStr = mediaDefMatch[1]
          .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":') // quote keys
          .replace(/,\s*]/g, ']') // remove trailing commas
          .replace(/'/g, '"') // single to double quotes

        const definitions = JSON.parse(jsonStr)
        // Prefer MP4 with highest quality
        const mp4Defs = definitions
          .filter(d => d.videoUrl && d.format === 'mp4' && d.videoUrl.startsWith('http'))
          .sort((a, b) => {
            const qA = parseInt(a.quality) || 0
            const qB = parseInt(b.quality) || 0
            return qB - qA
          })
        if (mp4Defs.length > 0) {
          return { videoUrl: mp4Defs[0].videoUrl, type: 'mp4', source: 'pornhub', quality: mp4Defs[0].quality, referer: 'https://www.pornhub.com/' }
        }
        // Fallback: any format with a URL
        const anyDef = definitions.find(d => d.videoUrl && d.videoUrl.startsWith('http'))
        if (anyDef) {
          return { videoUrl: anyDef.videoUrl, type: anyDef.format === 'hls' ? 'hls' : 'mp4', source: 'pornhub', quality: anyDef.quality, referer: 'https://www.pornhub.com/' }
        }
      } catch {
        // JSON parse failed — try next strategy
      }
    }

    // Strategy 2: Extract from qualityItems JSON
    const qualityMatch = html.match(/qualityItems_\d+\s*=\s*(\[[\s\S]*?\])\s*;/)
    if (qualityMatch) {
      try {
        const items = JSON.parse(qualityMatch[1].replace(/'/g, '"'))
        const best = items.sort((a, b) => (parseInt(b.text) || 0) - (parseInt(a.text) || 0))[0]
        if (best?.url) {
          return { videoUrl: best.url, type: 'mp4', source: 'pornhub', quality: best.text, referer: 'https://www.pornhub.com/' }
        }
      } catch {
        // fall through
      }
    }

    // Strategy 3: Extract from flashvars.video_url or video_alt_url
    const flashUrlMatch = html.match(/(?:video_url|video_alt_url[0-9]*)\s*=\s*(?:encodeURIComponent\s*\(\s*)?['"]([^'"]+)['"]/)
    if (flashUrlMatch && flashUrlMatch[1]) {
      let url = flashUrlMatch[1]
      try { url = decodeURIComponent(url) } catch { /* already decoded */ }
      if (/^https?:\/\//i.test(url)) {
        return { videoUrl: url, type: url.includes('.m3u8') ? 'hls' : 'mp4', source: 'pornhub', referer: 'https://www.pornhub.com/' }
      }
    }

    // Strategy 4: Look for <source> tag
    const $ = cheerio.load(html)
    const sourceSrc = $('video source[type="video/mp4"]').attr('src') || $('video source').first().attr('src')
    if (sourceSrc && /^https?:\/\//i.test(sourceSrc)) {
      return { videoUrl: sourceSrc, type: 'mp4', source: 'pornhub', referer: 'https://www.pornhub.com/' }
    }

    throw new Error('Could not extract video URL from PornHub page')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve a SpankBang page URL to a direct video URL.
 * SpankBang embeds video URLs in inline JS — typically in a `stream_url` variable
 * or in a data-stream attribute.
 */
async function resolveSpankBang(pageUrl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)

  try {
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        Referer: 'https://spankbang.party/',
      },
    })
    if (!res.ok) throw new Error(`SpankBang returned HTTP ${res.status}`)

    const html = await res.text()

    // Strategy 1: Extract from data-stream attribute
    const streamMatch = html.match(/data-stream\s*=\s*"([^"]+)"/)
    if (streamMatch && streamMatch[1]) {
      try {
        const streamData = JSON.parse(streamMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
        // streamData is typically an object like {"240p":"url","480p":"url","720p":"url"}
        const qualities = Object.entries(streamData)
          .filter(([, v]) => v && /^https?:\/\//i.test(v))
          .sort(([a], [b]) => {
            const qA = parseInt(a) || 0
            const qB = parseInt(b) || 0
            return qB - qA
          })
        if (qualities.length > 0) {
          const [quality, videoUrl] = qualities[0]
          return { videoUrl, type: videoUrl.includes('.m3u8') ? 'hls' : 'mp4', source: 'spankbang', quality, referer: 'https://spankbang.party/' }
        }
      } catch {
        // Not valid JSON — try next strategy
      }
    }

    // Strategy 2: Extract from stream_url variable in JS
    const streamUrlMatch = html.match(/stream_url\s*=\s*['"]([^'"]+)['"]/)
    if (streamUrlMatch && streamUrlMatch[1] && /^https?:\/\//i.test(streamUrlMatch[1])) {
      return { videoUrl: streamUrlMatch[1], type: 'mp4', source: 'spankbang', referer: 'https://spankbang.party/' }
    }

    // Strategy 3: Extract from videoUrl or playUrl in script data
    const videoUrlMatch = html.match(/(?:videoUrl|playUrl|file_url)\s*[:=]\s*['"]([^'"]+)['"]/i)
    if (videoUrlMatch && videoUrlMatch[1]) {
      let url = videoUrlMatch[1]
      try { url = decodeURIComponent(url) } catch { /* */ }
      if (/^https?:\/\//i.test(url)) {
        return { videoUrl: url, type: url.includes('.m3u8') ? 'hls' : 'mp4', source: 'spankbang', referer: 'https://spankbang.party/' }
      }
    }

    // Strategy 4: Look for <source> or <video> src
    const $ = cheerio.load(html)
    const sourceSrc = $('video source[type="video/mp4"]').attr('src')
      || $('video source').first().attr('src')
      || $('video').attr('src')
    if (sourceSrc && /^https?:\/\//i.test(sourceSrc)) {
      return { videoUrl: sourceSrc, type: 'mp4', source: 'spankbang', referer: 'https://spankbang.party/' }
    }

    // Strategy 5: Extract from JSON-LD structured data
    const ldMatch = html.match(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i)
    if (ldMatch) {
      try {
        const ldData = JSON.parse(ldMatch[1])
        const contentUrl = ldData?.contentUrl
        if (contentUrl && /^https?:\/\//i.test(contentUrl)) {
          return { videoUrl: contentUrl, type: contentUrl.includes('.m3u8') ? 'hls' : 'mp4', source: 'spankbang', referer: 'https://spankbang.party/' }
        }
      } catch {
        // Not valid JSON-LD
      }
    }

    throw new Error('Could not extract video URL from SpankBang page')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Auto-detect the NSFW provider from a URL and resolve it to a direct video URL.
 * Returns null if the URL doesn't match any known provider or resolution fails.
 */
export async function resolveNsfwVideoUrl(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return null

  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase()

    if (hostname.includes('xvideos.com')) {
      try {
        return await resolveXVideos(pageUrl)
      } catch (err) {
        console.error('XVideos resolve error:', err.message)
        return null
      }
    }

    if (hostname.includes('pornhub.com')) {
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
    // Invalid URL
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
    return hostname.includes('xvideos.com') || hostname.includes('pornhub.com') || hostname.includes('spankbang')
  } catch {
    return false
  }
}
