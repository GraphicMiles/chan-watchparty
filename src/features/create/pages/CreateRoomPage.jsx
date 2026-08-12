import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, Link, useSearchParams, useLocation } from 'react-router-dom'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'
import {
  extractVideoId,
  isDirectVideoUrl,
  normalizePlaybackUrl,
} from '../../../shared/lib/youtube.js'
import { createRoom, isO2TvUrl } from '../../../shared/lib/createRoom.js'
import { isSuitableThumbnail } from '../../../shared/lib/mediaHelper.js'
import { cleanMediaTitle } from '../../../shared/lib/titleFormat.js'
import { friendlyApiError } from '../../../shared/lib/mediaApi.js'
import { Button, Input, Card, useToast } from '../../../shared/ui/index.js'
import { ShowBrowser } from '../../../shared/components/ShowBrowser.jsx'
import { db } from '../../../shared/lib/firebase.js'
import { API_URL } from '../../../shared/lib/api.js'
import { isNativeRoomSupported, launchNativeRoom } from '../../room/nativeRoomBridge.js'
import { Link2 } from 'lucide-react'
import styles from './CreateRoomPage.module.css'

function parseShowSlugFromUrl(value) {
  try {
    const u = new URL(value)
    if (!isO2TvUrl(u.href)) return null
    if (/o2tv\.org/i.test(u.hostname)) return null
    const parts = u.pathname.split('/').filter(Boolean)
    return parts[0] || null
  } catch {
    return null
  }
}

function safeThumb(url) {
  return isSuitableThumbnail(url) ? url : null
}

function videoTypeLabel(content) {
  if (!content) return ''
  if (content.kind === 'youtube') return 'YouTube'
  switch (content.videoType) {
    case 'iptv': return 'Live TV (IPTV)'
    case 'sports': return 'Live Sports'
    case 'nsfw': return 'Direct video'
    default: return 'Direct video'
  }
}

/**
 * Create Room — P1 restructure.
 * One guided flow with a progress rail:
 *   1. Pick content (paste link | ShowBrowser: TV shows / YouTube)
 *   2. Room settings → Create
 * Deep links from /media drop the user at step 2 with content pre-picked.
 */
