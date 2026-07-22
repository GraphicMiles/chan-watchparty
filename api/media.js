/**
 * Media API — Clean rewrite
 *
 * 4 providers: YouTube, Direct (O2TV), IPTV, NSFW
 *
 * Actions: search, o2tvSeasons, o2tvEpisodes, o2tvResolve, probeIptv, refreshCatalog
 */

import * as cheerio from 'cheerio'
import { preflight, ok, fail, statusForError } from '../server-lib/http.js'
import { getDb, FieldValue, verifyIdToken } from '../server-lib/firebaseAdmin.js'
import { checkRateLimit, clientKey } from '../server-lib/rateLimit.js'
import { validateFetchUrl, isPrivateHost } from '../server-lib/ssrf.js'
import { sanitizeSearchQuery, sanitizeUrl, sanitizeAction } from '../server-lib/sanitize.js'
import { searchO2Tv, getO2TvSeasons, getO2TvEpisodes, resolveO2TvEpisode, probeAndFixO2TvUrl } from '../server-lib/o2tvResolver.js'
import { checkIptvChannel, getIptvChannels, getPlaylistChannels, probeIptvChannel } from '../server-lib/iptv.js'
import { searchNsfwProvider } from '../server-lib/nsfw.js'
import { resolveNsfwVideoUrl, isNsfwProviderUrl } from '../server-lib/nsfwResolver.js'

const ALLOWED_ACTIONS = [
  'search',
  'scrape',
  'o2tvSeasons',
  'o2tvEpisodes',
  'o2tvResolve',
  'probeIptv',
  'refreshCatalog',
]

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.VITE_YOUTUBE_API_KEY
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

// ─── Helpers ───

async function fetchPage(url, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

async function requireUser(req) {
  const auth = req.headers?.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) throw Object.assign(new Error('Missing token'), { status: 401 })
  return verifyIdToken(token)
}

function requireCronSecret(req) {
  const expected = process.env.CRON_SECRET
  if (!expected) throw Object.assign(new Error('CRON_SECRET not configured'), { status: 503 })
  const actual = req.headers?.['x-cron-secret'] || req.headers?.['X-Cron-Secret']
  if (actual !== expected) throw Object.assign(new Error('Unauthorized'), { status: 401 })
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

/** Wrap a media URL through /api/proxy for CORS + HTTPS */
function toProxiedUrl(mediaUrl, { referer } = {}) {
  if (!mediaUrl || typeof mediaUrl !== 'string') return mediaUrl
  if (mediaUrl.startsWith('/api/proxy')) return mediaUrl
  let clean = mediaUrl
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&#47;/g, '/')
  try {
    const parsed = new URL(clean)
    const isMkv = /\.mkv(\?|#|$)/i.test(parsed.pathname)
    let out = `/api/proxy?url=${encodeURIComponent(clean)}`
    if (isMkv) out += '&remux=1'
    if (referer && /^https?:\/\//i.test(referer)) out += `&referer=${encodeURIComponent(referer)}`
    return out
  } catch {
    return `/api/proxy?url=${encodeURIComponent(clean)}`
  }
}

// ═══════════════════════════════════════════════════════════════
// SEARCH PROVIDERS
// ═══════════════════════════════════════════════════════════════

// ─── YouTube ───
async function searchYouTube(query, limit = 20) {
  if (!YOUTUBE_API_KEY) throw new Error('YouTube API key not configured')

  const maxResults = Math.min(50, Math.max(1, Number(limit) || 20))
  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(maxResults),
    key: YOUTUBE_API_KEY,
    safeSearch: 'none',
  })

  const referer = process.env.YOUTUBE_API_REFERER
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/` : 'https://chan-yz3p.vercel.app/')

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {
    headers: { Referer: referer, 'User-Agent': 'ChanServer/1.0' },
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    throw new Error(error.error?.message || `YouTube API error: ${res.status}`)
  }

  const data = await res.json()
  const ids = (data.items || []).map(it => it.id?.videoId).filter(Boolean)
  if (!ids.length) return []

  return ids.map(id => {
    const item = (data.items || []).find(it => it.id?.videoId === id)
    const sn = item?.snippet || {}
    const thumb = sn.thumbnails?.high?.url || sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || null
    return {
      id,
      title: sn.title || 'Untitled',
      description: sn.description || '',
      thumbnail: thumb,
      image: thumb,
      channel: sn.channelTitle,
      url: `https://youtube.com/watch?v=${id}`,
      source: 'youtube',
      type: 'youtube',
      embeddable: true,
      isDirect: false,
    }
  })
}

