import * as cheerio from 'cheerio'

const XVIDEOS_SEARCH_URL = 'https://www.xvideos.com/'
// Vercel Hobby tier: 10s function timeout. Each provider gets 5s.
// 3 providers in parallel = max 5s total, leaving 5s for function overhead.
const SEARCH_TIMEOUT_MS = 5000

function buildXVideosSearchUrl(query) {
  const url = new URL(XVIDEOS_SEARCH_URL)
  url.searchParams.set('k', query)
  return url.href
}

async function searchXVideos(query, limit = 20) {
  const searchUrl = buildXVideosSearchUrl(query)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

  try {
    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ChanMediaResolver/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!response.ok) throw new Error(`XVIDEOS returned HTTP ${response.status}`)

    const html = await response.text()
    const $ = cheerio.load(html)
    const results = []
    const seen = new Set()

    $('.thumb-block').each((_, element) => {
      if (results.length >= limit) return false
      const item = $(element)
      const link = item.find('.thumb a[href], .title a[href]').first().attr('href')
      if (!link) return

      const url = new URL(link, searchUrl).href
      if (seen.has(url) || !/xvideos\.com$/i.test(new URL(url).hostname)) return
      seen.add(url)

      const titleLink = item.find('.title a[title], .title a').first()
      const title = titleLink.attr('title') || titleLink.text().replace(/\s+/g, ' ').trim() || 'Untitled'
      const thumbnail = item.find('img[data-src], img[data-sfwthumb], img[data-mzl]').first()
      const duration = item.find('.duration').first().text().replace(/\s+/g, ' ').trim() || null
      const quality = item.find('.video-hd-mark, .video-sd-mark').first().text().trim() || null

      results.push({
        id: item.attr('data-id') || url,
        title,
        url,
        link: url,
        thumbnail: thumbnail.attr('data-src') || thumbnail.attr('data-sfwthumb') || thumbnail.attr('data-mzl') || null,
        duration,
        quality,
        source: 'xvideos',
        provider: 'xvideos',
        type: 'nsfw',
        isNSFW: true,
        isDirect: false,
        playableInRoom: true,
        requiresUserAction: true,
        meta: 'Tap to resolve and play',
      })
    })

    return results
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('XVIDEOS search timed out')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function searchPornhub(query, limit = 20) {
  const PORNHUB_BASE = 'https://www.pornhub.com'
  // Try both URL patterns and merge results
  const searchUrls = [
    `${PORNHUB_BASE}/video/search?search=${encodeURIComponent(query)}`,
    `${PORNHUB_BASE}/s/${encodeURIComponent(query)}`,
  ]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  const results = []
  const seen = new Set()

  try {
    for (const searchUrl of searchUrls) {
      if (results.length >= limit) break
      try {
        const response = await fetch(searchUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://www.pornhub.com/',
          },
          redirect: 'follow',
        })
        if (!response.ok) continue

        const html = await response.text()
        const $ = cheerio.load(html)

        // PornHub uses multiple selectors across versions
        $('li.pcVideoListItem, .videoblock, .videoBox, .videoWrap, li[data-video-vkey]').each((_, element) => {
          if (results.length >= limit) return false
          const item = $(element)
          const link = item.find('a[href*="/view_video.php"]').first().attr('href') || item.find('a[href]').first().attr('href')
          if (!link) return

          try {
            const url = new URL(link, PORNHUB_BASE).href
            if (seen.has(url)) return
            // Must be a view_video.php URL or a valid video page URL
            if (!/pornhub\.com\/view_video\.php/i.test(url) && !/pornhub\.com\/view_video\.php\?viewkey=/i.test(url)) {
              // Accept slug-based URLs like /embed/XXXX or direct video pages
              if (!/pornhub\.com\/(view_video|embed|album)/i.test(url)) return
            }
            seen.add(url)

            const title = item.find('.title a, .videoTitle, a[title]').first().attr('title')
              || item.find('.title a, .videoTitle').first().text().replace(/\s+/g, ' ').trim()
              || item.find('a[title]').first().attr('title')
              || item.find('img').first().attr('alt')
              || 'Untitled'
            const img = item.find('img[data-thumb_url], img[data-src], img[data-mediumthumb], img[src]').first()
            const thumbnail = img.attr('data-thumb_url') || img.attr('data-src') || img.attr('data-mediumthumb') || img.attr('src') || null
            const duration = item.find('.duration, .videoDuration').first().text().replace(/\s+/g, ' ').trim() || null

            results.push({
              id: item.attr('data-video-vkey') || url,
              title,
              url,
              link: url,
              thumbnail,
              duration,
              source: 'pornhub',
              provider: 'pornhub',
              type: 'nsfw',
              isNSFW: true,
              isDirect: false,
              playableInRoom: true,
              requiresUserAction: true,
              meta: 'Tap to resolve and play',
            })
          } catch {
            /* ignore */
          }
        })

        // Fallback: if no results from selectors, extract view_video links from raw HTML
        if (results.length === 0) {
          const videoLinkRegex = /href="(https?:\/\/(?:www\.)?pornhub\.com\/view_video\.php\?viewkey=[a-z0-9]+)"/gi
          let match
          const fallbackSeen = new Set()
          while ((match = videoLinkRegex.exec(html)) !== null && results.length < limit) {
            const url = match[1]
            if (fallbackSeen.has(url)) continue
            fallbackSeen.add(url)
            if (seen.has(url)) continue
            seen.add(url)
            // Extract title from surrounding context
            const contextStart = Math.max(0, match.index - 300)
            const contextEnd = Math.min(html.length, match.index + 500)
            const context = html.slice(contextStart, contextEnd)
            const titleMatch = context.match(/title="([^"]+)"/) || context.match(/alt="([^"]+)"/)
            const title = titleMatch?.[1] || 'PornHub Video'
            const imgMatch = context.match(/(?:data-thumb_url|data-src|src)="(https?:[^"]+)"/)
            const thumbnail = imgMatch?.[1] || null
            const durMatch = context.match(/(\d+:\d+:\d+|\d+:\d+)/)
            const duration = durMatch?.[1] || null

            results.push({
              id: url,
              title,
              url,
              link: url,
              thumbnail,
              duration,
              source: 'pornhub',
              provider: 'pornhub',
              type: 'nsfw',
              isNSFW: true,
              isDirect: false,
              playableInRoom: true,
              requiresUserAction: true,
              meta: 'Tap to resolve and play',
            })
          }
        }
      } catch {
        /* try next URL pattern */
      }
    }

    return results
  } catch {
    return results
  } finally {
    clearTimeout(timer)
  }
}

