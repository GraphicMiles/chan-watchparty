import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'
import { Search, Loader2, ChevronLeft, Youtube, Tv, AlertCircle, Link2 } from 'lucide-react'
import styles from './ShowBrowser.module.css'
import { useScraper } from '../../hooks/useScraper.js'
import { useAuth } from '../auth/hooks/useAuth.jsx'
import { isO2TvUrl, isDirectVideoUrl, normalizePlaybackUrl, getThumbnail } from '../lib/youtube.js'
import { isSuitableThumbnail } from '../lib/mediaHelper.js'
import { cleanMediaTitle } from '../lib/titleFormat.js'
import { mediaPost, resolveDownloadLink, friendlyApiError } from '../lib/mediaApi.js'
import { useToast } from '../ui/index.js'

function parseShowSlugFromUrl(value) {
  try {
    const u = new URL(value)
    if (!isO2TvUrl(u.href)) return null
    if (/o2tv\.org/i.test(u.hostname)) return null
    const parts = u.pathname.split('/').filter(Boolean)
    return parts[0] || null
  } catch {
    return null
  }
}

function safeThumb(url) {
  return isSuitableThumbnail(url) ? url : null
}

/**
 * The ONE hierarchical media browser (P1 consolidation).
 *
 * Replaces three duplicate implementations:
 *  - CreateRoomPage's YouTube search + O2TV/Nkiri browser
 *  - UnifiedSearch's direct layer + EpisodesModal
 *  - RoomPage's "Change Video" search
 *
 * Search → results → (O2TV: show → seasons → episodes) → onPick(content)
 *
 * content contract (see shared/lib/createRoom.js):
 *   { kind: 'youtube', videoId, url, title, thumbnail, videoType }
 *   { kind: 'direct',  url, title, thumbnail, videoType, source?, pendingResolve? }
 */
