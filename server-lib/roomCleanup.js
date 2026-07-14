import { FieldValue, Timestamp } from './firebaseAdmin.js'

const STALE_MINUTES = 15

export async function deleteRoomAndSubcollections(db, roomRef) {
  const subcollections = [
    'participants',
    'messages',
    'playerState',
    'queue',
    'floatingReactions',
    'typing',
    'aiState',
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

    // No heartbeat at all — check if old enough to be stale
    if (!data.lastHeartbeat) {
      const createdMs = data.createdAt?.toMillis?.() || 0
      if (createdMs > 0 && (nowMs - createdMs) > STALE_MINUTES * 60 * 1000) {
        allStaleRefs.set(doc.id, doc.ref)
        continue
      }
    }

    // Room has 0 participants but is still "live" — stale ghost
    if (data.participantCount === 0) {
      const createdMs = data.createdAt?.toMillis?.() || 0
      // Give a 2-minute grace period after creation for the host to join
      if (createdMs > 0 && (nowMs - createdMs) > 2 * 60 * 1000) {
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
