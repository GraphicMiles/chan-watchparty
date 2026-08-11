import { apiPath, parseJsonResponse } from './api.js'
import { normalizePlaybackUrl } from './youtube.js'

/**
 * Map raw server/API validation strings to user-friendly messages.
 * The backend legitimately returns terse dev-facing errors (e.g. "showSlug
 * required") for malformed requests — those must never reach the UI verbatim.
 * Only well-known internal patterns are mapped; genuinely user-meaningful
 * messages (expired links, room full, invite code, etc.) pass through.
 */
export function friendlyApiError(message) {
  const msg = String(message || '')
  if (!msg) return 'Something went wrong — please try again.'
  if (/showSlug required|seasonNum required|episodeNum required|showSlug|Missing show|incomplete show reference/i.test(msg)) {
    return "We couldn't open this show from the search results. Go back and pick it again, or try another result."
  }
  if (/missing roomid|missing token|invalid or expired token|token uid does not match/i.test(msg)) {
    return 'Your session expired — please sign in again and retry.'
  }
  if (/^url required$/i.test(msg) || /a valid url|valid url required/i.test(msg)) {
    return 'A valid link is required for this action.'
  }
  if (/^query required$/i.test(msg)) {
    return 'Please enter a search query.'
  }
  if (/^missing action$/i.test(msg) || /unknown action/i.test(msg) || /unknown layer/i.test(msg) || /invalid action/i.test(msg)) {
    return "We couldn't complete this request — please try again."
  }
  return msg
}

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
    throw new Error(friendlyApiError(data.error) || `Request failed (HTTP ${res.status})`)
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

/**
 * Resolve a DownloadWella/fsmc episode PAGE url to a full stream descriptor
 * (Phase B). Returns the server's descriptor object — the single source of
 * truth for native playback: direct CDN url, headers, container, codec,
 * sourceUrl, mirrors. Throws on expiry/unresolvable pages.
 */
export async function resolveDownloadDescriptor(user, pageUrl, title) {
  const raw = proxyTargetUrl(pageUrl)
  if (!user) throw new Error('Sign in to use media tools')
  if (!/downloadwella\.com|fsmc/i.test(raw)) {
    throw new Error('Not a DownloadWella / fsmc link')
  }
  const data = await mediaPost(user, {
    action: 'nkiriResolve',
    url: raw,
    title: title || 'Chan video',
  })
  const descriptor = data?.descriptor
  if (!descriptor?.streamUrl) {
    throw new Error('Could not resolve a playable link. The download page may be expired — pick the episode again.')
  }
  return descriptor
}

/**
 * Refresh a descriptor from its sourceUrl (fresh token). Same shape as
 * resolveDownloadDescriptor; the server walks the page form again.
 */
export async function refreshDownloadDescriptor(user, sourceUrl, title) {
  const raw = proxyTargetUrl(sourceUrl)
  if (!user) throw new Error('Sign in to use media tools')
  if (!/downloadwella\.com|fsmc/i.test(raw)) {
    throw new Error('Not a DownloadWella / fsmc link')
  }
  const data = await mediaPost(user, {
    action: 'nkiriRefresh',
    url: raw,
    title: title || 'Chan video',
  })
  const descriptor = data?.descriptor
  if (!descriptor?.streamUrl) {
    throw new Error('Could not refresh the link. The download page may be expired — pick the episode again.')
  }
  return descriptor
}
