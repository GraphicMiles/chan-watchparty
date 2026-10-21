import { useEffect, useRef, useState } from 'react';
import { Play, Search, Hash, Monitor, WifiOff } from 'lucide-react';
import { POSTERS, LIVE_ROOMS, RECENT } from '../data.js';
import { Avatar, BottomNav, PosterCard, SecHead, Stack, grad, useGo, useUser } from '../ui.jsx';

export default function Home() {
  const go = useGo();
  const { name } = useUser();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);
  const codeRef = useRef(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const join = () => {
    if (!code.trim()) {
      setInvalid(true);
      codeRef.current?.focus();
      return;
    }
    go('room');
  };

  return (
    <div className="screen">
      <div className="safe-top" />
      {!online && (
        <div className="banner"><WifiOff size={15} /><span>You are offline. Changes will sync when the network returns.</span></div>
      )}
      <div className="scroll">
        <div className="px h-row" style={{ marginTop: 8 }}>
          <span style={{ fontWeight: 900, letterSpacing: '.06em', fontSize: 17 }}>CHAN</span>
          <button type="button" onClick={() => go('profile')} aria-label="Profile">
            <Avatar name={name || 'Viewer'} color="#E9B44C" size={34} />
          </button>
        </div>
        <button type="button" className="search-pill" onClick={() => go('browse')}>
          <Search size={17} /><span>Search a show, paste a link, or find a room</span>
        </button>
        <div className="chip-row" style={{ marginTop: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12.5, fontWeight: 650, flex: 'none' }}>Recent</span>
          {RECENT.map((r) => (
            <button key={r} type="button" className="chip" onClick={() => go('browse')}>{r}</button>
          ))}
        </div>

        <SecHead title="Continue watching" top={14} />
        <div className="px">
          <button type="button" className="backdrop" style={{ ...grad(POSTERS[0]), height: 168 }} onClick={() => go('room')}>
            <span className="b-in">
              <span className="pill pill-glass">ROOM STILL LIVE</span>
              <span style={{ display: 'block', fontSize: 19, fontWeight: 900, marginTop: 8 }}>Shogun, E4</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--soft)', margin: '2px 0 10px' }}>32 min left, 5 friends still in the room</span>
              <span className="progress" style={{ display: 'block' }}><i style={{ width: '46%' }} /></span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 11, color: 'var(--amber)', fontSize: 13, fontWeight: 800 }}>
                <Play size={13} />Rejoin room
              </span>
            </span>
          </button>
        </div>

        <SecHead title="Live now" top={18} live />
        <div className="hscroll">
          {LIVE_ROOMS.map((r) => (
            <span key={r.title} className="room-card">
              <button type="button" className="backdrop" style={grad(POSTERS[r.p])} onClick={() => go('room')}>
                <span className="b-in">
                  <span className="pill pill-live">LIVE</span>
                  <span className="card-title-2" style={{ fontWeight: 800, fontSize: 14.5, marginTop: 8, lineHeight: 1.25 }}>{r.title}</span>
                  <span style={{ display: 'block', fontSize: 11.5, color: 'var(--soft)', marginTop: 3 }}>{r.ep}</span>
                </span>
              </button>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
                <Stack size={24} />
                <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.35, minWidth: 0 }}>
                  <b style={{ color: 'var(--text)' }}>{r.n} watching</b>
                  <span style={{ display: 'block', color: r.friends ? 'var(--soft)' : 'var(--muted)' }}>{r.friends || `Hosted by ${r.host}`}</span>
                </span>
              </span>
            </span>
          ))}
        </div>

        <div className="join-card" style={{ marginTop: 14 }}>
          <div className={`field${invalid ? ' invalid' : ''}`}>
            <Hash size={15} />
            <input
              ref={codeRef}
              value={code}
              onChange={(e) => { setCode(e.target.value); setInvalid(false); }}
              placeholder={invalid ? 'Enter an invite code' : 'Invite code'}
              aria-label="Invite code"
              maxLength={12}
              autoComplete="off"
              autoCapitalize="characters"
            />
          </div>
          <button type="button" className="btn btn-primary" onClick={join}>Join</button>
        </div>
        <div className="px" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-ghost" style={{ height: 44, fontSize: 14 }} onClick={() => go('share')}>
            <Monitor size={15} />Start a screen share
          </button>
        </div>

        <SecHead title="Trending this week" top={18} />
        <div className="hscroll">
          {POSTERS.slice(0, 5).map((p, i) => (
            <PosterCard key={p.t} p={p} w={108} rank={i + 1} onOpen={() => go('title')} />
          ))}
        </div>
      </div>
      <BottomNav active="home" />
    </div>
  );
}
