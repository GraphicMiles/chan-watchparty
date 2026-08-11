import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VideoPlayerPlugin } from '../../../native/VideoPlayerPlugin'
import { AlertTriangle, Loader2 } from 'lucide-react'
import styles from './NativeEmbeddedPlayer.module.scss'

/** Map technical errors to friendly copy — users never see jargon. */
function friendlyError(message) {
  const text = String(message || '')
  if (/expired|page instead of video|no longer valid|404/i.test(text)) {
    return 'This link has expired. Pick the episode again or try another source.'
  }
  if (/network|timeout|offline|failed to fetch/i.test(text)) {
    return 'Network issue while fetching media. Check your connection and retry.'
  }
  if (/reject|blocked|forbidden|403/i.test(text)) {
    return 'The source blocked playback. Try another source.'
  }
  return "Couldn't play this video. It may be unavailable or expired."
}

/**
 * NativeEmbeddedPlayer — the ONE player for non-YouTube content on Android.
 *
 * Renders a placeholder surface (the same 16:9 stage rect the web player
 * uses) and positions the native overlay over it via VideoPlayerPlugin.
 * Drives playback through the plugin and exposes the same adapter shape
 * usePlayerSync expects, so room sync / queue auto-next work unchanged.
 *
 * The user never sees a choice or technical detail — just friendly status
 * ("Fetching media…" / "Buffering…") and the video.
 */
