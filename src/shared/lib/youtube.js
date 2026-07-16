// YouTube Data API v3 configuration (optional - only needed for search)
const YOUTUBE_API_KEY = import.meta.env.VITE_YOUTUBE_API_KEY || ''
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

const VIDEO_ID_RE =
  /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([^"&?/ ]{11})/

export function extractVideoId(input) {
  if (!input || typeof input !== 'string') return null
  const m = input.match(VIDEO_ID_RE)
  return m ? m[1] : null
}

export function buildYouTubeEmbedUrl(videoId) {
  if (!videoId) return null
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?rel=0&modestbranding=1`
}

export function buildYouTubeWatchUrl(videoId) {
  if (!videoId) return null
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
}

const DIRECT_VIDEO_RE = /\.(mp4|m3u8|webm|ogg|mov|mkv|avi|flv|ts)(\?|#|$)/i

// Common direct video host patterns
const DIRECT_HOST_PATTERNS = [
  /o2tv\.org$/i,
  /cdn\./i,
  /video\./i,
  /stream\./i,
  /download\./i,
  /media\./i,
  /files\./i,
  /content\./i,
  /videos\./i,
  /movies\./i,
  /[a-z0-9]+\.otv/i,
]

export function isDirectVideoUrl(url) {
  if (!url || typeof url !== 'string') return false

  // Same-origin proxy URLs are always playable in-room (already resolved server-side)
  if (/^\/api\/proxy\?/i.test(url) || /\/api\/proxy\?url=/i.test(url)) return true

  // Percent-decoded check so encoded ".mp4" inside proxy query still matches
  let decoded = url
  try { decoded = decodeURIComponent(url) } catch { /* keep original */ }
  if (DIRECT_VIDEO_RE.test(url) || DIRECT_VIDEO_RE.test(decoded)) return true

  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://example.com')
    if (u.pathname.startsWith('/api/proxy')) return true
    if (!['http:', 'https:'].includes(u.protocol)) return false

    // Check if hostname matches known direct video hosts
    const hostname = u.hostname.toLowerCase()
    if (DIRECT_HOST_PATTERNS.some(pattern => pattern.test(hostname))) {
      // If it's from a known video CDN, check for video extension or path patterns
      if (DIRECT_VIDEO_RE.test(u.pathname) || DIRECT_VIDEO_RE.test(decoded)) return true

      // Also accept URLs with hash-based filenames (common on CDNs)
      if (/\/[a-f0-9]{16,}\//i.test(u.pathname) && u.pathname.length > 30) {
        return true
      }
    }

    // Query-param filename patterns (e.g. ?name=movie.mkv used by Koyeb CDN)
    if (u.searchParams.getAll('name').some((v) => DIRECT_VIDEO_RE.test(v) || /\.(mp4|m3u8|mkv|webm|avi|mov|ts)$/i.test(v))) {
      return true
    }

    return DIRECT_VIDEO_RE.test(u.pathname) || DIRECT_VIDEO_RE.test(url)
  } catch {
    return DIRECT_VIDEO_RE.test(url) || DIRECT_VIDEO_RE.test(decoded)
  }
}

export function normalizeDirectUrl(url) {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
}

export function normalizePlaybackUrl(url, opts = {}) {
  // Decode HTML entities that may leak through from server-side scraping
  // (JSON.parse doesn't decode &amp; → & so URLs can contain entities)
  let normalized = (url || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&#47;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
  normalized = normalizeDirectUrl(normalized)
  // Already a same-origin proxy path — leave intact (keeps remux/referer params)
  if (/^\/api\/proxy\?/i.test(normalized)) return normalized
  try {
    const parsed = new URL(normalized, typeof window !== 'undefined' ? window.location.origin : 'https://chan.invalid')
    if (parsed.pathname.startsWith('/api/proxy')) {
      return `${parsed.pathname}${parsed.search}`
    }

    const hostname = parsed.hostname.toLowerCase()
    // Check if this is an MKV file that needs remuxing
    const isMkv = /\.mkv(\?|#|$)/i.test(parsed.pathname)
      || /-mkv(\?|#|$)/i.test(parsed.pathname)
      // Also check query params: ?name=movie.mkv or ?name=something-mkv
      || /\.(mkv)(&|$)/i.test(parsed.search)
      || /-mkv(&|$)/i.test(parsed.search)
      || parsed.searchParams.getAll('name').some(v => /\.mkv$/i.test(v) || /-mkv$/i.test(v))

    // Hosts that always need the proxy (Referer / CORS / mixed content)
    const needsProxyHost = (
      hostname.includes('downloadwella')
      || hostname.includes('fsmc')
      || hostname.includes('phncdn')
      || hostname.includes('pornhub')
      || hostname.includes('xvideos')
      || hostname.includes('spankbang')
      || hostname.includes('dood')
      || hostname.includes('kissorgrab')
      || hostname.includes('wideshares')
      || hostname.includes('np-downloader')
      || hostname.includes('wildshare')
      || hostname.includes('silversurfer')
      || hostname.includes('o2tv')
      || hostname.includes('koyeb.app')
      || hostname.includes('maxcinema')
    )

    // Koyeb MaxCinema watch URLs often have NO extension but stream MKV
    const isKoyebWatch = hostname.includes('koyeb.app') && (
      parsed.pathname.includes('/watch/')
      || parsed.searchParams.has('name')
    )

    const isHttp = parsed.protocol === 'http:'

    // Cross-origin direct video files (mp4/m3u8/webm/etc.) are routed through
    // the proxy by default so the browser can play them without CORS errors
    // or mixed-content blocks. Same-origin URLs and explicit direct-link opt-out
    // are left untouched.
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const isSameOrigin = origin && parsed.origin === origin
    const pathAndQuery = parsed.pathname + parsed.search
    const hasVideoExtension = /\.(mp4|m3u8|webm|ogg|mov|avi|flv|ts)(\?|#|$)/i.test(pathAndQuery)
    // Extension-less live paths still need proxy when http or CORS-hostile
    const looksLiveHls = /playlist|chunklist|index\.m3u|master\.m3u|\/live\/|\/hls\//i.test(pathAndQuery)
    const shouldProxyDirect = opts.forceProxy
      || (!isSameOrigin && hasVideoExtension)
      || (!isSameOrigin && looksLiveHls)

    if (isMkv || isKoyebWatch || needsProxyHost || isHttp || shouldProxyDirect) {
      let out = `/api/proxy?url=${encodeURIComponent(normalized)}`
      if (isMkv || isKoyebWatch) out += '&remux=1'
      if (hostname.includes('downloadwella') || hostname.includes('fsmc')) {
        out += `&referer=${encodeURIComponent('https://downloadwella.com/')}`
      } else if (hostname.includes('phncdn') || hostname.includes('pornhub')) {
        out += `&referer=${encodeURIComponent('https://www.pornhub.com/')}`
      } else if (hostname.includes('xvideos') || hostname.includes('cdn-xl') || hostname.includes('xvideos-cdn')) {
        out += `&referer=${encodeURIComponent('https://www.xvideos.com/')}`
      } else if (hostname.includes('spankbang') || hostname.includes('sb-cd') || hostname.includes('spankcdn')) {
        out += `&referer=${encodeURIComponent('https://spankbang.party/')}`
      } else if (hostname.includes('koyeb.app') || hostname.includes('maxcinema')) {
        out += `&referer=${encodeURIComponent('https://www.maxcinema.name.ng/')}`
      } else if (hostname.includes('wildshare') || hostname.includes('silversurfer') || hostname.includes('np-downloader')) {
        out += `&referer=${encodeURIComponent('https://www.naijaprey.tv/')}`
      } else if (hostname.includes('o2tv')) {
        out += `&referer=${encodeURIComponent('http://d6.o2tv.org/')}`
      }
      return out
    }
    return normalized
  } catch {
    return normalized
  }
}


/** True when playback URL is MKV remuxed through /api/proxy. */
export function isRemuxProxyUrl(url) {
  if (!url || typeof url !== 'string') return false
  if (!/\/api\/proxy\?/i.test(url)) return false
  if (/[?&]remux=1(?:&|$)/i.test(url)) return true
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://chan.invalid')
    const target = u.searchParams.get('url') || ''
    return /\.mkv(\?|#|$)/i.test(target) || /-mkv/i.test(target)
  } catch {
    return /\.mkv/i.test(url)
  }
}

/**
 * Set or clear seek-by-time on a remux proxy URL (?t=seconds).
 * Used so host + all participants remux from the same MKV cue.
 */
export function withRemuxSeekTime(url, timeSec) {
  if (!url || typeof url !== 'string') return url
  const t = Math.max(0, Number(timeSec) || 0)
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://chan.invalid'
    // Relative /api/proxy?... 
    if (url.startsWith('/api/proxy')) {
      const u = new URL(url, base)
      u.searchParams.delete('_seek') // cache-buster only for ReactPlayer
      if (t < 0.5) u.searchParams.delete('t')
      else u.searchParams.set('t', String(Math.floor(t * 10) / 10))
      // Ensure remux stays on for MKV seek path
      if (!u.searchParams.get('remux')) u.searchParams.set('remux', '1')
      return `${u.pathname}?${u.searchParams.toString()}`
    }
    if (/\/api\/proxy\?/i.test(url)) {
      const u = new URL(url)
      if (t < 0.5) u.searchParams.delete('t')
      else u.searchParams.set('t', String(Math.floor(t * 10) / 10))
      return u.toString()
    }
  } catch { /* fall through */ }
  return url
}

export function getRemuxSeekTime(url) {
  if (!url || typeof url !== 'string') return 0
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://chan.invalid'
    const u = url.startsWith('/') ? new URL(url, base) : new URL(url)
    const t = Number(u.searchParams.get('t') || 0)
    return Number.isFinite(t) && t > 0 ? t : 0
  } catch {
    return 0
  }
}

export function isMixedContentUrl(url) {
  return typeof window !== 'undefined'
    && window.location.protocol === 'https:'
    && /^http:\/\//i.test(url || '')
}

export function isYouTubeUrl(url) {
  return !!extractVideoId(url)
}

// Public oEmbed - no API key needed
export async function fetchYouTubeInfo(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(
        videoId
      )}&format=json`
    )
    if (!res.ok) return null
    const data = await res.json()
    return { title: data.title, thumbnail: data.thumbnail_url }
  } catch {
    return null
  }
}

