import * as cheerio from 'cheerio'
import { preflight, ok, fail, statusForError } from './lib/http.js'
import { verifyIdToken } from './lib/firebaseAdmin.js'
import { getSiteConfig, resolveUrl } from './lib/sources.js'
import { getIptvChannels } from './lib/iptv.js'

const MEDIA_EXT_RE = /\.(mp4|m3u8|webm|ogg|mov|mkv|avi|flv|ts)(\?|#|$)/i
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.VITE_YOUTUBE_API_KEY
const OMDB_API_KEY = process.env.OMDB_API_KEY
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

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`)
  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    throw new Error(error.error?.message || `YouTube API error: ${res.status}`)
  }
  
  const data = await res.json()
  const ids = (data.items || []).map((it) => it.id?.videoId).filter(Boolean)
  
  let statusById = {}
  if (ids.length) {
    const detailsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=status,snippet,contentDetails,statistics&id=${ids.join(',')}&key=${YOUTUBE_API_KEY}`
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
    
    return {
      id,
      title: sn.title || 'Untitled',
      description: sn.description || '',
      thumbnail: sn.thumbnails?.high?.url || sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url,
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
  if (!OMDB_API_KEY) {
    throw new Error('OMDb API key not configured')
  }
  
  const url = `https://www.omdbapi.com/?apikey=${OMDB_API_KEY}&s=${encodeURIComponent(query)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`OMDb error: ${res.status}`)
  
  const data = await res.json()
  if (data.Response === 'False') {
    return []
  }
  
  return (data.Search || []).map((it) => ({
    id: it.imdbID,
    title: it.Title,
    description: `${it.Type} • ${it.Year}`,
    thumbnail: it.Poster !== 'N/A' ? it.Poster : null,
    url: `https://www.imdb.com/title/${it.imdbID}`,
    year: it.Year,
    source: 'omdb',
    type: 'movie',
    isDirect: false,
  }))
}

async function searchDirectLinks(query, options = {}) {
  const results = []
  const requestedSite = options.site && options.site !== 'custom' ? options.site : null
  const scrapers = requestedSite
    ? [requestedSite]
    : ['nkiri', 'netnaija', 'fzmovies', 'o2tv']
  
  await Promise.all(scrapers.map(async (siteKey) => {
    try {
      const config = getSiteConfig(siteKey)
      if (!config?.buildSearchUrl) return
      
      const searchUrl = config.buildSearchUrl(query)
      const html = await fetchHtml(searchUrl)
      const siteResults = parseListing(html, searchUrl, config)
      
      results.push(...siteResults.map(r => ({
        ...r,
        source: siteKey,
        type: 'direct',
        // A listing/page URL is not playable. Preserve the parser's
        // classification instead of claiming every result is a direct file.
        isDirect: r.isDirect === true,
        playableInRoom: r.isDirect === true,
        quality: extractQuality(r.title),
      })))
    } catch (err) {
      console.error(`${siteKey} search failed:`, err.message)
    }
  }))
  
  const offset = Math.max(0, Number(options.offset) || 0)
  const limit = Math.min(50, Math.max(1, Number(options.limit) || 30))
  return {
    results: results.slice(offset, offset + limit),
    hasMore: offset + limit < results.length,
  }
}

async function searchIPTV(query, userChannels = []) {
  const channels = await getIptvChannels(userChannels)
  const term = query.toLowerCase()

  return channels
    .filter((channel) => {
      const searchable = `${channel.name} ${channel.group} ${channel.country}`.toLowerCase()
      return searchable.includes(term)
    })
    .slice(0, 20)
    .map((channel) => ({
      id: `iptv-${channel.name.replace(/\s+/g, '-').toLowerCase()}`,
      title: channel.name,
      description: channel.group,
      thumbnail: channel.logo,
      url: channel.url,
      channel: channel.name,
      group: channel.group,
      country: channel.country,
      source: 'iptv',
      type: 'iptv',
      isDirect: true,
      isLive: true,
      program: { now: 'Live Broadcast', next: null },
    }))
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
    
    if (!res.ok) throw new Error('Sports API error')
    
    const data = await res.json()
    
    return (data.matches || [])
      .filter(m => 
        m.homeTeam.name.toLowerCase().includes(query.toLowerCase()) ||
        m.awayTeam.name.toLowerCase().includes(query.toLowerCase()) ||
        m.competition.name.toLowerCase().includes(query.toLowerCase())
      )
      .map(m => ({
        id: `match-${m.id}`,
        title: `${m.homeTeam.name} vs ${m.awayTeam.name}`,
        description: `${m.competition.name} - ${formatMatchTime(m.utcDate)}`,
        thumbnail: m.competition.emblem,
        url: null,
        matchInfo: {
          teams: `${m.homeTeam.name} vs ${m.awayTeam.name}`,
          time: formatMatchTime(m.utcDate),
          competition: m.competition.name,
          status: m.status,
          homeTeam: m.homeTeam.name,
          awayTeam: m.awayTeam.name,
        },
        channel: guessChannel(m.competition.name),
        source: 'sports',
        type: 'sports',
        isLive: m.status === 'IN_PLAY' || m.status === 'LIVE',
        isUpcoming: m.status === 'SCHEDULED',
        channelAvailable: false, // Will be matched to IPTV
      }))
  } catch (err) {
    console.error('Sports API error:', err)
    return getDemoSportsData(query)
  }
}

