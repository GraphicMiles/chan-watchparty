import { useEffect, useRef, useCallback } from 'react'
import { doc, onSnapshot, setDoc, getDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'

const SYNC_THRESHOLD = 0.5 // 0.5s sync threshold as required
const VIEWER_RESYNC_MS = 3000
const HOST_HEARTBEAT_MS = 1500
const HOST_RECONCILIATION_SEEK_TIMEOUT = 10000 // max wait for player to seek after reconciliation

export function usePlayerSync(roomId, room, playerRef) {
  const { user } = useAuth()
  const isHost = room?.hostId === user?.uid
  const isCoHost = Array.isArray(room?.coHosts) && room.coHosts.includes(user?.uid)
  const canControl = Boolean(isHost || isCoHost)
  
  const lastVideoIdRef = useRef(null)
  const lastPlayingRef = useRef(null)
  const initialHostSyncDoneRef = useRef(false)
  const lastWriteTimeRef = useRef(0)
  const reconciliationTargetTimeRef = useRef(null) // set during host reconciliation
  const reconciliationAppliedAtRef = useRef(null) // timestamp when reconciliation was applied

  const writePlayerState = useCallback(async (patch, force = false) => {
    if (!roomId || !canControl || !room || !user) return
    const now = Date.now()
    // Debounce non-forced writes within 400ms to avoid flooding Firestore during rapid slider seeking
    if (!force && now - lastWriteTimeRef.current < 400) return
    lastWriteTimeRef.current = now

    const ref = doc(db, 'rooms', roomId, 'playerState', 'current')
    await setDoc(ref, {
      videoId: room.videoId || '',
      videoUrl: room.videoUrl || null,
      isPlaying: false,
      currentTime: 0,
      updatedAt: serverTimestamp(),
      clientTimeMs: now,
      updatedBy: user.uid,
      ...patch,
    }, { merge: true })
  }, [roomId, canControl, room, user])

  // Apply a Firestore player state to the active player adapter
  const applyPlayerState = useCallback((state) => {
    if (!state) return
    const player = playerRef.current
    if (!player || typeof player.getPlayerState !== 'function') return

    const baseTimeMs = state.clientTimeMs || (state.updatedAt?.toMillis ? state.updatedAt.toMillis() : Date.now())
    const elapsedSec = state.isPlaying ? Math.max(0, (Date.now() - baseTimeMs) / 1000) : 0
    const expectedTime = (state.currentTime || 0) + elapsedSec
    const current = player.getCurrentTime?.() || 0
    const playerState = player.getPlayerState()
    const diff = Math.abs(current - expectedTime)

    // Sync video ID/URL if adapter supports loadVideoById
    if (state.videoId && lastVideoIdRef.current !== state.videoId) {
      player.loadVideoById?.(state.videoId)
      lastVideoIdRef.current = state.videoId
    }

    if (state.isPlaying && playerState !== 1) {
      player.playVideo?.()
    } else if (!state.isPlaying && playerState !== 2) {
      player.pauseVideo?.()
    }
    lastPlayingRef.current = state.isPlaying

    const isLiveStream = room?.isLive || room?.videoType === 'iptv' || room?.source === 'iptv' || player.isLive?.()
    if (!isLiveStream && diff > SYNC_THRESHOLD) {
      player.seekTo?.(expectedTime, true)
    }
  }, [playerRef, room?.isLive, room?.videoType, room?.source])

  // HOST/CO-HOST INITIAL RECONCILIATION:
  // When the host leaves and returns (or refreshes), check existing room playerState FIRST
  // so the host does NOT restart the watch from 00:00 for all participants!
  useEffect(() => {
    if (!canControl || !roomId || initialHostSyncDoneRef.current) return undefined

    let isMounted = true
    const checkExistingState = async () => {
      try {
        const ref = doc(db, 'rooms', roomId, 'playerState', 'current')
        const snap = await getDoc(ref)
        if (!isMounted || !snap.exists()) {
          initialHostSyncDoneRef.current = true
          return
        }
        const data = snap.data()
        // If room state exists and is currently active (> 2s into video and updated within last 6 hours),
        // apply that state to the host's player instead of writing 00:00!
        const updatedAtMs = data.updatedAt?.toMillis ? data.updatedAt.toMillis() : (data.clientTimeMs || 0)
        const isRecent = Date.now() - updatedAtMs < 6 * 3600 * 1000
        if (data && data.currentTime > 2 && isRecent) {
          applyPlayerState(data)
          // Track the reconciliation target so heartbeat doesn't overwrite with 00:00
          reconciliationTargetTimeRef.current = data.currentTime
          reconciliationAppliedAtRef.current = Date.now()
        }
      } catch (err) {
        console.error('Host initial reconciliation check failed:', err)
      } finally {
        if (isMounted) {
          initialHostSyncDoneRef.current = true
        }
      }
    }

    checkExistingState()
    return () => { isMounted = false }
  }, [canControl, roomId, applyPlayerState])

  // Controller heartbeat (every 1.5s when playing, or 5s when paused)
  useEffect(() => {
    if (!canControl || (!room?.videoId && !room?.videoUrl)) return undefined

    const interval = setInterval(() => {
      if (!initialHostSyncDoneRef.current) return
      const player = playerRef.current
      if (!player || typeof player.getPlayerState !== 'function') return
      const state = player.getPlayerState()
      const isPlaying = state === 1
      const current = player.getCurrentTime?.() || 0

      // Guard: do not overwrite an active room with 00:00 right after joining
      if (current === 0 && !isPlaying && room?.createdAt?.toMillis && Date.now() - room.createdAt.toMillis() > 30000) {
        return
      }

      // Guard: after host reconciliation, don't write until the player has actually seeked
      // to the reconciled position. This prevents overwriting the saved position with 0
      // while the player is still loading/seeking.
      if (reconciliationTargetTimeRef.current !== null && reconciliationAppliedAtRef.current) {
        const elapsed = Date.now() - reconciliationAppliedAtRef.current
        const diff = Math.abs(current - reconciliationTargetTimeRef.current)
        // Player has seeked close enough to the target — reconciliation complete
        if (diff < 3) {
          reconciliationTargetTimeRef.current = null
          reconciliationAppliedAtRef.current = null
        } else if (elapsed < HOST_RECONCILIATION_SEEK_TIMEOUT) {
          // Still waiting for the player to seek — don't write 00:00 to Firestore!
          return
        } else {
          // Timeout — clear the reconciliation guard and let heartbeat write normally
          reconciliationTargetTimeRef.current = null
          reconciliationAppliedAtRef.current = null
        }
      }

      writePlayerState({
        ...(room.videoId ? { videoId: room.videoId } : { videoUrl: room.videoUrl }),
        isPlaying,
        currentTime: current,
      }).catch(() => {})
    }, HOST_HEARTBEAT_MS)

    return () => clearInterval(interval)
  }, [canControl, room?.videoId, room?.videoUrl, room?.createdAt, playerRef, writePlayerState])

  // Viewer real-time synchronization (< 0.5s threshold)
  useEffect(() => {
    if (canControl || !roomId) return undefined

    let disposed = false
    const stateRef = doc(db, 'rooms', roomId, 'playerState', 'current')
    const unsub = onSnapshot(stateRef, (snap) => {
      if (!disposed && snap.exists()) applyPlayerState(snap.data())
    })
    const interval = setInterval(async () => {
      try {
        const snap = await getDoc(stateRef)
        if (!disposed && snap.exists()) applyPlayerState(snap.data())
      } catch {
        /* retry on next interval */
      }
    }, VIEWER_RESYNC_MS)

    return () => {
      disposed = true
      unsub()
      clearInterval(interval)
    }
  }, [applyPlayerState, canControl, roomId])

  // Idle-tab resync on return to active tab
  useEffect(() => {
    if (!roomId) return undefined
    const onVis = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const snap = await getDoc(doc(db, 'rooms', roomId, 'playerState', 'current'))
        if (snap.exists()) applyPlayerState(snap.data())
      } catch {
        /* ignore */
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [applyPlayerState, roomId])

  return { writePlayerState, isHost, isCoHost, canControl }
}