// ─── Direct (O2TV) ───
async function searchDirect(query, options = {}) {
  const baseQ = String(query || '').trim()
  if (!baseQ) return { results: [], hasMore: false, searchedSites: ['o2tv'] }

  const limit = Math.min(40, Math.max(5, Number(options.limit) || 20))
  const searchTimeout = 8000

  let shows = []
  let searchError = null
  try {
    shows = await Promise.race([
      searchO2Tv(baseQ, limit),
      new Promise((_, reject) => setTimeout(() => reject(new Error('O2TV timed out')), searchTimeout)),
    ])
  } catch (err) {
    searchError = err.message
    shows = []
  }

  if (!Array.isArray(shows)) shows = []

  const results = shows.slice(0, limit).map(s => {
    const showName = String(s.showName || s.title || baseQ).trim() || baseQ
    const showSlug = String(s.showSlug || '').trim()
    const pageUrl = String(s.url || (showSlug ? `${BASE_URL}/${showSlug}/index.html` : '')).trim()
    const title = showName.length <= 80 ? showName : showName
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
      meta: s.guessed ? 'Direct match' : 'TV show — pick a season, then an episode',
      matchScore: s.matchScore || 0,
    }
  }).filter(r => r.url && r.showSlug)

  return {
    results,
    hasMore: false,
    searchedSites: ['o2tv'],
    multiLayerCascaded: false,
    error: results.length ? undefined : (searchError || undefined),
  }
}

const BASE_URL = 'https://tvshows4mobile.org'

// ─── O2TV Hierarchical ───
async function handleO2TvSeasons({ showSlug, showName, thumbnail }) {
  const slug = String(showSlug || '').trim()
  if (!slug) throw Object.assign(new Error('showSlug required'), { status: 400 })
  const seasons = await getO2TvSeasons(slug)
  const name = String(showName || '').trim() || slug.replace(/-otv[a-z0-9]+$/i, '').replace(/-/g, ' ').trim()
  return {
    results: seasons.map(season => ({
      title: `${name}: Season ${season.number}`,
      label: season.label,
      url: season.url,
      link: season.url,
      source: 'o2tv',
      type: 'direct',
      isDirect: false,
      playableInRoom: false,
      requiresResolve: true,
      o2tvKind: 'season',
      showSlug: slug,
      showName: name,
      seasonNum: season.number,
    })).filter(r => r.seasonNum > 0),
    count: seasons.length,
    showSlug: slug,
    showName: name,
    stage: 'seasons',
  }
}

async function handleO2TvEpisodes({ showSlug, showName, seasonNum, thumbnail }) {
  const slug = String(showSlug || '').trim()
  if (!slug) throw Object.assign(new Error('showSlug required'), { status: 400 })
  const season = Math.max(1, Number(seasonNum) || 1)
  const name = String(showName || '').trim() || slug.replace(/-otv[a-z0-9]+$/i, '').replace(/-/g, ' ').trim()
  const episodes = await getO2TvEpisodes(slug, season)
  const s = String(season).padStart(2, '0')
  return {
    results: episodes.map(ep => ({
      title: `${name} - S${s}E${String(ep.number).padStart(2, '0')}`,
      label: ep.title,
      url: ep.url,
      link: ep.url,
      source: 'o2tv',
      type: 'direct',
      isDirect: false,
      playableInRoom: false,
      requiresResolve: true,
      o2tvKind: 'episode',
      showSlug: slug,
      showName: name,
      seasonNum: season,
      episodeNum: ep.number,
    })).filter(r => r.episodeNum > 0),
    count: episodes.length,
    showSlug: slug,
    showName: name,
    seasonNum: season,
    stage: 'episodes',
  }
}

