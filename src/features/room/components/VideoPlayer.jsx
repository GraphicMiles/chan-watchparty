import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactPlayer from 'react-player'
import { Capacitor } from '@capacitor/core'
import { Hls, Events, ErrorTypes, isSupported } from 'hls.js'
import {
  AlertTriangle, Radio, Play, Pause, RotateCcw, RotateCw, Loader2,
  Volume2, VolumeX, Maximize, PictureInPicture2, Bookmark, Settings, Sun, Eye, EyeOff, FileText
} from 'lucide-react'
import { collection, addDoc, query, orderBy, limit, onSnapshot, serverTimestamp } from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'
import { normalizePlaybackUrl, isRemuxProxyUrl, withRemuxSeekTime, getRemuxSeekTime } from '../../../shared/lib/youtube.js'
import { proxyTargetUrl } from '../../../shared/lib/mediaApi.js'
import { playbackAccess } from '../../../shared/lib/resolvePlayback.js'
import { useToast } from '../../../shared/ui/index.js'
import NativeEmbeddedPlayer from './NativeEmbeddedPlayer.jsx'
import styles from './VideoPlayer.module.scss'
import { apiPath } from '../../../shared/lib/api.js'
import { VideoPlayerPlugin } from '../../../native/VideoPlayerPlugin'

const RETRY_ATTEMPTS = 3
const RETRY_DELAY = 3000

function youtubeUrl(videoId) {
  return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : ''
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) return '00:00'
  const sec = Math.max(0, Math.floor(seconds))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// MediaError code → human-readable message (module-level constant → stable identity,
// so it never needs to be a hook dependency and cannot cause a stale closure)
const MEDIA_ERROR_MESSAGES = {
  1: 'Playback was aborted. Try again.',
  2: 'Network error — the stream server may be down, slow, or the proxy timed out. Try again or use a different source.',
  3: 'Decoding error — this stream format is not supported or the file is corrupt. Try a different source.',
  4: 'Source not supported — the video URL may not return a playable video, the server may have returned an error page, or the stream timed out. Try a different source.',
}

// Detect demuxer/pipeline errors from error message (pure helper)
const isDemuxerError = (msg) => /demuxer|pipeline|format error/i.test(msg || '')

