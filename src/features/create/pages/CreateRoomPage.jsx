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
import { Button, Input, Card, useToast } from '../../../shared/ui/index.js'
import { ShowBrowser } from '../../../shared/components/ShowBrowser.jsx'
import { Link2, ArrowLeft } from 'lucide-react'
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

  // ── Flow state ────────────────────────────────────────────────────────
  const [step, setStep] = useState(1) // 1 = pick content, 2 = room settings
  const [content, setContent] = useState(null)
  const [pasteUrl, setPasteUrl] = useState('')
  const [browserTask, setBrowserTask] = useState(null) // { type:'show', slug, name, thumb }
  const [title, setTitle] = useState(presetTitle)
  const [capacity, setCapacity] = useState(12)
  const [isPrivate, setIsPrivate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)

  const pickContent = useCallback((next) => {
    setContent(next)
    setError(null)
    setTitle((t) => t || (next?.title || ''))
    setStep(2)
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
      const { roomId, inviteCode } = await createRoom(user, {
        title,
        capacity: Number(capacity) || 12,
        isPrivate,
        content,
      })
      toast('Room created', { variant: 'success' })
      navigate(`/room/${roomId}${inviteCode ? `?invite=${inviteCode}` : ''}`)
    } catch (err) {
      console.error('Create room error:', err)
      setError(err.message || 'Could not create room. Please try again.')
      toast(err.message || 'Could not create room', { variant: 'error' })
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
        <h1 className={styles.title}>Start a Room</h1>
        <p className={styles.subtitle}>
          Pick a video, then set up your room — everyone watches in perfect sync.
        </p>

        {/* Progress rail */}
        <div className={styles.rail}>
          <div className={`${styles.railStep} ${step === 1 ? styles.railActive : styles.railDone}`}>
            <span className={styles.railNum}>{step === 1 ? '1' : '✓'}</span>
            <span className={styles.railLabel}>Pick content</span>
          </div>
          <span className={styles.railLine} />
          <div className={`${styles.railStep} ${step === 2 ? styles.railActive : ''}`}>
            <span className={styles.railNum}>2</span>
            <span className={styles.railLabel}>Room settings</span>
          </div>
        </div>

        <div className={step === 1 ? styles.stepPane : styles.stepPaneHidden}>
        {step === 1 && (
          <>
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
          </>
        )}

        <div className={step === 2 ? styles.stepPane : styles.stepPaneHidden}>
        {step === 2 && (
          <>
            {/* Selected content summary */}
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
                <h3 className={styles.pickedTitle}>{content.title || 'Selected video'}</h3>
                {content.source && <span className={styles.pickedSource}>{content.source}</span>}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setContent(null); setStep(1) }}
              >
                Change
              </Button>
            </div>

            <form onSubmit={create} className={styles.form}>
              <Input
                placeholder="Room title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={80}
              />

              <div className={styles.settings}>
                <label className={styles.setting}>
                  <span className={styles.note}>Capacity</span>
                  <Input
                    type="number"
                    min={1}
                    max={12}
                    value={capacity}
                    onChange={(e) => setCapacity(e.target.value)}
                  />
                </label>
                <label className={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={isPrivate}
                    onChange={(e) => setIsPrivate(e.target.checked)}
                  />
                  Private room
                </label>
              </div>

              <Button type="submit" loading={creating} fullWidth disabled={!canCreate} variant="cta">
                Create Room
              </Button>
            </form>

            {error && <p className={styles.error}>{error}</p>}

            <p className={styles.footer}>
              <button type="button" className={styles.cancelLink} onClick={() => setStep(1)}>
                <ArrowLeft size={13} /> Back to content
              </button>
              <span className={styles.footerSep}>·</span>
              <button type="button" className={styles.cancelLink} onClick={goBack}>
                Cancel
              </button>
            </p>
          </>
        )}
        </div>

        {step === 1 && (
          <p className={styles.footer}>
            <button type="button" className={styles.cancelLink} onClick={goBack}>
              Cancel
            </button>
          </p>
        )}
        </div>
      </Card>
    </div>
  )
}
