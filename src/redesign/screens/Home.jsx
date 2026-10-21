import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, doc, getDoc, limit, onSnapshot, query as fbQuery, where } from 'firebase/firestore';
import { Play, Search, Hash, Monitor, X, Loader2 } from 'lucide-react';
import { db } from '../../shared/lib/firebase.js';
import { useAuth } from '../../shared/auth/hooks/useAuth.jsx';
import { apiPath, parseJsonResponse } from '../../shared/lib/api.js';
import { useToast } from '../../shared/ui/index.js';
import { getLastRoom } from '../../features/room/hooks/useRoom.js';
import { cleanMediaTitle } from '../../shared/lib/titleFormat.js';
import { getThumbnail } from '../../shared/lib/youtube.js';
import { Avatar, BottomNav, Img, PosterCard, SecHead, Stack, gradFor } from '../ui.jsx';

/**
 * A room is "truly live" only when:
 *  - status is live (already filtered by query)
 *  - participantCount > 0
 *  - lastHeartbeat is fresh (< 3 minutes) OR created recently (< 3 minutes)
 */
function isTrulyLive(room, nowMs = Date.now()) {
  if (!room) return false;
  const count = typeof room.participantCount === 'number' ? room.participantCount : 0;
  if (count <= 0) return false;

  const heartbeatMs = room.lastHeartbeat?.toMillis?.()
    ?? (typeof room.lastHeartbeat?.seconds === 'number' ? room.lastHeartbeat.seconds * 1000 : 0);
  const createdMs = room.createdAt?.toMillis?.()
    ?? (typeof room.createdAt?.seconds === 'number' ? room.createdAt.seconds * 1000 : 0)
    ?? (typeof room.createdAtMs === 'number' ? room.createdAtMs : 0);

  const FRESH_MS = 3 * 60 * 1000;
  if (heartbeatMs > 0) return (nowMs - heartbeatMs) < FRESH_MS;
  if (createdMs > 0) return (nowMs - createdMs) < FRESH_MS;
  return false;
}

const SOURCE_CHIPS = [
  { id: 'all', label: 'All' },
  { id: 'direct', label: 'Direct links' },
  { id: 'iptv', label: 'IPTV' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'sports', label: 'Sports' },
];

const TRENDING = ['Silo', 'House of the Dragon', 'Premier League', 'Squid Game', 'The Last of Us'];

const RECENT_KEY = 'chan:recent-searches';

