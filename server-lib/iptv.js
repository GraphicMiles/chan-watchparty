import { getDb } from './firebaseAdmin.js'

const DEFAULT_PLAYLIST_URL = 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8'
const CACHE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000
const HEALTH_TIMEOUT_MS = 4000

let playlistCache = { expiresAt: 0, channels: [] }

function readAttribute(line, name) {
  const match = line.match(new RegExp(`${name}="([^"]*)"`, 'i'))
  return match?.[1] || ''
}

function isSupportedStreamUrl(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    const host = url.hostname.toLowerCase()
    if (host.includes('youtube.com') || host.includes('youtu.be') || host.includes('twitch.tv')) return false
    if (/\.mpd(?:\?|#|$)/i.test(url.pathname)) return false
    return !value.includes('...')
  } catch {
    return false
  }
}

function normalizeChannel(channel) {
  if (!channel?.name || !isSupportedStreamUrl(channel.url)) return null
  return {
    name: String(channel.name).trim(),
    url: channel.url,
    group: String(channel.group || 'Live TV').trim(),
    country: String(channel.country || '').trim(),
    logo: channel.logo || null,
    provider: String(channel.provider || 'custom').trim(),
    playlistUrl: channel.playlistUrl || null,
  }
}

export function parseM3U(text, source = {}) {
  const channels = []
  const lines = String(text || '').split(/\r?\n/)
  let metadata = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.toUpperCase().startsWith('#EXTINF')) {
      const comma = line.indexOf(',')
      metadata = {
        name: comma >= 0 ? line.slice(comma + 1).trim() : readAttribute(line, 'tvg-name'),
        group: readAttribute(line, 'group-title') || 'Live TV',
        country: readAttribute(line, 'tvg-country'),
        logo: readAttribute(line, 'tvg-logo') || null,
        provider: source.provider || 'custom',
        playlistUrl: source.url || null,
      }
      continue
    }

    if (line.startsWith('#')) continue
    if (!metadata) continue

    const channel = normalizeChannel({ ...metadata, url: line })
    if (channel) channels.push(channel)
    metadata = null
  }

  return channels
}

function readPlaylistSources() {
  const raw = process.env.IPTV_PLAYLISTS_JSON
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) {
        return parsed
          .filter((source) => source?.enabled !== false && source?.url)
          .map((source, index) => ({
            id: String(source.id || `playlist-${index + 1}`),
            provider: String(source.label || source.id || `playlist-${index + 1}`),
            url: String(source.url),
          }))
      }
    } catch {
      console.error('IPTV_PLAYLISTS_JSON is not valid JSON')
    }
  }

  return [{
    id: 'free-tv',
    provider: 'Free-TV IPTV',
    url: process.env.IPTV_PLAYLIST_URL || DEFAULT_PLAYLIST_URL,
  }]
}

export function getPlaylistSources() {
  return readPlaylistSources()
}

function parseConfiguredChannels() {
  const raw = process.env.IPTV_CHANNELS_JSON
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(normalizeChannel).filter(Boolean) : []
  } catch {
    console.error('IPTV_CHANNELS_JSON is not valid JSON')
    return []
  }
}

async function fetchPlaylist(source) {
  const parsed = new URL(source.url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`IPTV playlist ${source.id} must use HTTP/HTTPS`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(parsed, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Chan IPTV catalog/1.0', Accept: 'application/vnd.apple.mpegurl,text/plain' },
    })
    if (!response.ok) throw new Error(`IPTV playlist returned HTTP ${response.status}`)
    return parseM3U(await response.text(), source)
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`IPTV playlist ${source.id} timed out`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function getPlaylistChannels({ force = false } = {}) {
  if (!force && playlistCache.expiresAt > Date.now()) return [...playlistCache.channels]

  const sources = readPlaylistSources()
  const settled = await Promise.allSettled(sources.map((source) => fetchPlaylist(source)))
  const channels = settled.flatMap((result, index) => {
    if (result.status === 'fulfilled') return result.value
    console.error(`IPTV playlist ${sources[index].id} failed:`, result.reason?.message || result.reason)
    return []
  })

  if (!channels.length) throw new Error('All IPTV playlists are unavailable or empty')
  const unique = new Map(channels.map((channel) => [channel.url, channel]))
  playlistCache = { expiresAt: Date.now() + CACHE_TTL_MS, channels: [...unique.values()] }
  return [...playlistCache.channels]
}

export async function checkIptvChannel(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    let response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Chan IPTV health check/1.0' },
    })

    if (response.status === 405 || response.status === 403 || response.status === 501) {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { Range: 'bytes=0-0', 'User-Agent': 'Chan IPTV health check/1.0' },
      })
      await response.body?.cancel?.()
    }

    const contentType = response.headers.get('content-type') || ''
    const healthy = response.ok && !contentType.toLowerCase().includes('text/html')
    return { healthy, status: response.status, contentType, error: healthy ? null : `HTTP ${response.status}` }
  } catch (error) {
    return {
      healthy: false,
      status: 0,
      contentType: '',
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function readHealthyCatalog(provider) {
  if (process.env.IPTV_USE_FIRESTORE_CATALOG !== 'true') return []
  try {
    const snap = await getDb()
      .collection('mediaCatalog')
      .doc('iptv')
      .collection('channels')
      .where('healthy', '==', true)
      .limit(2000)
      .get()
    return snap.docs
      .map((doc) => normalizeChannel(doc.data()))
      .filter((channel) => channel && (!provider || channel.provider === provider))
  } catch (error) {
    console.error('IPTV Firestore catalog read failed:', error.message)
    return []
  }
}

export async function getIptvChannels(extraChannels = [], provider = '') {
  const configured = [...parseConfiguredChannels(), ...extraChannels.map(normalizeChannel).filter(Boolean)]
  const catalog = await readHealthyCatalog(provider)
  if (catalog.length) {
    const unique = new Map([...catalog, ...configured].map((channel) => [channel.url, channel]))
    return [...unique.values()].filter((channel) => !provider || channel.provider === provider || channel.provider === 'custom')
  }

  try {
    const playlistChannels = await getPlaylistChannels()
    const unique = new Map([...playlistChannels, ...configured].map((channel) => [channel.url, channel]))
    return [...unique.values()].filter((channel) => !provider || channel.provider === provider || channel.provider === 'custom')
  } catch (error) {
    console.error('IPTV playlist error:', error.message)
    if (configured.length) return configured.filter((channel) => !provider || channel.provider === provider || channel.provider === 'custom')
    throw Object.assign(new Error('IPTV playlist is currently unavailable'), { status: 503 })
  }
}
