import { useEffect, useRef, useState } from 'react'
import { createRoom, connectToLivekit, publishScreenShare, publishCameraShare, isDisplayMediaSupported, getHostVideoTrack } from '../services/livekit.js'
import { parseJsonResponse } from '../../../shared/lib/api.js'

export default function ScreenShare({ roomId, isHost, user }) {
  const videoRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState(null)
  const [fallback, setFallback] = useState(null)
  const lkRef = useRef(null)
  const streamRef = useRef(null)

  useEffect(() => {
    let mounted = true

    const setup = async () => {
      try {
        const res = await fetch('/api/createLiveKitToken', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId, uid: user.uid, role: isHost ? 'host' : 'viewer' }),
        })
        const data = await parseJsonResponse(res)
        if (!res.ok) throw new Error(data.error || 'Could not get LiveKit token')

        const lkRoom = createRoom()
        lkRef.current = lkRoom
        await connectToLivekit(lkRoom, data.token)
        if (!mounted) return
        setConnected(true)

        if (isHost) {
          try {
            const stream = await publishScreenShare(lkRoom)
            streamRef.current = stream
          } catch (shareErr) {
            // On mobile, getDisplayMedia is not supported. Fall back to camera share.
            if (!isDisplayMediaSupported() && navigator.mediaDevices?.getUserMedia) {
              const stream = await publishCameraShare(lkRoom)
              streamRef.current = stream
              if (mounted) setFallback('camera')
            } else {
              throw shareErr
            }
          }
        }

        const attachTrack = () => {
          const track = getHostVideoTrack(lkRoom)
          if (track && videoRef.current) {
            track.attach(videoRef.current)
          }
        }

        lkRoom.on('trackSubscribed', attachTrack)
        attachTrack()
      } catch (err) {
        if (mounted) setError(err.message)
      }
    }

    setup()

    return () => {
      mounted = false
      streamRef.current?.getTracks?.().forEach((t) => t.stop())
      lkRef.current?.disconnect?.()
    }
  }, [roomId, isHost, user])

  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: 'black', borderRadius: '0.75rem', overflow: 'hidden' }}>
      <video ref={videoRef} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      {!connected && !error && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fog)' }}>
          Connecting to screen share…
        </div>
      )}
      {error && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ember)', textAlign: 'center', padding: '1rem' }}>
          {error}
        </div>
      )}
      {fallback && (
        <div style={{ position: 'absolute', top: '0.75rem', left: '0.75rem', background: 'rgba(0,0,0,0.7)', color: 'var(--paper)', padding: '0.35rem 0.6rem', borderRadius: '0.4rem', fontSize: '0.8rem' }}>
          Camera fallback (mobile)
        </div>
      )}
    </div>
  )
}
