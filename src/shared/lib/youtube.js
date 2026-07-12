const API_KEY = import.meta.env.VITE_YOUTUBE_API_KEY
const BASE = 'https://www.googleapis.com/youtube/v3'

const DIRECT_VIDEO_RE = /\.(mp4|m3u8|webm|ogg|mov|mkv)(\?|#|$)/i

export function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null
  try {
    const parsed = new URL(url.trim())
    const host = parsed.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') {
      return parsed.pathname.split('/').filter(Boolean)[0] || null
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (parsed.searchParams.get('v')) return parsed.searchParams.get('v')
      const parts = parsed.pathname.split('/').filter(Boolean)
      // /embed/ID, /shorts/ID, /live/ID, /v/ID
      if (parts[0] && ['embed', 'shorts', 'live', 'v', 'watch'].includes(parts[0]) && parts[1]) {
        return parts[0] === 'watch' ? parsed.searchParams.get('v') : parts[1]
      }
      return parts[parts.length - 1] || null
    }
  } catch {
    // bare id?
    if (/^[\w-]{11}$/.test(url.trim())) return url.trim()
  }
  return null
}

export function isDirectVideoUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const u = new URL(url, 'https://example.com')
    if (!['http:', 'https:'].includes(u.protocol)) return false
    return DIRECT_VIDEO_RE.test(u.pathname) || DIRECT_VIDEO_RE.test(url)
  } catch {
    return DIRECT_VIDEO_RE.test(url)
  }
}

export function getThumbnail(videoId) {
  if (!videoId) return null
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
}

export async function getVideoMetadata(videoId) {
  if (!API_KEY || !videoId) return null
  const res = await fetch(
    `${BASE}/videos?part=snippet,status,contentDetails&id=${encodeURIComponent(videoId)}&key=${API_KEY}`
  )
  const data = await res.json()
  return data.items?.[0] || null
}

/** Returns { embeddable, title, reason } */
export async function checkEmbeddable(videoId) {
  if (!videoId) return { embeddable: false, reason: 'No video id' }
  if (!API_KEY) {
    // Can't verify — allow but warn upstream
    return { embeddable: true, unverified: true, title: null, reason: null }
  }
  try {
    const item = await getVideoMetadata(videoId)
    if (!item) return { embeddable: false, reason: 'Video not found' }
    const embeddable = item.status?.embeddable !== false
    const privacy = item.status?.privacyStatus
    if (privacy === 'private') {
      return { embeddable: false, title: item.snippet?.title, reason: 'Video is private' }
    }
    if (!embeddable) {
      return {
        embeddable: false,
        title: item.snippet?.title,
        reason:
          'This video cannot be embedded (often Vevo/label restriction). Play it on YouTube, or pick another video.',
      }
    }
    return { embeddable: true, title: item.snippet?.title, reason: null }
  } catch {
    return { embeddable: true, unverified: true, title: null, reason: null }
  }
}

/**
 * Search + enrich with embeddable status (filters non-embeddable when possible).
 */
export async function searchVideos(query, maxResults = 12, { preferEmbeddable = true } = {}) {
  if (!API_KEY || !query) return []
  const res = await fetch(
    `${BASE}/search?part=snippet&type=video&q=${encodeURIComponent(query)}&maxResults=${Math.min(
      maxResults * 2,
      25
    )}&key=${API_KEY}`
  )
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error?.message || 'YouTube search failed')
  }
  const ids = (data.items || []).map((it) => it.id?.videoId).filter(Boolean)
  if (!ids.length) return []

  // Enrich with status.embeddable
  const vRes = await fetch(
    `${BASE}/videos?part=snippet,status&id=${ids.join(',')}&key=${API_KEY}`
  )
  const vData = await vRes.json()
  const byId = new Map((vData.items || []).map((it) => [it.id, it]))

  let results = ids.map((id) => {
    const full = byId.get(id)
    const sn = full?.snippet || data.items.find((i) => i.id?.videoId === id)?.snippet
    const embeddable = full?.status?.embeddable !== false
    return {
      id,
      title: sn?.title || 'Untitled',
      thumbnail:
        sn?.thumbnails?.high?.url ||
        sn?.thumbnails?.medium?.url ||
        sn?.thumbnails?.default?.url ||
        getThumbnail(id),
      channel: sn?.channelTitle,
      published: sn?.publishedAt,
      url: `https://www.youtube.com/watch?v=${id}`,
      source: 'youtube',
      embeddable,
      link: `https://www.youtube.com/watch?v=${id}`,
    }
  })

  if (preferEmbeddable) {
    const embeddable = results.filter((r) => r.embeddable)
    // Keep some non-embeddable at end so user still sees them labeled
    const blocked = results.filter((r) => !r.embeddable)
    results = [...embeddable, ...blocked].slice(0, maxResults)
  } else {
    results = results.slice(0, maxResults)
  }

  return results
}
