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
  
  // Quick regex check first
  if (DIRECT_VIDEO_RE.test(url)) return true
  
  try {
    const u = new URL(url, 'https://example.com')
    if (!['http:', 'https:'].includes(u.protocol)) return false
    
    // Check if hostname matches known direct video hosts
    const hostname = u.hostname.toLowerCase()
    if (DIRECT_HOST_PATTERNS.some(pattern => pattern.test(hostname))) {
      // If it's from a known video CDN, check for video extension or path patterns
      if (DIRECT_VIDEO_RE.test(u.pathname)) return true
      
      // Also accept URLs with hash-based filenames (common on CDNs)
      if (/\/[a-f0-9]{16,}\//i.test(u.pathname) && u.pathname.length > 30) {
        return true
      }
    }
    
    return DIRECT_VIDEO_RE.test(u.pathname) || DIRECT_VIDEO_RE.test(url)
  } catch {
    return DIRECT_VIDEO_RE.test(url)
  }
}

export function normalizeDirectUrl(url) {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
}

export function normalizePlaybackUrl(url) {
  const normalized = normalizeDirectUrl(url || '')
  try {
    const parsed = new URL(normalized, 'https://chan.invalid')
    // Check if this is an MKV file that needs remuxing
    const isMkv = /\.mkv(\?|#|$)/i.test(parsed.pathname) 
      || /-mkv(\?|#|$)/i.test(parsed.pathname)
      // Also check query params: ?name=movie.mkv or ?name=something-mkv
      || /\.(mkv)(&|$)/i.test(parsed.search)
      || /-mkv(&|$)/i.test(parsed.search)
      || parsed.searchParams.getAll('name').some(v => /\.mkv$/i.test(v) || /-mkv$/i.test(v))
    // Automatically route any HTTP stream through our secure Vercel Mixed-Content proxy (/api/proxy)
    // Also route MKV files through the proxy with remux=1 so they get converted to MP4
    if (isMkv) {
      return `/api/proxy?url=${encodeURIComponent(normalized)}&remux=1`
    }
    if (parsed.protocol === 'http:' && (typeof window !== 'undefined' && window.location.protocol === 'https:' || true)) {
      return `/api/proxy?url=${encodeURIComponent(normalized)}`
    }
    return normalized
  } catch {
    return normalized
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
