import { useState, useCallback } from 'react'
import { isDirectVideoUrl, normalizeDirectUrl } from '../shared/lib/youtube.js'

const API_URL = import.meta.env.VITE_API_URL || ''

export function useScraper() {
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const clear = useCallback(() => {
    setResults([])
    setError(null)
  }, [])

  const scrape = useCallback(async ({ url, query, site }) => {
    if (!url && !query) {
      setError('Please provide a URL or search query')
      return []
    }

    // Check if it's a direct video URL - skip scraping
    if (url && isDirectVideoUrl(url)) {
      const normalized = normalizeDirectUrl(url)
      const directResult = {
        title: normalized.split('/').pop()?.replace(/\.(mp4|m3u8|mkv|avi|mov|webm)$/i, '') || 'Direct Video',
        image: null,
        link: normalized,
        url: normalized,
        meta: 'direct file',
        source: 'direct',
        isDirect: true,
        quality: null,
      }
      setResults([directResult])
      setLoading(false)
      setError(null)
      return [directResult]
    }

    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`${API_URL}/api/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, query, site }),
      })

      const data = await res.json()

      if (!res.ok || !data.success) {
        throw new Error(data.error || `Server error: ${res.status}`)
      }

      // Normalize results with isDirect flag
      const normalized = (data.results || []).map((item) => ({
        title: item.title || 'Untitled',
        image: item.image || item.thumbnail || null,
        link: item.link || item.url || '',
        url: item.url || item.link || '',
        meta: item.meta || null,
        source: item.source || site || 'unknown',
        isDirect: item.isDirect || isDirectVideoUrl(item.link || item.url),
        quality: item.quality || extractQuality(item.title || item.meta || ''),
        playableInRoom: item.isDirect || isDirectVideoUrl(item.link || item.url),
      }))

      setResults(normalized)
      return normalized
    } catch (err) {
      const message = err.message || 'Failed to scrape'
      setError(message)
      setResults([])
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  return { results, loading, error, clear, scrape }
}

// Helper to extract quality from text
function extractQuality(text) {
  if (!text) return null
  const match = text.match(/(480p|720p|1080p|4K|2160p|HD|SD|360p|240p|1440p)/i)
  return match ? match[1] : null
}
