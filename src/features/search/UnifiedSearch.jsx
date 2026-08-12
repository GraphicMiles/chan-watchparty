import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Compass, PlayCircle, Link2, Tv, Trophy, ShieldAlert,
  Search, X, Loader2, Film, AlertCircle
} from 'lucide-react'
import styles from './UnifiedSearch.module.scss'
import { useUnifiedSearch } from '../../hooks/useUnifiedSearch'
import { useAuth } from '../../shared/auth/hooks/useAuth.jsx'
import { isDirectVideoUrl, normalizePlaybackUrl } from '../../shared/lib/youtube.js'
import { Modal, Button, useToast } from '../../shared/ui/index.js'
import { ShowBrowser } from '../../shared/components/ShowBrowser.jsx'
import { cleanMediaTitle } from '../../shared/lib/titleFormat.js'
import { apiPath, parseJsonResponse } from '../../shared/lib/api.js'

// NSFW is intentionally NOT in the chips row — it's age-gated behind an
// account-level setting (removed from the visible filter row per the redesign).
// utility: true = secondary browse entry (subtle styling). The description is
// surfaced as the search input placeholder so there is no separate label bar
// between the tabs and the search field.
const SEARCH_LAYERS = [
  { id: 'all', label: 'All Media', icon: Compass, description: 'Search across all sources', placeholder: 'Search movies, shows, live TV & sports…', utility: false },
  { id: 'youtube', label: 'YouTube', icon: PlayCircle, description: 'Search YouTube videos', placeholder: 'Search YouTube…', utility: false },
  { id: 'direct', label: 'Direct Links', icon: Link2, description: 'Nkiri shows via DownloadWella', placeholder: 'Search TV shows & movies (Silo, House of the Dragon…) or paste a link', utility: true },
  { id: 'iptv', label: 'IPTV', icon: Tv, description: 'Live TV channels', placeholder: 'Search live TV channels…', utility: true },
  { id: 'sports', label: 'Sports', icon: Trophy, description: 'Live sports events', placeholder: 'Search live sports…', utility: true },
]

const TRENDING = {
  all: ['Silo', 'House of the Dragon', 'Premier League'],
  youtube: ['Alan Walker Live', 'Top Movies 2026'],
  direct: ['Silo', 'House of the Dragon', 'Squid Game', 'The Last of Us'],
  iptv: ['CNN News', 'ESPN Sports', 'BBC World'],
  sports: ['Premier League', 'Champions League'],
  nsfw: ['Trending', 'Popular'],
}

