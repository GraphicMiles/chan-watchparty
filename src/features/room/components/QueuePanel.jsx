import React, { useState, useEffect, useCallback } from 'react'
import { collection, onSnapshot, query, orderBy, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore'
import { Plus, Trash2, Play, Search, Film, Loader2 } from 'lucide-react'
import { db } from '../../../shared/lib/firebase.js'
import { useUnifiedSearch } from '../../../hooks/useUnifiedSearch.js'
import { isDirectVideoUrl, normalizePlaybackUrl, extractVideoId, getThumbnail } from '../../../shared/lib/youtube.js'
import { Button, Input } from '../../../shared/ui/index.js'
import styles from './QueuePanel.module.scss'

export default function QueuePanel({ roomId, room, user, isHost, canControl, onPlayNext, toast }) {
  const [queue, setQueue] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState('youtube') // 'youtube' or 'direct'
  const { results, loading, search, clear } = useUnifiedSearch()

  useEffect(() => {
    if (!roomId) return undefined
    const q = query(collection(db, 'rooms', roomId, 'queue'), orderBy('createdAt', 'asc'))
    const unsub = onSnapshot(q, (snap) => {
      setQueue(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    })
    return unsub
  }, [roomId])

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
      await addToQueue({
        title,
        videoUrl: normalized,
        videoType: 'direct',
        thumbnail: '',
      })
      setSearchQuery('')
      return
    }

    await search({
      layer: activeTab,
      query: trimmed,
      options: { resolve: activeTab === 'direct' },
    })
  }, [searchQuery, activeTab, search, toast])

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
      const res = await fetch('/api/media', {
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

  const addToQueue = useCallback(async (item, episode = null) => {
    if (queue.length >= 5) {
      toast('Queue is full! Users can only add up to 5 media items to the queue.', { variant: 'error' })
      return
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
      return
    } else if (item.isDirect || isDirectVideoUrl(item.url || item.link)) {
      videoUrl = normalizePlaybackUrl(item.url || item.link)
      videoType = 'direct'
    } else {
      toast('Selected item must be a playable video or YouTube link', { variant: 'error' })
      return
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
      await addDoc(collection(db, 'rooms', roomId, 'queue'), payload)
      toast('Added to queue!', { variant: 'success' })
    } catch (err) {
      toast(err.message || 'Could not add to queue', { variant: 'error' })
    }
  }, [queue.length, activeTab, user, roomId, toast])

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

  return (
    <div className={styles.queuePanel}>
      <div className={styles.header}>
        <h3>Smart Queue ({queue.length}/5)</h3>
        <p>Add up to 5 videos. When the current stream finishes, the next queued item plays automatically!</p>
      </div>

      <div className={styles.tabs}>
        <button
          type="button"
          className={activeTab === 'youtube' ? styles.tabActive : styles.tab}
          onClick={() => { setActiveTab('youtube'); clear() }}
        >
          YouTube Search
        </button>
        <button
          type="button"
          className={activeTab === 'direct' ? styles.tabActive : styles.tab}
          onClick={() => { setActiveTab('direct'); clear() }}
        >
          Direct / Movies (e.g. Silo)
        </button>
      </div>

      <form onSubmit={handleSearch} className={styles.searchForm}>
        <div className={styles.inputRow}>
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search ${activeTab === 'direct' ? 'movies/shows (e.g. Silo)' : 'YouTube'} or paste URL...`}
            className={styles.searchInput}
          />
          <Button type="submit" size="sm" loading={loading}>
            <Search size={14} /> Search
          </Button>
        </div>
      </form>

      {/* Search results list in Card style */}
      {results.length > 0 && (
        <div className={styles.searchResultsSection}>
          <div className={styles.resultsBar}>
            <span>Found {results.length} result(s)</span>
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
                    ) : (
                      <button
                        type="button"
                        className={`${styles.addBtn} ${isFull ? styles.disabledBtn : ''}`}
                        onClick={() => addToQueue(item)}
                        disabled={isFull}
                        title={isFull ? 'Queue limit reached (max 5)' : 'Add to queue'}
                      >
                        <Plus size={14} /> Add
                      </button>
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
                          <button
                            type="button"
                            className={`${styles.addBtn} ${isFull ? styles.disabledBtn : ''}`}
                            onClick={() => addToQueue(item, ep)}
                            disabled={isFull}
                          >
                            <Plus size={14} /> Add
                          </button>
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
