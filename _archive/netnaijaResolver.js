/**
 * NetNaija Resolver
 *
 * Resolves the full download chain:
 *   thenetnaija.ng/{slug}-movie-download/          (content page)
 *   → mynetnaija.ng/episode-download/download-movie-{id}/  (download page)
 *   → meetdownload.com/{hash}/{filename}            (intermediate page)
 *   → {sub}.kissorgrab.com/dl/{token}/...           (actual file CDN URL)
 *
 * The CDN URL is embedded in meetdownload.com's HTML as:
 *   document.getElementById('downloadButton').onclick = function() {
 *       location.href = 'https://{sub}.kissorgrab.com/dl/…';
 *   };
 *
 * No Puppeteer needed — we extract the URL with regex from the raw HTML.
 * MKV files from this source won't play natively in the browser (only MP4/WebM).
 *
 * NOTE: mynetnaija.ng returns HTTP 404 status but still serves the page HTML.
 *       We read the body even on 404 responses for that host.
 */

import * as cheerio from 'cheerio'

/**
 * Search thenetnaija.ng using WordPress ?s= parameter
 * @param {string} query - Search term
 * @param {number} limit - Max results
 * @returns {Promise<Array<{title, url, thumbnail, source}>>}
 */
export async function searchNetNaija(query, limit = 15) {
  const searchUrl = `https://thenetnaija.ng/?s=${encodeURIComponent(query)}`
  const html = await fetchHtml(searchUrl)
  if (!html) return []

  const $ = cheerio.load(html)
  const results = []
  const seen = new Set()

  // NetNaija search results use .magsoul-grid-post-title h3 > a for titles
  // and .magsoul-grid-post-thumbnail-link for thumbnail links
  // They are NOT wrapped in <article> tags on the search page
  // We prefer title links over thumbnail links to avoid extracting <img> HTML as title

  // Step 1: Collect title links (preferred — they have clean text)
  const titleLinks = new Map()
  $('h3.magsoul-grid-post-title a, .magsoul-grid-post-title a').each((_, el) => {
    const href = $(el).attr('href') || ''
    const text = $(el).text().trim().replace(/\s+/g, ' ')
    if (href && text && text.length >= 3 && href.includes('-download')) {
      titleLinks.set(href, text)
    }
  })

  // Step 2: Collect all content page links
  const contentLinks = new Set()
  $('a[href*="-movie-download/"], a[href*="-series-download/"]').each((_, el) => {
    const href = $(el).attr('href') || ''
    if (href && !href.includes('/?s=') && !href.includes('/search') && !href.includes('/feed')) {
      contentLinks.add(href)
    }
  })

  for (const href of contentLinks) {
    if (seen.has(href)) continue
    seen.add(href)

    // Use the clean title from the h3 link if available
    let title = titleLinks.get(href) || ''
    // Derive from slug if no clean title
    if (!title || title.length < 3) {
      const slug = href.split('/').filter(Boolean).pop() || ''
      title = slug
        .replace(/-movie-download$/i, '')
        .replace(/-series-download$/i, '')
        .replace(/-/g, ' ')
        .replace(/\b(\d{4})\b/, '($1)')
        .replace(/\b\w/g, c => c.toUpperCase())
    }

    // Get thumbnail — NetNaija uses lazy loading (data-src) on thumbnail link containers
    const thumbnailLink = $(`a.magsoul-grid-post-thumbnail-link[href="${href}"]`)
    let img = thumbnailLink.find('img[data-src]').first().attr('data-src') ||
              thumbnailLink.find('img[src]').first().attr('src') || null
    // Also check noscript fallback
    if (!img) {
      const noscriptImg = thumbnailLink.find('noscript').html()
      if (noscriptImg) {
        const srcMatch = noscriptImg.match(/src="([^"]+)"/)
        if (srcMatch) img = srcMatch[1]
      }
    }
    // Broader fallback: any uploads image on the page
    if (!img) {
      img = $('img[data-src*="wp-content/uploads"]').first().attr('data-src') ||
            $('img[src*="wp-content/uploads"]').first().attr('src') || null
    }

    // Skip unsuitable thumbnails (ad images, icons, lazy placeholder GIFs)
    if (img && /hot7movies|whatsapp|logo|banner|favicon|1x1|pixel|home-round|data:image\/gif/i.test(img)) {
      img = null
    }
    // Resolve relative URLs
    if (img && !img.startsWith('http')) {
      img = `https://thenetnaija.ng${img.startsWith('/') ? '' : '/'}${img}`
    }

    results.push({
      title,
      url: href,
      link: href,
      thumbnail: img,
      image: img,
      source: 'netnaija',
      type: 'direct',
      isDirect: false, // content page, needs resolution
      playableInRoom: false,
    })

    if (results.length >= limit) break
  }

  return results
}