async function handleO2TvResolve({ showSlug, showName, seasonNum, episodeNum }) {
  const slug = String(showSlug || '').trim()
  if (!slug) throw Object.assign(new Error('showSlug required'), { status: 400 })
  const season = Math.max(1, Number(seasonNum) || 1)
  const ep = Math.max(1, Number(episodeNum) || 1)
  const name = String(showName || '').trim() || slug.replace(/-otv[a-z0-9]+$/i, '').replace(/-/g, ' ').trim()

  const resolved = await resolveO2TvEpisode(name, slug, season, ep)
  if (!resolved?.url) {
    throw Object.assign(
      new Error(`Could not resolve ${name} S${season}E${ep}. Try another episode.`),
      { status: 404 },
    )
  }

  let playUrl = resolved.url
  if (!playUrl.startsWith('/api/proxy') && /^https?:\/\//i.test(playUrl)) {
    playUrl = `/api/proxy?url=${encodeURIComponent(playUrl)}&referer=${encodeURIComponent('http://d6.o2tv.org/')}`
  }

  const s = String(season).padStart(2, '0')
  const e = String(ep).padStart(2, '0')
  const item = {
    title: resolved.title || `${name} - S${s}E${e}`,
    url: playUrl,
    link: playUrl,
    source: 'o2tv',
    type: 'direct',
    isDirect: true,
    playableInRoom: true,
    o2tvKind: 'direct',
    showSlug: slug,
    showName: name,
    seasonNum: season,
    episodeNum: ep,
    quality: resolved.quality || 'HD',
    videoType: 'direct',
  }

  return {
    results: [item],
    count: 1,
    directCount: 1,
    resolved: true,
    stage: 'resolved',
  }
}

// ─── IPTV ───
async function searchIPTV(query, userChannels = [], provider = '', limit = 100) {
  const channels = await getIptvChannels(userChannels, provider)
  const term = String(query || '').trim().toLowerCase()

  return channels
    .filter(channel => {
      if (!term) return true
      const searchable = `${channel.name} ${channel.group} ${channel.country}`.toLowerCase()
      return searchable.includes(term)
    })
    .slice(0, Math.max(1, Number(limit) || 100))
    .map(channel => {
      let playUrl = channel.url
      try {
        if (channel.url && !String(channel.url).startsWith('/api/proxy')) {
          playUrl = toProxiedUrl(channel.url)
        }
      } catch { playUrl = channel.url }
      return {
        id: `iptv-${channel.name.replace(/\s+/g, '-').toLowerCase()}`,
        title: channel.name,
        description: channel.group,
        thumbnail: channel.logo || null,
        image: channel.logo || null,
        url: playUrl,
        link: playUrl,
        rawUrl: channel.url,
        channel: channel.name,
        group: channel.group,
        country: channel.country,
        provider: channel.provider,
        source: 'iptv',
        type: 'iptv',
        isDirect: true,
        isLive: true,
        videoType: 'iptv',
        healthy: channel.healthy !== false,
        program: { now: 'Live Broadcast', next: null },
      }
    })
}

// ─── Sports ───
async function searchSports(query) {
  if (!FOOTBALL_DATA_KEY) throw Object.assign(new Error('Sports not configured'), { status: 503 })
  const res = await fetch('https://api.football-data.org/v4/matches?status=SCHEDULED,LIVE', {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY },
  })
  if (!res.ok) throw Object.assign(new Error(`Sports API error: ${res.status}`), { status: 502 })
  const data = await res.json()
  const term = String(query || '').toLowerCase()

  return (data.matches || [])
    .filter(match => {
      const home = match.homeTeam?.name?.toLowerCase() || ''
      const away = match.awayTeam?.name?.toLowerCase() || ''
      const comp = match.competition?.name?.toLowerCase() || ''
      return home.includes(term) || away.includes(term) || comp.includes(term)
    })
    .map(match => ({
      id: `match-${match.id}`,
      title: `${match.homeTeam.name} vs ${match.awayTeam.name}`,
      description: `${match.competition.name}`,
      thumbnail: match.competition.emblem || null,
      image: match.competition.emblem || null,
      url: null,
      matchInfo: {
        teams: `${match.homeTeam.name} vs ${match.awayTeam.name}`,
        time: match.utcDate,
        competition: match.competition.name,
        status: match.status,
      },
      source: 'sports',
      type: 'sports',
      isDirect: false,
      isLive: match.status === 'IN_PLAY' || match.status === 'LIVE',
    }))
}