async function searchSpankBang(query, limit = 20) {
  const SPANKBANG_BASE = 'https://spankbang.party'
  // Try multiple URL patterns — SpankBang has changed search endpoints over time
  const searchUrls = [
    `${SPANKBANG_BASE}/s/${encodeURIComponent(query)}/1/?o=all&q=${encodeURIComponent(query)}`,
    `${SPANKBANG_BASE}/s/${encodeURIComponent(query)}/`,
    `${SPANKBANG_BASE}/s/${encodeURIComponent(query)}/1/`,
  ]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  const results = []
  const seen = new Set()

  try {
    for (const searchUrl of searchUrls) {
      if (results.length >= limit) break
      try {
        const response = await fetch(searchUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://spankbang.party/',
          },
          redirect: 'follow',
        })
        if (!response.ok) continue

        const html = await response.text()
        const $ = cheerio.load(html)

        // SpankBang uses multiple possible selectors across versions
        // .video-item is the current main one; .thumb-block and .thumb-item are legacy
        $('.video-item, .thumb-item, .thumb-block, li.video, .result-item, .video-list-item').each((_, element) => {
          if (results.length >= limit) return false
          const item = $(element)

          // Find the video page link — SpankBang video URLs look like /XXXX/video/slug/
          // Also accept direct /XXXX/ slugs that redirect to video pages
          const link = item.find('a[href*="/video/"]').first().attr('href')
            || item.find('a[href]').filter((_, a) => {
              const href = $(a).attr('href') || ''
              return /\/[a-z0-9]{4,10}(?:\/video\/|\/$)/i.test(href) && !href.includes('/s/') && !href.includes('/search')
            }).first().attr('href')
            || item.find('a.n[href]').first().attr('href')
            || item.find('a[href]').first().attr('href')
          if (!link) return

          try {
            const url = new URL(link, SPANKBANG_BASE).href
            // Accept both /XXXX/video/SLUG/ and /XXXX/ patterns (SpankBang video pages)
            if (seen.has(url)) return
            // Reject search/category pages
            if (/\/(s|search|category|tag|pornstar|channel|playlist)\//i.test(url)) return
            // Must be a spankbang video page
            if (!/spankbang\.(com|party|com\.edge)\/[a-z0-9]{3,}/i.test(url)) return
            seen.add(url)

            const title = item.find('a.n, .n, .title, a[title]').first().attr('title')
              || item.find('a.n, .n, .title').first().text().replace(/\s+/g, ' ').trim()
              || item.find('img').first().attr('alt')
              || item.find('img').first().attr('title')
              || 'Untitled'
            const img = item.find('img[data-src], img[data-original], img[lazy-src], img[src]').first()
            const thumbnail = img.attr('data-src') || img.attr('data-original') || img.attr('lazy-src') || img.attr('src') || null
            const duration = item.find('.l, .duration, .video-length, time').first().text().replace(/\s+/g, ' ').trim() || null

            results.push({
              id: item.attr('data-id') || item.attr('data-video-id') || url,
              title,
              url,
              link: url,
              thumbnail,
              duration,
              source: 'spankbang',
              provider: 'spankbang',
              type: 'nsfw',
              isNSFW: true,
              isDirect: false,
              playableInRoom: true,
              requiresUserAction: true,
              meta: 'Tap to resolve and play',
            })
          } catch {
            /* ignore */
          }
        })

        // Fallback: if no results from selectors, try extracting links from raw HTML
        if (results.length === 0) {
          const videoLinkRegex = /href="(\/[a-z0-9]{4,10}\/video\/[^"]+\/?)"/gi
          let match
          const fallbackSeen = new Set()
          while ((match = videoLinkRegex.exec(html)) !== null && results.length < limit) {
            const href = match[1]
            if (fallbackSeen.has(href)) continue
            fallbackSeen.add(href)
            try {
              const url = new URL(href, SPANKBANG_BASE).href
              if (seen.has(url)) continue
              seen.add(url)
              // Try to extract title from surrounding context
              const contextStart = Math.max(0, match.index - 500)
              const contextEnd = Math.min(html.length, match.index + 500)
              const context = html.slice(contextStart, contextEnd)
              const titleMatch = context.match(/title="([^"]+)"/) || context.match(/alt="([^"]+)"/)
              const title = titleMatch?.[1] || 'SpankBang Video'
              const imgMatch = context.match(/(?:data-src|src)="(https?:[^"]+)"/)
              const thumbnail = imgMatch?.[1] || null
              const durMatch = context.match(/(\d+:\d+)/)
              const duration = durMatch?.[1] || null

              results.push({
                id: url,
                title,
                url,
                link: url,
                thumbnail,
                duration,
                source: 'spankbang',
                provider: 'spankbang',
                type: 'nsfw',
                isNSFW: true,
                isDirect: false,
                playableInRoom: true,
                requiresUserAction: true,
                meta: 'Tap to resolve and play',
              })
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* try next URL pattern */
      }
    }

    return results
  } catch {
    return results
  } finally {
    clearTimeout(timer)
  }
}

