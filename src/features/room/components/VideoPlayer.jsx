import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactPlayer from 'react-player'
import Hls from 'hls.js'
import {
  AlertTriangle, Radio, Play, Pause, RotateCcw, RotateCw,
  Volume2, VolumeX, Maximize, Palette, PictureInPicture2, Bookmark, Settings, Sun, Eye, EyeOff, Cpu, FileText
} from 'lucide-react'
import { collection, addDoc, query, orderBy, limit, onSnapshot, serverTimestamp } from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'
import { normalizePlaybackUrl, isRemuxProxyUrl, withRemuxSeekTime, getRemuxSeekTime } from '../../../shared/lib/youtube.js'
import { useToast } from '../../../shared/ui/index.js'
import { VideoUpscaler } from './VideoUpscaler.jsx'
import styles from './VideoPlayer.module.scss'

const RETRY_ATTEMPTS = 3
const RETRY_DELAY = 3000

const VIDEO_FILTERS = {
  none: { label: 'Normal / Original', css: 'none', desc: 'Default unaltered stream color' },
  ai_4k_upscale: { label: 'AI 4K Super-Res Upscale', css: 'contrast(1.45) saturate(1.68) brightness(1.06) drop-shadow(0 0 2px rgba(255,255,255,0.35)) hue-rotate(-2deg)', desc: 'Perceptual 4K super-resolution: edge sharpening, micro-contrast & HDR pop for direct streams' },
  ai_120fps_motion: { label: 'AI 120fps Motion Flow & Pop', css: 'contrast(1.5) saturate(1.82) brightness(1.09) drop-shadow(0 0 2.5px rgba(255,255,255,0.42)) sepia(0.05) hue-rotate(2deg)', desc: 'Perceptual 120fps motion clarity: crushed shadows, glowing highlights & ultra-vivid action' },
  capcut_pro_4k: { label: 'CapCut Pro 4K HDR Pop', css: 'contrast(1.32) saturate(1.55) brightness(1.04) hue-rotate(-3deg) drop-shadow(0 0 1px rgba(255,255,255,0.18))', desc: 'Ultra-crisp 4K definition, punchy contrast & deep saturated colors' },
  tiktok_120fps_sports: { label: 'TikTok 4K Sports Edit', css: 'contrast(1.38) saturate(1.68) brightness(1.06) sepia(0.08) hue-rotate(4deg)', desc: 'Crushed stadium shadows, glowing floodlights & hyper-vivid jersey colors' },
  akira_anime_hdr: { label: 'Akira / Anime 120fps HDR', css: 'contrast(1.25) saturate(1.75) brightness(1.08) hue-rotate(-6deg)', desc: 'Vibrant sky blues, lush sunlit greens & crystal-clear 2D line contrast' },
  brazil_samba_glow: { label: 'Brazil Samba Gold & Teal', css: 'contrast(1.3) saturate(1.62) brightness(1.03) sepia(0.18) hue-rotate(-14deg)', desc: 'Rich golden yellows and deep royal stadium blues for football edits' },
  bellingham_madrid_noir: { label: 'Madrid Royal Blue Pop', css: 'contrast(1.34) saturate(1.48) brightness(0.96) hue-rotate(8deg)', desc: 'Deep royal indigo shadows with crisp golden highlight punch' },
  capcut_vibrant: { label: 'CapCut Vibrant', css: 'saturate(1.45) contrast(1.15) brightness(1.04) hue-rotate(-2deg)', desc: 'TikTok/CapCut punchy pop & high saturation' },
  capcut_dark_mood: { label: 'CapCut Dark Mood', css: 'contrast(1.3) saturate(1.25) brightness(0.88) hue-rotate(5deg)', desc: 'Deep crushed shadows & glowing highlights' },
  hollywood_teal_orange: { label: 'Hollywood Teal & Orange', css: 'contrast(1.22) saturate(1.35) brightness(0.95) hue-rotate(-12deg) sepia(0.12)', desc: 'Blockbuster cinema contrast and warm skin tones' },
  imax_hdr: { label: 'IMAX Cinema HDR', css: 'contrast(1.28) saturate(1.18) brightness(1.02) drop-shadow(0 0 1px rgba(255,255,255,0.1))', desc: 'High dynamic range clarity with crisp definition' },
  tiktok_golden: { label: 'TikTok Golden Hour', css: 'saturate(1.3) brightness(1.06) contrast(1.1) sepia(0.22) hue-rotate(-8deg)', desc: 'Sun-drenched warm glow for aesthetic edits' },
  cyberpunk_neon: { label: 'Cyberpunk Neon Glow', css: 'saturate(1.65) contrast(1.25) brightness(0.98) hue-rotate(35deg)', desc: 'Futuristic electric pinks, purples & cyan' },
  anime_vivid: { label: 'Anime Vivid Pop', css: 'saturate(1.55) contrast(1.12) brightness(1.08) hue-rotate(-5deg)', desc: 'Super bright candy-colored pop perfect for 2D' },
  vintage_kodak: { label: 'Vintage Kodak 35mm', css: 'sepia(0.38) contrast(1.14) saturate(0.88) brightness(0.94) hue-rotate(10deg)', desc: 'Retro analog film look with nostalgic warmth' },
  clean_boost: { label: 'Clean Clarity Boost', css: 'brightness(1.15) contrast(1.12) saturate(1.12)', desc: 'Lifts dull scenes while keeping colors crisp' },
  night_owl: { label: 'Night Owl Low Light', css: 'brightness(1.35) contrast(1.18) saturate(1.1)', desc: 'Lifts deep shadows so dark movie scenes are crystal clear' },
  moody_noir: { label: 'Moody Noir Film', css: 'grayscale(0.85) contrast(1.4) brightness(0.92)', desc: 'High-contrast monochrome with deep dramatic feel' },
}

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
}) {
  const { user } = useAuth()
  const { toast } = useToast()
  const rawUrl = url || videoUrl || (videoType === 'youtube' ? youtubeUrl(videoId) : '')
  const resolvedUrl = useMemo(() => normalizePlaybackUrl(rawUrl), [rawUrl])
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

  const isHLS = useMemo(() => /(?:\.m3u8|m3u8)/i.test(currentUrl), [currentUrl])
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
  const [showControls, setShowControls] = useState(true)
  const [showSecondaryControls, setShowSecondaryControls] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [videoFilter, setVideoFilter] = useState('none')
  const [brightnessMultiplier, setBrightnessMultiplier] = useState(1.0)
  const [showFilterMenu, setShowFilterMenu] = useState(false)
  const [hlsLevels, setHlsLevels] = useState([])
  const [currentLevel, setCurrentLevel] = useState(-1)
  const [showQualityMenu, setShowQualityMenu] = useState(false)
  const [stagePins, setStagePins] = useState([])
  const [vlcGesture, setVlcGesture] = useState(null)
  const [aiUpscaleMode, setAiUpscaleMode] = useState('off') // 'off' | '4k' | '120fps'
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(false)
  const [subtitlesLoading, setSubtitlesLoading] = useState(false)
  const [targetVideoElement, setTargetVideoElement] = useState(null)
  
  const controlsTimeoutRef = useRef(null)
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

  const isDirectStream = videoType !== 'youtube' && !/^(https?:\/\/)?(www\.)?(youtube|youtu\.be)/i.test(currentUrl)
  const upscaleActive = aiUpscaleMode !== 'off'
  const activeFilterCss = useMemo(() => {
    let baseCss = VIDEO_FILTERS[videoFilter]?.css || 'none'
    if (aiUpscaleMode === '4k') {
      baseCss = baseCss === 'none' ? VIDEO_FILTERS.ai_4k_upscale.css : `${baseCss} ${VIDEO_FILTERS.ai_4k_upscale.css}`
    } else if (aiUpscaleMode === '120fps') {
      baseCss = baseCss === 'none' ? VIDEO_FILTERS.ai_120fps_motion.css : `${baseCss} ${VIDEO_FILTERS.ai_120fps_motion.css}`
    }
    if (brightnessMultiplier === 1) return baseCss
    if (baseCss === 'none' || !baseCss) return `brightness(${brightnessMultiplier})`
    if (/brightness\([\d.]+\)/i.test(baseCss)) {
      return baseCss.replace(/brightness\([\d.]+\)/i, `brightness(${brightnessMultiplier})`)
    }
    return `${baseCss} brightness(${brightnessMultiplier})`
  }, [videoFilter, brightnessMultiplier, aiUpscaleMode])

  const videoStyle = useMemo(() => ({
    filter: activeFilterCss,
    imageRendering: upscaleActive && isDirectStream ? 'high-quality' : 'auto',
    transform: upscaleActive && isDirectStream ? 'scale(1.02)' : 'none',
    transition: 'filter 0.25s ease, transform 0.25s ease',
  }), [activeFilterCss, upscaleActive, isDirectStream])

  const handleAiUpscaleCycle = useCallback((e) => {
    e?.stopPropagation()
    setAiUpscaleMode((prev) => {
      if (prev === 'off') return '4k'
      if (prev === '4k') return '120fps'
      return 'off'
    })
    toast(
      aiUpscaleMode === 'off'
        ? 'AI 4K Super-Resolution Upscale Enabled'
        : aiUpscaleMode === '4k'
        ? 'AI 120fps Motion Flow & Cinema Pop Enabled'
        : 'AI Upscale & Motion Enhancements Disabled',
      { variant: 'info' }
    )
  }, [aiUpscaleMode, toast])

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
      const res = await fetch('/api/room', {
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
  }, [subtitleBlobUrl, subtitlesEnabled, user, roomId, toast])

  const handleBrightnessCycle = useCallback((e) => {
    e.stopPropagation()
    setBrightnessMultiplier((prev) => {
      if (prev === 1.0) return 1.5
      if (prev === 1.5) return 2.0
      return 1.0
    })
  }, [])

  useEffect(() => {
    onReadyRef.current = onReady
    onPlayerEventRef.current = onPlayerEvent
  }, [onReady, onPlayerEvent])

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
    if (isHLS) return videoRef.current?.currentTime || 0
    const local = playerRef.current?.getCurrentTime?.() || 0
    // Remux-from-t streams restart at 0; expose room-absolute time for sync
    if (isRemuxProxyUrl(currentUrl)) {
      return (remuxBaseTimeRef.current || 0) + local
    }
    return local
  }, [isHLS, currentUrl])

  // Keep scrubber/labels on absolute timeline for remux seeks
  const toAbsoluteSec = useCallback((localSec) => {
    if (isRemuxProxyUrl(currentUrl)) {
      return (remuxBaseTimeRef.current || 0) + (Number(localSec) || 0)
    }
    return Number(localSec) || 0
  }, [currentUrl])

  const playerState = useCallback(() => (playingRef.current ? 1 : 2), [])

  const adapter = useMemo(() => ({
    getCurrentTime: () => currentTime(),
    getDuration: () => {
      if (isHLS) return videoRef.current?.duration || durationSec || 0
      // Remux-from-t: player reports remaining length; prefer absolute durationSec
      if (isRemuxProxyUrl(currentUrl) && durationSec > 0) return durationSec
      const local = playerRef.current?.getDuration?.() || 0
      if (isRemuxProxyUrl(currentUrl) && remuxBaseTimeRef.current > 0) {
        return Math.max(durationSec || 0, remuxBaseTimeRef.current + local)
      }
      return local || durationSec || 0
    },
    getPlayerState: () => playerState(),
    playVideo: () => {
      // Show progress immediately while media catches up
      setIsBuffering(true)
      if (isHLS) {
        const p = videoRef.current?.play?.()
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } else {
        try {
          playerRef.current?.getInternalPlayer?.()?.playVideo?.() || playerRef.current?.getInternalPlayer?.()?.play?.()
        } catch { /* */ }
      }
      playingRef.current = true
      setIsPlayingState(true)
    },
    pauseVideo: () => {
      if (isHLS) {
        videoRef.current?.pause()
      } else {
        playerRef.current?.getInternalPlayer?.()?.pauseVideo?.() || playerRef.current?.getInternalPlayer?.()?.pause?.()
      }
      playingRef.current = false
      setIsPlayingState(false)
    },
    seekTo: (value, type = 'seconds') => {
      const dur = (isHLS ? videoRef.current?.duration : playerRef.current?.getDuration?.()) || durationSec || 0
      const seekType = type === true ? 'seconds' : type
      const targetSec = seekType === 'fraction' ? (value * (dur || 0)) : value

      // MKV remux: real seek = new remux-from-t URL (synced via playerState.currentTime)
      // The remuxed fMP4 always starts at media time 0; we track absolute time via remuxBaseTimeRef.
      if (!isHLS && isRemuxProxyUrl(currentUrl) && !isLive && videoType !== 'iptv') {
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

      if (isHLS) {
        if (videoRef.current) {
          const isLiveOrIptvStream = isLive || !isFinite(videoRef.current.duration) || videoRef.current.duration > 86400 || videoType === 'iptv' || /(?:\.m3u8|m3u8)/i.test(currentUrl)
          if (isLiveOrIptvStream) {
            return
          }
          videoRef.current.currentTime = targetSec
          setCurrentSec(targetSec)
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
    isLive: () => isLive || isHLS || !isFinite(durationSec) || durationSec > 86400 || videoType === 'iptv' || /(?:\.m3u8|m3u8)/i.test(currentUrl),
    loadVideoById: () => {},
  }), [currentTime, durationSec, isHLS, isLive, playerState, currentUrl, videoType])

  const notifyReady = useCallback(() => {
    setIsReady(true)
    onReadyRef.current?.(adapter)
  }, [adapter])

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

  // MediaError code → human-readable message
  const MEDIA_ERROR_MESSAGES = {
    1: 'Playback was aborted. Try again.',
    2: 'Network error — the stream server may be down, slow, or the proxy timed out. Try again or use a different source.',
    3: 'Decoding error — this stream format is not supported or the file is corrupt. Try a different source.',
    4: 'Source not supported — the video URL may not return a playable video, the server may have returned an error page, or the stream timed out. Try a different source.',
  }

  // Detect demuxer/pipeline errors from error message
  const isDemuxerError = (msg) => /demuxer|pipeline|format error/i.test(msg || '')

  const handleError = useCallback((err) => {
    // ReactPlayer/FilePlayer passes MediaError objects or Events, NOT Error instances.
    // String(MediaError) = "[object Object]" — that's the "object entry" bug.
    let message = ''

    if (err instanceof Error) {
      message = err.message
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
        // Last resort — try to extract anything useful
        try {
          message = JSON.stringify(err).slice(0, 200)
        } catch {
          message = 'Video playback failed — unknown error'
        }
      }
    } else if (typeof err === 'string') {
      message = err
    } else {
      message = 'Video playback failed'
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
      onError?.(new Error(message))
      return
    }

    if (retryCountRef.current < RETRY_ATTEMPTS) {
      retryCountRef.current += 1
      retryTimeoutRef.current = setTimeout(() => {
        if (isHLS && hlsRef.current) {
          hlsRef.current.startLoad()
        } else {
          playerRef.current?.seekTo?.(played || 0, 'fraction')
        }
      }, RETRY_DELAY)
    } else {
      onError?.(new Error(message))
    }
  }, [currentUrl, isHLS, onError, played, toast, videoType])

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
    const isRemux = /[?&]remux=1(?:&|$)/i.test(currentUrl || '')
    if (!isHLS && currentUrl && videoType === 'direct' && currentUrl.includes('/api/proxy') && !isRemux) {
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

    if (!isHLS || !currentUrl || !videoRef.current) {
      return () => {}
    }

    const video = videoRef.current
    const onLoadedMetadata = () => {
      const dur = video.duration || 0
      setDurationSec(dur)
      onDuration?.(dur)
      notifyReady()
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
    } else if (Hls.isSupported()) {
      const isLiveHls = isLive || currentUrl.includes('/api/proxy') && /(?:\.m3u8|m3u8)/i.test(currentUrl)
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: isLiveHls,
        backBufferLength: isLiveHls ? 30 : 60,
        maxBufferLength: isLiveHls ? 30 : 60,
        maxMaxBufferLength: isLiveHls ? 120 : 600,
        liveSyncDurationCount: isLiveHls ? 3 : undefined,
        liveMaxLatencyDurationCount: isLiveHls ? 8 : undefined,
        manifestLoadingTimeOut: 15000,
        levelLoadingTimeOut: 15000,
        fragLoadingTimeOut: 20000,
      })
      hlsRef.current = hls
      hls.loadSource(currentUrl)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setHlsLevels(hls.levels || [])
        notifyReady()
      })
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        setCurrentLevel(data.level)
      })
      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.log('HLS error:', data.type, data.details, 'fatal:', data.fatal)
        if (!data.fatal) {
          // Non-fatal: retry network errors, recover media errors
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            console.log('HLS network error, retrying load...')
            // Show temporary warning after 3 retries
            hlsErrorCountRef.current = (hlsErrorCountRef.current || 0) + 1
            if (hlsErrorCountRef.current === 3) {
              toast('Stream is having trouble loading — the IPTV server may be slow or blocking requests', { variant: 'warning', duration: 5000 })
            }
            hls.startLoad()
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            console.log('HLS media error, recovering...')
            hls.recoverMediaError()
          }
          return
        }
        // Fatal errors: show meaningful message to user
        const errorMsg = data.type === Hls.ErrorTypes.NETWORK_ERROR
          ? 'Stream network error — the IPTV server may be blocking this request, the channel is offline, or the stream timed out. Try another channel.'
          : data.type === Hls.ErrorTypes.MEDIA_ERROR
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
      if (!Hls.isSupported()) video.removeAttribute('src')
    }
  }, [destroyHls, handleError, isHLS, isLive, notifyReady, onDuration, currentUrl])

  useEffect(() => () => {
    clearTimeout(retryTimeoutRef.current)
    destroyHls()
  }, [destroyHls])

  useEffect(() => {
    if (!playerRef.current || isHLS || played == null) return
    // Never force native fraction seeks on remux streams — timeline is absolute via ?t=
    if (isRemuxProxyUrl(currentUrl)) return
    const dur = playerRef.current.getDuration?.() || 0
    const cur = playerRef.current.getCurrentTime?.() || 0
    if (dur && Math.abs(cur - played * dur) > 2) {
      playerRef.current.seekTo(played, 'fraction')
    }
  }, [isHLS, played, currentUrl])

  // Track the active native <video> element for the WebGL upscaler overlay.
  useEffect(() => {
    let el = null
    if (isHLS) {
      el = videoRef.current
    } else if (playerRef.current?.getInternalPlayer) {
      const internal = playerRef.current.getInternalPlayer()
      if (internal instanceof HTMLVideoElement) el = internal
    }
    setTargetVideoElement(el)
  }, [isHLS, currentUrl, isReady])

  const handleMouseMove = useCallback(() => {
    setShowControls(true)
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
    controlsTimeoutRef.current = setTimeout(() => {
      if (playingRef.current) {
        setShowControls(false)
        setShowFilterMenu(false)
        setShowQualityMenu(false)
      }
    }, 3500)
  }, [])

  const triggerToggleControls = useCallback(() => {
    lastToggleTimeRef.current = Date.now()
    setShowControls((prev) => {
      const next = !prev
      if (!next) {
        setShowFilterMenu(false)
        setShowQualityMenu(false)
      } else {
        if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
        if (playingRef.current) {
          controlsTimeoutRef.current = setTimeout(() => {
            if (playingRef.current) {
              setShowControls(false)
              setShowFilterMenu(false)
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
  }, [])

  const togglePiP = useCallback((e) => {
    e.stopPropagation()
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
  }, [toast])

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
              ? 'This video uses HEVC/H.265 encoding. Chrome cannot decode HEVC in most builds. Pick an MP4/H.264 (x264) quality from Nkiri if available.'
              : isMkvError
                ? 'Chrome does not play MKV (Matroska) natively. We remux small MKVs to fMP4 on the server, but large files exceed Vercel Hobby (10s). Prefer an MP4 link, or use Safari (sometimes) / download + VLC.'
                : error}
        </p>
        {!isHevcError && (
          <button type="button" onClick={() => { setError(null); retryCountRef.current = 0; setCurrentUrl(resolvedUrl) }}>
            Retry
          </button>
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
        {isHLS ? (
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
                onLoad={() => {
                  const tracks = videoRef.current?.textTracks || []
                  for (let i = 0; i < tracks.length; i++) {
                    if (tracks[i].kind === 'subtitles') {
                      tracks[i].mode = subtitlesEnabled ? 'showing' : 'hidden'
                    }
                  }
                }}
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

      {/* Perceptual AI super-resolution overlay for direct streams */}
      <VideoUpscaler
        videoElement={targetVideoElement}
        enabled={upscaleActive && isDirectStream}
        mode={aiUpscaleMode}
      />

      {/* Transparent touch layer to ensure 1st tap toggles controls reliably & blocks long press context menu */}
      <div
        className={styles.touchCatcher}
        onClick={handleToggleControls}
        onPointerDown={handlePointerTouch}
        onContextMenu={(e) => e.preventDefault()}
      />

      {(!isReady || isBuffering) && !error && !isMixedContent && (
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
      {isLive && <div className={styles.liveIndicator}><Radio size={10} /> LIVE</div>}

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
          className={`${styles.customControlsOverlay} ${showControls ? styles.controlsVisible : ''}`}
          onClick={handleToggleControls}
          onPointerDown={handlePointerTouch}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className={styles.overlayControlsStack}>
            {showSecondaryControls && (
              <div className={styles.overlaySecondaryBar} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                <div className={styles.leftControls}>
                  <button
                    type="button"
                    className={styles.controlIconBtn}
                    onClick={toggleMute}
                    title={localMuted ? 'Unmute' : 'Mute'}
                  >
                    {localMuted || localVolume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
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
                  className={`${styles.controlIconBtn} ${brightnessMultiplier > 1 ? styles.activeBrightnessBtn : ''}`}
                  onClick={handleBrightnessCycle}
                  title="Brightness (Tap: 1x -> 1.5x -> 2x -> 1x)"
                >
                  <Sun size={16} style={{ color: brightnessMultiplier > 1 ? '#FAB005' : 'inherit' }} />
                  <span>{brightnessMultiplier === 1 ? 'Brightness' : `${brightnessMultiplier}x`}</span>
                </button>

                {/* AI Super-Resolution / 120fps Upscale Button */}
                <button
                  type="button"
                  className={`${styles.controlIconBtn} ${aiUpscaleMode !== 'off' ? styles.activeBrightnessBtn : ''}`}
                  onClick={handleAiUpscaleCycle}
                  title="Hardware GPU Super-Resolution & 120fps Motion Flow (Tap: Off -> 4K -> 120fps)"
                >
                  <Cpu size={16} style={{ color: aiUpscaleMode !== 'off' ? '#00E699' : 'inherit' }} />
                  <span>{aiUpscaleMode === 'off' ? 'AI Upscale' : aiUpscaleMode.toUpperCase()}</span>
                </button>

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

                <div className={styles.popupContainer}>
                  <button
                    type="button"
                    className={styles.controlIconBtn}
                    onClick={(e) => { e.stopPropagation(); setShowFilterMenu(!showFilterMenu); setShowQualityMenu(false) }}
                    title="Video LUT Filters"
                  >
                    <Palette size={16} />
                    <span>{VIDEO_FILTERS[videoFilter]?.label || 'Filter'}</span>
                  </button>
                  {showFilterMenu && (
                    <div className={styles.popupMenu} onClick={(e) => e.stopPropagation()}>
                      {Object.entries(VIDEO_FILTERS).map(([key, item]) => (
                        <button
                          key={key}
                          type="button"
                          className={`${styles.popupMenuItem} ${videoFilter === key ? styles.popupMenuItemActive : ''}`}
                          onClick={() => { setVideoFilter(key); setShowFilterMenu(false) }}
                        >
                          <span>{item.label}</span>
                          <span className={styles.popupMenuSub}>{item.desc}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {isHLS && hlsLevels.length > 1 && (
                  <div className={styles.popupContainer}>
                    <button
                      type="button"
                      className={styles.controlIconBtn}
                      onClick={(e) => { e.stopPropagation(); setShowQualityMenu(!showQualityMenu); setShowFilterMenu(false) }}
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
                  disabled={!canControl || isLive}
                  className={styles.rangeInput}
                  title="Seek position"
                />
              </div>

              <span className={styles.timeText}>{formatTime(durationSec)}</span>

              <button
                type="button"
                className={styles.overlayFullscreenBtn}
                onClick={toggleFullscreen}
                title="Fullscreen & Landscape Rotate"
              >
                <Maximize size={18} />
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
        <div className={styles.mainControlsBar} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
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
              disabled={!canControl || isLive}
              className={styles.rangeInput}
              title="Seek position"
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
                onClick={toggleMute}
                title={localMuted ? 'Unmute' : 'Mute'}
              >
                {localMuted || localVolume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
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

            {/* Brightness Control */}
            <button
              type="button"
              className={`${styles.controlIconBtn} ${brightnessMultiplier > 1 ? styles.activeBrightnessBtn : ''}`}
              onClick={handleBrightnessCycle}
              title="Brightness (Tap: 1x -> 1.5x -> 2x -> 1x)"
            >
              <Sun size={16} style={{ color: brightnessMultiplier > 1 ? '#FAB005' : 'inherit' }} />
              <span>{brightnessMultiplier === 1 ? 'Brightness' : `${brightnessMultiplier}x`}</span>
            </button>

            {/* AI Super-Resolution / 120fps Upscale Button */}
            <button
              type="button"
              className={`${styles.controlIconBtn} ${aiUpscaleMode !== 'off' ? styles.activeBrightnessBtn : ''}`}
              onClick={handleAiUpscaleCycle}
              title="Hardware GPU Super-Resolution & 120fps Motion Flow (Tap: Off -> 4K -> 120fps)"
            >
              <Cpu size={16} style={{ color: aiUpscaleMode !== 'off' ? '#00E699' : 'inherit' }} />
              <span>{aiUpscaleMode === 'off' ? 'AI Upscale' : aiUpscaleMode.toUpperCase()}</span>
            </button>

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

            {/* Cinema LUT Filters Menu */}
            <div className={styles.popupContainer}>
              <button
                type="button"
                className={styles.controlIconBtn}
                onClick={(e) => { e.stopPropagation(); setShowFilterMenu(!showFilterMenu); setShowQualityMenu(false) }}
                title="Video LUT Filters"
              >
                <Palette size={16} />
                <span>{VIDEO_FILTERS[videoFilter]?.label || 'Filter'}</span>
              </button>
              {showFilterMenu && (
                <div className={styles.popupMenu} onClick={(e) => e.stopPropagation()}>
                  {Object.entries(VIDEO_FILTERS).map(([key, item]) => (
                    <button
                      key={key}
                      type="button"
                      className={`${styles.popupMenuItem} ${videoFilter === key ? styles.popupMenuItemActive : ''}`}
                      onClick={() => { setVideoFilter(key); setShowFilterMenu(false) }}
                    >
                      <span>{item.label}</span>
                      <span className={styles.popupMenuSub}>{item.desc}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* HLS Quality Selector Menu */}
            {isHLS && hlsLevels.length > 1 && (
              <div className={styles.popupContainer}>
                <button
                  type="button"
                  className={styles.controlIconBtn}
                  onClick={(e) => { e.stopPropagation(); setShowQualityMenu(!showQualityMenu); setShowFilterMenu(false) }}
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
      </>
    )}
    </div>
  )
}
