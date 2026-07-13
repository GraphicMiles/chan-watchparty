import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactPlayer from 'react-player'
import Hls from 'hls.js'
import {
  AlertTriangle, Radio, Play, Pause, RotateCcw, RotateCw,
  Volume2, VolumeX, Maximize
} from 'lucide-react'
import { normalizePlaybackUrl } from '../../../shared/lib/youtube.js'
import styles from './VideoPlayer.module.scss'

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

export default function VideoPlayer({
  // Existing room/player contract.
  videoId,
  videoUrl,
  videoType = 'youtube',
  canControl = false,
  onReady,
  onPlayerEvent,

  // Optional controlled-player contract for callers that use it.
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
}) {
  const rawUrl = url || videoUrl || (videoType === 'youtube' ? youtubeUrl(videoId) : '')
  const resolvedUrl = useMemo(() => normalizePlaybackUrl(rawUrl), [rawUrl])
  const isHLS = useMemo(() => /(?:\.m3u8|m3u8)/i.test(resolvedUrl), [resolvedUrl])
  const isMixedContent = useMemo(
    () => typeof window !== 'undefined' && window.location.protocol === 'https:' && /^http:\/\//i.test(resolvedUrl),
    [resolvedUrl]
  )

  const playerWrapperRef = useRef(null)
  const playerRef = useRef(null)
  const hlsRef = useRef(null)
  const videoRef = useRef(null)
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef(null)
  const playingRef = useRef(Boolean(playing))
  const onReadyRef = useRef(onReady)
  const onPlayerEventRef = useRef(onPlayerEvent)

  const [error, setError] = useState(null)
  const [isReady, setIsReady] = useState(false)
  const [isPlayingState, setIsPlayingState] = useState(Boolean(playing))
  const [currentSec, setCurrentSec] = useState(0)
  const [durationSec, setDurationSec] = useState(0)
  const [loadedPercent, setLoadedPercent] = useState(0)
  const [localVolume, setLocalVolume] = useState(controlledVolume)
  const [localMuted, setLocalMuted] = useState(controlledMuted)
  const [showControls, setShowControls] = useState(true)
  const controlsTimeoutRef = useRef(null)

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

  const currentTime = useCallback(() => {
    if (isHLS) return videoRef.current?.currentTime || 0
    return playerRef.current?.getCurrentTime?.() || 0
  }, [isHLS])

  const playerState = useCallback(() => (playingRef.current ? 1 : 2), [])

  const adapter = useMemo(() => ({
    getCurrentTime: () => currentTime(),
    getDuration: () => {
      if (isHLS) return videoRef.current?.duration || durationSec || 0
      return playerRef.current?.getDuration?.() || durationSec || 0
    },
    getPlayerState: () => playerState(),
    playVideo: () => {
      if (isHLS) {
        videoRef.current?.play()
      } else {
        playerRef.current?.getInternalPlayer?.()?.playVideo?.() || playerRef.current?.getInternalPlayer?.()?.play?.()
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
      if (isHLS) {
        if (videoRef.current) {
          const targetSec = type === 'fraction' ? value * dur : value
          videoRef.current.currentTime = targetSec
          setCurrentSec(targetSec)
        }
        return
      }
      const seekType = type === true ? 'seconds' : type
      playerRef.current?.seekTo?.(value, seekType === 'fraction' ? 'fraction' : 'seconds')
      if (seekType === 'fraction' && dur) {
        setCurrentSec(value * dur)
      } else if (seekType !== 'fraction') {
        setCurrentSec(value)
      }
    },
    loadVideoById: () => {},
  }), [currentTime, durationSec, isHLS, playerState])

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

  const handleError = useCallback((err) => {
    const nextError = err instanceof Error ? err : new Error(String(err || 'Video playback failed'))
    console.error('Video error:', nextError)
    setError(nextError.message)

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
      onError?.(nextError)
    }
  }, [isHLS, onError, played])

  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }
  }, [])

  useEffect(() => {
    setError(null)
    setIsReady(false)
    retryCountRef.current = 0
    clearTimeout(retryTimeoutRef.current)
    destroyHls()

    if (!isHLS || !resolvedUrl || !videoRef.current) return undefined

    const video = videoRef.current
    const onLoadedMetadata = () => {
      const dur = video.duration || 0
      setDurationSec(dur)
      onDuration?.(dur)
      notifyReady()
    }
    const onNativeError = () => {
      handleError(video.error?.message || `Video error: ${video.error?.code || 'unknown'}`)
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: isLive,
        backBufferLength: 90,
        maxBufferLength: 30,
        manifestLoadingTimeOut: 10000,
        levelLoadingTimeOut: 10000,
        fragLoadingTimeOut: 20000,
      })
      hlsRef.current = hls
      hls.loadSource(resolvedUrl)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => notifyReady())
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
        else handleError(new Error(`HLS fatal error: ${data.details}`))
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = resolvedUrl
      video.addEventListener('loadedmetadata', onLoadedMetadata)
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
  }, [destroyHls, handleError, isHLS, isLive, notifyReady, onDuration, resolvedUrl])

  useEffect(() => () => {
    clearTimeout(retryTimeoutRef.current)
    destroyHls()
  }, [destroyHls])

  useEffect(() => {
    if (!playerRef.current || isHLS || played == null) return
    const dur = playerRef.current.getDuration?.() || 0
    const cur = playerRef.current.getCurrentTime?.() || 0
    if (dur && Math.abs(cur - played * dur) > 2) {
      playerRef.current.seekTo(played, 'fraction')
    }
  }, [isHLS, played])

  const handleMouseMove = useCallback(() => {
    setShowControls(true)
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
    controlsTimeoutRef.current = setTimeout(() => {
      if (playingRef.current) setShowControls(false)
    }, 3500)
  }, [])

  const togglePlayPause = useCallback((e) => {
    e?.stopPropagation()
    if (!canControl) return
    if (playingRef.current) {
      adapter.pauseVideo()
    } else {
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
    adapter.seekTo(fraction, 'fraction')
    setCurrentSec(targetSec)
    emitSeek(targetSec)
  }, [canControl, adapter, durationSec, emitSeek])

  const toggleFullscreen = useCallback((e) => {
    e.stopPropagation()
    const root = playerWrapperRef.current
    if (!root) return
    if (!document.fullscreenElement) {
      root.requestFullscreen?.() || root.webkitRequestFullscreen?.()
    } else {
      document.exitFullscreen?.() || document.webkitExitFullscreen?.()
    }
  }, [])

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
    return (
      <div className={styles.errorContainer}>
        <AlertTriangle size={32} strokeWidth={1.5} style={{ color: 'var(--ember)' }} />
        <h3>{isMixedContent ? 'HTTP stream blocked' : 'Playback Error'}</h3>
        <p>
          {isMixedContent
            ? 'This video server only provides HTTP. HTTPS deployments cannot load it in the browser. Use an HTTPS stream or another source.'
            : error}
        </p>
        <button type="button" onClick={() => { setError(null); retryCountRef.current = 0; window.location.reload() }}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <div
      ref={playerWrapperRef}
      className={styles.playerWrapper}
      onMouseMove={handleMouseMove}
      onTouchStart={handleMouseMove}
    >
      {isHLS ? (
        <video
          ref={videoRef}
          className={styles.videoElement}
          autoPlay={playing}
          muted={localMuted}
          controls={false}
          playsInline
          onPlay={emitPlay}
          onPause={emitPause}
          onSeeked={() => emitSeek(currentTime())}
          onEnded={onEnded}
          onTimeUpdate={(event) => {
            const video = event.currentTarget
            const dur = video.duration || 0
            if (dur && dur !== durationSec) setDurationSec(dur)
            setCurrentSec(video.currentTime || 0)
            const loaded = video.buffered.length && dur ? (video.buffered.end(0) / dur) * 100 : 0
            setLoadedPercent(loaded)
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
        />
      ) : (
        <ReactPlayer
          ref={playerRef}
          url={resolvedUrl}
          playing={isPlayingState}
          volume={localVolume}
          muted={localMuted}
          playbackRate={playbackRate}
          onProgress={(prog) => {
            setCurrentSec(prog.playedSeconds || 0)
            setLoadedPercent((prog.loaded || 0) * 100)
            onProgress?.(prog)
          }}
          onDuration={(dur) => {
            setDurationSec(dur || 0)
            onDuration?.(dur || 0)
          }}
          onPlay={emitPlay}
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
      )}

      {!isReady && <div className={styles.loadingOverlay}>Loading stream...</div>}
      {isLive && <div className={styles.liveIndicator}><Radio size={10} /> LIVE</div>}

      {/* Advanced Custom Controls Overlay (Watch Only, No Download) */}
      <div className={`${styles.customControlsOverlay} ${showControls || !isPlayingState ? styles.controlsVisible : ''}`}>
        <div className={styles.centerOverlayButtons}>
          <button
            type="button"
            className={styles.centerCircleBtn}
            onClick={(e) => jumpSeconds(-10, e)}
            disabled={!canControl}
            title="Rewind 10 seconds"
          >
            <RotateCcw size={22} />
          </button>

          <button
            type="button"
            className={styles.centerMainPlayBtn}
            onClick={togglePlayPause}
            disabled={!canControl}
            title={isPlayingState ? 'Pause' : 'Play'}
          >
            {isPlayingState ? <Pause size={34} /> : <Play size={34} style={{ marginLeft: '4px' }} />}
          </button>

          <button
            type="button"
            className={styles.centerCircleBtn}
            onClick={(e) => jumpSeconds(10, e)}
            disabled={!canControl}
            title="Forward 10 seconds"
          >
            <RotateCw size={22} />
          </button>
        </div>

        <div className={styles.customBottomBar}>
          <div className={styles.trackRow}>
            <span className={styles.timeText}>{formatTime(currentSec)}</span>
            
            <div className={styles.seekbarContainer}>
              <div className={styles.seekbarTrack}>
                <div className={styles.seekbarLoaded} style={{ width: `${loadedPercent}%` }} />
                <div className={styles.seekbarProgress} style={{ width: `${playedPercent}%` }} />
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
          </div>

          <div className={styles.bottomButtonsRow}>
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

            <div className={styles.centerControls}>
              <button
                type="button"
                className={styles.controlIconBtn}
                onClick={(e) => jumpSeconds(-10, e)}
                disabled={!canControl}
                title="Rewind 10s"
              >
                <RotateCcw size={16} />
              </button>
              <button
                type="button"
                className={styles.controlIconBtn}
                onClick={togglePlayPause}
                disabled={!canControl}
                title={isPlayingState ? 'Pause' : 'Play'}
              >
                {isPlayingState ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button
                type="button"
                className={styles.controlIconBtn}
                onClick={(e) => jumpSeconds(10, e)}
                disabled={!canControl}
                title="Forward 10s"
              >
                <RotateCw size={16} />
              </button>
            </div>

            <div className={styles.rightControls}>
              <button
                type="button"
                className={styles.controlIconBtn}
                onClick={toggleFullscreen}
                title="Fullscreen"
              >
                <Maximize size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
