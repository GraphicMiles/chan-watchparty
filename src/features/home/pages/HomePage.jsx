import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { collection, doc, getDoc, onSnapshot, query as fbQuery, where } from 'firebase/firestore'
import { Search, LogOut, Hash, Monitor, History, Play, Users, X } from 'lucide-react'
import { db } from '../../../shared/lib/firebase.js'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'
import { apiPath, parseJsonResponse } from '../../../shared/lib/api.js'
import { Button, Skeleton, useToast } from '../../../shared/ui/index.js'
import { Header, Layout } from '../../../shared/layout/index.js'
import { ErrorBoundary } from '../../../shared/components/ErrorBoundary.jsx'
import { getLastRoom } from '../../room/hooks/useRoom.js'
import { cleanMediaTitle } from '../../../shared/lib/titleFormat.js'
import styles from './HomePage.module.css'

/**
 * A room is "truly live" only when:
 *  - status is live (already filtered by query)
 *  - participantCount > 0
 *  - lastHeartbeat is fresh (< 3 minutes) OR created recently (< 3 minutes)
 */
function isTrulyLive(room, nowMs = Date.now()) {
  if (!room) return false
  const count = typeof room.participantCount === 'number' ? room.participantCount : 0
  if (count <= 0) return false

  const heartbeatMs = room.lastHeartbeat?.toMillis?.()
    ?? (typeof room.lastHeartbeat?.seconds === 'number' ? room.lastHeartbeat.seconds * 1000 : 0)
  const createdMs = room.createdAt?.toMillis?.()
    ?? (typeof room.createdAt?.seconds === 'number' ? room.createdAt.seconds * 1000 : 0)
    ?? (typeof room.createdAtMs === 'number' ? room.createdAtMs : 0)

  const FRESH_MS = 3 * 60 * 1000
  if (heartbeatMs > 0) return (nowMs - heartbeatMs) < FRESH_MS
  if (createdMs > 0) return (nowMs - createdMs) < FRESH_MS
  return false
}

/** Source filter chips — shown above results, not a pre-search screen. NSFW is
 * intentionally excluded (age-gated behind an account-level setting). */
const SOURCE_CHIPS = [
  { id: 'all', label: 'All' },
  { id: 'direct', label: 'Direct links' },
  { id: 'iptv', label: 'IPTV' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'sports', label: 'Sports' },
]

const RECENT_KEY = 'chan:recent-searches'

function loadRecentSearches() {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.slice(0, 6) : []
  } catch {
    return []
  }
}

function saveRecentSearch(term) {
  try {
    const t = String(term || '').trim().toLowerCase()
    if (!t) return
    const next = [t, ...loadRecentSearches().filter((x) => x !== t)].slice(0, 6)
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch { /* storage unavailable */ }
}

/** Friends list — placeholder hook (no friends system yet); stored per-account
 * so the "N friends here" ranking + badge are wired and ready. */
function loadFriendUids() {
  try {
    const raw = window.localStorage.getItem('chan:friends')
    const list = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(list) ? list : [])
  } catch {
    return new Set()
  }
}

