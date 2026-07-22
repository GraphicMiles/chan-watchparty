import { useState, useCallback, useRef } from 'react'
import { useAuth } from '../shared/auth/hooks/useAuth.jsx'
import { isSuitableThumbnail, isTitleMatch, cleanTitleForMatching } from '../shared/lib/mediaHelper.js'
import { apiPath, parseJsonResponse } from '../shared/lib/api.js'
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

function softClientTitleMatch(title, query) {
  if (!title || !query) return true
  if (isTitleMatch(title, query)) return true
  const baseQuery = String(query)
    .replace(/\s+season\s*\d+.*$/i, '')
    .replace(/\s+s\d+\s*e?\d*.*$/i, '')
    .trim()
  if (baseQuery && isTitleMatch(title, baseQuery)) return true
  const itemBase = String(title)
    .replace(/\s*[-–]\s*season\s*\d+.*$/i, '')
    .replace(/\s*s\d+\s*e\d+.*$/i, '')
    .trim()
  if (baseQuery && isTitleMatch(itemBase, baseQuery)) return true
  const qTokens = cleanTitleForMatching(baseQuery || query)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !['season', 'episode', 'complete', 'series', 'download'].includes(t))
  if (!qTokens.length) return true
  const tClean = cleanTitleForMatching(title)
  const hits = qTokens.filter((t) => tClean.includes(t))
  if (hits.length === 0) return Boolean(qTokens[0] && tClean.includes(qTokens[0]))
  return hits.length >= Math.ceil(qTokens.length * 0.5)
}

function deduplicateAndSyncThumbnails(items, query = null) {
  if (!Array.isArray(items)) return []
  const seenUrls = new Set()
  const seenTitles = new Set()
  const q = query && String(query).trim()

  const kept = items.filter((item) => {
    if (!item) return false

    // Soft title filter only — strict isTitleMatch was wiping entire providers
    // (netnaija / maxcinema / fztvseries) when titles had quality tags.
    if (q) {
      const isDirectOrMovie = item.isDirect || item.type === 'direct' || item.type === 'movie' || item.type === 'anime' || ['o2tv', 'tvshows4mobile', 'omdb'].includes(item.source)
      if (isDirectOrMovie && !softClientTitleMatch(item.title, q)) {
        return false
      }
    }

    let thumb = item.thumbnail || item.image || item.poster || null
    if (!isSuitableThumbnail(thumb)) {
      thumb = null
    }
    item.thumbnail = thumb
    item.image = thumb

    const urlKey = String(item.url || item.link || item.id || '').trim().toLowerCase()
    if (!urlKey || seenUrls.has(urlKey)) return false
    seenUrls.add(urlKey)

    // Dedup by title+source so two providers can share a title
    const titleKey = `${cleanTitleForMatching(item.title || '')}::${item.source || ''}`
    if (titleKey && titleKey.length > 5 && seenTitles.has(titleKey)) {
      return false
    }
    if (titleKey) seenTitles.add(titleKey)

    return true
  })

  // Never wipe the whole result set when titles are noisy (Nkiri "Silo S03 | TV Series")
  if (kept.length === 0 && items.length > 0) {
    const fallback = []
    const seen = new Set()
    for (const item of items) {
      if (!item) continue
      const urlKey = String(item.url || item.link || item.id || '').trim().toLowerCase()
      if (!urlKey || seen.has(urlKey)) continue
      seen.add(urlKey)
      let thumb = item.thumbnail || item.image || item.poster || null
      if (!isSuitableThumbnail(thumb)) thumb = null
      item.thumbnail = thumb
      item.image = thumb
      fallback.push(item)
      if (fallback.length >= 40) break
    }
    return fallback
  }
  return kept
}

export function useUnifiedSearch() {
  const { user } = useAuth()
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [searchMeta, setSearchMeta] = useState(null)

  const cacheRef = useRef(new Map())
  const abortControllerRef = useRef(null)
  const resultsRef = useRef([])
  const offsetRef = useRef(0)
  const lastSearchRef = useRef(null)

  const clear = useCallback(() => {
    setResults([])
    resultsRef.current = []
    setError(null)
    setHasMore(false)
    setSearchMeta(null)
    offsetRef.current = 0
    lastSearchRef.current = null
    abortControllerRef.current?.abort()
  }, [])

  const search = useCallback(async ({ layer, query, options = {}, append = false }) => {
    const trimmedQuery = query?.trim()
    if (!trimmedQuery) {
      setError('Please enter a search query')
      return []
    }

    const normalizedOptions = { ...options }
    const cacheKey = `${layer}:${trimmedQuery}:${JSON.stringify(normalizedOptions)}`
    const cached = !append ? cacheRef.current.get(cacheKey) : null

    lastSearchRef.current = { layer, query: trimmedQuery, options: normalizedOptions }

    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      resultsRef.current = cached.data
      offsetRef.current = cached.data.length
      setResults(cached.data)
      setHasMore(cached.hasMore)
      setError(null)
      return cached.data
    }

    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    const requestOffset = append ? offsetRef.current : 0

    setLoading(true)
    setError(null)

    try {
      if (!user) throw new Error('Sign in to search media')
      const token = await user.getIdToken()
      const res = await fetch(apiPath('/api/media'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'search',
          layer,
          query: trimmedQuery,
          options: {
            ...normalizedOptions,
            limit: layer === 'youtube' ? 15 : 25,
            offset: requestOffset,
          },
        }),
        signal: controller.signal,
      })

      let data
      try {
        data = await parseJsonResponse(res)
      } catch (parseErr) {
        if (res.status === 504) {
          throw new Error('Search timed out — providers are slow. Try a more specific query or another layer.')
        }
        if (res.status === 429) {
          throw new Error('Too many searches — wait a moment and try again.')
        }
        throw parseErr
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      // Treat soft errors (e.g. YouTube key missing) as non-fatal if results exist
      if (data.success === false && !(data.results && data.results.length)) {
        throw new Error(data.error || 'Search failed')
      }
      if (data.error && (!data.results || data.results.length === 0)) {
        // Surface provider-specific soft errors (e.g. "YouTube: API key not configured")
        throw new Error(data.error)
      }

      const newResults = data.results || []
      const combined = append ? [...resultsRef.current, ...newResults] : newResults
      const finalResults = deduplicateAndSyncThumbnails(combined, trimmedQuery)
      const nextHasMore = data.hasMore === true

      resultsRef.current = finalResults
      offsetRef.current = requestOffset + newResults.length
      setResults(finalResults)
      setHasMore(nextHasMore)
      setSearchMeta({
        searchedSites: data.searchedSites || [],
        multiLayerCascaded: data.multiLayerCascaded === true,
      })

      if (!append) {
        cacheRef.current.set(cacheKey, {
          data: finalResults,
          hasMore: nextHasMore,
          timestamp: Date.now(),
        })
      }

      return finalResults
    } catch (err) {
      if (err.name === 'AbortError') return []
      setError(err.message || 'Search failed')
      if (!append) {
        resultsRef.current = []
        setResults([])
      }
      return []
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
        setLoading(false)
      }
    }
  }, [user])

  const loadMore = useCallback(() => {
    if (loading || !hasMore || !lastSearchRef.current) return Promise.resolve([])
    return search({ ...lastSearchRef.current, append: true })
  }, [loading, hasMore, search])

  const refresh = useCallback(() => {
    const current = lastSearchRef.current
    cacheRef.current.clear()
    if (!current) return Promise.resolve([])
    return search(current)
  }, [search])

  return {
    results,
    loading,
    error,
    hasMore,
    searchMeta,
    search,
    loadMore,
    clear,
    refresh,
  }
}
