import { createContext, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Play, Pause, Home, LayoutGrid, Plus, Users, User, ChevronLeft, Share2,
  Pencil, Maximize, SlidersHorizontal,
} from 'lucide-react';
import { POSTERS, PEOPLE, ROOM } from './data.js';

/* Route map (mock ids mirror the old app's paths) */
export function pathFor(id, layer) {
  switch (id) {
    case 'auth': return '/auth';
    case 'browse': return '/search' + (layer && layer !== 'all' ? `?layer=${layer}` : '');
    case 'title': return '/title';
    case 'create': return '/create';
    case 'room': return '/room/friday-night';
    case 'settings': return '/room/friday-night/settings';
    case 'share': return '/room/friday-night/share';
    case 'error': return '/room/friday-night/error';
    case 'profile': return '/profile';
    case 'states': return '/states';
    default: return '/';
  }
}
export function useGo() {
  const navigate = useNavigate();
  return (id, layer) => navigate(pathFor(id, layer));
}

/* Anonymous user (mock auth): name persists locally, colour derived later. */
const UserCtx = createContext({ name: '', setName: () => {} });
export function UserProvider({ children }) {
  const [name, setNameState] = useState(() => {
    try { return localStorage.getItem('chan-name') || ''; } catch { return ''; }
  });
  const setName = (n) => {
    setNameState(n);
    try {
      if (n) localStorage.setItem('chan-name', n);
      else localStorage.removeItem('chan-name');
    } catch { /* storage unavailable */ }
  };
  return <UserCtx.Provider value={{ name, setName }}>{children}</UserCtx.Provider>;
}
export const useUser = () => useContext(UserCtx);

/* Temporary confirmation flag (Copied / Saved feedback) */
export function useTempFlag(ms = 1400) {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (!flag) return undefined;
    const t = setTimeout(() => setFlag(false), ms);
    return () => clearTimeout(t);
  }, [flag, ms]);
  return [flag, () => setFlag(true)];
}

export function copyText(txt) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(txt);
  return new Promise((ok, no) => {
    try {
      const a = document.createElement('textarea');
      a.value = txt;
      a.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(a);
      a.select();
      const done = document.execCommand('copy');
      a.remove();
      if (done) ok(); else no(new Error('copy failed'));
    } catch (err) { no(err); }
  });
}

export const grad = (p) => ({ background: `linear-gradient(160deg,${p.g[0]},${p.g[1]})` });
export const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function Avatar({ name, color, size = 30 }) {
  return (
    <span className="avatar" style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.4) }}>
      {(name || 'V')[0].toUpperCase()}
    </span>
  );
}
export function Stack({ list = PEOPLE, size = 26 }) {
  return (
    <span className="avatar-stack">
      {list.slice(0, 4).map((p) => <Avatar key={p.n} name={p.n} color={p.c} size={size} />)}
    </span>
  );
}

export function PosterCard({ p, w, rank, fluid, onOpen }) {
  if (fluid) {
    return (
      <span style={{ minWidth: 0 }}>
        <button type="button" className="poster" style={{ ...grad(p), width: '100%', aspectRatio: '2/3' }} onClick={onOpen} aria-label={p.t} />
        <span className="poster-meta"><b>{p.t}</b>{p.m}{p.src !== 'Direct links' ? `, ${p.src}` : ''}</span>
      </span>
    );
  }
  const width = w || 118;
  return (
    <span style={{ flex: 'none', width }}>
      <button type="button" className="poster" style={{ ...grad(p), width, aspectRatio: '2/3' }} onClick={onOpen} aria-label={p.t}>
        {rank ? <span className="p-rank">{rank}</span> : null}
      </button>
      <span className="poster-meta"><b>{p.t}</b>{p.m}</span>
    </span>
  );
}

export function SecHead({ title, top = 18, live }) {
  return (
    <div className="px" style={{ margin: `${top}px 0 8px` }}>
      <span className="sec-title">{live ? <span className="live-dot" /> : null}{title}</span>
    </div>
  );
}

