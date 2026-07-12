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
      setError('URL or query is required')
      return
    }

    // Handle direct video URLs immediately without API call
    if (url && isDirectVideoUrl(url)) {
      const normalized = normalizeDirectUrl(url)
      const fileName = normalized.split('/').pop()?.replace(/\.(mp4|m3u8|mkv|avi|mov|webm|ogg|flv)$/i, '') || 'Video'
      const directResult = {
        title: fileName,
        image: null,
        link: normalized,
        url: normalized,
        meta: 'direct file',
        source: 'direct',
        isDirect: true,
        quality: extractQualityFromFilename(fileName),
        playableInRoom: true,
      }
      setResults([directResult])
      setError(null)
      return
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

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      if (!data.success) {
        throw new Error(data.error || 'Scrape failed')
      }

      // Normalize results with isDirect flag and quality extraction
      const normalized = (data.results || []).map((item, index) => ({
        id: index,
        title: item.title || 'Untitled',
        image: item.image || item.thumbnail || null,
        link: item.link || item.url || '',
        url: item.url || item.link || '',
        meta: item.meta || null,
        source: item.source || site || 'unknown',
        isDirect: item.isDirect || isDirectVideoUrl(item.link || item.url),
        quality: item.quality || extractQualityFromText(item.title + ' ' + (item.meta || '')),
        playableInRoom: item.isDirect || isDirectVideoUrl(item.link || item.url),
      }))

      setResults(normalized)
      
      if (data.hint) {
        console.log('Scraper hint:', data.hint)
      }
    } catch (err) {
      setError(err.message || 'Failed to scrape')
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  return { results, loading, error, clear, scrape }
}

// Helper functions
function extractQualityFromText(text) {
  if (!text) return null
  const match = text.match(/\b(4K|2160p|1440p|1080p|720p|480p|360p|240p|HD|SD|HQ|FullHD)\b/i)
  return match ? match[1] : null
}

function extractQualityFromFilename(filename) {
  if (!filename) return null
  const patterns = [
    { regex: /1080p|1920x1080|fullhd/i, quality: '1080p' },
    { regex: /720p|1280x720|hd/i, quality: '720p' },
    { regex: /480p|854x480|sd/i, quality: '480p' },
    { regex: /360p|640x360/i, quality: '360p' },
    { regex: /4k|2160p|ultrahd|uhd/i, quality: '4K' },
    { regex: /240p|426x240/i, quality: '240p' },
  ]
  
  for (const pattern of patterns) {
    if (pattern.regex.test(filename)) {
      return pattern.quality
    }
  }
  return null
}