export default function NativeEmbeddedPlayer({
  url,
  title,
  startSeconds = 0,
  referer,
  isLive = false,
  onReady,
  onPlayerEvent,
  onEnded,
  onError,
  onReResolve = null,
}) {
  const surfaceRef = useRef(null)
  const stateRef = useRef({ posSec: 0, durSec: 0, playing: false, ended: false })
  const callbacksRef = useRef({ onReady, onPlayerEvent, onEnded, onError })
  const readySentRef = useRef(false)

  const [status, setStatus] = useState('fetching') // fetching|playing|paused|ended|error
  const [errorMsg, setErrorMsg] = useState(null)
  const [reResolving, setReResolving] = useState(false)

  useEffect(() => {
    callbacksRef.current = { onReady, onPlayerEvent, onEnded, onError }
  }, [onReady, onPlayerEvent, onEnded, onError])

  // ── Adapter (same shape as VideoPlayer's web adapter) ────────────────
  const adapter = useMemo(() => ({
    getCurrentTime: () => stateRef.current.posSec,
    getDuration: () => stateRef.current.durSec,
    getPlayerState: () => {
      const s = stateRef.current
      if (s.playing) return 1
      if (s.durSec > 0) return 2
      return 0
    },
    isLive: () => Boolean(isLive),
    loadVideoById: () => {}, // not applicable — URLs are handled by the native side
    playVideo: () => { VideoPlayerPlugin.play().catch(() => {}) },
    pauseVideo: () => { VideoPlayerPlugin.pause().catch(() => {}) },
    seekTo: (value, type = 'seconds') => {
      const dur = stateRef.current.durSec || 0
      const targetSec = type === 'fraction' ? (value * (dur || 0)) : Number(value) || 0
      VideoPlayerPlugin.seekTo({ positionMs: Math.max(0, Math.round(targetSec * 1000)) }).catch(() => {})
    },
  }), [isLive])

  const handleEvent = useCallback((e) => {
    if (!e) return
    switch (e.state) {
      case 'ready':
        setStatus('playing')
        setErrorMsg(null)
        if (!readySentRef.current) {
          readySentRef.current = true
          callbacksRef.current.onReady?.(adapter)
        }
        break
      case 'buffering':
        setStatus('fetching')
        break
      case 'playing':
        stateRef.current.playing = true
        setStatus('playing')
        setErrorMsg(null)
        callbacksRef.current.onPlayerEvent?.({ isPlaying: true, currentTime: stateRef.current.posSec })
        break
      case 'paused':
        stateRef.current.playing = false
        setStatus('paused')
        callbacksRef.current.onPlayerEvent?.({ isPlaying: false, currentTime: stateRef.current.posSec })
        break
      case 'ended':
        stateRef.current.ended = true
        stateRef.current.playing = false
        setStatus('ended')
        if (!stateRef.current.endedHandled) {
          stateRef.current.endedHandled = true
          callbacksRef.current.onEnded?.()
        }
        break
      case 'error':
        setStatus('error')
        setErrorMsg(friendlyError(e.message))
        callbacksRef.current.onError?.(new Error(friendlyError(e.message)))
        break
      default:
        break
    }
  }, [adapter])

  // ── Lifecycle: show, measure, poll, close ─────────────────────────────
  useEffect(() => {
    let cancelled = false
    let raf = 0
    let poll = null
    let listenerHandle = null
    let closed = false

    const measureAndSetRect = () => {
      const el = surfaceRef.current
      if (el && !closed) {
        try {
          const dpr = window.devicePixelRatio || 1
          const r = el.getBoundingClientRect()
          VideoPlayerPlugin.setRect({
            x: Math.round(r.left * dpr),
            y: Math.round(r.top * dpr),
            w: Math.round(r.width * dpr),
            h: Math.round(r.height * dpr),
          }).catch(() => {})
        } catch { /* keep last rect */ }
      }
      if (!closed) raf = requestAnimationFrame(measureAndSetRect)
    }

    const start = async () => {
      try {
        listenerHandle = await VideoPlayerPlugin.addListener('playbackState', (e) => {
          if (!cancelled) handleEvent(e)
        })
        await VideoPlayerPlugin.showEmbedded({
          url,
          title: title || 'Chan video',
          startSeconds: startSeconds || 0,
          referer,
        })
        stateRef.current = { posSec: 0, durSec: 0, playing: false, ended: false, endedHandled: false }
        readySentRef.current = false
        setStatus('fetching')
        measureAndSetRect()
        poll = setInterval(async () => {
          if (cancelled || closed) return
          try {
            const p = await VideoPlayerPlugin.getPosition()
            if (p && !cancelled) {
              stateRef.current.posSec = (p.positionMs || 0) / 1000
              stateRef.current.durSec = (p.durationMs || 0) / 1000
            }
          } catch { /* poll best-effort */ }
        }, 1000)
      } catch (err) {
        setStatus('error')
        setErrorMsg(friendlyError(err?.message))
        callbacksRef.current.onError?.(err)
      }
    }

    start()

    return () => {
      cancelled = true
      closed = true
      cancelAnimationFrame(raf)
      if (poll) clearInterval(poll)
      if (listenerHandle) {
        try { listenerHandle.remove?.() } catch { /* */ }
      }
      // Hand the position/end state back to the room (sync + queue)
      VideoPlayerPlugin.closeEmbedded()
        .then((result) => {
          if (!result) return
          const posSec = (result.positionMs || 0) / 1000
          if (result.ended) {
            if (posSec > 0) callbacksRef.current.onPlayerEvent?.({ isPlaying: false, currentTime: posSec })
            if (!stateRef.current.endedHandled) callbacksRef.current.onEnded?.()
          } else if (posSec > 0) {
            callbacksRef.current.onPlayerEvent?.({ isPlaying: false, currentTime: posSec })
          }
        })
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, title, referer])

  return (
    <div className={styles.surface} ref={surfaceRef} data-native-embedded>
      {status !== 'playing' && !errorMsg && (
        <div className={styles.statusOverlay}>
          <Loader2 size={20} className={styles.spin} />
          <span>{status === 'ended' ? 'Playback finished' : 'Fetching media…'}</span>
        </div>
      )}
      {errorMsg && (
        <div className={styles.errorOverlay}>
          <AlertTriangle size={22} />
          <span>{errorMsg}</span>
          {onReResolve && /downloadwella|fsmc/i.test(String(url || '')) && (
            <button
              type="button"
              className={styles.reResolveBtn}
              disabled={reResolving}
              onClick={async () => {
                setReResolving(true)
                try {
                  await onReResolve(url)
                } catch { /* error overlay stays */ } finally {
                  setReResolving(false)
                }
              }}
            >
              {reResolving ? 'Resolving…' : 'Re-resolve link'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
