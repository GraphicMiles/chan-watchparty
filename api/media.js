import * as cheerio from 'cheerio'
import { createHash } from 'node:crypto'
import { preflight, ok, fail, statusForError } from './lib/http.js'
import { getDb, FieldValue, verifyIdToken } from './lib/firebaseAdmin.js'
import { getSiteConfig, resolveUrl } from './lib/sources.js'
import { checkIptvChannel, getIptvChannels, getPlaylistChannels } from './lib/iptv.js'
import { resolveDownloadwellaPage } from './lib/downloadwella.js'
import { searchNsfwProvider } from './lib/nsfw.js'

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
      const candidates = options.resolve
        ? siteResults.slice(0, Math.min(6, Math.max(1, Number(options.resolveLimit) || 4)))
        : siteResults

      const enriched = await Promise.all(candidates.map(async (result) => {
        if (options.resolve && !result.isDirect) {
          const resolved = await resolvePageChain(result.url, siteKey)
          if (resolved.length) {
            return resolved.map((item) => ({
              ...item,
              title: item.title || result.title,
              source: item.source || siteKey,
              type: 'direct',
              quality: extractQuality(item.title || result.title),
            }))
          }
        }

        return [{
          ...result,
          source: siteKey,
          type: 'direct',
          // A listing/page URL is not playable. Preserve the parser's
          // classification instead of claiming every result is a direct file.
          isDirect: result.isDirect === true,
          playableInRoom: result.isDirect === true,
          quality: extractQuality(result.title),
        }]
      }))
      results.push(...enriched.flat())
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

async function searchIPTV(query, userChannels = [], provider = '') {
  const channels = await getIptvChannels(userChannels, provider)
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
        return {
          id: `match-${match.id}`,
          title: `${match.homeTeam.name} vs ${match.awayTeam.name}`,
          description: `${match.competition.name} - ${time}`,
          thumbnail: match.competition.emblem,
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

async function searchNSFW(query, options = {}) {
  if (process.env.NSFW_ENABLED !== 'true') {
    throw Object.assign(new Error('NSFW search is not enabled'), { status: 503 })
  }
  if (!options.adultVerified) {
    throw Object.assign(new Error('Age verification required. You must be 18+ to search this content.'), { status: 403 })
  }

  const provider = options.provider || process.env.NSFW_PROVIDER || 'xvideos'
  return searchNsfwProvider(provider, query, Math.min(20, Math.max(1, Number(options.limit) || 20)))
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

function extractDirectMedia(html, baseUrl, source) {
  const $ = cheerio.load(html)
  const results = []
  const seen = new Set()
  const pageTitle = $('meta[property="og:title"]').attr('content') || $('title').text().trim() || 'Video'

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
      image: $('meta[property="og:image"]').attr('content') || null,
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

export async function resolvePageChain(startUrl, site) {
  const rootHost = new URL(startUrl).hostname.toLowerCase().replace(/^www\\./, '')
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
  
  $(config.items).each((_, el) => {
    const $el = $(el)
    const title =
      $el.find(config.title).first().text().trim() ||
      $el.attr('title') ||
      ($el.is('a') ? $el.text().trim() : '') ||
      $el.find('img').first().attr('alt') ||
      'Untitled'
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

  try {
    const body = req.body || {}
    const action = body.action || req.query?.legacy || 'search'
    if (action === 'refreshCatalog') {
      const catalog = await refreshIptvCatalog(req, body)
      return ok(res, catalog)
    }

    await requireUser(req)
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
              source: 'downloadwella',
              isDirect: true,
              playableInRoom: true,
              resolvedFrom: url,
            }))
          : [{
              title: decodeURIComponent(target.pathname.split('/').pop() || 'Download page'),
              url,
              link: url,
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
        const results = await resolvePageChain(url, site || 'custom')
        return ok(res, {
          results,
          count: results.length,
          directCount: results.filter((item) => item.isDirect).length,
          resolved: true,
          url,
          site: site || 'custom',
        })
      }

      // Single-page scrape fallback.
      const html = await fetchHtml(url)
      const config = getSiteConfig(site) || getSiteConfig('custom')
      const directResults = extractDirectMedia(html, url, site || 'custom')
      const pageResults = parseListing(html, url, config)
      const merged = [...directResults, ...pageResults]
      const results = [...new Map(merged.filter((item) => item.url).map((item) => [item.url, item])).values()]
      
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
          const searchResults = await searchNSFW(query, options)
          if (options.resolve) {
            const provider = options.provider || process.env.NSFW_PROVIDER || 'xvideos'
            const resolved = await Promise.all(searchResults.slice(0, 6).map(async (result) => {
              const pageResults = await resolvePageChain(result.url, provider)
              return pageResults.length ? pageResults : [result]
            }))
            results = resolved.flat().map((result) => ({
              ...result,
              source: result.source || 'xvideos',
              type: 'nsfw',
              isNSFW: true,
            }))
          } else {
            results = searchResults
          }
          break
        }
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
