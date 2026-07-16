import { FieldValue, Timestamp } from './firebaseAdmin.js'

const STALE_MINUTES = 15
// How long a room with 0 participants stays alive (waiting for host/viewers to return)
// Increased from 3 to 10 minutes to give users time to:
// - Reload after browser crashes
// - Reconnect after network issues
// - Fix page errors and rejoin
const ZERO_PARTICIPANT_GRACE_MINUTES = 10

export async function deleteRoomAndSubcollections(db, roomRef) {
  const subcollections = [
    'participants',
    'messages',
    'playerState',
    'queue',
    'floatingReactions',
    'typing',
    'aiState',
    'soundEffects',
    'stagePins',
    'quiz',
  ]

  for (const subName of subcollections) {
    const subCol = roomRef.collection(subName)
    while (true) {
      const snap = await subCol.limit(400).get()
      if (snap.empty) break
      const batch = db.batch()
      snap.docs.forEach((d) => {
        batch.delete(d.ref)
      })
      await batch.commit()
    }
  }

  // Delete the main room document
  await roomRef.delete().catch(() => {})
}

/**
 * Recompute participantCount from the participants subcollection and fix drift.
 * Returns the true count.
 */
async function reconcileParticipantCount(db, roomRef, data) {
  try {
    const participantsSnap = await roomRef.collection('participants').limit(200).get()
    const trueCount = participantsSnap.size
    const stored = typeof data.participantCount === 'number' ? data.participantCount : 0
    if (trueCount !== stored) {
      await roomRef.update({ participantCount: trueCount }).catch(() => {})
    }
    return trueCount
  } catch {
    return typeof data.participantCount === 'number' ? data.participantCount : 0
  }
}

export async function runCleanupStaleRooms(db) {
  const cutoff = Timestamp.fromDate(new Date(Date.now() - STALE_MINUTES * 60 * 1000))
  const allStaleRefs = new Map()

  // 1) Find live rooms with stale heartbeat (> 15 minutes old)
  const staleLiveSnap = await db
    .collection('rooms')
    .where('status', '==', 'live')
    .where('lastHeartbeat', '<', cutoff)
    .get()
  staleLiveSnap.docs.forEach((d) => allStaleRefs.set(d.id, d.ref))

  // 2) Find any rooms already marked ended
  const endedSnap = await db
    .collection('rooms')
    .where('status', '==', 'ended')
    .limit(100)
    .get()
  endedSnap.docs.forEach((d) => allStaleRefs.set(d.id, d.ref))

  // 3) Find live rooms that have NO lastHeartbeat field at all
  //    (host disconnected before first heartbeat could fire)
  //    Only clean if they were created more than STALE_MINUTES ago
  const allLiveSnap = await db
    .collection('rooms')
    .where('status', '==', 'live')
    .limit(500)
    .get()

  const nowMs = Date.now()
  for (const doc of allLiveSnap.docs) {
    if (allStaleRefs.has(doc.id)) continue // already flagged
    const data = doc.data()

    // Reconcile participantCount drift (ghost rooms often have stale counts)
    let trueCount = typeof data.participantCount === 'number' ? data.participantCount : 0
    // Always verify 0-count rooms and suspiciously high counts against the subcollection
    if (trueCount === 0 || trueCount > 0) {
      trueCount = await reconcileParticipantCount(db, doc.ref, data)
    }

    // No heartbeat at all — check if old enough to be stale
    if (!data.lastHeartbeat) {
      const createdMs = data.createdAt?.toMillis?.() || 0
      if (createdMs > 0 && (nowMs - createdMs) > STALE_MINUTES * 60 * 1000) {
        allStaleRefs.set(doc.id, doc.ref)
        continue
      }
    }

    // Room has 0 participants but is still "live" — could be a host who
    // left temporarily and will return. Only clean if BOTH conditions are met:
    // - 0 participants for longer than the grace period
    // - last activity (createdAt or lastHeartbeat) is older than grace
    if (trueCount === 0) {
      const createdMs = data.createdAt?.toMillis?.() || 0
      const heartbeatMs = data.lastHeartbeat?.toMillis?.() || 0
      const lastActivityMs = Math.max(createdMs, heartbeatMs) || createdMs
      // Give grace period for the host/viewers to return
      if (lastActivityMs > 0 && (nowMs - lastActivityMs) > ZERO_PARTICIPANT_GRACE_MINUTES * 60 * 1000) {
        allStaleRefs.set(doc.id, doc.ref)
        continue
      }
    }
  }

  let cleaned = 0
  for (const roomRef of allStaleRefs.values()) {
    try {
      await deleteRoomAndSubcollections(db, roomRef)
      cleaned += 1
    } catch (err) {
      console.error(`Error deleting room ${roomRef.id}:`, err)
    }
  }

  return { cleaned }
}