export function Toggle({ on, onChange, label }) {
  return (
    <button
      type="button"
      className={`toggle${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  );
}

export function BottomNav({ active }) {
  const go = useGo();
  const item = (id, Icon, label) => (
    <button type="button" className={active === id ? 'active' : ''} onClick={() => go(id)}>
      <Icon size={22} strokeWidth={1.8} />{label}
    </button>
  );
  return (
    <nav className="bottomnav">
      {item('home', Home, 'Home')}
      {item('browse', LayoutGrid, 'Browse')}
      <button type="button" className="fab" onClick={() => go('create')} aria-label="Start a party">
        <Plus size={26} strokeWidth={1.8} />
      </button>
      {item('room', Users, 'Room')}
      {item('profile', User, 'You')}
    </nav>
  );
}

/* Mock player surface: gradient "video", transport, seek, pins, floats. */
export function Player({
  playing, onTogglePlay, pos, dur = ROOM.duration, onSkip,
  skips, caption, pins, extraPins = [], vibe, floats = [], desktop, bgFilter,
}) {
  const p = POSTERS[0];
  const pct = Math.max(0, Math.min(100, (pos / dur) * 100));
  return (
    <div className={`player${caption ? ' cap' : ''}`} style={vibe ? { border: '1.5px solid #5A4040' } : undefined}>
      <div className="p-bg" style={{ ...grad(p), filter: bgFilter }} />
      {desktop ? (
        <div className="desktop-art">
          <div className="desktop-bar"><i /><i /><i /></div>
          <div style={{ padding: 12 }}>
            <div className="skel" style={{ height: 60, background: '#22242C' }} />
            <div className="skel" style={{ height: 8, width: '60%', marginTop: 10, background: '#26282F' }} />
            <div className="skel" style={{ height: 8, width: '44%', marginTop: 7, background: '#26282F' }} />
          </div>
        </div>
      ) : null}
      <div className="p-top">
        <span className="pill pill-glass"><span className="live-dot ok" />IN SYNC</span>
      </div>
      <div className="p-center">
        {skips ? <button type="button" className="skip-btn" onClick={() => onSkip(-10)}>-10s</button> : null}
        <button type="button" className="play-btn" onClick={onTogglePlay} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={25} /> : <Play size={25} />}
        </button>
        {skips ? <button type="button" className="skip-btn" onClick={() => onSkip(10)}>+10s</button> : null}
      </div>
      {caption ? (
        <div className="caption-line"><span>[rain against the banners] The torches gutter in the wind.</span></div>
      ) : null}
      {floats.map((f) => (
        <span key={f.id} className={`float-react${f.fly ? ' fly' : ''}`} style={{ top: f.top }}>{f.emoji}</span>
      ))}
      <div className="p-bottom">
        <div className="seek">
          <div className="progress"><i style={{ width: `${pct}%` }} /></div>
          {pins ? <><span className="pin-mark" style={{ left: '31%' }} /><span className="pin-mark" style={{ left: '57%' }} /></> : null}
          {extraPins.map((l) => <span key={l} className="pin-mark" style={{ left: `${l}%` }} />)}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 7, fontSize: 11, color: 'var(--soft)' }}>
          <span>{fmt(pos)} of {fmt(dur)}</span>
          <span><Maximize size={15} /></span>
        </div>
      </div>
    </div>
  );
}

export function RoomHead() {
  const go = useGo();
  return (
    <>
      <div className="safe-top" />
      <div className="px h-row" style={{ flex: 'none', marginTop: 2 }}>
        <button type="button" className="icon-btn" onClick={() => go('home')} aria-label="Leave room">
          <ChevronLeft size={19} />
        </button>
        <span style={{ textAlign: 'center', flex: '1 1 auto', minWidth: 0, padding: '0 8px' }}>
          <b className="truncate" style={{ fontSize: 14, display: 'block' }}>
            {ROOM.name} <span style={{ color: 'var(--faint)' }}><Pencil size={12} style={{ verticalAlign: '-1px' }} /></span>
          </b>
          <small style={{ color: 'var(--muted)', fontSize: 11 }}>{ROOM.seats}</small>
        </span>
        <button type="button" className="icon-btn" onClick={() => go('share')} aria-label="Share room">
          <Share2 size={18} />
        </button>
      </div>
    </>
  );
}

export function RoomMeta() {
  const go = useGo();
  return (
    <div className="px" style={{ flex: 'none', marginTop: 8 }}>
      <div className="h-row">
        <b className="truncate" style={{ fontSize: 15.5, lineHeight: 1.3, minWidth: 0 }}>{ROOM.episode}</b>
        <button type="button" className="icon-btn" onClick={() => go('settings')} aria-label="Player settings">
          <SlidersHorizontal size={18} />
        </button>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 2 }}>
        <small style={{ flex: '1 1 auto', minWidth: 0, color: 'var(--muted)', fontSize: 12 }}>{ROOM.source}</small>
        <Stack size={26} />
      </div>
    </div>
  );
}
