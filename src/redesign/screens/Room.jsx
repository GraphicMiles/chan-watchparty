import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import {
  X, Lock, Unlock, Monitor, AlertTriangle, Video, Play, Sparkles,
  MessageCircle, ListVideo, Users, ChevronLeft, ChevronRight, Share2, Pencil,
} from 'lucide-react'
import { collection, onSnapshot, query, orderBy, limit, deleteDoc, doc } from 'firebase/firestore'
import { db } from '../../shared/lib/firebase.js'
import { useAuth } from '../../shared/auth/hooks/useAuth.jsx'
import { useRoom } from '../../features/room/hooks/useRoom.js'
import { usePlayerSync } from '../../features/room/hooks/usePlayerSync.js'
import VideoPlayer from '../../features/room/components/VideoPlayer.jsx'
import { ErrorBoundary } from '../../shared/components/ErrorBoundary.jsx'
import ScreenShare from '../../features/room/components/ScreenShare.jsx'
import Chat from '../../features/room/components/Chat.jsx'
import QueuePanel from '../../features/room/components/QueuePanel.jsx'
import ParticipantList from '../../features/room/components/ParticipantList.jsx'
import { SyncPulse } from '../../shared/components/SyncPulse.jsx'
import { extractVideoId, normalizePlaybackUrl, getThumbnail } from '../../shared/lib/youtube.js'
import { cleanMediaTitle } from '../../shared/lib/titleFormat.js'
import { isDisplayMediaSupported } from '../../features/room/services/livekit.js'
import { Button, Modal, useToast } from '../../shared/ui/index.js'
import ShareRoom from '../../features/room/components/ShareRoom.jsx'
import { refreshDownloadDescriptor, fetchTitleSynopsis, proxyTargetUrl } from '../../shared/lib/mediaApi.js'
import { sanitizeSynopsis, looksLikeAiSynopsis } from '../../shared/lib/synopsis.js'
import { resolvePlaybackForUser, mediaDocFromDescriptor } from '../../shared/lib/resolvePlayback.js'
import { Img, Stack, Toggle, gradFor } from '../ui.jsx'

function RoomSynopsisBody({ text }) {
  const [open, setOpen] = useState(false)
  const { short, more } = truncateWords(text, 20)
  if (!text) return null
  return (
    <p className="syn-body">
      {open || !more ? text : `${short}… `}
      {more ? (
        <button type="button" onClick={() => setOpen((v) => !v)}>
          {open ? 'See less' : 'See more'}
        </button>
      ) : null}
    </p>
  )
}

const SOUND_FX_URLS = {
  airhorn: 'https://cdn.freesound.org/previews/435/435255_8863641-lq.mp3',
  cheer: 'https://cdn.freesound.org/previews/337/337049_5121236-lq.mp3',
  boom: 'https://cdn.freesound.org/previews/266/266105_4486188-lq.mp3',
  laugh: 'https://cdn.freesound.org/previews/369/369515_6687700-lq.mp3',
  applause: 'https://cdn.freesound.org/previews/483/483652_1015240-lq.mp3',
}

function truncateWords(text, max = 20) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  if (words.length <= max) return { short: words.join(' '), more: false }
  return { short: words.slice(0, max).join(' '), more: true }
}

const SOUND_FX_NAMES = {
  airhorn: 'Airhorn',
  cheer: 'Stadium Cheer',
  boom: 'Dramatic Boom',
  laugh: 'Crowd Laugh',
  applause: 'Applause',
}

