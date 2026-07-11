import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  doc,
  collection,
  onSnapshot,
  query,
  orderBy,
  addDoc,
  serverTimestamp,
  updateDoc,
  getDoc,
  setDoc,
  deleteDoc,
} from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'
import { parseJsonResponse } from '../../../shared/lib/api.js'

export function useRoom(roomId, inviteCode = null) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [room, setRoom] = useState(null)
  const [participants, setParticipants] = useState([])
  const [messages, setMessages] = useState([])
  const [joined, setJoined] = useState(false)
  const [error, setError] = useState(null)
  const [activityType, setActivityType] = useState('youtube')
  const [typing, setTyping] = useState([])

  // Join / leave via Vercel server functions
  const join = useCallback(async () => {
    if (!user || !roomId) return
    try {
      const body = { roomId, uid: user.uid, displayName: user.displayName || 'Viewer' }
      if (inviteCode) body.inviteCode = inviteCode
      const res = await fetch('/api/joinRoom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await parseJsonResponse(res)
      if (!res.ok) throw new Error(data.error || 'Could not join room')
      setJoined(true)
    } catch (err) {
      setError(err.message)
    }
  }, [user, roomId, inviteCode])

  const leave = useCallback(async () => {
    if (!user || !roomId) return
    try {
      const res = await fetch('/api/leaveRoom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, uid: user.uid }),
      })
      const data = await parseJsonResponse(res)
      if (!res.ok) throw new Error(data.error || 'Could not leave room')
      setJoined(false)
    } catch (err) {
      console.error(err)
    }
  }, [user, roomId])

  const endRoom = useCallback(async () => {
    if (!user || !roomId) return
    try {
      const res = await fetch('/api/endRoom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, uid: user.uid }),
      })
      const data = await parseJsonResponse(res)
      if (!res.ok) throw new Error(data.error || 'Could not end room')
      navigate('/')
    } catch (err) {
      setError(err.message)
    }
  }, [user, roomId, navigate])

  const sendMessage = useCallback(async (text, replyTo = null) => {
    if (!user || !roomId || !text.trim()) return
    const trimmed = text.trim().slice(0, 500)
    const payload = {
      uid: user.uid,
      displayName: user.displayName || 'Viewer',
      text: trimmed,
      createdAt: serverTimestamp(),
    }
    if (replyTo) payload.replyTo = replyTo
    await addDoc(collection(db, 'rooms', roomId, 'messages'), payload)
    // Clear typing indicator after sending
    await deleteDoc(doc(db, 'rooms', roomId, 'typing', user.uid)).catch(() => {})
  }, [user, roomId])

  const updateRoom = useCallback(async (payload) => {
    if (!user || !roomId) return
    await updateDoc(doc(db, 'rooms', roomId), payload)
  }, [user, roomId])

  const authFetch = useCallback(async (path, body) => {
    if (!user) throw new Error('Not signed in')
    const token = await user.getIdToken()
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const data = await parseJsonResponse(res)
    if (!res.ok) throw new Error(data.error || 'Request failed')
    return data
  }, [user])

  const kickParticipant = useCallback(async (uid) => {
    if (!roomId) return
    await authFetch('/api/kickParticipant', { roomId, uid })
  }, [roomId, authFetch])

  const promoteParticipant = useCallback(async (uid, role) => {
    if (!roomId) return
    await authFetch('/api/promoteParticipant', { roomId, uid, role })
  }, [roomId, authFetch])

  const muteParticipant = useCallback(async (uid, muted) => {
    if (!roomId) return
    await authFetch('/api/muteParticipant', { roomId, uid, muted })
  }, [roomId, authFetch])

  // Room listener
  useEffect(() => {
    if (!roomId) return
    const unsub = onSnapshot(doc(db, 'rooms', roomId), async (snap) => {
      if (!snap.exists()) {
        setError('Room not found')
        return
      }
      const data = snap.data()
      setRoom(data)
      setActivityType(data.activityType || 'youtube')
      if (data.status === 'ended') {
        setError('This room has ended')
      }
    })
    return unsub
  }, [roomId])

  // Participants listener
  useEffect(() => {
    if (!roomId) return
    const q = query(collection(db, 'rooms', roomId, 'participants'))
    const unsub = onSnapshot(q, (snap) => {
      setParticipants(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    })
    return unsub
  }, [roomId])

  // Messages listener
  useEffect(() => {
    if (!roomId) return
    const q = query(
      collection(db, 'rooms', roomId, 'messages'),
      orderBy('createdAt', 'asc')
    )
    const unsub = onSnapshot(q, (snap) => {
      setMessages(
        snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toMillis() || Date.now() }))
      )
    })
    return unsub
  }, [roomId])

  // Typing indicator listener
  useEffect(() => {
    if (!roomId) return
    const q = query(collection(db, 'rooms', roomId, 'typing'))
    const unsub = onSnapshot(q, (snap) => {
      const now = Date.now()
      setTyping(
        snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((t) => t.lastTypedAt?.toMillis && now - t.lastTypedAt.toMillis() < 5000)
      )
    })
    return unsub
  }, [roomId])

  const setTypingStatus = useCallback(async (isTyping) => {
    if (!user || !roomId) return
    const ref = doc(db, 'rooms', roomId, 'typing', user.uid)
    if (isTyping) {
      await setDoc(
        ref,
        {
          displayName: user.displayName || 'Viewer',
          lastTypedAt: serverTimestamp(),
        },
        { merge: true }
      )
    } else {
      await deleteDoc(ref).catch(() => {})
    }
  }, [user, roomId])

  // Host heartbeat for stale-room cleanup
  useEffect(() => {
    if (!user || !roomId || room?.hostId !== user.uid) return
    const interval = setInterval(() => {
      updateDoc(doc(db, 'rooms', roomId), { lastHeartbeat: serverTimestamp() })
    }, 30000)
    return () => clearInterval(interval)
  }, [user, roomId, room?.hostId])

  // Auto join if already a participant, otherwise leave on unmount
  useEffect(() => {
    if (!user || !roomId) return
    const check = async () => {
      const snap = await getDoc(doc(db, 'rooms', roomId, 'participants', user.uid))
      if (snap.exists()) {
        setJoined(true)
      } else {
        await join()
      }
    }
    check()
    return () => {
      leave()
    }
  }, [user, roomId, join, leave])

  return {
    room,
    participants,
    messages,
    joined,
    error,
    activityType,
    setActivityType,
    join,
    leave,
    endRoom,
    sendMessage,
    updateRoom,
    typing,
    setTyping: setTypingStatus,
    kickParticipant,
    promoteParticipant,
    muteParticipant,
  }
}
