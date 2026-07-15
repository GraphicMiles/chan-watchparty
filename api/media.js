import * as cheerio from 'cheerio'
import { createHash } from 'node:crypto'
import { preflight, ok, fail, statusForError } from '../server-lib/http.js'
import { getDb, FieldValue, verifyIdToken } from '../server-lib/firebaseAdmin.js'
import { getSiteConfig, resolveUrl, isSuitableThumbnail, isTitleMatch, cleanTitleForMatching, cleanTitleForOMDb } from '../server-lib/sources.js'
import { checkRateLimit, clientKey } from '../server-lib/rateLimit.js'
import { validateFetchUrl, isPrivateHost } from '../server-lib/ssrf.js'
import { checkIptvChannel, getIptvChannels, getPlaylistChannels } from '../server-lib/iptv.js'
import { resolveDownloadwellaPage } from '../server-lib/downloadwella.js'
import { searchNsfwProvider } from '../server-lib/nsfw.js'
import { resolveNsfwVideoUrl, isNsfwProviderUrl } from '../server-lib/nsfwResolver.js'
import { searchNaijaprey, resolveNaijapreyChain } from '../server-lib/naijapreyResolver.js'
import { resolveO2TvShow, resolveO2TvEpisode, probeAndFixO2TvUrl, warmO2TvCache } from '../server-lib/o2tvResolver.js'
import { resolveMeetDownload, resolveWaploaded, resolveGenericBrowser, getRenderedHtml, isBrowserAvailable } from '../server-lib/browser.js'
import { searchNetNaija, resolveNetNaijaChain } from '../server-lib/netnaijaResolver.js'
import { resolveArchiveOrgPage, resolveArchiveOrgDirectUrl } from '../server-lib/archiveResolver.js'
import { searchMaxCinema, resolveMaxCinemaChain } from '../server-lib/maxcinemaResolver.js'
import { resolveDoodUrl, isDoodUrl } from '../server-lib/doodResolver.js'
import { sanitizeSearchQuery, sanitizeUrl, sanitizeAction } from '../server-lib/sanitize.js'

const ALLOWED_MEDIA_ACTIONS = ['search', 'scrape', 'refreshCatalog']

const MEDIA_EXT_RE = /\.(mp4|m3u8|webm|ogg|mov|mkv|avi|flv|ts)(\?|#|$)/i
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY // server-side only — never use VITE_ prefix
const OMDB_API_KEY = process.env.OMDB_API_KEY || null  // no hardcoded fallback — must be configured
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY

/**
 * Route a remote media URL through /api/proxy so the browser can play it
 * over HTTPS with the correct upstream Referer. MKV files get remux=1.
 */
function toProxiedPlaybackUrl(mediaUrl, { referer } = {}) {
  if (!mediaUrl || typeof mediaUrl !== 'string') return mediaUrl
  if (mediaUrl.startsWith('/api/proxy')) return mediaUrl
  try {
    const parsed = new URL(mediaUrl)
    const isMkv = /\.mkv(\?|#|$)/i.test(parsed.pathname)
      || /-mkv(\?|#|$)/i.test(parsed.pathname)
      || parsed.searchParams.getAll('name').some((v) => /\.mkv$/i.test(v) || /-mkv$/i.test(v))
    let out = `/api/proxy?url=${encodeURIComponent(mediaUrl)}`
    if (isMkv) out += '&remux=1'
    if (referer && /^https?:\/\//i.test(referer)) {
      out += `&referer=${encodeURIComponent(referer)}`
    }
    return out
  } catch {
    return `/api/proxy?url=${encodeURIComponent(mediaUrl)}`
  }
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Expand a query with season variants for broader TV show discovery.
 * "silo" → ["silo", "silo season 1", "silo season 2", "silo season 3", "silo season 4"]
 * If the query already contains a season/episode marker, no expansion.
 */
function expandQueryWithSeasons(query) {
  if (!query || !query.trim()) return [query]
  const clean = query.trim()
  // Don't expand if query already targets a specific season or episode
  if (/\b(season\s*\d+|s\d+\s*e\d+|s\d+\b|episode\s*\d+)\b/i.test(clean)) {
    return [clean]
  }
  return [
    clean,
    `${clean} season 1`,
    `${clean} season 2`,
    `${clean} season 3`,
    `${clean} season 4`,
  ]
}

function extractQuality(text) {
  const match = text?.match(/\b(4K|2160p|1440p|1080p|720p|480p|360p|HD|SD|HQ|FullHD)\b/i)
  return match?.[1] || null
}

function parseDuration(iso) {
  if (!iso) return 0
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!match) return 0
  const [, h, m, s] = match
  return (parseInt(h) || 0) * 3600 + (parseInt(m) || 0) * 60 + (parseInt(s) || 0)
}

function formatDuration(iso) {
  const seconds = parseDuration(iso)
  if (!seconds) return null
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatMatchTime(utcDate) {
  const date = new Date(utcDate)
  const now = new Date()
  const diff = date - now
  
  if (diff < 0 && diff > -3 * 60 * 60 * 1000) return 'LIVE NOW'
  if (diff > 0 && diff < 24 * 60 * 60 * 1000) {
    return `Today ${date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`
  }
  return date.toLocaleDateString()
}

function deduplicateAndEnrich(items, query = null) {
  if (!Array.isArray(items)) return []
  const seenUrls = new Set()
  const seenTitles = new Set()
  
  return items.filter((item) => {
    if (!item) return false
    
    const isAdult = item.isNSFW === true || item.type === 'nsfw' || ['xvideos', 'pornhub', 'spankbang'].includes(String(item.source || '').toLowerCase()) || ['xvideos', 'pornhub', 'spankbang'].includes(String(item.provider || '').toLowerCase())

    // Strict close match verification for direct and movie search results against the query
    if (query && String(query).trim() && !isAdult) {
      const isDirectOrMovie = item.isDirect || item.type === 'direct' || item.type === 'movie' || item.type === 'anime' || ['nkiri', 'netnaija', 'fzmovies', '9jarocks', 'animedrive', 'o2tv', 'downloadwella', 'naijaprey', 'fztvseries', 'archiveorg', 'meetdownload', 'waploaded', 'maxcinema', 'omdb'].includes(item.source)
      if (isDirectOrMovie) {
        // Allow season-specific results through (e.g. "silo season 2" when querying "silo")
        const baseQuery = query.replace(/\s+season\s*\d+$/i, '').trim()
        const itemBase = (item.title || '').replace(/\s*[-–]\s*season\s*\d+.*$/i, '').replace(/\s*s\d+\s*e\d+.*$/i, '').trim()
        if (!isTitleMatch(item.title, query) && !isTitleMatch(itemBase, baseQuery) && !isTitleMatch(item.title, baseQuery)) {
          return false
        }
      }
    }

    // Ensure thumbnail property is synced and suitable
    let thumb = item.thumbnail || item.image || item.poster || null
    if (!isAdult && !isSuitableThumbnail(thumb)) {
      thumb = null
    }
    item.thumbnail = thumb
    item.image = thumb
    
    const urlKey = String(item.url || item.link || item.id || '').trim().toLowerCase()
    if (!urlKey || seenUrls.has(urlKey)) return false
    seenUrls.add(urlKey)

    // Deduplicate by normalized title if longer than 3 characters
    const titleKey = cleanTitleForMatching(item.title || '')
    if (titleKey && titleKey.length > 3 && seenTitles.has(titleKey)) {
      return false
    }
    if (titleKey) seenTitles.add(titleKey)

    return true
  })
}

// ==================== LAYER HANDLERS ====================

async function searchYouTube(query, limit = 20) {
  if (!YOUTUBE_API_KEY) {
    throw new Error('YouTube API key not configured. Add YOUTUBE_API_KEY to environment variables.')
  }

  // Do NOT set videoEmbeddable:'true' on the search call.
  // That filter is overly aggressive and often returns 0 items for normal
  // queries (especially with restricted keys / certain regions).
  // We enrich with videos.list afterwards and sort embeddable first instead.
  const maxResults = Math.min(50, Math.max(1, Number(limit) || 20))
  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(maxResults),
    key: YOUTUBE_API_KEY,
    safeSearch: 'none',
  })

  // Prefer the request Host / Origin when available so restricted API keys
  // that are locked to the Vercel domain still work.
  const referer = process.env.YOUTUBE_API_REFERER
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}/`
        : 'https://chan-yz3p.vercel.app/')

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {
    headers: {
      Referer: referer,
      'User-Agent': 'Mozilla/5.0 (compatible; ChanServer/1.0)',
    },
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    const msg = error.error?.message || `YouTube API error: ${res.status}`
    // Surface quota / key problems clearly so the UI doesn't just say "no results"
    throw new Error(msg)
  }

  const data = await res.json()
  const ids = (data.items || []).map((it) => it.id?.videoId).filter(Boolean)

  if (!ids.length) {
    // Empty search is unusual for real queries — log for diagnostics
    console.warn('YouTube search returned 0 items for query:', query, 'pageInfo:', data.pageInfo)
    return []
  }

  let statusById = {}
  try {
    const detailsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=status,snippet,contentDetails,statistics&id=${ids.join(',')}&key=${YOUTUBE_API_KEY}`,
      {
        headers: {
          Referer: referer,
          'User-Agent': 'Mozilla/5.0 (compatible; ChanServer/1.0)',
        },
      }
    )
    if (detailsRes.ok) {
      const detailsData = await detailsRes.json()
      for (const it of detailsData.items || []) {
        statusById[it.id] = it
      }
    }
  } catch (err) {
    console.error('YouTube videos.list enrichment failed:', err.message)
  }

  return ids.map((id) => {
    const searchItem = (data.items || []).find((it) => it.id?.videoId === id)
    const full = statusById[id]
    const sn = full?.snippet || searchItem?.snippet || {}
    const duration = full?.contentDetails?.duration
    const thumb = sn.thumbnails?.high?.url || sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || null

    return {
      id,
      title: sn.title || 'Untitled',
      description: sn.description || '',
      thumbnail: thumb,
      image: thumb,
      channel: sn.channelTitle,
      publishedAt: sn.publishedAt,
      url: `https://youtube.com/watch?v=${id}`,
      duration: formatDuration(duration),
      durationSeconds: parseDuration(duration),
      views: full?.statistics?.viewCount,
      source: 'youtube',
      type: 'youtube',
      // Prefer true embeddable; if status missing, assume playable (nocookie embed often works)
      embeddable: full?.status ? full.status.embeddable !== false : true,
      isDirect: false,
    }
  }).sort((a, b) => Number(b.embeddable) - Number(a.embeddable))
}