export const ShowBrowser = forwardRef(function ShowBrowser(
  { onPick, initialMode = 'tv', placeholder, compact = false, hideModeTabs = false, className },
  ref
) {
  const { user } = useAuth()
  const { toast } = useToast()
  const { results: tvResults, loading: tvLoading, error: tvError, clear: clearTv, scrape } = useScraper()

  const [mode, setMode] = useState(initialMode) // 'tv' | 'youtube'
  const [query, setQuery] = useState('')
  const [ytResults, setYtResults] = useState([])
  const [ytLoading, setYtLoading] = useState(false)
  const [searchError, setSearchError] = useState(null)

  // Hierarchical browse state (O2TV / Nkiri)
  const [stage, setStage] = useState(null) // null | 'seasons' | 'episodes'
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState(null)
  const [showSlug, setShowSlug] = useState('')
  const [showName, setShowName] = useState('')
  const [showThumb, setShowThumb] = useState(null)
  const [seasons, setSeasons] = useState([])
  const [episodes, setEpisodes] = useState([])
  const [seasonNum, setSeasonNum] = useState(null)
  const [resolvingIdx, setResolvingIdx] = useState(null)
  const abortRef = useRef(0)

  const emit = useCallback((content) => {
    onPick?.(content)
  }, [onPick])

  // ── Search ───────────────────────────────────────────────────────────

  const runSearch = useCallback(async (q = query) => {
    const target = String(q || '').trim()
    if (!target) {
      toast('Enter a title to search', { variant: 'warning' })
      return
    }
    if (!user) {
      toast('Sign in to search', { variant: 'warning' })
      return
    }
    setQuery(target)
    setSearchError(null)
    setBrowseError(null)
    setStage(null)
    clearTv()

    if (mode === 'youtube') {
      setYtLoading(true)
      setYtResults([])
      try {
        const data = await mediaPost(user, {
          action: 'search',
          layer: 'youtube',
          query: target,
          options: { limit: 12 },
        })
        const items = (data.results || []).map((it) => ({
          id: it.id,
          title: it.title,
          thumbnail: it.thumbnail,
          channel: it.channel,
          source: 'youtube',
          url: `https://www.youtube.com/watch?v=${it.id}`,
          embeddable: it.embeddable !== false,
        }))
        setYtResults(items)
        if (!items.length) toast('No YouTube results', { variant: 'warning' })
      } catch (err) {
        setSearchError(friendlyApiError(err.message || 'YouTube search failed'))
      } finally {
        setYtLoading(false)
      }
      return
    }

    // TV / direct mode via the scraper hook (server-side, same as before)
    await scrape({ query: target, site: 'o2tv' })
  }, [query, mode, user, toast, clearTv, scrape])

  const switchMode = useCallback((next) => {
    if (next === mode) return
    setMode(next)
    setQuery('')
    setSearchError(null)
    setBrowseError(null)
    setStage(null)
    setSeasons([])
    setEpisodes([])
    clearTv()
    setYtResults([])
  }, [mode, clearTv])

  // ── O2TV hierarchical browse ─────────────────────────────────────────

  const loadSeasons = useCallback(async (slug, name, thumb) => {
    if (!slug) {
      setBrowseError('Missing show reference. Go back and pick a show from search.')
      return
    }
    const reqId = ++abortRef.current
    setBrowseLoading(true)
    setBrowseError(null)
    setStage('seasons')
    setSeasons([])
    setEpisodes([])
    setShowSlug(slug)
    setShowName(name || slug.replace(/-/g, ' '))
    if (thumb) setShowThumb(safeThumb(thumb))
    try {
      const data = await mediaPost(user, {
        action: 'o2tvSeasons',
        showSlug: slug,
        showName: name || undefined,
        thumbnail: thumb || undefined,
      })
      if (reqId !== abortRef.current) return
      const list = Array.isArray(data.results) ? data.results : []
      setSeasons(list)
      if (data.showName) setShowName(data.showName)
      if (data.showSlug) setShowSlug(data.showSlug)
      if (data.thumbnail) setShowThumb(safeThumb(data.thumbnail) || showThumb)
      if (!list.length) setBrowseError('No seasons found for this show. Try another result or paste a direct .mp4 link.')
    } catch (err) {
      if (reqId !== abortRef.current) return
      setBrowseError(friendlyApiError(err.message || 'Failed to load seasons'))
    } finally {
      if (reqId === abortRef.current) setBrowseLoading(false)
    }
  }, [user, showThumb])

  const loadEpisodes = useCallback(async (season) => {
    const num = season?.seasonNum || season?.number
    if (!showSlug || !num) return
    const reqId = ++abortRef.current
    setBrowseLoading(true)
    setBrowseError(null)
    setStage('episodes')
    setEpisodes([])
    setSeasonNum(num)
    try {
      const data = await mediaPost(user, {
        action: 'o2tvEpisodes',
        showSlug,
        showName,
        seasonNum: num,
        thumbnail: showThumb || undefined,
      })
      if (reqId !== abortRef.current) return
      const list = Array.isArray(data.results) ? data.results : []
      setEpisodes(list)
      if (!list.length) setBrowseError('No episodes found for this season.')
    } catch (err) {
      if (reqId !== abortRef.current) return
      setBrowseError(friendlyApiError(err.message || 'Failed to load episodes'))
    } finally {
      if (reqId === abortRef.current) setBrowseLoading(false)
    }
  }, [user, showSlug, showName, showThumb])

  const loadNkiriEpisodes = useCallback(async (showUrl, showNameArg) => {
    const reqId = ++abortRef.current
    setBrowseLoading(true)
    setBrowseError(null)
    setStage('episodes')
    setEpisodes([])
    if (showNameArg) setShowName(showNameArg)
    try {
      const data = await mediaPost(user, { action: 'scrape', url: showUrl })
      if (reqId !== abortRef.current) return
      const list = (data.results || []).filter((r) => r.url)
      setEpisodes(list.map((r, i) => ({
        episodeNum: i + 1,
        title: r.title || `Episode ${i + 1}`,
        label: r.title || `Episode ${i + 1}`,
        url: r.url,
        thumbnail: r.thumbnail || null,
      })))
      if (!list.length) setBrowseError('No episodes found. Try another show.')
    } catch (err) {
      if (reqId !== abortRef.current) return
      setBrowseError(friendlyApiError(err.message || 'Failed to load episodes'))
    } finally {
      if (reqId === abortRef.current) setBrowseLoading(false)
    }
  }, [user])

  const resolveO2Episode = useCallback(async (ep, idx) => {
    if (!ep) return
    const epSeasonNum = ep.seasonNum || seasonNum || 1
    const epNum = ep.episodeNum || ep.number || (idx + 1)
    const epSlug = ep.showSlug || showSlug
    const reqId = ++abortRef.current
    setResolvingIdx(idx)
    setBrowseError(null)
    try {
      // Some flows (Nkiri flat episodes, pasted links) never set a show slug.
      // Calling o2tvResolve without one makes the server 400 with a raw
      // "showSlug required" validation string — instead resolve the episode
      // page directly (scrape / form-walk) which works for any page URL.
      if (!epSlug && ep.url) {
        const playUrl = await resolveDownloadLink(user, ep.url, ep.title || showName || `Episode ${epNum}`)
        if (reqId !== abortRef.current) return
        emit({
          kind: 'direct',
          url: playUrl,
          title: ep.title || ep.label || `${showName} S${String(epSeasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`,
          thumbnail: safeThumb(ep.thumbnail || showThumb),
          videoType: 'direct',
          source: ep.source || 'nkiri',
          sourceUrl: ep.url,
        })
        toast('Episode ready', { variant: 'success' })
        return
      }
      const data = await mediaPost(user, {
        action: 'o2tvResolve',
        showSlug: epSlug,
        showName: ep.showName || showName,
        seasonNum: epSeasonNum,
        episodeNum: epNum,
        thumbnail: ep.thumbnail || showThumb || undefined,
      })
      if (reqId !== abortRef.current) return
      const best = (data.results || []).find((r) => r.isDirect || r.playableInRoom || /\/api\/proxy\?/i.test(r.url || ''))
        || (data.results || [])[0]
      if (!best?.url) throw new Error('Could not resolve a playable link for this episode')
      const playUrl = normalizePlaybackUrl(best.url)
      const epTitle = best.title || ep.title || `${showName} S${String(epSeasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`
      emit({
        kind: 'direct',
        url: playUrl,
        title: epTitle,
        thumbnail: safeThumb(best.thumbnail || ep.thumbnail || showThumb),
        videoType: 'direct',
        source: 'o2tv',
        meta: best.meta || null,
      })
      toast('Episode ready', { variant: 'success' })
    } catch (err) {
      if (reqId !== abortRef.current) return
      // Single presentation point for errors: the in-panel banner. The toast
      // previously duplicated the exact same message on screen.
      setBrowseError(friendlyApiError(err.message || 'Failed to resolve episode'))
    } finally {
      if (reqId === abortRef.current) setResolvingIdx(null)
    }
  }, [user, showSlug, showName, seasonNum, showThumb, emit, toast])

  const pickEpisode = useCallback((ep, idx) => {
    // DownloadWella / fsmc page URLs are re-resolved FRESH at create time
    // (they expire fast). The room's change-video path resolves them upfront.
    if (/downloadwella\.com|fsmc/i.test(ep.url || '')) {
      emit({
        kind: 'direct',
        url: ep.url,
        title: ep.title || ep.label || `${showName} Episode ${idx + 1}`,
        thumbnail: safeThumb(ep.thumbnail || showThumb),
        videoType: 'direct',
        source: 'nkiri',
        pendingResolve: true,
        sourceUrl: ep.url, // keep the page URL so re-resolve can get a fresh token
      })
      toast('Episode selected — link will be resolved when the room starts', { variant: 'success' })
      return
    }
    resolveO2Episode(ep, idx)
  }, [emit, showName, showThumb, resolveO2Episode, toast])

  // ── Result click (ported from the old selectVideo) ───────────────────

  const selectResult = useCallback(async (item) => {
    setBrowseError(null)
    setSearchError(null)

    // YouTube result
    if (item.source === 'youtube' && item.id) {
      emit({
        kind: 'youtube',
        videoId: item.id,
        url: item.url || `https://youtube.com/watch?v=${item.id}`,
        title: item.title,
        thumbnail: safeThumb(item.thumbnail) || getThumbnail(item.id),
        videoType: 'youtube',
      })
      return
    }

    const candidate = item.link || item.url || ''
    const candidateStr = typeof candidate === 'string' ? candidate : ''
    const itemTitle = typeof item.title === 'string' ? item.title : (item.title != null ? String(item.title) : '')
    const thumb = safeThumb(item.thumbnail || item.image)

    // Already playable (proxy / mp4) — pick immediately
    if (item.isDirect || item.playableInRoom || isDirectVideoUrl(candidateStr) || /\/api\/proxy\?/i.test(candidateStr)) {
      if (!candidateStr) {
        toast('That result has no usable URL.', { variant: 'warning' })
        return
      }
      emit({
        kind: 'direct',
        url: normalizePlaybackUrl(candidateStr),
        title: itemTitle || 'Direct video',
        thumbnail: thumb,
        videoType: 'direct',
        source: item.source || 'direct',
        meta: item.meta || item.quality || null,
      })
      return
    }

    // O2TV show listing → seasons browser
    const isO2ShowBrowse = item.o2tvKind === 'show'
      || ((item.source === 'o2tv' || isO2TvUrl(candidateStr)) && !isDirectVideoUrl(candidateStr) && !/\/api\/proxy\?/i.test(candidateStr))
    if (isO2ShowBrowse) {
      const slug = item.showSlug || parseShowSlugFromUrl(candidateStr)
      if (slug) {
        await loadSeasons(slug, item.showName || itemTitle || 'TV Show', thumb)
        return
      }
    }

    // Nkiri show page → flat episodes
    if ((item.source === 'nkiri' || /thenkiri\.com|nkiri\.com/i.test(candidateStr)) && !isDirectVideoUrl(candidateStr)) {
      await loadNkiriEpisodes(candidateStr, itemTitle || 'TV Show')
      return
    }

    // DownloadWella episode link → resolve immediately (form-walk to the CDN file)
    if (/downloadwella\.com|fsmc/i.test(candidateStr)) {
      setResolvingIdx(-1)
      try {
        const playUrl = await resolveDownloadLink(user, candidateStr, itemTitle)
        emit({
          kind: 'direct',
          url: playUrl,
          title: itemTitle || 'Direct video',
          thumbnail: safeThumb(item.thumbnail || item.image),
          videoType: 'direct',
          source: 'nkiri',
          sourceUrl: candidateStr, // keep the page URL for later re-resolve
        })
      } catch (err) {
        toast(err.message || 'Failed to resolve episode', { variant: 'error' })
      } finally {
        setResolvingIdx(null)
      }
      return
    }

    // Requires a manual step on the source site
    if (item.requiresUserAction && candidateStr) {
      window.open(candidateStr, '_blank', 'noopener,noreferrer')
      toast('Opened the page. Complete any download step there, then paste the final HTTPS video URL into Chan.', {
        variant: 'info',
        duration: 8000,
      })
      return
    }

    // Generic page link → extract playable links in place
    if (candidateStr) {
      setQuery('')
      await scrape({ url: candidateStr, site: 'custom' })
      toast('Links extracted — pick a playable file below', { variant: 'info', duration: 4000 })
      return
    }

    toast('That result has no usable URL.', { variant: 'warning' })
  }, [emit, user, toast, loadSeasons, loadNkiriEpisodes, scrape])

  // ── Imperative API (used by CreateRoomPage presets / pasted O2TV URLs) ──

  useImperativeHandle(ref, () => ({
    reset() {
      abortRef.current += 1
      setStage(null)
      setSeasons([])
      setEpisodes([])
      setBrowseError(null)
      setSearchError(null)
      setShowSlug('')
      setShowName('')
      setShowThumb(null)
      clearTv()
      setYtResults([])
      setQuery('')
    },
    openShowBySlug(slug, name, thumb) {
      setMode('tv')
      setQuery('')
      setYtResults([])
      clearTv()
      return loadSeasons(slug, name, thumb)
    },
    openPageUrl(url, name) {
      if (isDirectVideoUrl(url)) {
        emit({
          kind: 'direct',
          url: normalizePlaybackUrl(url),
          title: name || 'Direct video',
          thumbnail: null,
          videoType: 'direct',
          source: 'direct',
        })
        return
      }
      const slug = parseShowSlugFromUrl(url)
      if (slug) {
        setMode('tv')
        clearTv()
        return loadSeasons(slug, name || slug.replace(/-/g, ' '), null)
      }
      setMode('tv')
      return scrape({ url, site: 'custom' })
    },
  }), [emit, loadSeasons, scrape, clearTv])

  // ── Render helpers ────────────────────────────────────────────────────

  const loading = tvLoading || ytLoading || browseLoading
  const error = searchError || tvError || browseError
  const results = mode === 'youtube' ? ytResults : tvResults
  const isBusy = Boolean(resolvingIdx !== null)

  const renderGrid = () => {
    if (stage === 'seasons') {
      return (
        <div className={styles.group}>
          <div className={styles.showHeader}>
            {showThumb && <img src={showThumb} alt="" className={styles.showPoster} onError={(e) => { e.currentTarget.style.display = 'none' }} />}
            <div className={styles.showHeaderText}>
              <h3 className={styles.showName}>{cleanMediaTitle(showName) || 'Select a season'}</h3>
              <button type="button" className={styles.backLink} onClick={() => { setStage(null); setSeasons([]); setShowSlug('') }}>
                <ChevronLeft size={14} /> Back to results
              </button>
            </div>
          </div>
          <div className={styles.grid}>
            {seasons.map((season, idx) => (
              <button
                key={season.seasonNum || season.url || idx}
                type="button"
                className={styles.tile}
                onClick={() => loadEpisodes(season)}
              >
                {(season.thumbnail || showThumb) && (
                  <img src={season.thumbnail || showThumb} alt="" className={styles.tileThumb} onError={(e) => { e.currentTarget.style.display = 'none' }} />
                )}
                <span className={styles.tileTitle}>{cleanMediaTitle(season.label || season.title) || `Season ${season.seasonNum || idx + 1}`}</span>
              </button>
            ))}
          </div>
        </div>
      )
    }

    if (stage === 'episodes') {
      return (
        <div className={styles.group}>
          <div className={styles.showHeader}>
            {showThumb && <img src={showThumb} alt="" className={styles.showPoster} onError={(e) => { e.currentTarget.style.display = 'none' }} />}
            <div className={styles.showHeaderText}>
              <h3 className={styles.showName}>{cleanMediaTitle(showName) || 'Episodes'}</h3>
              <button
                type="button"
                className={styles.backLink}
                onClick={() => {
                  setStage(showSlug ? 'seasons' : null)
                  setEpisodes([])
                  setSeasonNum(null)
                  if (!showSlug) { setShowName(''); setShowThumb(null) }
                }}
              >
                <ChevronLeft size={14} /> {showSlug ? 'All seasons' : 'Back to results'}
              </button>
            </div>
          </div>
          <div className={styles.grid}>
            {episodes.map((ep, idx) => (
              <button
                key={ep.episodeNum || ep.url || idx}
                type="button"
                className={`${styles.tile} ${resolvingIdx === idx ? styles.tileBusy : ''}`}
                disabled={isBusy}
                onClick={() => pickEpisode(ep, idx)}
              >
                {(ep.thumbnail || showThumb) && (
                  <img src={ep.thumbnail || showThumb} alt="" className={styles.tileThumb} onError={(e) => { e.currentTarget.style.display = 'none' }} />
                )}
                <span className={styles.tileTitle}>{cleanMediaTitle(ep.label || ep.title) || `Episode ${ep.episodeNum || idx + 1}`}</span>
                {resolvingIdx === idx && <span className={styles.resolving}>Resolving…</span>}
              </button>
            ))}
          </div>
        </div>
      )
    }

    return (
      <div className={styles.group}>
        <div className={styles.grid}>
          {results.map((item, idx) => {
            const playable = (item.source === 'youtube' && item.id) || item.isDirect || isDirectVideoUrl(item.link || item.url)
            const thumb = safeThumb(item.thumbnail || item.image) || (item.source === 'youtube' && item.id ? getThumbnail(item.id) : null)
            return (
              <button
                key={item.id || item.link || item.url || idx}
                type="button"
                className={`${styles.tile} ${!playable ? styles.tileMuted : ''}`}
                onClick={() => selectResult(item)}
              >
                {thumb && <img src={thumb} alt="" className={styles.tileThumb} onError={(e) => { e.currentTarget.style.display = 'none' }} />}
                <span className={styles.tileTitle}>{cleanMediaTitle(item.title)}</span>
                <span className={styles.tileMeta}>
                  {item.source === 'youtube'
                    ? (item.channel || 'YouTube')
                    : item.o2tvKind === 'show' || item.source === 'o2tv'
                      ? 'TV show — open seasons'
                      : playable
                        ? 'Ready to play'
                        : 'Select to continue'}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className={`${styles.browser} ${compact ? styles.compact : ''} ${className || ''}`}>
      {!hideModeTabs && (
        <div className={styles.modeTabs}>
          <button
            type="button"
            className={mode === 'tv' ? styles.modeActive : styles.mode}
            onClick={() => switchMode('tv')}
          >
            <Tv size={13} /> TV Shows &amp; Direct
          </button>
          <button
            type="button"
            className={mode === 'youtube' ? styles.modeActive : styles.mode}
            onClick={() => switchMode('youtube')}
          >
            <Youtube size={13} /> YouTube
          </button>
        </div>
      )}

      <form
        className={styles.searchRow}
        onSubmit={(e) => { e.preventDefault(); runSearch() }}
      >
        <div className={styles.inputWrap}>
          <Search size={15} className={styles.searchIcon} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder={placeholder || (mode === 'youtube' ? 'Search YouTube…' : 'Search shows &amp; movies (Silo, House of the Dragon…)' )}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button type="submit" className={styles.searchBtn} disabled={loading}>
          {loading ? <Loader2 size={14} className={styles.spin} /> : <Search size={14} />}
          Search
        </button>
      </form>

      {error && (
        <div className={styles.error}>
          <AlertCircle size={14} />
          <span>{error}</span>
          <button type="button" className={styles.errorDismiss} onClick={() => { setSearchError(null); setBrowseError(null); clearTv() }}>
            Dismiss
          </button>
        </div>
      )}

      {loading && stage === null && (
        <div className={styles.loading}>
          <Loader2 size={22} className={styles.spin} />
          <span>{mode === 'youtube' ? 'Searching YouTube…' : 'Searching shows…'}</span>
        </div>
      )}

      {!loading && !error && stage === null && results.length === 0 && !browseError && (
        <div className={styles.empty}>
          <Link2 size={22} />
          <p>
            {mode === 'youtube'
              ? 'Search YouTube or pick a video to start a watch party.'
              : 'Search TV shows and movies (O2TV / Nkiri) or paste a direct .mp4 / .m3u8 link above.'}
          </p>
        </div>
      )}

      {!loading && (stage !== null || results.length > 0) && renderGrid()}

      {stage !== null && browseLoading && (
        <div className={styles.loading}>
          <Loader2 size={22} className={styles.spin} />
          <span>{stage === 'episodes' ? 'Loading episodes…' : 'Loading seasons…'}</span>
        </div>
      )}
    </div>
  )
})
