import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Home, LayoutGrid, Plus, Users, User } from 'lucide-react';
import { Avatar as SharedAvatar } from '../shared/ui/index.js';
import { getLastRoom } from '../features/room/hooks/useRoom.js';

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

/* Deterministic poster art for media without artwork (rooms, thumbless
   results). Seeded by id/title so a card keeps its colours across renders. */
const PALETTES = [
  ['#3F3434', '#1E1A1B'], ['#403A32', '#1D1A16'], ['#323A40', '#171A1D'],
  ['#40362F', '#1C1815'], ['#363B34', '#181A17'], ['#393440', '#1A181C'],
  ['#323B36', '#161A18'], ['#383840', '#18181C'], ['#3B3934', '#1A1917'],
];
export function gradFor(seed = '') {
  let h = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const g = PALETTES[h % PALETTES.length];
  return { background: `linear-gradient(160deg,${g[0]},${g[1]})` };
}
export const grad = (p) => ({ background: `linear-gradient(160deg,${p.g[0]},${p.g[1]})` });
export const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/* Real thumbnail over gradient art; hides itself when the image fails. */
export function Img({ src, alt = '' }) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className="cover-img"
      onError={(e) => { e.currentTarget.style.display = 'none'; }}
    />
  );
}

export function Avatar({ name, uid, size = 30 }) {
  return <SharedAvatar name={name || 'Viewer'} uid={uid} size={size} />;
}

/* Overlapping avatar stack from real participant objects. */
export function Stack({ people = [], size = 26 }) {
  return (
    <span className="avatar-stack">
      {people.slice(0, 4).map((p, i) => (
        <Avatar
          key={p.uid || p.id || p.displayName || i}
          name={typeof p === 'string' ? p : p.displayName || 'Viewer'}
          uid={typeof p === 'string' ? p : p.uid || p.id}
          size={size}
        />
      ))}
    </span>
  );
}

/* Poster card driven by a real search result (or a trending term). */
export function PosterCard({ title, meta, thumb, seed, rank, w, fluid, badge, onOpen, rise }) {
  const inner = (
    <button
      type="button"
      className="poster"
      style={{ ...gradFor(seed || title), width: fluid ? '100%' : w || 118, aspectRatio: '2/3' }}
      onClick={onOpen}
      aria-label={title}
    >
      <Img src={thumb} alt="" />
      {rank ? <span className="p-rank">{rank}</span> : null}
      {badge ? <span className="pill pill-live" style={{ position: 'absolute', top: 8, left: 8, zIndex: 2 }}>{badge}</span> : null}
    </button>
  );
  return (
    <span className={rise ? 'rise' : undefined} style={{ ...(fluid ? { minWidth: 0 } : { flex: 'none', width: w || 118 }), ...(rise ? { '--d': rise } : null) }}>
      {inner}
      <span className="poster-meta"><b>{title}</b>{meta}</span>
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
  const navigate = useNavigate();
  const goRoom = () => {
    const last = getLastRoom();
    navigate(last?.roomId ? `/room/${last.roomId}` : '/');
  };
  const item = (id, Icon, label, onClick) => (
    <button type="button" className={active === id ? 'active' : ''} onClick={onClick}>
      <Icon size={22} strokeWidth={1.8} />{label}
    </button>
  );
  return (
    <nav className="bottomnav">
      {item('home', Home, 'Home', () => navigate('/'))}
      {item('browse', LayoutGrid, 'Browse', () => navigate('/search'))}
      <button type="button" className="fab" onClick={() => navigate('/create')} aria-label="Start a party">
        <Plus size={26} strokeWidth={1.8} />
      </button>
      {item('room', Users, 'Room', goRoom)}
      {item('profile', User, 'You', () => navigate('/profile'))}
    </nav>
  );
}