async function searchOMDb(query) {
  if (!OMDB_API_KEY || !query) {
    return []
  }
  
  try {
    const url = `https://www.omdbapi.com/?apikey=${OMDB_API_KEY}&s=${encodeURIComponent(query)}`
    const res = await fetch(url)
    if (!res.ok) return []
    
    const data = await res.json()
    if (data.Response === 'False' || !Array.isArray(data.Search)) {
      return []
    }
    
    return data.Search.filter((it) => isTitleMatch(it.Title, query)).map((it) => {
      const thumb = it.Poster !== 'N/A' && isSuitableThumbnail(it.Poster) ? it.Poster : null
      return {
        id: it.imdbID,
        title: it.Title,
        description: `${it.Type} • ${it.Year}`,
        thumbnail: thumb,
        image: thumb,
        url: `https://www.imdb.com/title/${it.imdbID}`,
        year: it.Year,
        source: 'omdb',
        type: 'movie',
        isDirect: false,
      }
    })
  } catch (err) {
    console.error('OMDb search error:', err.message)
    return []
  }
}

async function fetchBestOMDbPoster(searchKeyword, originalQuery = null) {
  if (!OMDB_API_KEY || !searchKeyword) return null
  try {
    const url = `https://www.omdbapi.com/?apikey=${OMDB_API_KEY}&s=${encodeURIComponent(searchKeyword)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    if (data.Response === 'False' || !Array.isArray(data.Search)) return null

    for (const it of data.Search) {
      if (!it.Poster || it.Poster === 'N/A' || !isSuitableThumbnail(it.Poster)) continue
      if (isTitleMatch(it.Title, searchKeyword) || (originalQuery && isTitleMatch(it.Title, originalQuery))) {
        return it.Poster
      }
    }
  } catch (err) {
    console.error('OMDb poster fetch error:', err.message)
  }
  return null
}

async function enrichWithOMDbPosters(items, query = null) {
  if (!Array.isArray(items) || items.length === 0) return items
  if (!OMDB_API_KEY) return items

  // If query was searched, fetch the exact OMDb poster for this query once
  let queryPoster = null
  if (query && String(query).trim()) {
    queryPoster = await fetchBestOMDbPoster(String(query).trim())
  }

  const posterCache = new Map()
  if (queryPoster && query) {
    posterCache.set(cleanTitleForMatching(query), queryPoster)
  }

  // Parallelise OMDb lookups with a concurrency cap to avoid rate-limiting
  const CONCURRENCY = 4
  const updated = await mapConcurrent(items, CONCURRENCY, async (item) => {
    if (!item) return item

    // Never enrich NSFW items with OMDb
    const isAdult = item.isNSFW === true || item.type === 'nsfw' || ['xvideos', 'pornhub', 'spankbang'].includes(String(item.source || '').toLowerCase()) || ['xvideos', 'pornhub', 'spankbang'].includes(String(item.provider || '').toLowerCase())
    if (isAdult) return item

    // YouTube thumbnails are already high quality — skip OMDb
    if (item.source === 'youtube' || item.type === 'youtube') return item

    // IPTV channel logos are domain-specific — skip OMDb
    if (item.source === 'iptv' || item.type === 'iptv') return item

    // Sports emblems are match-specific — skip OMDb
    if (item.source === 'sports' || item.type === 'sports') return item

    const cleanItemName = cleanTitleForOMDb(item.title)
    const cleanQueryName = cleanTitleForOMDb(query || '')

    // 1. If we have the exact OMDb poster for the searched query AND this item matches, use queryPoster
    if (queryPoster && query && cleanItemName && cleanQueryName && cleanItemName.toLowerCase() === cleanQueryName.toLowerCase()) {
      return {
        ...item,
        thumbnail: queryPoster,
        image: queryPoster,
        posterSource: 'omdb',
      }
    }

    // 2. Check if current thumbnail is already good (not from a scraped host)
    let thumb = item.thumbnail || item.image || null
    const isScrapedHost = typeof thumb === 'string' && /thenkiri|thenetnaija|mynetnaija|fzmovies|9jarocks|o2tv|naijaprey|np-downloader|wildshare|downloadwella|fztvseries|wideshares|archive\.org|meetdownload|waploaded|kissorgrab|maxcinema|koyeb/i.test(thumb)
    const hasGoodThumbnail = isSuitableThumbnail(thumb) && !isScrapedHost

    if (hasGoodThumbnail) return item

    // 3. No good thumbnail — look up OMDb poster for this item's clean name
    if (!cleanItemName || cleanItemName.length < 2) {
      // Can't look up OMDb without a name — clear the bad thumbnail
      return { ...item, thumbnail: null, image: null }
    }

    if (!posterCache.has(cleanItemName)) {
      const fetched = await fetchBestOMDbPoster(cleanItemName, query)
      posterCache.set(cleanItemName, fetched || null)
    }

    const matchedPoster = posterCache.get(cleanItemName) || null
    return {
      ...item,
      thumbnail: matchedPoster,
      image: matchedPoster,
      posterSource: matchedPoster ? 'omdb' : item.posterSource,
    }
  })

  return updated
}

// Vercel Hobby tier has a 10s function timeout. We race the search against
// an 8s deadline so we always return partial results instead of 504.
const DIRECT_SEARCH_TIMEOUT_MS = 8000

async function searchDirectLinks(query, options = {}) {
  const results = []
  const requestedSite = options.site && options.site !== 'custom' && options.site !== 'all' ? options.site : null
  const scrapers = requestedSite
    ? [requestedSite]
    : ['nkiri', 'netnaija', 'fzmovies', '9jarocks', 'o2tv', 'naijaprey', 'fztvseries', 'archiveorg', 'meetdownload', 'waploaded', 'maxcinema']
  
  const searchedSites = [...scrapers]
  
  // Expand query with season variants for broader TV show discovery
  const queries = expandQueryWithSeasons(query)
  
  // Race all scrapers against a deadline. Each scraper has its own catch,
  // so Promise.all will resolve once every scraper settles (success or fail).
  // We then race the whole thing against a global timeout so slow scrapers
  // don't cause a Vercel 504 — partial results are better than no results.
  const scrapeDeadline = new Promise((resolve) =>
    setTimeout(() => resolve('timeout'), DIRECT_SEARCH_TIMEOUT_MS)
  )
  
  const scrapeWork = Promise.all(scrapers.map(async (siteKey) => {
    try {
      // ─── NaijaPrey: dedicated search with season expansion ───
      if (siteKey === 'naijaprey') {
        try {
          // Search all season variants in parallel
          const allNpResults = await Promise.all(
            queries.map((q) => searchNaijaprey(q, 10).catch(() => []))
          )
          const npResults = allNpResults.flat()
          if (npResults.length > 0) {
            // Filter against the base query (allow season-specific results)
            const baseQuery = query.replace(/\s+season\s*\d+$/i, '').trim()
            const filtered = npResults.filter((item) => {
              if (!item?.title) return false
              if (isTitleMatch(item.title, query)) return true
              if (isTitleMatch(item.title, baseQuery)) return true
              // Allow if the item title contains the base query as a phrase
              const itemBase = item.title.replace(/\s*[-–]\s*season\s*\d+.*$/i, '').replace(/\s*s\d+\s*e\d+.*$/i, '').trim()
              return isTitleMatch(itemBase, baseQuery)
            })
            const enriched = filtered.length > 0 ? filtered : npResults
            for (const result of enriched) {
              const thumb = result.thumbnail || result.image || null
              results.push({
                ...result,
                thumbnail: thumb,
                image: thumb,
                source: 'naijaprey',
                type: 'direct',
                isDirect: result.isDirect === true,
                playableInRoom: result.isDirect === true,
                quality: extractQuality(result.title),
              })
            }
          }
        } catch (err) {
          console.error('naijaprey search failed:', err.message)
        }
        return
      }

      // ─── NetNaija: dedicated search with full chain resolution ───
      if (siteKey === 'netnaija') {
        try {
          // Search all season variants in parallel
          const allNnResults = await Promise.all(
            queries.map((q) => searchNetNaija(q, 10).catch(() => []))
          )
          const nnResults = allNnResults.flat()
          if (nnResults.length > 0) {
            // Filter against the base query (allow season-specific results)
            const baseQuery = query.replace(/\s+season\s*\d+$/i, '').trim()
            const filtered = nnResults.filter((item) => {
              if (!item?.title) return false
              if (isTitleMatch(item.title, query)) return true
              if (isTitleMatch(item.title, baseQuery)) return true
              const itemBase = item.title.replace(/\s*[-–]\s*season\s*\d+.*$/i, '').replace(/\s*s\d+\s*e\d+.*$/i, '').trim()
              return isTitleMatch(itemBase, baseQuery)
            })
            const enriched = filtered.length > 0 ? filtered : nnResults
            for (const result of enriched) {
              const thumb = result.thumbnail || result.image || null
              results.push({
                ...result,
                thumbnail: thumb,
                image: thumb,
                source: 'netnaija',
                type: 'direct',
                isDirect: result.isDirect === true,
                playableInRoom: result.playableInRoom === true,
                quality: extractQuality(result.title),
              })
            }
          }
        } catch (err) {
          console.error('netnaija search failed:', err.message)
        }
        return
      }

      // ─── MaxCinema: search + full chain resolution ───
      if (siteKey === 'maxcinema') {
        try {
          const allMcResults = await Promise.all(
            queries.map((q) => searchMaxCinema(q, 10).catch(() => []))
          )
          const mcResults = allMcResults.flat()
          if (mcResults.length > 0) {
            const baseQuery = query.replace(/\s+season\s*\d+$/i, '').trim()
            const filtered = mcResults.filter((item) => {
              if (!item?.title) return false
              if (isTitleMatch(item.title, query)) return true
              if (isTitleMatch(item.title, baseQuery)) return true
              const itemBase = item.title.replace(/\s*[-–]\s*season\s*\d+.*$/i, '').replace(/\s*s\d+\s*e\d+.*$/i, '').trim()
              return isTitleMatch(itemBase, baseQuery)
            })
            const enriched = filtered.length > 0 ? filtered : mcResults
            for (const result of enriched) {
              const thumb = result.thumbnail || result.image || null
              results.push({
                ...result,
                thumbnail: thumb,
                image: thumb,
                source: 'maxcinema',
                type: 'direct',
                isDirect: result.isDirect === true,
                playableInRoom: result.playableInRoom === true,
                quality: extractQuality(result.title),
              })
            }
          }
        } catch (err) {
          console.error('maxcinema search failed:', err.message)
        }
        return
      }

      // ─── Internet Archive: JSON API search ───
      if (siteKey === 'archiveorg') {
        try {
          const archiveResults = await searchArchiveOrg(query)
          for (const result of archiveResults) {
            results.push(result)
          }
        } catch (err) {
          console.error('archive.org search failed:', err.message)
        }
        return
      }

      // ─── MeetDownload: Puppeteer-based resolution (JS countdown + tokens) ───
      if (siteKey === 'meetdownload') {
        try {
          const config = getSiteConfig('meetdownload')
          const searchUrl = config?.buildSearchUrl?.(query)
          if (searchUrl) {
            const html = await fetchHtml(searchUrl).catch(() => null)
            if (html) {
              const $ = cheerio.load(html)
              const links = []
              $('a[href]').each((_, el) => {
                const href = $(el).attr('href') || ''
                const text = $(el).text().trim()
                if (href.includes('meetdownload.com/') && text && !href.includes('?s=')) {
                  links.push({ url: href, title: text })
                }
              })

              const baseQuery = query.replace(/\s+season\s*\d+$/i, '').trim()
              const filtered = links.filter((item) =>
                isTitleMatch(item.title, query) || isTitleMatch(item.title, baseQuery)
              )
              const toResolve = (filtered.length > 0 ? filtered : links).slice(0, 5)

              // Resolve each link — try regex extraction first (no Puppeteer),
              // fall back to Puppeteer if available
              for (const link of toResolve) {
                try {
                  const resolved = await resolveMeetDownloadPage(link.url)
                  for (const r of resolved) {
                    results.push({
                      ...r,
                      source: 'meetdownload',
                      title: r.title || link.title,
                      quality: extractQuality(r.title || link.title),
                    })
                  }
                } catch (err) {
                  console.error('MeetDownload resolution error:', err.message)
                }
              }
            }
          }
        } catch (err) {
          console.error('meetdownload search failed:', err.message)
        }
        return
      }

      // ─── Waploaded: cheerio-first search (try without Puppeteer) ───
      if (siteKey === 'waploaded') {
        try {
          const config = getSiteConfig('waploaded')
          const searchUrls = config?.buildSearchUrls ? config.buildSearchUrls(query) : [config?.buildSearchUrl?.(query)].filter(Boolean)

          for (const searchUrl of searchUrls) {
            if (!searchUrl) continue
            try {
              // Try fetching directly first — many "JS-rendered" sites
              // actually serve server-rendered HTML that cheerio can parse
              const html = await fetchHtml(searchUrl).catch(() => null)
              if (html) {
                const $ = cheerio.load(html)
                $('a[href]').each((_, el) => {
                  const href = $(el).attr('href') || ''
                  const text = $(el).text().trim()
                  const isMedia = /\/movie\/|\/series\/|\/video\/|\.mp4|\.mkv/i.test(href)
                  if (isMedia && text && text.length > 3 && text.length < 200) {
                    const baseQuery = query.replace(/\s+season\s*\d+$/i, '').trim()
                    if (isTitleMatch(text, query) || isTitleMatch(text, baseQuery)) {
                      results.push({
                        title: text,
                        url: href,
                        link: href,
                        source: 'waploaded',
                        type: 'direct',
                        isDirect: /\.(mp4|mkv|m3u8)/i.test(href),
                        playableInRoom: /\.(mp4|webm|m3u8)/i.test(href),
                        quality: extractQuality(text),
                      })
                    }
                  }
                })
              }

              // If cheerio didn't find results and Puppeteer is available, try browser
              if (results.length === 0 && isBrowserAvailable()) {
                const browserHtml = await getRenderedHtml(searchUrl, { timeout: 8000, waitForSelector: 'a[href*="/movie/"], a[href*="/series/"]' })
                if (browserHtml) {
                  const $b = cheerio.load(browserHtml)
                  $b('a[href]').each((_, el) => {
                    const href = $b(el).attr('href') || ''
                    const text = $b(el).text().trim()
                    const isMedia = /\/movie\/|\/series\/|\/video\/|\.mp4|\.mkv/i.test(href)
                    if (isMedia && text && text.length > 3 && text.length < 200) {
                      const baseQuery = query.replace(/\s+season\s*\d+$/i, '').trim()
                      if (isTitleMatch(text, query) || isTitleMatch(text, baseQuery)) {
                        // Avoid duplicates
                        if (!results.some(r => r.url === href)) {
                          results.push({
                            title: text,
                            url: href,
                            link: href,
                            source: 'waploaded',
                            type: 'direct',
                            isDirect: /\.(mp4|mkv|m3u8)/i.test(href),
                            playableInRoom: /\.(mp4|webm|m3u8)/i.test(href),
                            quality: extractQuality(text),
                          })
                        }
                      }
                    }
                  })
                }
              }
            } catch (err) {
              console.error('Waploaded search error:', err.message)
            }
            if (results.length > 0) break
          }
        } catch (err) {
          console.error('waploaded search failed:', err.message)
        }
        return
      }

      // ─── FZTVSeries: HTML scraping search (links go to downloadwella/wideshares) ───
      if (siteKey === 'fztvseries') {
        try {
          const config = getSiteConfig('fztvseries')
          let siteCandidates = []
          const seenUrls = new Set()

          const allVariantResults = await Promise.all(
            queries.map(async (q) => {
              const queryUrls = config?.buildSearchUrls ? config.buildSearchUrls(q) : (config?.buildSearchUrl ? [config.buildSearchUrl(q)] : [])
              for (const searchUrl of queryUrls) {
                if (!searchUrl) continue
                try {
                  const html = await fetchHtml(searchUrl)
                  const items = parseListing(html, searchUrl, config)
                  if (items && items.length > 0) return items
                } catch { /* try next */ }
              }
              return []
            })
          )

          for (const variantItems of allVariantResults) {
            for (const item of variantItems) {
              if (item?.url && !seenUrls.has(item.url)) {
                seenUrls.add(item.url)
                siteCandidates.push(item)
              }
            }
          }

          // Filter against query
          if (query && String(query).trim()) {
            const baseQuery = query.replace(/\s+season\s*\d+$/i, '').trim()
            siteCandidates = siteCandidates.filter((item) => {
              if (isTitleMatch(item?.title, query)) return true
              if (isTitleMatch(item?.title, baseQuery)) return true
              const itemBase = (item?.title || '').replace(/\s*[-–]\s*season\s*\d+.*$/i, '').replace(/\s*s\d+\s*e\d+.*$/i, '').trim()
              return isTitleMatch(itemBase, baseQuery)
            })
          }

          for (const result of siteCandidates) {
            const thumb = result.thumbnail || result.image || null
            // FZTVSeries links go to its own pages which link to downloadwella/wideshares
            // These need resolution, but some links are already to downloadwella
            const isDirectLink = /downloadwella\.com|wideshares\.org|\.mp4|\.mkv/i.test(result.url || '')
            results.push({
              ...result,
              thumbnail: thumb,
              image: thumb,
              source: 'fztvseries',
              type: 'direct',
              isDirect: isDirectLink,
              playableInRoom: isDirectLink,
              quality: extractQuality(result.title),
            })
          }
        } catch (err) {
          console.error('fztvseries search failed:', err.message)
        }
        return
      }

      // ─── Other providers: search with season expansion ───
      const config = getSiteConfig(siteKey)

      // Search all query variants in parallel, collect candidates
      let siteCandidates = []
      const seenUrls = new Set()

      const allVariantResults = await Promise.all(
        queries.map(async (q) => {
          const queryUrls = config?.buildSearchUrls ? config.buildSearchUrls(q) : (config?.buildSearchUrl ? [config.buildSearchUrl(q)] : [])
          for (const searchUrl of queryUrls) {
            if (!searchUrl) continue
            try {
              const html = await fetchHtml(searchUrl)
              const items = parseListing(html, searchUrl, config)
              if (items && items.length > 0) return items
            } catch {
              /* try next URL pattern */
            }
          }
          return []
        })
      )

      for (const variantItems of allVariantResults) {
        for (const item of variantItems) {
          if (item?.url && !seenUrls.has(item.url)) {
            seenUrls.add(item.url)
            siteCandidates.push(item)
          }
        }
      }

      // Filter candidates against the base query (allow season-specific results)
      if (query && String(query).trim()) {
        const baseQuery = query.replace(/\s+season\s*\d+$/i, '').trim()
        siteCandidates = siteCandidates.filter((item) => {
          if (isTitleMatch(item?.title, query)) return true
          if (isTitleMatch(item?.title, baseQuery)) return true
          const itemBase = (item?.title || '').replace(/\s*[-–]\s*season\s*\d+.*$/i, '').replace(/\s*s\d+\s*e\d+.*$/i, '').trim()
          return isTitleMatch(itemBase, baseQuery)
        })
      }

      // O2TV: use the resolver engine to discover actual CDN URLs
      if (siteCandidates.length === 0 && query && query.trim().length > 1) {
        const cleanQ = query.trim()
        if (siteKey === 'o2tv') {
          try {
            const o2tvResults = await resolveO2TvShow(cleanQ, 4, 8)
            for (const result of o2tvResults) {
              siteCandidates.push({
                title: result.title,
                url: result.url,
                link: result.link || result.url,
                source: 'o2tv',
                isDirect: true,
                playableInRoom: !result.probeFailed,
                quality: result.quality || 'HD',
                probeFailed: result.probeFailed || false,
              })
            }
          } catch (err) {
            console.error('O2TV resolver engine failed:', err.message)
          }
        } else {
          // Fallback: add season 1 & 2 links to the provider's search page
          const baseUrl = config.buildSearchUrl?.(cleanQ) || config.baseUrl
          siteCandidates.push(
            {
              title: `${cleanQ} (${config.label}) - Season 1 Complete / HD`,
              url: baseUrl,
              link: baseUrl,
              source: siteKey,
              isDirect: false,
              meta: `Provider: ${config.label} • Season 1`,
            },
            {
              title: `${cleanQ} (${config.label}) - Season 2 Complete / HD`,
              url: baseUrl,
              link: baseUrl,
              source: siteKey,
              isDirect: false,
              meta: `Provider: ${config.label} • Season 2`,
            }
          )
        }
      }

      if (siteCandidates.length === 0) return

      const toResolve = options.resolve ? siteCandidates.slice(0, 10) : siteCandidates
      const remainder = options.resolve ? siteCandidates.slice(10, 60) : []

      const enriched = await Promise.all(toResolve.map(async (result) => {
        if (options.resolve && !result.isDirect) {
          const resolved = await resolvePageChain(result.url, siteKey)
          if (resolved.length) {
            return resolved.map((item) => {
              const thumb = item.thumbnail || item.image || result.thumbnail || result.image || null
              return {
                ...item,
                title: item.title || result.title,
                thumbnail: thumb,
                image: thumb,
                source: item.source || siteKey,
                type: 'direct',
                quality: extractQuality(item.title || result.title),
              }
            })
          }
        }

        const thumb = result.thumbnail || result.image || null
        return [{
          ...result,
          thumbnail: thumb,
          image: thumb,
          source: siteKey,
          type: 'direct',
          isDirect: result.isDirect === true,
          playableInRoom: result.isDirect === true,
          quality: extractQuality(result.title),
        }]
      }))
      
      const remainderEnriched = remainder.map((result) => {
        const thumb = result.thumbnail || result.image || null
        return {
          ...result,
          thumbnail: thumb,
          image: thumb,
          source: siteKey,
          type: 'direct',
          isDirect: result.isDirect === true,
          playableInRoom: result.isDirect === true,
          quality: extractQuality(result.title),
        }
      })

      results.push(...enriched.flat(), ...remainderEnriched)
    } catch (err) {
      console.error(`${siteKey} search failed:`, err.message)
    }
  }))

  // Race: if scraping takes too long, return whatever results we have so far
  const raceResult = await Promise.race([scrapeWork, scrapeDeadline])
  if (raceResult === 'timeout') {
    console.log(`Direct links search hit ${DIRECT_SEARCH_TIMEOUT_MS}ms deadline with ${results.length} results so far`)
  }
  
  const omdbEnriched = await enrichWithOMDbPosters(results, query)
  const deduplicated = deduplicateAndEnrich(omdbEnriched, query)

  const byProvider = new Map()
  for (const item of deduplicated) {
    const src = item.source || 'other'
    if (!byProvider.has(src)) byProvider.set(src, [])
    byProvider.get(src).push(item)
  }

  const interleaved = []
  const providerLists = [...byProvider.values()]
  let added = true
  while (added) {
    added = false
    for (const list of providerLists) {
      if (list.length > 0) {
        interleaved.push(list.shift())
        added = true
      }
    }
  }

  const validResults = (interleaved.length ? interleaved : deduplicated).filter(
    (item) => item && (item.url || item.link) && item.title
  )
  const offset = Math.max(0, Number(options.offset) || 0)
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 60))
  return {
    results: validResults.slice(offset, offset + limit),
    hasMore: offset + limit < validResults.length,
    searchedSites,
    multiLayerCascaded: searchedSites.length > 1,
  }
}

async function searchArchiveOrg(query, limit = 20) {
  try {
    const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent('"' + query + '"')}+mediatype:movies&output=json&rows=${limit}&fl[]=identifier,title,mediatype,downloads,year,description,num_reviews`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(searchUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    clearTimeout(timer)
    if (!res.ok) return []
    const data = await res.json()
    const docs = data?.response?.docs || []

    // For each search result, try to resolve the actual MP4 file path via metadata API
    // This is much more reliable than guessing /{identifier}/{identifier}.mp4
    const resolved = await mapConcurrent(docs, 3, async (item) => {
      const directUrl = await resolveArchiveOrgDirectUrl(item.identifier)
      if (directUrl) {
        return {
          title: item.title || item.identifier,
          thumbnail: `https://archive.org/services/img/${item.identifier}`,
          image: `https://archive.org/services/img/${item.identifier}`,
          url: directUrl,
          link: directUrl,
          description: item.description ? String(item.description).slice(0, 200) : null,
          meta: item.year ? `Year: ${item.year} | Downloads: ${item.downloads || 0}` : `Downloads: ${item.downloads || 0}`,
          source: 'archiveorg',
          type: 'direct',
          isDirect: true,
          playableInRoom: true,
          quality: 'HD',
        }
      }
      // Fallback: use naive URL pattern (may 404 for multi-file items)
      const mp4Url = `https://archive.org/download/${item.identifier}/${item.identifier}.mp4`
      return {
        title: item.title || item.identifier,
        thumbnail: `https://archive.org/services/img/${item.identifier}`,
        image: `https://archive.org/services/img/${item.identifier}`,
        url: mp4Url,
        link: mp4Url,
        description: item.description ? String(item.description).slice(0, 200) : null,
        meta: item.year ? `Year: ${item.year} | Downloads: ${item.downloads || 0}` : `Downloads: ${item.downloads || 0}`,
        source: 'archiveorg',
        type: 'direct',
        isDirect: true,
        playableInRoom: true,
        quality: 'SD',
      }
    })

    return resolved
  } catch (err) {
    console.error('Archive.org search error:', err.message)
    return []
  }
}

async function searchIPTV(query, userChannels = [], provider = '', limit = 100) {
  const channels = await getIptvChannels(userChannels, provider)
  const term = String(query || '').trim().toLowerCase()

  return channels
    .filter((channel) => {
      if (!term) return true
      const searchable = `${channel.name} ${channel.group} ${channel.country}`.toLowerCase()
      return searchable.includes(term)
    })
    .slice(0, Math.max(1, Number(limit) || 100))
    .map((channel) => ({
      id: `iptv-${channel.name.replace(/\s+/g, '-').toLowerCase()}`,
      title: channel.name,
      description: channel.group,
      thumbnail: channel.logo || null,
      image: channel.logo || null,
      url: channel.url,
      channel: channel.name,
      group: channel.group,
      country: channel.country,
      provider: channel.provider,
      source: 'iptv',
      type: 'iptv',
      isDirect: true,
      isLive: true,
      program: { now: 'Live Broadcast', next: null },
    }))
}

function normalizeMatchText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function readSportsChannelRules() {
  const raw = process.env.SPORTS_CHANNEL_MAP_JSON
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    console.error('SPORTS_CHANNEL_MAP_JSON is not valid JSON')
    return []
  }
}

