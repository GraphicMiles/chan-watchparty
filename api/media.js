import * as cheerio from 'cheerio'
import { createHash } from 'node:crypto'
import { preflight, ok, fail, statusForError } from '../server-lib/http.js'
import { getDb, FieldValue, verifyIdToken } from '../server-lib/firebaseAdmin.js'
import { getSiteConfig, resolveUrl, isSuitableThumbnail, isTitleMatch, cleanTitleForMatching, cleanTitleForOMDb } from '../server-lib/sources.js'
import { checkRateLimit, clientKey } from '../server-lib/rateLimit.js'
import { validateFetchUrl, isPrivateHost } from '../server-lib/ssrf.js'
import { checkIptvChannel, getIptvChannels, getPlaylistChannels, probeIptvChannel } from '../server-lib/iptv.js'
import { resolveDownloadwellaPage } from '../server-lib/downloadwella.js'
import { searchNsfwProvider } from '../server-lib/nsfw.js'
import { resolveNsfwVideoUrl, isNsfwProviderUrl } from '../server-lib/nsfwResolver.js'
import { resolveNaijapreyChain } from '../server-lib/naijapreyResolver.js'
import {
  resolveO2TvShow,
  resolveO2TvEpisode,
  probeAndFixO2TvUrl,
  searchO2Tv,
  getO2TvSeasons,
  getO2TvEpisodes,
} from '../server-lib/o2tvResolver.js'
import { resolveO2TvEpisodeViaCaptcha } from '../server-lib/o2tvCaptchaResolver.js'
import { resolveNetNaijaChain } from '../server-lib/netnaijaResolver.js'
import { resolveArchiveOrgPage, resolveArchiveOrgDirectUrl } from '../server-lib/archiveResolver.js'
import { searchMaxCinema, resolveMaxCinemaChain } from '../server-lib/maxcinemaResolver.js'
import { resolveWithBrowser, getBrowser, isBrowserAvailable } from '../server-lib/browser.js'
import { resolveDoodUrl, isDoodUrl } from '../server-lib/doodResolver.js'
import { sanitizeSearchQuery, sanitizeUrl, sanitizeAction } from '../server-lib/sanitize.js'

const ALLOWED_MEDIA_ACTIONS = [
  'search',
  'scrape',
  'refreshCatalog',
  'probeIptv',
  'o2tvSeasons',
  'o2tvEpisodes',
  'o2tvResolve',
]

