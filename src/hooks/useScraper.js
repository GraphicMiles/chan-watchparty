import { useState, useCallback } from 'react'
import { isDirectVideoUrl, normalizeDirectUrl, normalizePlaybackUrl } from '../shared/lib/youtube.js'
import { useAuth } from '../shared/auth/hooks/useAuth.jsx'
import { isSuitableThumbnail, isTitleMatch, cleanTitleForMatching } from '../shared/lib/mediaHelper.js'

function softClientTitleMatch(title, query) {
  if (!title || !query) return true
  if (isTitleMatch(title, query)) return true
  const baseQuery = String(query)
    .replace(/\s+season\s*\d+.*$/i, '')
    .replace(/\s+s\d+\s*e?\d*.*$/i, '')
    .trim()
  if (baseQuery && isTitleMatch(title, baseQuery)) return true
  const qTokens = cleanTitleForMatching(baseQuery || query)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !['season', 'episode', 'complete', 'series'].includes(t))
  if (!qTokens.length) return true
  const tClean = cleanTitleForMatching(title)
  // Majority of meaningful tokens is enough (strict every-token wiped Nkiri titles)
  const hits = qTokens.filter((t) => tClean.includes(t))
  if (hits.length === 0) {
    // primary token only (e.g. "silo")
    return qTokens[0] && tClean.includes(qTokens[0])
  }
  return hits.length >= Math.ceil(qTokens.length * 0.5)
}

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
      const isActualUrl = typeof url === 'string' && /^https?:\/\//i.test(url.trim())
      const request = isActualUrl
        ? { action: 'scrape', url: url.trim(), site, options: { resolve: true } }
        : { action: 'search', layer: 'direct', query: (url || query || '').trim(), options: { site, resolve: true } }
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

      const targetQuery = (url || query || '').trim()

      const rawResults = data.results || []
      let filtered = rawResults.filter((item) => {
        if (!item) return false
        if (!isActualUrl && targetQuery) {
          const isDirectOrMovie = item.isDirect || item.type === 'direct' || item.type === 'movie' || item.type === 'anime' || ['nkiri', 'netnaija', 'fzmovies', '9jarocks', 'animedrive', 'o2tv', 'downloadwella', 'omdb'].includes(item.source)
          // Soft match only — strict isTitleMatch was returning 0 for real Nkiri hits
          if (isDirectOrMovie && !softClientTitleMatch(item.title, targetQuery)) {
            return false
          }
        }
        return true
      })
      // Never show empty if the server returned pages (layout/title noise)
      if (filtered.length === 0 && rawResults.length > 0 && !isActualUrl) {
        filtered = rawResults.filter(Boolean)
      }

      const normalized = filtered.map((item, index) => {
        const link = normalizePlaybackUrl(item.url || item.link || '')
        const playable = item.isDirect === true || isDirectVideoUrl(link)
        const rawThumb = item.thumbnail || item.image || null
        const thumb = isSuitableThumbnail(rawThumb) ? rawThumb : null
        return {
          id: index,
          title: item.title || 'Untitled',
          thumbnail: thumb,
          image: thumb,
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