function matchSportsChannels(match, channels) {
  const competition = match.competition.name
  const teams = `${match.homeTeam.name} ${match.awayTeam.name}`
  const rules = readSportsChannelRules().filter((rule) => {
    const competitionMatches = !rule.competition || normalizeMatchText(competition).includes(normalizeMatchText(rule.competition))
    const teamNeedle = rule.team || rule.teams
    const teamMatches = !teamNeedle || normalizeMatchText(teams).includes(normalizeMatchText(teamNeedle))
    return competitionMatches && teamMatches
  })

  const requestedNames = rules.flatMap((rule) => {
    const values = rule.channels || rule.channelNames || rule.channel || []
    return Array.isArray(values) ? values : [values]
  }).filter(Boolean).map(normalizeMatchText)

  if (!requestedNames.length) return []
  return channels.filter((channel) => {
    const channelText = normalizeMatchText(`${channel.name} ${channel.group}`)
    return requestedNames.some((name) => channelText.includes(name) || name.includes(channelText))
  })
}

async function searchSports(query) {
  if (!FOOTBALL_DATA_KEY) {
    throw Object.assign(new Error('Sports search is not configured. Add FOOTBALL_DATA_KEY.'), { status: 503 })
  }
  
  try {
    const res = await fetch(
      'https://api.football-data.org/v4/matches?status=SCHEDULED,LIVE',
      { headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY } }
    )
    
    if (!res.ok) throw Object.assign(new Error(`Sports API error: ${res.status}`), { status: 502 })
    
    const data = await res.json()
    const channels = await getIptvChannels().catch((err) => {
      console.error('Could not load IPTV channels for sports mapping:', err.message)
      return []
    })
    const term = query.toLowerCase()

    return (data.matches || [])
      .filter((match) => {
        const home = match.homeTeam?.name?.toLowerCase() || ''
        const away = match.awayTeam?.name?.toLowerCase() || ''
        const competition = match.competition?.name?.toLowerCase() || ''
        return home.includes(term) || away.includes(term) || competition.includes(term)
      })
      .map((match) => {
        const channelCandidates = matchSportsChannels(match, channels)
        const channel = channelCandidates[0] || null
        const time = formatMatchTime(match.utcDate)
        const thumb = match.competition.emblem || null
        return {
          id: `match-${match.id}`,
          title: `${match.homeTeam.name} vs ${match.awayTeam.name}`,
          description: `${match.competition.name} - ${time}`,
          thumbnail: thumb,
          image: thumb,
          url: channel?.url || null,
          matchInfo: {
            teams: `${match.homeTeam.name} vs ${match.awayTeam.name}`,
            time,
            competition: match.competition.name,
            status: match.status,
            homeTeam: match.homeTeam.name,
            awayTeam: match.awayTeam.name,
          },
          channel: channel?.name || null,
          channelCandidates: channelCandidates.map((candidate) => candidate.name),
          source: 'sports',
          type: 'sports',
          isDirect: Boolean(channel),
          isLive: match.status === 'IN_PLAY' || match.status === 'LIVE',
          isUpcoming: match.status === 'SCHEDULED',
          channelAvailable: Boolean(channel),
        }
      })
  } catch (err) {
    console.error('Sports API error:', err)
    throw Object.assign(new Error(err.message || 'Sports search failed'), { status: err.status || 502 })
  }
}