function getDemoSportsData(query) {
  const matches = [
    { home: 'Arsenal', away: 'Liverpool', comp: 'Premier League', time: 'Today 15:00', status: 'SCHEDULED' },
    { home: 'Real Madrid', away: 'Barcelona', comp: 'La Liga', time: 'Tomorrow 20:00', status: 'SCHEDULED' },
    { home: 'Chelsea', away: 'Manchester City', comp: 'Premier League', time: 'Saturday 12:30', status: 'SCHEDULED' },
    { home: 'Bayern Munich', away: 'Dortmund', comp: 'Bundesliga', time: 'LIVE NOW', status: 'LIVE' },
  ]
  
  return matches
    .filter(m => 
      m.home.toLowerCase().includes(query.toLowerCase()) ||
      m.away.toLowerCase().includes(query.toLowerCase()) ||
      m.comp.toLowerCase().includes(query.toLowerCase()) ||
      query.toLowerCase().includes('premier') ||
      query.toLowerCase().includes('liga') ||
      query.toLowerCase().includes('bundesliga')
    )
    .map((m, i) => ({
      id: `demo-${i}`,
      title: `${m.home} vs ${m.away}`,
      description: `${m.comp} - ${m.time}`,
      thumbnail: null,
      url: null,
      matchInfo: {
        teams: `${m.home} vs ${m.away}`,
        time: m.time,
        competition: m.comp,
        status: m.status,
      },
      channel: guessChannel(m.comp),
      source: 'sports',
      type: 'sports',
      isLive: m.status === 'LIVE' || m.time === 'LIVE NOW',
      isUpcoming: m.status === 'SCHEDULED',
      channelAvailable: false,
    }))
}

function guessChannel(competition) {
  const channels = {
    'Premier League': 'Sky Sports / NBC / Peacock',
    'Champions League': 'CBS / TNT Sports',
    'La Liga': 'ESPN+',
    'Bundesliga': 'ESPN+',
    'Serie A': 'Paramount+',
    'Ligue 1': 'beIN Sports',
  }
  return channels[competition] || 'Sports Channel'
}

async function searchNSFW(query, options = {}) {
  if (!options.adultVerified) {
    throw new Error('Age verification required. You must be 18+ to search this content.')
  }
  
  throw Object.assign(new Error('NSFW search is not configured'), { status: 501 })
}

// ==================== SCRAPER HELPERS ====================

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [a, b] = parts
  return a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
}

function validateFetchTarget(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http(s) URLs are allowed')
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed')
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === '::1' ||
    isPrivateIpv4(hostname)
  ) {
    throw new Error('Private and local network URLs are not allowed')
  }

  return parsed
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

function parseListing(html, baseUrl, config) {
  const $ = cheerio.load(html)
  const results = []
  const seen = new Set()
  
  $(config.items).each((_, el) => {
    const $el = $(el)
    const title = $el.find(config.title).first().text().trim() || 'Untitled'
    const rawImg = $el.find(config.image).first().attr('src') || $el.find(config.image).first().attr('data-src')
    const img = resolveUrl(rawImg, baseUrl)
    const rawLink = $el.find(config.link).first().attr('href') || $el.closest('a').attr('href')
    const link = resolveUrl(rawLink, baseUrl)
    const meta = $el.find(config.meta).first().text().trim() || null
    
    if (title && link && !seen.has(link)) {
      seen.add(link)
      results.push({
        title: title.slice(0, 200),
        image: img,
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

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed')

  try {
    await requireUser(req)
    const { action = 'search', layer = 'youtube', query, options = {}, url, site } = req.body || {}
    
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
      
      // Scrape HTML page
      const html = await fetchHtml(url)
      const config = getSiteConfig(site) || getSiteConfig('custom')
      const results = parseListing(html, url, config)
      
      return ok(res, { 
        results, 
        count: results.length,
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
          results = await searchIPTV(query, options.userChannels || [])
          break
        case 'sports':
          results = await searchSports(query)
          break
        case 'nsfw':
          results = await searchNSFW(query, options)
          break
        default:
          return fail(res, 400, `Unknown layer: ${layer}`)
      }
      
      return ok(res, {
        success: true,
        layer,
        query,
        count: results.length,
        hasMore,
        results,
      })
    }
    
    return fail(res, 400, `Unknown action: ${action}`)
  } catch (err) {
    console.error('Media API error:', err)
    return fail(res, statusForError(err), err.message || 'Request failed')
  }
}
