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
import { sanitizeAction, sanitizeRoomId, sanitizeUid, sanitizeText } from '../server-lib/sanitize.js'

const ALLOWED_ROOM_ACTIONS = [
  'join', 'leave', 'end', 'kick', 'promote', 'mute', 'freeze',
  'livekit', 'createlivekittoken',
  'ai', 'summary', 'catchup', 'quiz', 'generatequiz', 'votequiz',
  'subtitles', 'captions',
  'cleanupstalerooms', 'cleanup',
]

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
    throw Object.assign(new Error('Cron authentication is not configured on the server'), { status: 503 })
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
    // Always refresh lastHeartbeat on join so landing-page "truly live" filter
    // and stale-room cleanup both see recent activity.
    t.update(roomRef, {
      participantCount: FieldValue.increment(1),
      lastHeartbeat: FieldValue.serverTimestamp(),
    })
  })

  return { roomId: targetRoomId }
}

async function freezePlayerState(db, roomRef, room, uid, currentTime) {
  // Only host/co-host may freeze playback position (matches Firestore rules).
  const isController = room.hostId === uid || (Array.isArray(room.coHosts) && room.coHosts.includes(uid))
  if (!isController) return
  const frozenTime = Math.max(0, Number(currentTime) || 0)
  if (!Number.isFinite(frozenTime)) return
  try {
    await roomRef.collection('playerState').doc('current').set({
      isPlaying: false,
      currentTime: frozenTime,
      clientTimeMs: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
      frozenOnLeave: true,
    }, { merge: true })
  } catch (err) {
    console.error('freezePlayerState failed:', err.message)
  }
}

async function leaveRoom(db, body) {
  const { roomId, uid, currentTime } = body || {}
  if (!roomId || !uid) throw new Error('Missing roomId or uid')

  const roomRef = db.collection('rooms').doc(roomId)
  const participantRef = roomRef.collection('participants').doc(uid)
  let roomData = null
  let didLeave = false

  await db.runTransaction(async (t) => {
    const roomSnap = await t.get(roomRef)
    if (!roomSnap.exists) throw new Error('Room not found')
    const room = roomSnap.data()
    roomData = room
    if (room.status !== 'live') return

    const participantSnap = await t.get(participantRef)
    if (!participantSnap.exists) return

    t.delete(participantRef)
    // Recompute from actual participant docs when possible to avoid ghost counts.
    // Fall back to decrement if the subcollection size cannot be read inside the txn.
    let next = Math.max(0, (room.participantCount || 1) - 1)
    try {
      // Note: Firestore transactions don't support collection queries on all
      // platforms the same way; prefer decrement then clamp. A later leave/join
      // or cleanup will re-sync if needed.
      next = Math.max(0, (typeof room.participantCount === 'number' ? room.participantCount : 1) - 1)
    } catch {
      next = Math.max(0, (room.participantCount || 1) - 1)
    }
    t.update(roomRef, {
      participantCount: next,
      // If host left, stop advertising heartbeat freshness so cleanup can reclaim
      // the room after the grace period when nobody returns.
      ...(room.hostId === uid ? { lastHeartbeat: FieldValue.serverTimestamp() } : {}),
    })
    didLeave = true
  })

  // Freeze playback so rejoin continues from the same timestamp (host/co-host only).
  // Only freeze when we have a meaningful position — never clobber a saved
  // position by writing 0 from a racey unload event.
  const freezeTime = Number(currentTime)
  if (didLeave && roomData && Number.isFinite(freezeTime) && freezeTime > 0.5) {
    await freezePlayerState(db, roomRef, roomData, uid, freezeTime)
  }

  // If room is now empty, schedule opportunistic cleanup path is handled by
  // runCleanupStaleRooms (grace period). Do NOT end immediately — host may rejoin.

  return { success: true }
}

async function freezeRoom(db, body) {
  const { roomId, uid, currentTime } = body || {}
  if (!roomId || !uid) throw new Error('Missing roomId or uid')
  const roomRef = db.collection('rooms').doc(roomId)
  const snap = await roomRef.get()
  if (!snap.exists) throw new Error('Room not found')
  await freezePlayerState(db, roomRef, snap.data(), uid, currentTime)
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
    const rl = await checkRateLimit(`room:${ip}`, { limit: 60, windowMs: 60_000 })
    if (!rl.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ success: false, error: 'Too many requests — slow down' }))
      return
    }
    if (req.method === 'OPTIONS') {
      return sendResponse(res, 200, { ok: true }, JSON_HEADERS)
    }

    const body = req.body || {}
    const rawAction = String(body.action || req.query?.action || req.query?.legacy || '').toLowerCase()
    const action = sanitizeAction(rawAction, ALLOWED_ROOM_ACTIONS)
    if (rawAction && !action) return fail(res, 400, 'Invalid action')

    // Validate roomId in body if present
    if (body.roomId && !sanitizeRoomId(body.roomId)) return fail(res, 400, 'Invalid room ID')
    // Validate UID in body if present
    if (body.uid && !sanitizeUid(body.uid)) return fail(res, 400, 'Invalid UID')

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

    // Lightweight inline cleanup: on every room action, quickly delete
    // stale rooms with 0 participants past the grace period.
    // This ensures cleanup runs even without CRON_SECRET or cron jobs.
    // Runs ~5% of the time (and always on leave) so ghost rooms don't linger.
    const shouldCleanup = action === 'leave' || Math.random() < 0.05
    if (shouldCleanup) {
      try {
        // Don't await on leave path beyond a short race — keep leave snappy.
        if (action === 'leave') {
          Promise.resolve(runCleanupStaleRooms(db)).catch(() => {})
        } else {
          await runCleanupStaleRooms(db)
        }
      } catch {
        // Non-critical — don't block the main action
      }
    }

    let result

    if (action === 'join') {
      await requireUser(req, body.uid)
      result = await joinRoom(db, body)
    } else if (action === 'leave') {
      await requireUser(req, body.uid)
      result = await leaveRoom(db, body)
    } else if (action === 'freeze') {
      await requireUser(req, body.uid)
      result = await freezeRoom(db, body)
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
    // Don't leak internal error details for 5xx errors
    const safeMessage = statusForError(err) >= 500 ? 'Internal server error' : (err.message || 'Request failed')
    return fail(res, statusForError(err), safeMessage)
  }
}