/**
 * Resolve a thenetnaija.ng content page → mynetnaija.ng download page → meetdownload → CDN URL
 * @param {string} contentPageUrl - The thenetnaija.ng content page URL
 * @returns {Promise<Array<{title, url, source, isDirect, playableInRoom}>>}
 */
export async function resolveNetNaijaChain(contentPageUrl) {
  const hostname = new URL(contentPageUrl).hostname.toLowerCase()

  // If we're already on meetdownload.com, skip ahead
  if (hostname.includes('meetdownload.com')) {
    return resolveMeetDownloadUrl(contentPageUrl)
  }

  // If we're on mynetnaija.ng, skip to meetdownload
  if (hostname.includes('mynetnaija.ng')) {
    return resolveMyNetNaijaPage(contentPageUrl)
  }

  // Step 1: Scrape thenetnaija.ng content page → find mynetnaija download link
  const contentHtml = await fetchHtml(contentPageUrl)
  if (!contentHtml) return []

  // Also try to extract metadata from the content page (title, thumbnail)
  const contentMeta = extractContentPageMeta(contentHtml)

  const mynetnaijaUrl = extractMyNetNaijaLink(contentHtml, contentPageUrl)
  if (!mynetnaijaUrl) {
    // Maybe it links directly to meetdownload
    const meetdownloadUrl = extractMeetDownloadLink(contentHtml, contentPageUrl)
    if (meetdownloadUrl) {
      const results = await resolveMeetDownloadUrl(meetdownloadUrl)
      return applyContentMeta(results, contentMeta)
    }
    return []
  }

  // Step 2: Scrape mynetnaija.ng → find meetdownload link
  const results = await resolveMyNetNaijaPage(mynetnaijaUrl)
  return applyContentMeta(results, contentMeta)
}

/**
 * Apply content page metadata (title, thumbnail) to resolved results
 */
function applyContentMeta(results, meta) {
  if (!meta) return results
  return results.map(r => ({
    ...r,
    title: r.title === 'Video' && meta.title ? meta.title : r.title,
    thumbnail: r.thumbnail || meta.thumbnail || null,
    image: r.image || meta.thumbnail || null,
  }))
}

/**
 * Extract metadata (title, thumbnail) from a thenetnaija content page
 */
function extractContentPageMeta(html) {
  const $ = cheerio.load(html)
  const title = $('h1, .entry-title, .file-title').first().text().trim() || null

  // Get the featured image (full-size, not the small thumbnail)
  let img = $('meta[property="og:image"]').attr('content') ||
            $('a[href*="blogger.googleusercontent.com"]').attr('href') ||
            $('.featured-image img, article img[src*="blogger.googleusercontent"]').first().attr('src') ||
            $('img.wp-post-image').first().attr('src') || null

  if (img && /hot7movies|whatsapp|logo|banner|favicon|1x1|pixel/i.test(img)) {
    img = null
  }

  return { title, thumbnail: img }
}

/**
 * Resolve a mynetnaija.ng download page → meetdownload → CDN URL
 */
async function resolveMyNetNaijaPage(mynetnaijaUrl) {
  // mynetnaija.ng returns 404 but still serves the HTML body
  const html = await fetchHtml(mynetnaijaUrl, { accept404: true })
  if (!html) return []

  const meetdownloadUrl = extractMeetDownloadLink(html, mynetnaijaUrl)
  if (!meetdownloadUrl) return []

  return resolveMeetDownloadUrl(meetdownloadUrl)
}

/**
 * Extract the mynetnaija.ng download link from a thenetnaija content page
 */
