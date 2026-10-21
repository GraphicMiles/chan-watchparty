import { useState } from 'react';
import { Play, ChevronLeft, Link2 } from 'lucide-react';
import { POSTERS } from '../data.js';
import { Toggle, grad, useGo } from '../ui.jsx';

export default function Create() {
  const go = useGo();
  const p = POSTERS[0];
  const [cap, setCap] = useState(8);
  const [priv, setPriv] = useState(false);

  return (
    <div className="screen">
      <div className="safe-top" />
      <div className="px h-row" style={{ flex: 'none', marginTop: 6 }}>
        <button type="button" className="icon-btn" onClick={() => go('title')} aria-label="Back"><ChevronLeft size={19} /></button>
        <b style={{ fontSize: 16 }}>New room</b>
        <span style={{ width: 40 }} />
      </div>
      <div className="scroll">
        <div className="card" style={{ marginTop: 14, display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <span className="poster" style={{ ...grad(p), width: 52, height: 78, flex: 'none' }} />
          <span style={{ flex: '1 1 auto', minWidth: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>Direct links</span>
            <b style={{ display: 'block', fontSize: 14.5, marginTop: 2, lineHeight: 1.3 }}>Shogun, episode 4</b>
            <small style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.45, display: 'block', marginTop: 2 }}>
              Blackthorne trains the regiment while the council moves against Toranaga.
            </small>
          </span>
          <button type="button" className="see-all" onClick={() => go('browse')}>Change</button>
        </div>
        <div className="px" style={{ marginTop: 14 }}>
          <div className="field">
            <Link2 size={16} />
            <input placeholder="Or paste a link" aria-label="Paste a link" />
          </div>
          <p className="helper" style={{ marginTop: 7 }}>YouTube, a direct file, a download page or Live TV.</p>
        </div>
        <div className="px" style={{ marginTop: 20 }}>
          <label className="micro" style={{ display: 'block', marginBottom: 8 }} htmlFor="room-title">Room title, optional</label>
          <div className="field">
            <input id="room-title" placeholder="Defaults to Shogun, episode 4" maxLength={80} aria-label="Room title" />
          </div>
        </div>
        <div className="card" style={{ marginTop: 18, padding: '4px 16px' }}>
          <div className="switch-row">
            <span><b>Capacity</b><small>Up to 12 people</small></span>
            <span className="stepper">
              <button type="button" onClick={() => setCap((c) => Math.max(1, c - 1))} aria-label="Decrease capacity">&minus;</button>
              <b style={{ fontSize: 16, minWidth: 22, textAlign: 'center' }}>{cap}</b>
              <button type="button" onClick={() => setCap((c) => Math.min(12, c + 1))} aria-label="Increase capacity">+</button>
            </span>
          </div>
          <div className="switch-row">
            <span><b>Private room</b><small>Needs an invite code, stays out of Live now</small></span>
            <Toggle on={priv} onChange={setPriv} label="Private room" />
          </div>
        </div>
      </div>
      <div className="sticky-cta">
        <button type="button" className="btn btn-primary" onClick={() => go('room')}>
          <Play size={17} />Create room and enter
        </button>
        <p style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--faint)', marginTop: 10 }}>
          Invite link, QR code and code are waiting inside the room.
        </p>
      </div>
    </div>
  );
}
