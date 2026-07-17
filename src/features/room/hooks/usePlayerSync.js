import { useEffect, useRef, useCallback } from 'react'
import { doc, onSnapshot, setDoc, getDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'
import { isRemuxProxyUrl } from '../../../shared/lib/youtube.js'

const SYNC_THRESHOLD = 0.5 // 0.5s sync threshold as required
const VIEWER_RESYNC_MS = 3000
const HOST_HEARTBEAT_MS = 1500
const HOST_RECONCILIATION_SEEK_TIMEOUT = 15000 // max wait for player to seek after reconciliation
const PLAYER_READY_POLL_MS = 200
const PLAYER_READY_MAX_WAIT_MS = 12000

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
  const savedStateRef = useRef(null) // last known good playerState from Firestore
  const roomIdRef = useRef(roomId)

  // Reset reconciliation flags when room changes
  useEffect(() => {
    if (roomIdRef.current !== roomId) {
      roomIdRef.current = roomId
      initialHostSyncDoneRef.current = false
      reconciliationTargetTimeRef.current = null
      reconciliationAppliedAtRef.current = null
      savedStateRef.current = null
      lastVideoIdRef.current = null
      lastPlayingRef.current = null
    }
  }, [roomId])

  const writePlayerState = useCallback(async (patch, force = false) => {
    if (!roomId || !canControl || !room || !user) return
    const now = Date.now()
    // Debounce non-forced writes within 400ms to avoid flooding Firestore during rapid slider seeking
    if (!force && now - lastWriteTimeRef.current < 400) return
    lastWriteTimeRef.current = now

    const ref = doc(db, 'rooms', roomId, 'playerState', 'current')
    const baseUrl = room.videoUrl || null
    let patchOut = { ...patch }
    // Persist remux seek offset for MKV so joiners open the same cue window
    if (baseUrl && isRemuxProxyUrl(baseUrl) && typeof patchOut.currentTime === 'number') {
      const t = Math.max(0, Number(patchOut.currentTime) || 0)
      patchOut.remuxStartSec = t > 0.5 ? t : 0
      // Keep room.videoUrl base without t; player applies t from remuxStartSec / currentTime
    }
    await setDoc(ref, {
      videoId: room.videoId || '',
      videoUrl: room.videoUrl || null,
      isPlaying: false,
      currentTime: 0,
      updatedAt: serverTimestamp(),
      clientTimeMs: now,
      updatedBy: user.uid,
      ...patchOut,
    }, { merge: true })
  }, [roomId, canControl, room, user])

  // Apply a Firestore player state to the active player adapter
  const applyPlayerState = useCallback((state) => {
    if (!state) return false
    const player = playerRef.current
    if (!player || typeof player.getPlayerState !== 'function') return false

    const baseTimeMs = state.clientTimeMs || (state.updatedAt?.toMillis ? state.updatedAt.toMillis() : Date.now())
    // Only extrapolate elapsed time while actively playing AND someone is still in control.
    // If the saved state is paused (host left), resume exactly at the frozen currentTime.
    const elapsedSec = state.isPlaying ? Math.max(0, (Date.now() - baseTimeMs) / 1000) : 0
    const expectedTime = (Number(state.currentTime) || 0) + elapsedSec
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

    // VOD HLS (nsfw/direct) must still sync seeks — only true linear live skips them
    const isLiveStream = (
      room?.videoType === 'iptv'
      || room?.videoType === 'sports'
      || room?.source === 'iptv'
      || (room?.isLive && room?.videoType !== 'nsfw' && room?.videoType !== 'direct')
      || player.isLive?.()
    )
    // MKV remux: any meaningful jump must remux-from-t (not only 0.5s drift)
    const remuxJump = isRemuxProxyUrl(room?.videoUrl) && (
      diff > 1.5
      || (Number(state.remuxStartSec) > 0.5 && Math.abs(current - expectedTime) > 1.0)
    )
    if (!isLiveStream && (diff > SYNC_THRESHOLD || remuxJump)) {
      // Always pass absolute seconds — VideoPlayer remux path reloads ?t=
      player.seekTo?.(expectedTime, 'seconds')
    }
    return true
  }, [playerRef, room?.isLive, room?.videoType, room?.source, room?.videoUrl])

  // HOST/CO-HOST INITIAL RECONCILIATION:
  // When the host leaves and returns (or refreshes), restore the saved playerState
  // so playback continues from where they left off instead of restarting at 00:00.
  useEffect(() => {
    if (!canControl || !roomId || initialHostSyncDoneRef.current) return undefined

    let isMounted = true
    let pollTimer = null

    const waitForPlayer = () => new Promise((resolve) => {
      const started = Date.now()
      const tick = () => {
        if (!isMounted) {
          resolve(false)
          return
        }
        const player = playerRef.current
        if (player && typeof player.getPlayerState === 'function' && typeof player.getCurrentTime === 'function') {
          resolve(true)
          return
        }
        if (Date.now() - started >= PLAYER_READY_MAX_WAIT_MS) {
          resolve(false)
          return
        }
        pollTimer = setTimeout(tick, PLAYER_READY_POLL_MS)
      }
      tick()
    })

    const checkExistingState = async () => {
      try {
        const ref = doc(db, 'rooms', roomId, 'playerState', 'current')
        const snap = await getDoc(ref)
        if (!isMounted) return

        if (!snap.exists()) {
          initialHostSyncDoneRef.current = true
          return
        }

        const data = snap.data()
        savedStateRef.current = data

        const updatedAtMs = data.updatedAt?.toMillis
          ? data.updatedAt.toMillis()
          : (data.clientTimeMs || 0)
        const isRecent = Date.now() - updatedAtMs < 12 * 3600 * 1000
        const savedTime = Number(data.currentTime) || 0

        // Restore any meaningful saved position (even 1s+) so leave→rejoin never restarts
        if (data && savedTime > 0.5 && isRecent) {
          // Wait until the player adapter is actually ready before seeking
          const ready = await waitForPlayer()
          if (!isMounted) return

          if (ready) {
            // Force paused restore first so the player lands on the saved frame,
            // then re-apply original play state if it was playing.
            const restoreState = {
              ...data,
              // Always land on the frozen position first (no elapsed extrapolation on rejoin
              // when the last leave intentionally paused). If still marked playing and
              // updated very recently (<30s), allow mild extrapolation.
              isPlaying: false,
              currentTime: savedTime,
              clientTimeMs: Date.now(),
            }
            applyPlayerState(restoreState)

            // If the room was still actively playing (other co-host controlling, or
            // host briefly refreshed), resume play after seek settles.
            const wasActivelyPlaying = data.isPlaying === true && (Date.now() - updatedAtMs) < 30000
            if (wasActivelyPlaying) {
              setTimeout(() => {
                if (!isMounted) return
                applyPlayerState({
                  ...data,
                  currentTime: savedTime,
                  isPlaying: true,
                  clientTimeMs: Date.now(),
                })
              }, 400)
            }

            reconciliationTargetTimeRef.current = savedTime
            reconciliationAppliedAtRef.current = Date.now()
          } else {
            // Player never became ready — still guard the heartbeat so we don't
            // overwrite the saved position with 00:00.
            reconciliationTargetTimeRef.current = savedTime
            reconciliationAppliedAtRef.current = Date.now()
          }
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
    return () => {
      isMounted = false
      if (pollTimer) clearTimeout(pollTimer)
    }
  }, [canControl, roomId, applyPlayerState, playerRef])

  // Controller heartbeat (every 1.5s when playing, or 5s when paused)
  useEffect(() => {
    if (!canControl || (!room?.videoId && !room?.videoUrl)) return undefined

    const interval = setInterval(() => {
      if (!initialHostSyncDoneRef.current) return
      const player = playerRef.current
      if (!player || typeof player.getPlayerState !== 'function') return
      const state = player.getPlayerState()
      const isPlaying = state === 1
      let current = player.getCurrentTime?.() || 0

      // Remux-from-t: getCurrentTime is ABSOLUTE (adapter adds remuxBaseTime).
      // If adapter not ready and we still see ~0 while saved remuxStartSec is large, skip write.
      const saved = savedStateRef.current
      const savedTime = Number(saved?.currentTime) || 0
      const savedRemux = Number(saved?.remuxStartSec) || 0

      // Guard: do not overwrite an active room with 00:00 right after joining / mid remux reload
      if (current < 0.5) {
        if (savedTime > 0.5 || savedRemux > 0.5) return
        if (!isPlaying && room?.createdAt?.toMillis && Date.now() - room.createdAt.toMillis() > 15000) {
          return
        }
      }
      // Also ignore transient 0 while remuxing a seek (current jumped down vs last saved)
      if (savedTime > 5 && current < 1.5 && isRemuxProxyUrl(room?.videoUrl)) {
        return
      }

      // Guard: after host reconciliation, don't write until the player has actually seeked
      // to the reconciled position. This prevents overwriting the saved position with 0
      // while the player is still loading/seeking.
      if (reconciliationTargetTimeRef.current !== null && reconciliationAppliedAtRef.current) {
        const elapsed = Date.now() - reconciliationAppliedAtRef.current
        const target = reconciliationTargetTimeRef.current
        const diff = Math.abs(current - target)
        // Player has seeked close enough to the target — reconciliation complete
        if (diff < 3 || current >= target - 1) {
          reconciliationTargetTimeRef.current = null
          reconciliationAppliedAtRef.current = null
        } else if (elapsed < HOST_RECONCILIATION_SEEK_TIMEOUT) {
          // Still waiting for the player to seek — don't write 00:00 to Firestore!
          // Also re-issue seek periodically in case the first one was ignored.
          if (elapsed > 1500 && elapsed % 2000 < HOST_HEARTBEAT_MS + 50) {
            try {
              player.seekTo?.(target, true)
            } catch {
              /* ignore */
            }
          }
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
      if (!disposed && snap.exists()) {
        savedStateRef.current = snap.data()
        applyPlayerState(snap.data())
      }
    })
    const interval = setInterval(async () => {
      try {
        const snap = await getDoc(stateRef)
        if (!disposed && snap.exists()) {
          savedStateRef.current = snap.data()
          applyPlayerState(snap.data())
        }
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
        if (snap.exists()) {
          savedStateRef.current = snap.data()
          applyPlayerState(snap.data())
        }
      } catch {
        /* ignore */
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [applyPlayerState, roomId])

  return { writePlayerState, isHost, isCoHost, canControl }
}
