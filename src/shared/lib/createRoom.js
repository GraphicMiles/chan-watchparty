import { doc, setDoc, deleteDoc, serverTimestamp, collection } from 'firebase/firestore'
import { db } from './firebase.js'
import { apiPath, parseJsonResponse } from './api.js'
import { isDirectVideoUrl, normalizePlaybackUrl, checkEmbeddable } from './youtube.js'
import { proxyTargetUrl, isDownloadPageUrl, fetchTitleSynopsis } from './mediaApi.js'
import { sanitizeSynopsis } from './synopsis.js'
import { resolvePlaybackForUser } from './resolvePlayback.js'

export function isO2TvUrl(value) {
  return /tvshows4mobile\.org|o2tvseries|o2tv\.org/i.test(String(value || ''))
}

/**
 * Normalized "picked content" contract shared by ShowBrowser, CreateRoomPage,
 * UnifiedSearch and RoomPage's change-video modal (P1 consolidation).
 */
export const CONTENT_TYPES = ['youtube', 'direct', 'iptv', 'sports', 'nsfw']

export function makeInviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

/**
 * Create a Firestore room + playerState for a picked content item, join the
 * host, and return the room id. Mirrors the previous inline create() logic.
 *
 * content: {
 *   kind: 'youtube' | 'direct',
 *   videoId?,          // youtube
 *   url?,              // playable direct/iptv/sports/nsfw url
 *   videoType,         // one of CONTENT_TYPES
 *   title,
 *   thumbnail?,
 *   isLive?,
 *   source?,           // 'o2tv' | 'nkiri' | 'youtube' | 'direct' | ...
 *   meta?,
 * }
 */
