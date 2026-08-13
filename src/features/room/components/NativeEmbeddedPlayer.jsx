import { useEffect, useRef, useState } from 'react'
import { VideoPlayerPlugin } from '../../../native/VideoPlayerPlugin'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import styles from './NativeEmbeddedPlayer.module.scss'

/** Friendly, jargon-free copy. Technical detail goes to logs only. */
function friendlyError(kind, message) {
  const text = String(message || '')
  if (kind === 'expired' || /expired|page instead of video|no longer valid|404|410/i.test(text)) {
    return 'This link has expired. Refresh it or pick the episode again.'
  }
  if (kind === 'network' || /network|timeout|offline|failed to fetch|unreachable/i.test(text)) {
    return 'Network issue while fetching media. Check your connection and retry.'
  }
  if (kind === 'decode') {
    return "This video uses a format your device can't play. Try a different episode or source."
  }
  return "Couldn't play this video. It may be unavailable or expired."
}

const NETWORK_RETRIES = 2
const RETRY_BACKOFF_MS = [1500, 3000]

/**
 * NativeEmbeddedPlayer — the ONE player for non-YouTube content on Android.
 *
 * Plays the stream DIRECTLY from the CDN through the native engine
 * (ExoPlayer ⇄ LibVLC) using the stream descriptor's headers — never through
 * the WebView, never through the web player. On any failure it runs a
 * recovery state machine:
 *
 *   expired → refresh from sourceUrl (fresh token) → resume at position
 *   network → retry (backoff) → mirrors → refresh → fail
 *   decode  → engine switch (native) → mirrors → fail (honest message)
 *   other   → probe the URL to classify, then the above
 *
 * Only when every recovery path is exhausted does the overlay close and a
 * friendly error card appear (with actions that can actually help).
 */
