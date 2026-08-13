import { isDirectVideoUrl, normalizePlaybackUrl } from './youtube.js'
import {
  proxyTargetUrl,
  isDownloadPageUrl,
  resolveDownloadDescriptor,
} from './mediaApi.js'

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
  return {
    streamUrl: descriptor.streamUrl,
    referer: descriptor.referer || 'https://downloadwella.com/',
    headers: descriptor.headers || null,
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
export async function resolvePlaybackForUser(user, item = {}) {
  const title = item.title || item.label || 'Chan video'
  const page = pickSourceUrl(item)
  const rawUrl = proxyTargetUrl(item.videoUrl || item.url || item.link || '')

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

  if (!rawUrl) {
    throw new Error('This item has no playable link')
  }

  if (isDownloadPageUrl(rawUrl)) {
    throw new Error('This is a download page, not a video file. Pick the episode again.')
  }

  if (!isDirectVideoUrl(rawUrl) && !/^https?:\/\//i.test(rawUrl) && !/\/api\/proxy\?/i.test(rawUrl)) {
    throw new Error('Paste a valid YouTube URL or a direct video link (.mp4, .mkv, etc.)')
  }

  return {
    videoUrl: normalizePlaybackUrl(rawUrl),
    sourceUrl: null,
    media: null,
    isM3u8: /\.m3u8(\?|#|$)/i.test(rawUrl),
  }
}