export default function VideoPlayer({
  videoId,
  videoUrl,
  videoType = 'youtube',
  canControl = false,
  onReady,
  onPlayerEvent,
  roomId,

  url,
  playing,
  played = 0,
  volume: controlledVolume = 1,
  muted: controlledMuted = false,
  playbackRate = 1,
  onProgress,
  onDuration,
  onPlay,
  onPause,
  onEnded,
  onError,
  isLive = false,
  subtitleVtt = null,
  onReResolve = null,
  media = null,
  onRefresh = null,
  surfaceHidden = false, // room panels open -> hide native surface
  surfaceClipBottom = 0, // CSS px clipped off viewport bottom (mobile sheet) —
                         // native surface never covers the panel → panel on top
}) {
  const { user } = useAuth()
  const { toast } = useToast()
  const rawUrl = url || videoUrl || (videoType === 'youtube' ? youtubeUrl(videoId) : '')
  const resolvedUrl = useMemo(() => normalizePlaybackUrl(rawUrl), [rawUrl])
  const isNativeAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  // Allow runtime proxy fallback if direct playback fails (e.g. missing CORS headers)
  const [currentUrl, setCurrentUrl] = useState(resolvedUrl)
  const proxyFallbackAttemptedRef = useRef(false)
  // Logical timeline origin for MKV seek-by-time remux (player clock restarts at 0)
  const remuxBaseTimeRef = useRef(0)
  useEffect(() => {
    // Room videoUrl is usually base (no t=). Don't clobber an in-progress remux seek
    // when parent re-renders the same file without t=.
    setCurrentUrl((prev) => {
      try {
        if (isRemuxProxyUrl(prev) && isRemuxProxyUrl(resolvedUrl)) {
          const prevU = new URL(prev, window.location.origin)
          const nextU = new URL(resolvedUrl, window.location.origin)
          if (prevU.searchParams.get('url') === nextU.searchParams.get('url')) {
            // Same media file — keep current seek URL (has t= / _seek=)
            return prev
          }
        }
      } catch { /* fall through */ }
      remuxBaseTimeRef.current = getRemuxSeekTime(resolvedUrl)
      return resolvedUrl
    })
    proxyFallbackAttemptedRef.current = /^\/api\/proxy\?/i.test(resolvedUrl)
  }, [resolvedUrl])

  // Detect HLS even when wrapped in /api/proxy?url=...%2Fplaylist.m3u8
  const isHls = useMemo(() => {
    if (!currentUrl) return false
    if (/(?:\.m3u8|m3u8)/i.test(currentUrl)) return true
    if (videoType === 'iptv' || videoType === 'sports') return true
    if (isLive && !/\.(mp4|webm|mkv|ogg|mov)(\?|#|$)/i.test(currentUrl)) return true
    // Decode proxy target for detection
    try {
      if (/\/api\/proxy\?/i.test(currentUrl)) {
        const u = new URL(currentUrl, typeof window !== 'undefined' ? window.location.origin : 'https://chan.invalid')
        const target = u.searchParams.get('url') || ''
        if (/(?:\.m3u8|m3u8)/i.test(target)) return true
        try {
          const decoded = decodeURIComponent(target)
          if (/(?:\.m3u8|m3u8)/i.test(decoded)) return true
        } catch { /* */ }
      }
    } catch { /* */ }
    return false
  }, [currentUrl, videoType, isLive])

  // Phase B: on Android, ALL non-YouTube content plays through the single
  // embedded native engine — no choice screen, no web fallback, ever. If the
  // native engine cannot play a stream, the recovery state machine resolves a
  // better stream or fails honestly. (YouTube stays on the web embed.)
  const isNativeEmbedded = useMemo(() => {
    if (!isNativeAndroid || !currentUrl || videoType === 'youtube') return false
    return true // direct / iptv / sports / nsfw / HLS → native engine (ExoPlayer/VLC)
  }, [isNativeAndroid, currentUrl, videoType])

  const isMixedContent = useMemo(
    () => typeof window !== 'undefined' && window.location.protocol === 'https:' && /^http:\/\//i.test(currentUrl),
    [currentUrl]
  )

  const playerWrapperRef = useRef(null)
  const playerRef = useRef(null)
  const hlsRef = useRef(null)
  const videoRef = useRef(null)
  const retryCountRef = useRef(0)
  const hlsErrorCountRef = useRef(0)
  const retryTimeoutRef = useRef(null)
  const playingRef = useRef(Boolean(playing))
  const onReadyRef = useRef(onReady)
  const onPlayerEventRef = useRef(onPlayerEvent)
  const onEndedRef = useRef(onEnded)
  const onErrorRef = useRef(onError)

  const [error, setError] = useState(null)
  const [isReady, setIsReady] = useState(false)
  const [isBuffering, setIsBuffering] = useState(false)
  const [bufferingPercent, setBufferingPercent] = useState(0)
  const [isPlayingState, setIsPlayingState] = useState(Boolean(playing))
  const [currentSec, setCurrentSec] = useState(0)
  const [durationSec, setDurationSec] = useState(0)
  const [loadedPercent, setLoadedPercent] = useState(0)
  const [localVolume, setLocalVolume] = useState(controlledVolume)
  const [localMuted, setLocalMuted] = useState(controlledMuted)
  // Mirror of localMuted for the adapter's playVideo() — avoids a stale
  // closure on the mute flag when autoplay falls back to muted.
  const localMutedRef = useRef(localMuted)
  useEffect(() => { localMutedRef.current = localMuted }, [localMuted])
  const [showControls, setShowControls] = useState(true)
  const [showSecondaryControls, setShowSecondaryControls] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [brightnessMultiplier, setBrightnessMultiplier] = useState(1.0)
  const [qualityMenuUp, setQualityMenuUp] = useState(true)
  const [hlsLevels, setHlsLevels] = useState([])
  const [currentLevel, setCurrentLevel] = useState(-1)
  const [showQualityMenu, setShowQualityMenu] = useState(false)
  const [stagePins, setStagePins] = useState([])
  const [vlcGesture, setVlcGesture] = useState(null)
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(false)
  const [subtitlesLoading, setSubtitlesLoading] = useState(false)
  
  const controlsTimeoutRef = useRef(null)
  // ── Option A native wiring: the app's control bar drives the native engine ──
  const nativeApiRef = useRef(null)
  const controlsOverlayRef = useRef(null)
  const [controlsHeight, setControlsHeight] = useState(0) // CSS px of the bar strip
  const [nativeBuffering, setNativeBuffering] = useState(false)
  const lastTapTimeRef = useRef(0)
  const lastToggleTimeRef = useRef(0)
  const vlcAccumulatorRef = useRef(0)
  const vlcSideRef = useRef(null)
  const vlcTimerRef = useRef(null)
  const singleTapTimerRef = useRef(null)

  const subtitleBlobUrl = useMemo(() => {
    if (!subtitleVtt) return null
    try {
      return URL.createObjectURL(new Blob([subtitleVtt], { type: 'text/vtt' }))
    } catch {
      return null
    }
  }, [subtitleVtt])

  // Revoke previous blob URLs to avoid memory leaks
  const prevSubtitleBlobRef = useRef(null)
  useEffect(() => {
    if (subtitleBlobUrl && subtitleBlobUrl !== prevSubtitleBlobRef.current) {
      if (prevSubtitleBlobRef.current) {
        URL.revokeObjectURL(prevSubtitleBlobRef.current)
      }
      prevSubtitleBlobRef.current = subtitleBlobUrl
    }
    return () => {
      if (prevSubtitleBlobRef.current) {
        URL.revokeObjectURL(prevSubtitleBlobRef.current)
        prevSubtitleBlobRef.current = null
      }
    }
  }, [subtitleBlobUrl])

  // Native TextTrack-based subtitle overlay.
  // Manual VTT parsers break on cue IDs, settings, and WEBVTT headers,
  // so we let the browser parse the track and just mirror the active cue.
  const [currentSubtitleCueText, setCurrentSubtitleCueText] = useState(null)

  const syncActiveCue = useCallback((track) => {
    const cue = track?.activeCues?.[0]
    if (cue && cue.text) {
      setCurrentSubtitleCueText(cue.text)
    } else {
      setCurrentSubtitleCueText(null)
    }
  }, [])

  useEffect(() => {
    if (!videoRef.current || !videoRef.current.textTracks) return
    const tracks = videoRef.current.textTracks
    let targetTrack = null
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      if (track.kind === 'subtitles' || track.kind === 'captions') {
        track.mode = subtitlesEnabled ? 'showing' : 'hidden'
        if (subtitlesEnabled) targetTrack = track
      } else {
        track.mode = 'hidden'
      }
    }
    if (!targetTrack) {
      setCurrentSubtitleCueText(null)
      return
    }
    const onCueChange = () => syncActiveCue(targetTrack)
    targetTrack.addEventListener('cuechange', onCueChange)
    // Some browsers already have an active cue loaded before the listener attaches
    syncActiveCue(targetTrack)
    return () => {
      targetTrack.removeEventListener('cuechange', onCueChange)
    }
  }, [subtitlesEnabled, subtitleBlobUrl, syncActiveCue])

  useEffect(() => {
    const onFsChange = () => {
      const fsElement = document.fullscreenElement || document.webkitFullscreenElement
      setIsFullscreen(Boolean(fsElement))
    }
    document.addEventListener('fullscreenchange', onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      document.removeEventListener('webkitfullscreenchange', onFsChange)
    }
  }, [])

  // Brightness only (AI Upscale + LUT filters cut from v1 — keep the core
  // video controls: play/pause, scrub, volume, seek, fullscreen, PiP, CC).
  const activeFilterCss = useMemo(() => {
    if (brightnessMultiplier === 1) return 'none'
    return `brightness(${brightnessMultiplier})`
  }, [brightnessMultiplier])

  const videoStyle = useMemo(() => ({
    filter: activeFilterCss,
    transition: 'filter 0.25s ease',
  }), [activeFilterCss])


  // Brightness slider (50%..200%). <=100% is a pure dim overlay on the
  // native surface (never touches the engine); >100% uses the engine's
  // Brightness effect (Exo live / VLC debounced re-prepare). Web keeps pure
  // CSS brightness().
  const handleBrightnessChange = useCallback((e) => {
    e?.stopPropagation()
    const val = Number(e.target.value) / 100
    setBrightnessMultiplier(Math.max(0, Math.min(2, val)))
  }, [])

  const [brightnessPop, setBrightnessPop] = useState(false)
  const brightnessOpenRef = useRef(false)

  // Brightness popup: on Android the popup is rendered in the NATIVE layer
  // (RoomPlayerOverlayView) so it sits above the video surface — the video
  // keeps playing underneath. On web it's the CSS overlay.
  const toggleBrightnessPopup = useCallback(() => {
    if (isNativeEmbedded) {
      // Ref-based: never depends on possibly-stale state or missed events.
      const next = !brightnessOpenRef.current
      brightnessOpenRef.current = next
      setBrightnessPop(next)
      VideoPlayerPlugin.showBrightnessPopup({ visible: next, brightness: brightnessMultiplier }).catch(() => {})
    } else {
      setBrightnessPop((v) => {
        brightnessOpenRef.current = !v
        return !v
      })
    }
  }, [isNativeEmbedded, brightnessMultiplier])

  const [volumePop, setVolumePop] = useState(false)
  const volumeOpenRef = useRef(false)

  // Volume popover: on Android the popover is rendered in the NATIVE layer
  // (RoomPlayerOverlayView) so it sits above the video surface — the video
  // keeps playing underneath. On web it's the CSS overlay. Same pattern as
  // the brightness popover so both center identically and never clip.
  const toggleVolumePopup = useCallback(() => {
    if (isNativeEmbedded) {
      const next = !volumeOpenRef.current
      volumeOpenRef.current = next
      setVolumePop(next)
      VideoPlayerPlugin.showVolumePopup({ visible: next, volume: localVolume, muted: localMuted }).catch(() => {})
    } else {
      setVolumePop((v) => {
        volumeOpenRef.current = !v
        return !v
      })
    }
  }, [isNativeEmbedded, localVolume, localMuted])

  // Sync brightness from the native popup slider + close events back to JS.
  useEffect(() => {
    if (!isNativeEmbedded) return undefined
    let removeChanged
    let removeClosed
    let cancelled = false
    VideoPlayerPlugin.addListener('brightnessChanged', (e) => {
      if (typeof e?.brightness === 'number' && !cancelled) {
        setBrightnessMultiplier(Math.max(0, Math.min(2, e.brightness)))
      }
    }).then((l) => { if (cancelled) { try { l?.remove?.() } catch {} } else removeChanged = l?.remove })
    VideoPlayerPlugin.addListener('brightnessPopupClosed', () => {
      if (cancelled) return
      brightnessOpenRef.current = false
      setBrightnessPop(false)
    }).then((l) => { if (cancelled) { try { l?.remove?.() } catch {} } else removeClosed = l?.remove })
    return () => {
      cancelled = true
      try { removeChanged?.(); removeClosed?.() } catch { /* ignore */ }
    }
  }, [isNativeEmbedded])

  // Sync volume from the native popover slider + close events back to JS.
  useEffect(() => {
    if (!isNativeEmbedded) return undefined
    let removeChanged
    let removeClosed
    let cancelled = false
    VideoPlayerPlugin.addListener('volumeChanged', (e) => {
      if (cancelled) return
      if (typeof e?.volume === 'number') setLocalVolume(Math.max(0, Math.min(1, e.volume)))
      if (typeof e?.muted === 'boolean') setLocalMuted(e.muted)
    }).then((l) => { if (cancelled) { try { l?.remove?.() } catch {} } else removeChanged = l?.remove })
    VideoPlayerPlugin.addListener('volumePopupClosed', () => {
      if (cancelled) return
      volumeOpenRef.current = false
      setVolumePop(false)
    }).then((l) => { if (cancelled) { try { l?.remove?.() } catch {} } else removeClosed = l?.remove })
    return () => {
      cancelled = true
      try { removeChanged?.(); removeClosed?.() } catch { /* ignore */ }
    }
  }, [isNativeEmbedded])

  useEffect(() => {
    onReadyRef.current = onReady
    onPlayerEventRef.current = onPlayerEvent
    onEndedRef.current = onEnded
    onErrorRef.current = onError
  }, [onReady, onPlayerEvent, onEnded, onError])

  useEffect(() => {
    if (playing !== undefined) {
      playingRef.current = Boolean(playing)
      setIsPlayingState(Boolean(playing))
    }
  }, [playing])

  useEffect(() => {
    if (!isPlayingState) {
      setShowControls(true)
    }
  }, [isPlayingState])

  useEffect(() => {
    if (!roomId) return undefined
    const q = query(collection(db, 'rooms', roomId, 'stagePins'), orderBy('timeSec', 'asc'), limit(30))
    const unsub = onSnapshot(q, (snap) => {
      setStagePins(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    })
    return unsub
  }, [roomId])

  const currentTime = useCallback(() => {
    // Native mode: the web players (videoRef/playerRef) are null — read the
    // native adapter's position so ±10s, Pin bookmarks and AI CC use the
    // REAL playback position instead of 0.
    if (nativeApiRef.current) return nativeApiRef.current.getCurrentTime?.() ?? 0
    if (isHls) return videoRef.current?.currentTime || 0
    const local = playerRef.current?.getCurrentTime?.() || 0
    // Remux-from-t streams restart at 0; expose room-absolute time for sync
    if (isRemuxProxyUrl(currentUrl)) {
      return (remuxBaseTimeRef.current || 0) + local
    }
    return local
  }, [isHls, currentUrl])

  // Keep scrubber/labels on absolute timeline for remux seeks
  const toAbsoluteSec = useCallback((localSec) => {
    if (isRemuxProxyUrl(currentUrl)) {
      return (remuxBaseTimeRef.current || 0) + (Number(localSec) || 0)
    }
    return Number(localSec) || 0
  }, [currentUrl])

  const playerState = useCallback(() => (playingRef.current ? 1 : 2), [])

  /**
   * True live linear streams (IPTV/sports) vs VOD HLS (PornHub etc.).
   * CRITICAL: must NOT treat every m3u8 as live — that disables seeking
   * (seekTo early-return + isLive() blocks double-tap / scrub for NSFW VOD).
   * Declared here (below durationSec/videoRef/isHls) so its dependency array
   * never references a not-yet-initialized binding — that was a TDZ ReferenceError.
   */
  const isLivePlayback = useCallback(() => {
    if (videoType === 'iptv' || videoType === 'sports') return true
    if (isLive && videoType !== 'nsfw' && videoType !== 'direct') return true
    // Explicit room live flag only when not a VOD type
    if (isLive && (videoType === 'nsfw' || videoType === 'direct')) {
      // nsfw/direct with isLive is rare; trust finite duration when known
      const d = durationSec || videoRef.current?.duration || 0
      if (d > 0 && Number.isFinite(d) && d < 86400) return false
      return Boolean(isLive)
    }
    if (isHls) {
      const d = durationSec || videoRef.current?.duration || 0
      // VOD HLS playlists have a finite duration (seconds–hours)
      if (d > 0 && Number.isFinite(d) && d < 86400) return false
      // No duration yet: default live only for iptv/sports (handled above)
      // For nsfw/direct assume VOD until proven otherwise so seek works
      if (videoType === 'nsfw' || videoType === 'direct' || videoType === 'youtube') return false
      return !Number.isFinite(d) || d <= 0 || d >= 86400
    }
    return false
  }, [videoType, isLive, isHls, durationSec])

  // Declared after currentTime() so the dependency is safe (was 'used before defined').
  const handleAiSubtitlesToggle = useCallback(async (e) => {
    e?.stopPropagation()
    if (subtitleBlobUrl) {
      setSubtitlesEnabled((prev) => !prev)
      toast(subtitlesEnabled ? 'AI Scene Descriptions turned OFF' : 'AI Scene Descriptions turned ON', { variant: 'info' })
      return
    }
    if (!user || !roomId) {
      toast('Sign in to generate AI closed captions for this room', { variant: 'warning' })
      return
    }
    try {
      setSubtitlesLoading(true)
      const token = await user.getIdToken()
      const res = await fetch(apiPath('/api/room'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'subtitles', roomId, uid: user.uid, currentTimeSec: Math.floor(currentTime()) }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to generate AI subtitles')
      }
      setSubtitlesEnabled(true)
      toast('AI subtitles generated — scene descriptions & sound cues based on room context', { variant: 'success' })
    } catch (err) {
      toast(err.message || 'Could not generate subtitles', { variant: 'error' })
    } finally {
      setSubtitlesLoading(false)
    }
  }, [subtitleBlobUrl, subtitlesEnabled, user, roomId, toast, currentTime])

  const adapter = useMemo(() => ({
    getCurrentTime: () => nativeApiRef.current?.getCurrentTime?.() ?? currentTime(),
    getDuration: () => {
      if (nativeApiRef.current) return nativeApiRef.current.getDuration?.() || durationSec || 0
      if (isHls) return videoRef.current?.duration || durationSec || 0
      // Remux-from-t: player reports remaining length; prefer absolute durationSec
      if (isRemuxProxyUrl(currentUrl) && durationSec > 0) return durationSec
      const local = playerRef.current?.getDuration?.() || 0
      if (isRemuxProxyUrl(currentUrl) && remuxBaseTimeRef.current > 0) {
        return Math.max(durationSec || 0, remuxBaseTimeRef.current + local)
      }
      return local || durationSec || 0
    },
    getPlayerState: () => nativeApiRef.current?.getPlayerState?.() ?? playerState(),
    playVideo: () => {
      if (nativeApiRef.current) {
        nativeApiRef.current.playVideo?.()
        playingRef.current = true
        setIsPlayingState(true)
        return
      }
      // Show progress immediately while media catches up
      setIsBuffering(true)
      if (isHls) {
        const video = videoRef.current
        if (video) {
          // Autoplay policy: an unmuted play() without a user gesture is
          // rejected (NotAllowedError). This happens for everyone whose play is
          // driven by room sync (viewers) or on mobile Chrome — the old code
          // swallowed the rejection, still marked the stream "playing", and the
          // video sat on a black frame. Mute-and-retry is the standard fix.
          let muteFallbackDone = false
          const tryPlay = (muted) => {
            try { video.muted = muted } catch { /* */ }
            let promise = null
            try { promise = video.play() } catch { promise = null }
            if (promise && typeof promise.catch === 'function') {
              promise.catch(() => {
                if (!muted && !muteFallbackDone) {
                  muteFallbackDone = true
                  setLocalMuted(true)
                  tryPlay(true)
                }
              })
            }
          }
          tryPlay(localMutedRef.current)
          setIsPlayingState(true)
          return
        }
      } else {
        try {
          playerRef.current?.getInternalPlayer?.()?.playVideo?.() || playerRef.current?.getInternalPlayer?.()?.play?.()
        } catch { /* */ }
      }
      playingRef.current = true
      setIsPlayingState(true)
    },
    pauseVideo: () => {
      if (nativeApiRef.current) {
        nativeApiRef.current.pauseVideo?.()
        playingRef.current = false
        setIsPlayingState(false)
        return
      }
      if (isHls) {
        videoRef.current?.pause()
      } else {
        playerRef.current?.getInternalPlayer?.()?.pauseVideo?.() || playerRef.current?.getInternalPlayer?.()?.pause?.()
      }
      playingRef.current = false
      setIsPlayingState(false)
    },
    seekTo: (value, type = 'seconds') => {
      if (nativeApiRef.current) {
        nativeApiRef.current.seekTo?.(value, type)
        return
      }
      const dur = (isHls ? videoRef.current?.duration : playerRef.current?.getDuration?.()) || durationSec || 0
      const seekType = type === true ? 'seconds' : type
      const targetSec = seekType === 'fraction' ? (value * (dur || 0)) : value

      // MKV remux: real seek = new remux-from-t URL (synced via playerState.currentTime)
      // The remuxed fMP4 always starts at media time 0; we track absolute time via remuxBaseTimeRef.
      if (!isHls && isRemuxProxyUrl(currentUrl) && !isLive && videoType !== 'iptv') {
        const t = Math.max(0, Number(targetSec) || 0)
        const prevT = getRemuxSeekTime(currentUrl)
        const absNow = currentTime() || 0
        const localNow = playerRef.current?.getCurrentTime?.() || 0
        // Only use native seek for tiny nudges INSIDE the current remux window (local clock)
        const localTarget = t - (remuxBaseTimeRef.current || 0)
        if (
          Math.abs(t - prevT) < 0.75
          && localTarget >= 0
          && Math.abs(localNow - localTarget) < 8
          && Math.abs(absNow - t) < 3
        ) {
          try { playerRef.current?.seekTo?.(Math.max(0, localTarget), 'seconds') } catch { /* */ }
          setCurrentSec(t)
          onPlayerEventRef.current?.({ isPlaying: playingRef.current, currentTime: t, remuxStartSec: prevT || t })
          return
        }
        const next = withRemuxSeekTime(currentUrl, t)
        remuxBaseTimeRef.current = t
        setCurrentSec(t)
        setError(null)
        setIsBuffering(true)
        // Force ReactPlayer to reload even if only the t= query changed
        setCurrentUrl(next + (next.includes('?') ? '&' : '?') + `_seek=${Date.now()}`)
        // Notify room so viewers remux from the same absolute t
        onPlayerEventRef.current?.({ isPlaying: true, currentTime: t, remuxStartSec: t })
        return
      }

      if (isHls) {
        if (videoRef.current) {
          // Only block seek on true live linear streams — NOT VOD m3u8 (PornHub)
          if (isLivePlayback()) return
          const d = videoRef.current.duration
          if (!Number.isFinite(d) || d <= 0) {
            // Duration unknown yet — still try seek (HLS.js often accepts it after MANIFEST_PARSED)
          }
          try {
            videoRef.current.currentTime = Math.max(0, targetSec)
            setCurrentSec(targetSec)
            // hls.js: ensure level loads around seek point
            if (hlsRef.current) {
              try { hlsRef.current.startLoad(targetSec) } catch { /* */ }
            }
          } catch (err) {
            console.warn('HLS seek failed:', err)
          }
        }
        return
      }
      playerRef.current?.seekTo?.(value, seekType === 'fraction' ? 'fraction' : 'seconds')
      if (seekType === 'fraction' && dur) {
        setCurrentSec(value * dur)
      } else if (seekType !== 'fraction') {
        setCurrentSec(value)
      }
    },
    // Never treat VOD HLS (nsfw/direct) as live — that freezes the seek bar UX
    isLive: () => nativeApiRef.current?.isLive?.() ?? isLivePlayback(),
    loadVideoById: () => {},
  }), [currentTime, durationSec, isHls, isLive, playerState, currentUrl, videoType, isLivePlayback])

  const notifyReady = useCallback(() => {
    setIsReady(true)
    onReadyRef.current?.(adapter)
  }, [adapter])

  // Stable handle for the HLS setup effect. notifyReady's identity churns
  // whenever `adapter` changes (e.g. durationSec), which was destroying and
  // recreating the hls.js instance mid-playback — the "rebuffer / restream /
  // stops working" bug when the room re-rendered.
  const notifyReadyRef = useRef(notifyReady)
  useEffect(() => { notifyReadyRef.current = notifyReady }, [notifyReady])

  const emitPlay = useCallback(() => {
    playingRef.current = true
    setIsPlayingState(true)
    onPlay?.()
    onPlayerEventRef.current?.({ isPlaying: true, currentTime: currentTime() })
  }, [currentTime, onPlay])

  const emitPause = useCallback(() => {
    playingRef.current = false
    setIsPlayingState(false)
    onPause?.()
    onPlayerEventRef.current?.({ isPlaying: false, currentTime: currentTime() })
  }, [currentTime, onPause])

  const emitSeek = useCallback((newTimeSec) => {
    onPlayerEventRef.current?.({ isPlaying: playingRef.current, currentTime: newTimeSec })
  }, [])

  const handleError = useCallback((err) => {
    // ReactPlayer/FilePlayer passes MediaError objects or Events, NOT Error instances.
    // String(MediaError) = "[object Object]" — that's the "object entry" bug.
    let message = ''

    if (err instanceof Error) {
      message = err.message
    } else if (typeof err === 'string') {
      message = err
    } else if (err && typeof err === 'object') {
      // MediaError from <video>.error
      if (err.target?.error) {
        const code = err.target.error.code
        message = err.target.error.message || MEDIA_ERROR_MESSAGES[code] || `Video error (code ${code})`
      } else if (typeof err.code === 'number') {
        // Direct MediaError object
        message = err.message || MEDIA_ERROR_MESSAGES[err.code] || `Video error (code ${err.code})`
      } else if (err.message) {
        message = err.message
      } else if (typeof err.toString === 'function' && err.toString() !== '[object Object]') {
        message = err.toString()
      } else {
        // Last resort — never surface raw "[object Object]"
        try {
          const serialized = JSON.stringify(err)
          message = serialized && serialized !== '{}'
            ? serialized.slice(0, 200)
            : 'Video playback failed — unknown error'
        } catch {
          message = 'Video playback failed — unknown error'
        }
      }
    } else {
      message = 'Video playback failed'
    }

    if (!message || message === '[object Object]' || message === '{}') {
      message = 'Video playback failed — unknown error'
    }

    console.error('Video error:', message, err)

    // Special handling for demuxer/pipeline errors (common with live streams)
    if (isDemuxerError(message)) {
      message = videoType === 'youtube' && isLive
        ? 'YouTube live stream error — the live stream may have ended, be geo-restricted, or have encoding issues. Try another source.'
        : 'Stream decoding error — the video format may not be supported, the file may be corrupt, or the live stream may have ended. Try a different source.'
    }

    // If this is a cross-origin direct file that hasn't been proxied yet,
    // route it through /api/proxy and retry. This fixes the most common
    // MEDIA_ELEMENT_ERROR: Format error caused by missing CORS headers.
    if (
      !proxyFallbackAttemptedRef.current
      && currentUrl
      && videoType !== 'youtube'
      && !/^\/api\/proxy\?/i.test(currentUrl)
    ) {
      proxyFallbackAttemptedRef.current = true
      const proxied = normalizePlaybackUrl(currentUrl, { forceProxy: true })
      if (proxied !== currentUrl) {
        toast('Retrying through proxy to bypass CORS / mixed-content restrictions...', { variant: 'info', duration: 3000 })
        setCurrentUrl(proxied)
        setError(null)
        retryCountRef.current = 0
        return
      }
    }

    setError(message)

    // Don't retry demuxer/pipeline errors - they're usually fatal
    if (isDemuxerError(message)) {
      onErrorRef.current?.(new Error(message))
      return
    }

    if (retryCountRef.current < RETRY_ATTEMPTS) {
      retryCountRef.current += 1
      retryTimeoutRef.current = setTimeout(() => {
        if (isHls && hlsRef.current) {
          hlsRef.current.startLoad()
        } else {
          playerRef.current?.seekTo?.(played || 0, 'fraction')
        }
      }, RETRY_DELAY)
    } else {
      onErrorRef.current?.(new Error(message))
    }
  }, [currentUrl, isHls, isLive, played, toast, videoType])

  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }
  }, [])

  useEffect(() => {
    setError(null)
    setIsReady(false)
    setIsBuffering(true) // show loading as soon as source changes / play starts
    setBufferingPercent(0)
    retryCountRef.current = 0
    hlsErrorCountRef.current = 0
    clearTimeout(retryTimeoutRef.current)
    destroyHls()

    // Non-blocking soft preflight: do NOT delay the player. Only surface a hard
    // error if the probe clearly returns HTML/JSON error (expired link, 502/504).
    // Skip for remux=1 — player must start progressive remux immediately.
    // Also skip token hosts (downloadwella/fsmc/nkiserv): their CDN links are
    // single-use, and this bytes=0-1 probe makes an extra upstream request that
    // burns the token BEFORE the player's real request — the exact "unavailable
    // or expired" failure we're killing.
    const isRemux = /[?&]remux=1(?:&|$)/i.test(currentUrl || '')
    const preflightTarget = proxyTargetUrl(currentUrl || '') || ''
    const isTokenHost = /downloadwella|fsmc|nkiserv|thenkiri/i.test(preflightTarget)
    if (!isHls && currentUrl && videoType === 'direct' && currentUrl.includes('/api/proxy') && !isRemux && !isTokenHost) {
      const checkUrl = async () => {
        try {
          let checkRes
          try {
            checkRes = await fetch(currentUrl, {
              method: 'GET',
              headers: { Range: 'bytes=0-1' },
            })
          } catch {
            checkRes = await fetch(currentUrl, { method: 'HEAD' })
          }
          const contentType = checkRes.headers.get('content-type') || ''
          // Only hard-fail when the response is clearly an HTML/JSON error page
          if (
            (contentType.includes('text/html') || contentType.includes('application/json'))
            && checkRes.status >= 400
          ) {
            let serverMessage = ''
            try {
              const text = await checkRes.text()
              const parsed = JSON.parse(text)
              serverMessage = parsed.error || ''
            } catch {
              /* not JSON or empty */
            }
            const errorMsg = serverMessage
              ? serverMessage
              : checkRes.status === 504
                ? 'Stream proxy timed out on Vercel Hobby (10s). Large files are chunked automatically — retry or pick a smaller / faster source.'
                : checkRes.status === 502
                  ? 'Stream server returned an error page instead of video. The download token may have expired — go back to Nkiri, pick the episode again, and prefer an MP4 link (Chrome cannot play raw MKV).'
                  : `Stream returned ${contentType} instead of video data (HTTP ${checkRes.status}). Try a different source.`
            setError(errorMsg)
          } else {
            // Drain body if any so the connection can close
            try { await checkRes.arrayBuffer() } catch { /* */ }
          }
        } catch {
          // Network error — let the player try and show its own error
        }
      }
      checkUrl()
    }

    if (!isHls || !currentUrl || !videoRef.current) {
      return () => {}
    }

    const video = videoRef.current
    const onLoadedMetadata = () => {
      const dur = video.duration || 0
      setDurationSec(dur)
      onDuration?.(dur)
      notifyReadyRef.current?.()
    }
    const onNativeError = () => {
      const mediaErr = video.error
      if (mediaErr) {
        handleError({ code: mediaErr.code, message: mediaErr.message })
      } else {
        handleError('Video element encountered an unknown error')
      }
    }

    const canPlayNativeHls = video.canPlayType('application/vnd.apple.mpegurl') || (/iPad|iPhone|iPod|Safari/i.test(navigator.userAgent) && !/Chrome|CriOS|FxiOS|Edg/i.test(navigator.userAgent))

    if (canPlayNativeHls && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = currentUrl
      video.addEventListener('loadedmetadata', onLoadedMetadata)
    } else if (isSupported()) {
      // Live IPTV needs low-latency HLS settings; VOD m3u8 (e.g. PornHub) must NOT
      // use live mode — live mode breaks seeking / duration reporting.
      const isLiveHls = Boolean(
        videoType === 'iptv'
        || videoType === 'sports'
        || (isLive && videoType !== 'nsfw' && videoType !== 'direct')
      )
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: isLiveHls,
        backBufferLength: isLiveHls ? 30 : 90,
        maxBufferLength: isLiveHls ? 30 : 90,
        maxMaxBufferLength: isLiveHls ? 120 : 600,
        liveSyncDurationCount: isLiveHls ? 3 : undefined,
        liveMaxLatencyDurationCount: isLiveHls ? 10 : undefined,
        // Tolerate flaky free IPTV CDNs
        manifestLoadingTimeOut: isLiveHls ? 20000 : 15000,
        levelLoadingTimeOut: isLiveHls ? 20000 : 15000,
        fragLoadingTimeOut: isLiveHls ? 25000 : 20000,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
        fragLoadingMaxRetry: 6,
      })
      hlsRef.current = hls
      hls.loadSource(currentUrl)
      hls.attachMedia(video)
      hls.on(Events.MANIFEST_PARSED, (_ev, data) => {
        setHlsLevels(hls.levels || [])
        // Seed duration early so VOD seek bar enables before first timeupdate
        try {
          const level = data?.levels?.[0] || hls.levels?.[0]
          const details = level?.details
          const total = details?.totalduration || details?.duration || video.duration || 0
          if (total > 0 && Number.isFinite(total) && total < 86400) {
            setDurationSec(total)
            onDuration?.(total)
          }
        } catch { /* */ }
        notifyReadyRef.current?.()
      })
      hls.on(Events.LEVEL_SWITCHED, (_event, data) => {
        setCurrentLevel(data.level)
      })
      hls.on(Events.ERROR, (_event, data) => {
        console.log('HLS error:', data.type, data.details, 'fatal:', data.fatal)
        if (!data.fatal) {
          // Non-fatal: retry network errors, recover media errors
          if (data.type === ErrorTypes.NETWORK_ERROR) {
            console.log('HLS network error, retrying load...')
            // Show temporary warning after 3 retries
            hlsErrorCountRef.current = (hlsErrorCountRef.current || 0) + 1
            if (hlsErrorCountRef.current === 3) {
              toast('Stream is having trouble loading — the IPTV server may be slow or blocking requests', { variant: 'warning', duration: 5000 })
            }
            hls.startLoad()
          } else if (data.type === ErrorTypes.MEDIA_ERROR) {
            console.log('HLS media error, recovering...')
            hls.recoverMediaError()
          }
          return
        }
        // Fatal errors: show meaningful message to user
        const errorMsg = data.type === ErrorTypes.NETWORK_ERROR
          ? 'Stream network error — the IPTV server may be blocking this request, the channel is offline, or the stream timed out. Try another channel.'
          : data.type === ErrorTypes.MEDIA_ERROR
          ? 'Stream format error — this stream codec is not supported by your browser. Try another channel.'
          : `Stream error: ${data.details}. The channel may be offline or the link expired.`
        console.error('HLS fatal error:', errorMsg, data)
        handleError(new Error(errorMsg))
      })
    } else {
      handleError(new Error('HLS is not supported in this browser'))
    }

    video.addEventListener('error', onNativeError)
    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('error', onNativeError)
      clearTimeout(retryTimeoutRef.current)
      destroyHls()
      if (!isSupported()) video.removeAttribute('src')
    }
  }, [destroyHls, handleError, isHls, isLive, onDuration, toast, videoType, currentUrl])

  useEffect(() => () => {
    clearTimeout(retryTimeoutRef.current)
    if (nativeTapRef.current?.timer) clearTimeout(nativeTapRef.current.timer)
    destroyHls()
  }, [destroyHls])

  useEffect(() => {
    if (!playerRef.current || isHls || played == null) return
    // Never force native fraction seeks on remux streams — timeline is absolute via ?t=
    if (isRemuxProxyUrl(currentUrl)) return
    const dur = playerRef.current.getDuration?.() || 0
    const cur = playerRef.current.getCurrentTime?.() || 0
    if (dur && Math.abs(cur - played * dur) > 2) {
      playerRef.current.seekTo(played, 'fraction')
    }
  }, [isHls, played, currentUrl])

  // Track the active native <video> element for the WebGL upscaler overlay.
  // Track the control bar's live height so the native surface shrinks to the
  // video frame only (never covers the app's bar). Re-measured on layout
  // changes (secondary row, fullscreen, DPR) and when the bar shows/hides.
  useEffect(() => {
    const el = controlsOverlayRef.current
    if (!el) return
    const measure = () => {
      try {
        const h = el.getBoundingClientRect().height
        setControlsHeight(Math.round(h) || 0)
      } catch { /* keep last */ }
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [showControls, isNativeEmbedded])

  // Native playback state → app control bar (single surface requirement)
  const handleNativeProgress = useCallback(({ currentSec: cs, durationSec: ds, playing: pl, buffering: bf, percent: pc }) => {
    if (typeof cs === 'number' && Number.isFinite(cs)) setCurrentSec(cs)
    if (typeof ds === 'number' && Number.isFinite(ds) && ds > 0) setDurationSec(ds)
    if (typeof pl === 'boolean') {
      playingRef.current = pl
      setIsPlayingState(pl)
      setIsBuffering(false)
    }
    if (typeof bf === 'boolean') {
      setNativeBuffering(bf)
      setIsBuffering(bf)
      if (bf && typeof pc === 'number') setBufferingPercent(Math.max(1, Math.min(99, pc)))
    }
  }, [])

  const handleNativeApi = useCallback((api) => {
    nativeApiRef.current = api || null
  }, [])

  // ── Native surface tap handling ───────────────────────────────────────
  // The native overlay forwards every touch with its x/y fraction (fx, fy).
  // We implement the same gestures as the web player:
  //   • single tap            → toggle controls (show ⇄ hide)
  //   • double-tap LEFT half  → seek −10s
  //   • double-tap RIGHT half → seek +10s
  // Tap never exits fullscreen.
  const nativeTapRef = useRef({ last: 0, timer: null })
  const handleNativeTap = useCallback(({ x: fx } = {}) => {
    const now = Date.now()
    const ref = nativeTapRef.current
    const side = (fx == null)
      ? 'center'
      : fx < 0.38 ? 'left' : fx > 0.62 ? 'right' : 'center'

    if (ref.timer) {
      clearTimeout(ref.timer)
      ref.timer = null
    }

    // Double-tap on a side → seek by ±10s (same accumulation as the web path).
    if (now - ref.last < 340 && side !== 'center' && canControl && !adapter.isLive()) {
      ref.last = 0
      const delta = side === 'left' ? -10 : 10
      const target = Math.max(0, Math.min(durationSec || 999999, currentTime() + delta))
      adapter.seekTo(target, 'seconds')
      emitSeek(target)
      // Brief visual feedback (reuse the VLC gesture indicator).
      setVlcGesture({ side, seconds: delta })
      setTimeout(() => setVlcGesture(null), 500)
      return
    }

    ref.last = now
    // Single tap → toggle controls after a short delay (so a double-tap isn't
    // counted as two toggles).
    ref.timer = setTimeout(() => {
      ref.timer = null
      ref.last = 0
      setShowControls((s) => {
        const next = !s
        if (next) {
          // Auto-hide again while playing.
          if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
          controlsTimeoutRef.current = setTimeout(() => {
            if (playingRef.current) setShowControls(false)
          }, 3500)
        } else {
          if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
        }
        return next
      })
    }, side === 'center' ? 0 : 220)
  }, [canControl, adapter, durationSec, currentTime, emitSeek])

  const handleMouseMove = useCallback(() => {
    setShowControls(true)
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
    controlsTimeoutRef.current = setTimeout(() => {
      if (playingRef.current) {
        setShowControls(false)
        setShowQualityMenu(false)
      }
    }, 3500)
  }, [])

  const triggerToggleControls = useCallback(() => {
    lastToggleTimeRef.current = Date.now()
    setShowControls((prev) => {
      const next = !prev
      if (!next) {
        setShowQualityMenu(false)
      } else {
        if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
        if (playingRef.current) {
          controlsTimeoutRef.current = setTimeout(() => {
            if (playingRef.current) {
              setShowControls(false)
                    setShowQualityMenu(false)
            }
          }, 4000)
        }
      }
      return next
    })
  }, [])

  const handlePointerOrClick = useCallback((e) => {
    if (e?.defaultPrevented) return
    const isInteractive = e?.target?.closest?.('button, input, select, .seekbarContainer, [role="button"]')
    if (isInteractive) return

    const now = Date.now()
    // Absolute race-condition guard: if controls toggled or pointerdown triggered within last 500ms, ignore duplicate bubbling/click events
    if (now - lastToggleTimeRef.current < 500) {
      e?.stopPropagation()
      return
    }
    if (e?.type === 'click' && (e.pointerType === 'touch' || window?.matchMedia?.('(pointer: coarse)').matches || now - lastTapTimeRef.current < 500)) {
      e?.stopPropagation()
      return
    }
    if (e?.type === 'pointerdown' && e.pointerType !== 'touch') {
      return
    }

    e?.stopPropagation()
    const diff = now - lastTapTimeRef.current
    const wrapperRect = playerWrapperRef.current?.getBoundingClientRect()
    if (!wrapperRect) {
      lastTapTimeRef.current = now
      triggerToggleControls()
      return
    }

    const clientX = e?.clientX ?? (e?.touches?.[0]?.clientX || e?.changedTouches?.[0]?.clientX || 0)
    const relX = clientX - wrapperRect.left
    const width = wrapperRect.width
    const side = relX < width * 0.38 ? 'left' : relX > width * 0.62 ? 'right' : 'center'

    if (diff > 0 && diff < 340 && side !== 'center' && canControl && !adapter.isLive()) {
      lastTapTimeRef.current = now
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current)
        singleTapTimerRef.current = null
      }
      if (vlcTimerRef.current) clearTimeout(vlcTimerRef.current)

      if (vlcSideRef.current !== side) {
        vlcAccumulatorRef.current = side === 'left' ? -10 : 10
        vlcSideRef.current = side
      } else {
        vlcAccumulatorRef.current += side === 'left' ? -10 : 10
      }

      setVlcGesture({ side, seconds: vlcAccumulatorRef.current })

      vlcTimerRef.current = setTimeout(() => {
        if (vlcAccumulatorRef.current !== 0) {
          const target = Math.max(0, Math.min(durationSec || 999999, currentTime() + vlcAccumulatorRef.current))
          adapter.seekTo(target, 'seconds')
        }
        vlcAccumulatorRef.current = 0
        vlcSideRef.current = null
        setVlcGesture(null)
      }, 600)
      return
    }

    lastTapTimeRef.current = now

    if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current)
    const isDoubleTapCandidate = side !== 'center' && canControl && !adapter.isLive()
    singleTapTimerRef.current = setTimeout(() => {
      singleTapTimerRef.current = null
      triggerToggleControls()
    }, isDoubleTapCandidate ? 220 : 0)
  }, [canControl, adapter, durationSec, currentTime, triggerToggleControls])

  const handleToggleControls = handlePointerOrClick
  const handlePointerTouch = handlePointerOrClick

  const togglePlayPause = useCallback((e) => {
    e?.stopPropagation()
    if (!canControl) return
    if (playingRef.current) {
      adapter.pauseVideo()
      setIsBuffering(false)
    } else {
      setIsBuffering(true)
      adapter.playVideo()
    }
  }, [canControl, adapter])

  const jumpSeconds = useCallback((delta, e) => {
    e?.stopPropagation()
    if (!canControl) return
    const cur = currentTime()
    const target = Math.max(0, Math.min(durationSec || 999999, cur + delta))
    adapter.seekTo(target, 'seconds')
    emitSeek(target)
  }, [canControl, currentTime, durationSec, adapter, emitSeek])

  const handleSeekSlider = useCallback((e) => {
    e.stopPropagation()
    if (!canControl) return
    const fraction = Number(e.target.value) / 1000
    const dur = adapter.getDuration() || durationSec || 0
    const targetSec = fraction * dur
    // Always seek by absolute seconds so MKV remux uses ?t= correctly
    adapter.seekTo(targetSec, 'seconds')
    setCurrentSec(targetSec)
    emitSeek(targetSec)
  }, [canControl, adapter, durationSec, emitSeek])

  const toggleFullscreen = useCallback(async (e) => {
    e?.stopPropagation()
    // Native mode: fullscreen MUST go through the plugin — the native surface
    // sits above the WebView, so web fullscreen can't resize it and exiting
    // web fullscreen is what left the black screen behind (surface never
    // restored). The plugin resizes the overlay + hides system UI on enter,
    // and re-applies the stage rect + shows system UI on exit.
    if (isNativeEmbedded) {
      const next = !isFullscreen
      setIsFullscreen(next)
      try {
        await VideoPlayerPlugin.setFullscreen({ fullscreen: next })
      } catch (err) {
        console.error('Native fullscreen failed:', err)
        setIsFullscreen(!next)
        return
      }
      try {
        if (next) await window.screen?.orientation?.lock?.('landscape')?.catch?.(() => {})
        else window.screen?.orientation?.unlock?.()
      } catch { /* orientation unsupported */ }
      // Exiting fullscreen: the plugin re-applies lastRect immediately, but
      // the layout may still be settling (system bars returning, orientation
      // unlock). Force a re-measure + re-anchor of the surface to the room's
      // video box so it never gets stuck full-screen/black.
      if (!next) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            try { VideoPlayerPlugin.setVisible({ visible: true }) } catch { /* ignore */ }
          })
        })
      }
      return
    }
    const root = playerWrapperRef.current
    if (!root) return
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      try {
        if (root.requestFullscreen) {
          await root.requestFullscreen()
        } else if (root.webkitRequestFullscreen) {
          await root.webkitRequestFullscreen()
        } else if (videoRef.current?.webkitEnterFullscreen) {
          videoRef.current.webkitEnterFullscreen()
        }
      } catch (err) {
        console.error('Fullscreen request failed:', err)
      }
      try {
        if (window.screen?.orientation?.lock) {
          await window.screen.orientation.lock('landscape').catch(() => {})
        }
      } catch {
        /* orientation lock unsupported or permission denied */
      }
    } else {
      try {
        if (document.exitFullscreen) {
          await document.exitFullscreen()
        } else if (document.webkitExitFullscreen) {
          await document.webkitExitFullscreen()
        }
      } catch (err) {
        console.error('Exit fullscreen failed:', err)
      }
      try {
        if (window.screen?.orientation?.unlock) {
          window.screen.orientation.unlock()
        }
      } catch {
        /* ignore */
      }
    }
  }, [isNativeEmbedded, isFullscreen])

  // Toggle device orientation landscape ⇄ portrait while in fullscreen.
  const rotateOrientation = useCallback(async (e) => {
    e?.stopPropagation()
    try {
      const isLandscape = window.screen?.orientation?.type?.startsWith('landscape')
      if (isLandscape) {
        await window.screen?.orientation?.unlock?.()
        await window.screen?.orientation?.lock?.('portrait')?.catch?.(() => {})
      } else {
        await window.screen?.orientation?.lock?.('landscape')?.catch?.(() => {})
      }
    } catch {
      try { await window.screen?.orientation?.unlock?.() } catch { /* ignore */ }
    }
  }, [])

  const togglePiP = useCallback((e) => {
    e.stopPropagation()
    if (isNativeEmbedded) {
      VideoPlayerPlugin.enterPip().catch(() => {
        toast('Could not enter Picture in Picture mode', { variant: 'error' })
      })
      return
    }
    const video = videoRef.current || playerWrapperRef.current?.querySelector('video')
    if (!video) {
      toast('Picture in Picture only supported on direct streams / native video elements', { variant: 'warning' })
      return
    }
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture?.().catch(() => {})
    } else {
      video.requestPictureInPicture?.().catch(() => {
        toast('Could not enter Picture in Picture mode', { variant: 'error' })
      })
    }
  }, [isNativeEmbedded, toast])

  const addStagePin = useCallback(async (e) => {
    e.stopPropagation()
    if (!user || !roomId) return
    const cur = currentTime()
    const note = window.prompt(`Drop bookmark pin at ${formatTime(cur)} — Enter a quick note:`)
    if (!note || !note.trim()) return
    try {
      await addDoc(collection(db, 'rooms', roomId, 'stagePins'), {
        timeSec: cur,
        text: note.trim().slice(0, 80),
        uid: user.uid,
        displayName: user.displayName || 'Viewer',
        createdAt: serverTimestamp(),
      })
      toast('Stage pin added to timeline!', { variant: 'success' })
    } catch (err) {
      toast(err.message || 'Could not save bookmark', { variant: 'error' })
    }
  }, [user, roomId, currentTime, toast])

  const toggleMute = useCallback((e) => {
    e.stopPropagation()
    setLocalMuted((prev) => !prev)
  }, [])

  // Native mode: volume/mute from the app bar → the native engine
  useEffect(() => {
    if (!isNativeEmbedded || !nativeApiRef.current) return
    VideoPlayerPlugin.setVolume({ volume: localMuted ? 0 : localVolume }).catch(() => {})
  }, [isNativeEmbedded, localVolume, localMuted])

  // Native mode: Brightness / AI Upscale / LUT filter → native engine video
  // adjustments (Exo RgbAdjustment / VLC adjust filter). Web keeps its CSS path.
  useEffect(() => {
    if (!isNativeEmbedded) return
    // Brightness 0..2 (0%..200%). The plugin routes this to the REAL engine
    // effect for ALL values (Exo live RgbMatrix / VLC adjust JNI) — never
    // overlay blending — so toggling the slider never rebuffers or skips.
    VideoPlayerPlugin.setBrightnessDim({ brightness: brightnessMultiplier }).catch(() => {})
  }, [isNativeEmbedded, brightnessMultiplier])

  // Native mode: AI CC subtitles → attach the VTT to the native engine.
  useEffect(() => {
    if (!isNativeEmbedded) return
    const vtt = subtitlesEnabled ? (subtitleVtt || '') : ''
    VideoPlayerPlugin.setSubtitles({ vttText: vtt }).catch(() => {})
  }, [isNativeEmbedded, subtitlesEnabled, subtitleVtt])

  // Native mode: populate the quality menu from the engine's real track list.
  useEffect(() => {
    if (!isNativeEmbedded || !isHls || !isReady) return
    let active = true
    VideoPlayerPlugin.getVideoTracks()
      .then(({ tracks }) => {
        if (active && Array.isArray(tracks) && tracks.length > 1) setHlsLevels(tracks)
      })
      .catch(() => {})
    return () => { active = false }
  }, [isNativeEmbedded, isHls, isReady, currentUrl])

  const handleVolumeChange = useCallback((e) => {
    e.stopPropagation()
    const val = Number(e.target.value)
    setLocalVolume(val)
    if (val > 0 && localMuted) setLocalMuted(false)
  }, [localMuted])

  const playedPercent = durationSec > 0 ? Math.min(100, Math.max(0, (currentSec / durationSec) * 100)) : 0
  const seekbarValue = durationSec > 0 ? Math.round((currentSec / durationSec) * 1000) : 0

  if (error || isMixedContent) {
    const isHevcError = /HEVC|H\.265|x265/i.test(error || '')
    const isMkvError = /matroska|video\/x-matroska|\.mkv|MKV container/i.test(error || '')
      || (/demuxer|pipeline|format error|no supported/i.test(error || '') && /mkv|remux|matroska/i.test(`${error || ''} ${currentUrl || ''}`))
    return (
      <div className={styles.errorContainer}>
        <AlertTriangle size={32} strokeWidth={1.5} style={{ color: 'var(--ember)' }} />
        <h3>
          {isMixedContent
            ? 'HTTP stream blocked'
            : isHevcError || isMkvError
              ? 'Unsupported in Chrome'
              : 'Playback Error'}
        </h3>
        <p>
          {isMixedContent
            ? 'This video server only provides HTTP. HTTPS deployments cannot load it in the browser. Use an HTTPS stream or another source.'
            : isHevcError
              ? 'This video uses HEVC/H.265 encoding. Your browser may not support HEVC decoding natively. Try a different source with H.264/AVC encoding, or use the app on Android where HEVC hardware decoding is available.'
              : isMkvError
                ? 'We remux MKV to fMP4 for browser playback (like VLC does). If playback fails, the file may use an unsupported codec. Try an MP4 link or another source.'
                : error}
        </p>
        {!isHevcError && (
          <>
            {onReResolve && /downloadwella|fsmc/i.test(proxyTargetUrl(currentUrl) || '') && (
              <button
                type="button"
                className={styles.errorReResolve}
                onClick={async () => {
                  setError(null)
                  try {
                    await onReResolve(currentUrl)
                  } catch (err) {
                    setError(err?.message || 'Could not re-resolve the link')
                  }
                }}
              >
                Re-resolve link
              </button>
            )}
            <button type="button" onClick={() => { setError(null); retryCountRef.current = 0; setCurrentUrl(resolvedUrl) }}>
              Retry
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    <div className={styles.videoOuterContainer}>
      <div
        ref={playerWrapperRef}
        className={styles.playerWrapper}
        onMouseMove={handleMouseMove}
        onClick={handleToggleControls}
        onPointerDown={handlePointerTouch}
        onContextMenu={(e) => e.preventDefault()}
      >
        {isNativeEmbedded ? (
          <NativeEmbeddedPlayer
            url={playbackAccess(media?.streamUrl || currentUrl, media).streamUrl}
            title="Chan Video"
            startSeconds={currentSec || played || 0}
            referer={playbackAccess(media?.streamUrl || currentUrl, media).referer || undefined}
            headers={playbackAccess(media?.streamUrl || currentUrl, media).headers}
            container={media?.container || undefined}
            codec={media?.codec || undefined}
            sourceUrl={media?.sourceUrl || undefined}
            mirrors={media?.mirrors || []}
            isLive={isLive || videoType === 'iptv' || videoType === 'sports'}
            onReady={onReady}
            onPlayerEvent={onPlayerEvent}
            onEnded={onEnded}
            onError={onError}
            onRefresh={onRefresh}
            controlsHeight={controlsHeight}
            onProgress={handleNativeProgress}
            onApi={handleNativeApi}
            onControlsTap={handleNativeTap}
            onFullscreenChange={(v) => { setIsFullscreen(Boolean(v)) }}
            visible={!surfaceHidden}
            clipBottomPx={surfaceClipBottom}
          />
        ) : isHls ? (
          <video
            ref={videoRef}
            className={styles.videoElement}
            style={videoStyle}
            autoPlay={playing}
            muted={localMuted}
            controls={false}
            playsInline
            onPointerDown={handlePointerTouch}
            onClick={handleToggleControls}
            onPlay={() => { setIsReady(true); setIsBuffering(false); emitPlay() }}
            onPause={emitPause}
            onSeeked={() => emitSeek(currentTime())}
            onEnded={onEnded}
            onWaiting={() => { setIsBuffering(true) }}
            onCanPlay={() => { setIsBuffering(false) }}
            onTimeUpdate={(event) => {
              if (!isReady) setIsReady(true)
              const video = event.currentTarget
              const dur = video.duration || 0
              if (dur && dur !== durationSec) setDurationSec(dur)
              setCurrentSec(toAbsoluteSec(video.currentTime || 0))
              const loaded = video.buffered.length && dur ? (video.buffered.end(0) / dur) * 100 : 0
              setLoadedPercent(loaded)
              setBufferingPercent(Math.round(loaded))
              onProgress?.({
                played: dur ? video.currentTime / dur : 0,
                playedSeconds: video.currentTime,
                loaded: loaded / 100,
              })
            }}
            onLoadedMetadata={(event) => {
              const dur = event.currentTarget.duration || 0
              setDurationSec(dur)
              onDuration?.(dur)
            }}
          >
            {subtitleBlobUrl && (
              <track
                kind="subtitles"
                label="AI Scene Descriptions (English)"
                src={subtitleBlobUrl}
                srcLang="en"
                default={subtitlesEnabled}
              />
            )}
          </video>
        ) : (
          <div style={{ width: '100%', height: '100%', ...videoStyle }} onContextMenu={(e) => e.preventDefault()}>
            <ReactPlayer
            key={currentUrl}
            ref={playerRef}
            url={currentUrl}
            playing={isPlayingState}
            volume={localVolume}
            muted={localMuted}
            playbackRate={playbackRate}
            onStart={() => { setIsReady(true); setIsBuffering(false) }}
            onBuffer={() => setIsBuffering(true)}
            onBufferEnd={() => setIsBuffering(false)}
            onProgress={(prog) => {
              if (!isReady) setIsReady(true)
              const abs = toAbsoluteSec(prog.playedSeconds || 0)
              setCurrentSec(abs)
              setLoadedPercent((prog.loaded || 0) * 100)
              setBufferingPercent(Math.round((prog.loaded || 0) * 100))
              onProgress?.(prog ? { ...prog, playedSeconds: abs, played: durationSec > 0 ? abs / durationSec : prog.played } : prog)
            }}
            onDuration={(dur) => {
              const d = Number(dur) || 0
              // Remux-from-t may report remaining duration; keep absolute full length when known
              const absDur = isRemuxProxyUrl(currentUrl)
                ? Math.max(d + (remuxBaseTimeRef.current || 0), d, durationSec || 0)
                : d
              setDurationSec(absDur || d)
              onDuration?.(absDur || d)
            }}
            onPlay={() => { setIsReady(true); emitPlay() }}
            onPause={emitPause}
            onEnded={onEnded}
            onError={handleError}
            onReady={notifyReady}
            width="100%"
            height="100%"
            controls={false}
            config={{
              file: { attributes: { playsInline: true }, forceVideo: true },
              youtube: {
                playerVars: { rel: 0, modestbranding: 1, playsInline: 1, controls: 0 },
                embedOptions: { host: 'https://www.youtube-nocookie.com' },
              },
            }}
          />
        </div>
      )}

      {/* Transparent touch layer to ensure 1st tap toggles controls reliably & blocks long press context menu */}
      {!isNativeEmbedded && (
        <div
          className={styles.touchCatcher}
          onClick={handleToggleControls}
          onPointerDown={handlePointerTouch}
          onContextMenu={(e) => e.preventDefault()}
        />
      )}

      {!isNativeEmbedded && (!isReady || isBuffering) && !error && !isMixedContent && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingSpinner} />
          <div className={styles.loadingText}>
            {!isReady
              ? (bufferingPercent > 0
                  ? `Loading stream... ${Math.min(99, bufferingPercent)}%`
                  : 'Loading stream...')
              : (bufferingPercent > 0
                  ? `Buffering... ${Math.min(99, bufferingPercent)}%`
                  : 'Buffering...')}
          </div>
        </div>
      )}
      {isLivePlayback() && <div className={styles.liveIndicator}><Radio size={10} /> LIVE</div>}

      {/* Universal Hollywood Cinema AI Closed Captions / Subtitle Overlay */}
      {subtitlesEnabled && currentSubtitleCueText && (
        <div className={styles.customSubtitleOverlay}>
          <div className={styles.customSubtitleBox}>
            {currentSubtitleCueText.split('\n').map((line, idx) => (
              <p key={idx}>{line}</p>
            ))}
          </div>
        </div>
      )}

      {/* VLC Double-Tap Seek Gesture Indicator */}
      {vlcGesture && (
        <div className={`${styles.vlcGestureOverlay} ${vlcGesture.side === 'left' ? styles.vlcLeft : styles.vlcRight}`}>
          <div className={styles.vlcRippleCircle}>
            {vlcGesture.side === 'left' ? <RotateCcw size={32} /> : <RotateCw size={32} />}
            <span>{vlcGesture.seconds > 0 ? `+${vlcGesture.seconds}s` : `${vlcGesture.seconds}s`}</span>
          </div>
        </div>
      )}

      {/* In Fullscreen/Landscape mode ONLY, render controls as a bottom overlay */}
      {isFullscreen && (
        <div
          ref={controlsOverlayRef}
          className={`${styles.customControlsOverlay} ${showControls ? styles.controlsVisible : ''}`}
          onClick={handleToggleControls}
          onPointerDown={handlePointerTouch}
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* Title only — exit/fullscreen lives on the bottom bar so there
              is never a second fullscreen-looking icon in the top corner. */}
          <div className={styles.overlayTopBar} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <span className={styles.overlayTitle}>Chan Video</span>
          </div>
          <div className={styles.overlayControlsStack}>
            {showSecondaryControls && (
              <div className={styles.overlaySecondaryBar} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                <div className={styles.leftControls}>
                  <button
                    type="button"
                    className={styles.controlIconBtn}
                    onClick={(e) => { e.stopPropagation(); toggleVolumePopup() }}
                    title="Volume"
                  >
                    {localMuted || localVolume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
                  </button>
                </div>

                <button
                  type="button"
                  className={styles.controlIconBtn}
                  onClick={(e) => jumpSeconds(-10, e)}
                  disabled={!canControl}
                  title="Rewind 10s"
                >
                  <RotateCcw size={16} />
                  <span>-10s</span>
                </button>

                <button
                  type="button"
                  className={styles.controlIconBtn}
                  onClick={(e) => jumpSeconds(10, e)}
                  disabled={!canControl}
                  title="Forward 10s"
                >
                  <RotateCw size={16} />
                  <span>+10s</span>
                </button>

                <button
                  type="button"
                  className={styles.controlIconBtn}
                  onClick={addStagePin}
                  title="Drop timestamp bookmark pin"
                >
                  <Bookmark size={16} />
                  <span>Pin</span>
                </button>

                <button
                  type="button"
                  className={`${styles.controlIconBtn} ${brightnessMultiplier !== 1 ? styles.activeBrightnessBtn : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggleBrightnessPopup() }}
                  title="Brightness (0%..200%)"
                >
                  <Sun size={16} style={{ color: brightnessMultiplier !== 1 ? '#FAB005' : 'inherit' }} />
                  <span>{brightnessMultiplier === 1 ? 'Brightness' : `${Math.round(brightnessMultiplier * 100)}%`}</span>
                </button>
                {brightnessPop && !isNativeEmbedded && (
                  <div className={styles.brightnessOverlay} onClick={() => setBrightnessPop(false)}>
                    <div
                      className={styles.brightnessPopup}
                      onClick={(e) => e.stopPropagation()}
                      role="dialog"
                      aria-label="Brightness"
                    >
                      <div className={styles.brightnessHeader}>
                        <Sun size={15} style={{ color: '#FAB005' }} />
                        <span>Brightness</span>
                      </div>
                      <div className={styles.popupSliderRow}>
                        <Sun size={13} style={{ color: 'var(--room-text-secondary)' }} />
                        <input
                          type="range"
                          min="0"
                          max="200"
                          value={Math.round(brightnessMultiplier * 100)}
                          onChange={handleBrightnessChange}
                          className={styles.volumeSlider}
                          title="Brightness"
                        />
                        <span className={styles.popupSliderVal}>{Math.round(brightnessMultiplier * 100)}%</span>
                      </div>
                      <span className={styles.brightnessHint}>0% – 200%</span>
                    </div>
                  </div>
                )}
                {volumePop && !isNativeEmbedded && (
                  <div className={styles.volumeOverlay} onClick={() => setVolumePop(false)}>
                    <div
                      className={styles.volumePopup}
                      onClick={(e) => e.stopPropagation()}
                      role="dialog"
                      aria-label="Volume"
                    >
                      <div className={styles.brightnessHeader}>
                        <Volume2 size={15} style={{ color: 'var(--room-text-secondary)' }} />
                        <span>Volume</span>
                      </div>
                      <div className={styles.popupSliderRow}>
                        <button
                          type="button"
                          className={styles.controlIconBtn}
                          onClick={toggleMute}
                          title={localMuted ? 'Unmute' : 'Mute'}
                        >
                          {localMuted || localVolume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
                        </button>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={localMuted ? 0 : localVolume}
                          onChange={handleVolumeChange}
                          className={styles.volumeSlider}
                          title="Volume"
                        />
                        <span className={styles.popupSliderVal}>{Math.round((localMuted ? 0 : localVolume) * 100)}%</span>
                      </div>
                      <span className={styles.brightnessHint}>0% – 100%</span>
                    </div>
                  </div>
                )}

                {/* AI Closed Captions / Subtitles Button */}
                <button
                  type="button"
                  className={`${styles.controlIconBtn} ${subtitlesEnabled ? styles.activeBrightnessBtn : ''}`}
                  onClick={handleAiSubtitlesToggle}
                  disabled={subtitlesLoading}
                  title="Generate AI scene descriptions & sound cues for this stream"
                >
                  <FileText size={16} style={{ color: subtitlesEnabled ? '#FF6A2B' : 'inherit' }} />
                  <span>{subtitlesLoading ? 'AI CC...' : subtitlesEnabled ? 'CC: On' : 'CC: Off'}</span>
                </button>

                {isHls && hlsLevels.length > 1 && (
                  <div className={styles.popupContainer}>
                    <button
                      type="button"
                      className={styles.controlIconBtn}
                      onClick={(e) => { e.stopPropagation(); setShowQualityMenu(!showQualityMenu); }}
                      title="Stream Quality"
                    >
                      <Settings size={16} />
                      <span>{currentLevel === -1 ? 'Auto' : `${hlsLevels[currentLevel]?.height || 'HD'}p`}</span>
                    </button>
                    {showQualityMenu && (
                      <div className={styles.popupMenu} onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className={`${styles.popupMenuItem} ${currentLevel === -1 ? styles.popupMenuItemActive : ''}`}
                          onClick={() => {
                            if (hlsRef.current) hlsRef.current.currentLevel = -1
                            setCurrentLevel(-1)
                            setShowQualityMenu(false)
                          }}
                        >
                          Auto (Adaptive)
                        </button>
                        {hlsLevels.map((lvl, index) => (
                          <button
                            key={index}
                            type="button"
                            className={`${styles.popupMenuItem} ${currentLevel === index ? styles.popupMenuItemActive : ''}`}
                            onClick={() => {
                              if (hlsRef.current) hlsRef.current.currentLevel = index
                              setCurrentLevel(index)
                              setShowQualityMenu(false)
                            }}
                          >
                            {lvl.height}p ({Math.round((lvl.bitrate || 0) / 1000)} kbps)
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              <button
                  type="button"
                  className={styles.controlIconBtn}
                  onClick={togglePiP}
                  title="Picture in Picture"
                >
                  <PictureInPicture2 size={16} />
                  <span>PiP</span>
                </button>
              </div>
            )}

            <div className={styles.overlayBottomBar} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={styles.overlayPlayBtn}
                onClick={togglePlayPause}
                disabled={!canControl}
                title={isPlayingState ? 'Pause' : 'Play'}
              >
                {isPlayingState ? <Pause size={22} /> : <Play size={22} style={{ marginLeft: '2px' }} />}
              </button>

              <span className={styles.timeText}>{formatTime(currentSec)}</span>

              <div className={styles.seekbarContainer}>
                <div className={styles.seekbarTrack}>
                  <div className={styles.seekbarLoaded} style={{ width: `${loadedPercent}%` }} />
                  <div className={styles.seekbarProgress} style={{ width: `${playedPercent}%` }} />

                  {stagePins.map((pin) => {
                    const pinPercent = durationSec > 0 ? (pin.timeSec / durationSec) * 100 : 0
                    return (
                      <div
                        key={pin.id}
                        className={styles.stagePinDot}
                        style={{ left: `${pinPercent}%` }}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (canControl) adapter.seekTo(pin.timeSec, 'seconds')
                          toast(`${formatTime(pin.timeSec)} - ${pin.displayName}: "${pin.text}"`, { variant: 'info' })
                        }}
                        title={`Stage pin at ${formatTime(pin.timeSec)} - ${pin.displayName}: ${pin.text}`}
                      />
                    )
                  })}
                </div>
                <input
                  type="range"
                  min="0"
                  max="1000"
                  value={seekbarValue}
                  onChange={handleSeekSlider}
                  disabled={!canControl || isLivePlayback()}
                  className={styles.rangeInput}
                  title={isLivePlayback() ? 'Live stream — seeking disabled' : 'Seek position'}
                />
              </div>

              <span className={styles.timeText}>{formatTime(durationSec)}</span>

              <button
                type="button"
                className={styles.overlayFullscreenBtn}
                onClick={toggleFullscreen}
                title="Exit fullscreen"
              >
                <Maximize size={18} />
              </button>

              <button
                type="button"
                className={styles.overlayFullscreenBtn}
                onClick={rotateOrientation}
                title="Rotate orientation (landscape ⇄ portrait)"
              >
                <RotateCw size={18} />
              </button>

              <button
                type="button"
                className={styles.overlayFullscreenBtn}
                onClick={() => setShowSecondaryControls((s) => !s)}
                title={showSecondaryControls ? 'Hide Secondary Controls' : 'Show Secondary Controls'}
              >
                {showSecondaryControls ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>

    {/* In Normal watch room view (`!isFullscreen`), render Main & Secondary control bars directly underneath the video player */}
    {!isFullscreen && (
      <>
        <div ref={controlsOverlayRef} className={styles.mainControlsBar} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={styles.overlayPlayBtn}
            onClick={togglePlayPause}
            disabled={!canControl}
            title={isPlayingState ? 'Pause' : 'Play'}
          >
            {isPlayingState ? <Pause size={20} /> : <Play size={20} style={{ marginLeft: '2px' }} />}
          </button>

          <span className={styles.timeText}>{formatTime(currentSec)}</span>
          {nativeBuffering && (
            <span className={styles.bufferingTag}>
              <Loader2 size={13} className={styles.spinSmall} />
              Buffering…
            </span>
          )}

          <div className={styles.seekbarContainer}>
            <div className={styles.seekbarTrack}>
              <div className={styles.seekbarLoaded} style={{ width: `${loadedPercent}%` }} />
              <div className={styles.seekbarProgress} style={{ width: `${playedPercent}%` }} />

              {stagePins.map((pin) => {
                const pinPercent = durationSec > 0 ? (pin.timeSec / durationSec) * 100 : 0
                return (
                  <div
                    key={pin.id}
                    className={styles.stagePinDot}
                    style={{ left: `${pinPercent}%` }}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (canControl) adapter.seekTo(pin.timeSec, 'seconds')
                      toast(`${formatTime(pin.timeSec)} - ${pin.displayName}: "${pin.text}"`, { variant: 'info' })
                    }}
                    title={`Stage pin at ${formatTime(pin.timeSec)} - ${pin.displayName}: ${pin.text}`}
                  />
                )
              })}
            </div>
            <input
              type="range"
              min="0"
              max="1000"
              value={seekbarValue}
              onChange={handleSeekSlider}
              disabled={!canControl || isLivePlayback()}
              className={styles.rangeInput}
              title={isLivePlayback() ? 'Live stream — seeking disabled' : 'Seek position'}
            />
          </div>

          <span className={styles.timeText}>{formatTime(durationSec)}</span>

          <button
            type="button"
            className={styles.overlayFullscreenBtn}
            onClick={toggleFullscreen}
            title="Fullscreen & Landscape Rotate"
          >
            <Maximize size={16} />
          </button>

          <button
            type="button"
            className={styles.overlayFullscreenBtn}
            onClick={() => setShowSecondaryControls((s) => !s)}
            title={showSecondaryControls ? 'Hide Secondary Controls' : 'Show Secondary Controls'}
          >
            {showSecondaryControls ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        {showSecondaryControls && (
          <div className={styles.externalVideoControlsBar} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <div className={styles.leftControls}>
              <button
                type="button"
                className={styles.controlIconBtn}
                onClick={(e) => { e.stopPropagation(); toggleVolumePopup() }}
                title="Volume"
              >
                {localMuted || localVolume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
            </div>

            <button
              type="button"
              className={styles.controlIconBtn}
              onClick={(e) => jumpSeconds(-10, e)}
              disabled={!canControl}
              title="Rewind 10s"
            >
              <RotateCcw size={16} />
              <span>-10s</span>
            </button>

            <button
              type="button"
              className={styles.controlIconBtn}
              onClick={(e) => jumpSeconds(10, e)}
              disabled={!canControl}
              title="Forward 10s"
            >
              <RotateCw size={16} />
              <span>+10s</span>
            </button>

            <button
              type="button"
              className={styles.controlIconBtn}
              onClick={addStagePin}
              title="Drop timestamp bookmark pin"
            >
              <Bookmark size={16} />
              <span>Pin</span>
            </button>

            {/* Brightness / AI Upscale / CC / Filters are wired to the native
                engine via setVideoEffects / setSubtitles in native mode. */}
            {/* Brightness Control */}
            <button
              type="button"
              className={`${styles.controlIconBtn} ${brightnessMultiplier !== 1 ? styles.activeBrightnessBtn : ''}`}
              onClick={(e) => { e.stopPropagation(); toggleBrightnessPopup() }}
              title="Brightness (0%..200%)"
            >
              <Sun size={16} style={{ color: brightnessMultiplier !== 1 ? '#FAB005' : 'inherit' }} />
              <span>{brightnessMultiplier === 1 ? 'Brightness' : `${Math.round(brightnessMultiplier * 100)}%`}</span>
            </button>
            {brightnessPop && !isNativeEmbedded && (
              <div className={styles.brightnessOverlay} onClick={() => setBrightnessPop(false)}>
                <div
                  className={styles.brightnessPopup}
                  onClick={(e) => e.stopPropagation()}
                  role="dialog"
                  aria-label="Brightness"
                >
                  <div className={styles.brightnessHeader}>
                    <Sun size={15} style={{ color: '#FAB005' }} />
                    <span>Brightness</span>
                  </div>
                  <div className={styles.popupSliderRow}>
                    <Sun size={13} style={{ color: 'var(--room-text-secondary)' }} />
                    <input
                      type="range"
                      min="0"
                      max="200"
                      value={Math.round(brightnessMultiplier * 100)}
                      onChange={handleBrightnessChange}
                      className={styles.volumeSlider}
                      title="Brightness"
                    />
                    <span className={styles.popupSliderVal}>{Math.round(brightnessMultiplier * 100)}%</span>
                  </div>
                  <span className={styles.brightnessHint}>0% – 200%</span>
                </div>
              </div>
            )}
            {volumePop && !isNativeEmbedded && (
              <div className={styles.volumeOverlay} onClick={() => setVolumePop(false)}>
                <div
                  className={styles.volumePopup}
                  onClick={(e) => e.stopPropagation()}
                  role="dialog"
                  aria-label="Volume"
                >
                  <div className={styles.brightnessHeader}>
                    <Volume2 size={15} style={{ color: 'var(--room-text-secondary)' }} />
                    <span>Volume</span>
                  </div>
                  <div className={styles.popupSliderRow}>
                    <button
                      type="button"
                      className={styles.controlIconBtn}
                      onClick={toggleMute}
                      title={localMuted ? 'Unmute' : 'Mute'}
                    >
                      {localMuted || localVolume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={localMuted ? 0 : localVolume}
                      onChange={handleVolumeChange}
                      className={styles.volumeSlider}
                      title="Volume"
                    />
                    <span className={styles.popupSliderVal}>{Math.round((localMuted ? 0 : localVolume) * 100)}%</span>
                  </div>
                  <span className={styles.brightnessHint}>0% – 100%</span>
                </div>
              </div>
            )}

            {/* AI Closed Captions / Subtitles Button */}
            <button
              type="button"
              className={`${styles.controlIconBtn} ${subtitlesEnabled ? styles.activeBrightnessBtn : ''}`}
              onClick={handleAiSubtitlesToggle}
              disabled={subtitlesLoading}
              title="Generate AI scene descriptions & sound cues for this stream"
            >
              <FileText size={16} style={{ color: subtitlesEnabled ? '#FF6A2B' : 'inherit' }} />
              <span>{subtitlesLoading ? 'AI CC...' : subtitlesEnabled ? 'CC: On' : 'CC: Off'}</span>
            </button>

            {/* HLS Quality Selector Menu */}
            {isHls && hlsLevels.length > 1 && (
              <div className={styles.popupContainer}>
                <button
                  type="button"
                  className={styles.controlIconBtn}
                  onClick={(e) => { e.stopPropagation(); setShowQualityMenu(!showQualityMenu); setQualityMenuUp((e.currentTarget.getBoundingClientRect().top) > 220) }}
                  title="Stream Quality"
                >
                  <Settings size={16} />
                  <span>{currentLevel === -1 ? 'Auto' : `${hlsLevels[currentLevel]?.height || 'HD'}p`}</span>
                </button>
                {showQualityMenu && (
                  <div className={`${styles.popupMenu} ${qualityMenuUp ? styles.popupUp : ''}`} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={`${styles.popupMenuItem} ${currentLevel === -1 ? styles.popupMenuItemActive : ''}`}
                      onClick={() => {
                        if (isNativeEmbedded) {
                          VideoPlayerPlugin.setVideoQuality({ auto: true }).catch(() => {})
                        } else if (hlsRef.current) hlsRef.current.currentLevel = -1
                        setCurrentLevel(-1)
                        setShowQualityMenu(false)
                      }}
                    >
                      Auto (Adaptive)
                    </button>
                    {hlsLevels.map((lvl, index) => (
                      <button
                        key={index}
                        type="button"
                        className={`${styles.popupMenuItem} ${currentLevel === index ? styles.popupMenuItemActive : ''}`}
                        onClick={() => {
                          if (isNativeEmbedded) {
                            VideoPlayerPlugin.setVideoQuality({ auto: false, trackId: hlsLevels[index]?.id, height: hlsLevels[index]?.height || 0 }).catch(() => {})
                          } else if (hlsRef.current) hlsRef.current.currentLevel = index
                          setCurrentLevel(index)
                          setShowQualityMenu(false)
                        }}
                      >
                        {lvl.height}p ({Math.round((lvl.bitrate || 0) / 1000)} kbps)
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              className={styles.controlIconBtn}
              onClick={togglePiP}
              title="Picture in Picture"
            >
              <PictureInPicture2 size={16} />
              <span>PiP</span>
            </button>
          </div>
        )}
      </>
    )}
    </div>
  )
}
