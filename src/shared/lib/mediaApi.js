import { apiPath, parseJsonResponse } from './api.js'
import { normalizePlaybackUrl } from './youtube.js'

/**
 * Shared authenticated POST to /api/media.
 * Used by ShowBrowser, CreateRoomPage, UnifiedSearch and RoomPage so there is
 * exactly one way to talk to the media API (P1 consolidation).
 */
export async function mediaPost(user, body) {
  if (!user) throw new Error('Sign in to use media tools')
  const token = await user.getIdToken()
  const res = await fetch(apiPath('/api/media'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const data = await parseJsonResponse(res)
  if (!res.ok || data.success === false) {
    throw new Error(data.error || `Request failed (HTTP ${res.status})`)
  }
  return data
}

/** If url is a /api/proxy?url=... wrapper, return the decoded inner target; else url. */
export function proxyTargetUrl(url) {
  if (!url || typeof url !== 'string') return url
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://chan.invalid')
    if (u.pathname.startsWith('/api/proxy')) {
      const target = u.searchParams.get('url')
      if (target) return decodeURIComponent(target)
    }
  } catch { /* keep original */ }
  return url
}

/** True if the URL is a DownloadWella/fsmc *page* (HTML), not a media file. */
export function isDownloadPageUrl(url) {
  const raw = proxyTargetUrl(url)
  if (!raw) return false
  if (!/downloadwella\.com|fsmc/i.test(raw)) return false
  // A page: .html/.htm suffix, or no media extension at all
  if (/\.(html?|php)(\?|#|$)/i.test(raw)) return true
  return !/\.(mp4|m3u8|mkv|webm|mov|avi|flv|ts)(\?|#|$)/i.test(raw)
}

/**
 * Resolve a DownloadWella/fsmc page URL to a playable stream.
 * Uses the dedicated nkiriResolve action (form-walk to the real CDN file),
 * falls back to generic scrape, and validates the result is not an HTML page.
 * Returns the normalized (proxy-wrapped) playback URL.
 */
export async function resolveDownloadLink(user, pageUrl, title) {
  const raw = proxyTargetUrl(pageUrl)
  if (!user) throw new Error('Sign in to use media tools')
  if (!/downloadwella\.com|fsmc/i.test(raw)) {
    throw new Error('Not a DownloadWella / fsmc link')
  }

  let data
  try {
    data = await mediaPost(user, { action: 'nkiriResolve', url: raw, title: title || 'Chan video' })
  } catch (err) {
    // Fall back to generic scrape for hosts nkiriResolve doesn't know
    data = await mediaPost(user, { action: 'scrape', url: raw, options: { resolve: true } })
  }

  const list = data.results || []
  const candidates = list.filter((r) => r && !isDownloadPageUrl(r.url || r.link || ''))
  const best = candidates.find((r) => r.isDirect || r.playableInRoom || /\/api\/proxy\?/i.test(r.url || r.link || ''))
    || candidates[0]
    || list.find((r) => r && (r.isDirect || r.playableInRoom))

  if (!best?.url && !best?.link) {
    if (data.expired) {
      throw new Error('The download link expired. Go back and pick the episode again.')
    }
    throw new Error('Could not resolve a playable link for this episode. Try another episode or source.')
  }

  const playUrl = normalizePlaybackUrl(best.url || best.link)
  if (isDownloadPageUrl(playUrl)) {
    throw new Error('Could not resolve a playable link — the download page is no longer valid. Pick the episode again.')
  }
  return playUrl
}