export default function NativeEmbeddedPlayer({
  url,
  title,
  startSeconds = 0,
  referer,
  headers,
  container,
  codec,
  sourceUrl,
  mirrors = [],
  isLive = false,
  onReady,
  onPlayerEvent,
  onEnded,
  onError,
  onRefresh = null, // async (sourceUrl) => descriptor
  controlsHeight = 0, // CSS px of the app's control bar strip (native surface shrinks)
  onProgress = null, // ({ currentSec, durationSec, playing, buffering, percent }) => void
  onApi = null, // exposes the native adapter for the app's control bar
  onControlsTap = null, // native surface tapped -> app toggles its control bar
  onFullscreenChange = null, // native fullscreen entered/exited (syncs JS state)
  visible = true, // false when room panels must render above the video
  clipBottomPx = 0, // CSS px clipped off the viewport bottom (mobile sheet) —
                    // the native surface never covers the panel area, so the
                    // panel renders ON TOP of the video like the Share modal
}) {
  const propsRef = useRef({ onProgress, onApi, onControlsTap, onFullscreenChange })
  useEffect(() => {
    propsRef.current = { onProgress, onApi, onControlsTap, onFullscreenChange }
  }, [onProgress, onApi, onControlsTap, onFullscreenChange])
  const surfaceRef = useRef(null)
  const clipRef = useRef(clipBottomPx)
  useEffect(() => {
    clipRef.current = clipBottomPx
  }, [clipBottomPx])
  const stateRef = useRef({ posSec: startSeconds || 0, durSec: 0, playing: false, ended: false, endedHandled: false })
  const callbacksRef = useRef({ onReady, onPlayerEvent, onEnded, onError })
  const readySentRef = useRef(false)
  const sessionActiveRef = useRef(true)
  const timersRef = useRef([])
  const mirrorIdxRef = useRef(0)
  const netRetryRef = useRef(0)
  const cfgRef = useRef({ url, title, referer, headers, container, codec })
  const controlsHeightRef = useRef(controlsHeight)
  useEffect(() => {
    controlsHeightRef.current = controlsHeight
  }, [controlsHeight])

  const visibleRef = useRef(visible)
  useEffect(() => {
    visibleRef.current = visible
    VideoPlayerPlugin.setVisible({ visible }).catch(() => {})
  }, [visible])

  const [errorMsg, setErrorMsg] = useState(null)
  const [busyAction, setBusyAction] = useState(null) // 'retry' | 'reresolve'

  useEffect(() => {
    callbacksRef.current = { onReady, onPlayerEvent, onEnded, onError }
  }, [onReady, onPlayerEvent, onEnded, onError])

  useEffect(() => {
    cfgRef.current = { url, title, referer, headers, container, codec }
  }, [url, title, referer, headers, container, codec])

  // Video change (queue play-now / change video): the component stays
  // mounted (no key) — re-show the native player with the new media.
  const prevUrlRef = useRef(url)
  useEffect(() => {
    if (prevUrlRef.current === url) return
    prevUrlRef.current = url
    if (!url) return
    // A new URL is a new session — revive even if the previous media
    // hit terminalError (that path sets sessionActive=false).
    sessionActiveRef.current = true
    setErrorMsg(null)
    // Reset session state and load the new media from the start (the room's
    // playerState sync will resume/pause as needed).
    stateRef.current = { posSec: 0, durSec: 0, playing: false, ended: false, endedHandled: false }
    readySentRef.current = false
    mirrorIdxRef.current = 0
    netRetryRef.current = 0
    showRef.current(cfgRef.current, 0).catch(() => {})
  }, [url])

  // ── Recovery & control (plain fns + refs; avoids memoization cycles) ──

  const later = (fn, ms) => {
    if (!sessionActiveRef.current) return
    const t = setTimeout(() => { if (sessionActiveRef.current) fn() }, ms)
    timersRef.current.push(t)
  }

  const clearTimers = () => {
    timersRef.current.forEach((t) => clearTimeout(t))
    timersRef.current = []
  }

  // Adapter (same shape as VideoPlayer's web adapter) — recreated per render;
  // only used via handleEventRef so sync/queue keep working unchanged.
  const adapter = {
    getCurrentTime: () => stateRef.current.posSec,
    getDuration: () => stateRef.current.durSec,
    getPlayerState: () => {
      const s2 = stateRef.current
      if (s2.playing) return 1
      if (s2.durSec > 0) return 2
      return 0
    },
    isLive: () => Boolean(isLive),
    loadVideoById: () => {},
    playVideo: () => { VideoPlayerPlugin.play().catch(() => {}) },
    pauseVideo: () => { VideoPlayerPlugin.pause().catch(() => {}) },
    seekTo: (value, type = 'seconds') => {
      const dur = stateRef.current.durSec || 0
      const targetSec = type === 'fraction' ? (value * (dur || 0)) : Number(value) || 0
      VideoPlayerPlugin.seekTo({ positionMs: Math.max(0, Math.round(targetSec * 1000)) }).catch(() => {})
    },
  }

  const show = async (cfg, startSec) => {
    if (!sessionActiveRef.current) return
    readySentRef.current = false
    mirrorIdxRef.current = 0
    netRetryRef.current = 0
    try {
      await VideoPlayerPlugin.showEmbedded({
        url: cfg.url,
        title: title || 'Chan video',
        startSeconds: startSec || 0,
        referer: cfg.referer,
        headers: cfg.headers || undefined,
        container: cfg.container || undefined,
        codec: cfg.codec || undefined,
        controls: false, // app's own control bar drives playback — no native chrome
        isLive: Boolean(isLive),
      })
    } catch (err) {
      if (sessionActiveRef.current) terminalError('other', err?.message)
    }
  }

  const terminalError = (kind, message) => {
    if (!sessionActiveRef.current) return
    sessionActiveRef.current = false
    clearTimers()
    setErrorMsg(friendlyError(kind, message))
    callbacksRef.current.onError?.(new Error(friendlyError(kind, message)))
    // Close the native overlay so the friendly card is visible
    VideoPlayerPlugin.closeEmbedded().catch(() => {})
  }

  const adoptDescriptor = (desc) => {
    cfgRef.current = {
      url: desc.streamUrl,
      referer: desc.referer || referer,
      headers: desc.headers || headers,
      container: desc.container || container,
      codec: desc.codec || codec,
    }
  }

  const refreshAndPlay = async (posSec) => {
    if (!onRefresh || !sourceUrl) return false
    /* recovering */
    await VideoPlayerPlugin.showStatus({ text: 'Refreshing link…' }).catch(() => {})
    try {
      const desc = await onRefresh(sourceUrl, title)
      if (!sessionActiveRef.current) return true
      adoptDescriptor(desc)
      await show(cfgRef.current, posSec)
      return true
    } catch (err) {
      if (sessionActiveRef.current) terminalError('expired', err?.message)
      return true
    }
  }

  const recover = async (kind, message) => {
    if (!sessionActiveRef.current) return
    const posSec = stateRef.current.posSec

    // expired → refresh from sourceUrl
    if (kind === 'expired') {
      if (onRefresh && sourceUrl) {
        await refreshAndPlay(posSec)
        return
      }
      terminalError('expired', message)
      return
    }

    // network → retry (backoff) → mirrors → refresh
    if (kind === 'network') {
      if (netRetryRef.current < NETWORK_RETRIES) {
        const attempt = netRetryRef.current
        netRetryRef.current += 1
        /* recovering */
        await VideoPlayerPlugin.showStatus({ text: 'Reconnecting…' }).catch(() => {})
        later(() => show(cfgRef.current, posSec), RETRY_BACKOFF_MS[attempt] || 3000)
        return
      }
      const m = mirrors[mirrorIdxRef.current]
      if (m) {
        mirrorIdxRef.current += 1
        netRetryRef.current = 0
        /* recovering */
        await VideoPlayerPlugin.showStatus({ text: 'Trying another server…' }).catch(() => {})
        await show({ ...cfgRef.current, url: m }, posSec)
        return
      }
      if (onRefresh && sourceUrl) {
        await refreshAndPlay(posSec)
        return
      }
      terminalError('network', message)
      return
    }

    // decode → try a mirror once, else honest failure
    if (kind === 'decode') {
      const m = mirrors[mirrorIdxRef.current]
      if (m) {
        mirrorIdxRef.current += 1
        /* recovering */
        await VideoPlayerPlugin.showStatus({ text: 'Trying another version…' }).catch(() => {})
        await show({ ...cfgRef.current, url: m }, posSec)
        return
      }
      terminalError('decode', message)
      return
    }

    // other → probe to classify precisely, then recurse
    try {
      const probe = await VideoPlayerPlugin.probeStatus({ url: cfgRef.current.url, referer: cfgRef.current.referer })
      if (!sessionActiveRef.current) return
      if (probe.ok) {
        const m = mirrors[mirrorIdxRef.current]
        if (m) {
          mirrorIdxRef.current += 1
          await show({ ...cfgRef.current, url: m }, posSec)
          return
        }
        terminalError('decode', message)
      } else if (probe.status === 403 || probe.status === 404 || probe.status === 410) {
        await recover('expired', message)
      } else {
        await recover('network', message)
      }
    } catch {
      await recover('network', message)
    }
  }

  const handleEvent = async (e) => {
    if (!e || !sessionActiveRef.current) return
    switch (e.state) {
      case 'ready':
        setErrorMsg(null)
        if (!readySentRef.current) {
          readySentRef.current = true
          callbacksRef.current.onReady?.(adapter)
        }
        break
      case 'buffering':
        /* buffering */
        propsRef.current.onProgress?.({
          currentSec: stateRef.current.posSec,
          durationSec: stateRef.current.durSec,
          playing: stateRef.current.playing,
          buffering: true,
          percent: Math.max(1, Math.min(99, e.percent || 0)),
        })
        break
      case 'playing':
        stateRef.current.playing = true
        setErrorMsg(null)
        callbacksRef.current.onPlayerEvent?.({ isPlaying: true, currentTime: stateRef.current.posSec })
        propsRef.current.onProgress?.({
          currentSec: stateRef.current.posSec,
          durationSec: stateRef.current.durSec,
          playing: true,
          buffering: false,
          percent: 0,
        })
        break
      case 'paused':
        stateRef.current.playing = false
        callbacksRef.current.onPlayerEvent?.({ isPlaying: false, currentTime: stateRef.current.posSec })
        propsRef.current.onProgress?.({
          currentSec: stateRef.current.posSec,
          durationSec: stateRef.current.durSec,
          playing: false,
          buffering: false,
          percent: 0,
        })
        break
      case 'ended':
        stateRef.current.ended = true
        stateRef.current.playing = false
        if (!stateRef.current.endedHandled) {
          stateRef.current.endedHandled = true
          callbacksRef.current.onEnded?.()
        }
        break
      case 'error':
        await recover(e.kind || 'other', e.message)
        break
      default:
        break
    }
  }

  // Latest handlers exposed via refs (mount effect registers once)
  const handleEventRef = useRef(handleEvent)
  handleEventRef.current = handleEvent
  const showRef = useRef(show)
  showRef.current = show

  // Adapter for the app's control bar (set once, methods read live refs)
  const apiRef = useRef(null)
  if (!apiRef.current) {
    apiRef.current = {
      getCurrentTime: () => stateRef.current.posSec,
      getDuration: () => stateRef.current.durSec,
      getPlayerState: () => {
        const st = stateRef.current
        if (st.playing) return 1
        if (st.durSec > 0) return 2
        return 0
      },
      isLive: () => Boolean(isLive),
      loadVideoById: () => {},
      playVideo: () => { VideoPlayerPlugin.play().catch(() => {}) },
      pauseVideo: () => { VideoPlayerPlugin.pause().catch(() => {}) },
      seekTo: (value, type = 'seconds') => {
        const dur = stateRef.current.durSec || 0
        const targetSec = type === 'fraction' ? (value * (dur || 0)) : Number(value) || 0
        VideoPlayerPlugin.seekTo({ positionMs: Math.max(0, Math.round(targetSec * 1000)) }).catch(() => {})
      },
    }
  }

  // Keep the parent's adapter ref fresh on every render
  useEffect(() => {
    propsRef.current.onApi?.(apiRef.current)
  })

  // ── Lifecycle: show, measure, poll, close ────────────────────────────
  useEffect(() => {
    let cancelled = false
    let raf = 0
    let poll = null
    let listenerHandle = null

    const measureAndSetRect = () => {
      const el = surfaceRef.current
      if (el && sessionActiveRef.current) {
        try {
          const dpr = window.devicePixelRatio || 1
          const r = el.getBoundingClientRect()

          // Clip the surface to the area above the bottom sheet (chat/queue).
          // The sheet is a fixed-height panel at the bottom of the viewport;
          // the native surface must never cover it — otherwise the panel would
          // render BEHIND the video instead of on top of it.
          let visBottom = r.bottom
          const clipTop = (window.innerHeight || 800) - (clipRef.current || 0)
          if (clipRef.current > 0) visBottom = Math.min(r.bottom, clipTop)
          const hCss = Math.max(0, visBottom - r.top)

          const onScreen = r.bottom > 0 && r.top < (window.innerHeight || 800) && r.width > 0 && hCss > 0
          const shouldShow = visibleRef.current && onScreen
          // Panels/offscreen: hide the native surface so web UI renders above.
          if (!shouldShow) {
            VideoPlayerPlugin.setVisible({ visible: false }).catch(() => {})
          } else {
            VideoPlayerPlugin.setVisible({ visible: true }).catch(() => {})
            // The native surface matches the video box EXACTLY (w × hCss).
            // The app's control bars sit BELOW/OUTSIDE the box, so no height
            // subtraction here — subtracting the bar height is what shifted
            // the video up inside the box with a black gap below it.
            VideoPlayerPlugin.setRect({
              x: Math.round(r.left * dpr),
              y: Math.round(r.top * dpr),
              w: Math.round(r.width * dpr),
              h: Math.max(0, Math.round(hCss * dpr)),
            }).catch(() => {})
          }
        } catch { /* keep last rect */ }
      }
      if (!cancelled) raf = requestAnimationFrame(measureAndSetRect)
    }

    const start = async () => {
      try {
        listenerHandle = await VideoPlayerPlugin.addListener('playbackState', (e) => {
          if (!cancelled) handleEventRef.current?.(e)
        })
        try {
          const tapHandle = await VideoPlayerPlugin.addListener('controlsEvent', (e) => {
            if (!cancelled) {
              if (e?.type === 'tap') propsRef.current.onControlsTap?.({ x: e.x, y: e.y })
              else if (e?.type === 'fullscreenchange') propsRef.current.onFullscreenChange?.(Boolean(e.fullscreen))
            }
          })
          if (tapHandle?.remove) {
            const prevRemove = listenerHandle?.remove
            listenerHandle = { remove: () => { try { tapHandle.remove?.() } catch { /* */ } try { prevRemove?.() } catch { /* */ } } }
          }
        } catch { /* tap relay optional */ }
        await showRef.current(cfgRef.current, stateRef.current.posSec || startSeconds)
        measureAndSetRect()
        poll = setInterval(async () => {
          if (cancelled || !sessionActiveRef.current) return
          try {
            const p = await VideoPlayerPlugin.getPosition()
            if (p && !cancelled) {
              stateRef.current.posSec = (p.positionMs || 0) / 1000
              stateRef.current.durSec = (p.durationMs || 0) / 1000
              propsRef.current.onProgress?.({
                currentSec: stateRef.current.posSec,
                durationSec: stateRef.current.durSec,
                playing: stateRef.current.playing,
                buffering: false,
                percent: 0,
              })
            }
          } catch { /* poll best-effort */ }
        }, 1000)
      } catch (err) {
        if (!cancelled) handleEventRef.current?.({ state: 'error', kind: 'other', message: err?.message || 'Could not start the player' })
      }
    }

    start()

    return () => {
      cancelled = true
      sessionActiveRef.current = false
      clearTimers()
      cancelAnimationFrame(raf)
      if (poll) clearInterval(poll)
      if (listenerHandle) {
        try { listenerHandle.remove?.() } catch { /* */ }
      }
      // Intentional: read the LATEST state at cleanup time (may have changed
      // during the session — e.g. ended fired while mounted).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const endedHandledAtCleanup = stateRef.current.endedHandled
      // Hand the position/end state back to the room (sync + queue)
      VideoPlayerPlugin.closeEmbedded()
        .then((result) => {
          if (!result) return
          const posSec = (result.positionMs || 0) / 1000
          if (result.ended && !endedHandledAtCleanup) {
            if (posSec > 0) callbacksRef.current.onPlayerEvent?.({ isPlaying: false, currentTime: posSec })
            callbacksRef.current.onEnded?.()
          } else if (posSec > 0) {
            callbacksRef.current.onPlayerEvent?.({ isPlaying: false, currentTime: posSec })
          }
        })
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Manual actions on the terminal error card ────────────────────────

  const retryNow = async () => {
    setBusyAction('retry')
    setErrorMsg(null)
    sessionActiveRef.current = true
    try {
      await showRef.current(cfgRef.current, stateRef.current.posSec)
    } catch { /* handled inside show */ } finally {
      setBusyAction(null)
    }
  }

  const reResolveNow = async () => {
    if (!onRefresh || !sourceUrl) return
    setBusyAction('reresolve')
    setErrorMsg(null)
    sessionActiveRef.current = true
    try {
      const desc = await onRefresh(sourceUrl, title)
      adoptDescriptor(desc)
      await showRef.current(cfgRef.current, stateRef.current.posSec)
    } catch (err) {
      terminalError('expired', err?.message)
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className={styles.surface} ref={surfaceRef} data-native-embedded>
      {/* No JS status overlay here: in native mode the video surface covers the
          stage and the app's control bar (driven by onProgress) shows buffering. */}
      {errorMsg && (
        <div className={styles.errorOverlay}>
          <AlertTriangle size={22} />
          <span>{errorMsg}</span>
          <div className={styles.errorActions}>
            <button
              type="button"
              className={styles.reResolveBtn}
              disabled={Boolean(busyAction)}
              onClick={retryNow}
            >
              {busyAction === 'retry' ? 'Retrying…' : <><RefreshCw size={13} /> Retry</>}
            </button>
            {onRefresh && sourceUrl && (
              <button
                type="button"
                className={styles.reResolveBtn}
                disabled={Boolean(busyAction)}
                onClick={reResolveNow}
              >
                {busyAction === 'reresolve' ? 'Resolving…' : 'Re-resolve link'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
