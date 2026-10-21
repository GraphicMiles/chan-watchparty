import { getMessagingClient } from './firebaseAdmin.js'
import { sanitizeDisplayName } from './sanitize.js'

const CHANNEL_ID = 'room-activity'
const STALE_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
])

function cleanNotificationText(value, maxLength, fallback) {
  return sanitizeDisplayName(String(value || ''), maxLength) || fallback
}

function stringData(data = {}) {
  const out = {}
  for (const [key, value] of Object.entries(data)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || value == null) continue
    out[key] = String(value).slice(0, 1024)
  }
  return out
}

export async function sendPushToUser(db, uid, payload = {}) {
  if (!db || !uid) return { sent: 0, pruned: 0 }

  const snap = await db
    .collection('users')
    .doc(uid)
    .collection('pushDevices')
    .where('enabled', '==', true)
    .limit(25)
    .get()

  const refsByToken = new Map()
  snap.docs.forEach((docSnap) => {
    const token = String(docSnap.data()?.token || '').trim()
    if (!token) return
    if (!refsByToken.has(token)) refsByToken.set(token, [])
    refsByToken.get(token).push(docSnap.ref)
  })
  const tokens = [...refsByToken.keys()]
  if (!tokens.length) return { sent: 0, pruned: 0 }

  const data = stringData(payload.data)
  const title = cleanNotificationText(payload.title, 80, 'Chan')
  const body = cleanNotificationText(payload.body, 240, 'You have a new room update')
  const result = await getMessagingClient().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data,
    android: {
      priority: 'high',
      ttl: 60 * 60 * 1000,
      notification: {
        channelId: CHANNEL_ID,
        sound: 'default',
        tag: data.roomId || undefined,
      },
    },
  })

  const staleRefs = []
  result.responses.forEach((response, index) => {
    if (!response.success && STALE_TOKEN_CODES.has(response.error?.code)) {
      staleRefs.push(...(refsByToken.get(tokens[index]) || []))
    }
  })

  if (staleRefs.length) {
    const batch = db.batch()
    staleRefs.forEach((ref) => batch.delete(ref))
    await batch.commit().catch(() => {})
  }

  return { sent: result.successCount || 0, pruned: staleRefs.length }
}

export async function notifyRoomJoined(db, event = {}) {
  const hostId = String(event.hostId || '')
  const roomId = String(event.roomId || '')
  if (!hostId || !roomId || hostId === String(event.joinerUid || '')) {
    return { sent: 0, pruned: 0 }
  }

  const roomTitle = cleanNotificationText(event.roomTitle, 70, 'your room')
  const joinerName = cleanNotificationText(event.joinerName, 40, 'Someone')
  return sendPushToUser(db, hostId, {
    title: 'Someone joined your room',
    body: `${joinerName} joined ${roomTitle}`,
    data: {
      type: 'room_join',
      roomId,
      path: `/room/${roomId}`,
    },
  })
}
