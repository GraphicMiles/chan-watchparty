import { useEffect, useRef, useCallback } from 'react'
import { doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'

const SYNC_THRESHOLD = 1.5

export function usePlayerSync(roomId, room, playerRef) {
  const { user } = useAuth()
  const isHost = room?.hostId === user?.uid
  const isCoHost = room?.coHosts?.includes(user?.uid) ?? false
  const canControl = isHost || isCoHost
  const lastVideoIdRef = useRef(null)

  const writePlayerState = useCallback(async (patch) => {
    if (!roomId || !canControl || !room) return
    const ref = doc(db, 'rooms', roomId, 'playerState', 'current')
    await setDoc(ref, {
      videoId: room.videoId || '',
      isPlaying: false,
      currentTime: 0,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
      ...patch,
    }, { merge: true })
  }, [roomId, canControl, room, user])

  // Controller heartbeat: reads playerRef.current inside the interval so it starts as soon as the player is ready
  useEffect(() => {
    if (!canControl || !room?.videoId) return

    const interval = setInterval(() => {
      const player = playerRef.current
      if (!player || player.getPlayerState === undefined) return
      const state = player.getPlayerState()
      if (state === undefined) return
      const isPlaying = state === 1
      writePlayerState({
        videoId: room.videoId,
        isPlaying,
        currentTime: player.getCurrentTime?.() || 0,
      })
    }, 5000)

    return () => clearInterval(interval)
  }, [canControl, room?.videoId, playerRef, writePlayerState])

  // Viewer reconciliation: reads playerRef.current inside the callback
  useEffect(() => {
    if (canControl || !roomId) return

    const unsub = onSnapshot(doc(db, 'rooms', roomId, 'playerState', 'current'), (snap) => {
      const state = snap.data()
      if (!state) return
      const player = playerRef.current
      if (!player || player.getPlayerState === undefined) return

      const expectedTime = state.isPlaying
        ? state.currentTime + (Date.now() - state.updatedAt.toMillis()) / 1000
        : state.currentTime

      const current = player.getCurrentTime?.() || 0
      const playerState = player.getPlayerState()
      const diff = Math.abs(current - expectedTime)

      // Video change
      if (lastVideoIdRef.current !== state.videoId) {
        player.loadVideoById(state.videoId)
        lastVideoIdRef.current = state.videoId
      }

      // Play/pause toggle
      if (state.isPlaying && playerState !== 1) {
        player.playVideo?.()
      } else if (!state.isPlaying && playerState !== 2) {
        player.pauseVideo?.()
      }

      // Seek only if drifted past threshold
      if (diff > SYNC_THRESHOLD) {
        player.seekTo(expectedTime, true)
      }
    })

    return unsub
  }, [isHost, roomId, playerRef])

  return { writePlayerState, isHost, isCoHost, canControl }
}