export default function HomePage() {
  const { user, loading, logout } = useAuth()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [rooms, setRooms] = useState([])
  const [roomsLoading, setRoomsLoading] = useState(true)
  const [joining, setJoining] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteCode, setInviteCode] = useState('')
  const [query, setQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [recentSearches, setRecentSearches] = useState([])
  const [lastRoom, setLastRoom] = useState(null)
  const [continueRoom, setContinueRoom] = useState(null)
  const [nowTick, setNowTick] = useState(Date.now())
  const friendUids = useMemo(() => loadFriendUids(), [])
  const inputRef = useRef(null)

  useEffect(() => { setLastRoom(getLastRoom()) }, [])
  useEffect(() => { setRecentSearches(loadRecentSearches()) }, [])

  // Re-evaluate "freshness" every 30s so ghost rooms drop off without a full reload
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!user) { setRoomsLoading(false); return undefined }
    const unsub = onSnapshot(
      fbQuery(collection(db, 'rooms'), where('status', '==', 'live'), where('isPrivate', '==', false)),
      (snap) => {
        setRooms(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
        setRoomsLoading(false)
      },
      (err) => {
        console.error(err)
        setRoomsLoading(false)
        toast('Could not load rooms.', { variant: 'error' })
      }
    )
    return unsub
  }, [user, toast])

  const activeRooms = useMemo(
    () => rooms.filter((r) => isTrulyLive(r, nowTick)),
    [rooms, nowTick]
  )

  // Smart ranking: friends present first, then activity/size, then recency.
  const rankedRooms = useMemo(() => {
    const withMeta = activeRooms.map((r) => {
      const participants = Array.isArray(r.participants) ? r.participants
        : (Array.isArray(r.participantIds) ? r.participantIds : [])
      const friendsHere = participants.filter((p) => friendUids.has(typeof p === 'string' ? p : p?.uid)).length
      return { room: r, friendsHere, activity: Number(r.participantCount) || 0 }
    })
    return withMeta.sort((a, b) => {
      if (b.friendsHere !== a.friendsHere) return b.friendsHere - a.friendsHere
      if (b.activity !== a.activity) return b.activity - a.activity
      return (b.room.createdAt?.toMillis?.() || 0) - (a.room.createdAt?.toMillis?.() || 0)
    })
  }, [activeRooms, friendUids])

  useEffect(() => {
    if (!lastRoom?.roomId || !user) { setContinueRoom(null); return }
    const found = rooms.find((r) => r.id === lastRoom.roomId)
    if (found && isTrulyLive(found, nowTick)) { setContinueRoom(found); return }
    getDoc(doc(db, 'rooms', lastRoom.roomId))
      .then((snap) => {
        if (snap.exists() && snap.data().status === 'live') {
          const data = { id: snap.id, ...snap.data() }
          if (isTrulyLive(data, Date.now())) setContinueRoom(data)
          else setContinueRoom(null)
        } else { setContinueRoom(null) }
      })
      .catch(() => setContinueRoom(null))
  }, [rooms, lastRoom, user, nowTick])

  const submitSearch = (e) => {
    e?.preventDefault()
    const q = query.trim()
    if (!q) return
    saveRecentSearch(q)
    setRecentSearches(loadRecentSearches())
    setSearchFocused(false)
    navigate(`/search?q=${encodeURIComponent(q)}`)
  }

  const goChip = (layerId) => {
    if (layerId === 'all') { navigate('/search'); return }
    navigate(`/search?layer=${layerId}`)
  }

  const pickRecent = (term) => {
    setQuery(term)
    saveRecentSearch(term)
    setSearchFocused(false)
    navigate(`/search?q=${encodeURIComponent(term)}`)
  }

  const joinByInvite = async (e) => {
    e.preventDefault()
    if (!inviteCode.trim()) return
    if (!user) { toast('Sign in first', { variant: 'warning' }); navigate('/auth'); return }
    const code = inviteCode.trim().toUpperCase()
    setJoining(true)
    try {
      const token = await user.getIdToken()
      const res = await fetch(apiPath('/api/room'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'join', inviteCode: code, uid: user.uid, displayName: user.displayName || 'Viewer' }),
      })
      const data = await parseJsonResponse(res)
      if (res.ok && data.roomId) { navigate(`/room/${data.roomId}?invite=${code}`) }
      else { toast(data.error || 'Invalid invite code', { variant: 'error' }) }
    } catch (err) { toast(err.message || 'Could not join', { variant: 'error' }) }
    finally { setJoining(false) }
  }

  const headerActions = user ? (
    <Button variant="ghost" size="md" onClick={logout} aria-label="Sign out" title="Sign out">
      <LogOut size={16} />
    </Button>
  ) : (
    <Button as={Link} to="/auth" variant="primary" size="md">Sign In</Button>
  )

  const showSuggestions = searchFocused && !query.trim()

  return (
    <Layout header={<Header user={user} actions={headerActions} />}>
      {/* ── Primary search bar ── */}
      <form className={styles.searchForm} onSubmit={submitSearch}>
        <div className={`${styles.searchBar} ${searchFocused ? styles.searchBarFocused : ''}`}>
          <Search size={16} className={styles.searchIcon} />
          <input
            ref={inputRef}
            type="text"
            className={styles.searchInput}
            placeholder="Search a show, paste a link, or find a room"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
          />
          {query && (
            <button type="button" className={styles.clearBtn} onClick={() => { setQuery(''); inputRef.current?.focus() }} aria-label="Clear">
              <X size={14} />
            </button>
          )}
        </div>

        {/* ── Source filter chips (above results, not a pre-search screen) ── */}
        <div className={styles.chipRow}>
          {SOURCE_CHIPS.map((chip) => (
            <button key={chip.id} type="button" className={styles.chip} onClick={() => goChip(chip.id)}>
              {chip.label}
            </button>
          ))}
        </div>
      </form>

      {/* ── Suggestions on focus, before typing ── */}
      {showSuggestions && (
        <div className={styles.suggestions}>
          {(continueRoom || recentSearches.length > 0) && (
            <>
              {continueRoom && (
                <>
                  <div className={styles.sectionLabel}>
                    <span>Continue watching</span>
                  </div>
                  <div className={styles.suggestList}>
                    <Link to={`/room/${continueRoom.id}`} className={styles.suggestItem}>
                      <span className={styles.suggestIcon}><Play size={15} /></span>
                      <span className={styles.suggestText}>
                        <span className={styles.suggestTitle}>{continueRoom.title || 'Ongoing room'}</span>
                        <span className={styles.suggestMeta}>Resume watching</span>
                      </span>
                    </Link>
                  </div>
                </>
              )}
              {recentSearches.length > 0 && (
                <>
                  <div className={styles.sectionLabel}>
                    <span>Recent searches</span>
                  </div>
                  <div className={styles.suggestList}>
                    {recentSearches.map((term) => (
                      <button key={term} type="button" className={styles.suggestItem} onClick={() => pickRecent(term)}>
                        <span className={styles.suggestIcon}><History size={15} /></span>
                        <span className={styles.suggestText}>
                          <span className={styles.suggestTitle}>{term}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Secondary actions — demoted, small ── */}
      <div className={styles.secondaryRow}>
        <button type="button" className={styles.secBtn} onClick={() => navigate('/create')}>
          <Monitor size={14} /> Screen share
        </button>
        <button type="button" className={styles.secBtn} onClick={() => setInviteOpen((s) => !s)}>
          <Hash size={14} /> Join with code
        </button>
      </div>
      {inviteOpen && (
        <form className={styles.inviteForm} onSubmit={joinByInvite}>
          <input
            type="text"
            className={styles.inviteInput}
            placeholder="Invite code"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
            autoFocus
          />
          <Button type="submit" variant="primary" size="sm" loading={joining}>Join</Button>
        </form>
      )}

      {/* ── Live now — smart-ranked rooms ── */}
      <div className={styles.sectionLabel}>
        <span>Live now</span>
        <span className={styles.count}>{activeRooms.length} room{activeRooms.length !== 1 ? 's' : ''}</span>
      </div>

      {loading || roomsLoading ? (
        <div className={styles.skeletonList}>
          {[1, 2, 3].map((i) => (
            <div key={i} className={styles.skeletonRoom}>
              <Skeleton width="56px" height="56px" rounded="md" />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Skeleton height="0.9rem" width="70%" />
                <Skeleton height="0.7rem" width="45%" />
              </div>
            </div>
          ))}
        </div>
      ) : rankedRooms.length === 0 ? (
        <div className={styles.emptyRooms}>
          <p>No live rooms right now. Search above to start one — anyone can join.</p>
        </div>
      ) : (
        <div className={styles.roomList}>
          {rankedRooms.map(({ room, friendsHere }) => (
            <ErrorBoundary key={room.id}>
              <RoomRow room={room} friendsHere={friendsHere} />
            </ErrorBoundary>
          ))}
        </div>
      )}
    </Layout>
  )
}

/** Compact ranked room row (mockup structure): thumb + info + activity pulse. */
function RoomRow({ room, friendsHere = 0 }) {
  const isDirect = room.videoType === 'direct' || room.videoType === 'iptv' || room.videoType === 'sports'
    || (!room.videoId && Boolean(room.videoUrl))
  const startedAt = room.createdAt?.toDate?.()
  const timeAgo = startedAt ? getRelativeTime(startedAt) : null
  const watchers = typeof room.participantCount === 'number' ? Math.max(0, room.participantCount) : 0

  // Pseudo-random activity bars (deterministic per room id + count)
  const bars = useMemo(() => {
    let seed = 0
    for (let i = 0; i < (room.id || '').length; i += 1) seed = (seed * 31 + room.id.charCodeAt(i)) >>> 0
    const heights = [6, 13, 9, 15, 8, 12]
    return heights.map((h, i) => {
      const v = (seed >> (i * 3)) & 7
      return 5 + ((h + v) % 12)
    })
  }, [room.id])

  return (
    <Link to={`/room/${room.id}`} className={styles.roomCard}>
      <div className={styles.roomThumb}>
        <span className={styles.liveDot} />
        {isDirect ? <Monitor size={18} /> : <Play size={18} style={{ marginLeft: 2 }} />}
      </div>
      <div className={styles.roomInfo}>
        <div className={styles.roomTitle}>{cleanMediaTitle(room.title) || 'Untitled room'}</div>
        <div className={styles.roomMeta}>
          <span>{room.hostName || 'Host'}</span>
          <span className={styles.metaDot} />
          <span>{watchers} watching</span>
          {timeAgo && (
            <>
              <span className={styles.metaDot} />
              <span>{timeAgo}</span>
            </>
          )}
        </div>
        {friendsHere > 0 && (
          <span className={styles.friendBadge}>
            <Users size={10} /> {friendsHere} friend{friendsHere !== 1 ? 's' : ''} here
          </span>
        )}
      </div>
      <div className={styles.roomActivity} aria-hidden>
        {bars.map((h, i) => (
          <span key={i} style={{ height: `${h}px` }} />
        ))}
      </div>
    </Link>
  )
}

function getRelativeTime(date) {
  try {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) return null
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
    if (seconds < 60) return 'just now'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d ago`
    return date.toLocaleDateString()
  } catch {
    return null
  }
}
