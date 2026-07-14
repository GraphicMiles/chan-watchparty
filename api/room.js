/**
 * Consolidated room & moderation lifecycle endpoint (counts as 1 Vercel function).
 *
 * POST /api/room
 * body: { action: 'join' | 'leave' | 'end' | 'kick' | 'promote' | 'mute' | 'livekit' | 'ai' | 'cleanup', ... }
 */
import { getDb, FieldValue, verifyIdToken } from '../server-lib/firebaseAdmin.js'
import { preflight, ok, fail, statusForError, JSON_HEADERS } from '../server-lib/http.js'
import { sendResponse } from '../server-lib/response.js'
import { deleteRoomAndSubcollections, runCleanupStaleRooms } from '../server-lib/roomCleanup.js'
import { kickParticipant, promoteParticipant, muteParticipant } from '../server-lib/moderateHelper.js'
import { generateLiveKitToken } from '../server-lib/livekitHelper.js'
import { generateAiSummary, generateSmartCatchup, generateRoomQuiz, voteRoomQuiz, generateAiSubtitles } from '../server-lib/aiHelper.js'
import { checkRateLimit, clientKey } from '../server-lib/rateLimit.js'
import { timingSafeEqual } from 'node:crypto'

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

function requireCronSecret(req) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    throw Object.assign(new Error('CRON_SECRET is not configured — set it in your environment'), { status: 503 })
  }
  const provided = req.headers['x-cron-secret'] || req.headers['X-Cron-Secret'] || ''
  // Timing-safe comparison to prevent timing attacks
  const a = Buffer.from(String(provided), 'utf8')
  const b = Buffer.from(String(expected), 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error('Unauthorized'), { status: 401 })
  }
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

  // First mark ended for real-time client listeners
  await roomRef.update({
    status: 'ended',
    activityType: 'idle',
    endedAt: FieldValue.serverTimestamp(),
  }).catch(() => {})

  // Completely delete room and all subcollections right away so stale rooms never get stuck on Firestore
  await deleteRoomAndSubcollections(db, roomRef)

  return { success: true }
}

export default async function handler(req, res) {
  try {
    // --- Rate limiting (per IP) ---
    const ip = clientKey(req)
    const rl = checkRateLimit(`room:${ip}`, { limit: 60, windowMs: 60_000 })
    if (!rl.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ success: false, error: 'Too many requests — slow down' }))
      return
    }
    if (req.method === 'OPTIONS') {
      return sendResponse(res, 200, { ok: true }, JSON_HEADERS)
    }

    const body = req.body || {}
    const action = String(body.action || req.query?.action || req.query?.legacy || '').toLowerCase()

    // Cron check / cleanup target (GET or POST)
    if (action === 'cleanupstalerooms' || action === 'cleanup' || (req.method === 'GET' && !action)) {
      requireCronSecret(req)
      const db = getDb()
      const result = await runCleanupStaleRooms(db)
      return ok(res, result)
    }

    if (preflight(req, res, { methods: ['POST', 'GET'] })) return
    if (!action) return fail(res, 400, 'Missing action')

    const db = getDb()
    let result

    if (action === 'join') {
      await requireUser(req, body.uid)
      result = await joinRoom(db, body)
    } else if (action === 'leave') {
      await requireUser(req, body.uid)
      result = await leaveRoom(db, body)
    } else if (action === 'end') {
      await requireUser(req, body.uid)
      result = await endRoom(db, body)
    } else if (action === 'kick') {
      const decoded = await requireUser(req)
      result = await kickParticipant(db, decoded.uid, body)
    } else if (action === 'promote') {
      const decoded = await requireUser(req)
      result = await promoteParticipant(db, decoded.uid, body)
    } else if (action === 'mute') {
      const decoded = await requireUser(req)
      result = await muteParticipant(db, decoded.uid, body)
    } else if (action === 'livekit' || action === 'createlivekittoken') {
      await requireUser(req, body.uid)
      result = await generateLiveKitToken(db, body)
    } else if (action === 'ai' || action === 'summary') {
      const decoded = await requireUser(req)
      result = await generateAiSummary(db, decoded, body)
    } else if (action === 'catchup') {
      const decoded = await requireUser(req)
      result = await generateSmartCatchup(db, decoded, body)
    } else if (action === 'quiz' || action === 'generatequiz') {
      const decoded = await requireUser(req)
      result = await generateRoomQuiz(db, decoded, body)
    } else if (action === 'votequiz') {
      const decoded = await requireUser(req)
      result = await voteRoomQuiz(db, decoded, body)
    } else if (action === 'subtitles' || action === 'captions') {
      const decoded = await requireUser(req)
      result = await generateAiSubtitles(db, decoded, body)
    } else {
      return fail(res, 400, `Unknown action: ${action}`)
    }

    return ok(res, result)
  } catch (err) {
    console.error('room API error', err)
    return fail(res, statusForError(err), err.message || 'Internal error')
  }
}
