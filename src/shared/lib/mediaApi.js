import { apiPath, parseJsonResponse } from './api.js'

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
