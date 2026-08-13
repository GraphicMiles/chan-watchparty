import { useState, useEffect, useCallback } from 'react'
import { collection, onSnapshot, query, orderBy, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore'
import { Plus, Trash2, Play, Search, Film, Youtube, Link2, Loader2, RefreshCw } from 'lucide-react'
import { db } from '../../../shared/lib/firebase.js'
import { useUnifiedSearch } from '../../../hooks/useUnifiedSearch.js'
import { isDirectVideoUrl, normalizePlaybackUrl, extractVideoId, getThumbnail } from '../../../shared/lib/youtube.js'
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

  const [expandedSeasons, setExpandedSeasons] = useState({}) // { seasonUrl: episodes[] }
  const [loadingEpisodes, setLoadingEpisodes] = useState({}) // { seasonUrl: boolean }

  const fetchEpisodes = useCallback(async (seasonUrl) => {
    if (expandedSeasons[seasonUrl]) {
      // Already loaded, toggle off
      setExpandedSeasons(prev => {
        const next = { ...prev }
        delete next[seasonUrl]
        return next
      })
      return
    }

    setLoadingEpisodes(prev => ({ ...prev, [seasonUrl]: true }))
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
        setExpandedSeasons(prev => ({ ...prev, [seasonUrl]: data.results }))
      } else {
        toast('No episodes found on this season page', { variant: 'error' })
      }
    } catch (err) {
      console.error('Failed to fetch episodes:', err)
      toast('Failed to load episodes', { variant: 'error' })
    } finally {
      setLoadingEpisodes(prev => ({ ...prev, [seasonUrl]: false }))
    }
  }, [expandedSeasons, user, toast])

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
      // Nkiri season page - fetch and show episodes
      await fetchEpisodes(item.url || item.link)
      return null
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
  }, [queue.length, activeTab, user, roomId, toast, fetchEpisodes])

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
  const changeToResult = useCallback((item) => {
    const url = item.url || item.link || (item.id ? `https://youtube.com/watch?v=${item.id}` : '')
    if (!url) {
      toast('This item has no playable link', { variant: 'error' })
      return
    }
    onChangeVideo(url)
  }, [onChangeVideo, toast])

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
              const isNkiri = /thenkiri\.com|nkiri\.com/i.test(item.url || item.link || '')
              const isExpanded = expandedSeasons[item.url || item.link]
              const isLoading = loadingEpisodes[item.url || item.link]
              const episodes = isExpanded || []
              const playable = (item.type || activeTab) === 'youtube' && (item.id || extractVideoId(item.url))
                || item.isDirect || isDirectVideoUrl(item.url || item.link)

              return (
                <div key={idx}>
                  <div className={styles.resultCard}>
                    <div className={styles.thumbWrap}>
                      {thumb ? (
                        <img src={thumb} alt="" loading="lazy" />
                      ) : (
                        <div className={styles.noThumb}><Film size={20} /></div>
                      )}
                    </div>
                    <div className={styles.cardBody}>
                      <h4 className={styles.cardTitle}>{item.title}</h4>
                      <span className={styles.cardMeta}>{item.source || activeTab} · {item.duration || 'Video'}</span>
                    </div>

                    {isNkiri ? (
                      <button
                        type="button"
                        className={styles.addBtn}
                        onClick={() => fetchEpisodes(item.url || item.link)}
                        disabled={isLoading}
                      >
                        {isLoading ? 'Loading...' : isExpanded ? 'Hide Episodes' : 'Show Episodes'}
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

                  {/* Expanded Episodes for Nkiri Seasons */}
                  {isExpanded && (
                    <div className={styles.episodesList}>
                      {episodes.map((ep, epIdx) => (
                        <div key={epIdx} className={styles.episodeCard}>
                          <div className={styles.episodeInfo}>
                            <span className={styles.episodeTitle}>{ep.title}</span>
                          </div>
                          {view === 'change' ? (
                            <button
                              type="button"
                              className={styles.addBtn}
                              onClick={() => changeToResult(ep)}
                            >
                              <Play size={14} /> Play
                            </button>
                          ) : (
                            <button
                              type="button"
                              className={`${styles.addBtn} ${isFull ? styles.disabledBtn : ''}`}
                              onClick={() => addToQueue(item, ep)}
                              disabled={isFull}
                            >
                              <Plus size={14} /> Add
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
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
                    <div className={styles.noThumb}><Film size={16} /></div>
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
    </div>
  )
}
