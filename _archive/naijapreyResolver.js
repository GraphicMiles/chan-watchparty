import * as cheerio from 'cheerio'
import { isSuitableThumbnail, resolveUrl } from './sources.js'

const SEARCH_TIMEOUT_MS = 9000
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MAX_PT_HOPS = 10

// ---------- naijaprey.tv search ----------

export function buildNaijapreySearchUrls(query) {
  return [
    `https://www.naijaprey.tv/?s=${encodeURIComponent(query)}`,
  ]
}

export async function searchNaijaprey(query, limit = 20) {
  const searchUrl = `https://www.naijaprey.tv/?s=${encodeURIComponent(query)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

  try {
    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    if (!response.ok) throw new Error(`naijaprey returned HTTP ${response.status}`)

    const html = await response.text()
    const $ = cheerio.load(html)
    const results = []
    const seen = new Set()

    // naijaprey search results: each result is a card with a link + image
    $('.search-results article, .search-results .post-item, .search-results a[href*="naijaprey.tv/"], article.post, .content-area article').each((_, el) => {
      if (results.length >= limit) return false
      const $el = $(el)

      // Try to find the title link
      const titleLink = $el.find('a[href*="naijaprey.tv/"]').first()
      const link = titleLink.attr('href') || $el.find('a').first().attr('href')
      if (!link || seen.has(link)) return

      // Skip non-content URLs (tags, categories, pages, etc.)
      const linkPath = new URL(link, searchUrl).pathname
      if (/\/(tag\/|category\/|page\/|how-to-|dmca|contact|privacy|request|sitemap|downloader)/i.test(linkPath)) return
      // Must look like a content slug: /some-movie-title-2024/
      if (!/^\/[^/]+\/$/.test(linkPath) && !/^\/\d{4}\/\d{2}\/[^/]+\/$/.test(linkPath)) return

      seen.add(link)

      const title = titleLink.attr('title') || titleLink.text().replace(/\s+/g, ' ').trim() || $el.find('h2, h3, .entry-title').first().text().replace(/\s+/g, ' ').trim() || 'Untitled'

      const img = $el.find('img[src], img[data-src]').first()
      let thumbnail = img.attr('data-src') || img.attr('src') || null
      if (thumbnail && !thumbnail.startsWith('http')) {
        thumbnail = resolveUrl(thumbnail, searchUrl)
      }

      // Extract rating if available
      const rating = $el.find('.rating, [class*="rating"]').first().text().trim() || null

      results.push({
        id: link,
        title: title.slice(0, 200),
        url: link,
        link,
        thumbnail: isSuitableThumbnail(thumbnail) ? thumbnail : null,
        image: isSuitableThumbnail(thumbnail) ? thumbnail : null,
        source: 'naijaprey',
        type: 'direct',
        isDirect: false,
        meta: rating ? `Rating: ${rating}` : null,
      })
    })

    return results
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('naijaprey search timed out')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// ---------- naijaprey content page → np-downloader link ----------

/**
 * Given a naijaprey.tv content page URL, extract the download link
 * pointing to vdl.np-downloader.com
 */
export async function resolveNaijapreyPage(pageUrl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

  try {
    const response = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    if (!response.ok) throw new Error(`naijaprey page returned HTTP ${response.status}`)

    const html = await response.text()
    const $ = cheerio.load(html)

    const results = []
    const seen = new Set()

    // Extract page metadata
    const pageTitle = $('meta[property="og:title"]').attr('content') || $('title').text().trim() || 'Video'
    const pageImg = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || null
    const resolvedPageImg = resolveUrl(pageImg, pageUrl)
    const suitableImg = isSuitableThumbnail(resolvedPageImg) ? resolvedPageImg : null

    // Find download links on the content page
    // Pattern 1: Links to np-downloader — these are the primary download links
    $('a[href*="np-downloader.com"], a[href*="naijaprey.com/sdm_downloads"], a[href*="np-downloader"], a.button[href]').each((_, el) => {
      const href = $(el).attr('href')
      if (!href || seen.has(href)) return
      // Only include links that go to np-downloader or are download buttons
      const resolved = resolveUrl(href, pageUrl)
      try {
        const hostname = new URL(resolved).hostname.toLowerCase()
        if (!hostname.includes('np-downloader')) return
      } catch {
        return
      }
      seen.add(href)
      const text = $(el).text().trim() || 'Download'
      // Skip subtitle links
      if (/subtitle/i.test(text) || /\.srt/i.test(resolved)) return
      results.push({
        title: `${pageTitle} - ${text}`,
        url: resolved,
        link: resolved,
        thumbnail: suitableImg,
        image: suitableImg,
        source: 'naijaprey',
        isDirect: false,
        meta: 'NP-Downloader page',
        resolvedFrom: pageUrl,
      })
    })

    // Pattern 2: Direct media links on the page (video/src elements)
    const directMediaRe = /\.(mp4|m3u8|webm|mkv|avi|mov)(\?|#|$)/i
    const subtitleRe = /\.(srt|sub|sbv|ass|ssa|vtt)(\?|#|$)/i
    $('video[src], video source[src], source[src]').each((_, el) => {
      const rawUrl = $(el).attr('src')
      if (!rawUrl) return
      const resolved = resolveUrl(rawUrl, pageUrl)
      if (!directMediaRe.test(resolved) || seen.has(resolved)) return
      if (subtitleRe.test(resolved)) return
      seen.add(resolved)
      results.push({
        title: `${pageTitle} (direct)`,
        url: resolved,
        link: resolved,
        thumbnail: suitableImg,
        image: suitableImg,
        source: 'naijaprey',
        isDirect: true,
        playableInRoom: true,
        resolvedFrom: pageUrl,
      })
    })

    // Pattern 3: Any direct media URLs in the HTML
    // Use word-boundary lookahead to avoid matching "movieteasers.net" as ".mov"
    const rawMatches = html.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|webm|mkv|avi|mov)(?=[\s"'<>]|$)(?:\?[^\s"'<>]*)?/gi) || []
    for (const raw of rawMatches) {
      const resolved = raw.replace(/&amp;/g, '&')
      if (seen.has(resolved)) continue
      // Skip subtitle files
      if (/\.srt[?#]/i.test(resolved) || /\.srt$/i.test(resolved)) continue
      // Validate it looks like a real media URL (extension must be at end of path or before query)
      try {
        const urlObj = new URL(resolved)
        if (!/\.(mp4|m3u8|webm|mkv|avi|mov)($|\?)/i.test(urlObj.pathname)) continue
      } catch {
        continue
      }
      seen.add(resolved)
      results.push({
        title: `${pageTitle} (direct file)`,
        url: resolved,
        link: resolved,
        thumbnail: suitableImg,
        image: suitableImg,
        source: 'naijaprey',
        isDirect: true,
        playableInRoom: true,
        resolvedFrom: pageUrl,
      })
    }

    return { results, thumbnail: suitableImg }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('naijaprey page fetch timed out')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// ---------- np-downloader → wildshare link ----------

/**
 * Given a vdl.np-downloader.com page URL, extract the wildshare.net link
 */
export async function resolveNpDownloaderPage(pageUrl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

  try {
    const response = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: 'https://www.naijaprey.tv/',
      },
    })
    if (!response.ok) throw new Error(`np-downloader returned HTTP ${response.status}`)

    const html = await response.text()
    const $ = cheerio.load(html)

    const results = []
    const seen = new Set()

    const pageTitle = $('h1.entry-title, h1').first().text().trim() || $('title').text().replace(/\s*–\s*NP-Downloader\s*$/i, '').trim() || 'Download'

    // Find the sdm_download link (typically wildshare.net)
    $('a.sdm_download, a.sdm_download.black, .entry-content a[href]').each((_, el) => {
      const href = $(el).attr('href')
      if (!href || seen.has(href)) return
      const resolved = resolveUrl(href, pageUrl)
      seen.add(resolved)

      // Check if this is an external download host
      try {
        const hostname = new URL(resolved).hostname.toLowerCase()
        if (hostname.includes('wildshare') || hostname.includes('np-downloader') || hostname.includes('naijaprey')) {
          const text = $(el).text().trim() || 'Download'
          results.push({
            url: resolved,
            link: resolved,
            host: hostname,
            text,
          })
        }
      } catch {
        /* skip invalid URLs */
      }
    })

    return { results, title: pageTitle }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('np-downloader page fetch timed out')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// ---------- wildshare.net → direct media URL ----------

/**
 * Given a wildshare.net page URL, follow the pt= token chain
 * until we get a 302 redirect to the actual download URL.
 *
 * The chain works like:
 * 1. GET wildshare.net/{id} → page with .wildbutton onclick → pt=TOKEN_1
 * 2. GET wildshare.net/{id}?pt=TOKEN_1 (with cookies) → page with new wildbutton → pt=TOKEN_2
 * 3. Repeat until server responds with 302 redirect to silversurfer.wildshare.net/{id}/{filename}?download_token=...
 */
export async function resolveWildsharePage(pageUrl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)

  try {
    let currentUrl = pageUrl
    let cookies = ''
    let fileName = null

    // Extract filename from the page for result metadata
    const fileNameMatch = pageUrl.match(/\/([^/?]+?)(?:\.(?:mkv|mp4|avi|webm))?\/?$/)

    for (let hop = 0; hop < MAX_PT_HOPS; hop++) {
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(cookies ? { Cookie: cookies } : {}),
          ...(hop > 0 ? { Referer: pageUrl } : {}),
        },
      })

      // Merge cookies
      const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : String(response.headers.get('set-cookie') || '').split(/,(?=[^;]+=[^;]+)/)
      for (const cookie of setCookies) {
        const [pair] = cookie.split(';')
        const [name, ...rest] = pair.trim().split('=')
        if (name && rest.length) {
          if (!cookies) {
            cookies = `${name}=${rest.join('=')}`
          } else {
            // Replace or add cookie
            const re = new RegExp(`(^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=[^;]*`)
            if (re.test(cookies)) {
              cookies = cookies.replace(re, `$1${name}=${rest.join('=')}`)
            } else {
              cookies += `; ${name}=${rest.join('=')}`
            }
          }
        }
      }

      // 302 redirect to the actual file = success!
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location) {
          const resolvedUrl = new URL(location, currentUrl).href
          // URL-encode special characters in the path (brackets, spaces, etc.)
          // so the URL works properly when passed to the proxy
          let safeUrl
          try {
            const parsed = new URL(resolvedUrl)
            // Re-encode the pathname to handle unencoded brackets etc.
            const safePath = parsed.pathname.split('/').map((seg) => encodeURIComponent(decodeURIComponent(seg))).join('/')
            parsed.pathname = safePath
            safeUrl = parsed.href
          } catch {
            safeUrl = resolvedUrl
          }
          // This is the direct download URL
          return {
            directUrls: [safeUrl],
            thumbnail: null,
            requiresUserAction: false,
          }
        }
      }

      if (!response.ok && response.status !== 200) {
        break
      }

      const html = await response.text()

      // Try to extract filename from the page
      const $ = cheerio.load(html)
      const titleEl = $('.ft-title .heading3, .ft-title span').first()
      if (titleEl.length && !fileName) {
        fileName = titleEl.text().trim()
      }

      // Look for .wildbutton onclick with a new pt= token
      let nextPtUrl = null
      $('.wildbutton').each((_, el) => {
        const onclick = $(el).attr('onclick') || ''
        const match = onclick.match(/window\.location\s*=\s*'([^']+)'/)
        if (match) {
          nextPtUrl = match[1]
          return false // break
        }
      })

      if (!nextPtUrl) {
        // No more wildbutton — check for direct links
        const directMediaRe = /\.(mp4|m3u8|webm|mkv|avi|mov)(\?|#|$)/i
        let directUrl = null
        $('a[href], video[src], source[src]').each((_, el) => {
          const href = $(el).attr('href') || $(el).attr('src')
          if (href && directMediaRe.test(href)) {
            directUrl = resolveUrl(href, currentUrl)
            return false
          }
        })

        if (directUrl) {
          return {
            directUrls: [directUrl],
            thumbnail: null,
            requiresUserAction: false,
          }
        }

        // No wildbutton and no direct URL — we're stuck
        break
      }

      currentUrl = resolveUrl(nextPtUrl, pageUrl)
    }

    // Failed to resolve to a direct URL
    return { directUrls: [], thumbnail: null, requiresUserAction: true }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('wildshare resolution timed out')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// ---------- Full chain: naijaprey → np-downloader → wildshare → direct ----------

/**
 * Resolve a naijaprey.tv content page through the full download chain
 * to get direct playable media URLs.
 */
export async function resolveNaijapreyChain(contentUrl) {
  const results = []

  // Step 1: Fetch the naijaprey content page and extract np-downloader links
  const pageResult = await resolveNaijapreyPage(contentUrl)

  // Separate direct media links (from <video>/<source>) and np-downloader links
  const directResults = pageResult.results.filter((r) => r.isDirect)
  const downloaderLinks = pageResult.results.filter((r) => !r.isDirect)
  for (const link of downloaderLinks) {
    try {
      const npResult = await resolveNpDownloaderPage(link.url)

      // Step 3: For each wildshare link, resolve to direct URL
      for (const wsEntry of npResult.results) {
        try {
          const wsResult = await resolveWildsharePage(wsEntry.url)
          if (wsResult.directUrls.length) {
            for (const directUrl of wsResult.directUrls) {
              // Extract filename from URL
              let title = link.title || npResult.title || 'Video'
              try {
                const pathParts = new URL(directUrl).pathname.split('/')
                const rawName = decodeURIComponent(pathParts[pathParts.length - 1] || '')
                if (rawName && /\.(mkv|mp4|avi|webm)/i.test(rawName)) {
                  title = rawName.replace(/\.(mkv|mp4|avi|webm)$/i, '')
                }
              } catch {
                /* use default title */
              }

              // Proxy wildshare/silversurfer direct URLs so the browser can play them
              // (CORS + Referer + mixed content). Remux if MKV.
              const isMkv = /\.mkv(\?|#|$)/i.test(directUrl)
              // The wildshare landing page is the best Referer for the CDN;
              // fall back to the np-downloader page or naijaprey content page.
              const bestReferer = wsEntry.url || link.url || contentUrl
              const proxied = isMkv
                ? `/api/proxy?url=${encodeURIComponent(directUrl)}&remux=1&referer=${encodeURIComponent(bestReferer)}`
                : `/api/proxy?url=${encodeURIComponent(directUrl)}&referer=${encodeURIComponent(bestReferer)}`
              results.push({
                title,
                url: proxied,
                link: proxied,
                thumbnail: link.thumbnail || pageResult.thumbnail || null,
                image: link.thumbnail || pageResult.thumbnail || null,
                source: 'naijaprey',
                type: 'direct',
                isDirect: true,
                playableInRoom: true,
                videoType: 'direct',
                resolvedFrom: contentUrl,
                referer: bestReferer,
              })
            }
          }
        } catch (err) {
          console.error('Wildshare resolution failed:', err.message)
        }
      }
    } catch (err) {
      console.error('NP-Downloader resolution failed:', err.message)
    }
  }

  // If no results from the full chain, combine whatever we got from the content page
  if (results.length === 0 && pageResult.results.length > 0) {
    // Return page results — direct results are playable, non-direct are reference links
    return pageResult.results
  }

  // If we have chain results but also direct results from the content page, merge them
  if (directResults.length > 0 && results.length > 0) {
    return [...directResults, ...results]
  }

  return results
}
