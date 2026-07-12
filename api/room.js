/**
 * Consolidated room lifecycle endpoint (counts as 1 Vercel function).
 *
 * POST /api/room
 * body: { action: 'join' | 'leave' | 'end', ... }
 *
 * Replaces: joinRoom, leaveRoom, endRoom
 */
import { getDb, FieldValue, verifyIdToken } from './lib/firebaseAdmin.js'
import { preflight, ok, fail, statusForError } from './lib/http.js'

async function requireUser(req, expectedUid) {
  const token = req.headers.authorization?.split('Bearer ')[1]
  if (!token) throw Object.assign(new Error('Missing token'), { status: 401 })
  let decoded
  try {
    decoded = await verifyIdToken(token)
  } catch {
    throw Object.assign(new Error('Invalid or expired token'), { status: 401 })
  }
  if (expectedUid && decoded.uid !== expectedUid) {
    throw Object.assign(new Error('Token uid does not match request uid'), { status: 403 })
  }
  return decoded
}

async function joinRoom(db, body) {
  const { roomId, uid, displayName, inviteCode } = body || {}
  let targetRoomId = roomId

  if (!targetRoomId && inviteCode) {
    const snap = await db
      .collection('rooms')
      .where('inviteCode', '==', String(inviteCode).toUpperCase())
      .where('status', '==', 'live')
      .limit(1)
      .get()
    if (snap.empty) throw new Error('Room not found or invite code invalid')
    targetRoomId = snap.docs[0].id
  }

  if (!targetRoomId || !uid || !displayName) {
    throw new Error('Missing roomId, uid, or displayName')
  }

  const roomRef = db.collection('rooms').doc(targetRoomId)
  const participantRef = roomRef.collection('participants').doc(uid)

  await db.runTransaction(async (t) => {
    const roomSnap = await t.get(roomRef)
    if (!roomSnap.exists) throw new Error('Room not found')
    const room = roomSnap.data()
    if (room.status !== 'live') throw new Error('Room has ended')

    const participantSnap = await t.get(participantRef)
    if (participantSnap.exists) return

    if (room.locked === true && room.hostId !== uid) {
      throw new Error('Room is locked — the host is not accepting new joins')
    }

    if (room.isPrivate === true && room.hostId !== uid) {
      const code = String(inviteCode || '').toUpperCase()
      if (!code || code !== String(room.inviteCode || '').toUpperCase()) {
        throw new Error('Private room — invite code required')
      }
    }

    // Prefer denormalized count; fall back to query if missing.
    let count = typeof room.participantCount === 'number' ? room.participantCount : null
    if (count == null) {
      const participantsSnap = await t.get(roomRef.collection('participants'))
      count = participantsSnap.size
    }
    if (count >= (room.capacity || 12)) {
      throw new Error('Room is full — ask the host to raise capacity')
    }

    t.set(participantRef, {
      displayName,
      role: room.hostId === uid ? 'host' : 'viewer',
      muted: false,
      joinedAt: FieldValue.serverTimestamp(),
    })
    t.update(roomRef, { participantCount: FieldValue.increment(1) })
  })

  return { roomId: targetRoomId }
}

async function leaveRoom(db, body) {
  const { roomId, uid } = body || {}
  if (!roomId || !uid) throw new Error('Missing roomId or uid')

  const roomRef = db.collection('rooms').doc(roomId)
  const participantRef = roomRef.collection('participants').doc(uid)

  await db.runTransaction(async (t) => {
    const roomSnap = await t.get(roomRef)
    if (!roomSnap.exists) throw new Error('Room not found')
    const room = roomSnap.data()
    if (room.status !== 'live') return

    const participantSnap = await t.get(participantRef)
    if (!participantSnap.exists) return

    t.delete(participantRef)
    const next = Math.max(0, (room.participantCount || 1) - 1)
    t.update(roomRef, { participantCount: next })
  })

  return { success: true }
}

async function endRoom(db, body) {
  const { roomId, uid } = body || {}
  if (!roomId || !uid) throw new Error('Missing roomId or uid')

  const roomRef = db.collection('rooms').doc(roomId)
  const snap = await roomRef.get()
  if (!snap.exists) throw new Error('Room not found')
  const room = snap.data()
  if (room.hostId !== uid) throw new Error('Only the host can end the room')

  await roomRef.update({
    status: 'ended',
    activityType: 'idle',
    endedAt: FieldValue.serverTimestamp(),
  })

  return { success: true }
}

export default async function handler(req, res) {
  try {
    if (preflight(req, res, { methods: ['POST'] })) return

    const body = req.body || {}
    const action = String(body.action || '').toLowerCase()
    if (!action) return fail(res, 400, 'Missing action (join | leave | end)')

    await requireUser(req, body.uid)

    const db = getDb()
    let result
    if (action === 'join') result = await joinRoom(db, body)
    else if (action === 'leave') result = await leaveRoom(db, body)
    else if (action === 'end') result = await endRoom(db, body)
    else return fail(res, 400, `Unknown action: ${action}`)

    return ok(res, result)
  } catch (err) {
    console.error('room API error', err)
    return fail(res, statusForError(err), err.message || 'Internal error')
  }
}
