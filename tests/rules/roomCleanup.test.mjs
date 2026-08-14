/**
 * Room TTL / ghost-participant reaping, against the Firestore emulator via the
 * Admin SDK (cleanup runs server-side, so it bypasses security rules).
 *
 * The bug being guarded: `leave` only fires on a clean exit, so a killed app or
 * dropped connection left the seat behind. Cleanup saw participantCount > 0,
 * assumed the room was alive and refreshed its heartbeat — one ghost seat made
 * a room immortal.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8710'
process.env.GOOGLE_CLOUD_PROJECT = 'chan-rules-test'
process.env.FIREBASE_ADMIN_PROJECT_ID = 'chan-rules-test'

const { default: admin } = await import('firebase-admin')
const { runCleanupStaleRooms } = await import('../../server-lib/roomCleanup.js')

let app
let db

const MINUTE = 60 * 1000
const ago = (ms) => admin.firestore.Timestamp.fromMillis(Date.now() - ms)

beforeAll(() => {
  app = admin.initializeApp({ projectId: 'chan-rules-test' }, `cleanup-${Date.now()}`)
  db = app.firestore()
})

afterAll(async () => { await app?.delete() })

async function wipe() {
  const rooms = await db.collection('rooms').get()
  for (const r of rooms.docs) {
    for (const sub of ['participants', 'messages', 'playerState']) {
      const s = await r.ref.collection(sub).get()
      await Promise.all(s.docs.map((d) => d.ref.delete()))
    }
    await r.ref.delete()
  }
}

beforeEach(wipe)

/** Room old enough to be eligible for cleanup (past MIN_ROOM_AGE_MINUTES). */
async function seedRoom(id, { heartbeatAgeMs, createdAgeMs = 60 * MINUTE, hostId = 'host' } = {}) {
  await db.collection('rooms').doc(id).set({
    hostId,
    status: 'live',
    title: id,
    createdAt: ago(createdAgeMs),
    lastHeartbeat: ago(heartbeatAgeMs),
    participantCount: 0,
  })
  return db.collection('rooms').doc(id)
}

async function seat(roomRef, uid, lastSeenAgeMs) {
  await roomRef.collection('participants').doc(uid).set({
    displayName: uid,
    role: uid === 'host' ? 'host' : 'viewer',
    muted: false,
    joinedAt: ago(lastSeenAgeMs),
    lastSeenAt: ago(lastSeenAgeMs),
  })
}

describe('ghost participant reaping', () => {
  it('removes a seat whose client stopped heartbeating', async () => {
    const room = await seedRoom('ghosty', { heartbeatAgeMs: 30 * MINUTE })
    await seat(room, 'host', 30 * MINUTE)      // ghost: 30m since last beat
    await db.collection('rooms').doc('ghosty').update({ participantCount: 1 })

    await runCleanupStaleRooms(db)

    const seats = await room.collection('participants').get()
    expect(seats.size).toBe(0)
  })

  it('keeps a seat that is actively heartbeating', async () => {
    const room = await seedRoom('livey', { heartbeatAgeMs: 1 * MINUTE })
    await seat(room, 'host', 30 * 1000)        // beat 30s ago — alive
    await db.collection('rooms').doc('livey').update({ participantCount: 1 })

    await runCleanupStaleRooms(db)

    const seats = await room.collection('participants').get()
    expect(seats.size).toBe(1)
    const snap = await room.get()
    expect(snap.exists).toBe(true)
  })

  it('reaps ghosts but keeps live viewers in the same room', async () => {
    const room = await seedRoom('mixed', { heartbeatAgeMs: 1 * MINUTE })
    await seat(room, 'host', 20 * 1000)
    await seat(room, 'ghost1', 30 * MINUTE)
    await seat(room, 'ghost2', 45 * MINUTE)
    await db.collection('rooms').doc('mixed').update({ participantCount: 3 })

    await runCleanupStaleRooms(db)

    const seats = await room.collection('participants').get()
    expect(seats.docs.map((d) => d.id)).toEqual(['host'])
    const snap = await room.get()
    expect(snap.data().participantCount).toBe(1)
  })

  it('a room left with only ghosts is reclaimed, not kept alive forever', async () => {
    // The exact leak: stale heartbeat + an orphaned seat. Previously this
    // refreshed lastHeartbeat and survived every sweep.
    const room = await seedRoom('immortal', { heartbeatAgeMs: 90 * MINUTE })
    await seat(room, 'ghost', 90 * MINUTE)
    await db.collection('rooms').doc('immortal').update({ participantCount: 1 })

    await runCleanupStaleRooms(db)

    const snap = await room.get()
    expect(snap.exists).toBe(false)
  })

  it('a lone stale viewer does NOT renew the room clock', async () => {
    // Host is gone; a non-host seat that is still (just) within the liveness
    // window must not refresh lastHeartbeat.
    const room = await seedRoom('noHost', { heartbeatAgeMs: 40 * MINUTE })
    await seat(room, 'viewer', 30 * 1000)
    await db.collection('rooms').doc('noHost').update({ participantCount: 1 })

    const before = (await room.get()).data().lastHeartbeat.toMillis()
    await runCleanupStaleRooms(db)
    const after = await room.get()

    if (after.exists) {
      expect(after.data().lastHeartbeat.toMillis()).toBe(before)
    }
  })

  it('does not evict a legacy seat that has no timestamps', async () => {
    const room = await seedRoom('legacy', { heartbeatAgeMs: 1 * MINUTE })
    await room.collection('participants').doc('old').set({ displayName: 'Old', role: 'host' })
    await db.collection('rooms').doc('legacy').update({ participantCount: 1 })

    await runCleanupStaleRooms(db)

    const seats = await room.collection('participants').get()
    expect(seats.size).toBe(1)
  })

  it('enforces an absolute room lifetime ceiling', async () => {
    const room = await seedRoom('ancient', {
      heartbeatAgeMs: 1 * MINUTE,
      createdAgeMs: 40 * 60 * MINUTE, // ~40h old, past the 24h ceiling
    })
    await seat(room, 'host', 10 * 1000) // actively alive
    await db.collection('rooms').doc('ancient').update({ participantCount: 1 })

    await runCleanupStaleRooms(db)

    const snap = await room.get()
    expect(snap.exists).toBe(false)
  })

  it('never deletes a brand-new room mid-create', async () => {
    const room = await seedRoom('fresh', { heartbeatAgeMs: 0, createdAgeMs: 30 * 1000 })
    await db.collection('rooms').doc('fresh').update({ participantCount: 0 })

    await runCleanupStaleRooms(db)

    const snap = await room.get()
    expect(snap.exists).toBe(true)
  })
})
