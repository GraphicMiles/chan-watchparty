import { useEffect, useRef, useState } from 'react'
import { Loader2, AlertCircle, Camera } from 'lucide-react'
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
        const token = await user.getIdToken()
        const res = await fetch('/api/room', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'livekit', roomId, uid: user.uid, role: isHost ? 'host' : 'viewer' }),
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
    <div style={{
      position: 'relative',
      width: '100%',
      height: '100%',
      background: '#000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <video ref={videoRef} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      {!connected && !error && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.75rem',
          color: 'var(--fog)',
          fontSize: '0.9rem',
        }}>
          <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
          Connecting to screen share...
        </div>
      )}
      {error && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.75rem',
          color: 'var(--ember)',
          textAlign: 'center',
          padding: '1rem',
          fontSize: '0.9rem',
        }}>
          <AlertCircle size={24} />
          {error}
        </div>
      )}
      {fallback && (
        <div style={{
          position: 'absolute',
          top: '0.75rem',
          left: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          background: 'rgba(12, 14, 22, 0.85)',
          backdropFilter: 'blur(8px)',
          color: 'var(--paper)',
          padding: '0.4rem 0.7rem',
          borderRadius: '8px',
          fontSize: '0.78rem',
          border: '1px solid rgba(255,255,255,0.06)',
        }}>
          <Camera size={12} />
          Camera fallback (mobile)
        </div>
      )}
    </div>
  )
}
