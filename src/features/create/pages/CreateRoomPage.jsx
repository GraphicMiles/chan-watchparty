import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, Link, useSearchParams, useLocation } from 'react-router-dom'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'
import {
  extractVideoId,
  isDirectVideoUrl,
  normalizePlaybackUrl,
} from '../../../shared/lib/youtube.js'
import { createRoom } from '../../../shared/lib/createRoom.js'
import { isSuitableThumbnail } from '../../../shared/lib/mediaHelper.js'
import { cleanMediaTitle } from '../../../shared/lib/titleFormat.js'
import { friendlyApiError } from '../../../shared/lib/mediaApi.js'
import { sanitizeSynopsis } from '../../../shared/lib/synopsis.js'
import { Button, Card, useToast } from '../../../shared/ui/index.js'
import { Link2, Compass } from 'lucide-react'
import styles from './CreateRoomPage.module.css'

function parseShowSlugFromUrl(value) {
  try {
    const u = new URL(value)
    if (!/tvshows4mobile\.org|o2tvseries|o2tv\.org/i.test(u.href)) return null
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
 * Create Room — single-step (mockup structure).
 * The picker lives in the Media Browser; this page only sets up the room.
 *   - Arrives with ?video / ?videoUrl presets from the Media Browser → the
 *     media card + settings are shown immediately.
 *   - Arrives with nothing (deep link / home) → empty state → "Browse media".
 *   - "Change" goes back to the Media Browser.
 */
export default function CreateRoomPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { toast } = useToast()

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
  // Query-string synopsis is a fallback for deep links. The Media Browser
  // also passes the full blurb via location.state so long text isn't lost
  // when videoUrl + thumbnail already saturate the URL.
  const presetSynopsis = sanitizeSynopsis(
    location.state?.synopsis || location.state?.content?.synopsis || searchParams.get('synopsis') || ''
  )

  // ── State ───────────────────────────────────────────────────────────────
  const [content, setContent] = useState(null) // picked content (from presets)
  // Custom room title override. Starts EMPTY on purpose — the picked content's
  // title is the default, shown as the input placeholder, so we never render
  // the same title twice (once in the media card, once in the field).
  const [title, setTitle] = useState('')
  const [capacity, setCapacity] = useState(12)
  const [isPrivate, setIsPrivate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)

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
        synopsis: presetSynopsis || undefined,
      })
      return
    }
    // DownloadWella / fsmc PAGE links (picked TV-show episodes) are not
    // direct video URLs — they're resolved to a FRESH token at create time.
    const isDwPage = /downloadwella\.com|fsmc/i.test(presetVideoUrl) && !isDirectVideoUrl(presetVideoUrl)
    if (isDirectVideoUrl(presetVideoUrl) || /\/api\/proxy\?/i.test(presetVideoUrl) || isDwPage) {
      const isM3u8 = /\.m3u8(\?|#|$)/i.test(presetVideoUrl)
      const streamType = ['iptv', 'sports', 'nsfw'].includes(presetType) ? presetType : (isM3u8 ? 'iptv' : 'direct')
      pickContent({
        kind: 'direct',
        url: normalizePlaybackUrl(presetVideoUrl),
        title: presetTitle || 'Direct video',
        thumbnail: presetThumb,
        videoType: streamType,
        isLive: presetIsLive,
        // DownloadWella pages expire fast — keep the page URL so createRoom
        // walks the form for a fresh CDN token instead of a dead one.
        sourceUrl: presetSourceUrl || (isDwPage ? presetVideoUrl : undefined),
        pendingResolve: isDwPage,
        synopsis: presetSynopsis || undefined,
      })
      return
    }
    // O2TV show page / slug → the picker (seasons) lives in the Media
    // Browser's Direct layer now — hand off there instead of embedding a
    // second browser here.
    const slug = presetShowSlug || parseShowSlugFromUrl(presetVideoUrl)
    if (slug) {
      const q = presetShowName || presetTitle || slug
      navigate(`/media?layer=direct&q=${encodeURIComponent(q)}`, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]) // run once per user/preset — presets come from navigation

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
        content: { ...content, synopsis: content?.synopsis || presetSynopsis || null },
      })
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

  const browseMedia = () => navigate('/media', { state: { from: location.pathname } })

  return (
    <div className={styles.page}>
      <Card className={styles.card}>
        <h1 className={styles.title}>New room</h1>
        <p className={styles.subtitle}>
          Pick something to watch in the Media Browser, then set up the room here — everyone syncs instantly.
        </p>

        {!content ? (
          /* No content yet (deep link / home) — route to the picker */
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <Compass size={26} />
            </div>
            <h2 className={styles.emptyTitle}>Pick something to watch</h2>
            <p className={styles.emptyText}>
              Browse the Media Browser for a YouTube video, a live channel, a sports match, or a TV show — then come back here to start the room.
            </p>
            <Button type="button" variant="cta" onClick={browseMedia}>
              Browse media
            </Button>
          </div>
        ) : (
          /* Create panel — media card + grouped settings + CTA (the only form) */
          <div className={styles.pane}>
            {/* Media preview card — thumb + color-coded source chip + title + Change */}
            <div className={styles.mediaCard}>
              <div className={styles.mediaThumb}>
                {(content.thumbnail || (content.kind === 'youtube' && content.videoId)) ? (
                  <img
                    src={content.thumbnail}
                    alt=""
                    onError={(e) => { e.currentTarget.style.display = 'none' }}
                  />
                ) : (
                  <Link2 size={20} style={{ color: 'var(--text-muted-grey)' }} />
                )}
              </div>
              <div className={styles.mediaInfo}>
                <span
                  className={styles.sourceChip}
                  data-source={String(content.videoType || 'direct').toLowerCase()}
                >
                  {content.kind === 'youtube' ? '▶ YouTube' : contentLabel}
                </span>
                <h3 className={styles.mediaTitle}>{cleanMediaTitle(content.title) || 'Selected video'}</h3>
                {sanitizeSynopsis(content.synopsis) && (
                  <p className={styles.mediaSynopsis}>{sanitizeSynopsis(content.synopsis)}</p>
                )}
              </div>
              <button type="button" className={styles.changeBtn} onClick={browseMedia}>
                Change
              </button>
            </div>

            {/* Settings — one grouped card with dividers */}
            <div className={styles.settingsCard}>
              <form onSubmit={create}>
                <div className={styles.settingRow}>
                  <span className={styles.settingLabel}>Room title</span>
                  <input
                    type="text"
                    className={styles.titleInput}
                    placeholder={content?.title ? `Defaults to "${cleanMediaTitle(content.title)}"` : 'Room title'}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={80}
                  />
                </div>

                <div className={styles.settingRow}>
                  <span className={styles.settingLabel}>Capacity</span>
                  <div className={styles.stepper}>
                    <button
                      type="button"
                      className={styles.stepBtn}
                      aria-label="Decrease capacity"
                      onClick={() => setCapacity((c) => Math.max(1, Number(c) - 1))}
                    >
                      –
                    </button>
                    <span className={styles.capacityValue}>{capacity}</span>
                    <button
                      type="button"
                      className={styles.stepBtn}
                      aria-label="Increase capacity"
                      onClick={() => setCapacity((c) => Math.min(12, Number(c) + 1))}
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className={styles.settingRow}>
                  <span className={styles.settingLabel}>Private room</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isPrivate}
                    className={`${styles.switch} ${isPrivate ? styles.switchOn : ''}`}
                    onClick={() => setIsPrivate((v) => !v)}
                  >
                    <span className={styles.switchKnob} />
                  </button>
                </div>

                {/* CTA row — Create + Cancel side by side */}
                <div className={styles.ctaRow}>
                  <Button type="submit" loading={creating} disabled={!canCreate} variant="cta" className={styles.cta}>
                    Create room
                  </Button>
                  <button type="button" className={styles.cancelBtn} onClick={goBack}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>

            {error && <p className={styles.error}>{error}</p>}
          </div>
        )}
      </Card>
    </div>
  )
}
