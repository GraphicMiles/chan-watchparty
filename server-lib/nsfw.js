import * as cheerio from 'cheerio'

const XVIDEOS_SEARCH_URL = 'https://www.xvideos.com/'
// Vercel Hobby tier: 10s function timeout. Each provider gets 6s.
// 3 providers in parallel = max 6s total, leaving 4s for function overhead.
const SEARCH_TIMEOUT_MS = 6000

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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml',
          },
        })
        if (!response.ok) continue

        const html = await response.text()
        const $ = cheerio.load(html)

        $('li.pcVideoListItem, .videoblock, .videoBox').each((_, element) => {
          if (results.length >= limit) return false
          const item = $(element)
          const link = item.find('a[href*="/view_video.php"]').first().attr('href') || item.find('a[href]').first().attr('href')
          if (!link) return

          try {
            const url = new URL(link, PORNHUB_BASE).href
            if (seen.has(url) || !/pornhub\.com\/view_video\.php/i.test(url)) return
            seen.add(url)

            const title = item.find('.title a, .videoTitle, a[title]').first().attr('title') || item.find('.title a, .videoTitle').first().text().replace(/\s+/g, ' ').trim() || 'Untitled'
            const img = item.find('img[data-thumb_url], img[data-src], img[src]').first()
            const thumbnail = img.attr('data-thumb_url') || img.attr('data-src') || img.attr('src') || null
            const duration = item.find('.duration').first().text().replace(/\s+/g, ' ').trim() || null

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
  // Try both URL patterns and merge results
  const searchUrls = [
    `${SPANKBANG_BASE}/s/${encodeURIComponent(query)}/`,
    `${SPANKBANG_BASE}/video/search?search=${encodeURIComponent(query)}`,
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml',
          },
        })
        if (!response.ok) continue

        const html = await response.text()
        const $ = cheerio.load(html)

        $('.video-item, .thumb-item').each((_, element) => {
          if (results.length >= limit) return false
          const item = $(element)
          const link = item.find('a[href*="/video/"]').first().attr('href') || item.find('a.n[href]').first().attr('href') || item.find('a[href]').first().attr('href')
          if (!link) return

          try {
            const url = new URL(link, SPANKBANG_BASE).href
            if (seen.has(url) || !/spankbang\.(com|party)\/.*\/video\//i.test(url)) return
            seen.add(url)

            const title = item.find('a.n, .n, .title').first().text().replace(/\s+/g, ' ').trim() || item.find('img').first().attr('alt') || 'Untitled'
            const img = item.find('img[data-src], img[src]').first()
            const thumbnail = img.attr('data-src') || img.attr('src') || null
            const duration = item.find('.l, .duration').first().text().replace(/\s+/g, ' ').trim() || null

            results.push({
              id: item.attr('data-id') || url,
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

    // Race all 3 providers against a global 7s deadline (leaves 3s for Vercel overhead)
    const globalDeadline = setTimeout(() => {}, 7000)
    const globalController = new AbortController()

    const [xv, ph, sb] = await Promise.all([
      searchXVideos(query, perProvider).catch(() => []),
      searchPornhub(query, perProvider).catch(() => []),
      searchSpankBang(query, perProvider).catch(() => []),
    ])
    clearTimeout(globalDeadline)
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