export default function Room() {
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

  // Child overlays (episodes popup in QueuePanel) signal their open state so
  // the room can lock background scrolling while ANY overlay is active.
  const [childOverlayOpen, setChildOverlayOpen] = useState(false)
  useEffect(() => {
    const onModal = (e) => setChildOverlayOpen(Boolean(e?.detail))
    window.addEventListener('chan:overlay', onModal)
    return () => window.removeEventListener('chan:overlay', onModal)
  }, [])

  // Lock background scroll while the chat/queue sheet OR a child overlay
  // (episodes popup) is open — the background must not scroll behind them.
  const backgroundLocked = showChat || childOverlayOpen
  useEffect(() => {
    document.body.style.overflow = backgroundLocked ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [backgroundLocked])
  const [isNarrow, setIsNarrow] = useState(() => (typeof window !== 'undefined' ? window.innerWidth <= 768 : false))
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth <= 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
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
    banParticipant,
    reportPlayerPosition,
  } = useRoom(roomId, inviteCode)

  const { isHost, writePlayerState, canControl } = usePlayerSync(roomId, room, playerRef)

  // Groq synopsis ONLY after playback has started. Never on join/create —
  // that raced DownloadWella tokens. Uses the show/movie title, not a guess.
  const synopsisFillRef = useRef(false)
  const fillSynopsisAfterPlay = useCallback(async () => {
    if (!canControl || !user || !room || room.synopsis || synopsisFillRef.current) return
    const title = cleanMediaTitle(room.title || room.media?.title || '')
    if (!title) return
    synopsisFillRef.current = true
    const extra = room.videoType === 'youtube' ? 'YouTube video' : 'TV show or movie'
    try {
      const text = sanitizeSynopsis(await fetchTitleSynopsis(user, title, extra))
      if (text) await updateRoom({ synopsis: text, synopsisSource: 'ai' })
    } catch {
      synopsisFillRef.current = false
    }
  }, [canControl, user, room, updateRoom])

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

      if (item.videoId || item.videoType === 'youtube') {
        await updateRoom({
          videoId: item.videoId || null,
          videoUrl: null,
          videoType: 'youtube',
          activityType: 'youtube',
          title: item.title || 'Untitled',
          synopsis: sanitizeSynopsis(item.synopsis),
          media: null,
          sourceUrl: null,
        })
        await writePlayerState({
          videoId: item.videoId || '',
          videoUrl: null,
          isPlaying: true,
          currentTime: 0,
        }, true)
      } else {
        const resolved = await resolvePlaybackForUser(user, item)
        await updateRoom({
          videoId: null,
          videoUrl: resolved.videoUrl,
          videoType: item.videoType || 'direct',
          activityType: item.videoType || 'direct',
          title: item.title || 'Untitled',
          synopsis: sanitizeSynopsis(item.synopsis),
          synopsisSource: item.synopsisSource || (looksLikeAiSynopsis(item.synopsis) ? 'ai' : null),
          media: resolved.media,
          sourceUrl: resolved.sourceUrl,
          isLive: Boolean(resolved.isM3u8),
        })
        await writePlayerState({
          videoId: '',
          videoUrl: resolved.videoUrl,
          isPlaying: true,
          currentTime: 0,
        }, true)
      }
      toast('Playing queued stream!', { variant: 'success' })
    } catch (err) {
      toast(err.message || 'Could not play next stream', { variant: 'error' })
    } finally {
      setBusy(false)
    }
  }, [canControl, user, updateRoom, writePlayerState, toast])

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
  const reResolveVideo = useCallback(async (staleUrl, quiet = false) => {
    if (!canControl) {
      if (!quiet) toast('Only the host or a co-host can re-resolve the link', { variant: 'warning' })
      throw new Error('Only the host or a co-host can re-resolve the link')
    }
    setBusy(true)
    try {
      if (!quiet) toast('Re-resolving link…', { variant: 'info' })
      const resolveFrom = (room?.media?.sourceUrl && /downloadwella\.com|fsmc/i.test(room.media.sourceUrl))
        ? room.media.sourceUrl
        : (room?.sourceUrl && /downloadwella\.com|fsmc/i.test(room.sourceUrl))
          ? room.sourceUrl
          : staleUrl
      const descriptor = await refreshDownloadDescriptor(user, resolveFrom, room?.title || 'Chan video')
      const freshUrl = normalizePlaybackUrl(descriptor.streamUrl)
      const mediaDoc = mediaDocFromDescriptor(descriptor, resolveFrom)
      await updateRoom({
        videoUrl: freshUrl,
        videoType: 'direct',
        activityType: 'direct',
        isLive: false,
        media: mediaDoc,
      })
      await writePlayerState({ videoUrl: freshUrl, isPlaying: false, currentTime: 0 }, true)
      if (!quiet) toast('Link refreshed — playing', { variant: 'success' })
      return descriptor
    } catch (err) {
      if (!quiet) toast(err.message || 'Could not re-resolve the link', { variant: 'error' })
      throw err
    } finally {
      setBusy(false)
    }
  }, [canControl, user, room, updateRoom, writePlayerState, toast])

  // Mint a FRESH token the moment a newly-created direct room opens. The token
  // resolved at create time can die while the room sits paused (or be consumed
  // by an upstream probe), so we re-walk the page here — before the host ever
  // presses play. Only for the controller, only for DownloadWella-backed rooms,
  // and only within the first 90s of the room's life (never reset a returning
  // session that is mid-playback).
  const freshTokenKeyRef = useRef(null)
  useEffect(() => {
    if (!canControl || !room) return
    if (freshTokenKeyRef.current === roomId) return
    if (room.videoType !== 'direct') return
    const sourceUrl = room.media?.sourceUrl || room.sourceUrl || ''
    const streamUrl = room.media?.streamUrl || room.videoUrl || ''
    if (!/downloadwella\.com|fsmc/i.test(proxyTargetUrl(sourceUrl))) return
    if (!/downloadwella|fsmc|nkiserv|thenkiri/i.test(proxyTargetUrl(streamUrl))) return
    const ageMs = room.createdAt?.toMillis ? Date.now() - room.createdAt.toMillis() : Infinity
    if (ageMs > 90_000) return
    freshTokenKeyRef.current = roomId
    reResolveVideo(streamUrl, true).catch(() => {
      // Keep the stored link. If it's dead, the player's recovery machine will
      // re-resolve with retries.
    })
  }, [canControl, room, roomId, reResolveVideo])

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

  // Change the currently-playing video. extras.sourceUrl is the episode
  // PAGE when the pick is DownloadWella — we resolve a fresh token first.
  const changeVideo = async (url, extras = {}) => {
    const trimmedUrl = String(url || extras.sourceUrl || '').trim()
    if (!trimmedUrl) return

    const id = extractVideoId(trimmedUrl)
    try {
      setBusy(true)

      if (id) {
        await updateRoom({
          videoId: id,
          videoUrl: null,
          videoType: 'youtube',
          activityType: 'youtube',
          isLive: false,
          title: extras.title || room.title,
          synopsis: extras.synopsis !== undefined ? sanitizeSynopsis(extras.synopsis) : null,
          media: null,
          sourceUrl: null,
        })
        await writePlayerState({ videoId: id, videoUrl: null, isPlaying: false, currentTime: 0 })
      } else {
        const resolved = await resolvePlaybackForUser(user, {
          url: trimmedUrl,
          videoUrl: extras.videoUrl || trimmedUrl,
          sourceUrl: extras.sourceUrl,
          title: extras.title || room.title,
        })
        const nextType = resolved.isM3u8 ? 'iptv' : 'direct'
        await updateRoom({
          videoId: null,
          videoUrl: resolved.videoUrl,
          videoType: nextType,
          activityType: nextType,
          isLive: resolved.isM3u8,
          title: extras.title || room.title,
          synopsis: extras.synopsis !== undefined ? sanitizeSynopsis(extras.synopsis) : null,
          media: resolved.media,
          sourceUrl: resolved.sourceUrl,
        })
        await writePlayerState({ videoId: null, videoUrl: resolved.videoUrl, isPlaying: false, currentTime: 0 })
      }

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

  // Stable identity: the VideoPlayer's HLS setup effect depended on the old
  // inline onError, so every RoomPage re-render (heartbeat, chat, reactions)
  // destroyed and recreated the hls.js instance — "rebuffer / restream /
  // stops working" on live streams. Keep it referentially stable.
  const handleVideoPlayerError = useCallback((err) => {
    console.error('VideoPlayer error:', err)
    // Native already shows Retry / Re-resolve — don't stack a toast.
  }, [])

  const onPlayerEvent = (patch) => {
    if (patch && typeof patch.currentTime === 'number' && reportPlayerPosition) {
      reportPlayerPosition(patch.currentTime, patch.isPlaying)
    }
    if (canControl) writePlayerState(patch)
    // Groq only after the stream is actually playing — never on prepare/ready.
    if (patch?.isPlaying) fillSynopsisAfterPlay()
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
  // ── Redesign sheet (chat / queue / people) ────────────────────────────
  const [dragY, setDragY] = useState(null)
  const dragStart = useRef(0)
  const closeSheet = useCallback(() => setShowChat(false), [])
  const openTab = useCallback((id) => { setSidebarTab(id); setShowChat(true) }, [])
  const gripDown = (e) => {
    dragStart.current = e.clientY
    setDragY(0)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
  }
  const gripMove = (e) => {
    if (dragY === null) return
    setDragY(Math.max(0, e.clientY - dragStart.current))
  }
  const gripUp = () => {
    if (dragY === null) return
    if (dragY > 80 || dragY < 6) closeSheet()
    setDragY(null)
  }

  // Error/loading/joining checks - MUST be after all hooks but before main render
  if (error) {
    return (
      <div className="screen">
        <div className="center-state">
          <span className="peek-ic" style={{ width: 52, height: 52, borderRadius: 16, color: 'var(--danger-ink)' }}>
            <AlertTriangle size={24} />
          </span>
          <h3>Room error</h3>
          <p>{error}</p>
          <button type="button" className="btn btn-ghost btn-sm" style={{ width: 'auto', marginTop: 8 }} onClick={() => navigate('/')}>
            Back to Home
          </button>
        </div>
      </div>
    )
  }

  if (!room) {
    return (
      <div className="screen">
        <div className="center-state">
          <h3>Loading room...</h3>
          <p>If this persists, the room may have been deleted.</p>
          <button type="button" className="btn btn-ghost btn-sm" style={{ width: 'auto', marginTop: 8 }} onClick={() => navigate('/')}>
            Back to Home
          </button>
        </div>
      </div>
    )
  }

  if (!joined) {
    return (
      <div className="screen">
        <div className="center-state">
          <p>Joining room...</p>
        </div>
      </div>
    )
  }

  const modeLabel = room?.videoType === 'iptv' ? 'Live TV' : isDirectVideo ? 'Direct Video' : isYoutube ? 'YouTube' : 'Screen Share'
  const titleText = cleanMediaTitle(room.title) || 'Video'
  const miniThumb = room.videoId ? getThumbnail(room.videoId) : null
  const typingNames = (typing || []).map((t) => t.displayName).filter(Boolean)
  const lastMsg = [...messages].reverse().find((m) => m.type !== 'system' && m.text)
  const chatPeek = typingNames.length
    ? `${typingNames.join(', ')} typing…`
    : lastMsg
      ? `${lastMsg.type === 'bot' ? 'AI' : (lastMsg.displayName || 'Someone')}: ${lastMsg.text}`
      : 'No messages yet'
  const queuePeek = queueItems.length ? `Up next: ${queueItems[0].title || 'Queued video'}` : 'Nothing queued'
  const peoplePeek = room.isPrivate && room.inviteCode ? `Invite code ${room.inviteCode}` : 'Tap to invite friends'

  const tabBtn = (id, Icon, label) => (
    <button key={id} type="button" className={sidebarTab === id ? 'active' : ''} onClick={() => setSidebarTab(id)}>
      <Icon size={14} />{label}
    </button>
  )
  const peek = (id, Icon, title, sub) => (
    <button key={id} type="button" className="peek" onClick={() => openTab(id)}>
      <span className="peek-ic"><Icon size={18} /></span>
      <span className="peek-body"><b>{title}</b><span className="truncate">{sub}</span></span>
      <span className="peek-end"><ChevronRight size={16} /></span>
    </button>
  )

  return (
    <div className="screen">
      <div className="safe-top" />
      <div className="px" style={{ flex: 'none', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" className="icon-btn" onClick={requestLeave} aria-label="Leave room" title="Leave room">
          <ChevronLeft size={19} />
        </button>
        <span style={{ textAlign: 'center', flex: '1 1 auto', minWidth: 0, padding: '0 2px' }}>
          {editingTitle && isHost ? (
            <form
              style={{ display: 'flex', gap: 6, alignItems: 'center' }}
              onSubmit={(e) => { e.preventDefault(); saveTitle() }}
            >
              <span className="field" style={{ flex: '1 1 auto', height: 38 }}>
                <input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  maxLength={80}
                  autoFocus
                  aria-label="Room title"
                />
              </span>
              <button type="submit" className="btn btn-primary btn-sm" style={{ height: 38 }}>Save</button>
              <button type="button" className="text-btn" onClick={() => setEditingTitle(false)}>Cancel</button>
            </form>
          ) : (
            <>
              <b className="truncate" style={{ fontSize: 14, display: 'block' }}>
                {titleText}
                {isHost && (
                  <button
                    type="button"
                    aria-label="Edit room title"
                    style={{ color: 'var(--faint)', padding: 6 }}
                    onClick={() => { setTitleDraft(room.title || ''); setEditingTitle(true) }}
                  >
                    <Pencil size={12} style={{ verticalAlign: '-1px' }} />
                  </button>
                )}
              </b>
              <small style={{ color: 'var(--muted)', fontSize: 11, display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
                {participants.length} of {room.capacity} in
                <SyncPulse active size={10} />
              </small>
            </>
          )}
        </span>
        <button
          type="button"
          className={`pill ${room.locked ? 'pill-live' : 'pill-glass'}`}
          onClick={isHost ? toggleLock : undefined}
          disabled={!isHost}
          title={isHost ? (room.locked ? 'Tap to unlock' : 'Tap to lock') : (room.locked ? 'Room is locked' : 'Room is open')}
          aria-pressed={Boolean(room.locked)}
          style={{ flex: 'none' }}
        >
          {room.locked ? <Lock size={11} /> : <Unlock size={11} />}
          {room.locked ? 'Locked' : 'Open'}
        </button>
        <button type="button" className="icon-btn" onClick={() => setShareOpen(true)} aria-label="Share room" title="Share room">
          <Share2 size={18} />
        </button>
      </div>

      <div className="player-real" style={{ boxShadow: vibeGlowStyle, transition: 'box-shadow 0.4s ease' }}>
        {(isYoutube || isDirectVideo) ? (
          <ErrorBoundary fallback={(error, resetError) => (
            <div className="center-state" style={{ height: '100%' }}>
              <h3>Video Player Error</h3>
              <p>{error?.message || 'The video failed to load. This could be due to network issues, unsupported format, or the stream being unavailable.'}</p>
              <button type="button" className="btn btn-ghost btn-sm" style={{ width: 'auto' }} onClick={() => { resetError(); window.location.reload(); }}>
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
              onError={handleVideoPlayerError}
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
              // Wrap so the native player's extra (sourceUrl, title) args
              // never land in reResolveVideo's `quiet` param.
              onRefresh={canControl ? (src) => reResolveVideo(src) : null}
              // Sheet open: the native surface is CLIPPED to the band above
              // the sheet (sheet top = 40px) so the panel renders on top of
              // the video while it keeps playing.
              surfaceClipBottom={
                showChat && isNarrow
                  ? Math.max(0, (window.innerHeight || 800) - 40)
                  : 0
              }
              // Modals (Share, confirms) must render ABOVE the video — hide
              // the native surface while any is open.
              surfaceHidden={shareOpen || endConfirmOpen || leaveConfirmOpen || Boolean(autoNextPrompt) || childOverlayOpen}
            />
          </ErrorBoundary>
        ) : (
          <ScreenShare roomId={roomId} isHost={isHost} user={user} />
        )}
        {shareBanner && (
          <div className="banner-float">
            <Monitor size={14} />
            <span className="truncate">{shareBanner}</span>
          </div>
        )}
        {soundFxBanner && (
          <div className="banner-float">
            <span className="truncate">{soundFxBanner}</span>
          </div>
        )}
        {floatingReactions.length > 0 && (
          <div className="react-overlay">
            {floatingReactions.map((item) => (
              <span key={item.id} className="float-react">
                {item.emoji}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="px" style={{ flex: 'none', marginTop: 10 }}>
        <b className="truncate" style={{ fontSize: 15.5, lineHeight: 1.3, display: 'block' }}>{titleText}</b>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 3 }}>
          <small style={{ flex: '1 1 auto', minWidth: 0, color: 'var(--muted)', fontSize: 12 }}>
            {modeLabel}, you are {canControl ? (isHost ? 'Host' : 'Co-host') : 'Viewer'}
            {queueItems.length > 0 ? `, ${queueItems.length} in queue` : ''}
          </small>
          {participants.length > 0 && <Stack people={participants} size={26} />}
        </div>
        {room.synopsis ? (
          <div style={{ marginTop: 6 }}>
            {(room.synopsisSource === 'ai' || looksLikeAiSynopsis(room.synopsis)) ? (
              <span className="ai-tag">AI inferred</span>
            ) : null}
            <RoomSynopsisBody text={room.synopsis} />
          </div>
        ) : null}
      </div>

      {canControl && (
        <>
          <div className="action-pills">
            {(isYoutube || isDirectVideo) ? (
              canShareScreen && (
                <button type="button" disabled={busy} onClick={() => switchActivity('screenshare')}>
                  <Monitor size={14} />Share screen
                </button>
              )
            ) : (
              <button type="button" disabled={busy} onClick={() => switchActivity(room?.videoType === 'direct' ? 'direct' : 'youtube')}>
                <Video size={14} />Stop share
              </button>
            )}
            <button type="button" className={vibeLightingEnabled ? 'on' : ''} onClick={() => setVibeLightingEnabled(!vibeLightingEnabled)}>
              <Sparkles size={14} />Vibe Glow {vibeLightingEnabled ? 'On' : 'Off'}
            </button>
            <button type="button" onClick={() => openTab('queue')}>
              <ListVideo size={14} />Change video
            </button>
          </div>
          {(isYoutube || isDirectVideo) && !canShareScreen && (
            <div className="helper px" style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
              <Monitor size={13} />
              <span>Screen share requires a desktop browser</span>
            </div>
          )}
        </>
      )}

      <div className="scroll" style={{ paddingBottom: 8 }}>
        <div className="peeks">
          {peek('chat', MessageCircle, 'Chat', chatPeek)}
          {peek('queue', ListVideo, `Queue, ${queueItems.length} of 5`, queuePeek)}
          {peek('people', Users, `People, ${participants.length} of ${room.capacity} in`, peoplePeek)}
        </div>
      </div>

      <div className={`rs-wrap${showChat ? '' : ' closed'}`}>
        <div className="rs-dim" onClick={closeSheet} />
        <div
          className="rs"
          role="dialog"
          aria-label="Chat and queue"
          style={dragY !== null ? { transform: `translateY(${dragY}px)`, transition: 'none' } : undefined}
        >
          <div
            className="rs-grip"
            aria-label="Close panel"
            onPointerDown={gripDown}
            onPointerMove={gripMove}
            onPointerUp={gripUp}
            onPointerCancel={gripUp}
          >
            <i />
          </div>
          <div className="rs-head">
            <div className="room-tabs">
              {tabBtn('chat', MessageCircle, 'Chat')}
              {tabBtn('queue', ListVideo, `Queue ${queueItems.length}/5`)}
              {tabBtn('people', Users, 'People')}
            </div>
            <button type="button" className="icon-btn" onClick={closeSheet} aria-label="Close">
              <X size={17} />
            </button>
          </div>
          <div className="rs-mini">
            <button type="button" className="rs-mini-back" onClick={closeSheet} aria-label="Back to video">
              <span className="rs-mini-thumb" style={gradFor(roomId)}>
                <Img src={miniThumb} alt="" />
              </span>
              <span style={{ minWidth: 0, flex: '1 1 auto' }}>
                <b className="truncate">{titleText}</b>
                <small>
                  <span className="live-dot ok" />{participants.length} watching, tap to watch
                </small>
              </span>
            </button>
          </div>

          {sidebarTab === 'chat' && (
            <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', padding: '2px 10px calc(10px + env(safe-area-inset-bottom,0px))' }}>
              <Chat
                messages={messages}
                sendMessage={sendMessage}
                user={user}
                roomId={roomId}
                typing={typing}
                setTyping={setTyping}
              />
            </div>
          )}

          {sidebarTab === 'queue' && (
            <div className="scroll">
              <QueuePanel
                roomId={roomId}
                room={room}
                user={user}
                isHost={isHost}
                canControl={canControl}
                onPlayNext={onPlayNextQueueItem}
                onChangeVideo={changeVideo}
                toast={toast}
              />
            </div>
          )}

          {sidebarTab === 'people' && (
            <div className="scroll">
              <div className="card" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <b style={{ fontSize: 14, display: 'block' }}>{room.isPrivate ? 'Invite code' : 'Invite friends'}</b>
                  {room.isPrivate && room.inviteCode ? (
                    <small className="mono" style={{ color: 'var(--text)', fontSize: 15, fontWeight: 800, letterSpacing: '.12em' }}>{room.inviteCode}</small>
                  ) : (
                    <small style={{ color: 'var(--muted)', fontSize: 12 }}>Share the link or QR code.</small>
                  )}
                </span>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setShareOpen(true)}>
                  <Share2 size={14} />Share
                </button>
              </div>

              <div className="card" style={{ marginTop: 12, padding: '4px 16px' }}>
                <div className="switch-row">
                  <span>
                    <b>Lock joins</b>
                    <small>{room.locked ? 'New joins are blocked.' : 'Room is open to new joiners.'}</small>
                  </span>
                  {isHost
                    ? <Toggle on={Boolean(room.locked)} onChange={() => toggleLock()} label="Lock joins" />
                    : <span className="pill pill-glass">{room.locked ? 'Locked' : 'Open'}</span>}
                </div>
              </div>

              <div style={{ marginTop: 8 }}>
                <ParticipantList
                  participants={participants}
                  hostId={room.hostId}
                  coHosts={room.coHosts}
                  bannedUids={room.bannedUids || []}
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
                  onBan={async (uid, banned) => {
                    try {
                      await banParticipant(uid, banned)
                      toast(banned ? 'Participant banned' : 'Ban lifted', { variant: 'success' })
                    } catch (err) {
                      toast(err.message || (banned ? 'Ban failed' : 'Unban failed'), { variant: 'error' })
                    }
                  }}
                />
              </div>

              <div className="card" style={{ marginTop: 14 }}>
                <b style={{ fontSize: 14 }}>Room info</b>
                <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.9, marginTop: 8 }}>
                  Host: {room.hostName}<br />
                  Capacity: {participants.length}/{room.capacity}<br />
                  Mode: {modeLabel}<br />
                  Privacy: {room.isPrivate ? 'Private' : 'Public'}
                  {room.isPrivate && <><br />Invite: {room.inviteCode}</>}
                  {room.locked && <><br />Joins locked</>}
                </div>
              </div>

              <div className="px" style={{ marginTop: 16 }}>
                {isHost ? (
                  <button type="button" className="btn btn-danger" style={{ height: 44, fontSize: 14 }} onClick={() => setEndConfirmOpen(true)}>
                    End room for everyone
                  </button>
                ) : (
                  <button type="button" className="btn btn-danger" style={{ height: 44, fontSize: 14 }} onClick={requestLeave}>
                    Leave room
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Change Video lives inside the Queue tab (QueuePanel) */}
      <ShareRoom room={room} roomId={roomId} open={shareOpen} onClose={() => setShareOpen(false)} />

      <Modal open={endConfirmOpen} title="End this room?" icon={AlertTriangle} onClose={() => setEndConfirmOpen(false)}>
        <p style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--muted)' }}>
          This ends the room for everyone. Viewers will be disconnected and the room will be marked ended.
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={() => setEndConfirmOpen(false)}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={confirmEnd}>End Room</Button>
        </div>
      </Modal>

      <Modal open={leaveConfirmOpen} title="Leave while sharing?" icon={AlertTriangle} onClose={() => setLeaveConfirmOpen(false)}>
        <p style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--muted)' }}>
          You are currently sharing your screen. Leaving will stop the share for everyone.
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={() => setLeaveConfirmOpen(false)}>Stay</Button>
          <Button variant="danger" loading={busy} onClick={confirmLeave}>Leave Room</Button>
        </div>
      </Modal>

      {/* Auto-Next Queue Prompt */}
      {autoNextPrompt && (
        <Modal open={Boolean(autoNextPrompt)} title="Up Next from Queue!" icon={Play} onClose={() => { clearTimeout(autoNextTimerRef.current); setAutoNextPrompt(null) }}>
          <div>
            <p style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--muted)' }}>
              Current video finished playing. Automatically playing the next queued item in <strong>5 seconds</strong>...
            </p>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 14 }}>
              {autoNextPrompt.thumbnail && (
                <img src={autoNextPrompt.thumbnail} alt="" style={{ width: 64, height: 40, objectFit: 'cover', borderRadius: 10 }} />
              )}
              <div style={{ minWidth: 0 }}>
                <h4 style={{ fontSize: 14 }}>{autoNextPrompt.title}</h4>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Added by {autoNextPrompt.addedByName}</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
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
    </div>
  )
}
