import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactPlayer from 'react-player'
import Hls from 'hls.js'
import styles from './VideoPlayer.module.scss'

const RETRY_ATTEMPTS = 3
const RETRY_DELAY = 3000

function youtubeUrl(videoId) {
  return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : ''
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
  volume = 1,
  muted = false,
  playbackRate = 1,
  onProgress,
  onDuration,
  onPlay,
  onPause,
  onEnded,
  onError,
  isLive = false,
}) {
  const resolvedUrl = url || videoUrl || (videoType === 'youtube' ? youtubeUrl(videoId) : '')
  const isHLS = useMemo(() => /(?:\.m3u8|m3u8)/i.test(resolvedUrl), [resolvedUrl])

  const playerRef = useRef(null)
  const hlsRef = useRef(null)
  const videoRef = useRef(null)
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef(null)
  const playingRef = useRef(false)
  const onReadyRef = useRef(onReady)
  const onPlayerEventRef = useRef(onPlayerEvent)

  const [error, setError] = useState(null)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    onReadyRef.current = onReady
    onPlayerEventRef.current = onPlayerEvent
  }, [onReady, onPlayerEvent])

  const currentTime = useCallback(() => {
    if (isHLS) return videoRef.current?.currentTime || 0
    return playerRef.current?.getCurrentTime?.() || 0
  }, [isHLS])

  const playerState = useCallback(() => (playingRef.current ? 1 : 2), [])

  const adapter = useMemo(() => ({
    getCurrentTime: () => currentTime(),
    getDuration: () => {
      if (isHLS) return videoRef.current?.duration || 0
      return playerRef.current?.getDuration?.() || 0
    },
    getPlayerState: () => playerState(),
    playVideo: () => {
      if (isHLS) return videoRef.current?.play()
      return playerRef.current?.getInternalPlayer?.()?.playVideo?.() || playerRef.current?.getInternalPlayer?.()?.play?.()
    },
    pauseVideo: () => {
      if (isHLS) return videoRef.current?.pause()
      return playerRef.current?.getInternalPlayer?.()?.pauseVideo?.() || playerRef.current?.getInternalPlayer?.()?.pause?.()
    },
    seekTo: (value, type = 'seconds') => {
      if (isHLS) {
        if (videoRef.current) videoRef.current.currentTime = type === 'fraction'
          ? value * (videoRef.current.duration || 0)
          : value
        return
      }
      // The legacy hook passes true as the second argument for seconds.
      const seekType = type === true ? 'seconds' : type
      playerRef.current?.seekTo?.(value, seekType === 'fraction' ? 'fraction' : 'seconds')
    },
    loadVideoById: () => {
      // The room document controls the URL; ReactPlayer reloads when it changes.
    },
  }), [currentTime, isHLS, playerState])

  const notifyReady = useCallback(() => {
    setIsReady(true)
    onReadyRef.current?.(adapter)
  }, [adapter])

  const emitPlay = useCallback(() => {
    playingRef.current = true
    onPlay?.()
    onPlayerEventRef.current?.({ isPlaying: true, currentTime: currentTime() })
  }, [currentTime, onPlay])

  const emitPause = useCallback(() => {
    playingRef.current = false
    onPause?.()
    onPlayerEventRef.current?.({ isPlaying: false, currentTime: currentTime() })
  }, [currentTime, onPause])

  const emitSeek = useCallback(() => {
    onPlayerEventRef.current?.({ isPlaying: playingRef.current, currentTime: currentTime() })
  }, [currentTime])

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
    playingRef.current = false
    clearTimeout(retryTimeoutRef.current)
    destroyHls()

    if (!isHLS || !resolvedUrl || !videoRef.current) return undefined

    const video = videoRef.current
    const onLoadedMetadata = () => {
      onDuration?.(video.duration || 0)
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
    const duration = playerRef.current.getDuration?.() || 0
    const current = playerRef.current.getCurrentTime?.() || 0
    if (duration && Math.abs(current - played * duration) > 2) {
      playerRef.current.seekTo(played, 'fraction')
    }
  }, [isHLS, played])

  if (error) {
    return (
      <div className={styles.errorContainer}>
        <div className={styles.errorIcon}>⚠️</div>
        <h3>Playback Error</h3>
        <p>{error}</p>
        <button type="button" onClick={() => { setError(null); retryCountRef.current = 0; window.location.reload() }}>
          Retry
        </button>
      </div>
    )
  }

  if (isHLS) {
    return (
      <div className={styles.playerWrapper}>
        <video
          ref={videoRef}
          className={styles.videoElement}
          autoPlay={playing}
          muted={muted}
          controls={canControl}
          playsInline
          onPlay={emitPlay}
          onPause={emitPause}
          onSeeked={emitSeek}
          onEnded={onEnded}
          onTimeUpdate={(event) => {
            const video = event.currentTarget
            const duration = video.duration || 0
            onProgress?.({
              played: duration ? video.currentTime / duration : 0,
              playedSeconds: video.currentTime,
              loaded: video.buffered.length ? video.buffered.end(0) / duration : 0,
            })
          }}
          onLoadedMetadata={(event) => onDuration?.(event.currentTarget.duration || 0)}
        />
        {!isReady && <div className={styles.loadingOverlay}>Loading stream…</div>}
        {isLive && <div className={styles.liveIndicator}>● LIVE</div>}
      </div>
    )
  }

  return (
    <div className={styles.playerWrapper}>
      <ReactPlayer
        ref={playerRef}
        url={resolvedUrl}
        playing={playing}
        volume={volume}
        muted={muted}
        playbackRate={playbackRate}
        onProgress={onProgress}
        onDuration={onDuration}
        onPlay={emitPlay}
        onPause={emitPause}
        onEnded={onEnded}
        onError={handleError}
        onReady={notifyReady}
        width="100%"
        height="100%"
        controls={canControl}
        config={{
          file: { attributes: { crossOrigin: 'anonymous', playsInline: true }, forceVideo: true },
          youtube: {
            playerVars: { rel: 0, modestbranding: 1, playsInline: 1 },
            embedOptions: { host: 'https://www.youtube-nocookie.com' },
          },
        }}
      />
      {isLive && <div className={styles.liveIndicator}>● LIVE</div>}
    </div>
  )
}
