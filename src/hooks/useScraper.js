import { useState, useCallback } from 'react'
import { isDirectVideoUrl, normalizeDirectUrl, normalizePlaybackUrl } from '../shared/lib/youtube.js'
import { useAuth } from '../shared/auth/hooks/useAuth.jsx'

const API_URL = import.meta.env.VITE_API_URL || ''

export function useScraper() {
  const { user } = useAuth()
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

    if (url && isDirectVideoUrl(url)) {
      const normalized = normalizePlaybackUrl(url)
      const fileName = normalized.split('/').pop()?.replace(/\.(mp4|m3u8|mkv|avi|mov|webm|ogg|flv|ts)$/i, '') || 'Video'
      setResults([{
        title: fileName,
        image: null,
        link: normalized,
        url: normalized,
        meta: 'direct file',
        source: 'direct',
        isDirect: true,
        quality: extractQualityFromFilename(fileName),
        playableInRoom: true,
      }])
      setError(null)
      return
    }

    if (!user) {
      setError('Sign in to use media tools')
      return
    }
    setLoading(true)
    setError(null)

    try {
      const token = await user.getIdToken()
      const request = url
        ? { action: 'scrape', url, site, options: { resolve: true } }
        : { action: 'search', layer: 'direct', query, options: { site, resolve: true } }
      const res = await fetch(`${API_URL}/api/media`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
      })
      const data = await res.json()

      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      const normalized = (data.results || []).map((item, index) => {
        const link = normalizePlaybackUrl(item.url || item.link || '')
        const playable = item.isDirect === true || isDirectVideoUrl(link)
        return {
          id: index,
          title: item.title || 'Untitled',
          image: item.image || item.thumbnail || null,
          link,
          url: link,
          meta: item.meta || null,
          source: item.source || site || 'unknown',
          isDirect: playable,
          requiresUserAction: item.requiresUserAction === true,
          quality: item.quality || extractQualityFromText(`${item.title || ''} ${item.meta || ''}`),
          playableInRoom: playable,
        }
      })

      setResults(normalized)
    } catch (err) {
      setError(err.message || 'Failed to scrape')
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [user])

  return { results, loading, error, clear, scrape }
}

function extractQualityFromText(text) {
  if (!text) return null
  const match = text.match(/\b(4K|2160p|1440p|1080p|720p|480p|360p|240p|HD|SD|HQ|FullHD)\b/i)
  return match ? match[1] : null
}

function extractQualityFromFilename(filename) {
  return extractQualityFromText(filename)
}
