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
  
  // 1) Find live rooms with stale heartbeat (> 15 minutes old)
  const staleLiveSnap = await db
    .collection('rooms')
    .where('status', '==', 'live')
    .where('lastHeartbeat', '<', cutoff)
    .get()

  // 2) Find any rooms already marked ended
  const endedSnap = await db
    .collection('rooms')
    .where('status', '==', 'ended')
    .limit(100)
    .get()

  // Also find rooms with missing heartbeat older than cutoff or created long ago and abandoned
  const allStaleRefs = new Map()
  staleLiveSnap.docs.forEach((d) => allStaleRefs.set(d.id, d.ref))
  endedSnap.docs.forEach((d) => allStaleRefs.set(d.id, d.ref))

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