// ─── NSFW ───
async function searchNSFW(query, options = {}, user = null) {
  if (process.env.NSFW_ENABLED !== 'true') {
    throw Object.assign(new Error('NSFW not enabled'), { status: 403 })
  }
  if (!user) throw Object.assign(new Error('Sign in required'), { status: 401 })
  if (!options.adultVerified) {
    throw Object.assign(new Error('Age verification required'), { status: 403 })
  }

  const provider = options.provider || 'all'
  const maxLimit = Math.min(100, Math.max(1, Number(options.limit) || 25))
  const offset = Math.max(0, Number(options.offset) || 0)
  const allResults = await searchNsfwProvider(provider, query, maxLimit + offset)

  const paginated = allResults.slice(offset, offset + maxLimit)
  const nextHasMore = offset + maxLimit < allResults.length

  return {
    results: paginated.map(result => ({
      ...result,
      source: result.source || result.provider || 'nsfw',
      type: 'nsfw',
      isNSFW: true,
      isDirect: false,
      requiresUserAction: true,
      playableInRoom: false,
    })),
    hasMore: nextHasMore,
  }
}

// ─── IPTV Catalog Refresh ───
async function refreshIptvCatalog(req, body) {
  requireCronSecret(req)
  const offset = Math.max(0, Number(body.offset) || 0)
  const limit = Math.min(100, Math.max(1, Number(body.limit) || 50))
  const channels = await getPlaylistChannels({ force: true })
  const batchChannels = channels.slice(offset, offset + limit)
  if (!batchChannels.length) {
    return { action: 'iptv', total: channels.length, offset, checked: 0, healthy: 0, nextOffset: null, complete: true }
  }

  const checks = await mapConcurrent(batchChannels, 8, channel => checkIptvChannel(channel.url))
  const db = getDb()
  const batch = db.batch()
  const collection = db.collection('mediaCatalog').doc('iptv').collection('channels')
  const checkedAt = FieldValue.serverTimestamp()

  batchChannels.forEach((channel, index) => {
    const health = checks[index]
    const { createHash } = require('node:crypto')
    const id = createHash('sha1').update(channel.url).digest('hex')
    batch.set(collection.doc(id), {
      ...channel,
      source: channel.provider || 'iptv-playlist',
      playlistUrl: channel.playlistUrl || process.env.IPTV_PLAYLIST_URL || '',
      healthy: health.healthy,
      healthStatus: health.status,
      contentType: health.contentType,
      healthError: health.error,
      checkedAt,
    }, { merge: true })
  })
  await batch.commit()

  const healthy = checks.filter(c => c.healthy).length
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

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed')

  // Rate limiting
  const ip = clientKey(req)
  const rl = await checkRateLimit(`media:${ip}`, { limit: 40, windowMs: 60_000 })
  if (!rl.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
    return res.end(JSON.stringify({ success: false, error: 'Too many requests' }))
  }

  try {
    const body = req.body || {}
    const rawAction = body.action || 'search'
    const action = sanitizeAction(rawAction, ALLOWED_ACTIONS) || 'search'

    let query = body.query || ''
    let options = body.options || {}

    if (action === 'search' && query) {
      query = sanitizeSearchQuery(query) || query
    }

    // ─── Catalog refresh (cron) ───
    if (action === 'refreshCatalog') {
      return ok(res, await refreshIptvCatalog(req, body))
    }

    // ─── IPTV probe ───
    if (action === 'probeIptv') {
      const probeUrl = body.url
      if (!probeUrl) return fail(res, 400, 'URL required')
      return ok(res, { ...(await probeIptvChannel(probeUrl)), url: probeUrl })
    }

    // ─── O2TV hierarchical actions ───
    if (action === 'o2tvSeasons') {
      return ok(res, await handleO2TvSeasons({
        showSlug: body.showSlug || options.showSlug,
        showName: body.showName || options.showName,
        thumbnail: body.thumbnail || options.thumbnail,
      }))
    }
    if (action === 'o2tvEpisodes') {
      return ok(res, await handleO2TvEpisodes({
        showSlug: body.showSlug || options.showSlug,
        showName: body.showName || options.showName,
        seasonNum: body.seasonNum ?? options.seasonNum,
        thumbnail: body.thumbnail || options.thumbnail,
      }))
    }
    if (action === 'o2tvResolve') {
      return ok(res, await handleO2TvResolve({
        showSlug: body.showSlug || options.showSlug,
        showName: body.showName || options.showName,
        seasonNum: body.seasonNum ?? options.seasonNum,
        episodeNum: body.episodeNum ?? options.episodeNum,
        thumbnail: body.thumbnail || options.thumbnail,
      }))
    }

    // ─── Scrape (resolve a URL to a playable video) ───
    if (action === 'scrape') {
      const scrapeUrl = body.url || ''
      if (!scrapeUrl) return fail(res, 400, 'URL required')
      const scrapeSite = body.site || ''
      const scrapeOptions = body.options || {}

      // Direct video URL
      if (/\.(mp4|m3u8|webm|mkv|avi|mov|flv|ts)(\?|#|$)/i.test(scrapeUrl)) {
        const proxied = toProxiedUrl(scrapeUrl)
        let title = 'Video'
        try { title = decodeURIComponent(new URL(scrapeUrl).pathname.split('/').pop() || 'Video') } catch {}
        return ok(res, {
          results: [{
            title: title.replace(/\.(mp4|m3u8|webm|mkv|avi|mov|flv|ts)$/i, ''),
            url: proxied,
            link: proxied,
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

      // O2TV / tvshows4mobile URL
      if (/tvshows4mobile|o2tvseries|o2tv\.org/i.test(scrapeUrl)) {
        try {
          // Try to parse as an episode URL
          const urlParts = scrapeUrl.split('/')
          const seasonMatch = urlParts.find(p => /Season-\d+/i.test(p))
          const episodeMatch = urlParts.find(p => /Episode-\d+/i.test(p))

          if (seasonMatch && episodeMatch) {
            // It's an episode page — resolve it
            const seasonNum = parseInt(seasonMatch.match(/(\d+)/)[1], 10)
            const epNum = parseInt(episodeMatch.match(/(\d+)/)[1], 10)
            const slugIdx = urlParts.findIndex(p => /tvshows4mobile|o2tvseries/i.test(p))
            const showSlug = urlParts[slugIdx + 1] || ''

            const resolved = await resolveO2TvEpisode(showSlug, showSlug, seasonNum, epNum)
            if (resolved?.url) {
              return ok(res, {
                results: [{ ...resolved, source: 'o2tv', type: 'direct' }],
                count: 1,
                directCount: 1,
                resolved: true,
              })
            }
          }

          // If not a specific episode, try to scrape the page for download links
          const html = await fetchPage(scrapeUrl)
          const downloadIds = []
          const idRegex = /\/download\/(\d+)/g
          let m
          while ((m = idRegex.exec(html)) !== null) {
            if (!downloadIds.includes(m[1])) downloadIds.push(m[1])
          }

          if (downloadIds.length > 0) {
            try {
              const { resolveViaCaptcha } = await import('../server-lib/o2tvCaptcha.js')
              const cdnUrl = await resolveViaCaptcha(scrapeUrl)
              if (cdnUrl) {
                const proxied = toProxiedUrl(cdnUrl, { referer: 'http://d6.o2tv.org/' })
                return ok(res, {
                  results: [{
                    title: 'Video',
                    url: proxied,
                    link: proxied,
                    isDirect: true,
                    playableInRoom: true,
                    source: 'o2tv',
                    type: 'direct',
                  }],
                  count: 1,
                  directCount: 1,
                  resolved: true,
                })
              }
            } catch (err) {
              console.error('Scrape captcha resolve failed:', err.message)
            }
          }

          return ok(res, { results: [], count: 0, directCount: 0, resolved: false, error: 'Could not resolve video from this page' })
        } catch (err) {
          console.error('Scrape O2TV failed:', err.message)
          return fail(res, 500, err.message)
        }
      }

      // NSFW provider URL
      if (isNsfwProviderUrl(scrapeUrl)) {
        try {
          const resolved = await resolveNsfwVideoUrl(scrapeUrl)
          if (resolved?.videoUrl) {
            const referer = resolved.referer || scrapeUrl
            const proxied = toProxiedUrl(resolved.videoUrl, { referer })
            return ok(res, {
              results: [{
                title: 'Video',
                url: proxied,
                link: proxied,
                isDirect: true,
                playableInRoom: true,
                source: resolved.source || 'nsfw',
                type: 'nsfw',
                quality: resolved.quality,
              }],
              count: 1,
              directCount: 1,
              resolved: true,
            })
          }
        } catch (err) {
          console.error('Scrape NSFW failed:', err.message)
        }
        return ok(res, { results: [], count: 0, directCount: 0, resolved: false })
      }

      // Unknown URL — try to extract any video links from the page
      try {
        const html = await fetchPage(scrapeUrl)
        const videoUrls = []
        const videoRegex = /https?:\/\/[^"'\s<>]+\.(mp4|m3u8|webm|mkv)[^"'\s<>]*/gi
        let vm
        while ((vm = videoRegex.exec(html)) !== null) {
          const url = vm[0].replace(/&amp;/g, '&')
          if (!videoUrls.includes(url)) videoUrls.push(url)
        }

        if (videoUrls.length > 0) {
          return ok(res, {
            results: videoUrls.map(url => {
              const proxied = toProxiedUrl(url)
              let title = 'Video'
              try { title = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Video') } catch {}
              return {
                title: title.replace(/\.(mp4|m3u8|webm|mkv)$/i, ''),
                url: proxied,
                link: proxied,
                isDirect: true,
                playableInRoom: true,
                source: scrapeSite || 'direct',
                type: 'direct',
              }
            }),
            count: videoUrls.length,
            directCount: videoUrls.length,
            resolved: true,
          })
        }
      } catch { /* */ }

      return ok(res, { results: [], count: 0, directCount: 0, resolved: false })
    }

    // ─── Search (all other actions) ───
    if (action === 'search') {
      if (!query) return fail(res, 400, 'Query required')

      const layer = body.layer || body.source || 'all'
      let results = []

      switch (layer) {
        case 'all': {
          const [ytRes, directRes, iptvRes] = await Promise.all([
            searchYouTube(query, 6).catch(() => []),
            searchDirect(query, { ...options, limit: 14 }).catch(() => ({ results: [] })),
            searchIPTV(query, options.userChannels || [], options.provider || '', 6).catch(() => []),
          ])
          results = [...(directRes.results || []), ...ytRes, ...iptvRes]
          break
        }
        case 'youtube':
          results = await searchYouTube(query, 50)
          break
        case 'direct': {
          const page = await searchDirect(query, options)
          return ok(res, {
            success: true,
            layer,
            query,
            count: page.results.length,
            hasMore: false,
            results: page.results,
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
          const decoded = await requireUser(req)
          const nsfwResult = await searchNSFW(query, options, decoded)
          return ok(res, { success: true, layer: 'nsfw', query, ...nsfwResult })
        }
        default:
          return fail(res, 400, `Unknown layer: ${layer}`)
      }

      return ok(res, { success: true, layer, query, count: results.length, hasMore: false, results })
    }

    return fail(res, 400, `Unknown action: ${action}`)
  } catch (err) {
    console.error('Media API error:', err)
    const safeMessage = statusForError(err) >= 500 ? 'Internal server error' : (err.message || 'Request failed')
    return fail(res, statusForError(err), safeMessage)
  }
}