async function searchNSFW(query, options = {}, user = null) {
  if (process.env.NSFW_ENABLED !== 'true') {
    throw Object.assign(new Error('NSFW search is not enabled'), { status: 403 })
  }
  // Require both client assertion and authenticated user (server-verified)
  if (!user) {
    throw Object.assign(new Error('You must be signed in to access adult content'), { status: 401 })
  }
  // Client-side adultVerified is kept for UX, but server-side we enforce auth
  if (!options.adultVerified) {
    throw Object.assign(new Error('Age verification required. You must be 18+ to search this content.'), { status: 403 })
  }

  const provider = options.provider || 'all'  // default to all providers (3-chain interleaving)
  const maxLimit = Math.min(100, Math.max(1, Number(options.limit) || 25))
  const offset = Math.max(0, Number(options.offset) || 0)
  const allResults = await searchNsfwProvider(provider, query, maxLimit + offset)

  // Apply offset-based pagination
  const paginated = allResults.slice(offset, offset + maxLimit)
  const nextHasMore = offset + maxLimit < allResults.length

  return { results: paginated, hasMore: nextHasMore }
}

// ==================== SCRAPER HELPERS ====================

function validateFetchTarget(rawUrl) {
  return validateFetchUrl(rawUrl)
}

async function fetchHtml(targetUrl) {
  const controller = new AbortController()
  // 5s timeout to stay within Vercel Hobby 10s function limit
  const timeout = setTimeout(() => controller.abort(), 5000)
  let currentUrl = validateFetchTarget(targetUrl)

  try {
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const res = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Referer': currentUrl.origin,
        },
      })

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location || redirect === 3) throw new Error('Too many or invalid redirects')
        currentUrl = validateFetchTarget(new URL(location, currentUrl).href)
        continue
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    }
    throw new Error('Too many redirects')
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Remote site timed out')
    throw e
  } finally {
    clearTimeout(timeout)
  }
}