export default function CreateRoomPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { toast } = useToast()
  const browserRef = useRef(null)

  const presetVideo = searchParams.get('video') || ''
  const presetVideoUrl = searchParams.get('videoUrl') || ''
  const presetTitle = searchParams.get('title') || ''
  const presetType = searchParams.get('type') || 'youtube'
  const presetThumb = safeThumb(searchParams.get('thumbnail') || '')
  const presetShowSlug = searchParams.get('showSlug') || ''
  const presetShowName = searchParams.get('showName') || ''
  const presetIsLive = searchParams.get('isLive') === 'true' || presetType === 'iptv' || presetType === 'sports'
  // Original episode page URL (DownloadWella etc.) — kept so re-resolve can
  // regenerate a fresh CDN token instead of echoing a dead one.
  const presetSourceUrl = searchParams.get('sourceUrl') || ''

  // ── Flow state ────────────────────────────────────────────────────────
  const [content, setContent] = useState(null) // picked content OR null = browsing
  const [pasteUrl, setPasteUrl] = useState('')
  const [browserTask, setBrowserTask] = useState(null) // { type:'show', slug, name, thumb }
  // Custom room title override. Starts EMPTY on purpose — the picked content's
  // title is the default, shown as the input placeholder, so we never render
  // the same title twice (once in the picked card, once in the field).
  const [title, setTitle] = useState('')
  const [capacity, setCapacity] = useState(12)
  const [isPrivate, setIsPrivate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)

  // Single-step flow (mockup): picking content shows the create panel
  // (summary + settings + CTA) on the same screen. "Change" returns to browse.
  const pickContent = useCallback((next) => {
    setContent(next)
    setError(null)
    // Keep a custom title the user already typed; never clobber it with the
    // picked title (that created the duplicate-title display).
  }, [])

  // ── Bootstrap from /media hand-off / deep link ───────────────────────
  useEffect(() => {
    if (!user) return
    // ?video=ID&type=youtube deep link (YouTube pick)
    if (presetVideo && !presetVideoUrl) {
      pickContent({
        kind: 'youtube',
        videoId: presetVideo,
        url: `https://youtube.com/watch?v=${presetVideo}`,
        title: presetTitle || 'YouTube video',
        thumbnail: presetThumb,
        videoType: 'youtube',
      })
      return
    }
    if (!presetVideoUrl) return
    const id = extractVideoId(presetVideoUrl)
    if (id) {
      pickContent({
        kind: 'youtube',
        videoId: id,
        url: `https://youtube.com/watch?v=${id}`,
        title: presetTitle || 'YouTube video',
        thumbnail: presetThumb,
        videoType: 'youtube',
      })
      return
    }
    if (isDirectVideoUrl(presetVideoUrl) || /\/api\/proxy\?/i.test(presetVideoUrl)) {
      const isM3u8 = /\.m3u8(\?|#|$)/i.test(presetVideoUrl)
      const streamType = ['iptv', 'sports', 'nsfw'].includes(presetType) ? presetType : (isM3u8 ? 'iptv' : 'direct')
      pickContent({
        kind: 'direct',
        url: normalizePlaybackUrl(presetVideoUrl),
        title: presetTitle || 'Direct video',
        thumbnail: presetThumb,
        videoType: streamType,
        isLive: presetIsLive,
        sourceUrl: presetSourceUrl || undefined,
      })
      return
    }
    // O2TV show page / slug → open the browser at seasons (step 1)
    const slug = presetShowSlug || parseShowSlugFromUrl(presetVideoUrl)
    if (slug) {
      setBrowserTask({ type: 'show', slug, name: presetShowName || presetTitle || 'TV Show', thumb: presetThumb })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]) // run once per user/preset — presets come from navigation

  useEffect(() => {
    if (!browserTask || !browserRef.current) return
    if (browserTask.type === 'show') {
      browserRef.current.openShowBySlug(browserTask.slug, browserTask.name, browserTask.thumb)
    }
    setBrowserTask(null)
  }, [browserTask])


  // ── Paste-link handling ───────────────────────────────────────────────
  const usePastedLink = async (e) => {
    e?.preventDefault()
    const value = String(pasteUrl || '').trim()
    if (!value) return
    const id = extractVideoId(value)
    if (id) {
      pickContent({
        kind: 'youtube',
        videoId: id,
        url: `https://youtube.com/watch?v=${id}`,
        title: presetTitle || 'YouTube video',
        thumbnail: null,
        videoType: 'youtube',
      })
      setPasteUrl('')
      return
    }
    if (isDirectVideoUrl(value)) {
      const isM3u8 = /\.m3u8(\?|#|$)/i.test(value)
      pickContent({
        kind: 'direct',
        url: normalizePlaybackUrl(value),
        title: presetTitle || 'Direct video',
        thumbnail: null,
        videoType: isM3u8 ? 'iptv' : 'direct',
        isLive: isM3u8,
      })
      setPasteUrl('')
      return
    }
    if (isO2TvUrl(value)) {
      const slug = parseShowSlugFromUrl(value)
      if (slug) {
        setPasteUrl('')
        browserRef.current?.openShowBySlug(slug, presetTitle || slug.replace(/-/g, ' '), presetThumb)
        return
      }
    }
    setPasteUrl('')
    browserRef.current?.openPageUrl(value, presetTitle || 'Media page')
  }

  // ── Create room ───────────────────────────────────────────────────────
  const create = async (e) => {
    e.preventDefault()
    setError(null)
    setCreating(true)
    try {
      // Custom title override: fall back to the picked content's title when
      // the user left the field empty (its placeholder already shows it).
      const roomTitle = title.trim() || cleanMediaTitle(content?.title || '') || 'Untitled room'
      const { roomId, inviteCode } = await createRoom(user, {
        title: roomTitle,
        capacity: Number(capacity) || 12,
        isPrivate,
        content,
      })
      // ONE room: on Android, go STRAIGHT to the native room and stay there.
      // The web app sits at home underneath; nothing else happens on this
      // screen. (YouTube content opens the web room — YouTube is web-only.)
      if (isNativeRoomSupported() && content?.kind !== 'youtube') {
        const idToken = await user.getIdToken()
        await launchNativeRoom({
          roomId,
          uid: user.uid,
          displayName: user.displayName || 'Viewer',
          idToken,
          projectId: db.app.options.projectId || '',
          apiKey: db.app.options.apiKey || '',
          apiBase: API_URL || '',
          startSeconds: 0,
        })
        navigate('/', { replace: true })
        return
      }
      toast('Room created', { variant: 'success' })
      navigate(`/room/${roomId}${inviteCode ? `?invite=${inviteCode}` : ''}`)
    } catch (err) {
      console.error('Create room error:', err)
      // Single presentation point: the in-panel banner (visible on the create
      // pane). The toast previously duplicated the same message on screen.
      setError(friendlyApiError(err.message || 'Could not create room. Please try again.'))
      setCreating(false)
    }
  }

  const canCreate = Boolean(content) && (content.kind === 'youtube' ? Boolean(content.videoId) : Boolean(content.url))

  const contentLabel = useMemo(() => videoTypeLabel(content), [content])

  if (!user) return <Link to="/auth">Sign in to create a room</Link>

  const goBack = () => {
    const from = location.state?.from
    if (from) navigate(from)
    else if (window.history.length > 1) navigate(-1)
    else navigate('/media')
  }

  return (
    <div className={styles.page}>
      <Card className={styles.card}>
        <h1 className={styles.title}>New room</h1>
        <p className={styles.subtitle}>
          Search a show, paste a link, or pick something to watch — everyone syncs instantly.
        </p>

        {/* Browse pane — hidden while content is picked (stays mounted so
            browser state survives "Change") */}
        <div className={content ? styles.paneHidden : styles.pane}>
          {/* Paste a link */}
          <form className={styles.pasteRow} onSubmit={usePastedLink}>
            <div className={styles.pasteWrap}>
              <Link2 size={15} className={styles.pasteIcon} />
              <Input
                placeholder="Paste a YouTube, .mp4 / .m3u8 / .mkv or TV-show page link…"
                value={pasteUrl}
                onChange={(e) => setPasteUrl(e.target.value)}
                className={styles.pasteInput}
              />
            </div>
            <Button type="submit" variant="secondary" size="md">Use link</Button>
          </form>

          <div className={styles.divider}>
            <span>or browse</span>
          </div>

          {/* The one browser (TV shows / YouTube) */}
          <ShowBrowser ref={browserRef} onPick={pickContent} />

          {error && <p className={styles.error}>{error}</p>}

          <p className={styles.footer}>
            <button type="button" className={styles.cancelLink} onClick={goBack}>
              Cancel
            </button>
          </p>
        </div>

        {/* Create panel — one step: picked summary + settings + CTA */}
        {content && (
          <div className={styles.pane}>
            <div className={styles.picked}>
              {(content.thumbnail || (content.kind === 'youtube' && content.videoId)) && (
                <img
                  src={content.thumbnail}
                  alt=""
                  className={styles.pickedThumb}
                  onError={(e) => { e.currentTarget.style.display = 'none' }}
                />
              )}
              <div className={styles.pickedInfo}>
                <span className={styles.pickedLabel}>{contentLabel}</span>
                <h3 className={styles.pickedTitle}>{cleanMediaTitle(content.title) || 'Selected video'}</h3>
                {content.source && <span className={styles.pickedSource}>{content.source}</span>}
              </div>
              <button type="button" className={styles.changeLink} onClick={() => { setContent(null); setError(null) }}>
                Change
              </button>
            </div>

            <form onSubmit={create} className={styles.form}>
              <Input
                label="Room title (optional)"
                placeholder={content?.title ? `Defaults to "${cleanMediaTitle(content.title)}"` : 'Room title'}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={80}
              />

              <div className={styles.settingsRow}>
                <span className={styles.settingsLabel}>Capacity</span>
                <div className={styles.stepper}>
                  <button
                    type="button"
                    className={styles.stepperBtn}
                    aria-label="Decrease capacity"
                    onClick={() => setCapacity((c) => Math.max(1, Number(c) - 1))}
                  >
                    –
                  </button>
                  <span className={styles.stepperValue}>{capacity}</span>
                  <button
                    type="button"
                    className={styles.stepperBtn}
                    aria-label="Increase capacity"
                    onClick={() => setCapacity((c) => Math.min(12, Number(c) + 1))}
                  >
                    +
                  </button>
                </div>
              </div>

              <div className={styles.settingsRow}>
                <span className={styles.settingsLabel}>Private room</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isPrivate}
                  className={`${styles.toggle} ${isPrivate ? styles.toggleOn : ''}`}
                  onClick={() => setIsPrivate((v) => !v)}
                >
                  <span className={styles.toggleKnob} />
                </button>
              </div>

              <Button type="submit" loading={creating} fullWidth disabled={!canCreate} variant="cta">
                Create room &amp; start watching
              </Button>
            </form>

            {error && <p className={styles.error}>{error}</p>}

            <p className={styles.footer}>
              <button type="button" className={styles.cancelLink} onClick={goBack}>
                Cancel
              </button>
            </p>
          </div>
        )}
      </Card>
    </div>
  )
}
