import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { collection, onSnapshot, query, orderBy, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore'
import { Plus, Trash2, Play, Search, Youtube, Link2, Loader2, RefreshCw, X } from 'lucide-react'
import { db } from '../../../shared/lib/firebase.js'
import { useUnifiedSearch } from '../../../hooks/useUnifiedSearch.js'
import { isDirectVideoUrl, normalizePlaybackUrl, extractVideoId, getThumbnail } from '../../../shared/lib/youtube.js'
import { isSeasonalResult, isStandaloneResult } from '../../../shared/lib/mediaType.js'
import { cleanMediaTitle } from '../../../shared/lib/titleFormat.js'
import { Input } from '../../../shared/ui/index.js'
import styles from './QueuePanel.module.scss'
import { apiPath } from '../../../shared/lib/api.js'

/**
 * QueuePanel — two modes behind two pills:
 *   Change video — pick/search a video and it PLAYS NOW (host/co-host).
 *   Queue        — line up videos; host can play a queued item immediately.
 * Both keep the YouTube ⇄ Direct source toggle composer.
 */
export default function QueuePanel({ roomId, user, canControl, onPlayNext, onChangeVideo, toast }) {
  const [queue, setQueue] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState('youtube') // 'youtube' or 'direct'
  const [view, setView] = useState('queue') // 'queue' | 'change'
  const { results, loading, search, clear } = useUnifiedSearch()

  useEffect(() => {
    if (!roomId) return undefined
    const q = query(collection(db, 'rooms', roomId, 'queue'), orderBy('createdAt', 'asc'))
    const unsub = onSnapshot(q, (snap) => {
      setQueue(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    })
    return unsub
  }, [roomId])

  // Episodes popup — a centered overlay (one at a time), styled like the
  // Media Browser's episode cards. { url, title, sourceItem, episodes,
  // loading, synopsis }
  const [episodesModal, setEpisodesModal] = useState(null)

  const openEpisodes = useCallback(async (item) => {
    const seasonUrl = item.url || item.link
    if (!seasonUrl) return
    setEpisodesModal({ url: seasonUrl, title: item.title || 'Episodes', sourceItem: item, episodes: [], loading: true, synopsis: null })
    try {
      const token = await user.getIdToken()
      const res = await fetch(apiPath('/api/media'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'scrape', url: seasonUrl }),
      })
      const data = await res.json()
      if (data.results && data.results.length > 0) {
        setEpisodesModal(prev => prev && prev.url === seasonUrl
          ? { ...prev, episodes: data.results, loading: false, synopsis: data.synopsis || null }
          : prev)
      } else {
        setEpisodesModal(prev => prev && prev.url === seasonUrl ? { ...prev, loading: false } : prev)
        toast('No episodes found on this season page', { variant: 'error' })
      }
    } catch (err) {
      console.error('Failed to fetch episodes:', err)
      toast('Failed to load episodes', { variant: 'error' })
      setEpisodesModal(prev => prev && prev.url === seasonUrl ? { ...prev, loading: false } : prev)
    }
  }, [user, toast])

  const closeEpisodes = useCallback(() => setEpisodesModal(null), [])

  // Tell the room to lock background scrolling while the popup is open
  // (and unlock when it closes).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('chan:overlay', { detail: Boolean(episodesModal) }))
  }, [episodesModal])

  // Close via Escape (or the X button).
  useEffect(() => {
    if (!episodesModal) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') closeEpisodes()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [episodesModal, closeEpisodes])

  /** Resolve a Nkiri movie page to its playable file. Returns
   *  { url, title, thumbnail } or null. Never surfaces raw filenames. */
  const resolveNkiriMovie = useCallback(async (item) => {
    const pageUrl = item.url || item.link
    if (!pageUrl) {
      toast('This result has no link', { variant: 'error' })
      return null
    }
    try {
      const token = await user.getIdToken()
      const res = await fetch(apiPath('/api/media'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'scrape', url: pageUrl, options: { resolve: true } }),
      })
      const data = await res.json()
      const direct = (data.results || []).find((r) => r.isDirect || r.playableInRoom || /\/api\/proxy\?/i.test(r.url || ''))
        || (data.results || [])[0]
      if (!direct?.url) {
        toast('Could not resolve a playable link for this movie', { variant: 'error' })
        return null
      }
      return {
        title: cleanMediaTitle(direct.title || item.title) || 'Movie',
        url: normalizePlaybackUrl(direct.url),
        thumbnail: direct.thumbnail || item.thumbnail || null,
        videoType: 'direct',
        source: 'nkiri',
      }
    } catch (err) {
      toast(err.message || 'Could not resolve movie', { variant: 'error' })
      return null
    }
  }, [user, toast])

  /** Add an item to the queue. Returns { id, payload } so callers can play it
   *  immediately, or null if nothing was queued. */
  const addToQueue = useCallback(async (item, episode = null) => {
    if (queue.length >= 5) {
      toast('Queue is full! Users can only add up to 5 media items to the queue.', { variant: 'error' })
      return null
    }

    let videoId = ''
    let videoUrl = null
    let videoType = 'youtube'

    if ((item.type || activeTab) === 'youtube' && (item.id || extractVideoId(item.url))) {
      videoId = item.id || extractVideoId(item.url)
      videoType = 'youtube'
    } else if (episode) {
      // Episode from expanded Nkiri season - resolve downloadwella
      videoUrl = episode.url
      videoType = 'direct'
      item = episode // Use episode data for title/thumbnail
    } else if (/thenkiri\.com|nkiri\.com/i.test(item.url || item.link || '')) {
      // Nkiri page — seasonal shows expand into an episode list; standalone
      // movies resolve straight to the playable file (never a nested card).
      if (isSeasonalResult(item)) {
        openEpisodes(item)
        return null
      }
      const resolved = await resolveNkiriMovie(item)
      if (!resolved) return null
      videoUrl = resolved.url
      videoType = 'direct'
      item = resolved // title/thumbnail from the resolved file
    } else if (item.isDirect || isDirectVideoUrl(item.url || item.link)) {
      videoUrl = normalizePlaybackUrl(item.url || item.link)
      videoType = 'direct'
    } else {
      toast('Selected item must be a playable video or YouTube link', { variant: 'error' })
      return null
    }

    const thumb = item.thumbnail || item.image || (videoId ? getThumbnail(videoId) : '') || ''
    const payload = {
      title: (item.title || 'Untitled').slice(0, 150),
      videoId: videoId || null,
      videoUrl: videoUrl || null,
      videoType,
      thumbnail: thumb,
      synopsis: item.synopsis || null,
      addedByUid: user?.uid || 'anonymous',
      addedByName: user?.displayName || 'Viewer',
      createdAt: serverTimestamp(),
    }

    try {
      const ref = await addDoc(collection(db, 'rooms', roomId, 'queue'), payload)
      toast('Added to queue!', { variant: 'success' })
      return { id: ref.id, payload }
    } catch (err) {
      toast(err.message || 'Could not add to queue', { variant: 'error' })
      return null
    }
  }, [queue.length, activeTab, user, roomId, toast, openEpisodes, resolveNkiriMovie])

  /** Add to queue AND start playing it right away (host/co-host). */
  const addAndPlay = useCallback(async (item, episode = null) => {
    if (!canControl) {
      toast('Only the host or co-hosts can play items immediately', { variant: 'warning' })
      return
    }
    const created = await addToQueue(item, episode)
    if (!created) return
    try {
      await onPlayNext(created.payload)
      await deleteDoc(doc(db, 'rooms', roomId, 'queue', created.id)).catch(() => {})
    } catch (err) {
      toast(err.message || 'Could not start playback', { variant: 'error' })
    }
  }, [canControl, addToQueue, onPlayNext, roomId, toast])

  // Declared AFTER addToQueue/fetchEpisodes so it closes over already-defined
  // callbacks — fixes 'used before defined' + makes the dependency array exhaustive.
  const handleSearch = useCallback(async (e) => {
    e?.preventDefault()
    if (!searchQuery.trim()) {
      toast('Enter keywords or paste a video link', { variant: 'warning' })
      return
    }

    const trimmed = searchQuery.trim()
    if (isDirectVideoUrl(trimmed)) {
      const normalized = normalizePlaybackUrl(trimmed)
      const title = normalized.split('/').pop()?.replace(/\.(mp4|m3u8|mkv|avi|mov|webm|ogg|flv)$/i, '') || 'Direct Video'
      if (view === 'change') {
        onChangeVideo(normalized)
        setSearchQuery('')
        return
      }
      await addToQueue({
        title,
        videoUrl: normalized,
        videoType: 'direct',
        thumbnail: '',
      })
      setSearchQuery('')
      return
    }

    // Pasted YouTube link → play now (change) or queue it
    const ytId = extractVideoId(trimmed)
    if (ytId) {
      const url = `https://youtube.com/watch?v=${ytId}`
      if (view === 'change') {
        onChangeVideo(url)
        setSearchQuery('')
        return
      }
      await addToQueue({ title: 'YouTube video', url })
      setSearchQuery('')
      return
    }

    await search({
      layer: activeTab,
      query: trimmed,
      options: { resolve: activeTab === 'direct' },
    })
  }, [searchQuery, activeTab, view, search, toast, addToQueue, onChangeVideo])

  /** Resolve a search result to a playable URL and change the current video. */
  const changeToResult = useCallback(async (item) => {
    // Standalone Nkiri movie → resolve the page to a playable file first.
    if (/thenkiri\.com|nkiri\.com/i.test(item.url || item.link || '') && isStandaloneResult(item)) {
      const resolved = await resolveNkiriMovie(item)
      if (resolved?.url) onChangeVideo(resolved.url)
      return
    }
    const url = item.url || item.link || (item.id ? `https://youtube.com/watch?v=${item.id}` : '')
    if (!url) {
      toast('This item has no playable link', { variant: 'error' })
      return
    }
    onChangeVideo(url)
  }, [onChangeVideo, resolveNkiriMovie, toast])

  const removeFromQueue = useCallback(async (item) => {
    if (!canControl && item.addedByUid !== user?.uid) {
      toast('You can only remove items you added, or ask the host', { variant: 'warning' })
      return
    }
    try {
      await deleteDoc(doc(db, 'rooms', roomId, 'queue', item.id))
      toast('Removed from queue', { variant: 'success' })
    } catch (err) {
      toast(err.message || 'Could not remove item', { variant: 'error' })
    }
  }, [canControl, user, roomId, toast])

  const handlePlayQueueItem = useCallback(async (item) => {
    if (!canControl) {
      toast('Only the host or co-hosts can immediately play queued items', { variant: 'warning' })
      return
    }
    try {
      onPlayNext(item)
      await deleteDoc(doc(db, 'rooms', roomId, 'queue', item.id))
    } catch (err) {
      toast(err.message || 'Could not play queue item', { variant: 'error' })
    }
  }, [canControl, onPlayNext, roomId, toast])

  const switchView = (next) => {
    setView(next)
    clear()
    setSearchQuery('')
  }

  const canChange = Boolean(canControl && onChangeVideo)
  const showChangeTab = canChange

  return (
    <div className={styles.queuePanel}>
      {/* Mode pills — Change video | Queue */}
      <div className={styles.viewPills}>
        {showChangeTab && (
          <button
            type="button"
            className={`${styles.viewPill} ${view === 'change' ? styles.viewPillActive : ''}`}
            onClick={() => switchView('change')}
          >
            <RefreshCw size={13} />
            Change video
          </button>
        )}
        <button
          type="button"
          className={`${styles.viewPill} ${view === 'queue' ? styles.viewPillActive : ''}`}
          onClick={() => switchView('queue')}
        >
          <Play size={13} />
          Queue{queue.length > 0 ? ` (${queue.length}/5)` : ''}
        </button>
      </div>

      {/* Composer — source toggle + input + trailing action */}
      <div className={styles.queueControls}>
        <form onSubmit={handleSearch} className={styles.composerBar}>
          <button
            type="button"
            className={styles.sourceChip}
            onClick={() => { setActiveTab(activeTab === 'youtube' ? 'direct' : 'youtube'); clear() }}
            title={activeTab === 'youtube' ? 'Switch to Direct / Movies' : 'Switch to YouTube'}
          >
            {activeTab === 'youtube' ? <Youtube size={14} /> : <Link2 size={14} />}
            {activeTab === 'youtube' ? 'YouTube' : 'Direct'}
          </button>
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={activeTab === 'direct' ? 'Paste a video link…' : 'Search YouTube…'}
            className={styles.searchInput}
          />
          <button
            type="submit"
            className={styles.trailingBtn}
            title={view === 'change' ? 'Play this video now' : 'Search'}
            aria-label={view === 'change' ? 'Play now' : 'Search'}
          >
            {loading ? <Loader2 size={14} className="spin" /> : view === 'change' ? <Play size={14} /> : <Search size={14} />}
          </button>
        </form>
        {view === 'change' && (
          <p className={styles.viewHint}>Picking a result below changes the video for everyone right now.</p>
        )}
        {view === 'queue' && (
          <p className={styles.viewHint}>Add videos to line up. The host can play any queued item immediately.</p>
        )}
      </div>

      {/* Search results list in Card style */}
      {results.length > 0 && (
        <div className={styles.searchResultsSection}>
          <div className={styles.resultsBar}>
            <span>{view === 'change' ? 'Pick a result to play now' : `Found ${results.length} result(s)`}</span>
            <button type="button" onClick={clear} className={styles.clearBtn}>Clear</button>
          </div>
          <div className={styles.resultsList}>
            {results.map((item, idx) => {
              const thumb = item.thumbnail || item.image || null
              const isFull = queue.length >= 5
              const isNkiriPage = /thenkiri\.com|nkiri\.com/i.test(item.url || item.link || '')
              const seasonal = isSeasonalResult(item)
              const standalone = isStandaloneResult(item)
              const showExpand = isNkiriPage && seasonal
              // Standalone Nkiri movies are playable too (resolved on click).
              const playable = (item.type || activeTab) === 'youtube' && (item.id || extractVideoId(item.url))
                || item.isDirect || isDirectVideoUrl(item.url || item.link)
                || (isNkiriPage && standalone)

              return (
                <div key={idx}>
                  <div className={styles.resultCard}>
                    <div className={styles.thumbWrap}>
                      {thumb ? (
                        <img src={thumb} alt="" loading="lazy" />
                      ) : (
                        <div className={styles.noThumb} />
                      )}
                    </div>
                    <div className={styles.cardBody}>
                      <h4 className={styles.cardTitle}>{item.title}</h4>
                      <span className={styles.cardMeta}>{item.source || activeTab} · {item.duration || 'Video'}</span>
                    </div>

                    {showExpand ? (
                      <button
                        type="button"
                        className={styles.addBtn}
                        onClick={() => openEpisodes(item)}
                      >
                        Show Episodes
                      </button>
                    ) : view === 'change' ? (
                      <button
                        type="button"
                        className={`${styles.addBtn} ${!playable ? styles.disabledBtn : ''}`}
                        onClick={() => changeToResult(item)}
                        disabled={!playable}
                        title={playable ? 'Play this video now' : 'Not playable directly'}
                      >
                        <Play size={14} /> Play now
                      </button>
                    ) : (
                      <div className={styles.resultActions}>
                        {canControl && (
                          <button
                            type="button"
                            className={styles.iconBtn}
                            onClick={() => addAndPlay(item)}
                            disabled={isFull}
                            title={isFull ? 'Queue limit reached (max 5)' : 'Add and play now'}
                          >
                            <Play size={13} />
                          </button>
                        )}
                        <button
                          type="button"
                          className={`${styles.addBtn} ${isFull ? styles.disabledBtn : ''}`}
                          onClick={() => addToQueue(item)}
                          disabled={isFull}
                          title={isFull ? 'Queue limit reached (max 5)' : 'Add to queue'}
                        >
                          <Plus size={14} /> Add
                        </button>
                      </div>
                    )}
                  </div>

                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Active Queue List */}
      <div className={styles.activeQueueSection}>
        <h4 className={styles.sectionTitle}>Up Next in Room</h4>
        {queue.length === 0 ? (
          <div className={styles.emptyQueue}>
            <p>Queue is empty. Search above or paste a link to line up videos!</p>
          </div>
        ) : (
          <div className={styles.queueList}>
            {queue.map((item, index) => (
              <div key={item.id} className={styles.queueItem}>
                <span className={styles.queueNumber}>#{index + 1}</span>
                <div className={styles.queueThumb}>
                  {item.thumbnail ? (
                    <img src={item.thumbnail} alt="" loading="lazy" />
                  ) : (
                    <div className={styles.noThumb} />
                  )}
                </div>
                <div className={styles.queueInfo}>
                  <h4 className={styles.queueTitle}>{item.title}</h4>
                  <span className={styles.queueMeta}>Added by {item.addedByName}</span>
                </div>
                <div className={styles.queueActions}>
                  {canControl && (
                    <button
                      type="button"
                      className={styles.playNowBtn}
                      onClick={() => handlePlayQueueItem(item)}
                      title="Play Now"
                    >
                      <Play size={14} />
                    </button>
                  )}
                  {(canControl || item.addedByUid === user?.uid) && (
                    <button
                      type="button"
                      className={styles.removeBtn}
                      onClick={() => removeFromQueue(item)}
                      title="Remove from queue"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Episodes popup — portaled to <body> so it truly centers on the
          screen (the sheet's slide transform would otherwise hijack
          position:fixed and pin it to the sheet's bottom). Modal: the dim
          scrim blocks ALL background interaction while it's open (scroll
          + taps); close via scrim tap, X or Esc. */}
      {episodesModal && createPortal(
        <div className={styles.episodesOverlay} onClick={closeEpisodes}>
          <div
            className={styles.episodesModal}
            role="dialog"
            aria-label={`${episodesModal.title} episodes`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.episodesHeader}>
              <div className={styles.episodesHeaderText}>
                <span className={styles.episodesHeaderTitle}>{cleanMediaTitle(episodesModal.title) || 'Episodes'}</span>
                {episodesModal.synopsis && (
                  <span className={styles.episodesHeaderSynopsis}>{episodesModal.synopsis}</span>
                )}
              </div>
              <button type="button" className={styles.episodesClose} onClick={closeEpisodes} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <div className={styles.episodesList}>
              {episodesModal.loading ? (
                <div className={styles.episodesEmpty}>
                  <Loader2 size={18} className="spin" />
                  <span>Loading episodes…</span>
                </div>
              ) : episodesModal.episodes.length === 0 ? (
                <div className={styles.episodesEmpty}>
                  <span>No episodes found on this page.</span>
                </div>
              ) : (
                episodesModal.episodes.map((ep, epIdx) => {
                  const epThumb = ep.thumbnail || episodesModal.sourceItem?.thumbnail || null
                  const isFull = queue.length >= 5
                  return (
                    <div key={epIdx} className={styles.epRow}>
                      <div className={styles.epThumb}>
                        {epThumb ? (
                          <img src={epThumb} alt="" loading="lazy" />
                        ) : (
                          <div className={styles.epNoThumb} />
                        )}
                      </div>
                      <div className={styles.epBody}>
                        <h4 className={styles.epTitle}>{cleanMediaTitle(ep.title) || `Episode ${epIdx + 1}`}</h4>
                        <div className={styles.epMeta}>
                          <span className={styles.epChip} data-source="direct">Episode</span>
                          <span className={styles.epQuality}>{ep.container ? String(ep.container).toUpperCase() : 'Video'}</span>
                        </div>
                      </div>
                      {view === 'change' ? (
                        <button
                          type="button"
                          className={styles.addBtn}
                          onClick={() => { changeToResult(ep); closeEpisodes() }}
                        >
                          <Play size={14} /> Play
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={`${styles.addBtn} ${isFull ? styles.disabledBtn : ''}`}
                          onClick={() => addToQueue(episodesModal.sourceItem, ep)}
                          disabled={isFull}
                          title={isFull ? 'Queue limit reached (max 5)' : 'Add to queue'}
                        >
                          <Plus size={14} /> Add
                        </button>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
