import { useEffect, useRef, useCallback } from 'react'
import { doc, onSnapshot, setDoc, getDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'

const SYNC_THRESHOLD = 1.5
const VIEWER_RESYNC_MS = 5000

export function usePlayerSync(roomId, room, playerRef) {
  const { user } = useAuth()
  const isHost = room?.hostId === user?.uid
  const isCoHost = Array.isArray(room?.coHosts) && room.coHosts.includes(user?.uid)
  const canControl = Boolean(isHost || isCoHost)
  const lastVideoIdRef = useRef(null)
  const lastPlayingRef = useRef(null)

  const writePlayerState = useCallback(async (patch) => {
    if (!roomId || !canControl || !room || !user) return
    const ref = doc(db, 'rooms', roomId, 'playerState', 'current')
    await setDoc(ref, {
      videoId: room.videoId || '',
      videoUrl: room.videoUrl || null,
      isPlaying: false,
      currentTime: 0,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
      ...patch,
    }, { merge: true })
  }, [roomId, canControl, room, user])

  // Controller heartbeat every 5s.
  useEffect(() => {
    if (!canControl || (!room?.videoId && !room?.videoUrl)) return undefined

    const interval = setInterval(() => {
      const player = playerRef.current
      if (!player || typeof player.getPlayerState !== 'function') return
      const state = player.getPlayerState()
      writePlayerState({
        ...(room.videoId ? { videoId: room.videoId } : { videoUrl: room.videoUrl }),
        isPlaying: state === 1,
        currentTime: player.getCurrentTime?.() || 0,
      }).catch(() => {})
    }, 5000)

    return () => clearInterval(interval)
  }, [canControl, room?.videoId, room?.videoUrl, playerRef, writePlayerState])

  // Apply a Firestore player state when the player is ready. The initial
  // snapshot can arrive before the player mounts, so viewer reconciliation is
  // also retried periodically below.
  const applyPlayerState = useCallback((state) => {
    if (!state?.updatedAt?.toMillis) return
    const player = playerRef.current
    if (!player || typeof player.getPlayerState !== 'function') return

    const expectedTime = state.isPlaying
      ? state.currentTime + (Date.now() - state.updatedAt.toMillis()) / 1000
      : state.currentTime
    const current = player.getCurrentTime?.() || 0
    const playerState = player.getPlayerState()
    const diff = Math.abs(current - expectedTime)

    // The room document owns the URL. A player adapter may implement this as
    // a no-op, while YouTube-compatible adapters can use it when available.
    if (state.videoId && lastVideoIdRef.current !== state.videoId) {
      player.loadVideoById?.(state.videoId)
      lastVideoIdRef.current = state.videoId
    }

    if (state.isPlaying && playerState !== 1) player.playVideo?.()
    else if (!state.isPlaying && playerState !== 2) player.pauseVideo?.()
    lastPlayingRef.current = state.isPlaying

    if (diff > SYNC_THRESHOLD) player.seekTo?.(expectedTime, true)
  }, [playerRef])

  // Viewer reconciliation.
  useEffect(() => {
    if (canControl || !roomId) return undefined

    let disposed = false
    const stateRef = doc(db, 'rooms', roomId, 'playerState', 'current')
    const unsub = onSnapshot(stateRef, (snap) => {
      if (!disposed) applyPlayerState(snap.data())
    })
    const interval = setInterval(async () => {
      try {
        const snap = await getDoc(stateRef)
        if (!disposed) applyPlayerState(snap.data())
      } catch {
        /* retry on the next interval */
      }
    }, VIEWER_RESYNC_MS)

    return () => {
      disposed = true
      unsub()
      clearInterval(interval)
    }
  }, [applyPlayerState, canControl, roomId])

  // Idle-tab resync on return.
  useEffect(() => {
    if (canControl || !roomId) return undefined
    const onVis = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const snap = await getDoc(doc(db, 'rooms', roomId, 'playerState', 'current'))
        applyPlayerState(snap.data())
      } catch {
        /* ignore */
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [applyPlayerState, canControl, roomId])

  return { writePlayerState, isHost, isCoHost, canControl }
}
