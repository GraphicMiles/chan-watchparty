import { isDirectVideoUrl, normalizePlaybackUrl } from './youtube.js'
import {
  proxyTargetUrl,
  isDownloadPageUrl,
  resolveDownloadDescriptor,
  mediaPost,
} from './mediaApi.js'

const PLAYBACK_UA = 'Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'

/**
 * Single Referer rule for native + proxy + Firestore media:
 *  - DownloadWella/fsmc FILE, or a stream we got by walking a Wella PAGE
 *    → Referer https://downloadwella.com/  (even if the CDN host is nkiserv)
 *  - Bare nkiserv / thenkiri file (no Wella page) → UA only, no Referer
 *  - Never send Referer: thenkiri.com on a file request (403s nkiserv)
 */
export function playbackAccess(streamUrl, media = null) {
  const stream = proxyTargetUrl(streamUrl || media?.streamUrl || '') || streamUrl || null
  const page = media?.sourceUrl || null
  const walkedWella = Boolean(page && isDownloadPageUrl(page))
  const streamWella = Boolean(stream && /downloadwella|fsmc/i.test(stream))
  const referer = (walkedWella || streamWella)
    ? (media?.referer && /downloadwella|fsmc/i.test(media.referer)
      ? media.referer
      : 'https://downloadwella.com/')
    : null
  const headers = { 'User-Agent': PLAYBACK_UA }
  if (referer) headers.Referer = referer
  return { streamUrl: stream, referer, headers }
}

