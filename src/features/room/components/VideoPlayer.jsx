import { useEffect, useRef } from 'react'
import YouTube from 'react-youtube'

export default function VideoPlayer({ videoId, videoUrl, videoType = 'youtube', canControl, onReady, onPlayerEvent }) {
  const playerRef = useRef(null)
  const videoRef = useRef(null)

  // Handle direct video (HTML5 player)
  useEffect(() => {
    if (videoType !== 'direct' || !videoUrl || !videoRef.current) return

    const video = videoRef.current
    
    const handlePlay = () => {
      onPlayerEvent?.({ isPlaying: true, currentTime: video.currentTime })
    }
    
    const handlePause = () => {
      onPlayerEvent?.({ isPlaying: false, currentTime: video.currentTime })
    }
    
    const handleTimeUpdate = () => {
      // Send time updates occasionally for sync
      if (Math.random() > 0.95) {
        onPlayerEvent?.({ currentTime: video.currentTime })
      }
    }

    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('timeupdate', handleTimeUpdate)
    
    // Notify parent that player is ready with a YouTube-shaped interface
    onReady?.({ 
      playVideo: () => video.play(),
      pauseVideo: () => video.pause(),
      seekTo: (time) => { video.currentTime = time },
      getCurrentTime: () => video.currentTime,
      getDuration: () => video.duration,
      // Shim: mirrors YouTube's player state enum (1 = playing, 2 = paused)
      getPlayerState: () => video.paused ? 2 : 1,
    })

    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('timeupdate', handleTimeUpdate)
    }
  }, [videoType, videoUrl, onPlayerEvent, onReady])

  // Handle YouTube player
  const handleYouTubeReady = (e) => {
    playerRef.current = e.target
    onReady?.(e.target)
  }

  const handleYouTubePlay = () => {
    onPlayerEvent?.({ isPlaying: true, currentTime: playerRef.current?.getCurrentTime() || 0 })
  }

  const handleYouTubePause = () => {
    onPlayerEvent?.({ isPlaying: false, currentTime: playerRef.current?.getCurrentTime() || 0 })
  }

  // Render direct video player
  if (videoType === 'direct' && videoUrl) {
    return (
      <div style={{ 
        position: 'relative', 
        width: '100%', 
        aspectRatio: '16/9', 
        background: 'black', 
        borderRadius: '0.75rem', 
        overflow: 'hidden' 
      }}>
        <video
          ref={videoRef}
          src={videoUrl}
          controls={canControl}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          crossOrigin="anonymous"
          playsInline
          preload="metadata"
        >
          Your browser does not support the video tag.
        </video>
      </div>
    )
  }

  // Render YouTube player (default)
  return (
    <div style={{ 
      position: 'relative', 
      width: '100%', 
      aspectRatio: '16/9', 
      background: 'black', 
      borderRadius: '0.75rem', 
      overflow: 'hidden' 
    }}>
      {videoId ? (
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
            },
          }}
          onReady={handleYouTubeReady}
          onPlay={handleYouTubePlay}
          onPause={handleYouTubePause}
          style={{ width: '100%', height: '100%' }}
        />
      ) : (
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666'
        }}>
          No video selected
        </div>
      )}
    </div>
  )
}
