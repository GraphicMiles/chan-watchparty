import { FieldValue } from './firebaseAdmin.js'

export async function kickParticipant(db, requesterUid, body) {
  const { roomId, uid } = body || {}
  if (!roomId || !uid) throw new Error('Missing roomId or uid')

  await db.runTransaction(async (t) => {
    const roomRef = db.collection('rooms').doc(roomId)
    const roomSnap = await t.get(roomRef)
    if (!roomSnap.exists) throw new Error('Room not found')
    const room = roomSnap.data()
    if (room.hostId !== requesterUid) throw new Error('Only the host can kick participants')
    if (uid === requesterUid) throw new Error('You cannot kick yourself')

    const participantRef = roomRef.collection('participants').doc(uid)
    const participantSnap = await t.get(participantRef)
    if (!participantSnap.exists) throw new Error('Participant not found')

    t.delete(participantRef)
    const next = Math.max(0, (room.participantCount || 1) - 1)
    const update = { participantCount: next }
    if (Array.isArray(room.coHosts) && room.coHosts.includes(uid)) {
      update.coHosts = FieldValue.arrayRemove(uid)
    }
    t.update(roomRef, update)
  })

  return { success: true }
}

export async function promoteParticipant(db, requesterUid, body) {
  const { roomId, uid, role } = body || {}
  if (!roomId || !uid || !role) throw new Error('Missing roomId, uid, or role')
  if (!['co-host', 'viewer'].includes(role)) throw new Error('Invalid role')

  await db.runTransaction(async (t) => {
    const roomRef = db.collection('rooms').doc(roomId)
    const roomSnap = await t.get(roomRef)
    if (!roomSnap.exists) throw new Error('Room not found')
    const room = roomSnap.data()
    if (room.hostId !== requesterUid) throw new Error('Only the host can assign roles')
    if (uid === requesterUid) throw new Error('You cannot change your own role')

    const participantRef = roomRef.collection('participants').doc(uid)
    const participantSnap = await t.get(participantRef)
    if (!participantSnap.exists) throw new Error('Participant not found')

    t.update(participantRef, { role })
    t.update(roomRef, {
      coHosts: role === 'co-host' ? FieldValue.arrayUnion(uid) : FieldValue.arrayRemove(uid),
    })
  })

  return { success: true }
}

export async function muteParticipant(db, requesterUid, body) {
  const { roomId, uid, muted } = body || {}
  if (!roomId || !uid || typeof muted !== 'boolean') {
    throw new Error('Missing roomId, uid, or muted')
  }

  await db.runTransaction(async (t) => {
    const roomRef = db.collection('rooms').doc(roomId)
    const roomSnap = await t.get(roomRef)
    if (!roomSnap.exists) throw new Error('Room not found')
    const room = roomSnap.data()
    const isHost = room.hostId === requesterUid
    const isCoHost = Array.isArray(room.coHosts) && room.coHosts.includes(requesterUid)
    if (!isHost && !isCoHost) throw new Error('Only the host or co-hosts can mute')
    if (uid === room.hostId) throw new Error('You cannot mute the host')

    const participantRef = roomRef.collection('participants').doc(uid)
    const participantSnap = await t.get(participantRef)
    if (!participantSnap.exists) throw new Error('Participant not found')

    t.update(participantRef, { muted })
  })

  return { success: true }
}