function extractDirectMedia(html, baseUrl, source) {
  const $ = cheerio.load(html)
  const results = []
  const seen = new Set()
  const pageTitle = $('meta[property="og:title"]').attr('content') || $('title').text().trim() || 'Video'
  const pageImg = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || $('.post-thumbnail img, .poster img, article img').first().attr('src') || null
  const resolvedPageImg = resolveUrl(pageImg, baseUrl)

  const add = (rawUrl, title, meta = 'direct file') => {
    const link = resolveUrl(rawUrl, baseUrl)
    if (!link || !MEDIA_EXT_RE.test(link) || seen.has(link)) return
    try {
      const parsed = new URL(link)
      if (parsed.hostname.includes('xvideos-cdn.com') && /preview/i.test(parsed.pathname)) return
    } catch {
      return
    }
    seen.add(link)
    results.push({
      title: title || `${pageTitle} (direct video)`,
      thumbnail: resolvedPageImg,
      image: resolvedPageImg,
      link,
      url: link,
      meta,
      source,
      isDirect: true,
      playableInRoom: true,
    })
  }

  $('video[src], video source[src], source[src], a[href]').each((_, el) => {
    const raw = $(el).attr('src') || $(el).attr('href')
    add(raw, $(el).text().trim() || pageTitle)
  })

  const rawUrls = html.match(/https?:[^\s"'<>]+\.(?:mp4|m3u8|webm|ogg|mov|mkv|avi|flv|ts)(?:\?[^\s"'<>]*)?(?=[\s"'<>]|$)/gi) || []
  rawUrls.forEach((raw) => add(raw.replace(/&amp;/g, '&'), pageTitle, 'direct URL found on page'))
  return results
}

function providerActionResult(url) {
  const parsed = new URL(url)
  const fileName = decodeURIComponent(parsed.pathname.split('/').pop() || 'Download page')
  return {
    title: fileName.replace(/\.html?$/i, ''),
    url,
    link: url,
    source: 'downloadwella',
    isDirect: false,
    requiresUserAction: true,
    meta: 'Provider download action required. Open the page to continue.',
  }
}

function siteConfigForUrl(url, fallbackSite) {
  const hostname = new URL(url).hostname.toLowerCase()
  if (hostname === 'thenkiri.com' || hostname.endsWith('.thenkiri.com') || hostname === 'nkiri.com' || hostname.endsWith('.nkiri.com')) return getSiteConfig('nkiri')
  if (hostname === 'thenetnaija.ng' || hostname.endsWith('.thenetnaija.ng') || hostname === 'mynetnaija.ng' || hostname.endsWith('.mynetnaija.ng')) return getSiteConfig('netnaija')
  if (hostname.includes('9jarocks')) return getSiteConfig('9jarocks')
  if (hostname.includes('animedrive')) return getSiteConfig('animedrive')
  if (hostname.includes('naijaprey')) return getSiteConfig('naijaprey')
  if (hostname.includes('np-downloader')) return getSiteConfig('naijaprey')
  if (hostname.includes('fztvseries')) return getSiteConfig('fztvseries')
  if (hostname.includes('wideshares')) return getSiteConfig('fztvseries')
  if (hostname.includes('archive.org')) return getSiteConfig('archiveorg')
  if (hostname.includes('meetdownload')) return getSiteConfig('meetdownload')
  if (hostname.includes('waploaded')) return getSiteConfig('waploaded')
  if (hostname.includes('maxcinema')) return getSiteConfig('maxcinema')
  return getSiteConfig(fallbackSite)
}

function isResolverHost(url, rootHost) {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    // Standard same-site + downloadwella resolution
    if (hostname === rootHost || hostname.endsWith('.' + rootHost) || hostname === 'downloadwella.com' || hostname.endsWith('.downloadwella.com')) return true
    // NaijaPrey resolution chain: np-downloader and wildshare are downstream resolvers
    if (hostname.includes('np-downloader.com') || hostname.includes('wildshare.net')) return true
    // O2TV / tvshows4mobile are cross-linked resolver hosts
    if (hostname.includes('tvshows4mobile') || hostname.includes('o2tvseries') || hostname.includes('o2tv.org')) return true
    // Wideshares is used by FZTVSeries for direct file downloads
    if (hostname.includes('wideshares.org')) return true
    // MeetDownload needs browser resolution for tokens
    if (hostname.includes('meetdownload.com')) return true
    // NetNaija chain: mynetnaija.ng is the download subdomain, kissorgrab.com is the CDN
    if (hostname.includes('mynetnaija.ng')) return true
    if (hostname.includes('kissorgrab.com')) return true
    // Internet Archive: details pages need resolution to find actual MP4 files
    if (hostname.includes('archive.org')) return true
    // MaxCinema: info pages need resolution to find server download links
    if (hostname.includes('maxcinema') || hostname.includes('koyeb.app')) return true
    return false
  } catch {
    return false
  }
}

async function resolveO2TvPage(pageUrl) {
  try {
    const parsed = new URL(pageUrl)
    const hostname = parsed.hostname.toLowerCase()
    if (!hostname.includes('o2tvseries') && !hostname.includes('o2tv.org') && !hostname.includes('tvshows4mobile')) {
      return null
    }

    const parts = parsed.pathname.split('/').filter(Boolean).map(p => decodeURIComponent(p))
    let showRaw = parts[0] || 'Show'
    let seasonRaw = parts[1] || 'Season 01'
    let episodeRaw = parts[2] || 'Episode 01'

    const showClean = showRaw
      .replace(/^Download-/i, '')
      .replace(/-otv[a-z0-9]+$/i, '')
      .replace(/-/g, ' ')
      .trim()

    const showSlug = showRaw

    // Extract season number — handles both "Season 01" and "Season-01"
    const seasonMatch = seasonRaw.match(/Season[\s-]*(\d+)/i)
    const seasonNum = seasonMatch ? parseInt(seasonMatch[1], 10) : 1

    // Extract episode number — handles both "Episode 01" and "Episode-01"
    const epMatch = episodeRaw.match(/Episode[\s-]*(\d+)/i) || episodeRaw.match(/S\d+E(\d+)/i)
    const epNum = epMatch ? parseInt(epMatch[1], 10) : 1

    // If this is a season page (no episode), resolve all episodes
    if (!episodeRaw || episodeRaw.startsWith('Season')) {
      const results = await resolveO2TvShow(showClean, 1, 10)
      // Filter to just the requested season
      const seasonPrefix = `S${String(seasonNum).padStart(2, '0')}E`
      return results.filter(r => r.title.includes(seasonPrefix))
    }

    // If this is an episode page, try to probe for the CDN URL
    const result = await resolveO2TvEpisode(showClean, showSlug, seasonNum, epNum)
    if (result) return [result]

    // Fallback: probe and fix the URL
    const s = String(seasonNum).padStart(2, '0')
    const e = String(epNum).padStart(2, '0')
    const slugSuffix = showSlug.match(/otv([a-z0-9]+)$/i)?.[1] || '1awrk'
    const fallbackUrl = `http://d6.o2tv.org/${encodeURIComponent(showClean)}/Season%20${s}/${encodeURIComponent(showClean)}%20-%20S${s}E${e}%20(TvShows4Mobile.Com)%20otv-${slugSuffix}.mp4`
    const fixedUrl = await probeAndFixO2TvUrl(fallbackUrl)
    return [{
      title: `${showClean} - S${s}E${e}`,
      url: fixedUrl,
      link: fixedUrl,
      source: 'o2tv',
      isDirect: true,
      playableInRoom: fixedUrl !== fallbackUrl,
      resolvedFrom: pageUrl,
    }]
  } catch (err) {
    console.error('O2TV direct resolution error:', err)
    return null
  }
}

