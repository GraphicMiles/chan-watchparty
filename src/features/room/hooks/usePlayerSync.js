import { useEffect, useRef, useCallback } from 'react'
import { doc, onSnapshot, setDoc, getDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'

const SYNC_THRESHOLD = 1.5

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
      isPlaying: false,
      currentTime: 0,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
      ...patch,
    }, { merge: true })
  }, [roomId, canControl, room, user])

  // Controller heartbeat every 5s
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

  // Viewer reconciliation
  useEffect(() => {
    if (canControl || !roomId) return

    const unsub = onSnapshot(doc(db, 'rooms', roomId, 'playerState', 'current'), (snap) => {
      const state = snap.data()
      if (!state) return
      const player = playerRef.current
      if (!player || player.getPlayerState === undefined) return
      if (!state.updatedAt?.toMillis) return

      const expectedTime = state.isPlaying
        ? state.currentTime + (Date.now() - state.updatedAt.toMillis()) / 1000
        : state.currentTime

      const current = player.getCurrentTime?.() || 0
      const playerState = player.getPlayerState()
      const diff = Math.abs(current - expectedTime)

      if (state.videoId && lastVideoIdRef.current !== state.videoId) {
        try {
          player.loadVideoById(state.videoId)
        } catch {
          /* ignore */
        }
        lastVideoIdRef.current = state.videoId
      }

      if (state.isPlaying && playerState !== 1) player.playVideo?.()
      else if (!state.isPlaying && playerState !== 2) player.pauseVideo?.()
      lastPlayingRef.current = state.isPlaying

      if (diff > SYNC_THRESHOLD) {
        player.seekTo(expectedTime, true)
      }
    })

    return unsub
  }, [canControl, roomId, playerRef])

  // Idle-tab resync on return
  useEffect(() => {
    if (canControl || !roomId) return
    const onVis = async () => {
      if (document.visibilityState !== 'visible') return
      const player = playerRef.current
      if (!player || player.getPlayerState === undefined) return
      try {
        const snap = await getDoc(doc(db, 'rooms', roomId, 'playerState', 'current'))
        const state = snap.data()
        if (!state?.updatedAt?.toMillis) return
        const expectedTime = state.isPlaying
          ? state.currentTime + (Date.now() - state.updatedAt.toMillis()) / 1000
          : state.currentTime
        const current = player.getCurrentTime?.() || 0
        if (Math.abs(current - expectedTime) > SYNC_THRESHOLD) {
          player.seekTo(expectedTime, true)
        }
        if (state.isPlaying) player.playVideo?.()
        else player.pauseVideo?.()
      } catch {
        /* ignore */
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [canControl, roomId, playerRef])

  return { writePlayerState, isHost, isCoHost, canControl }
}
