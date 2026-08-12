import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Share2, MessageSquare, X, LogOut, Radio, Lock, Unlock,
  Pencil, Monitor, Film, ChevronDown, ChevronRight, AlertTriangle,
  Video, Link2, ListVideo, Play, Sparkles
} from 'lucide-react'
import { collection, onSnapshot, query, orderBy, limit, deleteDoc, doc, getDoc } from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'
import { useRoom } from '../hooks/useRoom.js'
import { usePlayerSync } from '../hooks/usePlayerSync.js'
import VideoPlayer from '../components/VideoPlayer.jsx'
import { ErrorBoundary } from '../../../shared/components/ErrorBoundary.jsx'
import ScreenShare from '../components/ScreenShare.jsx'
import Chat from '../components/Chat.jsx'
import QueuePanel from '../components/QueuePanel.jsx'
import ParticipantList from '../components/ParticipantList.jsx'
import { SyncPulse } from '../../../shared/components/SyncPulse.jsx'
import { extractVideoId, isDirectVideoUrl, normalizePlaybackUrl } from '../../../shared/lib/youtube.js'
import { cleanMediaTitle } from '../../../shared/lib/titleFormat.js'
import { isDisplayMediaSupported } from '../services/livekit.js'
import { Button, Input, Card, IconButton, Modal, Badge, useToast } from '../../../shared/ui/index.js'
import { Layout } from '../../../shared/layout/index.js'
import ShareRoom from '../components/ShareRoom.jsx'
import styles from './RoomPage.module.css'
import { proxyTargetUrl, resolveDownloadLink, refreshDownloadDescriptor } from '../../../shared/lib/mediaApi.js'
import { ShowBrowser } from '../../../shared/components/ShowBrowser.jsx'
import { apiPath, API_URL } from '../../../shared/lib/api.js'
import { isNativeRoomSupported, launchNativeRoom, onNativeRoomResult } from '../nativeRoomBridge.js'

const SOUND_FX_URLS = {
  airhorn: 'https://cdn.freesound.org/previews/435/435255_8863641-lq.mp3',
  cheer: 'https://cdn.freesound.org/previews/337/337049_5121236-lq.mp3',
  boom: 'https://cdn.freesound.org/previews/266/266105_4486188-lq.mp3',
  laugh: 'https://cdn.freesound.org/previews/369/369515_6687700-lq.mp3',
  applause: 'https://cdn.freesound.org/previews/483/483652_1015240-lq.mp3',
}

const SOUND_FX_NAMES = {
  airhorn: 'Airhorn',
  cheer: 'Stadium Cheer',
  boom: 'Dramatic Boom',
  laugh: 'Crowd Laugh',
  applause: 'Applause',
}

