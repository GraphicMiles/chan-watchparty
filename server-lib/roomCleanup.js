import { FieldValue, Timestamp } from './firebaseAdmin.js'

const STALE_MINUTES = 15
// How long a room with 0 participants stays alive (waiting for host/viewers to return)
// Increased from 3 → 10 → 30 minutes so create→join races, browser reloads,
// StrictMode remounts, and brief network drops no longer wipe live rooms.
const ZERO_PARTICIPANT_GRACE_MINUTES = 30
// Never delete a room younger than this, even if participantCount is 0.
// Protects the create-room flow: setDoc → set playerState → join can leave a
// brief window where count is still 0 while the host is mid-join.
const MIN_ROOM_AGE_MINUTES = 5
// A seat whose client has not heartbeat within this window is a ghost and is
// removed. Clients beat every 60s, so this tolerates several missed beats
// (backgrounded tab, tunnel, brief signal loss) before reaping.
const PARTICIPANT_STALE_MINUTES = 5
// Hard ceiling on room lifetime. Without this a room with a permanently
// active host tab could live indefinitely.
const MAX_ROOM_AGE_HOURS = 24

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
    'chatMeta',
  ]

  for (const subName of subcollections) {
    const subCol = roomRef.collection(subName)
    while (true) {
      const snap = await subCol.limit(400).get()
      if (snap.empty) break
      // messages/{id}/reactions is a sub-subcollection: deleting the parent
      // document in Firestore does NOT remove it, so those docs were being
      // orphaned in the database forever.
      if (subName === 'messages') {
        for (const d of snap.docs) {
          const reactions = await d.ref.collection('reactions').limit(400).get().catch(() => null)
          if (reactions && !reactions.empty) {
            const rb = db.batch()
            reactions.docs.forEach((r) => rb.delete(r.ref))
            await rb.commit().catch(() => {})
          }
        }
      }
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
 * Reap participant seats whose client has stopped heartbeating, then
 * recompute participantCount from what actually remains.
 *
 * This is the fix for rooms that never expired. `leave` only fires on a clean
 * exit, so a killed app / dropped connection / locked phone left the seat
 * behind forever. Cleanup then saw participantCount > 0, treated the room as
 * alive, and REFRESHED its heartbeat — so a single ghost seat made the room
 * immortal and the zero-participant grace period could never be reached.
 *
 * Seats without a lastSeenAt (written before this field existed, or by an
 * older client) fall back to joinedAt, and are only reaped once they are
 * older than the grace period — so a legacy seat is never killed instantly.
 *
 * Returns the number of live seats remaining.
 */
async function reconcileParticipantCount(db, roomRef, data) {
  try {
    const participantsSnap = await roomRef.collection('participants').limit(200).get()
    const nowMs = Date.now()
    const cutoffMs = PARTICIPANT_STALE_MINUTES * 60 * 1000

    const ghosts = []
    let liveCount = 0
    for (const p of participantsSnap.docs) {
      const pd = p.data() || {}
      const seenMs = pd.lastSeenAt?.toMillis?.() || 0
      const joinedMs = pd.joinedAt?.toMillis?.() || 0
      const referenceMs = seenMs || joinedMs
      // No usable timestamp at all: keep the seat rather than risk evicting a
      // live viewer; the room-level grace period still applies.
      if (!referenceMs) { liveCount += 1; continue }
      if (nowMs - referenceMs > cutoffMs) ghosts.push(p.ref)
      else liveCount += 1
    }

    if (ghosts.length) {
      const batch = db.batch()
      ghosts.forEach((ref) => batch.delete(ref))
      await batch.commit().catch(() => {})
    }

    const stored = typeof data.participantCount === 'number' ? data.participantCount : 0
    if (liveCount !== stored) {
      await roomRef.update({ participantCount: liveCount }).catch(() => {})
    }
    return liveCount
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
    const createdMs = data.createdAt?.toMillis?.() || 0
    const roomAgeMs = createdMs > 0 ? nowMs - createdMs : Number.POSITIVE_INFINITY

    // Brand-new rooms are never cleaned here — host may still be joining.
    if (roomAgeMs < MIN_ROOM_AGE_MINUTES * 60 * 1000) {
      continue
    }

    // Reconcile participantCount drift (ghost rooms often have stale counts)
    let trueCount = typeof data.participantCount === 'number' ? data.participantCount : 0
    // Always verify against the subcollection so ghost counts don't stick.
    trueCount = await reconcileParticipantCount(db, doc.ref, data)

    // Absolute lifetime ceiling — applies even to a room that still looks
    // busy, so nothing can live forever.
    if (createdMs > 0 && (nowMs - createdMs) > MAX_ROOM_AGE_HOURS * 3600 * 1000) {
      allStaleRefs.set(doc.id, doc.ref)
      continue
    }

    // Genuinely live seats remain (ghosts were already reaped above), so the
    // room stays. The heartbeat is only refreshed when a HOST seat is still
    // present: previously any surviving seat refreshed it, which is what let
    // one orphaned participant keep a dead room alive indefinitely.
    if (trueCount > 0) {
      const heartbeatMs = data.lastHeartbeat?.toMillis?.() || 0
      if (!heartbeatMs || (nowMs - heartbeatMs) > STALE_MINUTES * 60 * 1000) {
        let hostSeated = false
        try {
          const hostSnap = await doc.ref.collection('participants').doc(String(data.hostId || '')).get()
          hostSeated = hostSnap.exists
        } catch { /* treat as not seated */ }
        try {
          await doc.ref.update({
            participantCount: trueCount,
            ...(hostSeated ? { lastHeartbeat: Timestamp.fromDate(new Date()) } : {}),
          })
        } catch {
          /* non-critical */
        }
      }
      continue
    }

    // No heartbeat at all — check if old enough to be stale
    if (!data.lastHeartbeat) {
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
      const heartbeatMs = data.lastHeartbeat?.toMillis?.() || 0
      const lastActivityMs = Math.max(createdMs, heartbeatMs) || createdMs
      // Give grace period for the host/viewers to return
      if (lastActivityMs > 0 && (nowMs - lastActivityMs) > ZERO_PARTICIPANT_GRACE_MINUTES * 60 * 1000) {
        allStaleRefs.set(doc.id, doc.ref)
        continue
      }
    }
  }

  // Drop any pre-flagged "stale heartbeat" rooms that still have seats —
  // the earlier query can't see participantCount, so re-check before delete.
  for (const [id, roomRef] of [...allStaleRefs.entries()]) {
    try {
      const snap = await roomRef.get()
      if (!snap.exists) {
        allStaleRefs.delete(id)
        continue
      }
      const data = snap.data()
      if (data?.status === 'ended') continue
      const createdMs = data.createdAt?.toMillis?.() || 0
      if (createdMs > 0 && (nowMs - createdMs) < MIN_ROOM_AGE_MINUTES * 60 * 1000) {
        allStaleRefs.delete(id)
        continue
      }
      // Past the absolute ceiling the room goes regardless of who is seated,
      // so do not let the live-seat check below rescue it.
      if (createdMs > 0 && (nowMs - createdMs) > MAX_ROOM_AGE_HOURS * 3600 * 1000) {
        continue
      }
      // Reaps ghost seats first, so this reflects genuinely live viewers.
      const trueCount = await reconcileParticipantCount(db, roomRef, data)
      if (trueCount > 0) {
        allStaleRefs.delete(id)
        try {
          // Only a seated host renews the room clock (see the note in the
          // main pass) — otherwise a lone stale viewer keeps it alive forever.
          let hostSeated = false
          try {
            const hostSnap = await roomRef.collection('participants').doc(String(data.hostId || '')).get()
            hostSeated = hostSnap.exists
          } catch { /* treat as not seated */ }
          await roomRef.update({
            participantCount: trueCount,
            ...(hostSeated ? { lastHeartbeat: Timestamp.fromDate(new Date()) } : {}),
          })
        } catch {
          /* non-critical */
        }
      }
    } catch {
      /* keep flagged on read error — better to retry later than leak forever */
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
