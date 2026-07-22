/**
 * Dood.li / DoodStream Video URL Resolver
 *
 * DoodStream (dood.li, dood.to, dood.watch, dood.so) is a video hosting CDN
 * used by MaxCinema and other providers. The extraction flow is:
 *
 *   1. Fetch the /e/{videoId} embed page
 *   2. Extract the /pass_md5/... URL and token from inline JS
 *   3. Fetch the pass_md5 URL with Referer header → returns a partial URL
 *   4. Append random characters + token + expiry to build the final video URL
 *
 * This is based on the yt-dlp DoodStream extractor logic.
 * DoodStream domains rotate, so we support multiple TLDs.
 * The final URL is time-limited (token expires).
 */

import * as cheerio from 'cheerio'
import { randomBytes } from 'node:crypto'

const RESOLVE_TIMEOUT_MS = 5000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

// Known DoodStream domains (they rotate TLDs)
const DOOD_DOMAINS = ['dood.li', 'dood.to', 'dood.watch', 'dood.so', 'dood.pm', 'dood.ws', 'dood.re', 'dood.yt', 'dood.la']

/**
 * Check if a URL is a DoodStream URL
 */
export function isDoodUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return DOOD_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))
  } catch {
    return false
  }
}

/**
 * Resolve a DoodStream URL to a direct video URL.
 *
 * Supports both /d/{id} (download page) and /e/{id} (embed page) URLs.
 *
 * @param {string} doodUrl - The DoodStream page URL
 * @returns {Promise<{videoUrl: string, title: string, thumbnail: string|null, source: string}|null>}
 */
export async function resolveDoodUrl(doodUrl) {
  if (!doodUrl || typeof doodUrl !== 'string') return null

  try {
    const parsed = new URL(doodUrl)
    const hostname = parsed.hostname

    // If it's a /d/ (download) page, we need to find the /e/ embed iframe first
    if (parsed.pathname.startsWith('/d/')) {
      return await resolveFromDownloadPage(doodUrl, hostname)
    }

    // If it's an /e/ (embed) page, resolve directly
    if (parsed.pathname.startsWith('/e/')) {
      return await resolveFromEmbedPage(doodUrl, hostname)
    }

    return null
  } catch {
    return null
  }
}

/**
 * Resolve from a /d/ download page by finding the /e/ embed iframe
 */
async function resolveFromDownloadPage(downloadUrl, hostname) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)

  try {
    const res = await fetch(downloadUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    })
    clearTimeout(timer)

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const html = await res.text()
    const $ = cheerio.load(html)

    // Find the embed iframe: <iframe src="/e/{id}">
    const embedSrc = $('iframe[src*="/e/"]').attr('src')
    if (!embedSrc) throw new Error('No embed iframe found on download page')

    // Build full embed URL
    const embedUrl = embedSrc.startsWith('http')
      ? embedSrc
      : `https://${hostname}${embedSrc}`

    return await resolveFromEmbedPage(embedUrl, hostname)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve from an /e/ embed page — the core extraction logic
 *
 * The embed page contains:
 *   - A /pass_md5/... URL in a <script> tag
 *   - A token parameter in the page source
 *
 * Step 1: Fetch the pass_md5 URL with Referer → get partial video URL
 * Step 2: Append random chars + token + expiry → final video URL
 */
async function resolveFromEmbedPage(embedUrl, hostname) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)

  try {
    const res = await fetch(embedUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        Referer: embedUrl,
      },
    })
    clearTimeout(timer)

    if (!res.ok) throw new Error(`Embed page returned HTTP ${res.status}`)

    const html = await res.text()

    // Extract title from og:title or meta
    const $ = cheerio.load(html)
    const title = $('meta[property="og:title"]').attr('content')
      || $('meta[name="twitter:title"]').attr('content')
      || $('title').text().replace(/\s*\|\s*DoodStream\.com\s*$/i, '').trim()
      || 'Video'

    // Extract thumbnail
    const thumbnail = $('meta[property="og:image"]').attr('content')
      || $('meta[name="twitter:image"]').attr('content')
      || $('meta[itemprop="thumbnailUrl"]').attr('content')
      || null

    // Extract /pass_md5/... URL from inline script
    // Pattern: '/pass_md5/xxxxx/yyyyyy' or 'https://dood.xxx/pass_md5/...'
    const passMd5Match = html.match(/(\/pass_md5\/[^\s'"]+)/)
    if (!passMd5Match) {
      throw new Error('Could not find pass_md5 URL in embed page')
    }

    let passMd5Path = passMd5Match[1]
    // Build full URL if it's a relative path
    if (passMd5Path.startsWith('/')) {
      passMd5Path = `https://${hostname}${passMd5Path}`
    }

    // Extract the token from the page source
    // Pattern: ?token=xxxxx or token=xxxxx
    const tokenMatch = html.match(/[?&]token=([a-z0-9]+)/i)
      || html.match(/\btoken\s*[:=]\s*["']?([a-z0-9]+)/i)
    if (!tokenMatch) {
      throw new Error('Could not find token in embed page')
    }
    const token = tokenMatch[1]

    // Step 2: Fetch the pass_md5 URL with Referer header
    // This returns a partial video URL (e.g., "https://something.cdn.dood.video/abc/def")
    const passController = new AbortController()
    const passTimer = setTimeout(() => passController.abort(), RESOLVE_TIMEOUT_MS)

    let passResponse
    try {
      passResponse = await fetch(passMd5Path, {
        signal: passController.signal,
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          Referer: embedUrl,
        },
      })
    } finally {
      clearTimeout(passTimer)
    }

    if (!passResponse.ok) {
      throw new Error(`pass_md5 returned HTTP ${passResponse.status}`)
    }

    const partialUrl = (await passResponse.text()).trim()
    if (!partialUrl || !partialUrl.startsWith('http')) {
      throw new Error('pass_md5 did not return a valid URL')
    }

    // Step 3: Build the final video URL
    // Append: random 10 chars + ?token=xxx + &expiry=timestamp_ms
    const randomChars = randomBytes(5).toString('hex').slice(0, 10)
    const expiry = Date.now()
    const finalUrl = `${partialUrl}${randomChars}?token=${token}&expiry=${expiry}`

    return {
      videoUrl: finalUrl,
      title,
      thumbnail,
      source: 'doodstream',
    }
  } finally {
    clearTimeout(timer)
  }
}