export default function RoomPage() {
  const { roomId } = useParams()
  const [searchParams] = useSearchParams()
  const inviteCode = searchParams.get('invite')
  const { user } = useAuth()
  const navigate = useNavigate()
  const { toast } = useToast()

  useEffect(() => {
    document.body.classList.add('room-theme')
    return () => document.body.classList.remove('room-theme')
  }, [])

  const [sidebarTab, setSidebarTab] = useState('chat')
  const [showChat, setShowChat] = useState(() => (typeof window !== 'undefined' ? window.innerWidth > 768 : true))
  const [isNarrow, setIsNarrow] = useState(() => (typeof window !== 'undefined' ? window.innerWidth <= 768 : false))
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth <= 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const [newVideoUrl, setNewVideoUrl] = useState('')
  const [changeVideoOpen, setChangeVideoOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [endConfirmOpen, setEndConfirmOpen] = useState(false)
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [shareBanner, setShareBanner] = useState('')
  const [busy, setBusy] = useState(false)
  const [queueItems, setQueueItems] = useState([])
  const [autoNextPrompt, setAutoNextPrompt] = useState(null)
  const [floatingReactions, setFloatingReactions] = useState([])
  const [soundFxBanner, setSoundFxBanner] = useState(null)
  const [vibeLightingEnabled, setVibeLightingEnabled] = useState(true)
  
  const playerRef = useRef(null)
  const prevActivity = useRef(null)
  const autoNextTimerRef = useRef(null)
  const lastPlayedFxRef = useRef(null)

  const {
    room,
    participants,
    messages,
    error,
    joined,
    activityType,
    endRoom,
    leave,
    sendMessage,
    updateRoom,
    typing,
    setTyping,
    kickParticipant,
    promoteParticipant,
    muteParticipant,
    reportPlayerPosition,
  } = useRoom(roomId, inviteCode)

  const { isHost, writePlayerState, canControl } = usePlayerSync(roomId, room, playerRef)

  // ── Native room: the ONE watch room (mobile app) ──────────────────────
  // On Android, non-YouTube rooms launch NativeRoomActivity with the room
  // credentials. The native activity reads the room from Firestore REST
  // (videoUrl, media, participants, messages, queue, playerState) — nothing
  // else needed. The web room stays mounted underneath purely as the launch
  // shell (it also keeps the seat + host heartbeat alive); its video stays
  // unmounted so nothing ever double-plays.
  const directContent = Boolean(room?.videoUrl) && room?.videoType !== 'youtube'
  const nativeSupported = directContent && isNativeRoomSupported()
  const [nativeGate, setNativeGate] = useState(() => (isNativeRoomSupported() ? 'launching' : 'done'))
  const nativeLaunchedRef = useRef(false)

  useEffect(() => {
    if (!nativeSupported || nativeGate !== 'launching' || nativeLaunchedRef.current) return
    if (!user || !room?.videoUrl || !roomId) return
    nativeLaunchedRef.current = true
    let cancelled = false
    const run = async () => {
      try {
        const [idToken, psSnap] = await Promise.all([
          user.getIdToken(),
          getDoc(doc(db, 'rooms', roomId, 'playerState', 'current')).catch(() => null),
        ])
        if (cancelled) return
        const ps = psSnap?.exists?.() ? psSnap.data() : null
        const startSeconds = Number(ps?.currentTime) > 0 ? Number(ps.currentTime) : 0
        await launchNativeRoom({
          roomId,
          uid: user.uid,
          displayName: user.displayName || 'Viewer',
          idToken,
          projectId: db.app.options.projectId || '',
          apiKey: db.app.options.apiKey || '',
          apiBase: API_URL || '',
          startSeconds,
        })
      } catch (err) {
        console.error('Native room launch failed:', err)
        if (!cancelled) {
          nativeLaunchedRef.current = false
          setNativeGate('done')
        }
      }
    }
    const timer = setTimeout(run, 600)
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeSupported, nativeGate, user, room?.videoUrl, roomId])

  useEffect(() => {
    if (!nativeSupported || nativeGate !== 'launching') return
    if (!user || !roomId) return
    let disposed = false
    const handle = onNativeRoomResult((res) => {
      if (disposed) return
      if (res && typeof res.positionMs === 'number' && res.positionMs > 0) {
        const currentTime = Math.max(0, res.positionMs / 1000)
        reportPlayerPosition?.(currentTime, Boolean(res.wasPlaying))
        // Freeze playerState so a re-entry resumes at the native position.
        user.getIdToken().then((token) => {
          fetch(apiPath('/api/room'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ action: 'freeze', roomId, uid: user.uid, currentTime }),
            keepalive: true,
          }).catch(() => {})
        })
      }
      setNativeGate('returned')
    })
    return () => {
      disposed = true
      try { handle?.remove?.() } catch { /* already removed */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeSupported, nativeGate, user, roomId])

  // Continuously report player position so leave/beforeunload can freeze the exact timestamp
  useEffect(() => {
    if (!reportPlayerPosition) return undefined
    const tick = () => {
      const player = playerRef.current
      if (!player || typeof player.getCurrentTime !== 'function') return
      const t = player.getCurrentTime?.() || 0
      const playing = player.getPlayerState?.() === 1
      reportPlayerPosition(t, playing)
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [reportPlayerPosition, joined, roomId])

  useEffect(() => () => {
    if (autoNextTimerRef.current) clearTimeout(autoNextTimerRef.current)
  }, [])

  useEffect(() => {
    if (!roomId) return undefined
    const q = query(collection(db, 'rooms', roomId, 'queue'), orderBy('createdAt', 'asc'))
    return onSnapshot(q, (snap) => {
      setQueueItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    })
  }, [roomId])

  useEffect(() => {
    if (!roomId) return undefined
    const q = query(collection(db, 'rooms', roomId, 'floatingReactions'), orderBy('createdAt', 'desc'), limit(15))
    return onSnapshot(q, (snap) => {
      const now = Date.now()
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((item) => {
        const at = item.createdAt?.toMillis?.() || item.createdAtMs || 0
        return now - at < 4000
      })
      setFloatingReactions(items)
    })
  }, [roomId])

  useEffect(() => {
    if (!roomId) return undefined
    const q = query(collection(db, 'rooms', roomId, 'soundEffects'), orderBy('createdAt', 'desc'), limit(1))
    return onSnapshot(q, (snap) => {
      if (snap.empty) return
      const item = { id: snap.docs[0].id, ...snap.docs[0].data() }
      const now = Date.now()
      const at = item.createdAt?.toMillis?.() || item.createdAtMs || 0
      if (now - at < 3500 && lastPlayedFxRef.current !== item.id) {
        lastPlayedFxRef.current = item.id
        const audioUrl = SOUND_FX_URLS[item.soundKey]
        if (audioUrl) {
          const audio = new Audio(audioUrl)
          audio.volume = 0.75
          audio.play().catch(() => {})
        }
        const fxName = SOUND_FX_NAMES[item.soundKey] || item.soundKey
        setSoundFxBanner(`${fxName} — by ${item.displayName}`)
        setTimeout(() => setSoundFxBanner(null), 3000)
      }
    })
  }, [roomId])

  useEffect(() => {
    if (!activityType) return
    if (prevActivity.current && prevActivity.current !== activityType) {
      if (activityType === 'screenshare') {
        const hostName = room?.hostName || 'Host'
        setShareBanner(`${hostName} is sharing their screen`)
        const t = window.setTimeout(() => setShareBanner(''), 3500)
        return () => window.clearTimeout(t)
      }
    }
    prevActivity.current = activityType
  }, [activityType, room?.hostName])

  useEffect(() => {
    if (!showChat) return
    const onKey = (e) => {
      if (e.key === 'Escape' && window.innerWidth <= 768) setShowChat(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showChat])

  const onPlayNextQueueItem = useCallback(async (item) => {
    if (!canControl || !item) return
    try {
      setBusy(true)
      if (autoNextTimerRef.current) clearTimeout(autoNextTimerRef.current)
      setAutoNextPrompt(null)
      
      await updateRoom({
        videoId: item.videoId || null,
        videoUrl: item.videoUrl || null,
        videoType: item.videoType || 'youtube',
        activityType: item.videoType || 'youtube',
        title: item.title || 'Untitled',
      })
      await writePlayerState({
        videoId: item.videoId || '',
        videoUrl: item.videoUrl || null,
        isPlaying: true,
        currentTime: 0,
      }, true)
      toast('Playing queued stream!', { variant: 'success' })
    } catch (err) {
      toast(err.message || 'Could not play next stream', { variant: 'error' })
    } finally {
      setBusy(false)
    }
  }, [canControl, updateRoom, writePlayerState, toast])

  const handleVideoEnded = useCallback(() => {
    if (!canControl || queueItems.length === 0) return
    const nextItem = queueItems[0]
    setAutoNextPrompt(nextItem)
    if (autoNextTimerRef.current) clearTimeout(autoNextTimerRef.current)
    autoNextTimerRef.current = setTimeout(async () => {
      setAutoNextPrompt(null)
      await onPlayNextQueueItem(nextItem)
      await deleteDoc(doc(db, 'rooms', roomId, 'queue', nextItem.id)).catch(() => {})
    }, 5000)
  }, [canControl, queueItems, onPlayNextQueueItem, roomId])

  // Hooks must run unconditionally on every render. These two useCallbacks
  // previously lived AFTER the `if (!user)` early return, which made them
  // conditional hooks (rules-of-hooks violation). They are declared here, with
  // all other hooks, so call order is stable across renders.
  // Re-resolve a stale/expired DownloadWella page link and update the room so
  // every viewer gets the fresh CDN URL (wired to the player's error card).
  // Re-resolve a stale/expired DownloadWella link. Uses the room's stored
  // descriptor (sourceUrl) to walk the page form for a FRESH token, updates
  // the room doc (videoUrl + media descriptor) so ALL viewers recover, and
  // returns the new descriptor for immediate native playback (Phase B).
  const reResolveVideo = useCallback(async (staleUrl) => {
    if (!canControl) {
      toast('Only the host or a co-host can re-resolve the link', { variant: 'warning' })
      throw new Error('Only the host or a co-host can re-resolve the link')
    }
    setBusy(true)
    try {
      toast('Re-resolving link…', { variant: 'info' })
      const resolveFrom = (room?.media?.sourceUrl && /downloadwella\.com|fsmc/i.test(room.media.sourceUrl))
        ? room.media.sourceUrl
        : (room?.sourceUrl && /downloadwella\.com|fsmc/i.test(room.sourceUrl))
          ? room.sourceUrl
          : staleUrl
      const descriptor = await refreshDownloadDescriptor(user, resolveFrom, room?.title || 'Chan video')
      const freshUrl = normalizePlaybackUrl(descriptor.streamUrl)
      const mediaDoc = {
        streamUrl: descriptor.streamUrl,
        referer: descriptor.referer || 'https://downloadwella.com/',
        headers: descriptor.headers || null,
        container: descriptor.container || null,
        codec: descriptor.codec || null,
        sourceUrl: descriptor.sourceUrl || resolveFrom || null,
        mirrors: Array.isArray(descriptor.mirrors) ? descriptor.mirrors : [],
        sizeBytes: descriptor.sizeBytes || null,
        probe: descriptor.probe || null,
        resolvedAt: descriptor.resolvedAt || null,
      }
      await updateRoom({
        videoUrl: freshUrl,
        videoType: 'direct',
        activityType: 'direct',
        isLive: false,
        media: mediaDoc,
      })
      await writePlayerState({ videoUrl: freshUrl, isPlaying: false, currentTime: 0 }, true)
      toast('Link refreshed — playing', { variant: 'success' })
      return descriptor
    } catch (err) {
      toast(err.message || 'Could not re-resolve the link', { variant: 'error' })
      throw err
    } finally {
      setBusy(false)
    }
  }, [canControl, user, room, updateRoom, writePlayerState, toast])

  // P1: change video from the shared browser content contract
  const changeVideoContent = useCallback(async (content) => {
    if (!content) return
    setBusy(true)
    try {
      if (content.kind === 'youtube' && content.videoId) {
        await updateRoom({
          videoId: content.videoId,
          videoUrl: null,
          videoType: 'youtube',
          activityType: 'youtube',
          isLive: false,
          title: content.title || room.title,
        })
        await writePlayerState({ videoId: content.videoId, videoUrl: null, isPlaying: false, currentTime: 0 })
      } else if (content.url) {
        let playUrl = content.url
        // DownloadWella page links expire fast — resolve fresh via nkiriResolve
        // (form-walk to the CDN file) before switching the room's video.
        if (content.pendingResolve && /downloadwella\.com|fsmc/i.test(proxyTargetUrl(playUrl))) {
          toast('Resolving episode link…', { variant: 'info' })
          playUrl = await resolveDownloadLink(user, playUrl, content.title)
        }
        const nextType = content.videoType || (/\.m3u8(\?|#|$)/i.test(playUrl) ? 'iptv' : 'direct')
        await updateRoom({
          videoId: null,
          videoUrl: playUrl,
          videoType: nextType,
          activityType: nextType,
          isLive: nextType === 'iptv' || nextType === 'sports',
          title: content.title || room.title,
        })
        await writePlayerState({ videoId: null, videoUrl: playUrl, isPlaying: false, currentTime: 0 })
      } else {
        toast('No playable link for that pick', { variant: 'error' })
        return
      }
      setChangeVideoOpen(false)
      setNewVideoUrl('')
      toast('Video updated', { variant: 'success' })
    } catch (err) {
      toast(err.message || 'Could not update video', { variant: 'error' })
    } finally {
      setBusy(false)
    }
  }, [user, room, updateRoom, writePlayerState, toast])

  if (!user) {
    return (
      <div className={styles.loading}>
        <Link to="/auth">Sign in to join</Link>
      </div>
    )
  }

  const isDirectVideo = room?.videoType === 'direct' || room?.videoType === 'iptv' || room?.videoType === 'sports' || room?.videoType === 'nsfw'
  const isYoutube = !isDirectVideo && (activityType === 'youtube' || activityType === 'direct')
  const canShareScreen = isDisplayMediaSupported()

  const switchActivity = async (type) => {
    if (type === 'screenshare' && !canShareScreen) {
      toast('Screen share needs a desktop browser. On mobile, only watching is supported.', { variant: 'warning' })
      return
    }
    try {
      setBusy(true)
      await updateRoom({ activityType: type })
    } catch (err) {
      toast(err.message || 'Could not switch mode', { variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const changeVideo = async (e) => {
    e?.preventDefault()
    const trimmedUrl = newVideoUrl.trim()
    const itemTitle = ''

    const id = extractVideoId(trimmedUrl)
    const isDirect = isDirectVideoUrl(trimmedUrl) || /\.(mp4|m3u8|mkv|avi|mov|webm|flv|ts)(\?|#|$)/i.test(trimmedUrl)
    const isM3u8 = /\.m3u8(\?|#|$)/i.test(trimmedUrl)
    const playbackUrl = normalizePlaybackUrl(trimmedUrl)
    
    try {
      setBusy(true)
      
      if (id) {
        await updateRoom({ 
          videoId: id, 
          videoUrl: null,
          videoType: 'youtube',
          activityType: 'youtube',
          isLive: false,
          title: itemTitle || room.title,
        })
        await writePlayerState({ videoId: id, videoUrl: null, isPlaying: false, currentTime: 0 })
      } else if (isDirect || trimmedUrl) {
        const nextType = isM3u8 ? 'iptv' : 'direct'
        await updateRoom({ 
          videoId: null, 
          videoUrl: playbackUrl,
          videoType: nextType,
          activityType: nextType,
          isLive: isM3u8,
          title: itemTitle || room.title,
        })
        await writePlayerState({ videoId: null, videoUrl: playbackUrl, isPlaying: false, currentTime: 0 })
      } else {
        toast('Paste a valid YouTube URL or direct video link (.mp4, .mkv, etc.)', { variant: 'error' })
        return
      }
      
      setNewVideoUrl('')
      setChangeVideoOpen(false)
      toast('Video updated', { variant: 'success' })
    } catch (err) {
      toast(err.message || 'Could not update video', { variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const saveTitle = async () => {
    const next = titleDraft.trim()
    if (!next || next === room.title) {
      setEditingTitle(false)
      return
    }
    try {
      await updateRoom({ title: next })
      toast('Title updated', { variant: 'success' })
      setEditingTitle(false)
    } catch (err) {
      toast(err.message || 'Could not update title', { variant: 'error' })
    }
  }

  const toggleLock = async () => {
    try {
      await updateRoom({ locked: !room.locked })
      toast(room.locked ? 'Room unlocked' : 'Room locked — new joins blocked', { variant: 'success' })
    } catch (err) {
      toast(err.message || 'Could not update lock', { variant: 'error' })
    }
  }

  const confirmEnd = async () => {
    try {
      setBusy(true)
      await endRoom()
    } catch (err) {
      toast(err.message || 'Could not end room', { variant: 'error' })
      setBusy(false)
    }
  }

  const confirmLeave = async () => {
    try {
      setBusy(true)
      await leave()
      navigate('/')
    } catch (err) {
      toast(err.message || 'Could not leave', { variant: 'error' })
      setBusy(false)
    }
  }

  const requestLeave = () => {
    if (isHost && activityType === 'screenshare') {
      setLeaveConfirmOpen(true)
      return
    }
    confirmLeave()
  }

  const onPlayerReady = (player) => {
    playerRef.current = player || null
    if (player && reportPlayerPosition) {
      try {
        reportPlayerPosition(player.getCurrentTime?.() || 0, player.getPlayerState?.() === 1)
      } catch {
        /* ignore */
      }
    }
  }

  const onPlayerEvent = (patch) => {
    if (patch && typeof patch.currentTime === 'number' && reportPlayerPosition) {
      reportPlayerPosition(patch.currentTime, patch.isPlaying)
    }
    if (canControl) writePlayerState(patch)
  }

  // Calculate dynamic Vibe Lighting (#3) — crisp border instead of blur shadow
  const vibeGlowStyle = (() => {
    if (!vibeLightingEnabled) return 'none'
    const count = floatingReactions.length
    if (count >= 5) return '0 0 0 3px #FF3B30'
    if (count >= 2) return '0 0 0 2px #FF6A2B'
    if (count >= 1) return '0 0 0 2px #1F7A5C'
    return 'none'
  })()

  const header = (
    <header className={styles.header}>
      <div className={styles.roomTitle}>
        <Link to="/" className={styles.brand}>
          Chan
        </Link>
        <div className={styles.titleSep} />
        <SyncPulse active size={16} />
        {editingTitle && isHost ? (
          <form
            className={styles.titleEdit}
            onSubmit={(e) => {
              e.preventDefault()
              saveTitle()
            }}
          >
            <Input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              maxLength={80}
              autoFocus
            />
            <Button type="submit" size="sm">Save</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditingTitle(false)}>Cancel</Button>
          </form>
        ) : (
          <h1 className={styles.titleText}>{cleanMediaTitle(room?.title) || 'Room'}</h1>
        )}
        {room?.locked && (
          <Badge variant="warning" icon={Lock}>Locked</Badge>
        )}
        {isDirectVideo && (
          <Badge variant="accent" icon={Link2}>Direct</Badge>
        )}
      </div>
      <div className={styles.headerActions}>
        <IconButton onClick={() => setShareOpen(true)} aria-label="Share room" title="Share room">
          <Share2 size={18} />
        </IconButton>
        <IconButton onClick={() => { setShowChat(true); setSidebarTab('queue') }} active={showChat && sidebarTab === 'queue'} aria-label="Toggle queue" title="Queue">
          <ListVideo size={18} />
          {queueItems.length > 0 && <span className={styles.queueCountBadge}>{queueItems.length}</span>}
        </IconButton>
        <IconButton onClick={() => { setShowChat(true); setSidebarTab('chat') }} active={showChat && sidebarTab === 'chat'} aria-label="Toggle chat" title="Chat">
          <MessageSquare size={18} />
        </IconButton>
        {room && isHost ? (
          <Button variant="danger" size="sm" onClick={() => setEndConfirmOpen(true)}>End Room</Button>
        ) : room ? (
          <Button variant="danger" size="sm" onClick={requestLeave}>
            <LogOut size={14} />
            Leave
          </Button>
        ) : null}
      </div>
    </header>
  )

  // Error/loading/joining checks - MUST be after all hooks but before main render
  if (error) {
    return (
      <Layout header={header} wide className={styles.layout}>
        <div className={styles.error}>
          <h3>Room Error</h3>
          <p>{error}</p>
          <Button as={Link} to="/" variant="secondary">Back to Home</Button>
        </div>
      </Layout>
    )
  }

  if (!room) {
    return (
      <Layout header={header} wide className={styles.layout}>
        <div className={styles.loading}>
          <p>Loading room...</p>
          <p style={{ fontSize: '0.875rem', color: '#888', marginTop: '1rem' }}>
            If this persists, the room may have been deleted.
          </p>
          <Button as={Link} to="/" variant="secondary" style={{ marginTop: '1rem' }}>Back to Home</Button>
        </div>
      </Layout>
    )
  }

  if (!joined) {
    return (
      <Layout header={header} wide className={styles.layout}>
        <div className={styles.joining}>
          <p>Joining room...</p>
        </div>
      </Layout>
    )
  }

  // Native room gate: while the native room is open, keep the web video
  // unmounted (the native activity plays it). After it closes, offer to
  // reopen it, fall back to the web player, or leave.
  if (nativeGate === 'launching' && nativeSupported) {
    return (
      <Layout header={header} wide className={styles.layout}>
        <div className={styles.joining}>
          <p>Opening room…</p>
          <p style={{ fontSize: '0.875rem', color: '#888', marginTop: '1rem' }}>
            {room?.title || 'This room'} is playing in the native player.
          </p>
          <Button
            variant="secondary"
            style={{ marginTop: '1rem' }}
            onClick={() => {
              try { localStorage.setItem('chan:forceWebRoom', '1') } catch { /* ignore */ }
              setNativeGate('done')
            }}
          >
            Use web player instead
          </Button>
        </div>
      </Layout>
    )
  }

  if (nativeGate === 'returned' && nativeSupported) {
    return (
      <Layout header={header} wide className={styles.layout}>
        <div className={styles.joining}>
          <p>You&apos;re back in the room</p>
          <p style={{ fontSize: '0.875rem', color: '#888', marginTop: '1rem' }}>
            Resume watching here, or reopen the native room player.
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: '1rem', flexWrap: 'wrap' }}>
            <Button
              onClick={() => {
                nativeLaunchedRef.current = false
                setNativeGate('launching')
              }}
            >
              Reopen Native Room
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                try { localStorage.setItem('chan:forceWebRoom', '1') } catch { /* ignore */ }
                setNativeGate('done')
              }}
            >
              Use Web Player
            </Button>
            <Button variant="secondary" onClick={() => { leave().catch(() => {}) }}>
              Leave Room
            </Button>
          </div>
        </div>
      </Layout>
    )
  }

  return (
    <Layout header={header} wide className={styles.layout}>
      <div className={styles.main}>
        <div className={styles.stage}>
          <div className={styles.playerWrap} style={{ boxShadow: vibeGlowStyle, transition: 'box-shadow 0.4s ease' }}>
            {isYoutube || isDirectVideo ? (
              <ErrorBoundary fallback={(error, resetError) => (
                <div className={styles.errorContainer}>
                  <h3>Video Player Error</h3>
                  <p>{error?.message || 'The video failed to load. This could be due to network issues, unsupported format, or the stream being unavailable.'}</p>
                  <button type="button" onClick={() => { resetError(); window.location.reload(); }}>
                    Retry
                  </button>
                </div>
              )}>
                <VideoPlayer
                  videoId={room.videoId}
                  videoUrl={room.videoUrl}
                  videoType={room.videoType || 'youtube'}
                  canControl={canControl}
                  onReady={onPlayerReady}
                  onPlayerEvent={onPlayerEvent}
                  onEnded={handleVideoEnded}
                  onError={(err) => {
                    console.error('VideoPlayer error:', err)
                    toast?.(err?.message || 'Video playback failed. Try another source.', { variant: 'error', duration: 5000 })
                  }}
                  roomId={roomId}
                  isLive={Boolean(
                    room.videoType === 'iptv'
                    || room.videoType === 'sports'
                    || room.source === 'iptv'
                    // VOD (nsfw/direct/youtube) must stay seekable even if isLive was set by mistake
                    || (room.isLive && room.videoType !== 'nsfw' && room.videoType !== 'direct' && room.videoType !== 'youtube')
                  )}
                  subtitleVtt={room.subtitleVtt}
                  media={room?.media || null}
                  onReResolve={canControl ? reResolveVideo : null}
                  onRefresh={canControl ? reResolveVideo : null}
                  // Mobile chat/queue sheet: the native surface is CLIPPED to
                  // the area above the sheet (sheet height = min(70vh, 520px),
                  // mirroring RoomPage.module.css), so the panel renders ON
                  // TOP of the video like the Share modal — the video keeps
                  // playing in the visible band above it.
                  surfaceClipBottom={
                    showChat && isNarrow
                      ? Math.min((window.innerHeight || 800) * 0.7, 520)
                      : 0
                  }
                />
              </ErrorBoundary>
            ) : (
              <ScreenShare roomId={roomId} isHost={isHost} user={user} />
            )}
            {shareBanner && (
              <div className={styles.shareBanner}>
                <Monitor size={14} />
                <span>{shareBanner}</span>
              </div>
            )}
            {soundFxBanner && (
              <div className={styles.soundFxBanner}>
                <span>{soundFxBanner}</span>
              </div>
            )}
            {floatingReactions.length > 0 && (
              <div className={styles.floatingReactionsOverlay}>
                {floatingReactions.map((item) => (
                  <span key={item.id} className={styles.floatingEmoji}>
                    {item.emoji}
                  </span>
                ))}
              </div>
            )}
          </div>

          {canControl && (
            <Card className={styles.controlsCard}>
              <div className={styles.controls}>
                <Button variant="secondary" size="sm" onClick={() => setChangeVideoOpen(true)}>
                  <Film size={14} />
                  Change Video
                </Button>
                {(isYoutube || isDirectVideo) ? (
                  canShareScreen && (
                    <Button variant="secondary" size="sm" loading={busy} onClick={() => switchActivity('screenshare')}>
                      <Monitor size={14} />
                      Share Screen
                    </Button>
                  )
                ) : (
                  <Button variant="secondary" size="sm" loading={busy} onClick={() => switchActivity(room?.videoType === 'direct' ? 'direct' : 'youtube')}>
                    <Video size={14} />
                    Stop Screen Share
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => { setShowChat(true); setSidebarTab('queue') }}>
                  <ListVideo size={14} />
                  Queue ({queueItems.length}/5)
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setVibeLightingEnabled(!vibeLightingEnabled)}>
                  <Sparkles size={14} />
                  Vibe Glow: {vibeLightingEnabled ? 'On' : 'Off'}
                </Button>
                {isHost && (
                  <>
                    <Button variant="secondary" size="sm" onClick={toggleLock}>
                      {room.locked ? <Unlock size={14} /> : <Lock size={14} />}
                      {room.locked ? 'Unlock Room' : 'Lock Room'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setTitleDraft(room.title || '')
                        setEditingTitle(true)
                      }}
                    >
                      <Pencil size={14} />
                      Edit Title
                    </Button>
                  </>
                )}
              </div>
              {(isYoutube || isDirectVideo) && !canShareScreen && (
                <div className={styles.controlsFooter}>
                  <Monitor size={13} />
                  <span>Screen share requires a desktop browser</span>
                </div>
              )}
            </Card>
          )}

          <div className={styles.metaBar}>
            <button
              type="button"
              className={styles.metaToggle}
              onClick={() => setDetailsOpen((s) => !s)}
              aria-expanded={detailsOpen}
            >
              <span className={styles.metaLeft}>
                <Badge variant="live" icon={Radio} pulse>Live</Badge>
                <span className={styles.metaInfo}>
                  {participants.length}/{room.capacity} watching
                </span>
                <span className={styles.metaSep}>·</span>
                <span className={styles.metaInfo}>
                  {room?.videoType === 'iptv' ? 'Live TV' : isDirectVideo ? 'Direct Video' : isYoutube ? 'YouTube' : 'Screen Share'}
                </span>
                {queueItems.length > 0 && (
                  <>
                    <span className={styles.metaSep}>·</span>
                    <span className={styles.metaInfo}>Queue: {queueItems.length} waiting</span>
                  </>
                )}
              </span>
              {detailsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
            {detailsOpen && (
              <div className={styles.details}>
                <ParticipantList
                  participants={participants}
                  hostId={room.hostId}
                  coHosts={room.coHosts}
                  currentUserId={user?.uid}
                  isHost={isHost}
                  canControl={canControl}
                  onKick={async (uid) => {
                    try {
                      await kickParticipant(uid)
                      toast('Participant removed', { variant: 'success' })
                    } catch (err) {
                      toast(err.message || 'Kick failed', { variant: 'error' })
                    }
                  }}
                  onPromote={async (uid, role) => {
                    try {
                      await promoteParticipant(uid, role)
                      toast(role === 'co-host' ? 'Promoted to co-host' : 'Demoted to viewer', { variant: 'success' })
                    } catch (err) {
                      toast(err.message || 'Update failed', { variant: 'error' })
                    }
                  }}
                  onMute={async (uid, muted) => {
                    try {
                      await muteParticipant(uid, muted)
                      toast(muted ? 'Muted' : 'Unmuted', { variant: 'success' })
                    } catch (err) {
                      toast(err.message || 'Mute failed', { variant: 'error' })
                    }
                  }}
                />
                <Card className={styles.infoCard}>
                  <h3 className={styles.infoTitle}>Room Info</h3>
                  <p className="mono">Host: {room.hostName}</p>
                  <p className="mono">Capacity: {participants.length}/{room.capacity}</p>
                  <p className="mono">Mode: {room?.videoType === 'iptv' ? 'Live TV' : isDirectVideo ? 'Direct Video' : isYoutube ? 'YouTube' : 'Screen Share'}</p>
                  {room.isPrivate && <p className="mono">Invite: {room.inviteCode}</p>}
                  {room.locked && <p className="mono">Joins locked</p>}
                </Card>
              </div>
            )}
          </div>
        </div>

        {showChat && (
          <>
            <div className={styles.overlay} onClick={() => setShowChat(false)} />
            <aside className={`${styles.sidebar} ${showChat ? styles.open : ''}`} role="dialog" aria-label="Sidebar">
              <div className={styles.sidebarHeader}>
                <div className={styles.headerLeftSpacer} />
                <div className={styles.sidebarTabs}>
                  <button
                    type="button"
                    className={sidebarTab === 'chat' ? styles.sidebarTabActive : styles.sidebarTab}
                    onClick={() => setSidebarTab('chat')}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    className={sidebarTab === 'queue' ? styles.sidebarTabActive : styles.sidebarTab}
                    onClick={() => setSidebarTab('queue')}
                  >
                    Queue ({queueItems.length}/5)
                  </button>
                </div>
                <div className={styles.headerRightAction}>
                  <IconButton onClick={() => setShowChat(false)} aria-label="Close sidebar">
                    <X size={18} />
                  </IconButton>
                </div>
              </div>
              <div className={styles.sidebarContent}>
                {sidebarTab === 'chat' ? (
                  <Chat
                    messages={messages}
                    sendMessage={sendMessage}
                    user={user}
                    roomId={roomId}
                    typing={typing}
                    setTyping={setTyping}
                  />
                ) : (
                  <QueuePanel
                    roomId={roomId}
                    room={room}
                    user={user}
                    isHost={isHost}
                    canControl={canControl}
                    onPlayNext={onPlayNextQueueItem}
                    toast={toast}
                  />
                )}
              </div>
            </aside>
          </>
        )}
      </div>

      {/* P1: Change Video — shared browser in a modal */}
      <Modal open={changeVideoOpen} title="Change Video" icon={Film} onClose={() => setChangeVideoOpen(false)}>
        <div className={styles.changeVideoBody}>
          <form
            className={styles.searchRow}
            onSubmit={(e) => { e.preventDefault(); if (newVideoUrl.trim()) { changeVideo(e) } }}
          >
            <Input
              placeholder="Paste YouTube URL or direct .mp4 / .m3u8 / .mkv link"
              value={newVideoUrl}
              onChange={(e) => setNewVideoUrl(e.target.value)}
            />
            <Button type="submit" size="sm">Use link</Button>
          </form>
          <div className={styles.changeDivider}>
            <span>or browse</span>
          </div>
          <ShowBrowser onPick={changeVideoContent} initialMode="tv" compact />
        </div>
      </Modal>

      <ShareRoom room={room} roomId={roomId} open={shareOpen} onClose={() => setShareOpen(false)} />

      <Modal open={endConfirmOpen} title="End this room?" icon={AlertTriangle} onClose={() => setEndConfirmOpen(false)}>
        <p className={styles.confirmText}>
          This ends the room for everyone. Viewers will be disconnected and the room will be marked ended.
        </p>
        <div className={styles.confirmActions}>
          <Button variant="secondary" onClick={() => setEndConfirmOpen(false)}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={confirmEnd}>End Room</Button>
        </div>
      </Modal>

      <Modal open={leaveConfirmOpen} title="Leave while sharing?" icon={AlertTriangle} onClose={() => setLeaveConfirmOpen(false)}>
        <p className={styles.confirmText}>
          You are currently sharing your screen. Leaving will stop the share for everyone.
        </p>
        <div className={styles.confirmActions}>
          <Button variant="secondary" onClick={() => setLeaveConfirmOpen(false)}>Stay</Button>
          <Button variant="danger" loading={busy} onClick={confirmLeave}>Leave Room</Button>
        </div>
      </Modal>

      {/* Auto-Next Queue Prompt */}
      {autoNextPrompt && (
        <Modal open={Boolean(autoNextPrompt)} title="Up Next from Queue!" icon={Play} onClose={() => { clearTimeout(autoNextTimerRef.current); setAutoNextPrompt(null) }}>
          <div className={styles.autoNextModal}>
            <p className={styles.confirmText}>
              Current video finished playing. Automatically playing the next queued item in <strong>5 seconds</strong>...
            </p>
            <div className={styles.autoNextItemPreview}>
              {autoNextPrompt.thumbnail && <img src={autoNextPrompt.thumbnail} alt="" className={styles.autoNextThumb} />}
              <div>
                <h4 className={styles.autoNextTitle}>{autoNextPrompt.title}</h4>
                <span className={styles.autoNextMeta}>Added by {autoNextPrompt.addedByName}</span>
              </div>
            </div>
            <div className={styles.confirmActions}>
              <Button variant="secondary" onClick={() => { clearTimeout(autoNextTimerRef.current); setAutoNextPrompt(null) }}>
                Cancel
              </Button>
              <Button variant="cta" loading={busy} onClick={async () => {
                if (autoNextTimerRef.current) clearTimeout(autoNextTimerRef.current)
                const item = autoNextPrompt
                setAutoNextPrompt(null)
                await onPlayNextQueueItem(item)
                await deleteDoc(doc(db, 'rooms', roomId, 'queue', item.id)).catch(() => {})
              }}>
                Play Next Now
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Layout>
  )
}