function loadRecentSearches() {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(0, 6) : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(term) {
  try {
    const t = String(term || '').trim().toLowerCase();
    if (!t) return;
    const next = [t, ...loadRecentSearches().filter((x) => x !== t)].slice(0, 6);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage unavailable */ }
}

/** Friends list — placeholder hook (no friends system yet); stored per-account
 * so the "N friends here" ranking + badge are wired and ready. */
function loadFriendUids() {
  try {
    const raw = window.localStorage.getItem('chan:friends');
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function getRelativeTime(date) {
  try {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) return null;
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  } catch {
    return null;
  }
}

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [rooms, setRooms] = useState([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [codeInvalid, setCodeInvalid] = useState(false);
  const [query, setQuery] = useState('');
  const [recentSearches, setRecentSearches] = useState([]);
  const [lastRoom, setLastRoom] = useState(null);
  const [continueRoom, setContinueRoom] = useState(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const friendUids = useMemo(() => loadFriendUids(), []);
  const codeRef = useRef(null);

  useEffect(() => { setLastRoom(getLastRoom()); }, []);
  useEffect(() => { setRecentSearches(loadRecentSearches()); }, []);

  // Re-evaluate "freshness" every 30s so ghost rooms drop off without a full reload
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!user) { setRoomsLoading(false); return undefined; }
    const unsub = onSnapshot(
      // The limit is required, not cosmetic: the Firestore rules only permit
      // a bounded lobby query, so that an unfiltered scan of the whole rooms
      // collection (which would expose private rooms and their invite codes)
      // is impossible. It also caps how much the lobby can ever download.
      fbQuery(
        collection(db, 'rooms'),
        where('status', '==', 'live'),
        where('isPrivate', '==', false),
        limit(100),
      ),
      (snap) => {
        setRooms(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setRoomsLoading(false);
      },
      (err) => {
        console.error(err);
        setRoomsLoading(false);
        toast('Could not load rooms.', { variant: 'error' });
      },
    );
    return unsub;
  }, [user, toast]);

  const activeRooms = useMemo(
    () => rooms.filter((r) => isTrulyLive(r, nowTick)),
    [rooms, nowTick],
  );

  // Smart ranking: friends present first, then activity/size, then recency.
  const rankedRooms = useMemo(() => {
    const withMeta = activeRooms.map((r) => {
      const participants = Array.isArray(r.participants) ? r.participants
        : (Array.isArray(r.participantIds) ? r.participantIds : []);
      const friendsHere = participants.filter((p) => friendUids.has(typeof p === 'string' ? p : p?.uid)).length;
      return { room: r, friendsHere, activity: Number(r.participantCount) || 0 };
    });
    return withMeta.sort((a, b) => {
      if (b.friendsHere !== a.friendsHere) return b.friendsHere - a.friendsHere;
      if (b.activity !== a.activity) return b.activity - a.activity;
      return (b.room.createdAt?.toMillis?.() || 0) - (a.room.createdAt?.toMillis?.() || 0);
    });
  }, [activeRooms, friendUids]);

  useEffect(() => {
    if (!lastRoom?.roomId || !user) { setContinueRoom(null); return; }
    const found = rooms.find((r) => r.id === lastRoom.roomId);
    if (found && isTrulyLive(found, nowTick)) { setContinueRoom(found); return; }
    getDoc(doc(db, 'rooms', lastRoom.roomId))
      .then((snap) => {
        if (snap.exists() && snap.data().status === 'live') {
          const data = { id: snap.id, ...snap.data() };
          if (isTrulyLive(data, Date.now())) setContinueRoom(data);
          else setContinueRoom(null);
        } else { setContinueRoom(null); }
      })
      .catch(() => setContinueRoom(null));
  }, [rooms, lastRoom, user, nowTick]);

  const submitSearch = (e) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    saveRecentSearch(q);
    setRecentSearches(loadRecentSearches());
    navigate(`/search?q=${encodeURIComponent(q)}`);
  };

  const goChip = (layerId) => {
    if (layerId === 'all') { navigate('/search'); return; }
    navigate(`/search?layer=${layerId}`);
  };

  const pickRecent = (term) => {
    setQuery(term);
    saveRecentSearch(term);
    navigate(`/search?q=${encodeURIComponent(term)}`);
  };

  const joinByInvite = async (e) => {
    e.preventDefault();
    if (!inviteCode.trim()) { setCodeInvalid(true); codeRef.current?.focus(); return; }
    if (!user) { toast('Sign in first', { variant: 'warning' }); navigate('/auth'); return; }
    const code = inviteCode.trim().toUpperCase();
    setJoining(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(apiPath('/api/room'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'join', inviteCode: code, uid: user.uid, displayName: user.displayName || 'Viewer' }),
      });
      const data = await parseJsonResponse(res);
      if (res.ok && data.roomId) { navigate(`/room/${data.roomId}?invite=${code}`); }
      else { toast(data.error || 'Invalid invite code', { variant: 'error' }); }
    } catch (err) { toast(err.message || 'Could not join', { variant: 'error' }); }
    finally { setJoining(false); }
  };

  const roomThumb = (room) => (room?.videoId ? getThumbnail(room.videoId) : null);

  return (
    <div className="screen with-nav">
      <div className="safe-top" />
      <div className="scroll">
        <div className="px h-row" style={{ marginTop: 8 }}>
          <span style={{ fontWeight: 900, letterSpacing: '.06em', fontSize: 17 }}>CHAN</span>
          <button type="button" onClick={() => navigate('/profile')} aria-label="Profile">
            <Avatar name={user?.displayName || 'Viewer'} uid={user?.uid} size={34} />
          </button>
        </div>

        <form onSubmit={submitSearch}>
          <div className="search-pill" style={{ cursor: 'text' }}>
            <Search size={17} style={{ flex: 'none' }} />
            <input
              type="text"
              placeholder="Search a show, paste a link, or find a room"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search"
              style={{ background: 'none', border: 'none', outline: 'none', flex: '1 1 auto', fontSize: 13.5, color: 'var(--text)', minWidth: 0 }}
            />
            {query && (
              <button type="button" style={{ color: 'var(--muted)', flex: 'none' }} onClick={() => setQuery('')} aria-label="Clear">
                <X size={15} />
              </button>
            )}
          </div>
        </form>

        <div className="chip-row" style={{ marginTop: 8, alignItems: 'center' }}>
          {SOURCE_CHIPS.map((chip) => (
            <button key={chip.id} type="button" className="chip" onClick={() => goChip(chip.id)}>
              {chip.label}
            </button>
          ))}
        </div>

        {recentSearches.length > 0 && (
          <div className="chip-row" style={{ marginTop: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 12.5, fontWeight: 650, flex: 'none' }}>Recent</span>
            {recentSearches.map((r) => (
              <button key={r} type="button" className="chip" onClick={() => pickRecent(r)}>{r}</button>
            ))}
          </div>
        )}

        {continueRoom && (
          <>
            <SecHead title="Continue watching" top={14} />
            <div className="px">
              <button
                type="button"
                className="backdrop rise"
                style={{ ...gradFor(continueRoom.id), height: 168 }}
                onClick={() => navigate(`/room/${continueRoom.id}`)}
              >
                <Img src={roomThumb(continueRoom)} alt="" />
                <span className="b-in">
                  <span className="pill pill-glass">ROOM STILL LIVE</span>
                  <span className="card-title-2" style={{ display: '-webkit-box', fontSize: 19, fontWeight: 900, marginTop: 8, lineHeight: 1.2 }}>
                    {cleanMediaTitle(continueRoom.title) || 'Ongoing room'}
                  </span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--soft)', margin: '3px 0 10px' }}>
                    Hosted by {continueRoom.hostName || 'Host'}, {continueRoom.participantCount || 0} watching
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--amber)', fontSize: 13, fontWeight: 800 }}>
                    <Play size={13} />Rejoin room
                  </span>
                </span>
              </button>
            </div>
          </>
        )}

        <SecHead title="Live now" top={18} live />
        {roomsLoading ? (
          <div className="hscroll">
            {[0, 1, 2].map((i) => (
              <span key={i} className="room-card">
                <span className="skel" style={{ display: 'block', height: 130, borderRadius: 16 }} />
                <span className="skel" style={{ display: 'block', height: 12, width: '70%', marginTop: 9 }} />
                <span className="skel" style={{ display: 'block', height: 10, width: '45%', marginTop: 6 }} />
              </span>
            ))}
          </div>
        ) : rankedRooms.length === 0 ? (
          <div className="px">
            <div className="empty-box">
              <h4>No live rooms right now</h4>
              <p>Search above to start one. Anyone can join.</p>
            </div>
          </div>
        ) : (
          <div className="hscroll">
            {rankedRooms.map(({ room, friendsHere }, i) => {
              const watchers = typeof room.participantCount === 'number' ? Math.max(0, room.participantCount) : 0;
              const timeAgo = room.createdAt?.toDate?.() ? getRelativeTime(room.createdAt.toDate()) : null;
              const participants = Array.isArray(room.participants) ? room.participants
                : (Array.isArray(room.participantIds) ? room.participantIds : []);
              return (
                <span key={room.id} className="room-card rise" style={{ '--d': `${Math.min(i, 6) * 50}ms` }}>
                  <button
                    type="button"
                    className="backdrop"
                    style={gradFor(room.id)}
                    onClick={() => navigate(`/room/${room.id}`)}
                  >
                    <Img src={roomThumb(room)} alt="" />
                    <span className="b-in">
                      <span className="pill pill-live">LIVE</span>
                      <span className="card-title-2" style={{ fontWeight: 800, fontSize: 14.5, marginTop: 8, lineHeight: 1.25 }}>
                        {cleanMediaTitle(room.title) || 'Untitled room'}
                      </span>
                      <span style={{ display: 'block', fontSize: 11.5, color: 'var(--soft)', marginTop: 3 }}>
                        {timeAgo ? `Started ${timeAgo}` : 'Live now'}
                      </span>
                    </span>
                  </button>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
                    {participants.length > 0 && <Stack people={participants} size={24} />}
                    <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.35, minWidth: 0 }}>
                      <b style={{ color: 'var(--text)' }}>{watchers} watching</b>
                      <span style={{ display: 'block' }}>
                        {friendsHere > 0
                          ? `${friendsHere} friend${friendsHere !== 1 ? 's' : ''} here`
                          : `Hosted by ${room.hostName || 'Host'}`}
                      </span>
                    </span>
                  </span>
                </span>
              );
            })}
          </div>
        )}

        <form className="join-card" style={{ marginTop: 14 }} onSubmit={joinByInvite}>
          <div className={`field${codeInvalid ? ' invalid' : ''}`}>
            <Hash size={15} />
            <input
              ref={codeRef}
              value={inviteCode}
              onChange={(e) => { setInviteCode(e.target.value.toUpperCase()); setCodeInvalid(false); }}
              placeholder={codeInvalid ? 'Enter an invite code' : 'Invite code'}
              aria-label="Invite code"
              maxLength={12}
              autoComplete="off"
              autoCapitalize="characters"
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={joining}>
            {joining ? <Loader2 size={16} className="spin" /> : null}Join
          </button>
        </form>
        <div className="px" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-ghost" style={{ height: 44, fontSize: 14 }} onClick={() => navigate('/create')}>
            <Monitor size={15} />Start a screen share
          </button>
        </div>

        <SecHead title="Trending this week" top={18} />
        <div className="hscroll">
          {TRENDING.map((term, i) => (
            <PosterCard
              key={term}
              title={term}
              meta="Tap to search"
              w={108}
              rank={i + 1}
              rise={`${i * 50}ms`}
              onOpen={() => { saveRecentSearch(term); navigate(`/search?q=${encodeURIComponent(term)}`); }}
            />
          ))}
        </div>
      </div>
      <BottomNav active="home" />
    </div>
  );
}
