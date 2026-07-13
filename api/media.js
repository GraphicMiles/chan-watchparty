import * as cheerio from 'cheerio'
import { preflight, ok, fail } from './lib/http.js'
import { getSiteConfig, resolveUrl } from './lib/sources.js'

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
  const scrapers = ['nkiri', 'netnaija', 'fzmovies', 'o2tv']
  
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
        isDirect: true,
        quality: extractQuality(r.title),
      })))
    } catch (err) {
      console.error(`${siteKey} search failed:`, err.message)
    }
  }))
  
  return results.slice(0, options.limit || 30)
}

async function searchIPTV(query, userChannels = []) {
  // Legal free public channels
  const publicChannels = [
    { name: 'Pluto TV Movies', url: 'https://service-stitcher.clusters.pluto.tv/v1/stitch/embed/hls/channel/5a667c2c8e85f57e0c13e8fc/master.m3u8', group: 'Movies', logo: 'https://pluto.tv/assets/images/pluto-logo.png' },
    { name: 'Pluto TV Action', url: 'https://service-stitcher.clusters.pluto.tv/v1/stitch/embed/hls/channel/5a667c2c8e85f57e0c13e8fc/master.m3u8', group: 'Action', logo: 'https://pluto.tv/assets/images/pluto-logo.png' },
    { name: 'Pluto TV Sports', url: 'https://service-stitcher.clusters.pluto.tv/v1/stitch/embed/hls/channel/5a667c2c8e85f57e0c13e8fc/master.m3u8', group: 'Sports', logo: 'https://pluto.tv/assets/images/pluto-logo.png' },
    { name: 'Stirr Action', url: 'https://dai.google.com/linear/hls/pa/event/...', group: 'Action', logo: null },
    { name: 'Stirr Sports', url: 'https://dai.google.com/linear/hls/pa/event/...', group: 'Sports', logo: null },
  ]
  
  const allChannels = [...publicChannels, ...userChannels]
  
  return allChannels
    .filter(ch => 
      ch.name.toLowerCase().includes(query.toLowerCase()) ||
      ch.group?.toLowerCase().includes(query.toLowerCase())
    )
    .slice(0, 20)
    .map(ch => ({
      id: `iptv-${ch.name.replace(/\s+/g, '-').toLowerCase()}`,
      title: ch.name,
      description: ch.group || 'Live TV',
      thumbnail: ch.logo,
      url: ch.url,
      channel: ch.name,
      group: ch.group,
      source: 'iptv',
      type: 'iptv',
      isDirect: true,
      isLive: true,
      program: {
        now: 'Live Broadcast',
        next: 'Upcoming Program',
      },
    }))
}

async function searchSports(query) {
  if (!FOOTBALL_DATA_KEY) {
    return getDemoSportsData(query)
  }
  
  try {
    const res = await fetch(
      `https://api.football-data.org/v4/matches?status=SCHEDULED,LIVE&matchday=1`,
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
  
  // Return empty array - implement actual scrapers as needed
  return []
}

// ==================== SCRAPER HELPERS ====================

async function fetchHtml(targetUrl) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  
  try {
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': new URL(targetUrl).origin,
      },
    })
    
    clearTimeout(timeout)
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } catch (e) {
    clearTimeout(timeout)
    throw e
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

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed')

  try {
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
      
      switch (layer) {
        case 'youtube':
          results = await searchYouTube(query, options.limit)
          break
        case 'omdb':
        case 'movies':
          results = await searchOMDb(query)
          break
        case 'direct':
          results = await searchDirectLinks(query, options)
          break
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
        results,
      })
    }
    
    return fail(res, 400, `Unknown action: ${action}`)
  } catch (err) {
    console.error('Media API error:', err)
    return fail(res, 500, err.message || 'Request failed')
  }
}