// Provider registry: add a new adapter module here rather than changing the
// media API dispatcher. Each adapter must return the shared result schema and
// must not bypass login, paywall, CAPTCHA, or anti-bot controls.
const NSFW_PROVIDERS = {
  xvideos: {
    id: 'xvideos',
    label: 'XVIDEOS',
    search: searchXVideos,
  },
  pornhub: {
    id: 'pornhub',
    label: 'PORNHUB',
    search: searchPornhub,
  },
  spankbang: {
    id: 'spankbang',
    label: 'SPANKBANG',
    search: searchSpankBang,
  },
}

export function getNsfwProviderIds() {
  return Object.keys(NSFW_PROVIDERS)
}

export async function searchNsfwProvider(provider, query, limit = 100) {
  if (!provider || provider === 'all' || !NSFW_PROVIDERS[provider]) {
    // Fetch up to 25 per provider so interleaving can fill ~75 results
    // Reduced from 40 to stay within Vercel Hobby 10s timeout
    const perProvider = Math.min(25, Math.max(10, Math.ceil(limit / 3)))

    const [xv, ph, sb] = await Promise.all([
      searchXVideos(query, perProvider).catch((err) => {
        console.error('XVIDEOS search failed:', err.message)
        return []
      }),
      searchPornhub(query, perProvider).catch((err) => {
        console.error('PornHub search failed:', err.message)
        return []
      }),
      searchSpankBang(query, perProvider).catch((err) => {
        console.error('SpankBang search failed:', err.message)
        return []
      }),
    ])

    // Interleave results round-robin from all three providers so the user sees
    // a mix of sources instead of all XVideos first, then all PornHub, etc.
    const all = []
    const lists = [xv, ph, sb].filter((l) => l.length > 0)
    let added = true
    while (added) {
      added = false
      for (const l of lists) {
        if (l.length > 0) {
          all.push(l.shift())
          added = true
        }
      }
    }
    return all
  }
  const adapter = NSFW_PROVIDERS[provider]
  return adapter.search(query, limit)
}