/** Headers the native engine needs for Nkiri/DownloadWella CDNs. */
export function mediaStubForCdn(rawUrl, sourceUrl = null) {
  const streamUrl = proxyTargetUrl(rawUrl) || rawUrl
  if (!streamUrl || isDownloadPageUrl(streamUrl) || isNkiriHtmlPage(streamUrl)) return null
  const access = playbackAccess(streamUrl, { sourceUrl, referer: null })
  return {
    streamUrl,
    referer: access.referer,
    headers: access.headers,
    sourceUrl: sourceUrl || null,
    container: /\.mkv(\?|#|$)/i.test(streamUrl) ? 'mkv' : (/\.mp4(\?|#|$)/i.test(streamUrl) ? 'mp4' : null),
    codec: null,
    mirrors: [],
    sizeBytes: null,
    probe: null,
    resolvedAt: Date.now(),
  }
}

function isNkiriHtmlPage(url) {
  const raw = proxyTargetUrl(url)
  if (!raw || typeof raw !== 'string') return false
  if (!/thenkiri\.com|nkiri\.com/i.test(raw)) return false
  return !isDirectVideoUrl(raw)
}

/**
 * Shared playback resolve — same contract as createRoom.
 *
 * Queue stores the episode PAGE (sourceUrl) and optionally a last CDN
 * (videoUrl). Play-now / change-video ALWAYS walk the page for a fresh
 * token when sourceUrl is a DownloadWella/fsmc page. Never write an HTML
 * page into room.videoUrl (proxy then returns "web page instead of video").
 */

export function pickSourceUrl(item = {}) {
  const candidates = [
    item.sourceUrl,
    item.media?.sourceUrl,
    item.url,
    item.link,
    item.videoUrl,
  ]
  for (const c of candidates) {
    const raw = proxyTargetUrl(c)
    if (raw && isDownloadPageUrl(raw)) return raw
  }
  return null
}

export function mediaDocFromDescriptor(descriptor, fallbackSourceUrl = null) {
  if (!descriptor?.streamUrl) return null
  const stream = descriptor.streamUrl
  const sourceUrl = descriptor.sourceUrl || fallbackSourceUrl || null
  const access = playbackAccess(stream, { sourceUrl, referer: descriptor.referer || null })
  return {
    streamUrl: stream,
    referer: access.referer,
    headers: access.headers,
    container: descriptor.container || null,
    codec: descriptor.codec || null,
    sourceUrl: descriptor.sourceUrl || fallbackSourceUrl || null,
    mirrors: Array.isArray(descriptor.mirrors) ? descriptor.mirrors : [],
    sizeBytes: descriptor.sizeBytes || null,
    probe: descriptor.probe || null,
    resolvedAt: descriptor.resolvedAt || null,
  }
}

/**
 * Resolve a pick / queue item into something the room can play.
 *
 * @returns {{
 *   videoUrl: string,
 *   sourceUrl: string|null,
 *   media: object|null,
 *   isM3u8: boolean,
 * }}
 */
export async function resolvePlaybackForUser(user, item = {}, depth = 0) {
  if (depth > 2) {
    throw new Error('Could not resolve a playable link — pick the episode again.')
  }
  const title = item.title || item.label || 'Chan video'
  const page = pickSourceUrl(item)
  const rawUrl = proxyTargetUrl(item.videoUrl || item.url || item.link || '')
  const alreadyFile = Boolean(rawUrl && isDirectVideoUrl(rawUrl))

  if (page && user) {
    const descriptor = await resolveDownloadDescriptor(user, page, title)
    const media = mediaDocFromDescriptor(descriptor, page)
    const videoUrl = normalizePlaybackUrl(descriptor.streamUrl)
    if (isDownloadPageUrl(videoUrl)) {
      throw new Error('Could not resolve a playable link — pick the episode again.')
    }
    return {
      videoUrl,
      sourceUrl: page,
      media,
      isM3u8: /\.m3u8(\?|#|$)/i.test(descriptor.streamUrl || ''),
    }
  }

  // Nkiri/thenkiri HTML is a listing page, not a file. Scrape it, then
  // resolve the first downloadwella/direct hit — never proxy the HTML.
  // Skip if we already have the episode file (sourceUrl may be the SHOW page
  // used only as Referer — scraping it again would pick the wrong episode).
  const nkiriPage = !alreadyFile
    ? [item.sourceUrl, item.url, item.link, item.videoUrl].find(isNkiriHtmlPage)
    : null
  if (nkiriPage && user) {
    const data = await mediaPost(user, { action: 'scrape', url: nkiriPage, options: { resolve: true }, title })
    const list = data.results || []
    const best = list.find((r) => r && (r.isDirect || r.playableInRoom || r.isDirectMedia || isDirectVideoUrl(r.url || r.link)))
      || list.find((r) => r && (isDownloadPageUrl(r.url || r.link) || /downloadwella\.com|fsmc/i.test(r.url || r.link || '')))
      || list[0]
    if (!best?.url && !best?.link) {
      throw new Error('Could not resolve a playable link for this title. Pick the episode again.')
    }
    const hit = best.url || best.link
    return resolvePlaybackForUser(user, {
      title,
      url: hit,
      sourceUrl: isDownloadPageUrl(hit) ? proxyTargetUrl(hit) : null,
      videoUrl: isDirectVideoUrl(hit) ? hit : null,
    }, depth + 1)
  }

  if (!rawUrl) {
    throw new Error('This item has no playable link')
  }

  if (isDownloadPageUrl(rawUrl)) {
    throw new Error('This is a download page, not a video file. Pick the episode again.')
  }

  if (!isDirectVideoUrl(rawUrl) && !/^https?:\/\//i.test(rawUrl) && !/\/api\/proxy\?/i.test(rawUrl)) {
    throw new Error('Paste a valid YouTube URL or a direct video link (.mp4, .mkv, etc.)')
  }

  // Last-resort guard: never hand an HTML listing to the proxy.
  if (isNkiriHtmlPage(rawUrl)) {
    throw new Error('Could not resolve a playable link — pick the episode again.')
  }

  return {
    videoUrl: normalizePlaybackUrl(rawUrl),
    sourceUrl: item.sourceUrl || null,
    media: mediaStubForCdn(rawUrl, item.sourceUrl),
    isM3u8: /\.m3u8(\?|#|$)/i.test(rawUrl),
  }
}