async function resolveWidesharesPage(pageUrl) {
  try {
    const html = await fetchHtml(pageUrl)
    // Extract the force_download URL from the JavaScript
    const forceMatch = html.match(/force_download\.php\?path=[^"'\s]+/)
    if (forceMatch) {
      const forceUrl = forceMatch[0].startsWith('http') ? forceMatch[0] : `https://wideshares.org/${forceMatch[0]}`
      // Follow the redirect chain to get the final direct URL
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 6000)
      try {
        const res = await fetch(forceUrl, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Referer': pageUrl,
          },
        })
        clearTimeout(timer)
        const finalUrl = res.url || forceUrl
        const filename = decodeURIComponent(finalUrl.split('/').pop().split('?')[0])
        return [{
          title: filename.replace(/\.[^.]+$/, '').replace(/[._]/g, ' '),
          url: finalUrl,
          link: finalUrl,
          source: 'fztvseries',
          isDirect: true,
          playableInRoom: /\.(mp4|webm|m3u8)/i.test(finalUrl),
          resolvedFrom: pageUrl,
        }]
      } catch {
        clearTimeout(timer)
      }
    }

    // Fallback: extract any direct media URLs from the page
    return extractDirectMedia(html, pageUrl, 'fztvseries')
  } catch (err) {
    console.error('Wideshares resolution error:', err.message)
    return null
  }
}

/**
 * Resolve a MeetDownload page WITHOUT Puppeteer.
 * MeetDownload pages contain JS countdowns but the final download URLs
 * are often embedded in the page source as onclick handlers or in script tags.
 * This extracts them using regex.
 */
async function resolveMeetDownloadPage(url) {
  try {
    const html = await fetchHtml(url)
    if (!html) return []

    const results = []
    const seen = new Set()

    // Pattern 1: onclick="location.href='https://sub.kissorgrab.com/dl/...'"
    const onclickRe = /location\.href\s*=\s*['"]([^'"]*(?:kissorgrab|download|\.mp4|\.mkv)[^'"]*)['"]/gi
    let match
    while ((match = onclickRe.exec(html)) !== null) {
      const dlUrl = match[1].replace(/&amp;/g, '&')
      if (!seen.has(dlUrl)) {
        seen.add(dlUrl)
        const filename = decodeURIComponent(dlUrl.split('/').pop()?.split('?')[0] || 'Video')
        results.push({
          title: filename.replace(/\.[^.]+$/, ''),
          url: dlUrl,
          link: dlUrl,
          source: 'meetdownload',
          type: 'direct',
          isDirect: true,
          playableInRoom: /\.(mp4|webm|m3u8)/i.test(dlUrl),
          quality: extractQuality(filename),
          resolvedFrom: url,
        })
      }
    }

    // Pattern 2: <a href="https://...kissorgrab.com/dl/...">
    const hrefRe = /href\s*=\s*["']([^"']*(?:kissorgrab|\.mp4|\.mkv|download)[^"']*)["']/gi
    while ((match = hrefRe.exec(html)) !== null) {
      const dlUrl = match[1].replace(/&amp;/g, '&')
      if (seen.has(dlUrl)) continue
      seen.add(dlUrl)
      const filename = decodeURIComponent(dlUrl.split('/').pop()?.split('?')[0] || 'Video')
      results.push({
        title: filename.replace(/\.[^.]+$/, ''),
        url: dlUrl,
        link: dlUrl,
        source: 'meetdownload',
        type: 'direct',
        isDirect: true,
        playableInRoom: /\.(mp4|webm|m3u8)/i.test(dlUrl),
        quality: extractQuality(filename),
        resolvedFrom: url,
      })
    }

    // Pattern 3: window.location = '...' in script blocks
    const scriptRe = /window\.location\s*=\s*['"]([^'"]*(?:kissorgrab|\.mp4|\.mkv|download)[^'"]*)['"]/gi
    while ((match = scriptRe.exec(html)) !== null) {
      const dlUrl = match[1].replace(/&amp;/g, '&')
      if (seen.has(dlUrl)) continue
      seen.add(dlUrl)
      const filename = decodeURIComponent(dlUrl.split('/').pop()?.split('?')[0] || 'Video')
      results.push({
        title: filename.replace(/\.[^.]+$/, ''),
        url: dlUrl,
        link: dlUrl,
        source: 'meetdownload',
        type: 'direct',
        isDirect: true,
        playableInRoom: /\.(mp4|webm|m3u8)/i.test(dlUrl),
        quality: extractQuality(filename),
        resolvedFrom: url,
      })
    }

    // If regex didn't find anything and Puppeteer is available, fall back
    if (results.length === 0 && isBrowserAvailable()) {
      const browserResults = await resolveMeetDownload(url)
      return browserResults
    }

    return results
  } catch (err) {
    console.error('MeetDownload regex resolution error:', err.message)
    // Fall back to Puppeteer if available
    if (isBrowserAvailable()) {
      return await resolveMeetDownload(url)
    }
    return []
  }
}

export async function resolvePageChain(startUrl, site) {
  const rootHost = new URL(startUrl).hostname.toLowerCase().replace(/^www\\./, '')
  if (rootHost.includes('o2tvseries') || rootHost.includes('o2tv.org') || rootHost.includes('tvshows4mobile')) {
    const o2tvDirect = await resolveO2TvPage(startUrl)
    if (o2tvDirect && o2tvDirect.length) return o2tvDirect
  }

  // NaijaPrey full-chain resolution: content page → np-downloader → wildshare → direct URL
  if (rootHost.includes('naijaprey') || rootHost.includes('np-downloader') || rootHost.includes('wildshare')) {
    try {
      const naijapreyResults = await resolveNaijapreyChain(startUrl)
      if (naijapreyResults && naijapreyResults.length) return naijapreyResults
    } catch (err) {
      console.error('NaijaPrey chain resolution failed:', err.message)
    }
  }

  // NetNaija full-chain resolution: thenetnaija → mynetnaija → meetdownload → kissorgrab CDN
  if (rootHost.includes('thenetnaija.ng') || rootHost.includes('mynetnaija.ng') || rootHost.includes('meetdownload.com') || rootHost.includes('kissorgrab.com')) {
    try {
      const nnResults = await resolveNetNaijaChain(startUrl)
      if (nnResults && nnResults.length) return nnResults
    } catch (err) {
      console.error('NetNaija chain resolution failed:', err.message)
    }
  }

  // Wideshares resolution (used by FZTVSeries): download page → force_download → direct URL
  if (rootHost.includes('wideshares.org')) {
    try {
      const wsResults = await resolveWidesharesPage(startUrl)
      if (wsResults && wsResults.length) return wsResults
    } catch (err) {
      console.error('Wideshares resolution failed:', err.message)
    }
  }

  // MeetDownload resolution: Puppeteer-based (JS countdown + tokens)
  if (rootHost.includes('meetdownload')) {
    try {
      const mdResults = await resolveMeetDownload(startUrl)
      if (mdResults && mdResults.length) return mdResults
    } catch (err) {
      console.error('MeetDownload resolution failed:', err.message)
    }
  }

  // Internet Archive: details page → metadata API → direct MP4 URLs
  if (rootHost.includes('archive.org')) {
    try {
      const archiveResults = await resolveArchiveOrgPage(startUrl)
      if (archiveResults && archiveResults.length) return archiveResults
    } catch (err) {
      console.error('Archive.org resolution failed:', err.message)
    }
  }

  // MaxCinema: info page → server URL → 302 redirect → CDN file
  if (rootHost.includes('maxcinema') || rootHost.includes('koyeb.app')) {
    try {
      const mcResults = await resolveMaxCinemaChain(startUrl)
      if (mcResults && mcResults.length) return mcResults
    } catch (err) {
      console.error('MaxCinema resolution failed:', err.message)
    }
  }
  
  const queue = [{ url: startUrl, depth: 0 }]
  const visited = new Set()
  const output = []

  while (queue.length && visited.size < 8) {
    const current = queue.shift()
    if (visited.has(current.url)) continue
    visited.add(current.url)

    const hostname = new URL(current.url).hostname.toLowerCase()
    if (hostname === 'downloadwella.com' || hostname.endsWith('.downloadwella.com') || hostname.includes('downloadwella') || hostname.includes('fsmc')) {
      const resolved = await resolveDownloadwellaPage(current.url)
      if (resolved.directUrls.length) {
        output.push(...resolved.directUrls.map((mediaUrl) => {
          const proxied = toProxiedPlaybackUrl(mediaUrl, { referer: 'https://downloadwella.com/' })
          let title = 'Video'
          try {
            title = decodeURIComponent(new URL(mediaUrl).pathname.split('/').pop() || 'Video')
          } catch { /* */ }
          return {
            title: title.replace(MEDIA_EXT_RE, ''),
            url: proxied,
            link: proxied,
            thumbnail: resolved.thumbnail || null,
            image: resolved.thumbnail || null,
            source: 'downloadwella',
            type: 'direct',
            isDirect: true,
            playableInRoom: true,
            resolvedFrom: current.url,
          }
        }))
      } else {
        output.push(providerActionResult(current.url))
      }
      continue
    }

    let html
    try {
      html = await fetchHtml(current.url)
    } catch (error) {
      output.push({
        title: 'Page could not be fetched',
        url: current.url,
        link: current.url,
        source: hostname,
        isDirect: false,
        meta: error.message,
      })
      continue
    }

    const direct = extractDirectMedia(html, current.url, site || hostname)
    if (direct.length) {
      output.push(...direct.map((item) => ({ ...item, resolvedFrom: current.url })))
      continue
    }

    const pageResults = parseListing(html, current.url, siteConfigForUrl(current.url, site))
      .filter((item) => !item.isDirect && isResolverHost(item.url, rootHost))

    if (current.depth < 2) {
      for (const page of pageResults) {
        if (!visited.has(page.url)) queue.push({ url: page.url, depth: current.depth + 1 })
      }
    }

    if (!pageResults.length && current.url === startUrl) {
      output.push(...parseListing(html, current.url, siteConfigForUrl(current.url, site)))
    }
  }

  return [...new Map(output.filter((item) => item.url).map((item) => [item.url, item])).values()]
}

