import jwt from 'jsonwebtoken'

export async function generateLiveKitToken(db, body) {
  const { roomId, uid, role } = body || {}
  if (!roomId || !uid || !role) {
    throw Object.assign(new Error('Missing roomId, uid, or role'), { status: 400 })
  }

  const snap = await db.collection('rooms').doc(roomId).get()
  if (!snap.exists) throw Object.assign(new Error('Room not found'), { status: 404 })
  const room = snap.data()

  const isHost = room.hostId === uid
  if (role === 'host' && !isHost) {
    throw Object.assign(new Error('Only the host can publish'), { status: 403 })
  }

  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  if (!apiKey || !apiSecret) {
    throw Object.assign(new Error('LiveKit credentials not configured'), { status: 500 })
  }

  const token = jwt.sign(
    {
      video: {
        roomJoin: true,
        room: roomId,
        canPublish: isHost,
        canSubscribe: true,
        canPublishData: false,
      },
    },
    apiSecret,
    {
      issuer: apiKey,
      subject: uid,
      expiresIn: '4h',
    }
  )

  return { token }
}