const MEDIA_EXT_RE = /\.(mp4|m3u8|webm|ogg|mov|mkv|avi|flv|ts)(\?|#|$)/i
// Server-side key takes precedence; fall back to VITE_ key so a single
// Vercel environment variable (VITE_YOUTUBE_API_KEY) works for both
// client-side checks and server-side search without extra configuration.
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.VITE_YOUTUBE_API_KEY
const OMDB_API_KEY = process.env.OMDB_API_KEY || null  // no hardcoded fallback — must be configured
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY

/**
 * Route a remote media URL through /api/proxy so the browser can play it
 * over HTTPS with the correct upstream Referer. MKV files get remux=1.
 */
function toProxiedPlaybackUrl(mediaUrl, { referer } = {}) {
  if (!mediaUrl || typeof mediaUrl !== 'string') return mediaUrl
  if (mediaUrl.startsWith('/api/proxy')) return mediaUrl
  // Safety net: decode HTML entities that may have leaked through from page scraping
  // (JSON.parse does NOT decode &amp; → & so URLs extracted from HTML can contain entities)
  let cleanUrl = mediaUrl
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&#47;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
  try {
    const parsed = new URL(cleanUrl)
    const isMkv = /\.mkv(\?|#|$)/i.test(parsed.pathname)
      || /-mkv(\?|#|$)/i.test(parsed.pathname)
      || parsed.searchParams.getAll('name').some((v) => /\.mkv$/i.test(v) || /-mkv$/i.test(v))
    let out = `/api/proxy?url=${encodeURIComponent(cleanUrl)}`
    if (isMkv) out += '&remux=1'
    if (referer && /^https?:\/\//i.test(referer)) {
      out += `&referer=${encodeURIComponent(referer)}`
    }
    return out
  } catch {
    return `/api/proxy?url=${encodeURIComponent(cleanUrl)}`
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

    // Soft title filter for direct/movie results (strict match was dropping whole providers)
    if (query && String(query).trim() && !isAdult) {
      const isDirectOrMovie = item.isDirect || item.type === 'direct' || item.type === 'movie' || item.type === 'anime' || ['nkiri', 'netnaija', 'fzmovies', '9jarocks', 'animedrive', 'o2tv', 'downloadwella', 'naijaprey', 'fztvseries', 'archiveorg', 'meetdownload', 'waploaded', 'maxcinema', 'omdb'].includes(item.source)
      if (isDirectOrMovie) {
        const baseQuery = query.replace(/\s+season\s*\d+$/i, '').trim()
        const itemBase = (item.title || '').replace(/\s*[-–]\s*season\s*\d+.*$/i, '').replace(/\s*s\d+\s*e\d+.*$/i, '').trim()
        const hardMatch = isTitleMatch(item.title, query)
          || isTitleMatch(itemBase, baseQuery)
          || isTitleMatch(item.title, baseQuery)
        if (!hardMatch) {
          // Soft: all meaningful tokens (≥3 chars) appear in the title
          const qTokens = cleanTitleForMatching(baseQuery || query)
            .split(/\s+/)
            .filter((t) => t.length >= 3)
          const tClean = cleanTitleForMatching(item.title || '')
          if (qTokens.length > 0 && !qTokens.every((t) => tClean.includes(t))) {
            return false
          }
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
    throw new Error('YouTube API key not configured on the server. Add YOUTUBE_API_KEY (or VITE_YOUTUBE_API_KEY) to your Vercel environment variables.')
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
  const tryKeys = [
    String(searchKeyword).trim(),
    // Strip season/episode noise for better poster match
    String(searchKeyword).replace(/\b(season|episode|s\d+e\d+|s\d+|part\s*\d+)\b/gi, ' ').replace(/\s+/g, ' ').trim(),
  ].filter((k, i, a) => k && k.length >= 2 && a.indexOf(k) === i)

  try {
    for (const key of tryKeys) {
      // Prefer exact title lookup first
      const tUrl = `https://www.omdbapi.com/?apikey=${OMDB_API_KEY}&t=${encodeURIComponent(key)}`
      try {
        const tRes = await fetch(tUrl)
        if (tRes.ok) {
          const tData = await tRes.json()
          if (tData?.Poster && tData.Poster !== 'N/A' && isSuitableThumbnail(tData.Poster)) {
            return tData.Poster
          }
        }
      } catch { /* try search */ }

      const url = `https://www.omdbapi.com/?apikey=${OMDB_API_KEY}&s=${encodeURIComponent(key)}`
      const res = await fetch(url)
      if (!res.ok) continue
      const data = await res.json()
      if (data.Response === 'False' || !Array.isArray(data.Search)) continue

      // Prefer posters that title-match; else first good poster
      let fallback = null
      for (const it of data.Search) {
        if (!it.Poster || it.Poster === 'N/A' || !isSuitableThumbnail(it.Poster)) continue
        if (!fallback) fallback = it.Poster
        if (isTitleMatch(it.Title, key) || (originalQuery && isTitleMatch(it.Title, originalQuery))) {
          return it.Poster
        }
      }
      if (fallback) return fallback
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

    // 2. Prefer existing poster (including Nkiri thenkiri.com images)
    let thumb = item.thumbnail || item.image || item.poster || null
    const isProviderJunk = typeof thumb === 'string' && /downloadwella|np-downloader|wildshare|fsmc|kissorgrab|meetdownload|1x1|pixel|logo|spinner|placeholder/i.test(thumb)
    const hasGoodThumbnail = isSuitableThumbnail(thumb) && !isProviderJunk
    // Keep Nkiri/thenkiri/netnaija posters — they are real show art
    const isNkiriStylePoster = typeof thumb === 'string' && /thenkiri|nkiri|thenetnaija|mynetnaija|pbcdnw|aoneroom/i.test(thumb)

    if (hasGoodThumbnail || isNkiriStylePoster) {
      return {
        ...item,
        thumbnail: thumb,
        image: thumb,
        title: formatMediaTitle(item.title) || item.title,
      }
    }

    // 3. No usable thumbnail — OMDb by clean title
    if (!cleanItemName || cleanItemName.length < 2) {
      return {
        ...item,
        thumbnail: isSuitableThumbnail(thumb) ? thumb : null,
        image: isSuitableThumbnail(thumb) ? thumb : null,
        title: formatMediaTitle(item.title) || item.title,
      }
    }

    if (!posterCache.has(cleanItemName)) {
      const fetched = await fetchBestOMDbPoster(cleanItemName, query)
      posterCache.set(cleanItemName, fetched || null)
    }

    const matchedPoster = posterCache.get(cleanItemName) || null
    const finalThumb = matchedPoster || (isSuitableThumbnail(thumb) ? thumb : null)
    return {
      ...item,
      title: formatMediaTitle(item.title) || item.title,
      thumbnail: finalThumb,
      image: finalThumb,
      posterSource: matchedPoster ? 'omdb' : item.posterSource,
    }
  })

  return updated
}

// Vercel Hobby tier has a ~10s function timeout. Search must return listing
// results from MANY providers — do NOT deep-resolve during search (that is
// done on click via action=scrape). Keep the deadline high enough for slow
// African hosts, but never expand every season for every provider.
const DIRECT_SEARCH_TIMEOUT_MS = 9000

/**
 * Lenient title match for Nkiri listings.
 * Returns a score: 0 = no match, higher = better.
 * Hard-zero only when nothing useful overlaps — avoids wiping all hits
 * when Nkiri titles are noisy ("Download … Nkiri", SEO junk, etc.).
 */
function titleMatchScore(title, query) {
  if (!title || !query) return 1
  if (isTitleMatch(title, query)) return 100

  const baseQuery = String(query)
    .replace(/\s+season\s*\d+$/i, '')
    .replace(/\s+s\d+\s*e\d+.*$/i, '')
    .trim()
  if (baseQuery && baseQuery !== query && isTitleMatch(title, baseQuery)) return 90

  const itemBase = String(title)
    .replace(/\s*[-–]\s*season\s*\d+.*$/i, '')
    .replace(/\s*s\d+\s*e\d+.*$/i, '')
    .replace(/^(download|watch|stream|get)\s+/i, '')
    .trim()
  if (baseQuery && isTitleMatch(itemBase, baseQuery)) return 85

  const qTokens = cleanTitleForMatching(baseQuery || query)
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !['of', 'the', 'in', 'at', 'to', 'and', 'for', 'with', 'by', 'from', 'on', 'or', 'a', 'an'].includes(t))
  if (qTokens.length === 0) return 1

  const tClean = cleanTitleForMatching(title)
  if (!tClean) return 0

  // Exact cleaned phrase
  const qClean = cleanTitleForMatching(baseQuery || query)
  if (qClean && tClean.includes(qClean)) return 80

  const hits = qTokens.filter((t) => tClean.includes(t))
  if (hits.length === 0) {
    // Last-chance: first significant token only (e.g. query "silo season 2" vs title "SILO")
    const primary = qTokens[0]
    if (primary && primary.length >= 3 && tClean.includes(primary)) return 25
    return 0
  }

  // Majority of tokens is enough (was: every token — too strict)
  const ratio = hits.length / qTokens.length
  if (ratio >= 1) return 70
  if (ratio >= 0.6) return 50
  if (hits.length >= 2) return 35
  if (hits[0] && hits[0].length >= 4) return 20
  return 0
}

function softTitleMatch(title, query) {
  return titleMatchScore(title, query) > 0
}

/**
 * Clean a media title for display: strip provider names, site branding, file extensions.
 * Keep only: show/movie title + season/episode + quality.
 * Examples:
 *   "Download Silo Season 1 Episode 3 - 1080p WEB-DLP - Nkiri" → "Silo - S01E03 - 1080p"
 *   "[Nkiri] House of the Dragon S02E01 720p WEB-DL" → "House of the Dragon - S02E01 - 720p"
 *   "Download Avengers Endgame 2019 1080p BluRay" → "Avengers Endgame - 1080p BluRay"
 */
function formatMediaTitle(rawTitle) {
  if (!rawTitle) return 'Untitled'
  let title = String(rawTitle).trim()

  // Strip provider / site branding completely (never show in UI)
  title = title
    .replace(/^(download|watch|stream|get|free)\s+/i, '')
    .replace(/\[(nkiri|thenkiri|netnaija|thenetnaija|mynetnaija|fzmovies|9jarocks|naijaprey|fztvseries|downloadwella|maxcinema|archive\.org|o2tv|custom|omdb)\]/gi, '')
    .replace(/\b(nkiri|thenkiri|netnaija|thenetnaija|mynetnaija|fzmovies|9jarocks|naijaprey|fztvseries|downloadwella|maxcinema|archive\.org|o2tvseries|o2tv|meetdownload|kissorgrab|tvshows4mobile)\b/gi, '')
    .replace(/\s*[-–|]\s*(free|hd|watch online|download)\s*$/gi, '')

  // Capture season + episode in human form
  let seasonNum = null
  let episodeNum = null
  let partNum = null

  let seMatch = title.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i)
  if (seMatch) {
    seasonNum = parseInt(seMatch[1], 10)
    episodeNum = parseInt(seMatch[2], 10)
    title = title.replace(seMatch[0], ' ')
  } else {
    seMatch = title.match(/\bSeason\s*(\d{1,2})\s*(?:Episode\s*(\d{1,3}))?\b/i)
    if (seMatch) {
      seasonNum = parseInt(seMatch[1], 10)
      if (seMatch[2]) episodeNum = parseInt(seMatch[2], 10)
      title = title.replace(seMatch[0], ' ')
    } else {
      seMatch = title.match(/\b(\d{1,2})x(\d{1,3})\b/i)
      if (seMatch) {
        seasonNum = parseInt(seMatch[1], 10)
        episodeNum = parseInt(seMatch[2], 10)
        title = title.replace(seMatch[0], ' ')
      }
    }
  }

  // Standalone season (S03 / Season 3) without episode
  if (seasonNum == null) {
    const sOnly = title.match(/\bS(\d{1,2})\b/i) || title.match(/\bSeason\s*(\d{1,2})\b/i)
    if (sOnly) {
      seasonNum = parseInt(sOnly[1], 10)
      title = title.replace(sOnly[0], ' ')
    }
  }

  // Standalone episode
  if (episodeNum == null) {
    const eOnly = title.match(/\bE(?:p(?:isode)?)?\s*(\d{1,3})\b/i)
    if (eOnly) {
      episodeNum = parseInt(eOnly[1], 10)
      title = title.replace(eOnly[0], ' ')
    }
  }

  // Part N (Batman Part Two / Part 2)
  const partMatch = title.match(/\bPart\s*([0-9]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i)
  if (partMatch) {
    const raw = partMatch[1].toLowerCase()
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
    partNum = words[raw] || parseInt(raw, 10)
    title = title.replace(partMatch[0], ' ')
  }

  // Drop quality / codec / container tags from display title (optional quiet strip)
  title = title
    .replace(/\.(mp4|mkv|m3u8|avi|mov|webm|ts)$/i, '')
    .replace(/\b(x264|x265|h\.?264|h\.?265|hevc|aac|ac3|dts|5\.1|7\.1)\b/gi, ' ')
    .replace(/\b(WEB-?DLP?|BluRay|BRRip|HDRip|WEBRip|HDTV|DVDRip|CAMRip|TELECINE|WEB)\b/gi, ' ')
    .replace(/\b(4K|2160p|1440p|1080p|720p|480p|360p|HD|SD|HQ|FullHD|UHD)\b/gi, ' ')
    .replace(/\b(complete|full series|tv series|series|movie|film|free|watch|online|added)\b/gi, ' ')
    .replace(/\(\d{4}\)/g, ' ')
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/[_]+/g, ' ')
    .replace(/\s*[-–:]+\s*/g, ' ')
    .replace(/[^a-zA-Z0-9\s'&.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Title-case words
  const titleCase = (s) => {
    const words = s.split(/\s+/).filter(Boolean)
    return words.map((w, i) => {
      const lower = w.toLowerCase()
      if (i > 0 && /^(a|an|the|and|or|of|in|on|to|for|with|at|by|from)$/.test(lower)) return lower
      // Keep short all-caps tokens
      if (/^[A-Z0-9]{2,4}$/.test(w) && w === w.toUpperCase()) return w
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    }).join(' ')
  }

  let base = titleCase(title) || 'Untitled'

  // Build: "Silo: Season 1 Episode 3" or "Batman: Part 2"
  const bits = []
  if (seasonNum != null) bits.push(`Season ${seasonNum}`)
  if (episodeNum != null) bits.push(`Episode ${episodeNum}`)
  if (partNum != null && seasonNum == null) bits.push(`Part ${partNum}`)

  if (bits.length) {
    return `${base}: ${bits.join(' ')}`
  }
  return base
}


/**
 * Resolve a Downloadwella page to a direct CDN video URL using Puppeteer.
 * Downloadwella pages have a "Create download link" JS button — cheerio/form
 * submission doesn't work. Puppeteer clicks the button and extracts the result.
 *
 * Chain: downloadwella page → click button → wait for link → extract /d/... URL
 */
async function resolveDownloadwellaWithBrowser(pageUrl) {
  if (!isBrowserAvailable()) {
    console.log('Browser not available — skipping Puppeteer downloadwella resolution')
    return []
  }
  try {
    const results = await resolveWithBrowser(pageUrl, {
      timeout: 20000,
      countdownSeconds: 3,
      waitForSelector: 'input[type="submit"], button, a.btn',
      extractFn: async (page, originUrl) => {
        // Find and click the "Create download link" button
        const selectors = [
          'input[value*="Create download"]',
          'input[type="submit"]',
          'button[type="submit"]',
          'a.btn-primary',
          '.download-btn',
        ]
        let clicked = false
        for (const sel of selectors) {
          try {
            const el = await page.$(sel)
            if (el) { await el.click(); clicked = true; break }
          } catch { /* try next */ }
        }

        if (!clicked) {
          try {
            await page.evaluate(() => {
              const els = document.querySelectorAll('input, button, a')
              for (const el of els) {
                const text = (el.value || el.textContent || '').toLowerCase()
                if (text.includes('download') || text.includes('create')) { el.click(); return true }
              }
              return false
            })
            clicked = true
          } catch { /* ignore */ }
        }

        if (clicked) {
          await page.waitForFunction(() => {
            const links = document.querySelectorAll('a[href]')
            for (const link of links) {
              const href = link.href || ''
              if (/\/d\/[a-z0-9]+/i.test(href) || /\.(mp4|mkv|m3u8|webm)/i.test(href)) return true
            }
            const body = document.body.innerText || ''
            return /https?:\/\/[^\s]+\/d\/[a-z0-9]+/i.test(body)
          }, { timeout: 15000 }).catch(() => {})
        }

        return await page.evaluate(() => {
          const results = []
          const seen = new Set()
          document.querySelectorAll('a[href]').forEach((el) => {
            const href = el.href || ''
            if (seen.has(href)) return
            if (/\/d\/[a-z0-9]+/i.test(href) || /\.(mp4|mkv|m3u8|webm|avi|mov)(\?|#|$)/i.test(href)) {
              seen.add(href)
              results.push({ url: href, title: el.textContent.trim() || decodeURIComponent(href.split('/').pop().split('?')[0]) || 'Video' })
            }
          })
          const bodyText = document.body.innerText || ''
          const urlMatches = bodyText.match(/https?:\/\/[^\s]+\/d\/[a-z0-9]+[^\s]*/gi) || []
          for (const raw of urlMatches) {
            const clean = raw.replace(/&amp;/g, '&').replace(/[.)]$/, '')
            if (!seen.has(clean)) { seen.add(clean); results.push({ url: clean, title: decodeURIComponent(clean.split('/').pop().split('?')[0]) || 'Video' }) }
          }
          return results
        })
      },
    })
    return results || []
  } catch (err) {
    console.error('Downloadwella Puppeteer resolution failed:', err.message)
    return []
  }
}

/**
 * Related queries — kept SHORT for Vercel Hobby (10s).
 * Old version fired 10+ sequential searches and often timed out → empty results.
 */
function generateRelatedQueries(baseQ) {
  const clean = String(baseQ || '').trim()
  if (!clean) return []
  const queries = [clean]

  // Only expand when query is a short title (not already "silo s02e01")
  if (/\b(season\s*\d+|s\d+\s*e\d+|s\d+\b|episode\s*\d+)\b/i.test(clean)) {
    return queries
  }

  // One sequel hint is enough for discovery under Hobby budget
  queries.push(`${clean} season 1`)
  if (clean.split(/\s+/).length <= 3) {
    queries.push(`${clean} 2`)
  }
  // Cap hard
  return [...new Set(queries)].slice(0, 3)
}

function parseNkiriSearchHtml(searchHtml, baseUrl, seenUrls) {
  const pages = []
  if (!searchHtml) return pages
  const $s = cheerio.load(searchHtml)
  const baseHost = (() => {
    try { return new URL(baseUrl).origin } catch { return 'https://thenkiri.com' }
  })()

  const push = (hrefRaw, titleRaw, thumbRaw) => {
    if (!hrefRaw) return
    let href = hrefRaw.trim()
    try { href = new URL(href, baseUrl).href } catch { return }
    if (!href.startsWith('http')) return
    // Accept thenkiri / nkiri hosts
    if (!/thenkiri\.com|nkiri\.com/i.test(href)) return
    // Drop WP chrome / taxonomy / feeds — keep content slugs like /silo-s03-complete-tv-series/
    if (/\/(page|category|tag|search|author|wp-json|feed|wp-content|wp-includes|comments)\//i.test(href)) return
    if (/[?&]s=/i.test(href)) return
    if (/#/.test(href) && href.replace(/#.*$/, '').replace(/\/$/, '') === baseHost) return
    if (/\/(how-to-download|login|register)\/?$/i.test(href)) return
    if (seenUrls.has(href)) return
    const title = String(titleRaw || '').replace(/\s+/g, ' ').trim()
      || href.split('/').filter(Boolean).pop()?.replace(/[-_]/g, ' ')
      || 'Video'
    let thumbnail = thumbRaw || null
    if (thumbnail) {
      try { thumbnail = new URL(thumbnail, baseUrl).href } catch { thumbnail = null }
    }
    seenUrls.add(href)
    pages.push({ url: href, title, thumbnail })
  }

  // Broad selector set — Nkiri/WordPress themes change class names often
  const selectors = [
    '.search-entry-inner a[href]',
    '.search-entry a[href]',
    'article a[href]',
    '.post-item a[href]',
    '.post a[href]',
    '.entry-title a[href]',
    'h2.entry-title a[href]',
    'h2 a[href]',
    'h3 a[href]',
    '.movie-item a[href]',
    '.list-movies a[href]',
    '.jetpack-search-filters-widget a[href]',
    'a[rel="bookmark"]',
    'main a[href]',
  ]

  for (const sel of selectors) {
    $s(sel).each((_, el) => {
      const href = $s(el).attr('href') || ''
      const $el = $s(el)
      const title = $el.find('img').attr('alt')
        || $el.attr('title')
        || $el.attr('aria-label')
        || $el.text()
        || $el.closest('article, .post, .search-entry, .post-item').find('h1,h2,h3,.entry-title').first().text()
        || ''
      const thumbnail = $el.find('img').attr('src')
        || $el.find('img').attr('data-src')
        || $el.find('img').attr('data-lazy-src')
        || $el.closest('article, .post, .search-entry, .post-item').find('img').first().attr('src')
        || null
      push(href, title, thumbnail)
    })
  }

  // Regex fallback for any thenkiri post links missed by DOM
  if (pages.length < 3) {
    const re = /href=["'](https?:\/\/(?:www\.)?(?:thenkiri|nkiri)\.com\/[^"']+)["']/gi
    let m
    while ((m = re.exec(searchHtml)) !== null) {
      const href = m[1]
      if (seenUrls.has(href)) continue
      const ctx = searchHtml.slice(Math.max(0, m.index - 400), Math.min(searchHtml.length, m.index + 600))
      const tm = ctx.match(/title=["']([^"']+)["']/) || ctx.match(/alt=["']([^"']+)["']/) || ctx.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/i)
      const thumbMatch = ctx.match(/(?:src|data-src|data-lazy-src)=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i)
      push(href, tm?.[1], thumbMatch?.[1])
    }
  }

  // Also surface bare downloadwella links if theme embeds them in search HTML
  const dwRe = /href=["'](https?:\/\/(?:www\.)?downloadwella\.com\/[^"']+)["']/gi
  let dw
  while ((dw = dwRe.exec(searchHtml)) !== null) {
    const href = dw[1].replace(/&amp;/g, '&')
    if (seenUrls.has(href)) continue
    if (/\/(login|register|premium)/i.test(href)) continue
    const ctx = searchHtml.slice(Math.max(0, dw.index - 250), Math.min(searchHtml.length, dw.index + 400))
    const tm = ctx.match(/title=["']([^"']+)["']/) || ctx.match(/alt=["']([^"']+)["']/)
    const title = (tm?.[1] || href.split('/').filter(Boolean).pop()?.replace(/[-_.]/g, ' ') || 'Episode').trim()
    seenUrls.add(href)
    pages.push({ url: href, title, thumbnail: null })
  }

  return pages
}

/**
 * Direct Links = O2TV show listing only (fast, Hobby-safe).
 * Flow: search shows → Create Room loads seasons → user picks season →
 * episodes → user picks episode → o2tvResolve → playable proxy URL.
 * Do NOT deep-resolve every episode at search time (that was incomplete /
 * timeout-prone and produced flat episode dumps without hierarchy).
 */
async function searchDirectLinks(query, options = {}) {
  const baseQ = String(query || '').trim()
  if (!baseQ) {
    return { results: [], hasMore: false, searchedSites: ['o2tv'], multiLayerCascaded: false }
  }

  const limit = Math.min(40, Math.max(5, Number(options.limit) || 20))
  // Catalog page is large; give searchO2Tv enough headroom (it caches after first hit).
  const searchTimeout = Math.max(DIRECT_SEARCH_TIMEOUT_MS, 14000)

  let shows = []
  let searchError = null
  try {
    shows = await Promise.race([
      searchO2Tv(baseQ, limit),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('O2TV search timed out')), searchTimeout),
      ),
    ])
  } catch (err) {
    searchError = err.message
    console.error('O2TV show search failed:', err.message)
    shows = []
  }

  if (!Array.isArray(shows)) shows = []

  // Do NOT invent fake show slugs here — searchO2Tv already probes guesses.
  // Returning bogus /Show/ links breaks Create Room season loading.

  let results = shows.slice(0, limit).map((s) => {
    const showName = String(s.showName || s.title || baseQ).trim() || baseQ
    const showSlug = String(s.showSlug || '').trim()
    const pageUrl = String(s.url || (showSlug ? `https://tvshows4mobile.org/${showSlug}/index.html` : '')).trim()
    // Keep short clean titles; formatMediaTitle is for noisy episode labels
    const title = showName.length <= 80 ? showName : (formatMediaTitle(showName) || showName)
    return {
      title,
      url: pageUrl,
      link: pageUrl,
      thumbnail: null,
      image: null,
      source: 'o2tv',
      type: 'direct',
      isDirect: false,
      playableInRoom: false,
      requiresResolve: true,
      o2tvKind: 'show',
      showSlug,
      showName,
      quality: 'HD',
      videoType: 'direct',
      meta: s.guessed
        ? 'Guessed show link — open to load seasons'
        : 'TV show — pick a season, then an episode',
      matchScore: s.matchScore || 0,
    }
  }).filter((r) => r.url && r.showSlug)

  try {
    results = await enrichWithOMDbPosters(results, baseQ)
  } catch (err) {
    console.error('OMDb enrich (o2tv) failed:', err.message)
  }

  results = results.map((r) => ({
    ...r,
    title: String(r.title || r.showName || baseQ),
    source: 'o2tv',
    o2tvKind: 'show',
    showSlug: r.showSlug,
    showName: r.showName || r.title,
    isDirect: false,
    playableInRoom: false,
    requiresResolve: true,
  }))

  return {
    results,
    hasMore: false,
    searchedSites: ['o2tv'],
    multiLayerCascaded: false,
    error: results.length ? undefined : (searchError || undefined),
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
      // Include health metadata if available from the Firestore catalog
      healthy: channel.healthy !== false,
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
  const timeout = setTimeout(() => controller.abort(), 3500)
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

/**
 * Parse tvshows4mobile / o2tv page URLs into { showSlug, showName, seasonNum, epNum, kind }.
 * kind: 'show' | 'season' | 'episode' | 'cdn'
 */
function parseO2TvUrl(pageUrl) {
  const parsed = new URL(pageUrl)
  const hostname = parsed.hostname.toLowerCase()
  const isCdn = hostname.includes('o2tv.org')
  const isListing = hostname.includes('tvshows4mobile') || hostname.includes('o2tvseries')

  if (!isCdn && !isListing) return null

  const parts = parsed.pathname.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p) } catch { return p }
  })

  // CDN: /Show Name/Season 01/Show Name - S01E01 (...).mp4
  if (isCdn) {
    const showName = (parts[0] || 'Show').trim()
    const seasonMatch = (parts[1] || '').match(/Season[\s-]*(\d+)/i)
    const seasonNum = seasonMatch ? parseInt(seasonMatch[1], 10) : 1
    const filename = parts[parts.length - 1] || ''
    const epMatch = filename.match(/S\d+E(\d+)/i) || filename.match(/Episode[\s-]*(\d+)/i)
    const epNum = epMatch ? parseInt(epMatch[1], 10) : 1
    return {
      kind: /\.mp4/i.test(filename) ? 'cdn' : 'episode',
      showSlug: showName.replace(/\s+/g, '-'),
      showName,
      seasonNum,
      epNum,
      rawUrl: pageUrl,
    }
  }

  // Listing: /Show-Slug/ or /Show-Slug/Season-01/ or /Show-Slug/Season-01/Episode-01/
  const showRaw = parts[0] || 'Show'
  const showSlug = showRaw.replace(/\/index\.html?$/i, '')
  const showName = showSlug
    .replace(/^Download-/i, '')
    .replace(/-otv[a-z0-9]+$/i, '')
    .replace(/-/g, ' ')
    .trim()

  const seasonPart = parts[1] || ''
  const episodePart = parts[2] || ''
  const seasonMatch = seasonPart.match(/Season[\s-]*(\d+)/i)
  const seasonNum = seasonMatch ? parseInt(seasonMatch[1], 10) : null
  const epMatch = episodePart.match(/Episode[\s-]*(\d+)/i) || episodePart.match(/S\d+E(\d+)/i)
  const epNum = epMatch ? parseInt(epMatch[1], 10) : null

  let kind = 'show'
  if (seasonNum != null && epNum != null) kind = 'episode'
  else if (seasonNum != null) kind = 'season'

  return { kind, showSlug, showName, seasonNum: seasonNum || 1, epNum: epNum || 1, rawUrl: pageUrl }
}

async function resolveO2TvPage(pageUrl) {
  try {
    const info = parseO2TvUrl(pageUrl)
    if (!info) return null

    const { kind, showSlug, showName, seasonNum, epNum } = info

    // CDN direct file — probe/fix if needed, then return as playable
    if (kind === 'cdn') {
      const fixedUrl = await probeAndFixO2TvUrl(pageUrl)
      const s = String(seasonNum).padStart(2, '0')
      const e = String(epNum).padStart(2, '0')
      return [{
        title: `${showName} - S${s}E${e}`,
        url: fixedUrl,
        link: fixedUrl,
        source: 'o2tv',
        isDirect: true,
        playableInRoom: true,
        resolvedFrom: pageUrl,
        showSlug,
        showName,
        seasonNum,
        episodeNum: epNum,
      }]
    }

    // Show root: list seasons (do NOT deep-resolve every episode)
    if (kind === 'show') {
      const seasons = await getO2TvSeasons(showSlug)
      if (!seasons.length) {
        // Fallback: try resolveO2TvShow for first few eps so UI is not empty
        const fallback = await resolveO2TvShow(showName, 1, 8)
        return (fallback || []).map((r) => ({
          ...r,
          title: asPlainString(r.title, showName),
          url: asPlainString(r.url || r.link),
          link: asPlainString(r.link || r.url),
          showSlug,
          showName,
          o2tvKind: r.isDirect ? 'direct' : 'episode',
        })).filter((r) => r.url)
      }
      return seasons.map((season) => {
        const num = Number(season.number) || 0
        const pageUrl = absO2TvUrl(season.url, showSlug, num)
        return {
          title: asPlainString(`${showName}: Season ${num}`, `Season ${num}`),
          label: asPlainString(season.label, `Season ${num}`),
          url: pageUrl,
          link: pageUrl,
          source: 'o2tv',
          type: 'direct',
          isDirect: false,
          playableInRoom: false,
          requiresResolve: true,
          o2tvKind: 'season',
          showSlug,
          showName,
          seasonNum: num,
        }
      }).filter((r) => r.seasonNum > 0)
    }

    // Season page: list episodes (do NOT CDN-probe each yet)
    if (kind === 'season') {
      const episodes = await getO2TvEpisodes(showSlug, seasonNum)
      if (!episodes.length) {
        // Probe first few as last resort
        const probed = []
        for (let ep = 1; ep <= 8; ep += 1) {
          const result = await resolveO2TvEpisode(showName, showSlug, seasonNum, ep)
          if (result?.url) {
            probed.push({
              ...result,
              title: asPlainString(result.title),
              url: asPlainString(result.url),
              link: asPlainString(result.link || result.url),
              showSlug,
              showName,
              seasonNum,
              episodeNum: ep,
              o2tvKind: 'direct',
            })
          }
        }
        return probed
      }
      const s = String(seasonNum).padStart(2, '0')
      return episodes.map((ep) => {
        const num = Number(ep.number) || 0
        const e = String(num).padStart(2, '0')
        const pageUrl = absO2TvUrl(ep.url, showSlug, seasonNum, num)
        return {
          title: asPlainString(`${showName} - S${s}E${e}`, `S${s}E${e}`),
          label: asPlainString(ep.title, `Episode ${num}`),
          url: pageUrl,
          link: pageUrl,
          source: 'o2tv',
          type: 'direct',
          isDirect: false,
          playableInRoom: false,
          requiresResolve: true,
          o2tvKind: 'episode',
          showSlug,
          showName,
          seasonNum,
          episodeNum: num,
        }
      }).filter((r) => r.episodeNum > 0)
    }

    // Episode page: probe CDN (and captcha fallback)
    {
      let result = await resolveO2TvEpisode(showName, showSlug, seasonNum, epNum)
      if (!result) {
        try {
          const captchaResults = await resolveO2TvEpisodeViaCaptcha(showSlug, seasonNum, epNum)
          if (captchaResults?.length && captchaResults[0]?.url) {
            result = captchaResults[0]
          }
        } catch (err) {
          console.error('O2TV captcha fallback failed:', err.message)
        }
      }
      if (result) {
        return [{
          ...result,
          showSlug,
          showName,
          seasonNum,
          episodeNum: epNum,
          o2tvKind: 'direct',
          resolvedFrom: pageUrl,
        }]
      }

      const s = String(seasonNum).padStart(2, '0')
      const e = String(epNum).padStart(2, '0')
      const slugSuffix = showSlug.match(/otv([a-z0-9]+)$/i)?.[1] || '1awrk'
      const fallbackUrl = `http://d6.o2tv.org/${encodeURIComponent(showName)}/Season%20${s}/${encodeURIComponent(showName)}%20-%20S${s}E${e}%20(TvShows4Mobile.Com)%20otv-${slugSuffix}.mp4`
      const fixedUrl = await probeAndFixO2TvUrl(fallbackUrl)
      return [{
        title: `${showName} - S${s}E${e}`,
        url: fixedUrl,
        link: fixedUrl,
        source: 'o2tv',
        isDirect: true,
        playableInRoom: fixedUrl !== fallbackUrl,
        resolvedFrom: pageUrl,
        showSlug,
        showName,
        seasonNum,
        episodeNum: epNum,
        o2tvKind: 'direct',
        probeFailed: fixedUrl === fallbackUrl,
      }]
    }
  } catch (err) {
    console.error('O2TV direct resolution error:', err)
    return null
  }
}

/**
 * Dedicated hierarchical O2TV handlers used by Create Room UI.
 */
function absO2TvUrl(href, showSlug, seasonNum, episodeNum) {
  const fallback = episodeNum != null
    ? `https://tvshows4mobile.org/${showSlug}/Season-${String(seasonNum).padStart(2, '0')}/Episode-${String(episodeNum).padStart(2, '0')}/`
    : seasonNum != null
      ? `https://tvshows4mobile.org/${showSlug}/Season-${String(seasonNum).padStart(2, '0')}/`
      : `https://tvshows4mobile.org/${showSlug}/`
  if (!href || typeof href !== 'string') return fallback
  if (/^https?:\/\//i.test(href)) return href
  try {
    return new URL(href, 'https://tvshows4mobile.org/').href
  } catch {
    return fallback
  }
}

function asPlainString(value, fallback = '') {
  if (value == null) return fallback
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // Never leak "[object Object]" into titles / URLs / Firestore
  return fallback
}

async function handleO2TvSeasons({ showSlug, showName, thumbnail }) {
  const slug = asPlainString(showSlug).trim()
  if (!slug) throw Object.assign(new Error('showSlug is required'), { status: 400 })
  const seasons = await getO2TvSeasons(slug)
  const name = asPlainString(showName).trim()
    || slug.replace(/-otv[a-z0-9]+$/i, '').replace(/-/g, ' ').trim()
  let poster = asPlainString(thumbnail) || null
  if (!poster) {
    try {
      poster = await fetchBestOMDbPoster(name)
    } catch { /* ignore */ }
  }
  const results = (seasons || []).map((season) => {
    const num = Number(season.number) || 0
    const pageUrl = absO2TvUrl(season.url, slug, num)
    return {
      title: asPlainString(`${name}: Season ${num}`, `Season ${num}`),
      label: asPlainString(season.label, `Season ${num}`),
      url: pageUrl,
      link: pageUrl,
      thumbnail: poster,
      image: poster,
      source: 'o2tv',
      type: 'direct',
      isDirect: false,
      playableInRoom: false,
      requiresResolve: true,
      o2tvKind: 'season',
      showSlug: slug,
      showName: name,
      seasonNum: num,
    }
  }).filter((r) => r.seasonNum > 0 && r.url)
  return {
    results,
    count: results.length,
    showSlug: slug,
    showName: name,
    thumbnail: poster,
    stage: 'seasons',
  }
}

async function handleO2TvEpisodes({ showSlug, showName, seasonNum, thumbnail }) {
  const slug = asPlainString(showSlug).trim()
  if (!slug) throw Object.assign(new Error('showSlug is required'), { status: 400 })
  const season = Math.max(1, Number(seasonNum) || 1)
  const name = asPlainString(showName).trim()
    || slug.replace(/-otv[a-z0-9]+$/i, '').replace(/-/g, ' ').trim()
  const episodes = await getO2TvEpisodes(slug, season)
  let poster = asPlainString(thumbnail) || null
  if (!poster) {
    try {
      poster = await fetchBestOMDbPoster(name)
    } catch { /* ignore */ }
  }
  const s = String(season).padStart(2, '0')
  const results = (episodes || []).map((ep) => {
    const num = Number(ep.number) || 0
    const e = String(num).padStart(2, '0')
    const pageUrl = absO2TvUrl(ep.url, slug, season, num)
    return {
      title: asPlainString(`${name} - S${s}E${e}`, `S${s}E${e}`),
      label: asPlainString(ep.title, `Episode ${num}`),
      url: pageUrl,
      link: pageUrl,
      thumbnail: poster,
      image: poster,
      source: 'o2tv',
      type: 'direct',
      isDirect: false,
      playableInRoom: false,
      requiresResolve: true,
      o2tvKind: 'episode',
      showSlug: slug,
      showName: name,
      seasonNum: season,
      episodeNum: num,
    }
  }).filter((r) => r.episodeNum > 0 && r.url)
  return {
    results,
    count: results.length,
    showSlug: slug,
    showName: name,
    seasonNum: season,
    thumbnail: poster,
    stage: 'episodes',
  }
}

async function handleO2TvResolve({ showSlug, showName, seasonNum, episodeNum, thumbnail }) {
  const slug = asPlainString(showSlug).trim()
  if (!slug) throw Object.assign(new Error('showSlug is required'), { status: 400 })
  const season = Math.max(1, Number(seasonNum) || 1)
  const ep = Math.max(1, Number(episodeNum) || 1)
  const name = asPlainString(showName).trim()
    || slug.replace(/-otv[a-z0-9]+$/i, '').replace(/-/g, ' ').trim()
  const s = String(season).padStart(2, '0')
  const e = String(ep).padStart(2, '0')

  // Prefer captcha/download-page resolve first when GROQ is available — CDN
  // suffix probing is slow and often 404s for newer shows. Fall back to probe.
  let resolved = null
  try {
    const captchaResults = await resolveO2TvEpisodeViaCaptcha(slug, season, ep)
    if (captchaResults?.length && captchaResults[0]?.url && typeof captchaResults[0].url === 'string') {
      resolved = captchaResults[0]
    }
  } catch (err) {
    console.error('O2TV resolve captcha failed:', err.message)
  }

  if (!resolved?.url || typeof resolved.url !== 'string') {
    try {
      resolved = await resolveO2TvEpisode(name, slug, season, ep)
    } catch (err) {
      console.error('O2TV CDN probe failed:', err.message)
    }
  }

  const rawPlay = asPlainString(resolved?.url)
  if (!rawPlay) {
    // Clear error — Create Room can show Retry; room is not created with a dead URL
    const needsGroq = !process.env.GROQ_API_KEY
    throw Object.assign(
      new Error(
        needsGroq
          ? `Could not resolve ${name} S${s}E${e}. Server needs GROQ_API_KEY for O2TV captcha unlock, or try another episode.`
          : `Could not resolve ${name} S${s}E${e}. Try another episode or quality.`
      ),
      { status: 404 },
    )
  }

  let playUrl = rawPlay
  if (!playUrl.startsWith('/api/proxy') && /^https?:\/\//i.test(playUrl)) {
    playUrl = `/api/proxy?url=${encodeURIComponent(playUrl)}&referer=${encodeURIComponent('http://d6.o2tv.org/')}`
  }

  let poster = asPlainString(thumbnail) || asPlainString(resolved?.thumbnail) || null
  if (!poster) {
    try {
      poster = await fetchBestOMDbPoster(name)
    } catch { /* ignore */ }
  }

  const title = asPlainString(resolved?.title, `${name} - S${s}E${e}`)
  const item = {
    title,
    url: playUrl,
    link: playUrl,
    thumbnail: poster,
    image: poster,
    source: 'o2tv',
    type: 'direct',
    isDirect: true,
    playableInRoom: true,
    o2tvKind: 'direct',
    showSlug: slug,
    showName: name,
    seasonNum: season,
    episodeNum: ep,
    quality: asPlainString(resolved?.quality, 'HD') || 'HD',
    videoType: 'direct',
  }

  return {
    results: [item],
    count: 1,
    directCount: 1,
    resolved: true,
    stage: 'resolved',
    showSlug: slug,
    showName: name,
    seasonNum: season,
    episodeNum: ep,
    thumbnail: poster,
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
 * (Kept for potential future use — currently not called from search pipeline)
 */

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

    // Validate scrape URL (must update local `url` — body.url alone is not used below)
    if (action === 'scrape' && url) {
      const cleanUrl = sanitizeUrl(url)
      if (!cleanUrl) return fail(res, 400, 'Invalid or unsafe URL')
      url = cleanUrl
      body.url = cleanUrl
    }
    if (action === 'refreshCatalog') {
      const catalog = await refreshIptvCatalog(req, body)
      return ok(res, catalog)
    }

    if (action === 'probeIptv') {
      // Lightweight health probe for a single IPTV channel URL
      // Used by the room/player to verify a channel is alive before playback
      const probeUrl = body.url || url
      if (!probeUrl) return fail(res, 400, 'URL is required')
      const probe = await probeIptvChannel(probeUrl)
      return ok(res, { ...probe, url: probeUrl })
    }

    await requireUser(req)
    const decoded = await verifyIdToken(req.headers.authorization?.split('Bearer ')[1] || '')
    const layer = body.layer || body.source || 'youtube'

    // Hierarchical O2TV browse / resolve (Create Room flow)
    if (action === 'o2tvSeasons') {
      const payload = await handleO2TvSeasons({
        showSlug: body.showSlug || options.showSlug,
        showName: body.showName || options.showName,
        thumbnail: body.thumbnail || options.thumbnail,
      })
      return ok(res, payload)
    }
    if (action === 'o2tvEpisodes') {
      const payload = await handleO2TvEpisodes({
        showSlug: body.showSlug || options.showSlug,
        showName: body.showName || options.showName,
        seasonNum: body.seasonNum ?? options.seasonNum,
        thumbnail: body.thumbnail || options.thumbnail,
      })
      return ok(res, payload)
    }
    if (action === 'o2tvResolve') {
      const payload = await handleO2TvResolve({
        showSlug: body.showSlug || options.showSlug,
        showName: body.showName || options.showName,
        seasonNum: body.seasonNum ?? options.seasonNum,
        episodeNum: body.episodeNum ?? options.episodeNum,
        thumbnail: body.thumbnail || options.thumbnail,
      })
      return ok(res, payload)
    }
    
    // Legacy scrape endpoint
    if (action === 'scrape') {
      if (!url) return fail(res, 400, 'URL is required')
      
      // Direct video URL / already-proxied URL - return immediately (still proxy MKV/http)
      if (MEDIA_EXT_RE.test(url) || /^\/api\/proxy\?/i.test(url)) {
        let playUrl = url
        if (!/^\/api\/proxy\?/i.test(url)) {
          playUrl = toProxiedPlaybackUrl(url)
        }
        const title = decodeURIComponent(url.split('/').pop() || 'Video')
        return ok(res, {
          results: [{
            title: title.replace(MEDIA_EXT_RE, ''),
            url: playUrl,
            link: playUrl,
            isDirect: true,
            playableInRoom: true,
            source: 'direct',
            type: 'direct',
          }],
          count: 1,
          directCount: 1,
          resolved: true,
        })
      }

      const target = new URL(url)

      // MaxCinema Koyeb CDN watch URLs look like:
      // https://*.koyeb.app/watch/TOKEN?name=[MaxCinema...]_title_S01E01
      // They often have NO .mkv/.mp4 extension but stream Matroska/MP4.
      // Always proxy them (with remux) so the browser can play.
      if (target.hostname.toLowerCase().includes('koyeb.app')) {
        try {
          const nameParam = target.searchParams.get('name') || target.pathname.split('/').pop() || 'Video'
          let title = decodeURIComponent(nameParam)
            .replace(/^\[.*?\]\s*_?/i, '')
            .replace(/_/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || 'MaxCinema Video'
          // Force remux for Koyeb — most files are MKV even without extension
          const proxied = `/api/proxy?url=${encodeURIComponent(url)}&remux=1&referer=${encodeURIComponent('https://www.maxcinema.name.ng/')}`
          return ok(res, {
            results: [{
              title,
              url: proxied,
              link: proxied,
              source: 'maxcinema',
              type: 'direct',
              isDirect: true,
              playableInRoom: true,
              videoType: 'direct',
              resolvedFrom: url,
              meta: 'Koyeb CDN — proxied + remuxed for browser playback',
            }],
            count: 1,
            directCount: 1,
            resolved: true,
            url,
            site: 'maxcinema',
          })
        } catch (err) {
          console.error('Koyeb CDN wrap failed:', err.message)
        }
      }

      // NaijaPrey URL resolution (content page, np-downloader, or wildshare)
      if (target.hostname.toLowerCase().includes('naijaprey') || target.hostname.toLowerCase().includes('np-downloader') || target.hostname.toLowerCase().includes('wildshare')) {
        try {
          const npResults = await resolveNaijapreyChain(url)
          if (npResults && npResults.length > 0) {
            // Proxy actual direct media URLs. Do NOT proxy intermediate pages
            // (np-downloader / wildshare landing pages) as if they were playable.
            const proxied = npResults.map((item) => {
              if (!item) return item
              const mediaUrl = item.url || item.link
              if (!mediaUrl) return item
              const isDirectMedia = item.isDirect === true || MEDIA_EXT_RE.test(mediaUrl)
              if (isDirectMedia) {
                // Wildshare/silversurfer direct links prefer the wildshare landing
                // page as Referer; the naijaprey page is accepted but less reliable.
                const isWildshare = /wildshare\.net|silversurfer\.wildshare|dlws\d+\.wildshare|fasterbytes\.wildshare/i.test(mediaUrl)
                const referer = isWildshare
                  ? (item.referer || item.resolvedFrom || 'https://www.naijaprey.tv/')
                  : 'https://www.naijaprey.tv/'
                const playUrl = toProxiedPlaybackUrl(mediaUrl, { referer })
                return {
                  ...item,
                  url: playUrl,
                  link: playUrl,
                  isDirect: true,
                  playableInRoom: true,
                  type: 'direct',
                  source: item.source || 'naijaprey',
                }
              }
              return {
                ...item,
                source: item.source || 'naijaprey',
                type: 'direct',
                isDirect: false,
                playableInRoom: false,
                requiresResolve: true,
              }
            })
            const omdbResults = await enrichWithOMDbPosters(proxied, query || '')
            // Don't over-filter resolved chain results by title match
            const results = deduplicateAndEnrich(omdbResults, null)
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
              // NetNaija's kissorgrab CDN URLs are direct MKV files but need proxying
              // for CORS, correct Referer, and MKV remuxing.
              const proxied = nnResults.map((item) => {
                if (!item || !item.url) return item
                const mediaUrl = item.url || item.link
                if (!mediaUrl) return item
                if (item.isDirect && /kissorgrab|meetdownload|mynetnaija/i.test(mediaUrl)) {
                  const playUrl = toProxiedPlaybackUrl(mediaUrl, { referer: 'https://meetdownload.com/' })
                  return {
                    ...item,
                    url: playUrl,
                    link: playUrl,
                    type: 'direct',
                    source: item.source || 'netnaija',
                    videoType: 'direct',
                    // Preserve playableInRoom=false for subtitle files
                    playableInRoom: item.playableInRoom !== false,
                  }
                }
                return { ...item, source: item.source || 'netnaija', type: 'direct' }
              })
            const omdbResults = await enrichWithOMDbPosters(proxied, query || '')
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

      // O2TV hierarchical listing / CDN resolve (show → seasons → episodes → MP4)
      if (target.hostname.toLowerCase().includes('o2tv.org') || target.hostname.toLowerCase().includes('tvshows4mobile') || target.hostname.toLowerCase().includes('o2tvseries')) {
        try {
          const o2tvResults = await resolveO2TvPage(url)
          if (o2tvResults && o2tvResults.length > 0) {
            const info = parseO2TvUrl(url)
            const posterQuery = info?.showName || query || ''
            let poster = null
            try {
              if (posterQuery) poster = await fetchBestOMDbPoster(posterQuery)
            } catch { /* ignore */ }

            const proxied = o2tvResults.map((item) => {
              if (!item || !item.url) return item
              const thumb = item.thumbnail || item.image || poster || null
              if (item.isDirect && !item.url.startsWith('/api/proxy') && /^https?:\/\//i.test(item.url)) {
                const playUrl = `/api/proxy?url=${encodeURIComponent(item.url)}&referer=${encodeURIComponent('http://d6.o2tv.org/')}`
                return {
                  ...item,
                  url: playUrl,
                  link: playUrl,
                  thumbnail: thumb,
                  image: thumb,
                  playableInRoom: true,
                }
              }
              return {
                ...item,
                thumbnail: thumb,
                image: thumb,
              }
            })
            // Don't title-filter hierarchical season/episode lists
            const results = deduplicateAndEnrich(proxied, null)
            const allDirect = results.every((item) => item.isDirect || item.playableInRoom)
            return ok(res, {
              results,
              count: results.length,
              directCount: results.filter((item) => item.isDirect || item.playableInRoom).length,
              resolved: allDirect,
              stage: info?.kind === 'show' ? 'seasons' : info?.kind === 'season' ? 'episodes' : 'resolved',
              showSlug: info?.showSlug,
              showName: info?.showName,
              seasonNum: info?.seasonNum,
              thumbnail: poster,
              url,
              site: 'o2tv',
            })
          }
        } catch (err) {
          console.error('O2TV scrape resolution failed:', err.message)
        }
      }

      // MaxCinema URL resolution (info page → server → 302 → CDN)
      if (target.hostname.toLowerCase().includes('maxcinema') || target.hostname.toLowerCase().includes('koyeb.app')) {
        try {
          const mcResults = await resolveMaxCinemaChain(url)
          if (mcResults && mcResults.length > 0) {
              // Always proxy MaxCinema/Koyeb results (often MKV without extension)
              const proxied = mcResults.map((item) => {
                if (!item) return item
                const mediaUrl = item.url || item.link
                if (!mediaUrl) return item
                // Only treat as playable if the resolver explicitly marked it playable
                // or it's a Koyeb URL we know how to proxy. DoodStream/raw CDN links
                // that failed resolution must keep playableInRoom=false.
                const isKoyeb = /koyeb\.app/i.test(mediaUrl) && !/^\/api\/proxy/i.test(mediaUrl)
                const isPlayable = item.playableInRoom !== false || isKoyeb
                if (item.isDirect && isPlayable) {
                  // Force remux for koyeb (MKV-without-extension is common)
                  const playUrl = isKoyeb
                    ? `/api/proxy?url=${encodeURIComponent(mediaUrl)}&remux=1&referer=${encodeURIComponent('https://www.maxcinema.name.ng/')}`
                    : toProxiedPlaybackUrl(mediaUrl, {
                        referer: 'https://www.maxcinema.name.ng/',
                      })
                  return {
                    ...item,
                    url: playUrl,
                    link: playUrl,
                    isDirect: true,
                    playableInRoom: true,
                    type: 'direct',
                    source: item.source || 'maxcinema',
                    videoType: 'direct',
                  }
                }
                return { ...item, source: item.source || 'maxcinema', type: 'direct' }
              })
            const omdbResults = await enrichWithOMDbPosters(proxied, query || '')
            const results = deduplicateAndEnrich(omdbResults, null)
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

      // Nkiri URL resolution (show page → extract episode downloadwella links)
      if (target.hostname.toLowerCase().includes('thenkiri') || target.hostname.toLowerCase().includes('nkiri.com')) {
        try {
          const pageHtml = await fetchHtml(url)
          const $page = cheerio.load(pageHtml)
          const pagePoster = $page('meta[property="og:image"]').attr('content')
            || $page('meta[name="twitter:image"]').attr('content')
            || $page('img[src]').first().attr('src')
            || null
          const resolvedPoster = resolveUrl(pagePoster, url)
          const pageTitle = ($page('meta[property="og:title"]').attr('content')
            || $page('h1').first().text()
            || $page('title').text()
            || '').replace(/\s+/g, ' ').trim()

          const episodes = []
          const seenEp = new Set()
          const addEp = (hrefRaw, textRaw) => {
            if (!hrefRaw) return
            let href = String(hrefRaw).replace(/&amp;/g, '&').trim()
            try { href = new URL(href, url).href } catch { return }
            // Accept downloadwella + common alternate hosts Nkiri may use
            const hostOk = /downloadwella\.com|fsmc\.|dood\.(li|to|stream)|ds2play|d0000d|pixeldrain|gofile|mediafire|mega\.nz|drive\.google/i.test(href)
            if (!hostOk) return
            if (seenEp.has(href)) return
            seenEp.add(href)
            let text = String(textRaw || '').replace(/\s+/g, ' ').trim()
            if (!text || /download.*episode|click here|get link/i.test(text) || text.length < 3) {
              const urlMatch = href.match(/\/([^/]+)\.html?$/i) || href.match(/\/([^/?#]+)(?:\?|#|$)/i)
              text = urlMatch
                ? urlMatch[1].replace(/[-._+]/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
                : (pageTitle || 'Episode')
            }
            episodes.push({ url: href, title: text, poster: resolvedPoster })
          }

          // Strategy 1: explicit downloadwella anchors
          $page('a[href*="downloadwella.com"], a[href*="fsmc"]').each((_, el) => {
            addEp($page(el).attr('href'), $page(el).text() || $page(el).attr('title'))
          })

          // Strategy 2: download buttons / labeled links
          if (episodes.length === 0) {
            $page('a[href]').each((_, el) => {
              const href = $page(el).attr('href') || ''
              const text = ($page(el).text() || $page(el).attr('title') || '').trim()
              if (/downloadwella|fsmc|download\s*(episode|link|file|now)|480p|720p|1080p|mkv|mp4/i.test(`${href} ${text}`)) {
                addEp(href, text)
              }
            })
          }

          // Strategy 3: regex on full HTML (encoded entities, data attributes)
          if (episodes.length === 0) {
            const patterns = [
              /href=["'](https?:\/\/(?:www\.)?downloadwella\.com\/[^"']+)["']/gi,
              /href=["'](https?:\/\/[^"']*fsmc[^"']+)["']/gi,
              /["'](https?:\/\/(?:www\.)?downloadwella\.com\/[^"'\s]+)["']/gi,
            ]
            for (const dlRe of patterns) {
              let m
              while ((m = dlRe.exec(pageHtml)) !== null) {
                const href = m[1].replace(/&amp;/g, '&')
                const ctx = pageHtml.slice(Math.max(0, m.index - 200), Math.min(pageHtml.length, m.index + 500))
                const titleMatch = ctx.match(/title=["']([^"']+)["']/)
                  || ctx.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/i)
                  || ctx.match(/alt=["']([^"']+)["']/)
                addEp(href, titleMatch?.[1])
              }
            }
          }

          // Strategy 4: follow same-site "download" child pages (bounded, Hobby-safe)
          if (episodes.length === 0) {
            const childLinks = []
            $page('a[href]').each((_, el) => {
              const href = $page(el).attr('href') || ''
              let abs
              try { abs = new URL(href, url).href } catch { return }
              if (!/thenkiri\.com|nkiri\.com/i.test(abs)) return
              if (abs === url) return
              if (/download|episode|part|link/i.test(abs + ($page(el).text() || ''))) {
                childLinks.push(abs)
              }
            })
            for (const child of [...new Set(childLinks)].slice(0, 3)) {
              try {
                const childHtml = await fetchHtml(child)
                const $c = cheerio.load(childHtml)
                $c('a[href*="downloadwella.com"], a[href*="fsmc"]').each((_, el) => {
                  addEp($c(el).attr('href'), $c(el).text())
                })
                if (episodes.length > 0) break
              } catch {
                /* skip child */
              }
            }
          }

          // Prefer MP4-looking episode titles first (Chrome plays MP4; MKV needs remux)
          episodes.sort((a, b) => {
            const score = (t) => {
              let s = 0
              if (/\bmp4\b/i.test(t.title) || /\.mp4/i.test(t.url)) s += 10
              if (/\b1080p\b/i.test(t.title)) s += 3
              if (/\b720p\b/i.test(t.title)) s += 2
              if (/\bmkv\b/i.test(t.title) || /\.mkv/i.test(t.url)) s -= 5
              if (/\bhevc|x265|h\.?265\b/i.test(t.title)) s -= 8
              return s
            }
            return score(b) - score(a)
          })

          if (episodes.length > 0) {
            return ok(res, {
              results: episodes.map((ep) => ({
                title: formatMediaTitle(ep.title) || ep.title,
                url: ep.url,
                link: ep.url,
                thumbnail: ep.poster,
                image: ep.poster,
                source: /downloadwella|fsmc/i.test(ep.url) ? 'downloadwella' : 'nkiri',
                type: 'direct',
                isDirect: false,
                playableInRoom: false,
                requiresResolve: true,
                resolvedFrom: url,
                preferMp4: /\bmp4\b/i.test(ep.title) || /\.mp4/i.test(ep.url),
                codecHint: /\bhevc|x265|h\.?265\b/i.test(ep.title)
                  ? 'hevc'
                  : (/\bmkv\b/i.test(ep.title) || /\.mkv/i.test(ep.url) ? 'mkv' : null),
                meta: (/\bmkv\b/i.test(ep.title) || /\.mkv/i.test(ep.url))
                  ? 'MKV — Chrome cannot play MKV natively; we remux small files only on Hobby'
                  : undefined,
              })),
              count: episodes.length,
              directCount: 0,
              resolved: false,
              url,
              site: 'nkiri',
            })
          }

          return ok(res, {
            results: [{
              title: pageTitle || 'No episodes found',
              url,
              link: url,
              thumbnail: resolvedPoster,
              image: resolvedPoster,
              source: 'nkiri',
              type: 'direct',
              isDirect: false,
              playableInRoom: false,
              requiresResolve: false,
              meta: 'This page has no downloadable episodes. Layout may have changed or links are behind another host.',
            }],
            count: 1,
            directCount: 0,
            resolved: false,
            url,
            site: 'nkiri',
          })
        } catch (err) {
          console.error('Nkiri scrape failed:', err.message)
        }
      }

      // NSFW provider URL resolution (xvideos/pornhub/spankbang page → direct video URL)
      if (isNsfwProviderUrl(url)) {
        let resolveError = null
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
          resolveError = err.message
          console.error('NSFW provider resolve failed:', err.message)
        }
        // If resolution failed, try to pass the page URL through the proxy
        // as a last resort — some CDNs may accept the proxied page URL
        const providerName = target.hostname.includes('xvideos') ? 'xvideos' : target.hostname.includes('pornhub') ? 'pornhub' : 'spankbang'
        return ok(res, {
          results: [{
            title: decodeURIComponent(target.pathname.split('/').pop() || 'Video'),
            url,
            link: url,
            thumbnail: null,
            source: providerName,
            type: 'nsfw',
            isDirect: false,
            playableInRoom: false,
            requiresUserAction: true,
            meta: resolveError
              ? `Could not extract video URL: ${resolveError}. Try another result or open the page directly.`
              : 'Could not auto-extract video URL. Try another result or open the page to watch.',
          }],
          count: 1,
          directCount: 0,
          resolved: false,
          url,
          site: providerName,
          error: resolveError,
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
              const isMkv = /\.mkv(\?|#|$)/i.test(mediaUrl)
              const isMp4 = /\.mp4(\?|#|$)/i.test(mediaUrl)
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
                container: isMkv ? 'mkv' : (isMp4 ? 'mp4' : 'unknown'),
                meta: isMkv
                  ? 'MKV container — Chrome does not play MKV natively. Small files remux to fMP4 on the proxy; large files need an MP4 source or Safari/VLC.'
                  : undefined,
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
              expired: Boolean(resolved.expired),
              meta: resolved.error
                || (resolved.expired
                  ? 'Download token expired — go back to Nkiri, pick the episode again, and resolve a fresh link.'
                  : 'Provider download action could not be resolved automatically. Prefer an MP4 quality if available, or re-open Nkiri for a fresh link.'),
            }]
        // Prefer MP4 results first for Chrome playback
        results.sort((a, b) => {
          const score = (r) => (r.container === 'mp4' ? 2 : r.container === 'mkv' ? 0 : 1)
          return score(b) - score(a)
        })
        return ok(res, {
          results,
          count: results.length,
          directCount: resolved.directUrls.length,
          requiresUserAction: resolved.directUrls.length === 0,
          expired: Boolean(resolved.expired),
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
            // Always fetch max (50) so client-side pagination (15/page) works via Load More
            results = await searchYouTube(query, 50)
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
          results = page.results || []
          hasMore = page.hasMore
          // Direct results are already title-matched by searchO2Tv — skip the
          // second soft filter in deduplicateAndEnrich which can wipe short titles.
          const omdbEnriched = await enrichWithOMDbPosters(results, query)
          const deduped = deduplicateAndEnrich(omdbEnriched, null)
          return ok(res, {
            success: true,
            layer,
            query,
            count: deduped.length,
            hasMore: false,
            results: deduped,
            searchedSites: page.searchedSites || ['o2tv'],
            error: page.error,
          })
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
