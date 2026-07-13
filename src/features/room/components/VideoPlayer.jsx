import React, { useEffect, useRef, useState, useCallback } from 'react'
import ReactPlayer from 'react-player'
import Hls from 'hls.js'
import styles from './VideoPlayer.module.scss'

const RETRY_ATTEMPTS = 3
const RETRY_DELAY = 3000

export default function VideoPlayer({
  url,
  playing,
  played,
  volume,
  muted,
  playbackRate,
  onProgress,
  onDuration,
  onPlay,
  onPause,
  onEnded,
  onError,
  onReady,
  isLive = false,
}) {
  const playerRef = useRef(null)
  const hlsRef = useRef(null)
  const videoRef = useRef(null)
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef(null)
  
  const [isHLS, setIsHLS] = useState(false)
  const [isDirect, setIsDirect] = useState(false)
  const [error, setError] = useState(null)
  const [isReady, setIsReady] = useState(false)

  // Detect video type
  useEffect(() => {
    if (!url) return
    
    const isM3U8 = url.includes('.m3u8') || url.includes('m3u8')
    const isMP4 = url.match(/\.(mp4|mkv|avi|mov|webm|ogg|flv)(\?|#|$)/i)
    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be')
    
    setIsHLS(isM3U8)
    setIsDirect(isM3U8 || isMP4)
    setError(null)
    setIsReady(false)
    retryCountRef.current = 0
    
    return () => {
      clearTimeout(retryTimeoutRef.current)
    }
  }, [url])

  // Cleanup HLS on unmount or URL change
  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [url])

  // HLS.js setup
  useEffect(() => {
    if (!isHLS || !videoRef.current || !url) return
    
    setIsReady(false)
    
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: isLive,
        backBufferLength: 90,
        maxBufferLength: 30,
        maxMaxBufferLength: 600,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 10000,
        levelLoadingMaxRetry: 2,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 3,
      })
      
      hls.loadSource(url)
      hls.attachMedia(videoRef.current)
      
      hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        console.log('HLS manifest parsed, levels:', data.levels.length)
        setIsReady(true)
        onReady?.()
      })
      
      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLS error:', data)
        
        if (data.fatal) {
          switch(data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('Fatal network error, trying to recover...')
              hls.startLoad()
              break
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('Fatal media error, trying to recover...')
              hls.recoverMediaError()
              break
            default:
              destroyHls()
              handleError(new Error(`HLS fatal error: ${data.details}`))
              break
          }
        }
      })
      
      hlsRef.current = hls
      
      return () => {
        destroyHls()
      }
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      videoRef.current.src = url
      videoRef.current.addEventListener('loadedmetadata', () => {
        setIsReady(true)
        onReady?.()
      })
    } else {
      handleError(new Error('HLS not supported in this browser'))
    }
  }, [isHLS, url, isLive, onReady])

  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }
  }, [])

  const handleError = useCallback((err) => {
    console.error('Video error:', err)
    setError(err.message)
    
    if (retryCountRef.current < RETRY_ATTEMPTS) {
      retryCountRef.current++
      console.log(`Retrying... Attempt ${retryCountRef.current}/${RETRY_ATTEMPTS}`)
      
      retryTimeoutRef.current = setTimeout(() => {
        // Force reload
        if (isHLS && hlsRef.current) {
          hlsRef.current.startLoad()
        } else if (playerRef.current) {
          playerRef.current.seekTo(played || 0, 'fraction')
        }
      }, RETRY_DELAY)
    } else {
      onError?.(err)
    }
  }, [isHLS, played, onError])

  const handleVideoError = useCallback((e) => {
    const video = e.target
    const errorMsg = video.error?.message || `Video error: ${video.error?.code}`
    handleError(new Error(errorMsg))
  }, [handleError])

  // Sync playback state for ReactPlayer
  useEffect(() => {
    if (!playerRef.current || isHLS) return
    
    // Only seek if difference is significant (> 2 seconds)
    const currentTime = playerRef.current.getCurrentTime()
    const duration = playerRef.current.getDuration()
    if (duration && Math.abs(currentTime - played * duration) > 2) {
      playerRef.current.seekTo(played, 'fraction')
    }
  }, [played, isHLS])

  // Error display
  if (error) {
    return (
      <div className={styles.errorContainer}>
        <div className={styles.errorIcon}>⚠️</div>
        <h3>Playback Error</h3>
        <p>{error}</p>
        <button onClick={() => { setError(null); retryCountRef.current = 0; window.location.reload(); }}>
          Retry
        </button>
      </div>
    )
  }

  // Loading state
  if (!isReady && isHLS) {
    return (
      <div className={styles.loadingContainer}>
        <div className={styles.spinner}></div>
        <p>Loading stream...</p>
      </div>
    )
  }

  // HLS Player (native video element)
  if (isHLS) {
    return (
      <div className={styles.playerWrapper}>
        <video
          ref={videoRef}
          className={styles.videoElement}
          autoPlay={playing}
          muted={muted}
          controls
          playsInline
          onPlay={onPlay}
          onPause={onPause}
          onEnded={onEnded}
          onError={handleVideoError}
          onTimeUpdate={(e) => {
            const video = e.target
            if (video.duration) {
              onProgress?.({ 
                played: video.currentTime / video.duration,
                playedSeconds: video.currentTime,
                loaded: video.buffered.length > 0 ? video.buffered.end(0) / video.duration : 0
              })
            }
          }}
          onLoadedMetadata={(e) => {
            onDuration?.(e.target.duration)
          }}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
        {isLive && <div className={styles.liveIndicator}>● LIVE</div>}
      </div>
    )
  }

  // Standard ReactPlayer for YouTube and other URLs
  return (
    <div className={styles.playerWrapper}>
      <ReactPlayer
        ref={playerRef}
        url={url}
        playing={playing}
        volume={volume}
        muted={muted}
        playbackRate={playbackRate}
        onProgress={onProgress}
        onDuration={onDuration}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
        onError={handleError}
        onReady={() => { setIsReady(true); onReady?.(); }}
        width="100%"
        height="100%"
        controls
        config={{
          file: {
            attributes: {
              crossOrigin: 'anonymous',
              playsInline: true,
            },
            forceVideo: true,
            forceHLS: false,
          },
          youtube: {
            playerVars: {
              rel: 0,
              modestbranding: 1,
              playsInline: 1,
            },
            embedOptions: {
              host: 'https://www.youtube-nocookie.com',
            },
          },
        }}
      />
      {isLive && <div className={styles.liveIndicator}>● LIVE</div>}
    </div>
  )
          }