function parseListing(html, baseUrl, config) {
  const $ = cheerio.load(html)
  const results = []
  const seen = new Set()
  const pagePoster = $('meta[property="og:image"]').attr('content') ||
                     $('meta[name="twitter:image"]').attr('content') ||
                     $('.post-thumbnail img, .featured-image img, article img, .entry-content img, .poster img').first().attr('src') ||
                     $('.post-thumbnail img, .featured-image img, article img, .entry-content img, .poster img').first().attr('data-src') || null
  const resolvedPagePoster = resolveUrl(pagePoster, baseUrl)
  
  $(config.items).each((_, el) => {
    const $el = $(el)
    const title =
      $el.find(config.title).first().text().trim() ||
      $el.attr('title') ||
      ($el.is('a') ? $el.text().trim() : '') ||
      $el.find('img').first().attr('alt') ||
      'Untitled'
    
    let rawImg = $el.find(config.image).first().attr('src') ||
                 $el.find(config.image).first().attr('data-src') ||
                 $el.find('img').first().attr('src') ||
                 $el.find('img').first().attr('data-src') ||
                 $el.find('img').first().attr('data-lazy-src')
    
    if (!rawImg) {
      const parentCard = $el.closest('article, .post, .item, .card, .movie-item, .entry-content, main, .container, .movies-list')
      rawImg = parentCard.find('img[src], img[data-src]').first().attr('src') ||
               parentCard.find('img[src], img[data-src]').first().attr('data-src')
    }

    const img = resolveUrl(rawImg, baseUrl) || resolvedPagePoster
    const rawLink = $el.find(config.link).first().attr('href') || $el.closest('a').attr('href')
    const link = resolveUrl(rawLink, baseUrl)
    const meta = $el.find(config.meta).first().text().trim() || null
    
    if (title && link && !seen.has(link)) {
      seen.add(link)
      results.push({
        title: title.slice(0, 200),
        thumbnail: img || null,
        image: img || null,
        link,
        url: link,
        meta,
        isDirect: MEDIA_EXT_RE.test(link),
      })
    }
  })
  
  return results
}

// ==================== MAIN HANDLER ====================

async function requireUser(req) {
  const authorization = req.headers?.authorization || ''
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : ''
  if (!token) throw Object.assign(new Error('Missing token'), { status: 401 })

  try {
    return await verifyIdToken(token)
  } catch {
    throw Object.assign(new Error('Invalid or expired token'), { status: 401 })
  }
}

function requireCronSecret(req) {
  const expected = process.env.CRON_SECRET
  if (!expected) throw Object.assign(new Error('CRON_SECRET is not configured'), { status: 503 })
  const actual = req.headers?.['x-cron-secret'] || req.headers?.['X-Cron-Secret']
  if (actual !== expected) throw Object.assign(new Error('Unauthorized'), { status: 401 })
}

function clampInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, 0), max)
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length)
  let cursor = 0
  async function run() {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return results
}

