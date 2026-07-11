const API_KEY = import.meta.env.VITE_YOUTUBE_API_KEY
const BASE = 'https://www.googleapis.com/youtube/v3'

export function extractVideoId(url) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.includes('youtube.com')) {
      return parsed.searchParams.get('v') || parsed.pathname.split('/').pop()
    }
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.slice(1)
    }
  } catch {
    return null
  }
  return null
}

export async function getVideoMetadata(videoId) {
  if (!API_KEY || !videoId) return null
  const res = await fetch(
    `${BASE}/videos?part=snippet&id=${videoId}&key=${API_KEY}`
  )
  const data = await res.json()
  return data.items?.[0]?.snippet || null
}

export async function searchVideos(query, maxResults = 8) {
  if (!API_KEY || !query) return []
  const res = await fetch(
    `${BASE}/search?part=snippet&type=video&q=${encodeURIComponent(query)}&maxResults=${maxResults}&key=${API_KEY}`
  )
  const data = await res.json()
  return data.items || []
}

export function getThumbnail(videoId) {
  return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`
}
