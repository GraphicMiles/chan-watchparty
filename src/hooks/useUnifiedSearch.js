import { useState, useCallback, useRef } from 'react'
import { useAuth } from '../shared/auth/hooks/useAuth.jsx'

const API_URL = import.meta.env.VITE_API_URL || ''
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

export function useUnifiedSearch() {
  const { user } = useAuth()
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [hasMore, setHasMore] = useState(false)

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
      const res = await fetch(`${API_URL}/api/media`, {
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
            limit: 20,
            offset: requestOffset,
          },
        }),
        signal: controller.signal,
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      if (!data.success) throw new Error(data.error || 'Search failed')

      const newResults = data.results || []
      const finalResults = append ? [...resultsRef.current, ...newResults] : newResults
      const nextHasMore = data.hasMore === true

      resultsRef.current = finalResults
      offsetRef.current = requestOffset + newResults.length
      setResults(finalResults)
      setHasMore(nextHasMore)

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
    search,
    loadMore,
    clear,
    refresh,
  }
}
