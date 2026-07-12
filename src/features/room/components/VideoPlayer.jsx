import { useEffect, useRef, useState } from 'react'
import YouTube from 'react-youtube'

const EMBED_ERROR_CODES = new Set([101, 150, 100, 2, 5])

export default function VideoPlayer({
  videoId,
  videoUrl,
  videoType = 'youtube',
  canControl,
  onReady,
  onPlayerEvent,
}) {
  const playerRef = useRef(null)
  const videoRef = useRef(null)
  const [ytError, setYtError] = useState(null)
  const [directError, setDirectError] = useState(null)

  useEffect(() => {
    setYtError(null)
    setDirectError(null)
  }, [videoId, videoUrl, videoType])

  // Direct / HTML5 video
  useEffect(() => {
    if (videoType !== 'direct' || !videoUrl || !videoRef.current) return

    const video = videoRef.current

    const handlePlay = () => {
      onPlayerEvent?.({ isPlaying: true, currentTime: video.currentTime || 0 })
    }
    const handlePause = () => {
      onPlayerEvent?.({ isPlaying: false, currentTime: video.currentTime || 0 })
    }
    const handleSeeked = () => {
      onPlayerEvent?.({
        isPlaying: !video.paused,
        currentTime: video.currentTime || 0,
      })
    }
    const handleError = () => {
      setDirectError(
        'Could not play this file in the browser (bad URL, format, or the host blocks embedding). Try another direct .mp4 link.'
      )
    }

    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('seeked', handleSeeked)
    video.addEventListener('error', handleError)

    onReady?.({
      playVideo: () => video.play(),
      pauseVideo: () => video.pause(),
      seekTo: (time) => {
        video.currentTime = time
      },
      getCurrentTime: () => video.currentTime || 0,
      getDuration: () => video.duration || 0,
      getPlayerState: () => (video.paused ? 2 : 1),
    })

    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('error', handleError)
    }
  }, [videoType, videoUrl, onPlayerEvent, onReady])

  const handleYouTubeReady = (e) => {
    playerRef.current = e.target
    setYtError(null)
    onReady?.(e.target)
  }

  const handleYouTubePlay = () => {
    onPlayerEvent?.({ isPlaying: true, currentTime: playerRef.current?.getCurrentTime?.() || 0 })
  }

  const handleYouTubePause = () => {
    onPlayerEvent?.({ isPlaying: false, currentTime: playerRef.current?.getCurrentTime?.() || 0 })
  }

  const handleYouTubeError = (e) => {
    const code = e?.data
    if (code === 101 || code === 150) {
      setYtError(
        'This video cannot be embedded (often Vevo or label restriction). Open it on YouTube or pick another video.'
      )
    } else if (code === 100) {
      setYtError('Video not found or private.')
    } else if (EMBED_ERROR_CODES.has(code)) {
      setYtError(`YouTube player error (${code}). Try another video.`)
    } else {
      setYtError('Could not play this YouTube video here. Try another one.')
    }
  }

  if (videoType === 'direct' && videoUrl) {
    return (
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16/9',
          background: 'black',
          borderRadius: '0.75rem',
          overflow: 'hidden',
        }}
      >
        <video
          ref={videoRef}
          src={videoUrl}
          controls={canControl}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          playsInline
          preload="metadata"
        >
          Your browser does not support the video tag.
        </video>
        {directError && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '1rem',
              textAlign: 'center',
              background: 'rgba(0,0,0,0.85)',
              color: 'var(--paper, #f5f3ef)',
              fontSize: '0.9rem',
            }}
          >
            {directError}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16/9',
        background: 'black',
        borderRadius: '0.75rem',
        overflow: 'hidden',
      }}
    >
      {videoId ? (
        <>
          <YouTube
            videoId={videoId}
            opts={{
              width: '100%',
              height: '100%',
              playerVars: {
                autoplay: 0,
                controls: canControl ? 1 : 0,
                rel: 0,
                modestbranding: 1,
                disablekb: canControl ? 0 : 1,
                origin: typeof window !== 'undefined' ? window.location.origin : undefined,
              },
            }}
            onReady={handleYouTubeReady}
            onPlay={handleYouTubePlay}
            onPause={handleYouTubePause}
            onError={handleYouTubeError}
            style={{ width: '100%', height: '100%' }}
          />
          {ytError && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.75rem',
                padding: '1.25rem',
                textAlign: 'center',
                background: 'rgba(12,14,22,0.92)',
                color: 'var(--paper, #f5f3ef)',
                zIndex: 2,
              }}
            >
              <strong style={{ fontSize: '1.05rem' }}>Video unavailable in Chan</strong>
              <span style={{ color: 'var(--fog, #9aa0ae)', fontSize: '0.9rem', maxWidth: 360 }}>
                {ytError}
              </span>
              <a
                href={`https://www.youtube.com/watch?v=${videoId}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--drift, #7c89f7)', fontWeight: 600 }}
              >
                Open on YouTube
              </a>
            </div>
          )}
        </>
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#666',
          }}
        >
          No video selected
        </div>
      )}
    </div>
  )
}
