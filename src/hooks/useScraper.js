import { useCallback, useState } from 'react'
import { searchVideos as ytSearch } from '../shared/lib/youtube.js'

const API_BASE = import.meta.env.VITE_API_URL || ''

async function postJson(url, body) {
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error(`Server returned ${res.status} (not JSON)`)
  }
  if (!res.ok || data.success === false) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
}

/** Normalize any result shape for UI + create room */
function normalizeResult(r) {
  if (!r) return null
  const link = r.link || r.url || null
  const url = r.url || r.link || null
  const isDirect =
    r.isDirect === true ||
    (typeof link === 'string' && /\.(mp4|m3u8|webm|ogg|mov|mkv)(\?|#|$)/i.test(link))
  return {
    ...r,
    link,
    url,
    image: r.image || r.thumbnail || null,
    thumbnail: r.thumbnail || r.image || null,
    isDirect,
    playableInRoom:
      r.source === 'youtube' && r.id
        ? r.embeddable !== false
        : isDirect,
  }
}

export function useScraper() {
  const [results, setResults] = useState([])
  const [lastQuery, setLastQuery] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const clear = useCallback(() => {
    setResults([])
    setLastQuery(null)
    setError(null)
  }, [])

  const scrape = useCallback(async ({ url, query, site }) => {
    if (!url && !query) return
    setLoading(true)
    setError(null)
    try {
      const data = await postJson('/api/scrape', { url, query, site })
      const list = (data.results || []).map(normalizeResult).filter(Boolean)
      // Prefer direct media links first
      list.sort((a, b) => Number(b.isDirect) - Number(a.isDirect))
      setResults(list)
      setLastQuery({ type: 'scrape', site, query: query || url })
      if (!list.length) {
        setError(
          data.hint ||
            'No links found on that page. Open the site, go to the movie page, paste that URL, or paste a direct .mp4 link.'
        )
      }
      return { ...data, results: list }
    } catch (e) {
      setError(e.message)
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  const search = useCallback(async (query, source = 'youtube') => {
    if (!query) return
    setLoading(true)
    setError(null)
    try {
      if (source === 'youtube') {
        // Prefer client YouTube API with embeddable enrichment
        if (import.meta.env.VITE_YOUTUBE_API_KEY) {
          const items = await ytSearch(query.trim(), 16, { preferEmbeddable: true })
          const list = items.map(normalizeResult)
          setResults(list)
          setLastQuery({ type: 'search', source, query })
          if (!list.length) setError('No YouTube results for that search.')
          return { results: list }
        }
        const data = await postJson('/api/search', { query, source: 'youtube' })
        const list = (data.results || []).map(normalizeResult)
        setResults(list)
        setLastQuery({ type: 'search', source, query })
        return data
      }
      const data = await postJson('/api/search', { query, source })
      const list = (data.results || []).map(normalizeResult)
      setResults(list)
      setLastQuery({ type: 'search', source, query })
      return { ...data, results: list }
    } catch (e) {
      setError(e.message)
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  return { scrape, search, results, lastQuery, loading, error, clear }
}
