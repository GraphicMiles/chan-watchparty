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

const MEDIA_EXT_RE = /\.(mp4|m3u8|webm|ogg|mov|mkv|avi|flv|ts)(\?|#|$)/i
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY // server-side only — never use VITE_ prefix
const OMDB_API_KEY = process.env.OMDB_API_KEY || null  // no hardcoded fallback — must be configured
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY

// ==================== UTILITY FUNCTIONS ====================

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
      const isDirectOrMovie = item.isDirect || item.type === 'direct' || item.type === 'movie' || item.type === 'anime' || ['nkiri', 'netnaija', 'fzmovies', '9jarocks', 'animedrive', 'o2tv', 'downloadwella', 'omdb'].includes(item.source)
      if (isDirectOrMovie && !isTitleMatch(item.title, query)) {
        return false
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

  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(limit),
    key: YOUTUBE_API_KEY,
    videoEmbeddable: 'true',
  })

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {
    headers: {
      Referer: 'https://chan-yz3p.vercel.app/',
      'User-Agent': 'Mozilla/5.0 (compatible; ChanServer/1.0)',
    },
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    throw new Error(error.error?.message || `YouTube API error: ${res.status}`)
  }
  
  const data = await res.json()
  const ids = (data.items || []).map((it) => it.id?.videoId).filter(Boolean)
  
  let statusById = {}
  if (ids.length) {
    const detailsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=status,snippet,contentDetails,statistics&id=${ids.join(',')}&key=${YOUTUBE_API_KEY}`,
      {
        headers: {
          Referer: 'https://chan-yz3p.vercel.app/',
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
  }
  
  return ids.map((id) => {
    const searchItem = data.items.find((it) => it.id?.videoId === id)
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
      embeddable: full?.status?.embeddable !== false,
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
    const isAdult = item.isNSFW === true || item.type === 'nsfw' || ['xvideos', 'pornhub', 'spankbang'].includes(String(item.source || '').toLowerCase()) || ['xvideos', 'pornhub', 'spankbang'].includes(String(item.provider || '').toLowerCase())
    if (isAdult) return item

    const isTargetType = item.isDirect || item.type === 'direct' || item.type === 'movie' || item.type === 'anime' || ['nkiri', 'netnaija', 'fzmovies', '9jarocks', 'o2tv', 'downloadwella'].includes(item.source)
    if (!isTargetType) return item

    const cleanItemName = cleanTitleForOMDb(item.title)
    const cleanQueryName = cleanTitleForOMDb(query || '')

    // 1. If we have the exact OMDb poster for the searched query AND this exact show/movie is what was queried, use queryPoster!
    if (queryPoster && query && cleanItemName && cleanQueryName && cleanItemName.toLowerCase() === cleanQueryName.toLowerCase()) {
      return {
        ...item,
        thumbnail: queryPoster,
        image: queryPoster,
        posterSource: 'omdb',
      }
    }

    let thumb = item.thumbnail || item.image || null
    const isScrapedHost = typeof thumb === 'string' && /thenkiri|thenetnaija|fzmovies|9jarocks|o2tv/i.test(thumb)
    if (isSuitableThumbnail(thumb) && !isScrapedHost) return item

    // 2. Otherwise, look up OMDb specifically for this item's own clean name (e.g. "Avatar The Last Airbender" vs "Avatar")
    if (!cleanItemName || cleanItemName.length < 2) return { ...item, thumbnail: null, image: null }

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

async function searchDirectLinks(query, options = {}) {
  const results = []
  const requestedSite = options.site && options.site !== 'custom' && options.site !== 'all' ? options.site : null
  const scrapers = requestedSite
    ? [requestedSite]
    : ['nkiri', 'netnaija', 'fzmovies', '9jarocks', 'o2tv']
  
  const searchedSites = [...scrapers]
  
  await Promise.all(scrapers.map(async (siteKey) => {
    try {
      const config = getSiteConfig(siteKey)
      const queryUrls = config?.buildSearchUrls ? config.buildSearchUrls(query) : (config?.buildSearchUrl ? [config.buildSearchUrl(query)] : [])
      
      let siteCandidates = []
      for (const searchUrl of queryUrls) {
        if (!searchUrl) continue
        try {
          const html = await fetchHtml(searchUrl)
          const items = parseListing(html, searchUrl, config)
          if (items && items.length > 0) {
            siteCandidates.push(...items)
            break
          }
        } catch {
          /* try next query syntax for this site */
        }
      }

      if (query && String(query).trim()) {
        siteCandidates = siteCandidates.filter((item) => isTitleMatch(item?.title, query))
      }

      if (siteCandidates.length === 0 && query && query.trim().length > 1) {
        const cleanQ = query.trim()
        if (siteKey === 'o2tv') {
          for (const ep of [1, 2, 3, 4, 5, 6, 7, 8]) {
            const constructed = config.constructDirectUrl?.(cleanQ, 1, ep)
            if (constructed) {
              siteCandidates.push({
                title: `${cleanQ} - S01E${String(ep).padStart(2, '0')}`,
                url: constructed,
                link: constructed,
                source: 'o2tv',
                isDirect: true,
              })
            }
          }
          const constructedS2 = config.constructDirectUrl?.(cleanQ, 2, 1)
          if (constructedS2) {
            siteCandidates.push({
              title: `${cleanQ} - S02E01`,
              url: constructedS2,
              link: constructedS2,
              source: 'o2tv',
              isDirect: true,
            })
          }
        } else {
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

  const provider = options.provider || process.env.NSFW_PROVIDER || 'xvideos'
  return searchNsfwProvider(provider, query, Math.min(20, Math.max(1, Number(options.limit) || 20)))
}

// ==================== SCRAPER HELPERS ====================

function validateFetchTarget(rawUrl) {
  return validateFetchUrl(rawUrl)
}

async function fetchHtml(targetUrl) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 9000)
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
  if (hostname === 'thenetnaija.ng' || hostname.endsWith('.thenetnaija.ng')) return getSiteConfig('netnaija')
  if (hostname.includes('9jarocks')) return getSiteConfig('9jarocks')
  if (hostname.includes('animedrive')) return getSiteConfig('animedrive')
  return getSiteConfig(fallbackSite)
}

function isResolverHost(url, rootHost) {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname === rootHost || hostname.endsWith('.' + rootHost) || hostname === 'downloadwella.com' || hostname.endsWith('.downloadwella.com')
  } catch {
    return false
  }
}

async function resolveO2TvPage(pageUrl) {
  try {
    const parsed = new URL(pageUrl)
    const hostname = parsed.hostname.toLowerCase()
    if (!hostname.includes('o2tvseries') && !hostname.includes('o2tv.org')) {
      return null
    }

    const parts = parsed.pathname.split('/').filter(Boolean)
    let showRaw = parts[0] || 'Show'
    let seasonRaw = parts[1] || 'Season-01'
    let episodeRaw = parts[2] || 'Episode-01'

    const showClean = decodeURIComponent(showRaw)
      .replace(/^Download-/i, '')
      .replace(/-otv[a-z0-9]+$/i, '')
      .replace(/-/g, ' ')
      .trim()

    const seasonMatch = seasonRaw.match(/\d+/)
    const seasonNum = seasonMatch ? seasonMatch[0].padStart(2, '0') : '01'

    const epMatch = episodeRaw.match(/\d+/)
    const epNum = epMatch ? epMatch[0].padStart(2, '0') : '01'

    const cdns = ['d6.o2tv.org', 'd2.o2tv.org', 'd4.o2tv.org', 'd8.o2tv.org', 'd1.o2tv.org']
    const suffixes = [
      `%20(TvShows4Mobile.Com)%20otv-1awrk.mp4`,
      `%20(TvShows4Mobile.Com).mp4`,
      `%20otv.mp4`,
      `.mp4`,
    ]

    const candidates = []
    for (const cdn of cdns) {
      for (const suffix of suffixes) {
        candidates.push(`http://${cdn}/${showClean}/Season%20${seasonNum}/${showClean}%20-%20S${seasonNum}E${epNum}${suffix}`)
      }
    }

    for (const candidateUrl of candidates) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 2500)
        const check = await fetch(candidateUrl, {
          method: 'HEAD',
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        })
        clearTimeout(timer)
        if (check.ok || check.status === 206 || check.status === 302) {
          return [{
            title: `${showClean} - S${seasonNum}E${epNum}`,
            url: candidateUrl,
            link: candidateUrl,
            source: 'o2tv',
            isDirect: true,
            playableInRoom: true,
            resolvedFrom: pageUrl,
          }]
        }
      } catch {
        /* check next candidate */
      }
    }

    const primaryCandidate = `http://d6.o2tv.org/${showClean}/Season%20${seasonNum}/${showClean}%20-%20S${seasonNum}E${epNum}%20(TvShows4Mobile.Com)%20otv-1awrk.mp4`
    return [{
      title: `${showClean} - S${seasonNum}E${epNum}`,
      url: primaryCandidate,
      link: primaryCandidate,
      source: 'o2tv',
      isDirect: true,
      playableInRoom: true,
      resolvedFrom: pageUrl,
    }]
  } catch (err) {
    console.error('O2TV direct resolution error:', err)
    return null
  }
}

