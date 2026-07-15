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
  const playerPositionRef = useRef({ currentTime: 0, isPlaying: false })
  const isHostRef = useRef(false)

  const rememberRoom = useCallback((id, title = '') => {
    try {
      localStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ roomId: id, title, at: Date.now() }))
    } catch {
      /* ignore quota */
    }
  }, [])

  // Allow RoomPage / VideoPlayer to report last known position so leave can freeze it
  const reportPlayerPosition = useCallback((currentTime, isPlaying) => {
    if (typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime >= 0) {
      playerPositionRef.current = {
        currentTime,
        isPlaying: Boolean(isPlaying),
      }
    }
  }, [])

  const freezePlayerStateOnLeave = useCallback(async (idToken) => {
    if (!user || !roomId) return
    // Only host/co-host can write playerState (Firestore rules). Freeze position so
    // rejoin resumes exactly where the viewer stopped.
    if (!isHostRef.current) return

    const { currentTime } = playerPositionRef.current
    const frozenTime = Math.max(0, Number(currentTime) || 0)
    try {
      // Prefer server leave path (handles participantCount). Also write player state
      // client-side when possible so position is frozen even if keepalive leave races.
      await setDoc(
        doc(db, 'rooms', roomId, 'playerState', 'current'),
        {
          isPlaying: false,
          currentTime: frozenTime,
          clientTimeMs: Date.now(),
          updatedAt: serverTimestamp(),
          updatedBy: user.uid,
          frozenOnLeave: true,
        },
        { merge: true }
      )
    } catch {
      // If rules block (rare race), the leave API will still freeze via server.
      if (idToken) {
        try {
          await fetch('/api/room', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({
              action: 'freeze',
              roomId,
              uid: user.uid,
              currentTime: frozenTime,
            }),
            keepalive: true,
          })
        } catch {
          /* ignore */
        }
      }
    }
  }, [user, roomId])

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
      // Freeze playback position BEFORE leaving so rejoin can resume
      await freezePlayerStateOnLeave(token)
      const res = await fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: 'leave',
          roomId,
          uid: user.uid,
          currentTime: playerPositionRef.current.currentTime,
        }),
      })
      const data = await parseJsonResponse(res)
      if (!res.ok) throw new Error(data.error || 'Could not leave room')
      setJoined(false)
    } catch (err) {
      console.error(err)
    }
  }, [user, roomId, freezePlayerStateOnLeave])

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
    // Sanitize: strip HTML tags and control chars, limit length
    // Note: we do NOT HTML-encode here — JSX auto-escapes on render.
    // This is defense-in-depth in case text is ever rendered in non-JSX context.
    const sanitized = text.trim()
      .replace(/<[^>]*>/g, '')                              // strip HTML tags
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')   // strip control chars (keep \n, \t, \r)
      .replace(/\u200B|\uFEFF/g, '')                        // strip zero-width spaces / BOM
      .replace(/[ \t]+/g, ' ')                              // collapse whitespace
      .replace(/\n{3,}/g, '\n\n')                           // max 2 consecutive newlines
      .trim()
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
        isHostRef.current = data.hostId === user?.uid
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
  }, [roomId, rememberRoom, user?.uid])

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

  // Auto-leave (NOT end) when host/viewer closes tab / navigates away.
  // Freeze player position first so rejoin continues from the same timestamp.
  // Room cleanup will end truly stale rooms (no heartbeat, 0 participants).
  useEffect(() => {
    if (!user || !roomId) return

    let leaveToken = null
    user.getIdToken().then(t => { leaveToken = t }).catch(() => {})

    const handleUnload = () => {
      const frozenTime = Math.max(0, Number(playerPositionRef.current.currentTime) || 0)
      // Fire-and-forget LEAVE (not end) on tab close / navigation
      // keepalive ensures the request is sent even during unload
      fetch('/api/room', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(leaveToken ? { Authorization: `Bearer ${leaveToken}` } : {}),
        },
        body: JSON.stringify({
          action: 'leave',
          roomId,
          uid: user.uid,
          ...(frozenTime > 0.5 ? { currentTime: frozenTime } : {}),
        }),
        keepalive: true,
      }).catch(() => {})
    }

    window.addEventListener('beforeunload', handleUnload)
    window.addEventListener('pagehide', handleUnload)
    return () => {
      window.removeEventListener('beforeunload', handleUnload)
      window.removeEventListener('pagehide', handleUnload)
    }
  }, [user, roomId])

  // Auto join; leave only on real unmount.
  // Guard against React StrictMode double-mount: ignore leaves that fire
  // within the first ~800ms of mount (synthetic remount), so we don't
  // immediately leave + freeze position to 0 and break resume.
  useEffect(() => {
    if (!user || !roomId) return
    intentionalLeave.current = false
    wasParticipant.current = false
    let cancelled = false
    let leaveToken = null
    let joinedSuccessfully = false
    const mountedAt = Date.now()

    // Cache a token now for the keepalive leave fired on cleanup (can't await in cleanup)
    user.getIdToken().then(t => { leaveToken = t }).catch(() => {})

    const check = async () => {
      try {
        const snap = await getDoc(doc(db, 'rooms', roomId, 'participants', user.uid))
        if (cancelled) return
        if (snap.exists()) {
          wasParticipant.current = true
          setJoined(true)
          joinedSuccessfully = true
        } else {
          await join()
          if (!cancelled) {
            wasParticipant.current = true
            joinedSuccessfully = true
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not join room')
      }
    }
    check()

    return () => {
      cancelled = true
      // Skip leave if this was a StrictMode synthetic unmount (very short-lived mount)
      // or if we never successfully joined.
      const livedMs = Date.now() - mountedAt
      if (livedMs < 800 || !joinedSuccessfully) {
        return
      }
      intentionalLeave.current = true
      const frozenTime = Math.max(0, Number(playerPositionRef.current.currentTime) || 0)
      fetch('/api/room', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(leaveToken ? { Authorization: `Bearer ${leaveToken}` } : {}),
        },
        body: JSON.stringify({
          action: 'leave',
          roomId,
          uid: user.uid,
          // Only send freeze time if meaningful — avoid clobbering saved position with 0
          ...(frozenTime > 0.5 ? { currentTime: frozenTime } : {}),
        }),
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
    reportPlayerPosition,
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
