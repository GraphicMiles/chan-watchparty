import * as cheerio from 'cheerio'

const XVIDEOS_SEARCH_URL = 'https://www.xvideos.com/'
const SEARCH_TIMEOUT_MS = 8000

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
        requiresUserAction: true,
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

// Provider registry: add a new adapter module here rather than changing the
// media API dispatcher. Each adapter must return the shared result schema and
// must not bypass login, paywall, CAPTCHA, or anti-bot controls.
const NSFW_PROVIDERS = {
  xvideos: {
    id: 'xvideos',
    label: 'XVIDEOS',
    search: searchXVideos,
  },
}

export function getNsfwProviderIds() {
  return Object.keys(NSFW_PROVIDERS)
}

export async function searchNsfwProvider(provider, query, limit = 20) {
  const adapter = NSFW_PROVIDERS[provider]
  if (!adapter) throw Object.assign(new Error(`Unsupported NSFW provider: ${provider}`), { status: 400 })
  return adapter.search(query, limit)
}
