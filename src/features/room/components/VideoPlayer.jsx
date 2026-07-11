import { useRef } from 'react'
import YouTube from 'react-youtube'

export default function VideoPlayer({ videoId, isHost, onReady, onPlayerEvent }) {
  const playerRef = useRef(null)

  const handleReady = (e) => {
    playerRef.current = e.target
    onReady?.(e.target)
  }

  const handlePlay = () => {
    onPlayerEvent?.({ isPlaying: true, currentTime: playerRef.current?.getCurrentTime() || 0 })
  }

  const handlePause = () => {
    onPlayerEvent?.({ isPlaying: false, currentTime: playerRef.current?.getCurrentTime() || 0 })
  }

  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: 'black', borderRadius: '0.75rem', overflow: 'hidden' }}>
      <YouTube
        videoId={videoId}
        opts={{
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            controls: isHost ? 1 : 0,
            rel: 0,
            modestbranding: 1,
          },
        }}
        onReady={handleReady}
        onPlay={handlePlay}
        onPause={handlePause}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  )
}
