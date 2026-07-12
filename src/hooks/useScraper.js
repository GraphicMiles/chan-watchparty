import { useCallback, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_URL || ''

async function postJson(url, body) {
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok || !data.success) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
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
      setResults(data.results || [])
      setLastQuery({ type: 'scrape', site, query: query || url })
      return data
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
      if (source === 'youtube' && import.meta.env.VITE_YOUTUBE_API_KEY) {
        const params = new URLSearchParams({
          part: 'snippet',
          q: query,
          type: 'video',
          maxResults: '20',
          key: import.meta.env.VITE_YOUTUBE_API_KEY,
        })
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`)
        const data = await res.json()
        if (!res.ok) throw new Error(data.error?.message || 'YouTube search failed')
        const items = data.items?.map((it) => ({
          id: it.id.videoId,
          title: it.snippet.title,
          thumbnail: it.snippet.thumbnails?.high?.url || it.snippet.thumbnails?.medium?.url,
          channel: it.snippet.channelTitle,
          published: it.snippet.publishedAt,
          url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
          source: 'youtube',
        })) || []
        setResults(items)
        setLastQuery({ type: 'search', source, query })
        return { results: items }
      }
      const data = await postJson('/api/search', { query, source })
      setResults(data.results || [])
      setLastQuery({ type: 'search', source, query })
      return data
    } catch (e) {
      setError(e.message)
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  return { scrape, search, results, lastQuery, loading, error, clear }
}