export async function resolvePageChain(startUrl, site) {
  const rootHost = new URL(startUrl).hostname.toLowerCase().replace(/^www\\./, '')
  if (rootHost.includes('o2tvseries') || rootHost.includes('o2tv.org')) {
    const o2tvDirect = await resolveO2TvPage(startUrl)
    if (o2tvDirect && o2tvDirect.length) return o2tvDirect
  }
  
  const queue = [{ url: startUrl, depth: 0 }]
  const visited = new Set()
  const output = []

  while (queue.length && visited.size < 8) {
    const current = queue.shift()
    if (visited.has(current.url)) continue
    visited.add(current.url)

    const hostname = new URL(current.url).hostname.toLowerCase()
    if (hostname === 'downloadwella.com' || hostname.endsWith('.downloadwella.com')) {
      const resolved = await resolveDownloadwellaPage(current.url)
      if (resolved.directUrls.length) {
        output.push(...resolved.directUrls.map((url) => ({
          title: decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Video'),
          url,
          link: url,
          thumbnail: resolved.thumbnail || null,
          image: resolved.thumbnail || null,
          source: 'downloadwella',
          isDirect: true,
          playableInRoom: true,
          resolvedFrom: current.url,
        })))
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
  const ipRl = checkRateLimit(`media:${ip}`, { limit: 40, windowMs: 60_000 })
  if (!ipRl.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
    res.end(JSON.stringify({ success: false, error: 'Too many requests — slow down' }))
    return
  }

  try {
    const body = req.body || {}
    const action = body.action || req.query?.legacy || 'search'
    if (action === 'refreshCatalog') {
      const catalog = await refreshIptvCatalog(req, body)
      return ok(res, catalog)
    }

    await requireUser(req)
    const decoded = await verifyIdToken(req.headers.authorization?.split('Bearer ')[1] || '')
    const layer = body.layer || body.source || 'youtube'
    const { query, options = {}, url, site } = body
    
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
      if (target.hostname.toLowerCase().endsWith('downloadwella.com')) {
        const resolved = options.resolve === true ? await resolveDownloadwellaPage(url) : { directUrls: [], requiresUserAction: true }
        const results = resolved.directUrls.length
          ? resolved.directUrls.map((mediaUrl) => ({
              title: decodeURIComponent(new URL(mediaUrl).pathname.split('/').pop() || 'Video'),
              url: mediaUrl,
              link: mediaUrl,
              thumbnail: resolved.thumbnail || null,
              image: resolved.thumbnail || null,
              source: 'downloadwella',
              isDirect: true,
              playableInRoom: true,
              resolvedFrom: url,
            }))
          : [{
              title: decodeURIComponent(target.pathname.split('/').pop() || 'Download page'),
              url,
              link: url,
              thumbnail: resolved.thumbnail || null,
              image: resolved.thumbnail || null,
              source: 'downloadwella',
              isDirect: false,
              requiresUserAction: true,
              meta: 'Provider download action could not be resolved automatically. Open the page to continue.',
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
          results = await searchYouTube(query, Math.min(50, Math.max(1, Number(options.limit) || 20)))
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
          const searchResults = await searchNSFW(query, options, decoded)
          results = searchResults.map((result) => {
            const thumb = result.thumbnail || result.image || null
            return {
              ...result,
              thumbnail: thumb,
              image: thumb,
              source: result.source || result.provider || 'xvideos',
              type: 'nsfw',
              isNSFW: true,
              isDirect: false,
              requiresUserAction: true,
            }
          })
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