// Public oEmbed - no API key needed
export async function checkEmbeddable(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(
      videoId
    )}&format=json`
    const res = await fetch(url)
    if (res.status === 403 || res.status === 401) {
      return {
        embeddable: false,
        reason: 'This video is blocked from embedding by the uploader.',
      }
    }
    if (!res.ok) {
      return { embeddable: false, reason: 'Unable to verify embed status.' }
    }
    const data = await res.json()
    return {
      embeddable: true,
      title: data.title,
      thumbnail: data.thumbnail_url,
    }
  } catch {
    return { embeddable: false, reason: 'Network error while checking embed status.' }
  }
}

// YouTube Data API v3 functions (requires API key)

export async function searchYouTube(query, maxResults = 10) {
  if (!YOUTUBE_API_KEY) {
    throw new Error('YouTube API key not configured. Add VITE_YOUTUBE_API_KEY to your .env file.')
  }
  
  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(maxResults),
    key: YOUTUBE_API_KEY,
  })
  
  const res = await fetch(`${YOUTUBE_API_BASE}/search?${params}`, {
    headers: {
      Referer: typeof window !== 'undefined' ? window.location.href : 'https://chan-yz3p.vercel.app/',
    },
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    throw new Error(error.error?.message || 'YouTube search failed')
  }
  
  const data = await res.json()
  return data.items.map(item => ({
    id: item.id.videoId,
    title: item.snippet.title,
    description: item.snippet.description,
    thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
    channelTitle: item.snippet.channelTitle,
    publishedAt: item.snippet.publishedAt,
  }))
}

export async function getVideoDetails(videoId) {
  if (!YOUTUBE_API_KEY) {
    throw new Error('YouTube API key not configured')
  }
  
  const params = new URLSearchParams({
    part: 'snippet,contentDetails,statistics',
    id: videoId,
    key: YOUTUBE_API_KEY,
  })
  
  const res = await fetch(`${YOUTUBE_API_BASE}/videos?${params}`, {
    headers: {
      Referer: typeof window !== 'undefined' ? window.location.href : 'https://chan-yz3p.vercel.app/',
    },
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    throw new Error(error.error?.message || 'Failed to get video details')
  }
  
  const data = await res.json()
  if (!data.items || data.items.length === 0) {
    return null
  }
  
  const item = data.items[0]
  return {
    id: item.id,
    title: item.snippet.title,
    description: item.snippet.description,
    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url,
    duration: item.contentDetails.duration,
    viewCount: item.statistics.viewCount,
    likeCount: item.statistics.likeCount,
    channelTitle: item.snippet.channelTitle,
  }
}

// Check if API key is configured
export function hasYouTubeApiKey() {
  return !!YOUTUBE_API_KEY
}

export function getThumbnail(videoId) {
  if (!videoId) return null
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
}