export async function createRoom(user, { title, capacity, isPrivate, content }) {
  if (!user) throw new Error('Sign in to create a room')
  const roomTitle = typeof title === 'string' ? title.trim() : ''
  if (!roomTitle) throw new Error('Give the room a title')

  const videoId = content?.kind === 'youtube' ? content.videoId : ''
  let videoUrl = content?.kind === 'direct' ? (content.url || '') : ''
  const videoType = content?.videoType || 'youtube'
  let mediaDescriptor = null
  let pageUrl = ''

  if (videoType === 'youtube' && !videoId) {
    throw new Error('Pick a valid YouTube video')
  }
  if (videoType !== 'youtube') {
    if (!videoUrl) throw new Error('Pick a season and episode first, then create the room')
    if (isO2TvUrl(videoUrl) && !/\/api\/proxy\?/i.test(videoUrl) && !isDirectVideoUrl(videoUrl)) {
      throw new Error('Pick a season and episode first, then create the room')
    }
    if (!isDirectVideoUrl(videoUrl) && !videoUrl.includes('/api/proxy') && !/^https?:\/\//i.test(videoUrl)) {
      throw new Error('Paste a direct video file link (.mp4 / .m3u8 / .mkv) or pick an episode')
    }

    // Always resolve DownloadWella pages at create time (same helper as
    // queue play-now). Already-resolved CDN urls with no page are left as-is.
    const rawVideoUrl = proxyTargetUrl(videoUrl)
    pageUrl = content?.sourceUrl ? proxyTargetUrl(content.sourceUrl) : ''
    if ((pageUrl && /downloadwella\.com|fsmc/i.test(pageUrl)) || isDownloadPageUrl(rawVideoUrl)) {
      const resolved = await resolvePlaybackForUser(user, {
        url: videoUrl,
        sourceUrl: pageUrl || (isDownloadPageUrl(rawVideoUrl) ? rawVideoUrl : null),
        title: content?.title || 'Chan video',
      })
      videoUrl = resolved.videoUrl
      mediaDescriptor = resolved.media
      pageUrl = resolved.sourceUrl || pageUrl
    }

    if (isDownloadPageUrl(videoUrl)) {
      throw new Error('The download link is a page, not a video file — it may be expired. Go back and pick the episode again.')
    }
  }

  if (videoType === 'youtube') {
    const check = await checkEmbeddable(videoId)
    if (!check.embeddable) {
      throw new Error(check.reason || 'This YouTube video cannot be embedded in Chan. Choose a different video.')
    }
  }

  const roomId = doc(collection(db, 'rooms')).id
  const inviteCode = isPrivate ? makeInviteCode() : ''

  const roomData = {
    hostId: user.uid,
    hostName: user.displayName || 'Host',
    title: roomTitle,
    activityType: videoType === 'youtube' ? 'youtube' : videoType,
    isPrivate,
    inviteCode,
    coHosts: [],
    locked: false,
    capacity: Math.min(Math.max(Number(capacity) || 12, 1), 12),
    participantCount: 0,
    status: 'live',
    createdAt: serverTimestamp(),
    lastHeartbeat: serverTimestamp(),
  }

  // Persist only a real blurb. Short/junk strings stay off the room so
  // RoomPage doesn't render "Episode 1" as the synopsis.
  const synopsis = sanitizeSynopsis(content?.synopsis)
  if (synopsis) roomData.synopsis = synopsis

  if (videoType === 'youtube' && videoId) {
    roomData.videoId = videoId
    roomData.videoType = 'youtube'
  } else if (videoUrl) {
    roomData.videoUrl = videoUrl
    roomData.videoType = videoType
    roomData.activityType = videoType
    const streamType = videoType
    if (streamType === 'iptv' || streamType === 'sports') {
      roomData.isLive = true
    } else if (content?.isLive && streamType !== 'nsfw' && streamType !== 'direct') {
      roomData.isLive = true
    } else {
      roomData.isLive = false
    }
    if (content?.thumbnail) roomData.thumbnail = content.thumbnail
    if (mediaDescriptor && mediaDescriptor.streamUrl) {
      roomData.media = {
        streamUrl: mediaDescriptor.streamUrl,
        referer: mediaDescriptor.referer || 'https://downloadwella.com/',
        headers: mediaDescriptor.headers || null,
        container: mediaDescriptor.container || null,
        codec: mediaDescriptor.codec || null,
        sourceUrl: mediaDescriptor.sourceUrl || pageUrl || null,
        mirrors: Array.isArray(mediaDescriptor.mirrors) ? mediaDescriptor.mirrors : [],
        sizeBytes: mediaDescriptor.sizeBytes || null,
        probe: mediaDescriptor.probe || null,
        resolvedAt: mediaDescriptor.resolvedAt || null,
      }
      roomData.videoUrl = normalizePlaybackUrl(mediaDescriptor.streamUrl)
    } else if (content?.sourceUrl && /downloadwella\.com|fsmc/i.test(proxyTargetUrl(content.sourceUrl))) {
      roomData.sourceUrl = proxyTargetUrl(content.sourceUrl)
    }
  }

  roomData.participantCount = 1

  await setDoc(doc(db, 'rooms', roomId), roomData)

  const playerState = {
    isPlaying: false,
    currentTime: 0,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  }
  if (videoId) playerState.videoId = videoId
  if (videoUrl) playerState.videoUrl = videoUrl

  await setDoc(doc(db, 'rooms', roomId, 'playerState', 'current'), playerState)

  const joinToken = await user.getIdToken()
  let joinOk = false
  let lastJoinError = null
  for (let attempt = 0; attempt < 3 && !joinOk; attempt += 1) {
    try {
      const joinRes = await fetch(apiPath('/api/room'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${joinToken}`,
        },
        body: JSON.stringify({
          action: 'join',
          roomId,
          uid: user.uid,
          displayName: user.displayName || 'Host',
          inviteCode: inviteCode || undefined,
        }),
      })
      const joinData = await parseJsonResponse(joinRes)
      if (!joinRes.ok) {
        lastJoinError = new Error(joinData.error || 'Could not add host to room')
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
        continue
      }
      joinOk = true
    } catch (err) {
      lastJoinError = err
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
    }
  }
  if (!joinOk) {
    try {
      await deleteDoc(doc(db, 'rooms', roomId, 'playerState', 'current')).catch(() => {})
      await deleteDoc(doc(db, 'rooms', roomId)).catch(() => {})
    } catch {
      /* best-effort cleanup */
    }
    throw lastJoinError || new Error('Could not add host to room')
  }

  return { roomId, inviteCode }
}
