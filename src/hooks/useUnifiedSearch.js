import { useState, useCallback, useRef } from 'react'

const API_URL = import.meta.env.VITE_API_URL || ''
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

export function useUnifiedSearch() {
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)
  
  const cacheRef = useRef(new Map())
  const abortControllerRef = useRef(null)

  const clear = useCallback(() => {
    setResults([])
    setError(null)
    setHasMore(false)
    setOffset(0)
    abortControllerRef.current?.abort()
  }, [])

  const search = useCallback(async ({ layer, query, options = {}, append = false }) => {
    if (!query?.trim()) {
      setError('Please enter a search query')
      return []
    }

    // Cancel previous request
    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()

    const cacheKey = `${layer}:${query}:${JSON.stringify(options)}`
    const cached = cacheRef.current.get(cacheKey)
    
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      setResults(cached.data)
      setHasMore(cached.hasMore)
      setError(null)
      return cached.data
    }

    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`${API_URL}/api/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'search',
          layer, 
          query: query.trim(),
          options: {
            ...options,
            limit: 20,
            offset: append ? offset : 0
          }
        }),
        signal: abortControllerRef.current.signal,
      })
      
      const data = await res.json()
      
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      
      if (!data.success) {
        throw new Error(data.error || 'Search failed')
      }

      const newResults = data.results || []
      const finalResults = append ? [...results, ...newResults] : newResults
      
      // Cache results
      cacheRef.current.set(cacheKey, {
        data: finalResults,
        hasMore: newResults.length === 20,
        timestamp: Date.now()
      })
      
      setResults(finalResults)
      setHasMore(newResults.length === 20)
      setOffset(append ? offset + newResults.length : newResults.length)
      
      return finalResults
    } catch (err) {
      if (err.name === 'AbortError') {
        return []
      }
      setError(err.message || 'Search failed')
      if (!append) {
        setResults([])
      }
      return []
    } finally {
      setLoading(false)
    }
  }, [offset, results])

  const loadMore = useCallback(() => {
    if (!loading && hasMore) {
      // Need to get current search params from state or ref
      // This is a simplified version - in practice you'd store the current query
      return search({ layer: 'current', query: 'current', append: true })
    }
  }, [loading, hasMore, search])

  const refresh = useCallback(() => {
    cacheRef.current.clear()
    // Re-run current search if exists
  }, [])

  return { 
    results, 
    loading, 
    error, 
    hasMore,
    search, 
    loadMore,
    clear,
    refresh
  }
        }