async function refreshIptvCatalog(req, body) {
  requireCronSecret(req)
  const offset = clampInteger(body.offset, 0, 100000)
  const limit = clampInteger(body.limit, clampInteger(process.env.IPTV_HEALTH_CHECK_LIMIT, 50, 100), 100) || 50
  const channels = await getPlaylistChannels({ force: true })
  const batchChannels = channels.slice(offset, offset + limit)
  if (!batchChannels.length) {
    return { action: 'iptv', total: channels.length, offset, checked: 0, healthy: 0, nextOffset: null, complete: true }
  }

  const checks = await mapConcurrent(batchChannels, 8, (channel) => checkIptvChannel(channel.url))
  const db = getDb()
  const batch = db.batch()
  const collection = db.collection('mediaCatalog').doc('iptv').collection('channels')
  const checkedAt = FieldValue.serverTimestamp()
  batchChannels.forEach((channel, index) => {
    const health = checks[index]
    const id = createHash('sha1').update(channel.url).digest('hex')
    batch.set(collection.doc(id), {
      ...channel,
      source: channel.provider || 'iptv-playlist',
      playlistUrl: channel.playlistUrl || process.env.IPTV_PLAYLIST_URL || 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
      healthy: health.healthy,
      healthStatus: health.status,
      contentType: health.contentType,
      healthError: health.error,
      checkedAt,
    }, { merge: true })
  })
  await batch.commit()

  const healthy = checks.filter((check) => check.healthy).length
  const nextOffset = offset + batchChannels.length < channels.length ? offset + batchChannels.length : null
  return {
    action: 'iptv',
    total: channels.length,
    offset,
    checked: batchChannels.length,
    healthy,
    unhealthy: batchChannels.length - healthy,
    nextOffset,
    complete: nextOffset === null,
  }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed')

  // --- Rate limiting (per IP + per UID when available) ---
  const ip = clientKey(req)
  const ipRl = await checkRateLimit(`media:${ip}`, { limit: 40, windowMs: 60_000 })
  if (!ipRl.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
    res.end(JSON.stringify({ success: false, error: 'Too many requests — slow down' }))
    return
  }

  try {
    const body = req.body || {}
    const rawAction = body.action || req.query?.legacy || 'search'
    const action = sanitizeAction(rawAction, ALLOWED_MEDIA_ACTIONS) || 'search'

    // Validate and sanitize inputs early
    let query = body.query || ''
    let options = body.options || {}
    let url = body.url || ''
    let site = body.site || ''

    // Validate search query
    if (action === 'search' && query) {
      const cleanQuery = sanitizeSearchQuery(query)
      if (!cleanQuery) return fail(res, 400, 'Invalid search query')
      query = cleanQuery
    }

    // Validate scrape URL
    if (action === 'scrape' && url) {
      const cleanUrl = sanitizeUrl(url)
      if (!cleanUrl) return fail(res, 400, 'Invalid or unsafe URL')
      body.url = cleanUrl
    }
    if (action === 'refreshCatalog') {
      const catalog = await refreshIptvCatalog(req, body)
      return ok(res, catalog)
    }

    await requireUser(req)
    const decoded = await verifyIdToken(req.headers.authorization?.split('Bearer ')[1] || '')
    const layer = body.layer || body.source || 'youtube'
    
    // Legacy scrape endpoint
    if (action === 'scrape') {
      if (!url) return fail(res, 400, 'URL is required')
      
      // Direct video URL - return immediately
      if (MEDIA_EXT_RE.test(url)) {
        const title = decodeURIComponent(url.split('/').pop() || 'Video')
        return ok(res, {
          results: [{
            title: title.replace(MEDIA_EXT_RE, ''),
            url,
            isDirect: true,
            source: 'direct',
            type: 'direct',
          }],
          count: 1,
        })
      }
      
      const target = new URL(url)
      // NaijaPrey URL resolution (content page, np-downloader, or wildshare)
      if (target.hostname.toLowerCase().includes('naijaprey') || target.hostname.toLowerCase().includes('np-downloader') || target.hostname.toLowerCase().includes('wildshare')) {
        try {
          const npResults = await resolveNaijapreyChain(url)
          if (npResults && npResults.length > 0) {
            const omdbResults = await enrichWithOMDbPosters(npResults, query || '')
            const results = deduplicateAndEnrich(omdbResults, query || '')
            return ok(res, {
              results,
              count: results.length,
              directCount: results.filter((item) => item.isDirect).length,
              resolved: true,
              url,
              site: 'naijaprey',
            })
          }
        } catch (err) {
          console.error('NaijaPrey scrape resolution failed:', err.message)
        }
      }

      // NetNaija URL resolution (thenetnaija → mynetnaija → meetdownload → kissorgrab CDN)
      if (target.hostname.toLowerCase().includes('thenetnaija') || target.hostname.toLowerCase().includes('mynetnaija') || target.hostname.toLowerCase().includes('meetdownload') || target.hostname.toLowerCase().includes('kissorgrab')) {
        try {
          const nnResults = await resolveNetNaijaChain(url)
          if (nnResults && nnResults.length > 0) {
            const omdbResults = await enrichWithOMDbPosters(nnResults, query || '')
            const results = deduplicateAndEnrich(omdbResults, query || '')
            return ok(res, {
              results,
              count: results.length,
              directCount: results.filter((item) => item.isDirect).length,
              resolved: true,
              url,
              site: 'netnaija',
            })
          }
        } catch (err) {
          console.error('NetNaija scrape resolution failed:', err.message)
        }
      }

      // Internet Archive URL resolution (details page → metadata → direct MP4 URLs)
      if (target.hostname.toLowerCase().includes('archive.org')) {
        try {
          const archiveResults = await resolveArchiveOrgPage(url)
          if (archiveResults && archiveResults.length > 0) {
            const omdbResults = await enrichWithOMDbPosters(archiveResults, query || '')
            const results = deduplicateAndEnrich(omdbResults, query || '')
            return ok(res, {
              results,
              count: results.length,
              directCount: results.filter((item) => item.isDirect).length,
              resolved: true,
              url,
              site: 'archiveorg',
            })
          }
        } catch (err) {
          console.error('Archive.org scrape resolution failed:', err.message)
        }
      }

      // MaxCinema URL resolution (info page → server → 302 → CDN)
      if (target.hostname.toLowerCase().includes('maxcinema') || target.hostname.toLowerCase().includes('koyeb.app')) {
        try {
          const mcResults = await resolveMaxCinemaChain(url)
          if (mcResults && mcResults.length > 0) {
            const omdbResults = await enrichWithOMDbPosters(mcResults, query || '')
            const results = deduplicateAndEnrich(omdbResults, query || '')
            return ok(res, {
              results,
              count: results.length,
              directCount: results.filter((item) => item.isDirect).length,
              resolved: true,
              url,
              site: 'maxcinema',
            })
          }
        } catch (err) {
          console.error('MaxCinema scrape resolution failed:', err.message)
        }
      }

      // NSFW provider URL resolution (xvideos/pornhub/spankbang page → direct video URL)
      if (isNsfwProviderUrl(url)) {
        try {
          const resolved = await resolveNsfwVideoUrl(url)
          if (resolved && resolved.videoUrl) {
            // ALWAYS route NSFW video URLs through the proxy because:
            // 1. NSFW CDNs require specific Referer headers (browser sends wrong Referer)
            // 2. CORS blocks direct browser-to-CDN requests
            // 3. HTTP URLs need HTTPS proxying (mixed content)
            const referer = resolved.referer
              || (resolved.source === 'pornhub' ? 'https://www.pornhub.com/'
                : resolved.source === 'xvideos' ? 'https://www.xvideos.com/'
                  : resolved.source === 'spankbang' ? 'https://spankbang.party/'
                    : 'https://www.pornhub.com/')
            const videoUrl = toProxiedPlaybackUrl(resolved.videoUrl, { referer })
            return ok(res, {
              results: [{
                title: decodeURIComponent(target.pathname.split('/').pop() || 'Video'),
                url: videoUrl,
                link: videoUrl,
                thumbnail: null,
                source: resolved.source || 'nsfw',
                type: 'nsfw',
                isDirect: true,
                playableInRoom: true,
                videoType: 'direct',
                resolvedFrom: url,
                quality: resolved.quality || null,
                streamType: resolved.type || 'mp4',
              }],
              count: 1,
              directCount: 1,
              resolved: true,
              url,
              site: resolved.source || 'nsfw',
            })
          }
        } catch (err) {
          console.error('NSFW provider resolve failed:', err.message)
        }
        // If resolution failed, return the page as-is with a helpful message
        return ok(res, {
          results: [{
            title: decodeURIComponent(target.pathname.split('/').pop() || 'Video'),
            url,
            link: url,
            thumbnail: null,
            source: target.hostname.includes('xvideos') ? 'xvideos' : target.hostname.includes('pornhub') ? 'pornhub' : 'spankbang',
            type: 'nsfw',
            isDirect: false,
            requiresUserAction: true,
            meta: 'Could not auto-extract video URL. Open the page to watch.',
          }],
          count: 1,
          directCount: 0,
          url,
          site: 'nsfw',
        })
      }

      // DoodStream (dood.li, dood.to, etc.) video URL resolution
      if (isDoodUrl(url)) {
        try {
          const resolved = await resolveDoodUrl(url)
          if (resolved && resolved.videoUrl) {
            // DoodStream URLs are time-limited — route through proxy for HTTPS + reliability
            const videoUrl = `/api/proxy?url=${encodeURIComponent(resolved.videoUrl)}`
            return ok(res, {
              results: [{
                title: resolved.title || 'Video',
                url: videoUrl,
                link: videoUrl,
                thumbnail: resolved.thumbnail || null,
                source: 'doodstream',
                type: 'direct',
                isDirect: true,
                playableInRoom: true,
                resolvedFrom: url,
                meta: 'DoodStream video (time-limited URL)',
              }],
              count: 1,
              directCount: 1,
              resolved: true,
              url,
              site: 'doodstream',
            })
          }
        } catch (err) {
          console.error('DoodStream resolve failed:', err.message)
        }
        return ok(res, {
          results: [{
            title: 'DoodStream Video',
            url,
            link: url,
            thumbnail: null,
            source: 'doodstream',
            type: 'direct',
            isDirect: false,
            requiresUserAction: true,
            meta: 'Could not resolve DoodStream video automatically. Try opening the page directly.',
          }],
          count: 1,
          directCount: 0,
          url,
          site: 'doodstream',
        })
      }

      if (target.hostname.toLowerCase().includes('downloadwella') || target.hostname.toLowerCase().includes('fsmc')) {
        // Always resolve (and re-probe) downloadwella / fsmc CDN links — tokens expire
        // and the CDN requires a downloadwella.com Referer via the proxy.
        const resolved = await resolveDownloadwellaPage(url)
        const results = resolved.directUrls.length
          ? resolved.directUrls.map((mediaUrl) => {
              const proxied = toProxiedPlaybackUrl(mediaUrl, { referer: 'https://downloadwella.com/' })
              let title = 'Video'
              try {
                title = decodeURIComponent(new URL(mediaUrl).pathname.split('/').pop() || 'Video')
              } catch { /* */ }
              return {
                title: title.replace(MEDIA_EXT_RE, ''),
                url: proxied,
                link: proxied,
                thumbnail: resolved.thumbnail || null,
                image: resolved.thumbnail || null,
                source: 'downloadwella',
                type: 'direct',
                isDirect: true,
                playableInRoom: true,
                resolvedFrom: url,
                videoType: 'direct',
              }
            })
          : [{
              title: decodeURIComponent(target.pathname.split('/').pop() || 'Download page'),
              url,
              link: url,
              thumbnail: resolved.thumbnail || null,
              image: resolved.thumbnail || null,
              source: 'downloadwella',
              isDirect: false,
              requiresUserAction: true,
              meta: 'Provider download action could not be resolved automatically. The link may have expired — open Nkiri/DownloadWella again and pick a fresh result.',
            }]
        return ok(res, {
          results,
          count: results.length,
          directCount: resolved.directUrls.length,
          requiresUserAction: resolved.directUrls.length === 0,
          url,
          site: 'downloadwella',
        })
      }

      // Resolve same-site/download-provider pages up to a small bounded depth.
      // Provider controls are detected but not bypassed.
      if (options.resolve === true) {
        const chainResults = await resolvePageChain(url, site || 'custom')
        if (chainResults.length > 0) {
          const omdbResults = await enrichWithOMDbPosters(chainResults, query || '')
          const results = deduplicateAndEnrich(omdbResults, query || '')
          return ok(res, {
            results,
            count: results.length,
            directCount: results.filter((item) => item.isDirect).length,
            resolved: true,
            url,
            site: site || 'custom',
          })
        }
      }

      // Single-page scrape fallback.
      const html = await fetchHtml(url)
      const config = getSiteConfig(site) || getSiteConfig('custom')
      const directResults = extractDirectMedia(html, url, site || 'custom')
      const pageResults = parseListing(html, url, config)
      const merged = [...directResults, ...pageResults]
      const omdbResults = await enrichWithOMDbPosters(merged, query || '')
      const results = deduplicateAndEnrich(omdbResults, query || '')
      
      return ok(res, {
        results,
        count: results.length,
        directCount: directResults.length,
        url,
        site: site || 'custom',
      })
    }
    
    // Unified search
    if (action === 'search') {
      if (!query) return fail(res, 400, 'Query is required')
      
      let results = []
      let hasMore = false
      
      switch (layer) {
        case 'all': {
          const [ytRes, directRes, iptvRes, sportsRes] = await Promise.all([
            searchYouTube(query, 6).catch(() => []),
            searchDirectLinks(query, { ...options, limit: 14, resolve: true }).catch(() => ({ results: [] })),
            searchIPTV(query, options.userChannels || [], options.provider || '', 6).catch(() => []),
            searchSports(query).catch(() => []),
          ])
          results = deduplicateAndEnrich([
            ...(directRes.results || []),
            ...ytRes,
            ...iptvRes,
            ...sportsRes,
          ], query)
          hasMore = false
          break
        }
        case 'youtube':
          try {
            results = await searchYouTube(query, Math.min(50, Math.max(1, Number(options.limit) || 20)))
          } catch (ytErr) {
            console.error('YouTube search error:', ytErr.message)
            // Return empty results with helpful message instead of 500 error
            return ok(res, { success: true, results: [], searchedSites: ['youtube'], error: `YouTube: ${ytErr.message}` })
          }
          break
        case 'omdb':
        case 'movies':
          results = await searchOMDb(query)
          break
        case 'direct': {
          const page = await searchDirectLinks(query, options)
          results = page.results
          hasMore = page.hasMore
          break
        }
        case 'iptv':
          results = await searchIPTV(query, options.userChannels || [], options.provider || '')
          break
        case 'sports':
          results = await searchSports(query)
          break
        case 'nsfw': {
          // Wrap NSFW search in a timeout to prevent Vercel Hobby 504
          // If the search takes >8s, return whatever partial results we have
          let nsfwResult
          try {
            nsfwResult = await Promise.race([
              searchNSFW(query, options, decoded),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('NSFW search timed out')), 8000)
              ),
            ])
          } catch (timeoutErr) {
            console.error('NSFW search timeout or error:', timeoutErr.message)
            // Return empty results instead of crashing with 504
            return ok(res, {
              success: true,
              layer: 'nsfw',
              query,
              count: 0,
              hasMore: false,
              results: [],
              error: 'NSFW search timed out — providers may be slow. Try again or search a specific provider.',
            })
          }
          results = (nsfwResult.results || nsfwResult).map((result) => {
            const thumb = result.thumbnail || result.image || null
            const itemUrl = result.url || result.link || ''
            // Search hits are provider PAGE urls — mark for resolution, not as already-direct.
            // Client will call action=scrape which runs resolveNsfwVideoUrl + proxy.
            return {
              ...result,
              thumbnail: thumb,
              image: thumb,
              source: result.source || result.provider || 'xvideos',
              type: 'nsfw',
              isNSFW: true,
              isDirect: false,
              // Keep requiresUserAction so UI knows this needs a resolve step,
              // but the client now auto-resolves instead of only opening a new tab.
              requiresUserAction: true,
              playableInRoom: false,
              url: itemUrl,
              link: itemUrl,
            }
          })
          hasMore = nsfwResult.hasMore === true
          break
        }
        default:
          return fail(res, 400, `Unknown layer: ${layer}`)
      }
      
      const omdbEnriched = await enrichWithOMDbPosters(results, query)
      const deduplicated = deduplicateAndEnrich(omdbEnriched, query)
      
      return ok(res, {
        success: true,
        layer,
        query,
        count: deduplicated.length,
        hasMore,
        results: deduplicated,
      })
    }
    
    return fail(res, 400, `Unknown action: ${action}`)
  } catch (err) {
    console.error('Media API error:', err)
    // Don't leak internal error details to the client
    const safeMessage = statusForError(err) >= 500 ? 'Internal server error' : (err.message || 'Request failed')
    return fail(res, statusForError(err), safeMessage)
  }
}