function extractMyNetNaijaLink(html, baseUrl) {
  const $ = cheerio.load(html)

  // Look for link to mynetnaija.ng/episode-download/
  const selectors = [
    'a[href*="mynetnaija.ng/episode-download/"]',
    'a[href*="mynetnaija.ng"]',
  ]

  for (const sel of selectors) {
    const elements = $(sel)
    for (const el of elements) {
      const href = $(el).attr('href')
      if (href && href.includes('mynetnaija')) {
        return resolveHref(href, baseUrl)
      }
    }
  }

  // Fallback: try by text content
  $('a').each((_, el) => {
    const text = $(el).text().trim().toUpperCase()
    const href = $(el).attr('href') || ''
    if (text.includes('DOWNLOAD MOVIE') && href.includes('mynetnaija')) {
      return resolveHref(href, baseUrl)
    }
  })

  // Fallback: regex scan
  const match = html.match(/https?:\/\/(?:www\.)?mynetnaija\.ng\/episode-download\/[^\s"'<>]+/i)
  return match ? match[0] : null
}

/**
 * Extract the meetdownload.com link from a mynetnaija download page
 */
function extractMeetDownloadLink(html, baseUrl) {
  const $ = cheerio.load(html)

  // Look for meetdownload link — mynetnaija uses #downloadButton or a.button
  const selectors = [
    'a[href*="meetdownload.com/"]',
    'a#downloadButton[href*="meetdownload"]',
    'a.button[href*="meetdownload"]',
  ]

  for (const sel of selectors) {
    const el = $(sel).first()
    const href = el.attr('href')
    if (href && href.includes('meetdownload.com')) {
      return resolveHref(href, baseUrl)
    }
  }

  // Fallback: regex scan for meetdownload URL with hash pattern
  const match = html.match(/https?:\/\/(?:www\.)?meetdownload\.com\/[a-f0-9]{32}\/[^\s"'<>]+/i)
  return match ? match[0] : null
}

/**
 * Resolve a meetdownload.com URL → extract the kissorgrab CDN URL from the JS in the HTML.
 * No Puppeteer needed — the download URL is embedded in the onclick handler.
 */
async function resolveMeetDownloadUrl(meetdownloadUrl) {
  const html = await fetchHtml(meetdownloadUrl)
  if (!html) return []

  // Extract the CDN URL from the downloadButton onclick handler
  // Pattern: location.href = 'https://{sub}.kissorgrab.com/dl/...';
  // or: var currentTabUrl = 'https://{sub}.kissorgrab.com/dl/...';
  const cdnPatterns = [
    // location.href = 'URL' (inside the first uncommented onclick block)
    /location\.href\s*=\s*['"](https?:\/\/[^'"]+kissorgrab[^'"]+)['"]/i,
    // window.location.href = 'URL'
    /window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+kissorgrab[^'"]+)['"]/i,
    // var currentTabUrl = 'URL' (inside commented-out second onclick block)
    /var\s+currentTabUrl\s*=\s*['"](https?:\/\/[^'"]+kissorgrab[^'"]+)['"]/i,
  ]

  let cdnUrl = null
  for (const pattern of cdnPatterns) {
    const match = html.match(pattern)
    if (match) {
      cdnUrl = match[1]
      break
    }
  }

  // Extract title from the page
  const $ = cheerio.load(html)
  const pageTitle = $('h1').first().text().trim() ||
                    $('title').first().text().replace(/Download\s*/i, '').trim() ||
                    decodeURIComponent(meetdownloadUrl.split('/').pop() || 'Video')

  // Extract file size if present
  const sizeMatch = html.match(/\((\d+(?:\.\d+)?\s*(?:MB|GB))\)/i)
  const sizeInfo = sizeMatch ? sizeMatch[1] : ''

  // Extract subtitle download URL too (if available)
  const subtitleUrl = extractSubtitleUrl(html)
  const results = []

  if (cdnUrl) {
    // Detect file format from CDN URL or meetdownload page filename
    // CDN URL ends with /filename-ext (e.g., /ikka-2026-32760-mkv)
    // meetdownload page has <h1>Filename.EXT</h1>
    const cdnPathSegment = cdnUrl.split('/').pop() || ''
    const isMp4 = /\.mp4(\?|#|$)/i.test(cdnUrl) || /-mp4(\?|#|$)/i.test(cdnPathSegment)
    const isMkv = /\.mkv(\?|#|$)/i.test(cdnUrl) || /-mkv(\?|#|$)/i.test(cdnPathSegment)

    // Also check the page title for extension hints
    const titleExt = pageTitle.match(/\.(mp4|mkv|avi|webm)/i)?.[1]?.toLowerCase()
    const fileFormat = titleExt || (isMp4 ? 'mp4' : (isMkv ? 'mkv' : null))
    // MKV files are now playable — proxy remuxes them to MP4 on-the-fly
    const canPlayInBrowser = true

    let cleanTitle = pageTitle
    if (sizeInfo && !cleanTitle.includes(sizeInfo)) {
      cleanTitle = `${cleanTitle} (${sizeInfo})`
    }

    results.push({
      title: cleanTitle,
      url: cdnUrl,
      link: cdnUrl,
      source: 'netnaija',
      type: 'direct',
      isDirect: true,
      playableInRoom: canPlayInBrowser,
      quality: isMkv || fileFormat === 'mkv' ? 'MKV' : (isMp4 || fileFormat === 'mp4' ? 'HD' : null),
      meta: isMkv || fileFormat === 'mkv' ? 'MKV — auto-converted to MP4 for playback' : null,
      resolvedFrom: meetdownloadUrl,
    })

    if (subtitleUrl) {
      results.push({
        title: `${pageTitle} — Subtitle`,
        url: subtitleUrl,
        link: subtitleUrl,
        source: 'netnaija',
        type: 'direct',
        isDirect: true,
        playableInRoom: false,
        meta: 'Subtitle file',
        resolvedFrom: meetdownloadUrl,
      })
    }
  } else {
    // Couldn't extract CDN URL from HTML — return the meetdownload page as requiring user action
    results.push({
      title: pageTitle,
      url: meetdownloadUrl,
      link: meetdownloadUrl,
      source: 'netnaija',
      type: 'direct',
      isDirect: false,
      requiresUserAction: true,
      meta: 'Download button on external page — could not resolve automatically',
    })
  }

  return results
}

/**
 * Extract subtitle download URL from meetdownload page
 */
function extractSubtitleUrl(html) {
  // Find the downloadsButton onclick block, then extract the kissorgrab URL from it
  // The page has two separate <script> blocks: one for #downloadButton, one for #downloadsButton
  const scriptBlocks = html.match(/<script>[\s\S]*?<\/script>/gi) || []

  for (const block of scriptBlocks) {
    if (block.includes('downloadsButton')) {
      const urlMatch = block.match(/(?:location\.href|window\.location\.href)\s*=\s*['"](https?:\/\/[^'"]+)['"]/i)
      if (urlMatch && urlMatch[1].includes('kissorgrab')) {
        return urlMatch[1]
      }
    }
  }
  return null
}

/**
 * Resolve a relative/absolute href against a base URL
 */
function resolveHref(href, baseUrl) {
  if (!href) return null
  try {
    if (href.startsWith('http://') || href.startsWith('https://')) return href
    if (href.startsWith('//')) return `https:${href}`
    return new URL(href, baseUrl).href
  } catch {
    return href
  }
}

/**
 * Fetch HTML content with retries.
 * @param {string} url - URL to fetch
 * @param {object} options
 * @param {boolean} options.accept404 - Accept 404 status (mynetnaija.ng returns 404 but has valid body)
 * @param {number} retries - Number of retries
 */
async function fetchHtml(url, { accept404 = false } = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      })
      clearTimeout(timeout)

      // mynetnaija.ng returns 404 but serves the page HTML — accept it if flagged
      if (!res.ok && !(accept404 && res.status === 404)) {
        throw new Error(`HTTP ${res.status}`)
      }

      return await res.text()
    } catch (err) {
      if (attempt === retries) {
        console.error(`NetNaija fetchHtml failed for ${url}: ${err.message}`)
        return null
      }
      // Brief delay before retry
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  return null
}