export default function UnifiedSearch() {
  const navigate = useNavigate()
  const location = useLocation()
  const { toast } = useToast()
  const isMediaRoute = location.pathname === '/media'
  const [searchParams] = useSearchParams()

  // Chips/Home hand-off: ?layer=direct&q=silo
  const paramLayer = searchParams.get('layer') || ''
  const paramQuery = searchParams.get('q') || ''

  const [activeLayer, setActiveLayer] = useState(
    SEARCH_LAYERS.some((l) => l.id === paramLayer) ? paramLayer : (isMediaRoute ? 'direct' : 'all')
  )
  const [query, setQuery] = useState(paramQuery)
  const initialSearchDoneRef = useRef(false)
  const [adultVerified, setAdultVerified] = useState(false)
  const [showNsfwModal, setShowNsfwModal] = useState(false)
  const [pendingNsfwAction, setPendingNsfwAction] = useState(null)

  const { results, loading, error, search, clear, hasMore, loadMore } = useUnifiedSearch()

  const currentLayer = useMemo(() => SEARCH_LAYERS.find(l => l.id === activeLayer), [activeLayer])
  const CurrentLayerIcon = currentLayer?.icon || Film
  const trending = TRENDING[activeLayer] || TRENDING.all

  // Run once on mount if the home search bar handed us a query.
  useEffect(() => {
    initialSearchDoneRef.current = true
    if (!paramQuery) return
    setQuery(paramQuery)
    const t = setTimeout(() => { runSearchRef.current?.(paramQuery) }, 60)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Search-as-you-type: debounce runs whenever the query changes (450ms).
  // The mount effect handles the ?q= hand-off; this skips that first pass.
  useEffect(() => {
    if (activeLayer === 'direct') return // direct layer uses ShowBrowser
    const q = query.trim()
    if (!q) return
    if (initialSearchDoneRef.current === false) return
    const t = setTimeout(() => runSearchRef.current?.(q), 450)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, activeLayer])

  const runSearchRef = useRef(null)

  const runSearch = useCallback(async (targetQuery = query.trim()) => {
    if (!targetQuery) {
      toast('Please enter a search query', { variant: 'warning' })
      return
    }
    if (activeLayer === 'nsfw' && !adultVerified) {
      setPendingNsfwAction({ type: 'search', query: targetQuery })
      setShowNsfwModal(true)
      return
    }
    await search({
      layer: activeLayer,
      query: targetQuery,
      options: { adultVerified, resolve: activeLayer === 'nsfw' },
    })
  }, [activeLayer, query, search, adultVerified, toast])

  useEffect(() => {
    runSearchRef.current = runSearch
  }, [runSearch])

  // Direct layer hands off to the shared ShowBrowser (P1: one browser).
  const handleDirectPick = useCallback((content) => {
    if (!content) return
    const params = new URLSearchParams()
    if (content.kind === 'youtube' && content.videoId) {
      params.set('video', content.videoId)
      params.set('type', 'youtube')
    } else if (content.url) {
      params.set('videoUrl', content.url)
      params.set('type', content.videoType || 'direct')
      if (content.pendingResolve) {
        if (content.showSlug) params.set('showSlug', content.showSlug)
        if (content.showName) params.set('showName', content.showName)
      }
    }
    if (content.title) params.set('title', content.title)
    if (content.thumbnail) params.set('thumbnail', content.thumbnail)
    if (content.videoType === 'iptv' || content.videoType === 'sports') params.set('isLive', 'true')
    if (content.sourceUrl) params.set('sourceUrl', content.sourceUrl)
    navigate(`/create?${params.toString()}`, { state: { from: location.pathname } })
  }, [navigate, location.pathname])

  const handleLayerClick = useCallback((layerId) => {
    if (layerId === 'nsfw' && !adultVerified) {
      setPendingNsfwAction({ type: 'switch', layer: layerId })
      setShowNsfwModal(true)
      return
    }
    setActiveLayer(layerId)
    clear()
  }, [adultVerified, clear])

  const handleTrendingClick = useCallback((item) => {
    // Just set the query — the debounced search-as-you-type effect runs it.
    setQuery(item)
  }, [])

  const handleNsfwConfirm = useCallback(() => {
    setAdultVerified(true)
    setShowNsfwModal(false)
    if (pendingNsfwAction?.type === 'switch') {
      setActiveLayer(pendingNsfwAction.layer)
    } else if (pendingNsfwAction?.type === 'search') {
      setTimeout(() => runSearch(pendingNsfwAction.query), 50)
    }
    setPendingNsfwAction(null)
  }, [pendingNsfwAction, runSearch])

  const clearSearch = useCallback(() => {
    setQuery('')
    clear()
  }, [clear])

  // Apply dark theme when media page mounts
  useEffect(() => {
    document.body.classList.add('room-theme')
    return () => document.body.classList.remove('room-theme')
  }, [])

  return (
    <div className={styles.unifiedSearch}>
      {/* Header */}
      <div className={styles.header}>
        <h1>Media Browser</h1>
        <p className={styles.subtitle}>Search movies, shows, live TV, and sports — watch together in sync</p>
      </div>

      {/* Layer Tabs — one consistent grid (3-col on mobile so no button is
          orphaned). Utility sources (Direct Links / IPTV / Sports) get a
          subtler weight than All Media / YouTube. */}
      <div className={styles.layerTabs}>
        {SEARCH_LAYERS.map(layer => {
          const Icon = layer.icon
          return (
            <button
              key={layer.id}
              type="button"
              className={`${styles.tab} ${activeLayer === layer.id ? styles.active : ''} ${layer.adult ? styles.adult : ''} ${layer.utility ? styles.utility : ''}`}
              onClick={() => handleLayerClick(layer.id)}
            >
              <Icon size={14} />
              <span className={styles.label}>{layer.label}</span>
            </button>
          )
        })}
      </div>

      {/* Search Form — hidden on the direct layer, which uses ShowBrowser */}
      {activeLayer !== 'direct' && (
        <div className={styles.searchForm}>
          <form onSubmit={(e) => { e.preventDefault(); runSearch() }} className={styles.searchBarWrapper}>
            <div className={styles.inputInner}>
              <Search size={16} className={styles.searchIcon} />
              <input
                id="unified-search-input"
                type="text"
                className={styles.searchInput}
                placeholder={currentLayer?.placeholder || 'Search...'}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className={styles.searchButtonsRow}>
              {query && (
                <button type="button" onClick={clearSearch} className={styles.clearBtn} title="Clear">
                  <X size={14} />
                </button>
              )}
              <button type="submit" className={styles.searchBtn} disabled={loading} title="Search" aria-label="Search">
                {loading ? <Loader2 size={16} className={styles.spin} /> : <Search size={16} />}
              </button>
            </div>
          </form>

          {/* Trending */}
          {trending.length > 0 && (
            <div className={styles.trendingContainer}>
              <div className={styles.trendingHeader}>Trending</div>
              <div className={styles.trendingPills}>
                {trending.map((item, i) => (
                  <button key={i} type="button" className={styles.trendingPill} onClick={() => handleTrendingClick(item)}>
                    {item}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && activeLayer !== 'direct' && (
        <div className={styles.error}>
          <AlertCircle size={16} />
          <span>{error}</span>
          <button type="button" onClick={clearSearch}>Dismiss</button>
        </div>
      )}

      {/* Direct Links: the shared browser */}
      {activeLayer === 'direct' && (
        <div className={styles.directBrowser}>
          <ShowBrowser
            onPick={handleDirectPick}
            initialMode="tv"
            // The outer layer tabs above already cover source selection
            // (Direct Links / YouTube / IPTV / Sports) — showing the browser's
            // own TV/YouTube toggle here stacked two source selectors for one
            // concept. The browser's internal toggle stays on standalone
            // embeds (CreateRoomPage) where there are no outer tabs.
            hideModeTabs
            placeholder="Search TV shows &amp; movies (Silo, House of the Dragon…) or paste a link"
          />
        </div>
      )}

      {/* Other Layers: Results */}
      {activeLayer !== 'direct' && results.length > 0 && (
        <>
          <div className={styles.resultsHeader}>
            <h2>{results.length} result{results.length !== 1 ? 's' : ''}</h2>
            <button type="button" onClick={clearSearch} className={styles.clearAll}>Clear All</button>
          </div>

          <div className={styles.resultsGrid}>
            {results.map((result, idx) => (
              <ResultCard key={result.id || result.url || idx} result={result} layer={activeLayer} />
            ))}
          </div>

          {hasMore && (
            <div className={styles.loadMore}>
              <button type="button" onClick={loadMore} disabled={loading}>
                {loading ? <Loader2 size={14} className={styles.spin} /> : null}
                {loading ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}
        </>
      )}

      {/* Empty State */}
      {activeLayer !== 'direct' && !loading && results.length === 0 && !error && (
        <div className={styles.initial}>
          <div className={styles.initialIcon}>
            <CurrentLayerIcon size={28} />
          </div>
          <h3>{query ? 'Ready to search' : 'Search for something'}</h3>
          <p>
            {query
              ? `Tap Search to find "${query}" in ${currentLayer?.label?.toLowerCase() || 'all sources'}`
              : `Enter a query above to find ${currentLayer?.label?.toLowerCase() || 'content'}`}
          </p>
        </div>
      )}

      {/* NSFW Modal */}
      <Modal open={showNsfwModal} title="Age Verification Required" icon={ShieldAlert} onClose={() => setShowNsfwModal(false)}>
        <div className={styles.nsfwModalBody}>
          <p className={styles.nsfwModalText}>You must be 18 or older to access adult content.</p>
          <p className={styles.nsfwModalSubtext}>By continuing, you confirm you are of legal age in your jurisdiction.</p>
          <div className={styles.nsfwModalActions}>
            <Button variant="secondary" onClick={() => setShowNsfwModal(false)}>Cancel</Button>
            <Button variant="danger" onClick={handleNsfwConfirm}>I am 18+</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

// Result Card Component
function ResultCard({ result, layer }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuth()
  const { toast } = useToast()
  const [added, setAdded] = useState(false)
  const thumb = result.thumbnail || result.image || null

  const handleClick = useCallback(async () => {
    if ((result.type || layer) === 'youtube' && result.id) {
      navigate(`/create?video=${result.id}&title=${encodeURIComponent(result.title || 'Untitled')}&type=youtube`, { state: { from: location.pathname } })
      return
    }
    if (result.type === 'iptv' || result.isLive) {
      const liveUrl = result.rawUrl || result.url || result.link
      const playback = /\/api\/proxy\?/i.test(String(result.url || ''))
        ? String(result.url)
        : normalizePlaybackUrl(liveUrl, { forceProxy: true })
      const params = new URLSearchParams({
        videoUrl: playback,
        title: result.title || 'Live Stream',
        type: result.type === 'sports' ? 'sports' : 'iptv',
        isLive: 'true',
      })
      navigate(`/create?${params.toString()}`, { state: { from: location.pathname } })
      return
    }
    const sourceKey = String(result.source || '').toLowerCase()
    if (sourceKey === 'o2tv' || result.o2tvKind === 'show' || /tvshows4mobile|o2tv/i.test(result.url || '')) {
      const params = new URLSearchParams({
        videoUrl: result.url || '',
        title: result.title || 'Untitled',
        type: 'direct',
      })
      if (result.showSlug) params.set('showSlug', result.showSlug)
      if (result.showName) params.set('showName', result.showName)
      navigate(`/create?${params.toString()}`, { state: { from: location.pathname } })
      return
    }
    if (result.isDirect || result.playableInRoom || isDirectVideoUrl(result.url || '')) {
      const params = new URLSearchParams({
        videoUrl: normalizePlaybackUrl(result.url || result.link || ''),
        title: result.title || 'Video',
        type: ['iptv', 'sports', 'nsfw'].includes(result.type) ? result.type : 'direct',
      })
      navigate(`/create?${params.toString()}`, { state: { from: location.pathname } })
      return
    }
    if (user) {
      try {
        const token = await user.getIdToken()
        const res = await fetch(apiPath('/api/media'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'scrape', url: result.url || result.link, options: { resolve: true } }),
        })
        const data = await parseJsonResponse(res)
        const directItem = data.results?.find(r => r.isDirect || r.playableInRoom)
        if (directItem?.url) {
          const params = new URLSearchParams({
            videoUrl: normalizePlaybackUrl(directItem.url),
            title: directItem.title || result.title || 'Video',
            type: 'direct',
          })
          navigate(`/create?${params.toString()}`, { state: { from: location.pathname } })
          return
        }
      } catch { /* fallback */ }
    }
    toast('Could not resolve this result. Try another option.', { variant: 'error' })
  }, [result, layer, navigate, location.pathname, user, toast])

  return (
    <div className={styles.resultCard} onClick={handleClick}>
      {/* Thumbnail with play overlay */}
      <div className={styles.thumb}>
        {thumb ? (
          <img src={thumb} alt={cleanMediaTitle(result.title)} loading="lazy" className={styles.thumbImg} onError={(e) => { e.currentTarget.style.display = 'none' }} />
        ) : (
          <div className={styles.noThumb}><Film size={22} /></div>
        )}
        <span className={styles.playOverlay}><span className={styles.playCircle}>▶</span></span>
        {result.isLive && <span className={styles.liveBadge}>LIVE</span>}
        {result.quality && <span className={styles.qualityBadge}>{result.quality}</span>}
      </div>
      <div className={styles.cardBody}>
        <h3 className={styles.cardTitle}>{cleanMediaTitle(result.title)}</h3>
        <div className={styles.cardMeta}>
          <span className={styles.sourceChip} data-source={String(result.source || layer).toLowerCase()}>
            {String(result.source || layer).toLowerCase() === 'youtube' ? '▶ YouTube' : String(result.source || layer)}
          </span>
          <button
            type="button"
            className={`${styles.watchBtn} ${added ? styles.watchAdded : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              setAdded(true)
              setTimeout(() => setAdded(false), 1200)
              handleClick()
            }}
          >
            {added ? 'Added' : (result.isLive ? 'Watch Live' : 'Watch')}
          </button>
        </div>
      </div>
    </div>
  )
}
