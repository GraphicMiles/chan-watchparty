import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  doc,
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
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

const LAST_ROOM_KEY = 'chan:lastRoom'

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
  const [kicked, setKicked] = useState(false)
  const intentionalLeave = useRef(false)
  const wasParticipant = useRef(false)
  const joinInFlight = useRef(false)

  const rememberRoom = useCallback((id, title = '') => {
    try {
      localStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ roomId: id, title, at: Date.now() }))
    } catch {
      /* ignore quota */
    }
  }, [])

  const join = useCallback(async () => {
    if (!user || !roomId || joinInFlight.current) return
    joinInFlight.current = true
    try {
      const token = await user.getIdToken()
      const body = {
        action: 'join',
        roomId,
        uid: user.uid,
        displayName: user.displayName || 'Viewer',
      }
      if (inviteCode) body.inviteCode = inviteCode
      const res = await fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const data = await parseJsonResponse(res)
      if (!res.ok) throw new Error(data.error || 'Could not join room')
      setJoined(true)
      setKicked(false)
      rememberRoom(data.roomId || roomId)
    } catch (err) {
      setError(err.message)
    } finally {
      joinInFlight.current = false
    }
  }, [user, roomId, inviteCode, rememberRoom])

  const leave = useCallback(async () => {
    if (!user || !roomId) return
    intentionalLeave.current = true
    try {
      const token = await user.getIdToken()
      const res = await fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'leave', roomId, uid: user.uid }),
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
    intentionalLeave.current = true
    try {
      const token = await user.getIdToken()
      const res = await fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'end', roomId, uid: user.uid }),
      })
      const data = await parseJsonResponse(res)
      if (!res.ok) throw new Error(data.error || 'Could not end room')
      navigate('/')
    } catch (err) {
      setError(err.message)
      throw err
    }
  }, [user, roomId, navigate])

  const sendMessage = useCallback(async (text, replyTo = null) => {
    if (!user || !roomId || !text.trim()) return null
    // Basic sanitization: strip HTML tags, limit length
    const sanitized = text.trim()
      .replace(/<[^>]*>/g, '')   // strip HTML tags
      .replace(/&/g, '&amp;')    // encode ampersands
      .slice(0, 500)
    if (!sanitized) return null
    const payload = {
      uid: user.uid,
      displayName: user.displayName || 'Viewer',
      text: sanitized,
      createdAt: serverTimestamp(),
    }
    if (replyTo) payload.replyTo = replyTo
    const ref = await addDoc(collection(db, 'rooms', roomId, 'messages'), payload)
    await deleteDoc(doc(db, 'rooms', roomId, 'typing', user.uid)).catch(() => {})
    return ref.id
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
    await authFetch('/api/room', { action: 'kick', roomId, uid })
  }, [roomId, authFetch])

  const promoteParticipant = useCallback(async (uid, role) => {
    if (!roomId) return
    await authFetch('/api/room', { action: 'promote', roomId, uid, role })
  }, [roomId, authFetch])

  const muteParticipant = useCallback(async (uid, muted) => {
    if (!roomId) return
    await authFetch('/api/room', { action: 'mute', roomId, uid, muted })
  }, [roomId, authFetch])

  // Room listener
  useEffect(() => {
    if (!roomId) return
    const unsub = onSnapshot(
      doc(db, 'rooms', roomId),
      (snap) => {
        if (!snap.exists()) {
          setError('Room not found')
          return
        }
        const data = snap.data()
        setRoom({ id: roomId, ...data })
        setActivityType(data.activityType || 'youtube')
        if (data.status === 'ended') {
          setError('This room has ended')
        }
        rememberRoom(roomId, data.title || '')
      },
      (err) => {
        console.error(err)
        setError(err.message || 'Could not load room')
      }
    )
    return unsub
  }, [roomId, rememberRoom])

  // Participants listener + exact participantCount sync + kick detection
  useEffect(() => {
    if (!roomId || !user) return
    const q = query(collection(db, 'rooms', roomId, 'participants'))
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      setParticipants(list)
      // Participant count is managed server-side via transactions;
      // only host/co-host can update room doc (Firestore rules), so skip client-side sync.
      const me = list.find((p) => p.id === user.uid)
      if (me) {
        wasParticipant.current = true
        setKicked(false)
      } else if (wasParticipant.current && joined && !intentionalLeave.current) {
        setKicked(true)
        setJoined(false)
        setError('You were removed from this room')
      }
    })
    return unsub
  }, [roomId, user, joined, room?.participantCount])

  // Messages listener
  useEffect(() => {
    if (!roomId) return
    const q = query(collection(db, 'rooms', roomId, 'messages'), orderBy('createdAt', 'asc'), limit(200))
    const unsub = onSnapshot(q, (snap) => {
      setMessages(
        snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
          createdAt: d.data().createdAt?.toMillis?.() || Date.now(),
        }))
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
    // Immediate heartbeat so cleanup doesn't race a fresh room
    updateDoc(doc(db, 'rooms', roomId), { lastHeartbeat: serverTimestamp() }).catch(() => {})
    const interval = setInterval(() => {
      updateDoc(doc(db, 'rooms', roomId), { lastHeartbeat: serverTimestamp() }).catch(() => {})
    }, 60000)
    return () => clearInterval(interval)
  }, [user, roomId, room?.hostId])

  // Auto join; leave only on real unmount (not StrictMode remount race)
  useEffect(() => {
    if (!user || !roomId) return
    intentionalLeave.current = false
    wasParticipant.current = false
    let cancelled = false
    let leaveToken = null

    // Cache a token now for the keepalive leave fired on cleanup (can't await in cleanup)
    user.getIdToken().then(t => { leaveToken = t }).catch(() => {})

    const check = async () => {
      try {
        const snap = await getDoc(doc(db, 'rooms', roomId, 'participants', user.uid))
        if (cancelled) return
        if (snap.exists()) {
          wasParticipant.current = true
          setJoined(true)
        } else {
          await join()
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not join room')
      }
    }
    check()

    return () => {
      cancelled = true
      // Fire-and-forget leave; avoid blocking unmount
      intentionalLeave.current = true
      fetch('/api/room', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(leaveToken ? { Authorization: `Bearer ${leaveToken}` } : {}),
        },
        body: JSON.stringify({ action: 'leave', roomId, uid: user.uid }),
        keepalive: true,
      }).catch(() => {})
    }
  }, [user, roomId, join])

  return {
    room,
    participants,
    messages,
    joined,
    error,
    kicked,
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

export function getLastRoom() {
  try {
    const raw = localStorage.getItem(LAST_ROOM_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}
